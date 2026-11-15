/**
 * YOUTUBE PRO PLUS — updater.js
 * Full-tab page for the parts of the one-click update that need a user gesture:
 * picking the extension folder (once) and re-allowing write access. It also
 * shows install progress and a manual fallback when one-click isn't possible.
 */
'use strict';

(() => {
  const S = YtProSmoothUpdate;
  const view = document.getElementById('view');
  const logEl = document.getElementById('log');
  const params = new URLSearchParams(location.search);
  const manifest = chrome.runtime.getManifest();
  const current = manifest.version;
  const isFirefox = !!manifest.browser_specific_settings;
  const isStoreManaged = !!manifest.update_url; // installed from a store → the store updates it
  const AMO_URL = 'https://addons.mozilla.org/en-US/firefox/addon/youtube-pro-plus/';
  const RELEASES_URL = 'https://github.com/Archimetrix/Youtube-Pro-Plus/releases/latest';
  document.getElementById('ver').textContent = `YouTube Pro Plus · v${current}`;

  let autoTried = false;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function log(msg, cls = '') { logEl.className = `show ${cls}`.trim(); logEl.textContent = msg; }
  const getUpdate = async () => (await chrome.storage.local.get('ytpro_update_check')).ytpro_update_check || null;
  const refreshUpdate = () => new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: 'YTPRO_CHECK_UPDATE' }, (r) => { void chrome.runtime.lastError; resolve(r || null); }); }
    catch { resolve(null); }
  });

  const STEPS = ['Check folder', 'Download', 'Verify', 'Unpack', 'Install'];
  const PHASE_STEP = { check: 0, download: 1, verify: 2, unpack: 3, install: 4, rollback: 4, done: 5 };
  const progEl = document.getElementById('prog');
  const stepsEl = document.getElementById('steps');
  stepsEl.innerHTML = STEPS.map((t) => `<li>${t}</li>`).join('');

  function showProgress(p) {
    progEl.className = p.phase === 'done' ? 'show done' : p.phase === 'rollback' ? 'show fail' : 'show';
    document.getElementById('barFill').style.width = `${p.pct}%`;
    document.getElementById('progPct').textContent = `${p.pct}%`;
    document.getElementById('progText').textContent = p.text;
    const cur = PHASE_STEP[p.phase] ?? 0;
    [...stepsEl.children].forEach((li, i) => { li.className = i < cur ? 'done' : i === cur ? 'active' : ''; });
  }

  function setBusy(b) { view.querySelectorAll('button').forEach((x) => { x.disabled = b; }); }

  async function runUpdate() {
    const info = await getUpdate();
    if (!info || !info.ok || !info.updateAvailable) { log('No update is available right now.'); return; }
    if (!info.zipUrl) { log('This release has no downloadable package yet — use the Releases page instead.', 'error'); return; }
    setBusy(true);
    logEl.className = '';
    showProgress({ phase: 'check', pct: 0, text: 'Starting…' });
    try {
      const r = await S.applyUpdate({
        zipUrl: info.zipUrl, sha256: info.sha256, expectedVersion: info.latestVersion, sizeHint: info.zipSize, onProgress: showProgress,
      });
      log(`Updated to v${r.version} (${r.files} files). Reloading the extension — refresh your YouTube tabs afterwards.`, 'ok');
      setTimeout(() => chrome.runtime.reload(), 1200);
    } catch (e) {
      setBusy(false);
      if (progEl.className.indexOf('fail') < 0) progEl.classList.add('fail');
      if (e.code === 'WRONG_FOLDER') { await S.clearHandle(); await render(); }
      log(e.message || String(e), 'error');
    }
  }

  async function pickFolder() {
    let dir;
    try { dir = await showDirectoryPicker({ id: 'ytpro-update', mode: 'readwrite' }); }
    catch (e) { if (e && e.name !== 'AbortError') log(`Couldn't open the folder picker: ${e.message}`, 'error'); return; }
    log('Checking that this is the right folder…');
    if (!(await S.verifyIsLoadedFolder(dir))) {
      log('That isn\'t the folder your browser loaded YouTube Pro Plus from. Open your browser\'s extensions page (chrome://extensions or edge://extensions), check the path under "Details", and pick that exact folder (the one containing manifest.json).', 'error');
      return;
    }
    await S.saveHandle(dir);
    log(`Folder "${dir.name}" connected.`, 'ok');
    const info = await getUpdate();
    await render();
    if (info && info.ok && info.updateAvailable && info.zipUrl) runUpdate();
  }

  async function allowAccess() {
    const h = await S.getHandle();
    if (!h) return render();
    let p = 'denied';
    try { p = await h.requestPermission({ mode: 'readwrite' }); } catch { /* ignore */ }
    await render();
    if (p !== 'granted') { log('Access was not granted.', 'error'); return; }
    const info = await getUpdate();
    if (info && info.ok && info.updateAvailable && info.zipUrl) runUpdate();
  }

  const openManual = (url) => () => window.open(url, '_blank');

  async function render() {
    const [st, info] = await Promise.all([S.status(), getUpdate()]);
    const hasUpdate = !!(info && info.ok && info.updateAvailable);
    const canOneClick = hasUpdate && !!info.zipUrl;
    const pill = hasUpdate ? `<span class="pill">v${esc(info.latestVersion)} available</span>` : '<span class="pill">Up to date</span>';
    const manualUrl = (info && info.releaseUrl) || RELEASES_URL;

    // Firefox: updates come from Add-ons (AMO). Folder-writing isn't available.
    if (isFirefox) {
      view.innerHTML = `${pill}
        <p>On Firefox, YouTube Pro Plus updates through Firefox Add-ons.</p>
        <ol><li>Open <code>about:addons</code></li><li>Click the <b>gear icon</b> ⚙ → <b>Check for Updates</b></li></ol>
        <div class="row"><button class="primary" id="manual">Open Firefox Add-ons page</button></div>`;
      view.querySelector('#manual').onclick = openManual(AMO_URL);
      return;
    }

    // Installed from a store: the store already keeps it current.
    if (isStoreManaged) {
      view.innerHTML = `${pill}
        <p>This copy was installed from a browser store, which updates it automatically. One-click folder updates are only for the "Load unpacked" install.</p>
        <div class="row"><button id="manual">Open Releases page</button></div>`;
      view.querySelector('#manual').onclick = openManual(manualUrl);
      return;
    }

    if (typeof window.showDirectoryPicker !== 'function') {
      const isBrave = !!(navigator.brave);
      view.innerHTML = `<span class="pill warn">Not available in this browser setting</span>
        <p>This browser has the folder-access feature (File System Access API) switched off, so one-click updates can't run yet.</p>
        ${isBrave ? `<ol><li>Open <code>brave://flags/#file-system-access-api</code></li><li>Set it to <b>Enabled</b></li><li>Click <b>Relaunch</b>, then reopen this page</li></ol>` : '<p>Use a Chromium browser with this feature enabled (Chrome, Edge), or update manually.</p>'}
        <div class="row">${hasUpdate ? `<button class="primary" id="manual">Download update manually</button>` : ''}</div>`;
      const m = view.querySelector('#manual'); if (m) m.onclick = openManual(manualUrl);
      return;
    }

    if (!st.hasFolder) {
      view.innerHTML = `${pill}
        <p>One-time setup: tell YouTube Pro Plus which folder you loaded it from, so it can replace its own files when an update is ready.</p>
        <ol>
          <li>Open <code>chrome://extensions</code> (or <code>edge://extensions</code>) → YouTube Pro Plus → <b>Details</b> to see the folder path.</li>
          <li>Click <b>Choose folder</b> below and pick that exact folder (the one containing <code>manifest.json</code>).</li>
          <li>Click <b>Allow</b> / <b>Edit files</b> when the browser asks.</li>
        </ol>
        <p class="hint">Browsers refuse system folders like Documents or Downloads themselves, but a subfolder inside them is fine.</p>
        <div class="row"><button class="primary" id="pick">Choose folder${canOneClick ? ' &amp; update' : ''}</button></div>`;
      view.querySelector('#pick').onclick = pickFolder;
      return;
    }

    if (st.permission !== 'granted') {
      view.innerHTML = `${pill} <span class="pill warn">Access needs re-allowing</span>
        <p>Your browser paused write access to <code>${esc(st.folderName)}</code> (this happens after a browser restart). One click brings it back.</p>
        <p class="hint">If the browser offers <b>Allow on every visit</b>, choose it to avoid this next time.</p>
        <div class="row"><button class="primary" id="allow">Allow access${canOneClick ? ' &amp; update' : ''}</button><button id="change">Choose a different folder</button></div>`;
      view.querySelector('#allow').onclick = allowAccess;
      view.querySelector('#change').onclick = pickFolder;
      return;
    }

    view.innerHTML = `${pill} <span class="pill">Folder: ${esc(st.folderName)}</span>
      <p>${hasUpdate ? `YouTube Pro Plus v${esc(info.latestVersion)} is ready to install. Your settings and watch history are kept.` : 'You\'re all set — future updates will install in one click from the popup.'}</p>
      <div class="row">${canOneClick ? '<button class="primary" id="go">Install update now</button>' : ''}
        <button id="change">Choose a different folder</button><button id="forget">Disconnect folder</button></div>`;
    const go = view.querySelector('#go'); if (go) go.onclick = runUpdate;
    view.querySelector('#change').onclick = pickFolder;
    view.querySelector('#forget').onclick = async () => { await S.clearHandle(); log('Folder disconnected.'); render(); };

    if (canOneClick && params.get('auto') === '1' && !autoTried) { autoTried = true; runUpdate(); }
  }

  // Show what we know immediately, then refresh in the background.
  render().then(async () => {
    if (!params.get('auto')) {
      const fresh = await refreshUpdate();
      if (fresh && !progEl.classList.contains('show')) render();
    }
  });
})();
