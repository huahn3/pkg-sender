---
name: pkg-sender
description: Use when working in the pkg-sender repo — Docker web UI (docker-ps4-pkg-sender) dev/preview/publish, PKG metadata parsing parity with LoopDPI.Core, PS4/PS5 receiver protocol, or when asked where a feature lives or how to build/test/release anything in this repository.
---

# pkg-sender repo

Onboarding + fast paths. Full detail lives in `AGENTS.md` at the repo root —
read it before making changes; this skill is the quick-reference layer.

## What ships (three things, one repo)

1. **Desktop app** — `.NET 8` Avalonia: `library/` (UI) + `LoopDPI.Core/` (logic).
2. **PS5 receiver payload** — `payload/main.c` → shipped `payload/pkg-receiver.elf`, listens on `12800`.
3. **Docker web UI** — `docker-ps4-pkg-sender/` (Node 20/Express), image `ghcr.io/huahn3/docker-ps4-pkg-sender:latest`.

## 60-second web UI preview (no Docker, no console)

```sh
cd docker-ps4-pkg-sender
npm install
python3 tools/make_fake_pkgs.py                                  # valid fake PKGs -> ./files
python3 tools/mock_console.py receiver > /tmp/mock.log 2>&1 &    # fake PS5 receiver :12800
PORT=7895 STATIC_FILES=./files CACHE_DIR=./cache \
  LOCALIP=127.0.0.1 PS4IP=127.0.0.1 INSTALL_DELAY_MS=120 \
  node src/app.js > /tmp/webui.log 2>&1 &
```

Open <http://127.0.0.1:7895/>. Switch the mock to PS4-RPI mode with
`python3 tools/mock_console.py rpi` (adds `get_task_progress` / `uninstall_*`).
Stop everything: `pkill -f "node src/app.js"; pkill -f mock_console.py`.

## Key files

| Task | File |
| ---- | ---- |
| Web UI server, probe/install APIs | `docker-ps4-pkg-sender/src/app.js` |
| PKG header parsing (web) | `docker-ps4-pkg-sender/src/lib/pkgmeta.js` |
| PKG header parsing (desktop, source of truth) | `LoopDPI.Core/PkgInfo.cs` |
| Role/family rules (desktop) | `library/Views/LibraryView.axaml.cs` → `ToGameItem`, `FamilyKeyOf` |
| PS4 install paths (RPI + GoldHEN) | `LoopDPI.Core/Ps4Installer.cs` |
| Receiver API client | `LoopDPI.Core/ReceiverClient.cs`, `ConsoleClient.cs` |
| Web UI page + JS | `docker-ps4-pkg-sender/src/views/index.html`, `src/views/js/app.js` |
| Image build/publish | `Dockerfile`, `.github/workflows/docker-image.yml` |

## Non-negotiable rules

- **Parser parity**: `pkgmeta.js` mirrors `PkgInfo.cs`. Changing parsing, role
  (`DLC`/`Patch`/`Game`) or family key rules means changing both sides.
- **One URL per install request** to the PS5 receiver (it only reads `packages[0]`);
  RPI accepts an array.
- **Encode console URLs exactly once** (spaces/special chars break installs — issue #6).
- **Never assume RPI endpoints on a PS5** — no `uninstall_*`, no `get_task_progress`.
- Don't commit `files/`, `cache/`, `node_modules/`, `*.log`; do keep `package-lock.json` in sync.

## Build / release quick reference

```sh
dotnet build library/PkgSender.csproj            # desktop app
dotnet publish library/PkgSender.csproj -c Release -r linux-x64 \
  --self-contained true /p:PublishSingleFile=true -o publish
cd payload && make PS5_PAYLOAD_SDK=/path/to/sdk  # rebuild receiver (ps5-payload-sdk)
python3 tests/mock_receiver.py                   # receiver file endpoints for sendtest
dotnet run --project tests/sendtest -- <ip>
```

Publishing the web UI image: commit + push changes under `docker-ps4-pkg-sender/`
to `main` → GitHub Actions builds and pushes GHCR (~35 s). Manual re-run:
Actions → "Build & publish Docker image (GHCR)" → Run workflow.

## Environment the maintainer uses

- Console: **PS5, firmware 13.6, Relapse exploit** (`~/Desktop/Relapse-Exploit`,
  payloads: kstuff + etaHEN + shadowmountplus + zftpd; elfldr on `9021`).
- NAS compose: port `7895`, `LOCALIP=<NAS IP>`, `PS4IP=<PS5 IP>`, games mounted
  read-only at `/files`.
