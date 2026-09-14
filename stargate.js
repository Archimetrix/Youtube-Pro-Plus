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
const STARGATE_RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

async function starGateGetState() {
  const { ytpp_star_gate } = await chrome.storage.local.get('ytpp_star_gate');
  return ytpp_star_gate || null;
}

async function starGateSetState(state) {
  await chrome.storage.local.set({ ytpp_star_gate: state });
}

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'YTPP_STAR_GATE_STATUS':
      (async () => {
        const state = await starGateGetState();
        if (!state?.token) {
          sendResponse({ verified: false });
          return;
        }

        // Answer instantly from cache — never block page load on a network call.
        sendResponse({ verified: !!state.verified });

        // Only recheck with GitHub in the background if a full week has
        // passed since the last real check. The clock is anchored to
        // lastCheckedAt, not to "when the extension happened to load".
        const last = state.lastCheckedAt || 0;
        if (Date.now() - last < STARGATE_RECHECK_INTERVAL_MS) return;

        try {
          const starred = await starGateCheckStarred(state.token);
          await starGateSetState({ ...state, verified: starred, lastCheckedAt: Date.now() });
        } catch (e) {
          if (String(e.message).includes('expired')) {
            await starGateSetState({ ...state, verified: false, lastCheckedAt: Date.now() });
          }
          // Transient error: leave lastCheckedAt so next launch retries.
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
