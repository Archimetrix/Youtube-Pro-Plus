/**
 * Youtube Pro Plus — stargate.js
 *
 * Background-side logic for the "must star the repo" gate.
 * Uses GitHub's OAuth Device Flow so the user proves who they actually are,
 * then checks GET /user/starred/{owner}/{repo} with their own token — the
 * authoritative "did *this* account star it" check.
 *
 * Design: a ONE-TIME, lifetime gate, not an ongoing subscription check.
 *  - For the first STARGATE_GRACE_MS after install, the extension works
 *    normally with no gate at all — let people actually try it first.
 *  - Once the grace period ends, if the user still hasn't verified, the
 *    gate appears and stays until they do. There is no bypass.
 *  - The moment verification succeeds, `verified: true` is written to
 *    local storage permanently. From that point on we NEVER contact GitHub
 *    again for this user — no periodic recheck, no "did they unstar",
 *    no token-expiry concerns. It is a one-time proof, not a subscription.
 *    This also means it survives every future update/reload of the
 *    extension, since chrome.storage.local isn't touched by updates.
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

// How long a brand-new install gets to freely try the extension before the
// one-time star gate appears.
const STARGATE_GRACE_MS = 5 * 60 * 1000; // 5 minutes
const STARGATE_GRACE_ALARM = 'ytpp-star-gate-grace-expired';

async function starGateGetState() {
  const { ytpp_star_gate } = await chrome.storage.local.get('ytpp_star_gate');
  return ytpp_star_gate || null;
}

async function starGateSetState(patch) {
  const prev = (await starGateGetState()) || {};
  const next = { ...prev, ...patch };
  await chrome.storage.local.set({ ytpp_star_gate: next });
  return next;
}

// True if the extension's features should currently run: either the user
// has permanently verified (forever, from here on), or they're still inside
// the one-time grace window after installing.
function starGateIsActive(state) {
  if (!state) return false;
  if (state.verified) return true;
  const installedAt = state.installedAt || Date.now();
  return Date.now() - installedAt < STARGATE_GRACE_MS;
}

// Make sure installedAt is always set — covers a brand-new install, and
// also covers upgrading from an older version of the extension that never
// had this field, so those users get a fresh grace window too instead of
// an error.
async function starGateEnsureInstalledAt() {
  let state = await starGateGetState();
  if (!state) state = {};
  if (!state.installedAt) {
    state = await starGateSetState({ installedAt: Date.now() });
  }
  return state;
}

// Schedule the ONE single-shot alarm that flips the gate on at the end of
// the grace period, for a tab that's open continuously through that
// boundary (chrome.alarms wakes the service worker even if it's gone
// dormant, so this is reliable regardless of SW lifetime).
async function starGateScheduleGraceAlarm(state) {
  if (!state || state.verified) {
    chrome.alarms.clear(STARGATE_GRACE_ALARM);
    return;
  }
  const installedAt = state.installedAt || Date.now();
  const remainingMs = installedAt + STARGATE_GRACE_MS - Date.now();
  const delayInMinutes = Math.max(0.1, remainingMs / 60000);
  chrome.alarms.create(STARGATE_GRACE_ALARM, { delayInMinutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== STARGATE_GRACE_ALARM) return;
  const state = await starGateGetState();
  if (!state || state.verified) return; // verified in the meantime — nothing to do, ever again
  await starGateSyncFeatureScripts(false);
  // Push to any tab that's been open continuously through the grace
  // boundary, so it locks immediately instead of waiting for a reload.
  try {
    const tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://youtube.com/*'] });
    for (const tab of tabs) {
      if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'YTPP_STAR_GATE_GRACE_EXPIRED' }).catch(() => {});
    }
  } catch (e) {}
});

// ── Feature scripts only run while the gate is "active" (verified, or ──────
// still within the one-time grace period). The overlay in gate.js is just
// the UI; the real lock is here — none of the extension's feature scripts
// exist in the static manifest. They're registered dynamically, so hiding
// or deleting the overlay gains the user nothing.
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

async function starGateSyncFeatureScripts(active) {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: STARGATE_FEATURE_SCRIPTS.map((s) => s.id),
    });
    const have = new Set(existing.map((s) => s.id));
    if (active) {
      const missing = STARGATE_FEATURE_SCRIPTS.filter((s) => !have.has(s.id));
      if (missing.length) await chrome.scripting.registerContentScripts(missing);
    } else if (have.size) {
      await chrome.scripting.unregisterContentScripts({ ids: [...have] });
    }
  } catch (e) {
    console.warn('[YTPP] feature script sync failed:', e);
  }
}

// Run on every service worker start (install, update, browser launch, or
// SW waking back up): make sure installedAt exists, sync feature scripts to
// the current true/false state, and (re)schedule the one-shot grace alarm
// if still relevant. This is idempotent and safe to run redundantly.
async function starGateInit() {
  const state = await starGateEnsureInstalledAt();
  await starGateSyncFeatureScripts(starGateIsActive(state));
  await starGateScheduleGraceAlarm(state);
}
starGateInit();
chrome.runtime.onInstalled.addListener(() => { starGateInit(); });
chrome.runtime.onStartup.addListener(() => { starGateInit(); });

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

// A single, one-time check — not part of any ongoing recheck system. Used
// right after the user authenticates, and again if they click "I starred
// it, check again" after starring. Once this ever returns true and gets
// recorded as verified, it is never called again for this user.
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

// Permanently mark this browser as verified: clears the grace alarm (no
// longer relevant), turns features on, and — critically — nothing here
// ever triggers another GitHub call again for this install.
async function starGateMarkVerifiedForever(token) {
  await starGateSetState({ verified: true, verifiedAt: Date.now(), token });
  chrome.alarms.clear(STARGATE_GRACE_ALARM);
  await starGateSyncFeatureScripts(true);
}

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
        sendResponse({ ok: true, verified: starGateIsActive(state) });
      })();
      return true;

    // gate.js asks this on every YouTube start. Purely a local, offline
    // decision from stored state — no network call, nothing to wait on.
    case 'YTPP_STAR_GATE_STATUS':
      (async () => {
        const state = await starGateEnsureInstalledAt();
        if (state.verified) {
          sendResponse({ mode: 'unlocked' });
        } else if (starGateIsActive(state)) {
          sendResponse({ mode: 'grace' });
        } else {
          sendResponse({ mode: 'locked' });
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
              if (starred) {
                await starGateMarkVerifiedForever(result.token);
              } else {
                // Authenticated, but hasn't starred yet — keep the token
                // around (still fresh) so the "check again" button below
                // can reuse it without another full device-flow round trip.
                await starGateSetState({ verified: false, token: result.token });
              }
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
          if (starred) {
            await starGateMarkVerifiedForever(state.token);
          }
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
