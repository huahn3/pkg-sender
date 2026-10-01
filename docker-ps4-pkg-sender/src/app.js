const express = require('express');
const morgan = require('morgan');
const mustache_express = require('mustache-express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const filesize = require('filesize');
const crypto = require('crypto');
const { readMetaSync } = require('./lib/pkgmeta');

const port = process.env.PORT ?? 7777;
const static_files_path = path.resolve(process.env.STATIC_FILES ?? './files');
const cache_dir = path.resolve(process.env.CACHE_DIR ?? './cache');
const ps4_ip = process.env.PS4IP ?? 'localhost';
const local_ip = process.env.LOCALIP ?? 'localhost';
const ps4_port = parseInt(process.env.PS4PORT ?? '12800', 10);
const install_delay_ms = parseInt(process.env.INSTALL_DELAY_MS ?? '300', 10);

const app = express();

app.use('/css', express.static(path.join(__dirname, '../node_modules/@fortawesome/fontawesome-free/css')));
app.use('/webfonts', express.static(path.join(__dirname, '../node_modules/@fortawesome/fontawesome-free/webfonts')));
app.use('/css', express.static(path.join(__dirname, '../node_modules/bootstrap/dist/css')));
app.use('/js', express.static(path.join(__dirname, '../node_modules/bootstrap/dist/js')));
app.use('/js', express.static(path.join(__dirname, '../node_modules/jquery/dist')));

app.use('/css', express.static(path.join(__dirname, '/views/css')));
app.use('/js', express.static(path.join(__dirname, '/views/js')));

app.use(morgan('combined'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));

app.engine('html', mustache_express());
app.set('view engine', 'html');
app.set('views', __dirname + '/views');

let console_cache = { at: 0, data: null };
const queue_state = { tasks: [], updatedAt: 0 };

// Stable ID mapping (parity with Loopayeh/pkg-sender LoopDPI.Core/RangeFileServer.cs):
// Avoid putting raw filenames, Chinese paths, spaces, brackets into the URL.
// The PS5 receiver's json_first_package calls url_decode, turning %XX back to raw bytes.
// If raw non-ASCII bytes reach Node's HTTP parser (llhttp), it returns 400 Bad Request.
// By serving /pkg/:id (e.g. /pkg/lib-4a8f9b2c1d3e5f67), the URL is 100% clean ASCII.
const id_to_abs = new Map();
const abs_to_id = new Map();

function stable_id(rel, size) {
  const norm = rel.split(path.sep).join('/').toLowerCase();
  const h = crypto.createHash('sha256').update(norm + '|' + (size || 0)).digest('hex');
  return 'lib-' + h.slice(0, 16);
}

function resolve_file(target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  if (id_to_abs.has(target)) return id_to_abs.get(target);
  return safe_resolve(target);
}

app.get('/', function (req, res) {
  const groups = build_groups();
  const total = groups.reduce((n, g) => n + g.pkgs.length, 0);
  const bytes = groups.reduce((n, g) => n + g.bytes, 0);
  res.render('index', {
    groups: groups,
    total: total,
    totalSize: filesize(bytes),
    consoleIp: ps4_ip,
    port: port,
    localIp: local_ip
  });
});

// Serve PKG by stable id (preferred: clean ASCII url, no charset/encoding issues on PS5)
app.get('/pkg/:id', function (req, res, next) {
  const abs = id_to_abs.get(req.params.id);
  if (abs && fs.existsSync(abs)) {
    return res.sendFile(abs, function (err) {
      if (err && !res.headersSent) res.status(404).end('not found');
    });
  }
  next();
});

// Fallback: serve PKG by relative path
app.get('/pkg/*', function (req, res) {
  const abs = safe_resolve(req.params[0]);
  if (!abs) return res.status(404).end('not found');
  res.sendFile(abs, function (err) {
    if (err && !res.headersSent) res.status(404).end('not found');
  });
});

app.get('/icon/:key.png', function (req, res) {
  const key = String(req.params.key).replace(/[^a-f0-9]/gi, '');
  if (!key) return res.status(404).end('not found');
  res.sendFile(path.join(cache_dir, 'icons', key + '.png'), function (err) {
    if (err && !res.headersSent) res.status(404).end('not found');
  });
});

app.get('/api/groups', function (req, res) {
  res.json(build_groups());
});

app.get('/api/console', async function (req, res) {
  const fresh = req.query.fresh === '1';
  if (!fresh && console_cache.data && Date.now() - console_cache.at < 4000) {
    return res.json(console_cache.data);
  }
  const data = await probe_console();
  console_cache = { at: Date.now(), data: data };
  res.json(data);
});

app.get('/api/queue', function (req, res) {
  res.json(queue_state);
});

app.post('/install', function (req, res) {
  const target = req.body.filepath || req.body.file;
  const abs = resolve_file(target) || (typeof target === 'string' ? safe_resolve(rel_from_filepath(target)) : null);
  if (!abs) return res.status(400).end('invalid file');
  const item = scan_item(rel_from_abs(abs), abs);
  res.type('text/plain; charset=utf-8');
  ps4_install(item)
    .then((r) => res.end(JSON.stringify(r, null, 2)))
    .catch((e) => res.status(502).end(`error: ${e.message}`));
});

app.post('/api/uninstall', async function (req, res) {
  const mode = (await probe_console()).mode;
  if (mode !== 'rpi') {
    return res.status(409).json({
      ok: false,
      error: mode === 'receiver'
        ? 'pkg-receiver 没有卸载接口 — 请在 PS5 上手动删除该游戏'
        : '只有 PS4 Remote Package Installer 支持卸载'
    });
  }
  const kind = String(req.body.kind || 'game');
  const map = { game: '/api/uninstall_game', patch: '/api/uninstall_patch', ac: '/api/uninstall_ac', theme: '/api/uninstall_theme' };
  const ep = map[kind] || map.game;
  const body = kind === 'ac' || kind === 'theme'
    ? JSON.stringify({ content_id: String(req.body.contentId || '') })
    : JSON.stringify({ title_id: String(req.body.titleId || '') });
  try {
    const r = await console_http(ps4_ip, ps4_port, ep, body, 8000);
    res.json({ ok: /success/.test(r.body), reply: r.body });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/api/install', async function (req, res) {
  const files = Array.isArray(req.body && req.body.files) ? req.body.files : [];
  const items = [];
  for (const f of files) {
    const abs = resolve_file(String(f));
    if (!abs || path.extname(abs).toLowerCase() !== '.pkg') {
      return res.status(400).json({ ok: false, error: `invalid file: ${f}` });
    }
    items.push(scan_item(rel_from_abs(abs), abs));
  }
  if (items.length === 0) return res.status(400).json({ ok: false, error: 'no files' });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no'
  });

  let cancelled = false;
  res.on('close', function () { if (!res.writableEnded) cancelled = true; });

  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) { cancelled = true; } };

  const probe = await probe_console();
  send({ type: 'start', total: items.length, console: { ip: ps4_ip, mode: probe.mode } });
  if (probe.mode === 'offline') {
    send({ type: 'done', total: items.length, done: 0, failed: items.length, error: 'console offline' });
    return res.end();
  }

  const started = Date.now();
  let done = 0, failed = 0;

  for (let i = 0; i < items.length; i++) {
    if (cancelled) break;
    const item = items[i];
    const task = {
      id: crypto.randomUUID(),
      file: item.rel,
      name: item.meta && item.meta.ok ? item.meta.title : item.name,
      state: 'pending',
      at: Date.now()
    };
    queue_state.tasks.unshift(task);
    queue_state.updatedAt = Date.now();
    if (queue_state.tasks.length > 200) queue_state.tasks.length = 200;

    try {
      const r = await ps4_install(item);
      const ok = r.ok;
      task.state = ok ? 'ok' : 'fail';
      task.reply = r.reply;
      ok ? done++ : failed++;
      send({ type: 'progress', index: i + 1, total: items.length, file: item.rel, ok: ok, reply: r.reply });
    } catch (e) {
      failed++;
      task.state = 'fail';
      task.reply = e.message;
      send({ type: 'progress', index: i + 1, total: items.length, file: item.rel, ok: false, error: e.message });
    }

    if (probe.mode === 'receiver') {
      const st = await receiver_status().catch(() => null);
      if (st) send({ type: 'console', busy: !!st.busy, active: st.active | 0 });
    }

    if (i < items.length - 1 && install_delay_ms > 0 && !cancelled) {
      await sleep(install_delay_ms);
    }
  }

  const summary = { type: 'done', total: items.length, done: done, failed: failed, ms: Date.now() - started };
  send(summary);
  queue_state.updatedAt = Date.now();
  res.end();
});

app.listen(port, function () {
  try { build_groups(); } catch (e) { console.error('Initial scan error:', e.message); }
  console.log(`PS4/PS5 PKG sender listening on port ${port}`);
  console.log(`  files:   ${static_files_path}`);
  console.log(`  cache:   ${cache_dir}`);
  console.log(`  console: ${ps4_ip}:${ps4_port}   downloads from: ${local_ip}:${port}`);
});

// ---------------------------------------------------------------- scan

function walk_pkgs(dir, out) {
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return out; }
  for (const file of files) {
    const abs = path.join(dir, file);
    let stat;
    try { stat = fs.statSync(abs); } catch (e) { continue; }
    if (stat.isDirectory()) walk_pkgs(abs, out);
    else if (path.extname(file).toLowerCase() === '.pkg') out.push({ abs: abs, stat: stat });
  }
  return out;
}

function scan_item(rel, abs) {
  let stat;
  try { stat = fs.statSync(abs); } catch (e) { stat = { size: 0 }; }
  const meta = readMetaSync(abs, cache_dir);
  const id = stable_id(rel, stat.size);
  id_to_abs.set(id, abs);
  abs_to_id.set(abs, id);
  return {
    id: id,
    rel: rel,
    name: path.basename(abs),
    dir: dir_of(rel),
    root: root_of(rel),
    bytes: stat.size,
    size: filesize(stat.size),
    meta: meta
  };
}

function build_groups() {
  const found = walk_pkgs(static_files_path, []);
  const items = found.map((f) => scan_item(rel_from_abs(f.abs), f.abs));

  const byKey = new Map();
  for (const it of items) {
    const m = it.meta;
    const key = m && m.ok && m.titleId ? m.titleId : 'DIR:' + it.root;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }

  const groups = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => {
      const rank = (x) => (x.meta && x.meta.ok ? ({ Game: 0, Patch: 1, DLC: 2 }[x.meta.role] ?? 3) : 0);
      return rank(a) - rank(b) || b.bytes - a.bytes;
    });
    const base = list.find((i) => i.meta && i.meta.ok && i.meta.role === 'Game') || list[0];
    const baseMeta = base.meta && base.meta.ok ? base.meta : null;
    const titleId = baseMeta ? baseMeta.titleId : '';
    const platform = baseMeta ? baseMeta.platform : '';
    const icon = pickIcon(list);
    const roles = { Game: 0, Patch: 0, DLC: 0, Other: 0 };
    for (const i of list) {
      const r = i.meta && i.meta.ok ? i.meta.role : null;
      if (r && roles[r] !== undefined) roles[r]++;
      else roles.Other++;
    }
    groups.push({
      id: crypto.randomUUID(),
      key: key,
      title: baseMeta && baseMeta.title ? baseMeta.title : base.root,
      folder: base.root,
      titleId: titleId,
      platform: platform,
      icon: icon,
      count: list.length,
      bytes: list.reduce((n, i) => n + i.bytes, 0),
      size: filesize(list.reduce((n, i) => n + i.bytes, 0)),
      roles: roles,
      pkgs: list.map((i) => ({
        id: i.id,
        rel: i.rel,
        dir: i.dir,
        name: i.name,
        bytes: i.bytes,
        size: i.size,
        title: i.meta && i.meta.ok ? i.meta.title : '',
        version: i.meta && i.meta.ok ? i.meta.version : '',
        role: i.meta && i.meta.ok ? i.meta.role : '',
        contentId: i.meta && i.meta.ok ? i.meta.contentId : '',
        icon: i.meta && i.meta.ok ? i.meta.iconKey : ''
      }))
    });
  }

  groups.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  return groups;
}

function pickIcon(list) {
  const base = list.find((i) => i.meta && i.meta.ok && i.meta.role === 'Game' && i.meta.iconKey);
  if (base) return base.meta.iconKey;
  const any = list.find((i) => i.meta && i.meta.ok && i.meta.iconKey);
  return any ? any.meta.iconKey : '';
}

function dir_of(rel) {
  const d = path.posix.dirname(rel);
  return d === '.' ? '' : d;
}

function root_of(rel) {
  const d = dir_of(rel);
  return d ? d.split('/')[0] : '';
}

// ---------------------------------------------------------------- fs helpers

function safe_resolve(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const abs = path.resolve(static_files_path, rel.replace(/^\/+/, ''));
  if (abs !== static_files_path && !abs.startsWith(static_files_path + path.sep)) return null;
  try { if (fs.statSync(abs).isFile()) return abs; } catch (e) { return null; }
  return null;
}

function rel_from_abs(abs) {
  return path.relative(static_files_path, abs).split(path.sep).join('/');
}

function rel_from_filepath(filepath) {
  if (typeof filepath !== 'string') return null;
  const abs = path.resolve(filepath);
  if (!abs.startsWith(static_files_path + path.sep)) return null;
  return safe_resolve(rel_from_abs(abs)) ? rel_from_abs(abs) : null;
}

function normalize_item(it) {
  if (!it) return null;
  if (typeof it === 'object' && it.rel) return it;
  const str = String(it);
  const abs = resolve_file(str);
  if (abs) return scan_item(rel_from_abs(abs), abs);
  return { rel: str, name: path.basename(str) };
}

function pkg_url(itemOrRel) {
  if (typeof itemOrRel === 'object' && itemOrRel && itemOrRel.id) {
    return `http://${local_ip}:${port}/pkg/${itemOrRel.id}`;
  }
  const str = typeof itemOrRel === 'string' ? itemOrRel : (itemOrRel?.rel || '');
  if (id_to_abs.has(str)) {
    return `http://${local_ip}:${port}/pkg/${str}`;
  }
  const abs = safe_resolve(str);
  if (abs) {
    if (abs_to_id.has(abs)) {
      return `http://${local_ip}:${port}/pkg/${abs_to_id.get(abs)}`;
    }
    try {
      const size = fs.statSync(abs).size;
      const id = stable_id(rel_from_abs(abs), size);
      id_to_abs.set(id, abs);
      abs_to_id.set(abs, id);
      return `http://${local_ip}:${port}/pkg/${id}`;
    } catch (e) {}
  }
  const encoded = str.split('/').map(encodeURIComponent).join('/');
  return `http://${local_ip}:${port}/pkg/${encoded}`;
}

function icon_url(iconKey) {
  return iconKey ? `http://${local_ip}:${port}/icon/${iconKey}.png` : '';
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---------------------------------------------------------------- console

function tcp_open(host, port, ms) {
  return new Promise(function (resolve) {
    const s = new net.Socket();
    const timer = setTimeout(function () { s.destroy(); resolve(false); }, ms);
    s.once('connect', function () { clearTimeout(timer); s.destroy(); resolve(true); });
    s.once('error', function () { clearTimeout(timer); s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

function console_http(ip, listenPort, reqPath, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const opts = {
      host: ip,
      port: listenPort,
      path: reqPath,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      timeout: timeoutMs || 3000
    };
    const req = http.request(opts, function (resp) {
      let data = '';
      resp.on('data', function (c) { data += c; if (data.length > 512 * 1024) resp.destroy(); });
      resp.on('end', function () { resolve({ status: resp.statusCode, body: data }); });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

async function try_json(ip, listenPort, reqPath, timeoutMs) {
  try {
    const r = await console_http(ip, listenPort, reqPath, null, timeoutMs);
    return JSON.parse(r.body);
  } catch (e) {
    return null;
  }
}

async function try_text(ip, listenPort, reqPath, timeoutMs) {
  try {
    const r = await console_http(ip, listenPort, reqPath, null, timeoutMs);
    return r.body;
  } catch (e) {
    return null;
  }
}

async function receiver_status() {
  return try_json(ps4_ip, ps4_port, '/api/status', 2500);
}

async function probe_console() {
  const out = {
    ip: ps4_ip,
    mode: 'offline',
    ports: {},
    status: null,
    space: null,
    version: null,
    label: '离线',
    detail: ''
  };

  const open12800 = await tcp_open(ps4_ip, ps4_port, 1500);
  out.ports[String(ps4_port)] = open12800 ? 'open' : 'closed';

  if (open12800) {
    const st = await try_json(ps4_ip, ps4_port, '/api/status', 2500);
    if (st && typeof st.busy !== 'undefined') {
      out.mode = 'receiver';
      out.status = { busy: !!st.busy, active: st.active | 0, pull: !!st.pull };
      out.version = await try_json(ps4_ip, ps4_port, '/api/version', 2500);
      out.space = await try_json(ps4_ip, ps4_port, '/api/space', 2500);
      out.label = 'PS5 pkg-receiver';
      out.detail = st.busy ? `安装中 · ${st.active | 0} 个活动任务` : '空闲';
    } else {
      const probe = await try_text(ps4_ip, ps4_port, '/api', 2500);
      if (probe && /Unsupported method/i.test(probe)) {
        out.mode = 'rpi';
        out.label = 'PS4 Remote Pkg Installer';
        out.detail = 'RPI 模式 · 支持任务进度与卸载';
      }
    }
  }

  if (out.mode === 'offline') {
    const open9090 = await tcp_open(ps4_ip, 9090, 1200);
    out.ports['9090'] = open9090 ? 'open' : 'closed';
    if (open9090) {
      const s = await try_text(ps4_ip, 9090, '/status', 2000);
      if (s && /"status"\s*:\s*"ready"/.test(s.replace(/\s/g, ''))) {
        out.mode = 'goldhen';
        out.label = 'PS4 GoldHEN';
        out.detail = 'GoldHEN Payload Server — 暂未支持直推，需要另加 payload 注入';
      }
    }
  }

  if (out.mode === 'offline') {
    const parts = Object.keys(out.ports).map((p) => `${p}:${out.ports[p]}`);
    out.label = '离线';
    out.detail = parts.length ? parts.join(' · ') : '连接不上主机';
  }
  return out;
}

// ---------------------------------------------------------------- install

async function ps4_install(item) {
  const norm = normalize_item(item);
  if (!norm) throw new Error('invalid item');
  const url = pkg_url(norm);
  const name = norm.meta && norm.meta.ok ? norm.meta.title : norm.name;
  const icon = norm.meta && norm.meta.ok ? icon_url(norm.meta.iconKey) : '';

  const body = JSON.stringify({
    type: 'direct',
    packages: [url],
    name: name,
    icon_url: icon
  });
  const r = await console_http(ps4_ip, ps4_port, '/api/install', body, 20000);
  const ok = /success/i.test(r.body || '');
  return { ok: ok, status: r.status, reply: (r.body || '').trim().slice(0, 300) };
}
