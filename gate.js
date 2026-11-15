/**
 * Youtube Pro Plus — gate.js
 *
 * Runs at document_start. For the first few minutes after install, the
 * extension works with no gate at all (see STARGATE_GRACE_MS in
 * stargate.js). After that, if the user still hasn't verified (GitHub
 * device flow, handled in stargate.js) that they starred the repo, this
 * shows a full-page overlay that stays until they do. Verification is a
 * ONE-TIME, lifetime thing — once it succeeds, this overlay never appears
 * again for this install, ever, with no ongoing rechecks.
 *
 * Hardening:
 *  - The real lock is server-of-truth in stargate.js: feature scripts are
 *    only injected while verified, so hiding this overlay unlocks nothing.
 *  - The overlay lives in a CLOSED shadow root under a randomly named
 *    element, re-generated on every (re)injection, so ad-blocker element
 *    pickers / saved cosmetic filters can't target it persistently.
 *  - A MutationObserver + watchdog re-inject it if it is removed, hidden,
 *    shrunk, covered or restyled, and playback underneath is paused.
 *
 * "Show it later": every screen has a skip button. It asks the background to
 * unlock THIS tab only (kept in chrome.storage.session — gone when the browser
 * closes), then reloads so the feature scripts attach. New tabs / new browser
 * sessions show the gate again until the user actually verifies.
 */

(() => {
  'use strict';

  const REPO_URL = 'https://github.com/Archimetrix/Youtube-Pro-Plus';

  const baseStyle = `
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    background:
      radial-gradient(900px 520px at 50% -8%, rgba(255,170,0,.17), transparent 62%),
      radial-gradient(760px 520px at 105% 105%, rgba(255,64,64,.09), transparent 60%),
      #0b0b0e;
    overflow-y: auto;
    overflow-x: hidden;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: safe center;
    font-family: 'Roboto', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif;
    padding: clamp(14px, 3.5vh, 32px) 16px;
    box-sizing: border-box;
  `;

  // Shared stylesheet for every gate screen (lives inside the closed shadow
  // root, so nothing on the page can restyle it and it can't leak out).
  const GATE_CSS = `<style>
    *, *::before, *::after { box-sizing: border-box; }
    .g-card { width: 100%; max-width: 480px; margin: auto; text-align: left;
      padding: clamp(22px, 4vh, 34px) clamp(18px, 5vw, 30px) 20px;
      border-radius: 22px; display: flex; flex-direction: column; gap: 16px;
      background: linear-gradient(180deg, rgba(255,255,255,.075), rgba(255,255,255,.03));
      border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 30px 90px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.08);
      animation: g-in .4s cubic-bezier(.2,.8,.2,1) both; }
    .g-head { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; }
    .g-badge { width: 56px; height: 56px; border-radius: 18px; display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #ffc83d, #ff8a00); color: #2a1800;
      box-shadow: 0 8px 28px rgba(255,150,0,.35), inset 0 1px 0 rgba(255,255,255,.5); }
    .g-brand { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; font-weight: 600; color: rgba(255,255,255,.5); }
    .g-title { margin: 0; font-size: clamp(20px, 3.2vh, 24px); font-weight: 700; letter-spacing: -.01em; line-height: 1.2; color: #fff; }
    .g-sub { margin: 0; max-width: 390px; font-size: 14.5px; line-height: 1.55; color: rgba(255,255,255,.74); }
    .g-sub b { color: #fff; }
    .g-steps { list-style: none; margin: 2px 0; padding: 0; display: flex; flex-direction: column; gap: 11px; }
    .g-steps li { display: flex; gap: 12px; align-items: flex-start; }
    .g-n { flex: none; width: 24px; height: 24px; margin-top: 1px; border-radius: 50%; font-size: 12px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.18); color: #fff; }
    .g-steps b { display: block; font-size: 14px; font-weight: 600; color: #fff; }
    .g-d { display: block; font-size: 12.5px; line-height: 1.45; color: rgba(255,255,255,.6); }
    .g-trust { border: 1px solid rgba(86,211,100,.28); background: rgba(46,160,67,.07); border-radius: 12px; }
    .g-trust summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px;
      padding: 11px 14px; font-size: 13px; font-weight: 600; color: #6ee07f; border-radius: 12px; }
    .g-trust summary::-webkit-details-marker { display: none; }
    .g-trust summary::after { content: ''; margin-left: auto; width: 7px; height: 7px; flex: none;
      border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
      transform: rotate(45deg) translateY(-2px); transition: transform .2s; }
    .g-trust[open] summary::after { transform: rotate(-135deg); }
    .g-trust summary:focus-visible { outline: 2px solid #7fd1ff; outline-offset: 2px; }
    .g-tb { padding: 0 14px 14px; font-size: 12.5px; line-height: 1.5; color: rgba(255,255,255,.74); }
    .g-tb b { color: #fff; }
    .g-tb img { display: block; width: 100%; max-height: 32vh; object-fit: contain; margin-top: 10px;
      border-radius: 8px; border: 1px solid rgba(255,255,255,.12); }
    .g-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 2px; }
    .g-btn { appearance: none; border: 0; font: inherit; cursor: pointer; text-decoration: none;
      border-radius: 12px; padding: 13px 20px; font-size: 15px; font-weight: 700; line-height: 1.2;
      display: flex; align-items: center; justify-content: center; gap: 9px;
      transition: transform .12s, background .2s, box-shadow .2s, opacity .2s; }
    .g-btn:focus-visible { outline: 2px solid #7fd1ff; outline-offset: 2px; }
    .g-btn[disabled] { opacity: .6; cursor: default; transform: none; }
    .g-primary { background: #fff; color: #0b0b0e; box-shadow: 0 6px 20px rgba(255,255,255,.12); }
    .g-primary:hover:not([disabled]) { background: #f1f1f1; transform: translateY(-1px); }
    .g-ghost { background: rgba(255,255,255,.06); color: rgba(255,255,255,.9); border: 1px solid rgba(255,255,255,.15);
      font-size: 14px; font-weight: 600; padding: 11px 18px; }
    .g-ghost:hover:not([disabled]) { background: rgba(255,255,255,.12); }
    .g-note { margin: 0; text-align: center; font-size: 11.5px; line-height: 1.55; color: rgba(255,255,255,.46); }
    .g-status { min-height: 0; text-align: center; font-size: 12.5px; line-height: 1.45; color: #ffb4b4; }
    .g-status:empty { display: none; }
    .g-link { color: #7fd1ff; font-weight: 600; text-decoration: none; }
    .g-link:hover { text-decoration: underline; }
    .g-code-row { display: flex; gap: 10px; align-items: stretch; justify-content: center; }
    .g-code { flex: 1; max-width: 300px; text-align: center; user-select: all; border-radius: 14px;
      padding: 14px 8px 14px 16px; background: rgba(0,0,0,.42); border: 1px dashed rgba(255,255,255,.28);
      font-family: ui-monospace, 'SF Mono', Consolas, 'Liberation Mono', monospace;
      font-size: clamp(24px, 4vh, 30px); font-weight: 700; letter-spacing: .28em; color: #fff; }
    .g-icon-btn { flex: none; width: 52px; display: flex; align-items: center; justify-content: center; cursor: pointer;
      border-radius: 14px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.16); color: #fff;
      transition: background .2s; }
    .g-icon-btn span { display: flex; } .g-icon-btn [hidden] { display: none; }
    .g-icon-btn:hover { background: rgba(255,255,255,.14); }
    .g-icon-btn:focus-visible { outline: 2px solid #7fd1ff; outline-offset: 2px; }
    .g-wait { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 13px; color: rgba(255,255,255,.62); }
    .g-spin { flex: none; width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.2); border-top-color: #ffc83d; animation: g-spin .8s linear infinite; }
    .g-spin.g-big { width: 30px; height: 30px; border-width: 3px; }
    .g-alert { text-align: left; word-break: break-word; border-radius: 12px; padding: 12px 14px;
      font-size: 13.5px; line-height: 1.5; color: #ffb9b9; background: rgba(255,80,80,.09); border: 1px solid rgba(255,90,90,.35); }
    @keyframes g-in { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
    @keyframes g-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .g-card { animation: none; } .g-spin { animation-duration: 2.4s; } }
  </style>`;

  const ICON = {
    star: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="M12 2.4l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.3l-5.9 3.1 1.2-6.5L2.5 9.3l6.6-.9z"/></svg>',
    github: '<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    copy: '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3 10.5V3.5C3 2.7 3.7 2 4.5 2H10"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2.5 8.5 6 12 13.5 4"/></svg>',
    ext: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2h5v5M14 2L7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5"/></svg>',
  };

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Hardened overlay host ───────────────────────────────────────────────
  let locked = false;
  let host = null;
  let view = null;        // { html, bind } — last rendered view, for re-injection
  let boxEl = null;       // the current overlay's inner box (for status text)
  let watchdog = null;
  let observer = null;

  const rnd = () => Math.random().toString(36).slice(2, 10);

  // A real <style> rule (not an inline style we keep re-applying) so the
  // page's own scripts resetting inline styles on <html>/<body> can't bring
  // the horizontal scrollbar back between our 300ms enforce() ticks.
  function injectNoScrollStyle() {
    if (document.getElementById('ytpp-gate-noscroll')) return;
    const style = document.createElement('style');
    style.id = 'ytpp-gate-noscroll';
    style.textContent = `
      html, body {
        overflow-x: hidden !important;
        max-width: 100% !important;
      }
      /* Belt-and-suspenders: even if some rounding/layout quirk on the
         underlying page still computes a sliver of horizontal overflow,
         explicitly hide the horizontal scrollbar WIDGET itself (not just
         disallow scrolling) so nothing can render, in Chrome/Edge and
         Firefox alike. Vertical scrolling/scrollbar is untouched. */
      html::-webkit-scrollbar:horizontal,
      body::-webkit-scrollbar:horizontal {
        display: none !important;
        height: 0 !important;
        background: transparent !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  // NOTE: deliberately NOT called at load. This used to run on every
  // YouTube page for every user (even verified ones), leaving
  // `overflow-x:hidden` on both <html> and <body> permanently, which turns
  // <body> into its own scroll container and makes page scrolling janky
  // (see issue #16). It is now only applied while the gate is actually
  // showing (render/enforce) and is removed again in removeGate().
  function removeNoScrollStyle() {
    try { document.getElementById('ytpp-gate-noscroll')?.remove(); } catch (e) {}
    try { document.body && document.body.style.removeProperty('overflow-x'); } catch (e) {}
    try { document.documentElement && document.documentElement.style.removeProperty('overflow'); } catch (e) {}
  }

  function mount() {
    if (host) { try { host.remove(); } catch (e) {} }
    host = document.createElement('x-' + rnd() + '-' + rnd());
    host.setAttribute(rnd(), '');
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = baseStyle;
    root.appendChild(box);
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;' +
      'z-index:2147483647!important;overflow:hidden!important;' +
      'display:block!important;visibility:visible!important;opacity:1!important;' +
      'pointer-events:auto!important;transform:none!important;clip-path:none!important;';
    (document.documentElement || document.body).appendChild(host);
    box.innerHTML = view.html;
    boxEl = box;
    view.bind(box);
    bindSkip(box);
    try { box.querySelector('[data-autofocus]')?.focus({ preventScroll: true }); } catch (e) {}
  }

  function render(html, bind) {
    view = { html, bind: bind || (() => {}) };
    locked = true;
    injectNoScrollStyle();
    mount();
    startGuards();
  }

  function overlayIntact() {
    if (!host || !host.isConnected) return false;
    const cs = getComputedStyle(host);
    if (cs.display === 'none' || cs.visibility !== 'visible' || parseFloat(cs.opacity) < 0.99) return false;
    const r = host.getBoundingClientRect();
    if (r.width < innerWidth * 0.95 || r.height < innerHeight * 0.95) return false;
    if (document.elementFromPoint(innerWidth / 2, innerHeight / 2) !== host) return false;
    return true;
  }

  function enforce() {
    if (!locked) return;
    if (!overlayIntact()) mount();           // fresh random name each time
    injectNoScrollStyle();                   // re-add if the page ripped it out
    // Keep the page underneath quiet and un-scrollable while locked.
    document.querySelectorAll('video,audio').forEach((m) => { try { if (!m.paused) m.pause(); } catch (e) {} });
    if (document.documentElement) document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    if (document.body) document.body.style.setProperty('overflow-x', 'hidden', 'important');
  }

  function startGuards() {
    if (!observer) {
      observer = new MutationObserver(() => { if (locked && (!host || !host.isConnected)) mount(); });
      observer.observe(document.documentElement, { childList: true });
    }
    if (!watchdog) watchdog = setInterval(enforce, 300);
  }

  function removeGate() {
    locked = false;
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    if (observer) { observer.disconnect(); observer = null; }
    try { host && host.remove(); } catch (e) {}
    host = null;
    removeNoScrollStyle();
    window.__ytppStarVerified = true;
  }

  // Feature scripts are injected by the background only once verified, so
  // reload to let them attach to this page.
  function unlockAndReload() {
    removeGate();
    location.reload();
  }

  function card(inner) {
    return GATE_CSS + `<div class="g-card" role="dialog" aria-modal="true" aria-labelledby="g-title">${inner}</div>`;
  }

  function skipBtn() {
    return `<button type="button" class="g-btn g-ghost" id="ytpp-gate-skip">Show it later</button>`;
  }

  function setStatus(text) {
    const el = boxEl && boxEl.querySelector('#ytpp-gate-status');
    if (el) el.textContent = text || '';
  }

  // ── "Show it later" ─────────────────────────────────────────────────────
  // Unlocks THIS tab only (background keeps it in session storage), then
  // reloads so the feature scripts attach. Nothing permanent is written.
  let skipping = false;
  function skipForNow(btn) {
    if (skipping) return;
    skipping = true;
    stopPolling();
    if (btn) { btn.disabled = true; btn.textContent = 'Opening YouTube…'; }
    chrome.runtime.sendMessage({ type: 'YTPP_STAR_GATE_SKIP' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        skipping = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Show it later'; }
        setStatus("Couldn't skip just now — please try again.");
        return;
      }
      removeGate();
      location.reload();
    });
  }
  function bindSkip(root) {
    const b = root.querySelector('#ytpp-gate-skip');
    if (b) b.addEventListener('click', () => skipForNow(b));
  }

  function renderLocked() {
    const shot = chrome.runtime.getURL('imgs/github-permission.png');
    render(card(`
      <div class="g-head">
        <div class="g-badge">${ICON.star}</div>
        <div class="g-brand">Youtube Pro Plus</div>
        <h2 class="g-title" id="g-title">Unlock Youtube Pro Plus</h2>
        <p class="g-sub">It's <b>100% free</b>. A quick GitHub star is all we ask — it helps the project grow and keeps it free for everyone.</p>
      </div>

      <ol class="g-steps">
        <li><span class="g-n">1</span><div><b>Sign in with GitHub</b>
          <span class="g-d">Enter a short code on github.com. Your password is never shared.</span></div></li>
        <li><span class="g-n">2</span><div><b>Star the repository</b>
          <span class="g-d">If you haven't yet — <a class="g-link" href="${REPO_URL}" target="_blank" rel="noopener">open the repo</a>. It's the only thing we check.</span></div></li>
        <li><span class="g-n">3</span><div><b>Unlocked for good</b>
          <span class="g-d">One-time only. We never check again.</span></div></li>
      </ol>

      <details class="g-trust">
        <summary>${ICON.lock} Safe &amp; read-only — see what it asks for</summary>
        <div class="g-tb">
          The extension only gets <b>read-only access to Starring</b>. It checks whether you starred the repo — nothing more.
          <img src="${shot}" alt="GitHub authorization screen: read-only access to Starring">
        </div>
      </details>

      <div class="g-actions">
        <button type="button" class="g-btn g-primary" id="ytpp-gate-start" data-autofocus>${ICON.github} Verify with GitHub</button>
        ${skipBtn()}
      </div>
      <div class="g-status" id="ytpp-gate-status" aria-live="polite"></div>
      <p class="g-note">Verify once and this screen never appears again.<br>
        “Show it later” unlocks only this tab — it returns next time you open YouTube.</p>
    `), (el) => {
      el.querySelector('#ytpp-gate-start').addEventListener('click', beginAuth);
    });
  }

  function renderLoading() {
    render(card(`
      <div class="g-head">
        <span class="g-spin g-big" role="status" aria-label="Loading"></span>
        <h2 class="g-title" id="g-title">Contacting GitHub…</h2>
        <p class="g-sub">Getting your verification code ready.</p>
      </div>
      <div class="g-actions">${skipBtn()}</div>
      <div class="g-status" id="ytpp-gate-status" aria-live="polite"></div>
    `));
  }

  function renderCode(user_code, verification_uri) {
    // Only ever link to github.com, whatever the response says.
    let uri = 'https://github.com/login/device';
    try { const u = new URL(verification_uri); if (u.origin === 'https://github.com') uri = u.href; } catch (e) {}
    render(card(`
      <div class="g-head">
        <div class="g-badge">${ICON.github}</div>
        <h2 class="g-title" id="g-title">Enter this code on GitHub</h2>
        <p class="g-sub">Open GitHub, type or paste the code below and approve access. This page unlocks by itself afterwards.</p>
      </div>
      <div class="g-code-row">
        <div class="g-code" aria-label="Your code">${esc(user_code)}</div>
        <button type="button" class="g-icon-btn" id="ytpp-gate-copy" title="Copy code" aria-label="Copy code"><span class="g-i-copy">${ICON.copy}</span><span class="g-i-ok" hidden>${ICON.check}</span></button>
      </div>
      <div class="g-wait"><span class="g-spin" aria-hidden="true"></span><span>Waiting for you to confirm on GitHub…</span></div>
      <div class="g-actions">
        <a class="g-btn g-primary" id="ytpp-gate-open" data-autofocus href="${esc(uri)}" target="_blank" rel="noopener">Open GitHub ${ICON.ext}</a>
        ${skipBtn()}
      </div>
      <div class="g-status" id="ytpp-gate-status" aria-live="polite"></div>
    `), (el) => {
      const copyBtn = el.querySelector('#ytpp-gate-copy');
      if (!copyBtn) return;
      copyBtn.addEventListener('click', () => {
        const code = String(user_code).replace(/-/g, '');
        const iconCopy = copyBtn.querySelector('.g-i-copy');
        const iconOk   = copyBtn.querySelector('.g-i-ok');
        const done = () => {
          iconCopy.hidden = true; iconOk.hidden = false;
          setTimeout(() => { iconCopy.hidden = false; iconOk.hidden = true; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(done).catch(done);
        } else {
          const ta = document.createElement('textarea');
          ta.value = code;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta);
          done();
        }
      });
    });
  }

  function renderNotStarred(retried) {
    render(card(`
      <div class="g-head">
        <div class="g-badge">${ICON.star}</div>
        <h2 class="g-title" id="g-title">Almost there — one star to go</h2>
        <p class="g-sub">You're signed in, but this GitHub account hasn't starred the repo yet. Star it, then come back and tap retry.</p>
      </div>
      ${retried ? `<div class="g-alert" role="alert">Still not starred. Make sure you starred <b>${esc(REPO_URL.replace('https://github.com/', ''))}</b> with the account you just signed in with, then retry.</div>` : ''}
      <div class="g-actions">
        <a class="g-btn g-ghost" href="${REPO_URL}" target="_blank" rel="noopener">Open the repo &amp; star it ${ICON.ext}</a>
        <button type="button" class="g-btn g-primary" id="ytpp-gate-retry" data-autofocus>I've starred it — retry</button>
        ${skipBtn()}
      </div>
      <div class="g-status" id="ytpp-gate-status" aria-live="polite"></div>
    `), (el) => {
      el.querySelector('#ytpp-gate-retry').addEventListener('click', (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Checking…';
        recheck();
      });
    });
  }

  function renderError(message) {
    render(card(`
      <div class="g-head">
        <h2 class="g-title" id="g-title">Something went wrong</h2>
        <p class="g-sub">We couldn't finish the GitHub check. You can try again, or continue and verify later.</p>
      </div>
      <div class="g-alert" role="alert">${esc(message)}</div>
      <div class="g-actions">
        <button type="button" class="g-btn g-primary" id="ytpp-gate-start" data-autofocus>Try again</button>
        ${skipBtn()}
      </div>
      <div class="g-status" id="ytpp-gate-status" aria-live="polite"></div>
    `), (el) => {
      el.querySelector('#ytpp-gate-start').addEventListener('click', beginAuth);
    });
  }

  let pollTimer = null;
  let pollDeadline = 0;

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  // Polling lives here (content script), not in the background service
  // worker: each tick is one short message round-trip, so it survives the
  // minutes a real GitHub login can take without hitting MV3's service
  // worker idle-timeout.
  function pollTick(device_code, intervalSec) {
    if (Date.now() > pollDeadline) {
      stopPolling();
      return renderError('Timed out waiting for GitHub authorization. Please try again.');
    }
    chrome.runtime.sendMessage({ type: 'YTPP_STAR_GATE_POLL_ONCE', device_code }, (res) => {
      if (chrome.runtime.lastError) {
        pollTimer = setTimeout(() => pollTick(device_code, intervalSec), intervalSec * 1000);
        return;
      }
      switch (res?.status) {
        case 'success':
          stopPolling();
          if (res.starred) unlockAndReload();
          else renderNotStarred();
          return;
        case 'slow_down':
          intervalSec += 5;
        case 'pending':
          pollTimer = setTimeout(() => pollTick(device_code, intervalSec), intervalSec * 1000);
          return;
        default:
          stopPolling();
          renderError(res?.error || 'Verification failed.');
      }
    });
  }

  function beginAuth() {
    stopPolling();
    renderLoading();
    chrome.runtime.sendMessage({ type: 'YTPP_STAR_GATE_START_AUTH' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        return renderError(res?.error || chrome.runtime.lastError?.message || 'Could not start GitHub verification.');
      }
      const { device_code, user_code, verification_uri, interval, expires_in } = res.device;
      renderCode(user_code, verification_uri);
      pollDeadline = Date.now() + Math.min(expires_in || 900, 900) * 1000;
      pollTimer = setTimeout(() => pollTick(device_code, interval || 5), (interval || 5) * 1000);
    });
  }

  function recheck() {
    chrome.runtime.sendMessage({ type: 'YTPP_STAR_GATE_RECHECK' }, (res) => {
      if (!chrome.runtime.lastError && res?.ok && res.starred) unlockAndReload();
      else renderNotStarred(true);
    });
  }

  // If this tab stays open continuously through the moment the one-time
  // grace period ends, the background pushes this so the gate appears
  // immediately instead of waiting for a reload.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'YTPP_STAR_GATE_GRACE_EXPIRED') {
        window.__ytppStarVerified = false;
        renderLocked();
      }
    });
  } catch (e) {}

  chrome.runtime.sendMessage({ type: 'YTPP_STAR_GATE_STATUS' }, (res) => {
    // No response at all (lastError) means the background couldn't answer —
    // most likely stargate.js itself is missing/broken (e.g. deleted from
    // the unpacked extension). Fail closed rather than trusting the page.
    if (chrome.runtime.lastError) {
      renderLocked();
      return;
    }
    // 'unlocked'  → permanently verified, forever. Never show this again.
    // 'grace'     → brand-new install, still inside the free trial window.
    // 'skipped'   → user clicked "Show it later" in THIS tab this browser session.
    // 'locked'    → grace period over and never verified — show the gate
    //               (dismissable per-tab via "Show it later", or by verifying).
    if (res?.mode === 'unlocked' || res?.mode === 'grace' || res?.mode === 'skipped') {
      window.__ytppStarVerified = true;
      return;
    }
    renderLocked();
  });
})();
