/**
 * Youtube Pro Plus — gate.js
 *
 * Runs at document_start. Shows a full-page overlay until the user has
 * verified (GitHub device flow, handled in stargate.js) that they starred
 * the repo.
 *
 * Hardening:
 *  - The real lock is server-of-truth in stargate.js: feature scripts are
 *    only injected while verified, so hiding this overlay unlocks nothing.
 *  - The overlay lives in a CLOSED shadow root under a randomly named
 *    element, re-generated on every (re)injection, so ad-blocker element
 *    pickers / saved cosmetic filters can't target it persistently.
 *  - A MutationObserver + watchdog re-inject it if it is removed, hidden,
 *    shrunk, covered or restyled, and playback underneath is paused.
 */

(() => {
  'use strict';

  const REPO_URL = 'https://github.com/Archimetrix/Youtube-Pro-Plus';

  const baseStyle = `
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    background: radial-gradient(circle at 50% 0%, #2a1a05 0%, #121212 55%, #0a0a0a 100%);
    overflow-y: auto;
    overflow-x: hidden;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: safe center;
    gap: clamp(10px, 2vh, 18px);
    font-family: 'Roboto', Arial, sans-serif;
    text-align: center;
    padding: clamp(14px, 3.5vh, 32px) 20px;
    box-sizing: border-box;
  `;

  // ── Hardened overlay host ───────────────────────────────────────────────
  let locked = false;
  let host = null;
  let view = null;        // { html, bind } — last rendered view, for re-injection
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
  injectNoScrollStyle();

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
    view.bind(box);
  }

  function render(html, bind) {
    view = { html, bind: bind || (() => {}) };
    locked = true;
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
    document.documentElement && document.documentElement.style.removeProperty('overflow');
    window.__ytppStarVerified = true;
  }

  // Feature scripts are injected by the background only once verified, so
  // reload to let them attach to this page.
  function unlockAndReload() {
    removeGate();
    location.reload();
  }

  function btnHtml(id, label) {
    return `<button id="${id}" style="padding:10px 22px;border-radius:8px;border:none;background:#fff;color:#000;font-weight:600;font-size:14px;cursor:pointer;">${label}</button>`;
  }

  function renderLocked() {
    const shot = chrome.runtime.getURL('imgs/github-permission.png');
    render(`
      <div style="width:100%;max-width:560px;max-height:96vh;overflow-y:auto;overflow-x:hidden;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:clamp(16px,3vh,26px) 24px;box-shadow:0 20px 60px rgba(0,0,0,.5);display:flex;flex-direction:column;align-items:center;gap:clamp(8px,1.5vh,12px);box-sizing:border-box;">
        <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#ffb700,#ff8a00);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 0 20px rgba(255,170,0,.35);flex:none;">⭐</div>
        <h2 style="margin:0;font-size:20px;font-weight:700;">Support Youtube Pro Plus</h2>
        <p style="margin:0;font-size:14.5px;line-height:1.55;color:rgba(255,255,255,.85);">
          This extension is <strong style="color:#fff;">100% free to use</strong>. We need support to grow the project,
          so please star the <a href="${REPO_URL}" target="_blank" rel="noopener" style="color:#7fd1ff;font-weight:600;">GitHub repo</a>
          to unlock the extension.
        </p>
        <p style="margin:0;font-size:13.5px;line-height:1.55;color:rgba(255,255,255,.68);">
          You'll just sign in with GitHub to verify — this extension <strong style="color:#fff;">never sees your password</strong>,
          only a confirmation of whether your account has starred the repo or not.
        </p>
        <div style="width:100%;margin-top:2px;padding:12px 14px;background:rgba(46,160,67,.08);border:1px solid rgba(46,160,67,.35);border-radius:12px;">
          <div style="font-size:13px;font-weight:600;color:#56d364;margin-bottom:5px;">🔒 Safe &amp; read-only</div>
          <p style="margin:0 0 10px;font-size:12.5px;line-height:1.5;color:rgba(255,255,255,.72);">
            As you can see below, the extension only gets <strong style="color:#fff;">read-only access to Starring</strong>.
            It will only check if you starred or not — nothing more.
          </p>
          <img src="${shot}" alt="GitHub authorization screen: read-only access to Starring" style="width:100%;max-width:440px;max-height:42vh;object-fit:contain;border-radius:8px;border:1px solid rgba(255,255,255,.12);display:block;margin:0 auto;">
        </div>
        <button id="ytpp-gate-start" style="margin-top:4px;padding:11px 28px;border-radius:9px;border:none;background:linear-gradient(135deg,#fff,#e8e8e8);color:#000;font-weight:700;font-size:15px;cursor:pointer;display:flex;align-items:center;gap:8px;flex:none;">
          <svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          Verify with GitHub
        </button>
        <div id="ytpp-gate-status" style="font-size:11.5px;opacity:.6;min-height:14px;"></div>
      </div>
    `, (el) => {
    el.querySelector('#ytpp-gate-start').addEventListener('click', beginAuth);
  
    });
  }

  function renderCode(user_code, verification_uri) {
    render(`
      <h2 style="margin:0;font-size:20px;">One more step</h2>
      <p style="opacity:.75;font-size:14px;">
        Open <a href="${verification_uri}" target="_blank" style="color:#7fd1ff;">${verification_uri}</a>
        and enter this code:
      </p>
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="font-size:28px;letter-spacing:5px;font-weight:700;background:#111;padding:12px 24px;border-radius:8px;">${user_code}</div>
        <button id="ytpp-gate-copy" title="Copy code" style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#fff;cursor:pointer;">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3 10.5V3.5C3 2.7 3.7 2 4.5 2H10"/></svg>
        </button>
      </div>
      <p style="opacity:.55;font-size:13px;">Waiting for you to confirm on GitHub…</p>
    `, (el) => {
    const copyBtn = el.querySelector('#ytpp-gate-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const code = user_code.replace(/-/g, '');
        const done = () => {
          copyBtn.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5 8.5 6 12 13.5 4"/></svg>`;
          setTimeout(() => {
            copyBtn.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3 10.5V3.5C3 2.7 3.7 2 4.5 2H10"/></svg>`;
          }, 1500);
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
    }
  
    });
  }

  function renderNotStarred() {
    render(`
      <div style="font-size:32px;">👀</div>
      <h2 style="margin:0;font-size:20px;">Almost there</h2>
      <p style="opacity:.75;font-size:14px;max-width:420px;">
        You're verified, but this GitHub account hasn't starred the repo yet.
        Star it, then click retry.
      </p>
      <a href="${REPO_URL}" target="_blank" style="color:#7fd1ff;font-size:14px;">Open the repo →</a>
      ${btnHtml('ytpp-gate-retry', "I've starred it — retry")}
    `, (el) => {
    el.querySelector('#ytpp-gate-retry').addEventListener('click', recheck);
  
    });
  }

  function renderError(message) {
    render(`
      <h2 style="margin:0;font-size:20px;">Something went wrong</h2>
      <p style="opacity:.75;font-size:14px;max-width:420px;">${message}</p>
      ${btnHtml('ytpp-gate-start', 'Try again')}
    `, (el) => {
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
    render(`<p style="opacity:.7;font-size:14px;">Contacting GitHub…</p>`);
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
      else renderNotStarred();
    });
  }

  // Live re-lock: if the stored state flips to "not verified" — because a
  // weekly/periodic recheck found the star was removed, or the token was
  // revoked — show the overlay immediately, without waiting for a reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ytpp_star_gate) return;
      const now = changes.ytpp_star_gate.newValue;
      if (!(now && now.verified && now.token)) {
        window.__ytppStarVerified = false;
        renderLocked();
      }
    });
  } catch (e) {}

  chrome.runtime.sendMessage({ type: 'YTPP_STAR_GATE_STATUS' }, (res) => {
    // No response at all (lastError) means the background couldn't answer —
    // most likely stargate.js itself is missing/broken (e.g. deleted from
    // the unpacked extension). Fail closed rather than trusting the page.
    if (!chrome.runtime.lastError && res?.verified) {
      window.__ytppStarVerified = true;
      return;
    }
    renderLocked();
  });
})();
