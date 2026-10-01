# AGENTS.md

Guidance for AI assistants (and humans) working in this repository.
Read this first — it saves rediscovering how the project fits together.

## What this repo is

Three shippable things live side by side:

| # | Thing | Where | Stack |
| - | ----- | ----- | ----- |
| 1 | **PKG Sender desktop app** (main product) | `library/` + `LoopDPI.Core/` | .NET 8 / Avalonia, cross-platform (Win/Linux/macOS/Android/iOS) |
| 2 | **PS5 receiver payload** (runs on the console) | `payload/` | C, ps5-payload-sdk, ships as `payload/pkg-receiver.elf` |
| 3 | **Docker web UI** (NAS-friendly web frontend) | `docker-ps4-pkg-sender/` | Node 20 / Express, image published to GHCR |

All three talk the same console protocol (see [Architecture](#architecture)).

## Repo map

| Path | Purpose |
| ---- | ------- |
| `LoopDPI.Core/` | Shared library: console clients, PKG parsing, file server, scanning. Key files: `PkgInfo.cs` (PKG header + param.sfo/json reader), `Ps4Installer.cs` (PS4 RPI + GoldHEN push), `ConsoleClient.cs` / `ReceiverClient.cs` (PS5 receiver API), `RangeFileServer.cs` (port 9898 file server + `/catalog`), `GameLibrary.cs`, `TransferManager.cs` |
| `library/` | Avalonia UI (entry `library/Program.cs`, `MainWindow.axaml`, `Views/LibraryView.axaml.cs` — role/family rules live here), `pkg_header.py` header bridge |
| `payload/` | PS5 receiver source (`main.c`, `Makefile`), `serve_pkg.py` dev helper, shipped `pkg-receiver.elf` |
| `docker-ps4-pkg-sender/` | **Self-contained Node web UI** (own `package.json`, `README.md`, `Dockerfile`, `docker-compose.yml`). Entry `src/app.js`, PKG parser `src/lib/pkgmeta.js`, UI `src/views/`, dev tools `tools/` |
| `tests/` | `mock_receiver.py` (mocks receiver file endpoints), `sendtest/` + `srvtest/` (.NET console harnesses) |
| `.github/workflows/` | CI: `docker-image.yml`, `linux-deb.yml`, `ios.yml` |
| `docs/` | Screenshots used by the README |
| `preview-ui.html`, `mockup/` | Design mock-ups only — not shipped |
| `installer.iss`, `Build-Release.bat` | Windows installer/release script |
| `THEME.md` | Design tokens (colors/typography) shared with sibling apps |
| `firmware-test.md` | Manual PS5 firmware test checklist |

## Fast paths (commands)

```sh
# --- desktop app ---
dotnet build library/PkgSender.csproj            # build
Build-Release.bat                                # Windows: self-contained dist/ + installer
dotnet publish library/PkgSender.csproj -c Release -r linux-x64 \
  --self-contained true /p:PublishSingleFile=true -o publish   # same as CI

# --- receiver payload (needs ps5-payload-sdk) ---
cd payload && make PS5_PAYLOAD_SDK=/path/to/ps5-payload-sdk

# --- receiver-side tests ---
python3 tests/mock_receiver.py                   # mock receiver file endpoints
dotnet run --project tests/sendtest -- <console-ip>

# --- docker web UI, local preview (no Docker needed) ---
cd docker-ps4-pkg-sender
npm install
python3 tools/make_fake_pkgs.py                  # writes valid fake PKGs into ./files
python3 tools/mock_console.py &                  # fake console on 127.0.0.1:12800
PORT=7895 STATIC_FILES=./files CACHE_DIR=./cache \
  LOCALIP=127.0.0.1 PS4IP=127.0.0.1 node src/app.js
# open http://127.0.0.1:7895/     (mock in RPI mode: python3 tools/mock_console.py rpi)
# stop: pkill -f "node src/app.js"; pkill -f mock_console.py
```

## Architecture

### Ports & protocols

| Port | Who | What |
| ---- | --- | ---- |
| `9898` | PC app | HTTP file server (Range) + `/catalog` for the console browser page |
| `12801` / `12802` | PC app | UDP beacons (`PKGSENDER v1`, `PKGSENDER-PC <ip>:9898`) for auto-discovery |
| `12800` | PS5 `pkg-receiver.elf` **or** PS4 RPI | Install API (`POST /api/install`), `GET /api/status`, `GET /api/space`, `GET /api` probe |
| `9090` (+`9021`/`9020`) | PS4 GoldHEN | Payload server / binloader (web UI does **not** support this yet) |
| `2120`/`8888` | zftpd payload (separate project) | FTP + web file manager |
| `7895` | Docker web UI | Web UI + PKG download URLs (`/pkg/...`, `/icon/...`) |

### Console install paths

- **PS5** → `pkg-receiver.elf` on `12800`. Body: `{"packages":["<url>"],"name":"...","icon_url":"..."}`.
  The receiver parses **only the first** URL per request — send one package per call.
- **PS4 (recommended)** → Remote Package Installer on `12800`. Body: `{"type":"direct","packages":[...]}`.
  Returns task ids; supports `get_task_progress`, `pause/resume/unregister_task`, `uninstall_*`, `is_exists`.
- **PS4 (fallback)** → GoldHEN payload injection (`Ps4Installer.PushGoldHenAsync`, manifest + callback). Only implemented in the desktop app.

Both web UI and desktop app **auto-detect** the mode by probing `12800` (`/api/status` → receiver, `/api` → RPI) then `9090/status` → GoldHEN.

### Parity rule (important)

`docker-ps4-pkg-sender/src/lib/pkgmeta.js` is a **hand-ported mirror** of
`LoopDPI.Core/PkgInfo.cs`. If you change PKG parsing, role classification, or
family grouping on one side, change the other. The shared rules are:

- CNT/FIH container walk → entry table → `param.sfo` (PS4, id `0x1000`) / `param.json` (PS5, id `0x2000`)
- cover = first PNG among entry ids `0x1200`–`0x1220` (`icon0.png`)
- **role**: `category == "ac"` or title/content-id contains `dlc/add-on/expansion/season pass` → `DLC`;
  `category == "gp"` (or filename `patch`/`update`) → `Patch`; else `Game`
  (implemented in `LibraryView.axaml.cs` `ToGameItem` / `pkgmeta.js` `roleOf`)
- **family key**: uppercase Title ID when length ≥ 4, else fallback
  (`DIR:<folder>` in the web UI, `FILE:<name>` in the desktop app)

## CI / release matrix

| Workflow | Trigger | Output |
| -------- | ------- | ------ |
| `docker-image.yml` | push to `main` touching `docker-ps4-pkg-sender/**` (or manual) | `ghcr.io/huahn3/docker-ps4-pkg-sender:latest` + `sha-<short>` |
| `linux-deb.yml` | push touching `library/**`, `LoopDPI.Core/**`, `payload/pkg-receiver.elf` | `.deb` artifact |
| `ios.yml` | push touching `ios/**`, `LoopDPI.Core/**` | iOS IPA |
| releases | manual `Build-Release.bat` on Windows | `PkgSender-Setup-*.exe`, self-updating asset |

Desktop app version lives in `<Version>` of `library/PkgSender.csproj` (CI reads it for the `.deb`).

## Conventions & gotchas

- **Do not commit** `docker-ps4-pkg-sender/files/`, `cache/`, `node_modules/`, `server.log` (gitignored;
  regenerate with `tools/make_fake_pkgs.py`). `package-lock.json` **is** tracked — keep it in sync
  (`npm install` locally; the Dockerfile uses `npm ci`).
- `payload/*.elf` is gitignored **except** the shipped `payload/pkg-receiver.elf` (force-added on purpose —
  the release workflows and users need it).
- **Issue #6**: console installer breaks on spaces/special chars. URLs are percent-encoded exactly once
  (`Ps4Installer.EncodeUrlOnce`, `pkg_url()` in the web UI). Never double-encode.
- PS5 receiver (`pkg-receiver.elf`) ≠ PS4 RPI: same port, different feature set. Never assume
  RPI endpoints (`uninstall_*`, `get_task_progress`) exist on a PS5.
- GoldHEN support exists **only** in the desktop app; the web UI detects it and shows "not yet supported".
- UI dark theme tokens are in `THEME.md` — the web UI's own palette is in
  `docker-ps4-pkg-sender/src/views/css/style.css` (`:root` variables).
- Chinese strings in the web UI (`src/views/index.html`, `src/views/js/app.js`) are user-facing; keep them consistent.

## Docs index

- `README.md` — user manual for the desktop app (tutorials, receiver API, troubleshooting)
- `docker-ps4-pkg-sender/README.md` — Docker web UI: features, env vars, HTTP API, compose examples
- `THEME.md`, `SECURITY.md`, `firmware-test.md` — design tokens, vulnerability reporting, firmware checklist
