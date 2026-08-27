# Platform shells

Grok Bot is one product: the Linux **box** is the server; every shell is a
remote of that box’s gateway (HTTP + SSE + token). Desktop stays in the
Electron family. Android is a WebView stub for a future client of the **same
gateway**, not a second chat app and not a desktop WebSocket relay.

| Target | Family | Packager | Status |
| --- | --- | --- | --- |
| `macos-arm64` | Electron desktop | `scripts/package-macos.mjs` | Implemented |
| `windows-x64` | Electron desktop | `scripts/package-windows.mjs` | Implemented (Electron 42.1.0 zip) |
| `linux-x64` | Electron desktop | `scripts/package-linux.mjs` | Implemented (Electron 42.1.0 zip) |
| `android` | Thin WebView client | `scripts/package-android.mjs` | Shell stub (debug APK); gateway client not wired |

The catalog in [`manifests/platforms.json`](../manifests/platforms.json) is the
single source of truth. Loaders live in `source/shared/platform-targets.ts` and
`scripts/lib/platforms.mjs`.

## Capabilities

Every `DesktopBridge` method exists on every shell. Work that a shell cannot
do yet returns `{ code: "unsupported-capability", capability }` rather than
omitting the function.

Android v1 live capabilities: `conversation`, `auth`, `inferenceRouter`,
`secrets`, `remoteBox`. Computer/VNC, local Docker, MCP, window chrome, and
WebAuthn stay present and gated.

## Packaging

`npm run package` dispatches through `scripts/package.mjs` using
`GROK_BOT_TARGET` or the host OS:

```sh
GROK_BOT_TARGET=macos-arm64 npm run package   # macOS .app
GROK_BOT_TARGET=android npm run package       # debug APK + staged www
GROK_BOT_TARGET=linux-x64 npm run package     # Electron 42.1.0 dir: dist/openbot-linux-x64
GROK_BOT_TARGET=windows-x64 npm run package   # Electron 42.1.0 dir: dist/openbot-win32-x64
```

Linux and Windows packagers download the pinned Electron 42.1.0 zip (`@electron/get` + `checksums.json`), put reconstructed `app.asar` in `resources/`, and copy `docs/self-host.md`. They do not unpack the official Windows Setup.exe.

Android packaging can still stage a WebView shell. That shell must eventually
speak the box **gateway** (HTTP + SSE + token), not a desktop WebSocket.

## Bootstrap without hdiutil

On Linux, set `GROK_BOT_018_ASAR` to a checksum-pinned `app.asar` so
`npm run bootstrap` hydrates `src/app/dist` without mounting a DMG. macOS still
prefers the pinned DMG / `.app` cache for the Electron shell.
