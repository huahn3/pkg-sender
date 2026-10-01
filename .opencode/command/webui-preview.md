---
description: Start the Docker web UI locally with fake PKGs and a mock console (no Docker needed), then report the preview URL.
agent: build
---

Start a local preview of the Docker web UI (`docker-ps4-pkg-sender/`):

1. `cd docker-ps4-pkg-sender && npm install` (skip if `node_modules/` exists).
2. If `files/` is empty or missing, run `python3 tools/make_fake_pkgs.py`.
3. Start the mock console on `127.0.0.1:12800` in the background
   (`python3 tools/mock_console.py receiver`; use mode `rpi` if the user asks for PS4 mode).
4. Start the server in the background:
   `PORT=7895 STATIC_FILES=./files CACHE_DIR=./cache LOCALIP=127.0.0.1 PS4IP=127.0.0.1 INSTALL_DELAY_MS=120 node src/app.js`
   (If port 7895 is taken, pick another PORT and use it below.)
5. Verify: `GET /` returns 200 and `GET /api/console?fresh=1` returns
   `"mode":"receiver"`.
6. Report the preview URL (`http://127.0.0.1:<port>/`), what the status pill
   shows, and how to stop everything (`pkill -f "node src/app.js"; pkill -f mock_console.py`).

If a process is already running from a previous session, kill it first instead of starting a duplicate.

$ARGUMENTS
