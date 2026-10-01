# PS4 / PS5 PKG Sender (Docker web UI)

A [Docker compose](https://docs.docker.com/compose/) web UI for pushing `.pkg`
files to a jailbroken console over LAN — based on
[Flatz's Remote PKG Installer](https://gist.github.com/flatz/60956f2bf1351a563f625357a45cd9c8)
and the `pkg-receiver.elf` API from this repository.

## Features

- **Game cards with metadata** — parses each PKG header (CNT + `param.sfo` /
  `param.json`): title, Title ID, version, platform (PS4/PS5), and pulls
  `icon0.png` out as the cover.
- **Family grouping** — packages with the same Title ID (base + patch + DLC)
  collapse into one card with `本体 / 更新 / DLC` counts.
- **One-click install** — per-card **安装全部 (N)**, per-row **INSTALL**, header
  **一键安装全部 (N)**, or tick checkboxes and use the selection bar.
- **Live console status** — auto-detects what answers on the console
  (`pkg-receiver` / RPI / GoldHEN / offline), shows mode, busy state and
  `/data` free space; refresh every 5 s.
- **Install queue panel** — per-file pending / sent / failed rows, running
  summary, console activity line, clear.
- **Search / sort** — filter by title, filename, Title ID or path; sort by
  name / size / count.
- **Copy direct link** — copy the `http://<LOCALIP>:<PORT>/pkg/...` URL for any
  row (e.g. to paste into another downloader).
- **Uninstall** *(PS4 RPI only)* — pushes `uninstall_game` for a Title ID.

### Console support matrix

| Console / service | Detected as | Install | Status / space | Uninstall |
| ----------------- | ----------- | ------- | -------------- | --------- |
| PS5 + `pkg-receiver.elf` (port 12800) | `PS5 pkg-receiver` | ✅ | ✅ `busy`/`active`/`/api/space` | ❌ (delete on the console) |
| PS4 Remote PKG Installer (port 12800) | `PS4 Remote Pkg Installer` | ✅ | ✅ task ids | ✅ |
| PS4 GoldHEN payload server (port 9090) | `PS4 GoldHEN` | ⚠️ not yet (needs payload injection) | — | — |

## Quick start

```sh
docker compose up -d --build
# open http://<LOCALIP>:7895/
```

## Configure

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `7777` | Web UI port |
| `STATIC_FILES` | `./files` | Folder scanned for `*.pkg` (mount your games here, e.g. `/files`) |
| `CACHE_DIR` | `./cache` | Parsed metadata + cover cache (make it a volume to keep it) |
| `LOCALIP` | `localhost` | IP the **console** uses to download PKGs from this container |
| `PS4IP` | `localhost` | Console IP |
| `PS4PORT` | `12800` | Receiver / RPI port |
| `INSTALL_DELAY_MS` | `300` | Delay between two queued installs |

## Example: NAS + docker compose

```yaml
version: '3.8'

services:
  ps4-pkg-sender:
    build: .
    image: ps4-pkg-sender:local
    container_name: ps4-pkg-sender
    restart: unless-stopped
    ports:
      - "7895:7895"
    environment:
      - PORT=7895
      - STATIC_FILES=/files
      - CACHE_DIR=/cache
      - LOCALIP=192.168.31.88      # NAS/LAN IP the console downloads from
      - PS4IP=192.168.32.176       # console IP
      - PS4PORT=12800
      - INSTALL_DELAY_MS=300
    volumes:
      - /vol2/1000/R0/PS5/:/files:ro
      - ./cache:/cache
```

## API

| Method | Path | Body | Reply |
| ------ | ---- | ---- | ----- |
| GET | `/api/groups` | — | scanned library (metadata, roles, family groups) |
| GET | `/api/console?fresh=1` | — | `{mode, label, detail, status, space, ports}` |
| GET | `/api/queue` | — | last install tasks (up to 200) |
| POST | `/api/install` | `{"files":["<path relative to STATIC_FILES>", ...]}` | newline-delimited JSON (`start` / `progress` / `console` / `done`) |
| POST | `/api/uninstall` | `{"kind":"game","titleId":"CUSA…"}` | RPI only |
| GET | `/pkg/<relpath>` | — | PKG bytes (Range-capable) |
| GET | `/icon/<key>.png` | — | extracted cover |
| POST | `/install` | form field `filepath` (legacy) | plain-text reply |

## Local development (no Docker)

```sh
npm install
python3 tools/make_fake_pkgs.py        # writes valid fake PKGs into ./files
python3 tools/mock_console.py &        # fake console on 127.0.0.1:12800
PORT=7895 STATIC_FILES=./files CACHE_DIR=./cache \
  LOCALIP=127.0.0.1 PS4IP=127.0.0.1 node src/app.js
# open http://127.0.0.1:7895/
```

`tools/mock_console.py rpi` starts the mock in PS4-RPI mode instead
(`get_task_progress`, `uninstall_*`, task ids).
