package com.grokbot.reconstructed;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Thin remote of the box: the same UI the desktop ships, served by the local
 * forwarder so the page and the box traffic share one origin. Everything
 * chat-related lives in the page's TypeScript runtime; this shell only owns
 * the WebView, the forwarder lifecycle, and the Keystore-backed secrets.
 */
public class MainActivity extends AppCompatActivity {

  private WebView webView;
  private GatewayForwarder forwarder;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    try {
      forwarder = GatewayForwarder.start(this);
    } catch (IOException error) {
      throw new IllegalStateException("Could not start the local gateway forwarder.", error);
    }
    webView = new WebView(this);
    setContentView(webView);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMediaPlaybackRequiresUserGesture(false);
    webView.setWebViewClient(new WebViewClient());
    webView.addJavascriptInterface(new SandNative(this, forwarder), "SandNative");
    // The page checks window.desktop as soon as its bundle runs; document-start
    // injection makes sure the web runtime lands first.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      String boot = "import('/client-overrides/boot.js').catch(function (error) { console.error('boot failed', error); });";
      WebViewCompat.addDocumentStartJavaScript(webView, boot, Collections.singleton("http://127.0.0.1:" + forwarder.port()));
    }
    if (savedInstanceState != null) webView.restoreState(savedInstanceState);
    else webView.loadUrl("http://127.0.0.1:" + forwarder.port() + "/");
  }

  @Override
  protected void onSaveInstanceState(Bundle outState) {
    super.onSaveInstanceState(outState);
    if (webView != null) webView.saveState(outState);
  }

  @Override
  public boolean onKeyDown(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
      webView.goBack();
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }

  @Override
  protected void onDestroy() {
    if (webView != null) webView.destroy();
    super.onDestroy();
  }

  /** Same surface as the desktop secrets bridge, plus forwarder plumbing. */
  public static final class SandNative {
    private final Activity activity;
    private final GatewayForwarder forwarder;
    private final SecretsStore secrets;
    private final ExecutorService probePool = Executors.newSingleThreadExecutor();

    SandNative(Activity activity, GatewayForwarder forwarder) {
      this.activity = activity;
      this.forwarder = forwarder;
      this.secrets = new SecretsStore(activity);
    }

    @JavascriptInterface
    public void openExternal(String url) {
      activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    @JavascriptInterface
    public String listSecrets() {
      return secrets.listKeysJson();
    }

    @JavascriptInterface
    public String revealSecret(String key) {
      return secrets.reveal(key);
    }

    @JavascriptInterface
    public void upsertSecrets(String entriesJson) throws Exception {
      JSONObject object = new JSONObject(entriesJson);
      Iterator<String> keys = object.keys();
      while (keys.hasNext()) {
        String key = keys.next();
        secrets.upsert(key, object.getString(key));
      }
    }

    @JavascriptInterface
    public void removeSecrets(String keysJson) throws Exception {
      JSONArray array = new JSONArray(keysJson);
      for (int index = 0; index < array.length(); index += 1) {
        secrets.remove(array.getString(index));
      }
    }

    @JavascriptInterface
    public String getPref(String key) {
      return activity.getSharedPreferences("sand-box", Activity.MODE_PRIVATE).getString(key, null);
    }

    @JavascriptInterface
    public void setPref(String key, String value) {
      if ("boxBaseUrl".equals(key)) GatewayForwarder.setBoxBaseUrl(activity, value);
      else activity.getSharedPreferences("sand-box", Activity.MODE_PRIVATE).edit().putString(key, value).apply();
    }

    @JavascriptInterface
    public void clearPref(String key) {
      activity.getSharedPreferences("sand-box", Activity.MODE_PRIVATE).edit().remove(key).apply();
    }

    @JavascriptInterface
    public int getForwarderPort() {
      return forwarder.port();
    }

    /** True when a gateway token exists in the Keystore; never returns the token. */
    @JavascriptInterface
    public boolean hasGatewayToken() {
      String token = secrets.reveal("gatewayToken");
      return token != null && !token.isEmpty();
    }

    /** Native reachability probe; the browser cannot probe the box directly (Origin 403). */
    @JavascriptInterface
    public String probeGateway(String gatewayUrl, String token) {
      String url = gatewayUrl == null ? "" : gatewayUrl.replaceAll("/+$", "");
      if (url.isEmpty()) return reply(false, "Not connected.");
      String host = null;
      try { host = new URL(url).getHost(); } catch (Exception ignored) { /* fall through */ }
      if (host == null || host.isEmpty()) return reply(false, "Enter the box gateway address as a full URL, for example http://192.168.1.8:1340.");
      String lower = host.toLowerCase(java.util.Locale.ROOT);
      if (lower.equals("127.0.0.1") || lower.equals("localhost") || lower.equals("::1") || lower.equals("0.0.0.0") || lower.startsWith("127.")) {
        return reply(false, "127.0.0.1 is this device itself, not the box. Enter the box's LAN address, for example http://192.168.1.8:1340.");
      }
      try {
        return probePool.submit(() -> probe(url, token == null ? "" : token)).get();
      } catch (Exception error) {
        return reply(false, "Can't reach that URL.");
      }
    }

    private static String probe(String base, String token) {
      HttpURLConnection connection = null;
      try {
        connection = (HttpURLConnection) new URL(base + "/events").openConnection();
        connection.setConnectTimeout(3_000);
        connection.setReadTimeout(3_000);
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setRequestProperty("Accept-Encoding", "identity");
        if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
        int status = connection.getResponseCode();
        if (status == 401 || status == 403) return reply(false, token.isEmpty() ? "Enter a token." : "Wrong token.");
        if (status >= 200 && status < 500) return reply(true, "Connected.");
        return reply(false, "Can't reach that URL.");
      } catch (Exception error) {
        return reply(false, "Can't reach that URL.");
      } finally {
        if (connection != null) connection.disconnect();
      }
    }

    private static String reply(boolean ok, String message) {
      return "{" + "\"ok\":" + ok + ",\"message\":" + JSONObject.quote(message) + "}";
    }
  }
}
