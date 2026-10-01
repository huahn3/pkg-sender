const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SFO_CAP = 1024 * 1024;
const ICON_CAP = 8 * 1024 * 1024;

function u32be(b, o) { return b.readUInt32BE(o); }
function u64le(b, o) { return b.readBigUInt64LE(o); }

function readRangeSync(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

function ascii(buf, off, n) {
  let len = n;
  for (let i = 0; i < n; i++) {
    if (buf[off + i] === 0) { len = i; break; }
  }
  return buf.toString('ascii', off, off + len).trim();
}

function openCnt(fd, size) {
  if (size < 0x5A0) return null;
  const head = readRangeSync(fd, 0, 4);
  if (head.length < 4) return null;
  let cntBase = 0;
  if (head[0] === 0x7f && head[1] === 0x46 && head[2] === 0x49 && head[3] === 0x48) {
    const fih = readRangeSync(fd, 0, 0x60);
    if (fih.length < 0x60) return null;
    const emb = u64le(fih, 0x58);
    if (emb === 0n || emb > BigInt(size - 0x5A0)) return null;
    cntBase = Number(emb);
  } else if (!(head[0] === 0x7f && head[1] === 0x43 && head[2] === 0x4e && head[3] === 0x54)) {
    return null;
  }

  const hdr = readRangeSync(fd, cntBase, 0x5A0);
  if (hdr.length < 0x5A0 || hdr[0] !== 0x7f || hdr[1] !== 0x43 || hdr[2] !== 0x4e || hdr[3] !== 0x54) {
    return null;
  }
  const count = u32be(hdr, 0x10);
  const tableOff = u32be(hdr, 0x18);
  if (count === 0 || count > 0x10000) return null;
  const table = readRangeSync(fd, cntBase + tableOff, count * 0x20);
  if (table.length < count * 0x20) return null;

  const raw = [];
  for (let i = 0; i < count; i++) {
    const o = i * 0x20;
    raw.push({
      id: u32be(table, o),
      nameOff: u32be(table, o + 4),
      flags: u32be(table, o + 8),
      dataOff: u32be(table, o + 0x10),
      dataSize: u32be(table, o + 0x14)
    });
  }

  const names = {};
  const nt = raw.find((e) => e.id === 0x0200);
  if (nt && nt.dataSize > 0 && nt.dataSize <= 4 * 1024 * 1024 && (nt.flags & 0x80000000) === 0) {
    const nb = readRangeSync(fd, cntBase + nt.dataOff, nt.dataSize);
    if (nb.length === nt.dataSize) {
      let s = 0;
      for (let i = 0; i <= nb.length; i++) {
        if (i === nb.length || nb[i] === 0) {
          if (i > s) names[s] = nb.toString('ascii', s, i);
          s = i + 1;
        }
      }
    }
  }

  const entries = raw.map((e) => ({
    id: e.id,
    name: names[e.nameOff] || '',
    flags: e.flags,
    dataOff: e.dataOff,
    dataSize: e.dataSize
  }));

  let digest = '';
  if (cntBase + 0xFE0 + 32 <= size) {
    const d = readRangeSync(fd, cntBase + 0xFE0, 32);
    if (d.length === 32) digest = d.toString('hex').toUpperCase();
  }

  return {
    cntBase,
    contentId: ascii(hdr, 0x40, 0x30),
    digest,
    entries,
    find(id, name) {
      const byId = this.entries.find((e) => e.id === id && (e.flags & 0x80000000) === 0);
      if (byId) return byId;
      return this.entries.find(
        (e) => (e.flags & 0x80000000) === 0 && e.name.toLowerCase() === String(name || '').toLowerCase()
      ) || null;
    },
    readEntry(e, cap) {
      if (!e || e.dataSize === 0 || e.dataSize > cap || (e.flags & 0x80000000) !== 0) return null;
      const b = readRangeSync(fd, cntBase + e.dataOff, e.dataSize);
      return b.length === e.dataSize ? b : null;
    }
  };
}

function parseSfo(b) {
  if (!b || b.length < 0x14 || b[0] !== 0 || b[1] !== 0x50 || b[2] !== 0x53 || b[3] !== 0x46) {
    throw new Error('not SFO');
  }
  const keyTab = b.readUInt32LE(8);
  const dataTab = b.readUInt32LE(12);
  const n = b.readUInt32LE(16);
  if (n > 4096) throw new Error('bad SFO count');
  const out = {};
  for (let k = 0; k < n; k++) {
    const o = 0x14 + k * 0x10;
    if (o + 16 > b.length) throw new Error('bad SFO entry');
    const keyOff = b.readUInt16LE(o);
    const fmt = b.readUInt16LE(o + 2);
    const len = b.readUInt32LE(o + 4);
    const dataOff = b.readUInt32LE(o + 12);
    let end = keyTab + keyOff;
    while (end < b.length && b[end] !== 0) end++;
    const name = b.toString('ascii', keyTab + keyOff, end);
    if (fmt === 0x404) {
      out[name] = { isInt: true, text: '', int: b.readUInt32LE(dataTab + dataOff) };
    } else if (fmt === 0x204 || fmt === 0x4) {
      const slen = fmt === 0x204 ? Math.max(0, len - 1) : Math.max(0, len);
      const start = dataTab + dataOff;
      if (start < 0 || start + slen > b.length) throw new Error('bad SFO string');
      out[name] = { isInt: false, text: b.toString('utf8', start, start + slen).replace(/\0+$/, ''), int: 0 };
    }
  }
  return out;
}

function isDlcHeuristic(title, contentId) {
  const t = (title || '').toLowerCase();
  const c = (contentId || '').toLowerCase();
  return (
    t.includes('dlc') || t.includes('add-on') || t.includes('addon') ||
    t.includes('expansion') || t.includes('season pass') ||
    c.includes('-dlc') || c.includes('_dlc') || c.includes('addon')
  );
}

function roleOf(category, title, contentId, filename) {
  const cat = (category || '').toLowerCase();
  if (cat === 'ac' || isDlcHeuristic(title, contentId)) return 'DLC';
  if (cat === 'gp') return 'Patch';
  const base = path.basename(filename || '').toLowerCase();
  if (/(^|[-_ .])(patch|update)([-_ .]|$)/.test(base)) return 'Patch';
  return 'Game';
}

function titleIdOf(contentId) {
  if (!contentId) return '';
  const parts = contentId.split('-');
  let mid = parts.length >= 2 ? parts[1] : contentId;
  const us = mid.indexOf('_');
  if (us > 0) mid = mid.slice(0, us);
  mid = mid.trim().toUpperCase();
  return mid.length >= 4 && mid.length <= 16 ? mid : '';
}

function findIcon(cnt) {
  const tryEntry = (e) => {
    const b = cnt.readEntry(e, ICON_CAP);
    if (b && b.length >= 8 && b[0] === 0x89 && b[1] === 0x50) return b;
    return null;
  };
  for (const e of cnt.entries) {
    if (e.id === 0x1200 && (e.flags & 0x80000000) === 0) {
      const hit = tryEntry(e);
      if (hit) return hit;
    }
  }
  for (const e of cnt.entries) {
    if (e.id >= 0x1201 && e.id <= 0x1220 && (e.flags & 0x80000000) === 0) {
      const hit = tryEntry(e);
      if (hit) return hit;
    }
  }
  return null;
}

function identity(absPath, stat) {
  return crypto
    .createHash('sha1')
    .update(`${absPath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex');
}

function readMetaSync(absPath, cacheDir) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const key = identity(absPath, stat);
  const metaPath = path.join(cacheDir, 'meta', key + '.json');
  try {
    const cached = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (cached && cached.ok) return cached;
  } catch (e) { /* parse below */ }

  let result;
  try {
    result = parsePkgSync(absPath, stat);
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  result.key = key;
  try {
    fs.mkdirSync(path.join(cacheDir, 'meta'), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(result));
  } catch (e) { /* cache is best-effort */ }
  return result;
}

function parsePkgSync(absPath, stat) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const cnt = openCnt(fd, stat.size);
    if (!cnt) return { ok: false, error: 'not a CNT pkg' };

    const sfoEntry = cnt.find(0x1000, 'param.sfo');
    if (sfoEntry) {
      const sfoBytes = cnt.readEntry(sfoEntry, SFO_CAP);
      if (sfoBytes) {
        let sfo;
        try {
          sfo = parseSfo(sfoBytes);
        } catch (e) {
          sfo = null;
        }
        if (sfo) {
          const get = (n) => (sfo[n] ? sfo[n].text || (sfo[n].isInt ? String(sfo[n].int) : '') : '');
          const title = get('TITLE');
          const contentId = get('CONTENT_ID') || cnt.contentId;
          const titleId = get('TITLE_ID') || titleIdOf(contentId);
          const category = get('CATEGORY');
          let version = get('APP_VER') || get('VERSION');
          version = String(version).replace(/^[vV]/, '').trim();
          if (title || contentId) {
            const icon = findIcon(cnt);
            const iconKey = storeIcon(icon, absPath);
            return {
              ok: true,
              platform: 'PS4',
              title: title || path.basename(absPath),
              titleId: (titleId || '').toUpperCase(),
              contentId,
              version,
              category,
              role: roleOf(category, title, contentId, path.basename(absPath)),
              iconKey
            };
          }
        }
      }
    }

    const pjEntry = cnt.find(0x2000, 'param.json');
    if (pjEntry && cnt.contentId) {
      const pjb = cnt.readEntry(pjEntry, 2 * 1024 * 1024);
      if (pjb) {
        let title = '';
        let version = '';
        try {
          const pj = JSON.parse(pjb.toString('utf8'));
          version = typeof pj.contentVersion === 'string' ? pj.contentVersion : '';
          const lp = pj.localizedParameters || {};
          const lang = lp.defaultLanguage || 'en-US';
          title = (lp[lang] && lp[lang].titleName) || '';
          if (!title) {
            for (const k of Object.keys(lp)) {
              if (lp[k] && typeof lp[k] === 'object' && lp[k].titleName) {
                title = lp[k].titleName;
                break;
              }
            }
          }
        } catch (e) { /* fall through */ }
        const contentId = cnt.contentId;
        const titleId = titleIdOf(contentId);
        const icon = findIcon(cnt);
        const iconKey = storeIcon(icon, absPath);
        return {
          ok: true,
          platform: 'PS5',
          title: title || titleId || path.basename(absPath),
          titleId: (titleId || '').toUpperCase(),
          contentId,
          version: String(version).replace(/^[vV]/, '').trim(),
          category: '',
          role: roleOf('', title, contentId, path.basename(absPath)),
          iconKey
        };
      }
    }

    if (cnt.contentId) {
      const contentId = cnt.contentId;
      const titleId = titleIdOf(contentId);
      const icon = findIcon(cnt);
      const iconKey = storeIcon(icon, absPath);
      return {
        ok: true,
        platform: 'PS5',
        title: titleId || path.basename(absPath),
        titleId: (titleId || '').toUpperCase(),
        contentId,
        version: '',
        category: '',
        role: roleOf('', '', contentId, path.basename(absPath)),
        iconKey
      };
    }
    return { ok: false, error: 'no metadata' };
  } finally {
    fs.closeSync(fd);
  }
}

function storeIcon(icon, absPath) {
  if (!icon || !icon.length) return '';
  try {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const dir = path.join(cacheDir, 'icons');
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.createHash('sha1').update(absPath + '|' + icon.length).digest('hex');
    const file = path.join(dir, key + '.png');
    if (!fs.existsSync(file)) fs.writeFileSync(file, icon);
    return key;
  } catch (e) {
    return '';
  }
}

module.exports = { readMetaSync, roleOf, titleIdOf, identity };
