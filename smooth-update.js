/**
 * YOUTUBE PRO PLUS — smooth-update.js
 *
 * "Smoother Updates Process": updates an UNPACKED extension in place.
 *
 *   1. The user picks the extension's folder once (File System Access API).
 *   2. We prove it is the folder Chrome actually loaded (nonce probe).
 *   3. On update: download the release ZIP -> verify SHA-256 (when published)
 *      -> unzip fully in memory -> validate -> overwrite files (manifest.json
 *      last, with rollback on failure) -> caller runs chrome.runtime.reload().
 *
 * Loaded by both the service worker (importScripts) and updater.html.
 * No external libraries: ZIP parsing is done here, inflate uses the browser's
 * built-in DecompressionStream('deflate-raw').
 */
'use strict';

const YtProSmoothUpdate = (() => {
  const DB_NAME = 'ytpro-smooth-update';
  const STORE = 'kv';
  const HANDLE_KEY = 'dir';
  const FILELIST_KEY = 'ytpro_smooth_filelist';
  const MAX_ZIP_BYTES = 150 * 1024 * 1024;

  class SmoothError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  /* ── IndexedDB: persist the directory handle ───────────────────────────── */
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const getHandle = () => idbGet(HANDLE_KEY);
  const saveHandle = (h) => idbSet(HANDLE_KEY, h);
  const clearHandle = () => idbDelete(HANDLE_KEY);

  async function getPermission(handle) {
    if (!handle) return 'none';
    try { return await handle.queryPermission({ mode: 'readwrite' }); }
    catch { return 'denied'; }
  }

  async function status() {
    let handle = null;
    try { handle = await getHandle(); } catch { /* ignore */ }
    return {
      hasFolder: !!handle,
      folderName: handle ? handle.name : '',
      permission: await getPermission(handle), // none | granted | prompt | denied
    };
  }

  /* ── Folder verification ───────────────────────────────────────────────── */
  // Writes a throw-away file with a random nonce into the chosen folder, then
  // reads it back through the extension's own chrome-extension:// URL. It only
  // matches if the folder IS the one Chrome loaded this extension from.
  async function verifyIsLoadedFolder(dir) {
    try { await dir.getFileHandle('manifest.json'); }
    catch { return false; }
    const nonce = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
    const name = `ytpro-probe-${nonce}.txt`;
    try {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(nonce);
      await w.close();
      const res = await fetch(chrome.runtime.getURL(name), { cache: 'no-store' });
      return res.ok && (await res.text()).trim() === nonce;
    } catch {
      return false;
    } finally {
      try { await dir.removeEntry(name); } catch { /* ignore */ }
    }
  }

  /* ── ZIP reading ───────────────────────────────────────────────────────── */
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function readZipDirectory(buf) {
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new SmoothError('BAD_ZIP', 'Not a valid ZIP file.');
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || offset === 0xffffffff) throw new SmoothError('BAD_ZIP', 'ZIP64 archives are not supported.');

    const dec = new TextDecoder('utf-8');
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new SmoothError('BAD_ZIP', 'Corrupt ZIP directory.');
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compSize = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = dec.decode(u8.subarray(offset + 46, offset + 46 + nameLen));
      offset += 46 + nameLen + extraLen + commentLen;
      if (flags & 1) throw new SmoothError('BAD_ZIP', 'Encrypted ZIP entries are not supported.');
      entries.push({ name, method, compSize, size, localOffset });
    }

    async function read(entry) {
      if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new SmoothError('BAD_ZIP', 'Corrupt ZIP entry.');
      const nameLen = view.getUint16(entry.localOffset + 26, true);
      const extraLen = view.getUint16(entry.localOffset + 28, true);
      const start = entry.localOffset + 30 + nameLen + extraLen;
      const raw = u8.subarray(start, start + entry.compSize);
      let out;
      if (entry.method === 0) out = raw;
      else if (entry.method === 8) out = await inflateRaw(raw);
      else throw new SmoothError('BAD_ZIP', `Unsupported compression method ${entry.method}.`);
      if (out.byteLength !== entry.size) throw new SmoothError('BAD_ZIP', `Size mismatch in ${entry.name}.`);
      return out;
    }
    return { entries, read };
  }

  function safeSegments(path) {
    if (!path || path.includes('\\') || path.includes(':') || path.startsWith('/')) return null;
    const parts = path.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
    return parts;
  }

  /* ── Helpers ───────────────────────────────────────────────────────────── */
  const sha256Hex = async (buf) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
      .map((b) => b.toString(16).padStart(2, '0')).join('');

  function parseVersion(v) {
    return String(v || '').trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  }
  function isNewer(a, b) {
    const av = parseVersion(a), bv = parseVersion(b);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      if ((av[i] || 0) > (bv[i] || 0)) return true;
      if ((av[i] || 0) < (bv[i] || 0)) return false;
    }
    return false;
  }

  const sameVersion = (a, b) => !isNewer(a, b) && !isNewer(b, a);

  async function getDir(root, parts, create) {
    let dir = root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir;
  }
  async function readExisting(root, parts) {
    try {
      const dir = await getDir(root, parts.slice(0, -1), false);
      const fh = await dir.getFileHandle(parts[parts.length - 1]);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch { return null; }
  }
  async function writeFile(root, parts, data) {
    const dir = await getDir(root, parts.slice(0, -1), true);
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  async function removeFile(root, parts) {
    try {
      const dir = await getDir(root, parts.slice(0, -1), false);
      await dir.removeEntry(parts[parts.length - 1]);
    } catch { /* already gone */ }
  }

  /* ── The update itself ─────────────────────────────────────────────────── */
  let running = null;

  /**
   * @param {{zipUrl:string, sha256?:string, expectedVersion?:string,
   *          onProgress?:(msg:string)=>void}} opts
   * Throws SmoothError with .code in:
   *   NO_FOLDER | NEEDS_PERMISSION | WRONG_FOLDER | DOWNLOAD | CHECKSUM |
   *   BAD_ZIP | BAD_PACKAGE | WRITE
   */
  function applyUpdate(opts) {
    if (running) return running;
    running = doApply(opts).finally(() => { running = null; });
    return running;
  }

  const tick = () => new Promise((r) => setTimeout(r, 0)); // let the UI paint
  const fmtMB = (n) => (n / 1048576).toFixed(1);

  async function doApply({ zipUrl, sha256, expectedVersion, sizeHint, onProgress }) {
    // onProgress({ phase, pct (0-100), text }) — phase: check|download|verify|unpack|install|rollback|done
    let lastKey = '';
    const report = (phase, pct, text) => {
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      const key = phase + p + text;
      if (key === lastKey) return;
      lastKey = key;
      try { onProgress && onProgress({ phase, pct: p, text }); } catch { /* ignore */ }
    };
    if (!zipUrl) throw new SmoothError('DOWNLOAD', 'No download link found in the release.');

    report('check', 1, 'Checking your extension folder…');
    const root = await getHandle();
    if (!root) throw new SmoothError('NO_FOLDER', 'No extension folder selected yet.');
    if ((await getPermission(root)) !== 'granted') throw new SmoothError('NEEDS_PERMISSION', 'Folder access needs to be re-allowed.');
    if (!(await verifyIsLoadedFolder(root))) {
      throw new SmoothError('WRONG_FOLDER', 'The selected folder is not the one Chrome loaded this extension from.');
    }
    report('check', 5, 'Folder verified');

    // ── Download (streamed, so we can show real progress) ──
    report('download', 5, 'Starting download…');
    let buf;
    try {
      const res = await fetch(zipUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers && res.headers.get && res.headers.get('content-length')) || sizeHint || 0;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.byteLength;
          if (got > MAX_ZIP_BYTES) throw new Error('file too large');
          const frac = total ? Math.min(got / total, 1) : 0;
          report('download', 5 + frac * 50, total
            ? `Downloading… ${fmtMB(got)} / ${fmtMB(total)} MB`
            : `Downloading… ${fmtMB(got)} MB`);
        }
        const merged = new Uint8Array(got);
        let at = 0;
        for (const c of chunks) { merged.set(c, at); at += c.byteLength; }
        buf = merged.buffer;
      } else {
        buf = await res.arrayBuffer();
      }
    } catch (e) {
      throw new SmoothError('DOWNLOAD', `Download failed (${e.message}).`);
    }
    if (buf.byteLength > MAX_ZIP_BYTES) throw new SmoothError('DOWNLOAD', 'Download is unexpectedly large.');
    report('download', 55, `Downloaded ${fmtMB(buf.byteLength)} MB`);

    // ── Verify ──
    report('verify', 56, sha256 ? 'Verifying checksum…' : 'Checking package…');
    if (sha256) {
      if ((await sha256Hex(buf)).toLowerCase() !== String(sha256).toLowerCase()) {
        throw new SmoothError('CHECKSUM', 'Checksum mismatch — download was corrupted or tampered with.');
      }
    }
    report('verify', 60, sha256 ? 'Checksum OK' : 'Package readable');

    // ── Unpack (everything in memory before touching the disk) ──
    const zip = readZipDirectory(buf);
    // _metadata/ is generated by Chrome itself (indexed DNR rulesets) — never overwrite it.
    const files = zip.entries.filter((e) => !e.name.endsWith('/') && !/(^|\/)(__MACOSX\/|\.DS_Store$|_metadata\/)/.test(e.name));
    const manifestEntry = files
      .filter((e) => e.name === 'manifest.json' || e.name.endsWith('/manifest.json'))
      .sort((a, b) => a.name.length - b.name.length)[0];
    if (!manifestEntry) throw new SmoothError('BAD_PACKAGE', 'manifest.json not found inside the ZIP.');
    const prefix = manifestEntry.name.slice(0, -'manifest.json'.length);

    const wanted = files.filter((e) => e.name.startsWith(prefix));
    const payload = new Map();
    let i = 0;
    for (const e of wanted) {
      const rel = e.name.slice(prefix.length);
      if (!safeSegments(rel)) throw new SmoothError('BAD_PACKAGE', `Unsafe path in ZIP: ${rel}`);
      payload.set(rel, await zip.read(e));
      i++;
      report('unpack', 60 + (i / wanted.length) * 12, `Unpacking ${i}/${wanted.length}`);
      if (i % 5 === 0) await tick();
    }

    let next;
    try { next = JSON.parse(new TextDecoder().decode(payload.get('manifest.json'))); }
    catch { throw new SmoothError('BAD_PACKAGE', 'New manifest.json is not valid JSON.'); }

    const current = chrome.runtime.getManifest();
    if (next.manifest_version !== current.manifest_version) throw new SmoothError('BAD_PACKAGE', 'Manifest version mismatch.');
    if (current.key && next.key && current.key !== next.key) throw new SmoothError('BAD_PACKAGE', 'Package is for a different extension (key mismatch).');
    // A Firefox build (event-page/scripts background) must never replace a Chromium install.
    if (next.browser_specific_settings && !current.browser_specific_settings) throw new SmoothError('BAD_PACKAGE', 'Package is a Firefox build, not the Chromium build.');
    if (current.background && current.background.service_worker && !(next.background && next.background.service_worker)) {
      throw new SmoothError('BAD_PACKAGE', 'Package has no service worker (wrong browser build).');
    }
    if (expectedVersion && !sameVersion(next.version, expectedVersion)) {
      throw new SmoothError('BAD_PACKAGE', `Package version (${next.version}) is not the expected ${expectedVersion}.`);
    }
    if (!isNewer(next.version, current.version)) throw new SmoothError('BAD_PACKAGE', `Package (${next.version}) is not newer than the installed ${current.version}.`);
    const sw = next.background && next.background.service_worker;
    if (sw && !payload.has(sw)) throw new SmoothError('BAD_PACKAGE', `Package is missing ${sw}.`);

    // ── Back up, then install ──
    const order = [...payload.keys()].filter((p) => p !== 'manifest.json').concat('manifest.json');
    const backups = new Map();
    let n = 0;
    for (const rel of order) {
      backups.set(rel, await readExisting(root, rel.split('/')));
      n++;
      report('install', 72 + (n / order.length) * 5, 'Backing up current files…');
    }

    const touched = [];
    try {
      for (const rel of order) {
        await writeFile(root, rel.split('/'), payload.get(rel));
        touched.push(rel);
        report('install', 77 + (touched.length / order.length) * 20, `Installing ${touched.length}/${order.length}`);
      }
    } catch (e) {
      report('rollback', 97, 'Something went wrong — restoring previous version…');
      for (const rel of touched.reverse()) {
        const old = backups.get(rel);
        try {
          if (old) await writeFile(root, rel.split('/'), old);
          else await removeFile(root, rel.split('/'));
        } catch { /* best effort */ }
      }
      throw new SmoothError('WRITE', `Could not write files (${e.message}). Previous version restored.`);
    }

    report('install', 98, 'Cleaning up old files…');
    try {
      const stored = await chrome.storage.local.get({ [FILELIST_KEY]: [] });
      for (const rel of stored[FILELIST_KEY]) {
        if (!payload.has(rel) && safeSegments(rel)) await removeFile(root, rel.split('/'));
      }
      await chrome.storage.local.set({ [FILELIST_KEY]: [...payload.keys()] });
    } catch { /* non-fatal */ }

    report('done', 100, `Updated to v${next.version}`);
    return { version: String(next.version), files: payload.size };
  }

  return {
    SmoothError, status, getHandle, saveHandle, clearHandle, getPermission,
    verifyIsLoadedFolder, applyUpdate, isNewer,
  };
})();
