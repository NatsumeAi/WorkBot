# WorkBot

Self-hosted Grok Bot 0.18: a Linux **box** runs the bots, and every desktop or
phone app is a remote control of that box.

This repository is an unofficial reconstruction and extension of the publicly
shipped Grok Bot 0.18.0 app. It is not Anysphere’s original source and not an
official Grok Bot release. See [NOTICE.md](NOTICE.md) and
[PROVENANCE.md](PROVENANCE.md).

## What it is

- **Box** = Linux server (`host-main` + gateway + `box-exec-daemon`). Bots,
  transcripts, files, tools, and Computer live on the box.
- **Desktop / Android** = clients. They do not keep a second copy of the bots.
- **Wire:** UI → coordinator on the client → HTTP `{gateway}/api/{method}` +
  SSE `{gateway}/events` + Bearer token. No second sync protocol. Closing a
  client does not stop the box. The same gateway URL and token show the same
  bots on every device.
- **Shipped UI:** official 0.18 renderer (`index-UbX-y3il.js`) plus
  `client-ui/renderer-overlay/` (Router / API settings). Recovered
  `frontend/` is a study workspace, not the packaged UI.
- **Data:** desktop `~/.openbot`; box `/home/box/sand-data` (Docker volume
  isolation). Do not dual-write credentials.

Chat works with custom API keys or a self-hosted gateway; Cursor login is not
required for that path. Outbound proxy is **Off** (direct) or a **Custom URL**
you paste. `127.0.0.1` / `localhost` always go direct so local APIs work.

## Architecture

```text
polished shipped renderer (0.18 asar + overlay)
          │
          │ window.desktop + coordinatorPort
          ▼
     coordinator on this computer
          │
          │ HTTP POST /api/*  +  SSE /events  +  token
          ▼
     Linux box gateway
          │
     host + box-exec-daemon
```

Main trees:

- `source/electron-main/` — desktop lifecycle, settings, box connect, RPC
- `source/electron-preload/` — `window.desktop` / `window.coordinatorPort`
- `source/node-agent-coordinator/` — HTTP+SSE client to the box
- `source/host/` — inference, tools, MCP, transcripts (on the box)
- `source/shared/` — contracts and protocol
- `client-ui/renderer-overlay/` — Router API settings over the pinned renderer
- `source/client-overrides/` — small official-chat overlays (jump to latest,
  rewind from a user message)
- `frontend/` — readable UI reconstruction; not what users run
- `targets/android/` — WebView client of the **box gateway**, not a desktop hop
- `scripts/` — bootstrap, four-pack, verify
- `tests/` — regressions and packed-asar needles

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/FOUR-PACK.md](docs/FOUR-PACK.md), [docs/self-host.md](docs/self-host.md).

## Requirements

- Node.js **26.5.x** (`>=26.5.0 <27`). Default nvm 22 will fail the packer on
  `node:sqlite`.
- Git LFS (pinned 0.18 installers)
- Docker on the Linux box for self-host
- Android SDK / Gradle only if you pack the APK

## Quick start

```sh
git clone https://github.com/NatsumeAi/WorkBot.git
cd WorkBot
git lfs install
git lfs pull
npm ci
source ~/.nvm/nvm.sh && nvm use 26.5.1
npm run bootstrap          # Linux: set GROK_BOT_018_ASAR if you have no DMG
npm run check
GROK_BOT_PACK_SKIP_CHECK=1 npm run pack:all
```

`npm run bootstrap` hydrates checksum-pinned `src/app/dist`. On Linux, point
`GROK_BOT_018_ASAR` at the official asar when you cannot mount the DMG.

Four-pack artifacts:

| Target | Output |
| --- | --- |
| Linux x64 | `dist/workbot-linux-x64/` and `.zip` |
| Windows x64 | `dist/workbot-win32-x64/` and `.zip` |
| Android | `dist/workbot-android.apk` |

Gates: `npm run verify:four-pack`. Linux/Windows share
`scripts/lib/package-electron.mjs` (same asar). Do not patch `/tmp` asar copies
or add a Linux-only packer.

Packaging notes: [docs/FOUR-PACK.md](docs/FOUR-PACK.md),
[docs/PLATFORMS.md](docs/PLATFORMS.md).

## Self-host

Install the box on a Linux machine that already has Docker (Settings → Server
→ Install), then **Connect** with the gateway URL and token. Access URL must
be reachable from the client. Same LAN is enough; other networks need your own
route (forward, VPN, public address). WorkBot does not ship a tunnel vendor.

Desktop credentials persist under `~/.openbot` (mode `0600`). See
[docs/self-host.md](docs/self-host.md).

## Router

**Settings → Router / API:** empty slot is Custom (your base URL and key), not
OpenRouter.com. Image generation is a separate pool with image models, not the
chat LLM. Compact-at uses unused context (50% unused of 200k → 100k).

## Development

```sh
npm test                  # node:test regressions
npm run typecheck         # frontend TypeScript (includes recovered workspace)
npm run source:typecheck  # runtime TypeScript
npm run pack:all          # Linux, Windows, Android from one client-UI
npm run verify:four-pack  # three release gates
```

Ignored locally: `.cache`, `.build`, `dist`, `src/app/dist`, `.env*`,
`.cursor/`, `.grok-local/`, credentials, and generated Android `www/`.

## Preserved 0.18 installers

Research copies of the exact 0.18.0 installers live under
`research-archives/original/0.18.0/` (Git LFS):

| Platform | File | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `macos-arm64/Grok_Bot_0.18.0.dmg` | `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb` |
| Windows x64 | `windows-x64/Grok_Bot_0.18.0_Setup.exe` | `464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e` |

See [research-archives/README.md](research-archives/README.md).

## Status

Linux, Windows, and Android packs are produced from one client-UI. The app is
still an experimental reconstruction of one pinned 0.18 release. It does not
promise compatibility with later official Grok Bot versions.

Changes: [CONTRIBUTING.md](CONTRIBUTING.md). Publishing:
[docs/PUBLISHING.md](docs/PUBLISHING.md).
