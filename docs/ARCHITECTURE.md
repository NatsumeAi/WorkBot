# Architecture

The repository keeps two editable source roots:

- `source/` contains the Electron main, host, coordinator, local-exec, shared,
  and protocol reconstruction.
- `frontend/` contains the React renderer reconstruction.

The Linux **box** (host + gateway + box-exec-daemon) is the server. The desktop
app is a remote control: the UI talks to a local coordinator, which talks
**directly** to the box gateway over HTTP + SSE + token. Multiple clients using
the same gateway URL and token see the same bots. There is no hop through
another desktop.

`source/client-runtime` can build a complete `DesktopBridge` for shells that
need it. Electron preload uses it over IPC. It is not a substitute for the box
gateway.

The upstream 0.18.0 application is an external, checksum-pinned build input.
`npm run bootstrap` extracts its `dist` tree to ignored `src/app/dist`. On
macOS that still comes from the pinned DMG; on other hosts set
`GROK_BOT_018_ASAR`. Build scripts stage that baseline, compile reviewed source
runtimes, overlay eligible clean outputs, apply the reconstructed updater
guard, and pack a new ASAR.

Small manifests remain checked in only where the build consumes them directly.
Large recovery reports, source capsules, rejected candidate evidence, and
screenshots live only in the private forensic history and are not part of this
branch's product tree.

See [PLATFORMS.md](PLATFORMS.md) for target status and capability gates.
