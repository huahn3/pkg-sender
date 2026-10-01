const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const state = { mode: 'offline', consoleInfo: null, qCounter: 0, qOk: 0, qFail: 0 };

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function fmtSize(n) {
  if (!n || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + units[i];
}

function flash(msg, kind) {
  let el = $('#flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    document.body.appendChild(el);
  }
  el.className = 'flash show ' + (kind || 'ok');
  el.textContent = msg;
  clearTimeout(el.__t);
  el.__t = setTimeout(function () { el.className = 'flash'; }, 2600);
}

function pkgUrl(idOrRel) {
  const base = window.__BASE__ || '';
  if (typeof idOrRel === 'string' && idOrRel.startsWith('lib-')) {
    return base + '/pkg/' + idOrRel;
  }
  return base + '/pkg/' + String(idOrRel).split('/').map(encodeURIComponent).join('/');
}

// ------------------------------------------------------------ console status

async function refreshConsole(fresh) {
  try {
    const r = await fetch('/api/console' + (fresh ? '?fresh=1' : ''));
    const j = await r.json();
    state.consoleInfo = j;
    state.mode = j.mode;
    renderConsole(j);
  } catch (e) {
    renderConsole({ mode: 'offline', label: '离线', detail: e.message, space: null });
  }
}

function renderConsole(j) {
  const dot = $('#console_dot');
  const label = $('#console_label');
  const detail = $('#console_detail');
  const pill = $('#console_pill');
  pill.className = 'console-pill mode-' + j.mode;
  dot.className = 'dot';
  let text = j.label || j.mode;
  if (j.status && j.status.busy) text += ' · 安装中 ' + (j.status.active || 0);
  label.textContent = text;
  let d = j.detail || '';
  if (j.space && j.space.free >= 0) d += (d ? ' · ' : '') + '可用 ' + fmtSize(j.space.free) + ' / ' + fmtSize(j.space.total);
  detail.textContent = d;
  const qc = $('#q_console');
  if (qc) qc.textContent = text + (d ? ' — ' + d : '');
}

function startConsolePolling() {
  refreshConsole(true);
  setInterval(function () {
    if (document.hidden) return;
    if (state.busy) return;
    refreshConsole(false);
  }, 5000);
}

// ------------------------------------------------------------ search / sort

function applyFilter() {
  const q = $('#search').value.trim().toLowerCase();
  $('#clear_search').classList.toggle('d-none', !q);
  let shownGroups = 0;
  $$('#list .group').forEach(function (g) {
    if (!q) {
      g.classList.remove('filtered-out');
      $$('.row', g).forEach(function (r) { r.style.display = ''; });
      shownGroups++;
      return;
    }
    const gHit = (g.dataset.title + ' ' + g.dataset.titleId + ' ' + g.dataset.key + ' ' + g.dataset.platform)
      .toLowerCase().indexOf(q) >= 0;
    let rows = 0;
    $$('.row', g).forEach(function (r) {
      const hay = (r.dataset.name + ' ' + r.dataset.title + ' ' + r.dataset.rel + ' ' +
        r.dataset.role + ' ' + r.dataset.contentId).toLowerCase();
      const hit = gHit || hay.indexOf(q) >= 0;
      r.style.display = hit ? '' : 'none';
      if (hit) rows++;
    });
    g.classList.toggle('filtered-out', rows === 0);
    if (rows > 0) shownGroups++;
  });
  const empty = $('#empty_search');
  if (shownGroups === 0) {
    if (!empty) {
      const d = document.createElement('div');
      d.id = 'empty_search';
      d.className = 'alert alert-secondary m-3';
      d.textContent = '没有匹配 “' + q + '” 的游戏或文件';
      $('#list').appendChild(d);
    }
  } else if (empty) {
    empty.remove();
  }
}

function applySort() {
  const mode = $('#sort').value;
  const list = $('#list');
  const groups = $$('#list .group');
  groups.sort(function (a, b) {
    if (mode === 'size') return Number(b.dataset.bytes) - Number(a.dataset.bytes);
    if (mode === 'count') return Number(b.dataset.count) - Number(a.dataset.count);
    return a.dataset.title.localeCompare(b.dataset.title, 'zh');
  });
  groups.forEach(function (g) { list.appendChild(g); });
}

// ------------------------------------------------------------ selection

function selectedRows() {
  return $$('.row-check:checked').map(function (c) { return c.closest('.row'); });
}

function updateSelbar() {
  const rows = selectedRows();
  const bar = $('#selbar');
  if (!rows.length) {
    bar.classList.add('d-none');
    return;
  }
  bar.classList.remove('d-none');
  const bytes = rows.reduce(function (n, r) { return n + Number(r.dataset.bytes || 0); }, 0);
  $('#sel_count').textContent = '已选 ' + rows.length + ' 个';
  $('#sel_size').textContent = fmtSize(bytes);
}

// ------------------------------------------------------------ queue + install

function showQueue() {
  $('#queue').classList.remove('d-none');
}

function queueRow(rel) {
  const name = rel.split('/').pop();
  let row = $$('#q_body .qrow').find(function (r) { return r.dataset.rel === rel; });
  if (!row) {
    row = document.createElement('div');
    row.className = 'qrow';
    row.dataset.rel = rel;
    row.innerHTML =
      '<span class="qstate st-pending"><i class="fa-solid fa-circle-notch fa-spin"></i></span>' +
      '<span class="qname" title="' + esc(rel) + '">' + esc(name) + '</span>' +
      '<span class="qmsg"></span>';
    $('#q_body').prepend(row);
  }
  return row;
}

function setQueueRow(row, cls, msg) {
  const st = row.querySelector('.qstate');
  st.className = 'qstate st-' + cls;
  st.innerHTML =
    cls === 'ok' ? '<i class="fa-solid fa-check"></i>' :
    cls === 'fail' ? '<i class="fa-solid fa-xmark"></i>' :
    cls === 'active' ? '<i class="fa-solid fa-spinner fa-spin"></i>' :
    '<i class="fa-regular fa-clock"></i>';
  row.querySelector('.qmsg').textContent = msg || '';
}

function updateSummary() {
  const total = $$('#q_body .qrow').length;
  $('#q_summary').textContent = total
    ? '共 ' + total + ' · 成功 ' + state.qOk + ' · 失败 ' + state.qFail
    : '';
}

async function installFiles(files, label) {
  if (!files.length) return;
  files.forEach(function (f) { setQueueRow(queueRow(f), 'pending', '排队中'); });
  state.qOk = 0;
  state.qFail = 0;
  state.qCounter = files.length;
  showQueue();
  updateSummary();
  $('#q_title').textContent = label || ('安装 ' + files.length + ' 个 PKG');

  state.busy = true;
  try {
    const resp = await fetch('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(function () { return {}; });
      flash('失败：' + (err.error || resp.statusText), 'err');
      files.forEach(function (f) { setQueueRow(queueRow(f), 'fail', err.error || resp.statusText); });
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        handleStream(msg);
      }
    }
  } catch (e) {
    flash('连接失败：' + e.message, 'err');
  } finally {
    state.busy = false;
    refreshConsole(true);
    updateSummary();
  }
}

function handleStream(msg) {
  if (msg.type === 'start') {
    $('#q_title').textContent = $('#q_title').textContent + ' · 主机 ' + (msg.console ? msg.console.ip : '');
    if (msg.console && msg.console.mode === 'offline') {
      flash('主机离线 — 先在 PS5 上启动接收端', 'err');
    }
  } else if (msg.type === 'progress') {
    const row = queueRow(msg.file);
    if (msg.ok) {
      state.qOk++;
      setQueueRow(row, 'ok', '已发送');
    } else {
      state.qFail++;
      setQueueRow(row, 'fail', msg.error || msg.reply || '失败');
    }
    updateSummary();
  } else if (msg.type === 'console') {
    const qc = $('#q_console');
    qc.textContent = msg.busy ? ('主机安装中 · 活动任务 ' + msg.active) : '主机空闲';
  } else if (msg.type === 'done') {
    const suffix = msg.failed ? ('失败 ' + msg.failed) : ('完成 ' + msg.done);
    flash(suffix + (msg.error ? ' — ' + msg.error : ''), msg.failed ? 'err' : 'ok');
  }
}

// ------------------------------------------------------------ events

document.addEventListener('click', function (e) {
  const one = e.target.closest('.install-one');
  if (one) {
    e.preventDefault();
    e.stopPropagation();
    installFiles([one.dataset.rel], '安装单个 PKG');
    return;
  }

  const folder = e.target.closest('.install-folder');
  if (folder) {
    e.preventDefault();
    const panel = $(folder.dataset.target);
    const files = $$('.install-one', panel).map(function (b) { return b.dataset.rel; });
    const title = folder.closest('.group').dataset.title;
    installFiles(files, '一键安装：' + title);
    return;
  }

  const everything = e.target.closest('#install_everything');
  if (everything) {
    e.preventDefault();
    const files = $$('.install-one').map(function (b) { return b.dataset.rel; });
    installFiles(files, '一键安装全部 PKG');
    return;
  }

  const copy = e.target.closest('.copy-link');
  if (copy) {
    e.preventDefault();
    e.stopPropagation();
    const row = copy.closest('.row');
    const target = row.dataset.id || row.dataset.rel;
    const url = pkgUrl(target);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () { flash('已复制直链'); },
        function () { window.prompt('复制这个链接：', url); }
      );
    } else {
      window.prompt('复制这个链接：', url);
    }
    return;
  }

  const un = e.target.closest('.uninstall-game');
  if (un) {
    e.preventDefault();
    e.stopPropagation();
    const g = un.closest('.group');
    const tid = g.dataset.titleId;
    if (!tid) return flash('没有 Title ID，无法卸载', 'err');
    if (!window.confirm('在主机上删除「' + g.dataset.title + '」本体？ (' + tid + ')')) return;
    fetch('/api/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'game', titleId: tid })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { flash(j.ok ? '已请求卸载 ' + tid : (j.error || JSON.stringify(j)), j.ok ? 'ok' : 'err'); })
      .catch(function (er) { flash('卸载失败：' + er.message, 'err'); });
    return;
  }

  if (e.target.closest('#sel_install')) {
    const files = selectedRows().map(function (r) { return r.dataset.rel; });
    installFiles(files, '安装选中的 ' + files.length + ' 个');
    return;
  }

  if (e.target.closest('#sel_clear')) {
    $$('.row-check:checked, .check-all:checked').forEach(function (c) { c.checked = false; });
    updateSelbar();
    return;
  }

  if (e.target.closest('#q_close')) {
    $('#queue').classList.add('d-none');
    return;
  }

  if (e.target.closest('#q_clear')) {
    $('#q_body').innerHTML = '';
    state.qOk = 0;
    state.qFail = 0;
    updateSummary();
    return;
  }

  if (e.target.closest('#clear_search')) {
    $('#search').value = '';
    applyFilter();
    return;
  }

  if (e.target.closest('#console_pill')) {
    refreshConsole(true);
    return;
  }
});

document.addEventListener('change', function (e) {
  if (e.target.classList.contains('row-check')) {
    updateSelbar();
    return;
  }
  if (e.target.classList.contains('check-all')) {
    const group = e.target.closest('.group');
    $$('.row-check', group).forEach(function (c) { c.checked = e.target.checked; });
    updateSelbar();
    return;
  }
  if (e.target.id === 'sort') {
    applySort();
  }
});

let searchTimer = null;
document.addEventListener('input', function (e) {
  if (e.target.id === 'search') {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilter, 120);
  }
});

document.addEventListener('DOMContentLoaded', function () {
  applySort();
  applyFilter();
  updateSelbar();
  startConsolePolling();
});
