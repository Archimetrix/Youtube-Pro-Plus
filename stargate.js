/**
 * Youtube Pro Plus — stargate.js
 *
 * Background-side logic for the "must star the repo" gate.
 * Uses GitHub's OAuth Device Flow so the user proves who they actually are,
 * then checks GET /user/starred/{owner}/{repo} with their own token — the
 * authoritative "did *this* account star it" check.
 *
 * NOTE on service worker lifetime: MV3 service workers can be terminated by
 * Chrome after ~30s idle, so polling for the device-flow token is done as
 * repeated SHORT single-shot calls (driven by the content script's timer),
 * never as one long-lived loop held in the background.
 */

'use strict';

const STARGATE_GITHUB_CLIENT_ID = 'Iv23liWFPoRLUJ5Ic7PG';
const STARGATE_REPO_OWNER = 'Archimetrix';
const STARGATE_REPO_NAME = 'Youtube-Pro-Plus';
// No fixed "recheck every N minutes" timer any more. Instead: every time
// YouTube starts (a tab opens/navigates to youtube.com, which re-runs
// gate.js), we answer instantly from the local cache so the page is never
// blocked on a network call, and separately kick off a live check with
// GitHub in the background. If that live check finds the star is gone, the
// stored state flips and gate.js re-locks itself immediately via the
// storage.onChanged listener — no waiting for a timer.

async function starGateGetState() {
  const { ytpp_star_gate } = await chrome.storage.local.get('ytpp_star_gate');
  return ytpp_star_gate || null;
}

// ── Feature scripts are only injected while the user is verified ──────────
// The overlay in gate.js is just the UI. The real lock is here: none of the
// extension's feature scripts exist in the manifest any more. They are
// registered dynamically only while the stored state says "verified", so
// hiding / deleting / blocking the overlay gains the user nothing.
const STARGATE_FEATURE_SCRIPTS = [
  {
    "id": "ytpp-feat-0",
    "matches": [
      "*://www.youtube.com/*",
      "*://youtube.com/*"
    ],
    "js": [
      "browser-compat.js",
      "content.js"
    ],
    "runAt": "document_end"
  },
  {
    "id": "ytpp-feat-1",
    "matches": [
      "*://www.youtube.com/*",
      "*://youtube.com/*"
    ],
    "js": [
      "browser-compat.js",
      "sound-booster.js"
    ],
    "runAt": "document_idle"
  },
  {
    "id": "ytpp-feat-2",
    "matches": [
      "*://ssvid.net/*",
      "*://www.ssvid.net/*",
      "*://vidssave.com/*",
      "*://www.vidssave.com/*"
    ],
    "js": [
      "browser-compat.js",
      "inject-download.js"
    ],
    "runAt": "document_idle"
  },
  {
    "id": "ytpp-feat-3",
    "matches": [
      "*://www.youtube.com/*",
      "*://youtube.com/*"
    ],
    "js": [
      "browser-compat.js",
      "room-sync.js"
    ],
    "runAt": "document_idle"
  },
  {
    "id": "ytpp-feat-4",
    "matches": [
      "*://www.youtube.com/*",
      "*://youtube.com/*"
    ],
    "js": [
      "return-youtube-dislike.js"
    ],
    "runAt": "document_idle"
  },
  {
    "id": "ytpp-feat-5",
    "matches": [
      "*://www.youtube.com/*",
      "*://youtube.com/*"
    ],
    "js": [
      "sponsorblock.js"
    ],
    "runAt": "document_idle"
  },
  {
    "id": "ytpp-feat-6",
    "matches": [
      "*://www.youtube.com/*",
      "*://youtube.com/*"
    ],
    "js": [
      "content-scripts/pip-mode.js"
    ],
    "runAt": "document_idle"
  },
  {
    "id": "ytpp-feat-7",
    "matches": [
      "*://www.youtube.com/*",
      "*://youtube.com/*"
    ],
    "js": [
      "content-scripts/title-sync.js"
    ],
    "runAt": "document_idle"
  }
];

async function starGateSyncFeatureScripts(verified) {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: STARGATE_FEATURE_SCRIPTS.map((s) => s.id),
    });
    const have = new Set(existing.map((s) => s.id));
    if (verified) {
      const missing = STARGATE_FEATURE_SCRIPTS.filter((s) => !have.has(s.id));
      if (missing.length) await chrome.scripting.registerContentScripts(missing);
    } else if (have.size) {
      await chrome.scripting.unregisterContentScripts({ ids: [...have] });
    }
  } catch (e) {
    console.warn('[YTPP] feature script sync failed:', e);
  }
}

async function starGateSetState(state) {
  const prev = await starGateGetState();
  const wasVerified = !!(prev && prev.verified && prev.token);
  const isVerified = !!(state && state.verified && state.token);

  await chrome.storage.local.set({ ytpp_star_gate: state });
  await starGateSyncFeatureScripts(isVerified);

  // Went from verified → not verified (e.g. the repo star was removed):
  // reload any already-open YouTube tabs so their already-injected feature
  // scripts are dropped immediately, rather than lingering until the user
  // happens to reload the tab themselves.
  if (wasVerified && !isVerified) {
    try {
      const tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://youtube.com/*'] });
      for (const tab of tabs) {
        if (tab.id != null) chrome.tabs.reload(tab.id).catch(() => {});
      }
    } catch (e) {}
  }
}

// Keep registration in line with stored state on every service-worker start,
// install and browser launch (covers updates from older versions too).
(async () => {
  const st = await starGateGetState();
  await starGateSyncFeatureScripts(!!(st && st.verified && st.token));
})();
chrome.runtime.onInstalled.addListener(async () => {
  const st = await starGateGetState();
  await starGateSyncFeatureScripts(!!(st && st.verified && st.token));
});

async function starGateStartDeviceFlow() {
  // Use form-urlencoded (a CORS "simple" content type) instead of
  // application/json — a JSON body forces a preflight OPTIONS request,
  // and github.com's login endpoints don't reliably answer preflights
  // for extension origins in every browser (this was causing a
  // "NetworkError when attempting to fetch resource" failure in
  // Firefox). Sending Accept: application/json still gets us JSON back.
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: STARGATE_GITHUB_CLIENT_ID }).toString(),
  });
  if (!res.ok) throw new Error(`GitHub device_code request failed (${res.status})`);
  const data = await res.json();
  if (!data.device_code) throw new Error(data.error_description || 'Could not start GitHub device flow');
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

async function starGatePollOnce(deviceCode) {
  // Same form-urlencoded fix as starGateStartDeviceFlow() above.
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: STARGATE_GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).toString(),
  });
  const data = await res.json();

  if (data.access_token) return { status: 'success', token: data.access_token };
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow_down' };
  return { status: 'error', error: data.error_description || data.error || 'GitHub authorization failed' };
}

async function starGateCheckStarred(token) {
  const res = await fetch(
    `https://api.github.com/user/starred/${STARGATE_REPO_OWNER}/${STARGATE_REPO_NAME}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
  );
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  if (res.status === 401) throw new Error('GitHub session expired, please verify again.');
  throw new Error(`GitHub star check failed (${res.status})`);
}

// Proactively recheck with GitHub and sync feature scripts, instead of
// waiting for a YouTube tab to ask. This is what makes an unstar take
// effect even if the user never closes/reopens the tab that's already open.
async function starGateProactiveRecheck() {
  const state = await starGateGetState();
  if (!state?.token) return;
  try {
    const starred = await starGateCheckStarred(state.token);
    await starGateSetState({ ...state, verified: starred, lastCheckedAt: Date.now() });
  } catch (e) {
    if (String(e.message).includes('expired')) {
      await starGateSetState({ ...state, verified: false, lastCheckedAt: Date.now() });
    }
    // Transient network error: leave lastCheckedAt so the next alarm retries soon.
  }
}

// Browser startup counts as "starting YouTube" too, in case a YouTube tab
// gets restored from a previous session without a fresh navigation.
chrome.runtime.onStartup.addListener(() => { starGateProactiveRecheck(); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    // A tiny liveness probe: this handler only exists if stargate.js loaded
    // successfully. Feature scripts ping this before doing anything, so if
    // stargate.js is deleted (or importScripts fails for any reason), the
    // service worker never registers this listener, every feature script's
    // ping goes unanswered, and every feature script refuses to run —
    // instead of continuing to work with the enforcement code gone.
    case 'YTPP_STAR_GATE_LIVE_CHECK':
      (async () => {
        const state = await starGateGetState();
        sendResponse({ ok: true, verified: !!(state && state.verified && state.token) });
      })();
      return true;

    case 'YTPP_STAR_GATE_STATUS':
      (async () => {
        const state = await starGateGetState();
        if (!state?.token) {
          sendResponse({ verified: false });
          return;
        }

        // Answer instantly from cache — never block page load on a network call.
        // The user sees YouTube load normally; nothing is held up waiting
        // for GitHub here.
        sendResponse({ verified: !!state.verified });

        // Every single time YouTube starts (this handler runs on every
        // youtube.com navigation/new tab), silently re-check with GitHub in
        // the background — no staleness window, no waiting for a timer.
        // If the star is gone, starGateSetState() below flips the stored
        // state, which (a) unregisters the feature scripts and (b) makes
        // every open YouTube tab's gate.js re-lock itself immediately via
        // the storage.onChanged listener.
        try {
          const starred = await starGateCheckStarred(state.token);
          await starGateSetState({ ...state, verified: starred, lastCheckedAt: Date.now() });
        } catch (e) {
          if (String(e.message).includes('expired')) {
            await starGateSetState({ ...state, verified: false, lastCheckedAt: Date.now() });
          }
          // Transient network error: leave the cached state as-is; the
          // next YouTube start will simply try again.
        }
      })();
      return true;

    case 'YTPP_STAR_GATE_START_AUTH':
      starGateStartDeviceFlow()
        .then((device) => sendResponse({ ok: true, device }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'YTPP_STAR_GATE_POLL_ONCE':
      starGatePollOnce(msg.device_code)
        .then(async (result) => {
          if (result.status === 'success') {
            try {
              const starred = await starGateCheckStarred(result.token);
              await starGateSetState({ verified: starred, lastCheckedAt: Date.now(), token: result.token });
              sendResponse({ status: 'success', starred });
            } catch (e) {
              sendResponse({ status: 'error', error: e.message });
            }
          } else {
            sendResponse(result);
          }
        })
        .catch((e) => sendResponse({ status: 'error', error: e.message }));
      return true;

    case 'YTPP_STAR_GATE_RECHECK':
      (async () => {
        const state = await starGateGetState();
        if (!state?.token) { sendResponse({ ok: false, error: 'not_authenticated' }); return; }
        try {
          const starred = await starGateCheckStarred(state.token);
          await starGateSetState({ ...state, verified: starred, lastCheckedAt: Date.now() });
          sendResponse({ ok: true, starred });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;

    default:
      return undefined;
  }
});
