package com.grokbot.reconstructed;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * Plain-JVM harness for ForwarderCore. Run with no arguments; exits 0 on
 * success, 1 on failure with a printed reason. Exercises the four-pack
 * forwarder rules for real: header stripping, token injection, request body
 * forwarding, SSE streaming (no buffering), boot-script injection, and the
 * loopback guard.
 */
public final class ForwarderCoreTest {

  private static final String TOKEN = "four-pack-token-123";
  private static volatile Map<String, String> lastUpstreamHeaders = new HashMap<>();
  private static volatile String lastUpstreamBody = "";

  public static void main(String[] args) throws Exception {
    HttpServer upstream = startUpstream();
    ForwarderCore forwarder = new ForwarderCore(memoryUi(), testConfig("http://127.0.0.1:" + upstream.getAddress().getPort(), TOKEN));
    int port = forwarder.start(17597, 5);
    check(port > 0, "forwarder bound a port");

    try {
      // 1. Plain GET /health passes through with the token added.
      Response health = request("GET", "http://127.0.0.1:" + port + "/health", null, Map.of());
      check(health.status == 200, "GET /health is proxied: " + health.status);
      check(health.body.contains("\"ok\""), "GET /health body passes through: " + health.body);

      // 2. POST /api/sendPrompt: browser headers stripped, token + identity added, body intact.
      Response send = request("POST", "http://127.0.0.1:" + port + "/api/sendPrompt", "hello-box", Map.of(
        "Origin", "http://127.0.0.1:5173",
        "Referer", "http://127.0.0.1:5173/index.html",
        "Sec-Fetch-Site", "same-origin",
        "Content-Type", "application/json"));
      check(send.status == 200, "POST /api/sendPrompt is proxied: " + send.status);
      String authorization = lastUpstreamHeaders.getOrDefault("authorization", "");
      check(authorization.equals("Bearer " + TOKEN), "upstream saw the native token: " + authorization);
      String acceptEncoding = lastUpstreamHeaders.getOrDefault("accept-encoding", "");
      check(acceptEncoding.equals("identity"), "upstream saw accept-encoding identity: " + acceptEncoding);
      check(!lastUpstreamHeaders.containsKey("origin"), "upstream saw no Origin header");
      check(!lastUpstreamHeaders.containsKey("referer"), "upstream saw no Referer header");
      check(!lastUpstreamHeaders.containsKey("sec-fetch-site"), "upstream saw no Sec-Fetch-Site header");
      check(lastUpstreamBody.equals("hello-box"), "request body arrived intact: " + lastUpstreamBody);

      // 3. /events streams: the first chunk arrives long before the stream ends.
      long streamStart = System.currentTimeMillis();
      InputStream events = openStream("http://127.0.0.1:" + port + "/events");
      byte[] first = readUntil(events, (byte) '\n');
      long firstArrival = System.currentTimeMillis() - streamStart;
      String firstLine = new String(first, StandardCharsets.UTF_8).trim();
      check(firstLine.equals("data: first"), "SSE first chunk is the first event: " + firstLine);
      check(firstArrival < 300, "SSE streams immediately (no buffering): first chunk after " + firstArrival + "ms");
      byte[] rest = readAll(events);
      long totalMs = System.currentTimeMillis() - streamStart;
      String restText = new String(rest, StandardCharsets.UTF_8);
      check(restText.contains("data: second"), "SSE second chunk arrives: " + restText.trim());
      check(totalMs >= 350, "SSE second chunk waited for the upstream delay: " + totalMs + "ms");
      events.close();

      // 4. Static UI is served with the boot script injected.
      Response index = request("GET", "http://127.0.0.1:" + port + "/", null, Map.of());
      check(index.status == 200, "index.html served: " + index.status);
      check(index.body.contains("/client-overrides/boot.js"), "index.html injects the web runtime boot");
      check(index.body.contains("<html"), "index.html bytes otherwise intact");

      // 5. A loopback box address is refused with a human message.
      ForwarderCore loopback = new ForwarderCore(memoryUi(), fixedConfig("http://127.0.0.1:9", TOKEN));
      int loopbackPort = loopback.start(17697, 5);
      try {
        Response refused = request("GET", "http://127.0.0.1:" + loopbackPort + "/health", null, Map.of());
        check(refused.status == 502, "loopback box address is refused: " + refused.status);
        check(refused.body.contains("192.168.1.8"), "loopback refusal carries the human hint: " + refused.body);
      } finally {
        loopback.stop();
      }

      System.out.println("ForwarderCoreTest: PASS");
      System.exit(0);
    } catch (AssertionError error) {
      System.out.println("ForwarderCoreTest: FAIL " + error.getMessage());
      System.exit(1);
    } finally {
      forwarder.stop();
      upstream.stop(0);
    }
  }

  // ---- mock box gateway -----------------------------------------------------

  private static HttpServer startUpstream() throws IOException {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.setExecutor(Executors.newCachedThreadPool());
    server.createContext("/health", exchange -> respondJson(exchange, 200, "{\"ok\":true}"));
    server.createContext("/api/sendPrompt", exchange -> {
      lastUpstreamHeaders = new HashMap<>();
      for (Map.Entry<String, java.util.List<String>> header : exchange.getRequestHeaders().entrySet()) {
        lastUpstreamHeaders.put(header.getKey().toLowerCase(java.util.Locale.ROOT), String.join(",", header.getValue()));
      }
      lastUpstreamBody = new String(readAll(exchange.getRequestBody()), StandardCharsets.UTF_8);
      respondJson(exchange, 200, "{\"accepted\":true}");
    });
    server.createContext("/events", exchange -> {
      exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
      exchange.sendResponseHeaders(200, 0);
      OutputStream out = exchange.getResponseBody();
      out.write("data: first\n\n".getBytes(StandardCharsets.UTF_8));
      out.flush();
      try { Thread.sleep(450); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
      out.write("data: second\n\n".getBytes(StandardCharsets.UTF_8));
      out.flush();
      out.close();
    });
    server.start();
    return server;
  }

  private static void respondJson(HttpExchange exchange, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.sendResponseHeaders(status, bytes.length);
    exchange.getResponseBody().write(bytes);
    exchange.close();
  }

  // ---- helpers ----------------------------------------------------------------

  private static ForwarderCore.Config testConfig(String base, String token) {
    return new ForwarderCore.Config() {
      @Override public String boxBaseUrl() { return base; }
      @Override public String token() { return token; }
      @Override public boolean allowLoopbackBox() { return true; }
    };
  }

  private static ForwarderCore.Config fixedConfig(String base, String token) {
    return new ForwarderCore.Config() {
      @Override public String boxBaseUrl() { return base; }
      @Override public String token() { return token; }
    };
  }

  private static ForwarderCore.UiSource memoryUi() {
    String index = "<!doctype html><html><head><title>t</title></head><body></body></html>";
    return new ForwarderCore.UiSource() {
      @Override public boolean exists(String path) { return path.equals("/index.html") || path.equals("/"); }
      @Override public byte[] get(String path) throws IOException { return index.getBytes(StandardCharsets.UTF_8); }
      @Override public String contentType(String path) { return "text/html; charset=utf-8"; }
    };
  }

  private record Response(int status, String body) {}

  private static Response request(String method, String url, String body, Map<String, String> headers) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setRequestMethod(method);
    for (Map.Entry<String, String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
    if (body != null) {
      connection.setDoOutput(true);
      byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
      connection.setFixedLengthStreamingMode(bytes.length);
      connection.getOutputStream().write(bytes);
    }
    int status = connection.getResponseCode();
    InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
    String text = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
    connection.disconnect();
    return new Response(status, text);
  }

  private static InputStream openStream(String url) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setReadTimeout(5_000);
    return connection.getInputStream();
  }

  private static byte[] readUntil(InputStream in, byte terminator) throws IOException {
    ByteArrayOutputStream sink = new ByteArrayOutputStream();
    for (;;) {
      int current = in.read();
      if (current < 0) break;
      sink.write(current);
      if ((byte) current == terminator) break;
    }
    return sink.toByteArray();
  }

  private static byte[] readAll(InputStream in) throws IOException {
    ByteArrayOutputStream sink = new ByteArrayOutputStream();
    byte[] buffer = new byte[8 * 1024];
    for (;;) {
      int read = in.read(buffer);
      if (read < 0) break;
      sink.write(buffer, 0, read);
    }
    return sink.toByteArray();
  }

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private ForwarderCoreTest() {}
}
