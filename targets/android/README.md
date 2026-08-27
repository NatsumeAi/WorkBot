# Android shell

WebView wrapper for a future **remote-control client**. Bots live on the Linux box; the phone must talk to that box’s **gateway** (HTTP + SSE + token), the same way the desktop coordinator does.

This directory is **not** a desktop WebSocket relay. Do not point the APK at a running Grok Bot window.

Native bits that stay: Custom Tabs / intents for `openExternal`, Keystore behind the same `desktop.secrets.*` names. Gateway client wiring is not in this shell yet.
