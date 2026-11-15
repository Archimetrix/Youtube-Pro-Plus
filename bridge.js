/*
 * Background bridge for content scripts.
 *
 * Content scripts used to (a) make YouTube's page load extension files
 * (<link>/<script src="chrome-extension://...">) and (b) call two public APIs
 * with fetch() from inside the YouTube tab. Both are "page context" requests,
 * and many setups refuse them (Brave Shields, content blockers, CORS/CSP
 * quirks) - which is what fills the extension's error list with
 * "Unsafe attempt to load URL ... Domains, protocols and ports must match".
 *
 * The background is not subject to any of that, so it does the work and hands
 * the result back. Every handler:
 *   - only answers this extension's own content scripts on YouTube tabs,
 *   - applies the same gate as everything else (verified / grace / skipped tab),
 *   - uses fixed allowlists, so it can't be used as a general proxy or to
 *     inject arbitrary code.
 * Content scripts keep their old direct path as a fallback.
 */
(() => {
  const FETCH_HOSTS = new Set(['sponsor.ajay.app', 'returnyoutubedislikeapi.com']);
  const CSS_FILES   = new Set(['block-popups.css', 'features.css', 'theme.css']);
  const MAIN_FILES  = new Set(['default-quality.js', 'inject-speed.js']);
  const MAX_TEXT    = 5 * 1024 * 1024;

  function isYouTube(sender) {
    try {
      const h = new URL(sender.url || (sender.tab && sender.tab.url) || '').hostname;
      return h === 'www.youtube.com' || h === 'youtube.com';
    } catch (e) { return false; }
  }

  async function tabAllowed(sender) {
    try {
      const state = await starGateEnsureInstalledAt();
      return starGateIsActive(state) || (await starGateTabIsSkipped(sender.tab));
    } catch (e) { return false; }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('YTPP_BRIDGE_')) return false;
    if (sender.id !== chrome.runtime.id || !sender.tab || !isYouTube(sender)) {
      sendResponse({ ok: false, error: 'forbidden' });
      return false;
    }
    (async () => {
      try {
        if (!(await tabAllowed(sender))) { sendResponse({ ok: false, locked: true }); return; }

        if (msg.type === 'YTPP_BRIDGE_FETCH') {
          const u = new URL(String(msg.url));
          if (u.protocol !== 'https:' || !FETCH_HOSTS.has(u.hostname)) { sendResponse({ ok: false, error: 'forbidden' }); return; }
          const res  = await fetch(u.href, { cache: 'no-store', credentials: 'omit' });
          const text = (await res.text()).slice(0, MAX_TEXT);
          sendResponse({ ok: true, status: res.status, statusOk: res.ok, text });

        } else if (msg.type === 'YTPP_BRIDGE_ASSET') {
          if (!CSS_FILES.has(msg.file)) { sendResponse({ ok: false, error: 'forbidden' }); return; }
          const res = await fetch(chrome.runtime.getURL(msg.file));
          if (!res.ok) { sendResponse({ ok: false, error: 'status ' + res.status }); return; }
          sendResponse({ ok: true, text: await res.text() });

        } else if (msg.type === 'YTPP_BRIDGE_MAIN') {
          const files = Array.isArray(msg.files) ? msg.files : [];
          if (!files.length || !files.every((f) => MAIN_FILES.has(f))) { sendResponse({ ok: false, error: 'forbidden' }); return; }
          await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
            world: 'MAIN',
            files,
          });
          sendResponse({ ok: true });

        } else {
          sendResponse({ ok: false, error: 'unknown' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // async response
  });
})();
