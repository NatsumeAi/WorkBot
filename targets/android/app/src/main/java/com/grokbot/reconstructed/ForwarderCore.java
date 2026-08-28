package com.grokbot.reconstructed;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Pure-JVM half of the on-device gateway forwarder.
 *
 * The phone UI is served from this process (same origin), and box traffic is
 * proxied with browser-origin headers stripped and the gateway token added.
 * Responses are always pumped through in bounded chunks — the SSE /events
 * stream is never buffered. No chat logic lives here: it knows paths and
 * headers, nothing else.
 */
public final class ForwarderCore {

  /** Source of the bundled UI files (assets on Android, memory in tests). */
  public interface UiSource {
    boolean exists(String path);

    byte[] get(String path) throws IOException;

    String contentType(String path);
  }

  /** Forwarder destination; implementers must return a normalized base URL. */
  public interface Config {
    String boxBaseUrl();

    String token();

    /** Test hook only: production glue always refuses loopback boxes. */
    default boolean allowLoopbackBox() {
      return false;
    }
  }

  /** Headers that would mark the request as coming from a browser. */
  static final String[] STRIPPED_HEADERS = {
    "Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest",
    "Sec-Fetch-User", "Sec-Fetch-Storage-Access", "Cookie", "Access-Control-Request-Headers",
    "Access-Control-Request-Method", "X-Requested-With",
  };
  private static final List<String> STRIPPED_LOWER = Arrays.stream(STRIPPED_HEADERS)
    .map(name -> name.toLowerCase(Locale.ROOT)).toList();

  static final String[] PROXIED_PREFIXES = {"/api/", "/events", "/avatars/", "/health"};
  private static final int BUFFER_BYTES = 8 * 1024;
  static final String BOOT_SCRIPT_TAG = "<script type=\"module\" src=\"/client-overrides/boot.js\"></script>\n  ";
  private static final String LOOPBACK_MESSAGE =
    "127.0.0.1 is this device itself, not the box. Enter the box's LAN address, for example http://192.168.1.8:1340";

  private final UiSource ui;
  private final Config config;
  private final ExecutorService pool = Executors.newCachedThreadPool();
  private ServerSocket serverSocket;
  private volatile boolean running = false;

  public ForwarderCore(UiSource ui, Config config) {
    this.ui = ui;
    this.config = config;
  }

  /** Binds loopback on the first free port from {@code preferredPort} upward. */
  public int start(int preferredPort, int attempts) throws IOException {
    IOException last = null;
    for (int attempt = 0; attempt < attempts; attempt += 1) {
      try {
        serverSocket = new ServerSocket();
        serverSocket.bind(new InetSocketAddress("127.0.0.1", preferredPort + attempt), 64);
        running = true;
        Thread acceptLoop = new Thread(this::acceptLoop, "forwarder-accept");
        acceptLoop.setDaemon(true);
        acceptLoop.start();
        return serverSocket.getLocalPort();
      } catch (IOException error) {
        last = error;
      }
    }
    throw last != null ? last : new IOException("no forwarder port available");
  }

  public void stop() {
    running = false;
    if (serverSocket != null) {
      try { serverSocket.close(); } catch (IOException ignored) { /* closing */ }
    }
    pool.shutdownNow();
  }

  public int port() {
    return serverSocket == null ? -1 : serverSocket.getLocalPort();
  }

  private void acceptLoop() {
    while (running) {
      try {
        final Socket socket = serverSocket.accept();
        pool.submit(() -> {
          try (Socket connection = socket) {
            handle(connection);
          } catch (IOException | RuntimeException ignored) {
            // A dead client or malformed request must never kill the accept loop.
          }
        });
      } catch (IOException error) {
        if (running) { /* transient accept failure; keep serving */ }
        else return;
      }
    }
  }

  private void handle(Socket socket) throws IOException {
    socket.setSoTimeout(0);
    InputStream in = socket.getInputStream();
    OutputStream out = socket.getOutputStream();
    Request request = Request.read(in);
    if (request == null) { respondError(out, 400, "Malformed request."); return; }
    if (request.method.equals("GET") && isStaticPath(request.path)) {
      serveStatic(out, request.path);
      return;
    }
    if (isProxiedPath(request.path)) {
      proxy(request, in, out, socket);
      return;
    }
    respondError(out, 404, "Not found: " + request.path);
  }

  static boolean isProxiedPath(String path) {
    for (String prefix : PROXIED_PREFIXES) {
      if (path.equals(prefix) || path.startsWith(prefix) || (prefix.equals("/events") && path.startsWith("/events"))
        || (prefix.equals("/health") && path.startsWith("/health"))) return true;
    }
    return false;
  }

  private static boolean isStaticPath(String path) {
    return path.equals("/") || (!path.startsWith("/api/") && !path.startsWith("/avatars/") && !path.equals("/events") && !path.startsWith("/health"));
  }

  private void serveStatic(OutputStream out, String rawPath) throws IOException {
    String path = rawPath.equals("/") ? "/index.html" : rawPath;
    if (path.contains("..") || !ui.exists(path)) { respondError(out, 404, "Not found: " + rawPath); return; }
    byte[] bytes = ui.get(path);
    if (path.equals("/index.html")) bytes = injectBootScript(bytes);
    String contentType = ui.contentType(path);
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 200 OK\r\n");
    head.append("Content-Type: ").append(contentType).append("\r\n");
    head.append("Content-Length: ").append(bytes.length).append("\r\n");
    head.append("Cache-Control: no-cache\r\n");
    head.append("Connection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    out.write(bytes);
    out.flush();
  }

  static byte[] injectBootScript(byte[] indexHtml) {
    String html = new String(indexHtml, StandardCharsets.UTF_8);
    if (html.contains("/client-overrides/boot.js")) return indexHtml;
    int head = html.indexOf("<head>");
    if (head >= 0) {
      String injected = html.substring(0, head + "<head>".length()) + "\n  " + BOOT_SCRIPT_TAG.trim() + html.substring(head + "<head>".length());
      return injected.getBytes(StandardCharsets.UTF_8);
    }
    return indexHtml;
  }

  private void proxy(Request request, InputStream clientIn, OutputStream out, Socket clientSocket) throws IOException {
    String base = config.boxBaseUrl();
    if (base == null || base.isEmpty()) { respondError(out, 502, "No box address is configured yet. Set it in Settings -> Connect."); return; }
    URI baseUri;
    try { baseUri = URI.create(base); } catch (RuntimeException error) { respondError(out, 502, "The box address is not a valid URL."); return; }
    String host = baseUri.getHost() == null ? "" : baseUri.getHost().toLowerCase(Locale.ROOT);
    boolean loopback = host.equals("127.0.0.1") || host.equals("localhost") || host.equals("::1") || host.equals("0.0.0.0") || host.startsWith("127.");
    if (loopback && !config.allowLoopbackBox()) {
      respondError(out, 502, LOOPBACK_MESSAGE);
      return;
    }
    boolean events = request.path.startsWith("/events");
    long contentLength = request.contentLength();
    boolean bodyMethod = request.method.equals("POST") || request.method.equals("PUT") || request.method.equals("PATCH");
    if (bodyMethod && contentLength <= 0) {
      respondError(out, 411, "Length Required");
      return;
    }
    HttpURLConnection upstream;
    try {
      URL url = new URL(base + request.pathWithQuery());
      upstream = (HttpURLConnection) url.openConnection();
    } catch (IOException error) {
      respondError(out, 502, "The box address is not a valid URL.");
      return;
    }
    try {
      upstream.setRequestMethod(request.method);
      upstream.setConnectTimeout(10_000);
      upstream.setReadTimeout(events ? 0 : 60_000);
      for (Map.Entry<String, String> header : request.headers.entrySet()) {
        String lower = header.getKey().toLowerCase(Locale.ROOT);
        if (STRIPPED_LOWER.contains(lower)) continue;
        if (lower.equals("host") || lower.equals("content-length") || lower.equals("connection")
          || lower.equals("accept-encoding") || lower.equals("authorization")) continue;
        upstream.setRequestProperty(header.getKey(), header.getValue());
      }
      upstream.setRequestProperty("Accept-Encoding", "identity");
      String token = config.token();
      if (token != null && !token.isEmpty()) upstream.setRequestProperty("Authorization", "Bearer " + token);
      if (contentLength > 0) {
        upstream.setDoOutput(true);
        upstream.setFixedLengthStreamingMode(contentLength);
        try (OutputStream upstreamOut = upstream.getOutputStream()) {
          pump(clientIn, upstreamOut, contentLength);
        }
      }
      int status = upstream.getResponseCode();
      InputStream upstreamIn = null;
      if (status != 204 && status != 304) {
        try {
          upstreamIn = status >= 400 ? upstream.getErrorStream() : upstream.getInputStream();
        } catch (IOException ignored) {
          upstreamIn = upstream.getErrorStream();
        }
      }
      StringBuilder head = new StringBuilder();
      head.append("HTTP/1.1 ").append(status).append(" ").append(statusText(status)).append("\r\n");
      boolean hasContentType = false;
      for (Map.Entry<String, List<String>> header : upstream.getHeaderFields().entrySet()) {
        String name = header.getKey();
        if (name == null) continue;
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.equals("transfer-encoding") || lower.equals("connection") || lower.equals("keep-alive")
          || lower.equals("content-encoding") || lower.equals("server") || lower.equals("date")) continue;
        if (lower.equals("content-type")) hasContentType = true;
        for (String value : header.getValue()) head.append(name).append(": ").append(value).append("\r\n");
      }
      if (!hasContentType) head.append("Content-Type: application/json\r\n");
      head.append("Connection: close\r\n\r\n");
      out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
      out.flush();
      if (upstreamIn != null) {
        try {
          pump(upstreamIn, out, Long.MAX_VALUE);
        } catch (IOException ignored) {
          // A dropped stream (client or box) just ends this response.
        }
      }
      out.flush();
    } finally {
      upstream.disconnect();
      try { clientSocket.close(); } catch (IOException ignored) { /* closing */ }
    }
  }

  private static void pump(InputStream in, OutputStream out, long limit) throws IOException {
    byte[] buffer = new byte[BUFFER_BYTES];
    long remaining = limit;
    while (remaining > 0) {
      int read = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
      if (read < 0) return;
      out.write(buffer, 0, read);
      out.flush();
      remaining -= read;
    }
  }

  private static void respondError(OutputStream out, int status, String message) throws IOException {
    byte[] body = ("{" + "\"error\":" + quote(message) + "}").getBytes(StandardCharsets.UTF_8);
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 ").append(status).append(" ").append(statusText(status)).append("\r\n");
    head.append("Content-Type: application/json\r\n");
    head.append("Content-Length: ").append(body.length).append("\r\n");
    head.append("Connection: close\r\n\r\n");
    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    out.write(body);
    out.flush();
  }

  static String quote(String value) {
    StringBuilder escaped = new StringBuilder("\"");
    for (int index = 0; index < value.length(); index += 1) {
      char current = value.charAt(index);
      if (current == '"' || current == '\\') escaped.append('\\');
      if (current == '\n') { escaped.append("\\n"); continue; }
      escaped.append(current);
    }
    return escaped.append('"').toString();
  }

  static String statusText(int status) {
    switch (status) {
      case 200: return "OK";
      case 304: return "Not Modified";
      case 400: return "Bad Request";
      case 401: return "Unauthorized";
      case 403: return "Forbidden";
      case 404: return "Not Found";
      case 500: return "Internal Server Error";
      case 502: return "Bad Gateway";
      default: return "Status";
    }
  }

  /** One parsed HTTP/1.x request; the body stays unread on the socket stream. */
  static final class Request {
    final String method;
    final String path;
    final String query;
    final Map<String, String> headers;

    private Request(String method, String path, String query, Map<String, String> headers) {
      this.method = method;
      this.path = path;
      this.query = query;
      this.headers = headers;
    }

    String pathWithQuery() {
      return query == null || query.isEmpty() ? path : path + "?" + query;
    }

    long contentLength() {
      String value = headers.get("content-length");
      if (value == null) return -1;
      try { return Long.parseLong(value.trim()); } catch (NumberFormatException error) { return -1; }
    }

    static Request read(InputStream in) throws IOException {
      ByteArrayOutputStream head = new ByteArrayOutputStream();
      int rolling = 0;
      for (;;) {
        int current = in.read();
        if (current < 0) return null;
        head.write(current);
        rolling = ((rolling << 8) | (current & 0xFF)) & 0xFFFFFFFF;
        if (rolling == 0x0D0A0D0A) break;
        if (head.size() > 64 * 1024) return null;
      }
      String text = head.toString(StandardCharsets.US_ASCII);
      String[] lines = text.split("\r\n");
      if (lines.length < 1) return null;
      String[] requestLine = lines[0].split(" ");
      if (requestLine.length < 2) return null;
      Map<String, String> headers = new LinkedHashMap<>();
      for (int index = 1; index < lines.length; index += 1) {
        int colon = lines[index].indexOf(':');
        if (colon <= 0) continue;
        headers.put(lines[index].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[index].substring(colon + 1).trim());
      }
      String target = requestLine[1];
      String path = target;
      String query = "";
      int queryStart = target.indexOf('?');
      if (queryStart >= 0) {
        path = target.substring(0, queryStart);
        query = target.substring(queryStart + 1);
      }
      return new Request(requestLine[0].toUpperCase(Locale.ROOT), path, query, headers);
    }
  }
}
