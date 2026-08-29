/**
 * Youtube Pro Plus — gate.js
 *
 * Runs at document_start, before every other content script. Shows a
 * full-page overlay requiring the user to verify (via GitHub OAuth device
 * flow, handled in background-sw.js / stargate.js) that they have starred
 * the repo. Nothing loads underneath until the check passes.
 */

(() => {
  'use strict';

  const REPO_URL = 'https://github.com/Archimetrix/Youtube-Pro-Plus';
  const OVERLAY_ID = 'ytpp-star-gate';

  const baseStyle = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    background: #0f0f0f;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    font-family: 'Roboto', Arial, sans-serif;
    text-align: center;
    padding: 32px;
  `;

  function render(html) {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      el.style.cssText = baseStyle;
      (document.documentElement || document.body).appendChild(el);
    }
    el.innerHTML = html;
    return el;
  }

  function removeGate() {
    document.getElementById(OVERLAY_ID)?.remove();
    window.__ytppStarVerified = true;
  }

  function btnHtml(id, label) {
    return `<button id="${id}" style="padding:10px 22px;border-radius:8px;border:none;background:#fff;color:#000;font-weight:600;font-size:14px;cursor:pointer;">${label}</button>`;
  }

  function renderLocked() {
    const el = render(`
      <div style="font-size:32px;">⭐</div>
      <h2 style="margin:0;font-size:20px;">Support Youtube Pro Plus</h2>
      <p style="max-width:420px;opacity:.75;font-size:14px;line-height:1.5;">
        This extension is free to use. In exchange, please star the
        <a href="${REPO_URL}" target="_blank" style="color:#7fd1ff;">GitHub repo</a>
        to unlock it. You'll sign in with GitHub to verify — this extension never
        sees your password, only a confirmation of whether your account has starred the repo.
      </p>
      ${btnHtml('ytpp-gate-start', 'Verify with GitHub')}
      <div id="ytpp-gate-status" style="font-size:12px;opacity:.6;min-height:16px;"></div>
    `);
    el.querySelector('#ytpp-gate-start').addEventListener('click', beginAuth);
  }

  function renderCode(user_code, verification_uri) {
    render(`
      <h2 style="margin:0;font-size:20px;">One more step</h2>
      <p style="opacity:.75;font-size:14px;">
        Open <a href="${verification_uri}" target="_blank" style="color:#7fd1ff;">${verification_uri}</a>
        and enter this code:
      </p>
      <div style="font-size:28px;letter-spacing:5px;font-weight:700;background:#111;padding:12px 24px;border-radius:8px;">${user_code}</div>
      <p style="opacity:.55;font-size:13px;">Waiting for you to confirm on GitHub…</p>
    `);
  }

  function renderNotStarred() {
    const el = render(`
      <div style="font-size:32px;">👀</div>
      <h2 style="margin:0;font-size:20px;">Almost there</h2>
      <p style="opacity:.75;font-size:14px;max-width:420px;">
        You're verified, but this GitHub account hasn't starred the repo yet.
        Star it, then click retry.
      </p>
      <a href="${REPO_URL}" target="_blank" style="color:#7fd1ff;font-size:14px;">Open the repo →</a>
      ${btnHtml('ytpp-gate-retry', "I've starred it — retry")}
    `);
    el.querySelector('#ytpp-gate-retry').addEventListener('click', recheck);
  }

  function renderError(message) {
    const el = render(`
      <h2 style="margin:0;font-size:20px;">Something went wrong</h2>
      <p style="opacity:.75;font-size:14px;max-width:420px;">${message}</p>
      ${btnHtml('ytpp-gate-start', 'Try again')}
    `);
    el.querySelector('#ytpp-gate-start').addEventListener('click', beginAuth);
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
          if (res.starred) removeGate();
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
      if (!chrome.runtime.lastError && res?.ok && res.starred) removeGate();
      else renderNotStarred();
    });
  }

  chrome.runtime.sendMessage({ type: 'YTPP_STAR_GATE_STATUS' }, (res) => {
    if (!chrome.runtime.lastError && res?.verified) {
      window.__ytppStarVerified = true;
      return;
    }
    renderLocked();
  });
})();
