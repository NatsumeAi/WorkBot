# Platform shells

Grok Bot is one product: the Linux **box** is the server; every shell is a
remote of that box’s gateway (HTTP + SSE + token). Desktop stays in the
Electron family. Android is a thin WebView remote of the **same gateway**,
not a second chat app and not a desktop WebSocket relay.

The four-package contract — one UI directory, one wiring, one
`npm run pack:all` — is specified in [`docs/FOUR-PACK.md`](./FOUR-PACK.md),
including the three gates enforced by `npm run verify:four-pack`.

| Target | Family | Packager | Status |
| --- | --- | --- | --- |
| `macos-arm64` | Electron desktop | `scripts/package-macos.mjs` | Implemented |
| `windows-x64` | Electron desktop | `scripts/package-windows.mjs` | Implemented (Electron 42.1.0 zip) |
| `linux-x64` | Electron desktop | `scripts/package-linux.mjs` | Implemented (Electron 42.1.0 zip) |
| `android` | Thin WebView client | `scripts/package-android.mjs` | Implemented: shared client-UI parity + local forwarder + in-page web runtime (debug APK; device verification pending) |

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
npm run pack:all                               # one UI directory -> four packages + gates
GROK_BOT_PACK_TARGETS=android npm run pack:all # subset
npm run verify:four-pack                       # the three gates only
GROK_BOT_TARGET=macos-arm64 npm run package    # macOS .app
GROK_BOT_TARGET=android npm run package        # debug APK from the shared client-UI
GROK_BOT_TARGET=linux-x64 npm run package      # Electron 42.1.0 dir: dist/workbot-linux-x64
GROK_BOT_TARGET=windows-x64 npm run package    # Electron 42.1.0 dir: dist/workbot-win32-x64
```

Linux and Windows packagers download the pinned Electron 42.1.0 zip (`@electron/get` + `checksums.json`), put reconstructed `app.asar` in `resources/`, and copy `docs/self-host.md`. They do not unpack the official Windows Setup.exe.

The Android package stages the same client-UI directory as the Electron
packages (verified byte-for-byte against `client-ui-manifest.json`). The box
gateway rejects browser-origin requests with 403
(`source/host/gateway-server.ts`), so the phone reaches it only through the
on-device forwarder described in `docs/FOUR-PACK.md`.

## Bootstrap without hdiutil

On Linux, set `GROK_BOT_018_ASAR` to a checksum-pinned `app.asar` so
`npm run bootstrap` hydrates `src/app/dist` without mounting a DMG. macOS still
prefers the pinned DMG / `.app` cache for the Electron shell.
