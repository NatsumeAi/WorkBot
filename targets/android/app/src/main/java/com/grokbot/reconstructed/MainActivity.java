package com.grokbot.reconstructed;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;
import org.json.JSONObject;
import java.util.Iterator;

public class MainActivity extends AppCompatActivity {
  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    WebView webView = new WebView(this);
    setContentView(webView);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(true);
    webView.setWebViewClient(new WebViewClient());
    webView.addJavascriptInterface(new SandNative(this), "SandNative");
    webView.loadUrl("file:///android_asset/www/index.html");
  }

  public static final class SandNative {
    private final MainActivity activity;
    private final SecretsStore secrets;

    SandNative(MainActivity activity) {
      this.activity = activity;
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
      org.json.JSONArray array = new org.json.JSONArray(keysJson);
      for (int index = 0; index < array.length(); index += 1) {
        secrets.remove(array.getString(index));
      }
    }
  }
}
