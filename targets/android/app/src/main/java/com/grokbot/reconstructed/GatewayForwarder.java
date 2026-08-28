package com.grokbot.reconstructed;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * Android binding for {@link ForwarderCore}: assets in, Keystore-backed token
 * and stored box address out. Everything chat-related stays in the page; this
 * class only wires storage and lifecycle.
 */
public final class GatewayForwarder {

  private static final String PREFS = "sand-forwarder";
  private static final String PORT_PREF = "forwarderPort";
  private static final int PREFERRED_PORT = 17537;
  private static final int PORT_ATTEMPTS = 20;

  private static volatile GatewayForwarder instance;

  private final ForwarderCore core;
  private final SharedPreferences prefs;
  private final SecretsStore secrets;
  private final SharedPreferences boxConfig;

  private GatewayForwarder(Context context, ForwarderCore core, SharedPreferences prefs, SecretsStore secrets, SharedPreferences boxConfig) {
    this.core = core;
    this.prefs = prefs;
    this.secrets = secrets;
    this.boxConfig = boxConfig;
  }

  public static GatewayForwarder start(Context context) throws IOException {
    GatewayForwarder existing = instance;
    if (existing != null) return existing;
    synchronized (GatewayForwarder.class) {
      if (instance != null) return instance;
      SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
      SharedPreferences boxConfig = context.getSharedPreferences("sand-box", Context.MODE_PRIVATE);
      SecretsStore secrets = new SecretsStore(context);
      ForwarderCore core = new ForwarderCore(uiSource(context.getAssets()), config(boxConfig, secrets));
      int storedPort = prefs.getInt(PORT_PREF, PREFERRED_PORT);
      int port = core.start(storedPort, PORT_ATTEMPTS);
      prefs.edit().putInt(PORT_PREF, port).apply();
      instance = new GatewayForwarder(context, core, prefs, secrets, boxConfig);
      return instance;
    }
  }

  public static GatewayForwarder require() {
    GatewayForwarder existing = instance;
    if (existing == null) throw new IllegalStateException("GatewayForwarder has not started yet.");
    return existing;
  }

  public int port() {
    return core.port();
  }

  /** Forces the proxy to re-read the box address/token after Connect changes. */
  public void refreshConfig() {
    // Config is read per connection; nothing cached to invalidate.
  }

  public static String boxBaseUrl(Context context) {
    return context.getSharedPreferences("sand-box", Context.MODE_PRIVATE).getString("boxBaseUrl", "");
  }

  static void setBoxBaseUrl(Context context, String value) {
    context.getSharedPreferences("sand-box", Context.MODE_PRIVATE).edit().putString("boxBaseUrl", value).apply();
    GatewayForwarder existing = instance;
    if (existing != null) existing.refreshConfig();
  }

  private static ForwarderCore.Config config(SharedPreferences boxConfig, SecretsStore secrets) {
    return new ForwarderCore.Config() {
      @Override
      public String boxBaseUrl() {
        return boxConfig.getString("boxBaseUrl", "");
      }

      @Override
      public String token() {
        return secrets.reveal("gatewayToken");
      }
    };
  }

  private static ForwarderCore.UiSource uiSource(final AssetManager assets) {
    return new ForwarderCore.UiSource() {
      @Override
      public boolean exists(String path) {
        String clean = path.startsWith("/") ? path.substring(1) : path;
        try (InputStream ignored = assets.open("www/" + clean)) {
          return true;
        } catch (IOException error) {
          return false;
        }
      }

      @Override
      public byte[] get(String path) throws IOException {
        String clean = path.startsWith("/") ? path.substring(1) : path;
        InputStream in = assets.open("www/" + clean);
        try {
          ByteArrayOutputStream sink = new ByteArrayOutputStream();
          byte[] buffer = new byte[16 * 1024];
          int read;
          while ((read = in.read(buffer)) != -1) sink.write(buffer, 0, read);
          return sink.toByteArray();
        } finally {
          in.close();
        }
      }

      @Override
      public String contentType(String path) {
        String clean = path.toLowerCase(Locale.ROOT);
        if (clean.endsWith(".html")) return "text/html; charset=utf-8";
        if (clean.endsWith(".js") || clean.endsWith(".mjs")) return "text/javascript";
        if (clean.endsWith(".css")) return "text/css";
        if (clean.endsWith(".json")) return "application/json";
        if (clean.endsWith(".svg")) return "image/svg+xml";
        if (clean.endsWith(".png")) return "image/png";
        if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
        if (clean.endsWith(".webp")) return "image/webp";
        if (clean.endsWith(".ico")) return "image/x-icon";
        if (clean.endsWith(".woff2")) return "font/woff2";
        if (clean.endsWith(".woff")) return "font/woff";
        if (clean.endsWith(".ttf")) return "font/ttf";
        if (clean.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
      }
    };
  }
}
