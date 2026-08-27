package com.grokbot.reconstructed;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONArray;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Keystore-backed store used by desktop.secrets.* — not a parallel mobile API. */
public final class SecretsStore {
  private static final String PREFS = "sand-secrets";
  private static final String KEY_ALIAS = "grok-bot-secrets";
  private final SharedPreferences prefs;
  private final SecretKey secretKey;

  public SecretsStore(Context context) {
    this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    this.secretKey = loadOrCreateKey();
  }

  public String listKeysJson() {
    JSONArray keys = new JSONArray();
    for (String key : prefs.getAll().keySet()) keys.put(key);
    return keys.toString();
  }

  public String reveal(String key) {
    String stored = prefs.getString(key, null);
    if (stored == null) return null;
    try {
      return decrypt(stored);
    } catch (Exception error) {
      return null;
    }
  }

  public void upsert(String key, String value) throws Exception {
    prefs.edit().putString(key, encrypt(value)).apply();
  }

  public void remove(String key) {
    prefs.edit().remove(key).apply();
  }

  private SecretKey loadOrCreateKey() {
    try {
      KeyStore store = KeyStore.getInstance("AndroidKeyStore");
      store.load(null);
      if (store.containsAlias(KEY_ALIAS)) {
        return (SecretKey) store.getKey(KEY_ALIAS, null);
      }
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build());
      return generator.generateKey();
    } catch (Exception error) {
      throw new IllegalStateException("Unable to open the Android Keystore for Grok Bot secrets.", error);
    }
  }

  private String encrypt(String value) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, secretKey);
    byte[] iv = cipher.getIV();
    byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
    return Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
  }

  private String decrypt(String stored) throws Exception {
    String[] parts = stored.split(":", 2);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
    return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
  }
}
