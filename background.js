
// ─── YouTube Pro + Background Service Worker ─────────────────────────────────
// Handles the "Auto Fullscreen on YouTube" feature.
// Enters fullscreen when a YouTube tab is active; exits when switching away.

// Strictly match www.youtube.com and youtube.com ONLY.
// music.youtube.com, m.youtube.com, etc. are intentionally excluded.
const YOUTUBE_HOSTNAMES = new Set(['www.youtube.com', 'youtube.com']);

// Track which windows we've put into fullscreen so we can exit when leaving YT.
const fullscreenedWindows = new Set();

function isYouTubeUrl(url) {
    try {
        return YOUTUBE_HOSTNAMES.has(new URL(url).hostname);
    } catch {
        return false;
    }
}

async function isFullscreenEnabled() {
    return new Promise(resolve => {
        chrome.storage.local.get(['fullscreen'], result => {
            resolve(result.fullscreen === true); // Default OFF
        });
    });
}

// Firefox restricts programmatic fullscreen via the windows API (security policy).
// We attempt fullscreen and silently fall back to maximized if it is blocked.
async function goFullscreen(windowId) {
    if (fullscreenedWindows.has(windowId)) return;
    fullscreenedWindows.add(windowId);
    try {
        await chrome.windows.update(windowId, { state: 'maximized' });
        // Firefox may reject 'fullscreen' state — catch and stay maximized
        await chrome.windows.update(windowId, { state: 'fullscreen' }).catch(() => {});
    } catch (e) {
        fullscreenedWindows.delete(windowId);
    }
}

async function exitFullscreen(windowId) {
    if (!fullscreenedWindows.has(windowId)) return;
    fullscreenedWindows.delete(windowId);
    try {
        const win = await chrome.windows.get(windowId).catch(() => null);
        if (win && (win.state === 'fullscreen' || win.state === 'maximized')) {
            await chrome.windows.update(windowId, { state: 'normal' }).catch(() => {});
        }
    } catch (e) {}
}

// Exit fullscreen on ALL windows we manage — used when feature is disabled
async function exitAllFullscreen() {
    const ids = [...fullscreenedWindows];
    fullscreenedWindows.clear();
    for (const windowId of ids) {
        try {
            const win = await chrome.windows.get(windowId).catch(() => null);
            if (win && (win.state === 'fullscreen' || win.state === 'maximized')) {
                await chrome.windows.update(windowId, { state: 'normal' }).catch(() => {});
            }
        } catch (e) {}
    }
}

// ── Trigger: tab becomes active ──────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (!(await isFullscreenEnabled())) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);

    // If we can't read the tab URL (new tab, chrome:// pages, etc.) treat as non-YouTube
    if (!tab || !tab.url || !isYouTubeUrl(tab.url)) {
        exitFullscreen(windowId);
        return;
    }

    goFullscreen(windowId);
});

// ── Trigger: tab URL changes (navigation inside a tab) ───────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading') return;
    if (!tab.active) return;
    if (!(await isFullscreenEnabled())) return;

    // Exit fullscreen for any navigation away from YouTube (including no URL)
    if (!changeInfo.url || !isYouTubeUrl(changeInfo.url)) {
        exitFullscreen(tab.windowId);
        return;
    }

    goFullscreen(tab.windowId);
});

// ── Reset per-window tracking when a window exits fullscreen manually ─────────
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (win && win.state !== 'fullscreen') {
        fullscreenedWindows.delete(windowId);
    }
});

// ─── Protect user data on install / update ────────────────────────────────────
// chrome.storage.local persists across updates automatically, but this listener
// makes the intent explicit and guards against any future code accidentally
// clearing storage on startup.
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update') {
        // Extension updated — do NOT touch ytProVideos or resumeSettings.
        // Just log silently so it's visible in the background console if needed.
        chrome.storage.local.get(['ytProVideos'], (data) => {
            const count = (data.ytProVideos || []).length;
            console.log(`[YT Pro+] Updated to v${chrome.runtime.getManifest().version}. ${count} history entries preserved.`);
        });
    }
    // For fresh installs, also do nothing — storage starts empty naturally.
});


chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'fullscreenToggleChanged') {
        if (!message.state) {
            exitAllFullscreen();
        }
    } else if (message.action === 'masterToggleChanged') {
        if (!message.state) {
            // Master switch turned off — exit fullscreen everywhere immediately
            exitAllFullscreen();
        }
    }
});

// ─── Report an Issue — FormSubmit relay ───────────────────────────────────────
// Fetch runs from the background service worker (no CORS/CSP restrictions),
// not the popup. Images arrive as base64 strings and are reconstructed as Blobs.

function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
}

async function sendReportViaWeb3Forms(data) {
    const formData = new FormData();
    formData.append('access_key', '198c1cad-2010-4e96-9efb-345f297d381c');
    formData.append('subject',    'Bug Report \u2014 YouTube Pro+');
    formData.append('from_name',  'YouTube Pro+ Extension');
    formData.append('Name',       data.name || 'Anonymous');
    formData.append('Message',    data.message);
    formData.append('Browser',    data.browser);

    (data.images || []).forEach((img, i) => {
        const blob = base64ToBlob(img.base64, img.mimeType);
        formData.append('Screenshot_' + (i + 1), blob, img.fileName);
    });

    const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        body:   formData
        // No Content-Type header — browser sets multipart/form-data + boundary
    });

    const json = await res.json();
    return { ok: json.success === true, message: json.message || '' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SEND_REPORT') {
        sendReportViaWeb3Forms(message.data)
            .then(sendResponse)
            .catch(err => sendResponse({ ok: false, error: err.message }));
        return true; // keep message channel open for async response
    }
});


// ─── Tab Title Sync ────────────────────────────────────────────────────────────
// Chrome throttles timers hard on backgrounded tabs, so YouTube's own tab-title
// updates can get stuck on the previous song when a playlist/Mix autoplays the
// next video while the tab isn't focused. This alarm runs in the extension
// process (not the page), so it's unaffected by that throttling, and just
// pings every open YouTube tab to re-check the real video title.
// Works regardless of the PiP Mode setting — see content-scripts/title-sync.js.

const TITLE_SYNC_ALARM_NAME = 'ytpp-title-sync';

chrome.alarms.get(TITLE_SYNC_ALARM_NAME, (alarm) => {
    if (!alarm) {
        chrome.alarms.create(TITLE_SYNC_ALARM_NAME, {
            delayInMinutes:  1,
            periodInMinutes: 1 // Chrome's practical minimum for packed extensions
        });
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== TITLE_SYNC_ALARM_NAME) return;
    chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://youtube.com/*'] }, (tabs) => {
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { action: 'ytpp-sync-title' }, () => {
                void chrome.runtime.lastError; // no content script in this tab yet — ignore
            });
        }
    });
});

// ─── Auto Update Checker + one-click ("Smooth") updater ───────────────────────
// Every 24 h the GitHub *Releases* API is polled. The result (version, release
// ZIP url, SHA-256 digest, size) is cached in chrome.storage.local under
// `ytpro_update_check`, and the legacy `updateAvailable` flag is still written so
// the popup badge keeps working. If the Releases API is unreachable we fall back
// to reading manifest.json from the repo (version only → manual download).
//
// The one-click install itself lives in smooth-update.js (YtProSmoothUpdate); the
// message handlers further below are what the popup / updater.html talk to.

const UPDATE_ALARM_NAME   = 'ytpro-update-check';
const UPDATE_REPO         = 'Archimetrix/Youtube-Pro-Plus';
const UPDATE_RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_CHECK_URL    = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/manifest.json`;
const UPDATE_INTERVAL_MIN = 1440; // 24 hours in minutes
const GITHUB_DOWNLOAD_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;
const UPDATE_CHECK_KEY    = 'ytpro_update_check';
const SMOOTH_PROGRESS_KEY = 'ytpro_smooth_progress';
const AMO_URL             = 'https://addons.mozilla.org/en-US/firefox/addon/youtube-pro-plus/';

/** Where users go to get the update: AMO on Firefox, the in-extension updater on
 *  unpacked Chromium installs, GitHub releases for store-managed copies. */
function updateTargetUrl() {
    const m = chrome.runtime.getManifest();
    if (m.browser_specific_settings) return AMO_URL;
    if (m.update_url) return GITHUB_DOWNLOAD_URL;
    return chrome.runtime.getURL('updater.html');
}

/** Pulls "8.1" out of tags like "v8.1", "8.1.0", "YtProPlus-v8_1". */
function extractVersion(str) {
    const m = String(str || '').match(/\d+(?:[._]\d+)*/);
    return m ? m[0].replace(/_/g, '.') : '';
}

/** Semantic-version compare. Returns true if remote > local. */
function isNewerVersion(local, remote) {
    const toNum = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
    const l = toNum(local);
    const r = toNum(remote);
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
        const a = l[i] || 0, b = r[i] || 0;
        if (b > a) return true;
        if (b < a) return false;
    }
    return false;
}

/** Prefer an uploaded Chromium .zip; never pick Firefox/source archives. */
function pickReleaseZip(assets) {
    const zips = (Array.isArray(assets) ? assets : []).filter(a => /\.zip$/i.test(a.name || ''));
    const usable = zips.filter(a => !/firefox|gecko|xpi|source|src/i.test(a.name));
    return usable.find(a => /chrom/i.test(a.name)) || usable[0] || null;
}

let updateCheckPromise = null;
function checkForUpdate() {
    if (updateCheckPromise) return updateCheckPromise;
    updateCheckPromise = doCheckForUpdate().finally(() => { updateCheckPromise = null; });
    return updateCheckPromise;
}

async function doCheckForUpdate() {
    const localVersion = chrome.runtime.getManifest().version;
    let result;
    try {
        let latestVersion = '', releaseUrl = GITHUB_DOWNLOAD_URL, zipUrl = '', sha256 = '', zipSize = 0, source = 'release';
        try {
            const res = await fetch(UPDATE_RELEASES_API, {
                cache: 'no-store',
                headers: { Accept: 'application/vnd.github+json' }
            });
            if (!res.ok) throw new Error('GitHub API ' + res.status);
            const data = await res.json();
            latestVersion = extractVersion(data.tag_name) || extractVersion(data.name);
            if (!latestVersion) throw new Error('Release has no version');
            releaseUrl = data.html_url || GITHUB_DOWNLOAD_URL;
            const asset = pickReleaseZip(data.assets);
            zipUrl  = (asset && asset.browser_download_url) || data.zipball_url || '';
            sha256  = asset && /^sha256:/i.test(asset.digest || '') ? asset.digest.slice(7) : '';
            zipSize = (asset && asset.size) || 0;
        } catch (apiErr) {
            // Fallback: version only (no one-click install without a zip url).
            const res = await fetch(UPDATE_CHECK_URL, { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            latestVersion = String((await res.json()).version || '');
            if (!latestVersion) throw apiErr;
            source = 'manifest';
        }

        const updateAvailable = isNewerVersion(localVersion, latestVersion);
        result = {
            ok: true, currentVersion: localVersion, latestVersion, updateAvailable,
            releaseUrl, zipUrl, sha256, zipSize, source, checkedAt: Date.now()
        };
    } catch (err) {
        // Network errors are silent — check will retry next cycle
        console.warn('[YT Pro+] Update check failed:', err.message);
        result = { ok: false, currentVersion: localVersion, error: err.message, checkedAt: Date.now() };
        // Keep the previous good result so the popup doesn't lose a known update.
        const prev = (await chrome.storage.local.get(UPDATE_CHECK_KEY))[UPDATE_CHECK_KEY];
        if (prev && prev.ok) result = Object.assign({}, prev, { stale: true, checkedAt: Date.now() });
        await chrome.storage.local.set({ [UPDATE_CHECK_KEY]: result });
        return result;
    }

    await chrome.storage.local.set({
        [UPDATE_CHECK_KEY]: result,
        lastUpdateCheck: Date.now(),
        updateAvailable: result.updateAvailable ? { version: result.latestVersion, url: GITHUB_DOWNLOAD_URL } : null
    });

    if (result.updateAvailable) {
        // Show a Chrome system notification
        chrome.notifications.create('ytpro-update', {
            type:     'basic',
            iconUrl:  'imgs/icon128.png',
            title:    'YouTube Pro+ Update Available 🎉',
            message:  `v${result.latestVersion} is ready! Click here or the extension icon and tap "Update".`,
            priority: 1
        });
        console.log(`[YT Pro+] Update available: ${localVersion} → ${result.latestVersion}`);
    }
    return result;
}

// Open GitHub when the notification button is clicked
chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
    if (notifId === 'ytpro-update' && btnIndex === 0) {
        chrome.tabs.create({ url: updateTargetUrl() });
    }
});

// Also open GitHub when the notification body is clicked
chrome.notifications.onClicked.addListener((notifId) => {
    if (notifId === 'ytpro-update') {
        chrome.tabs.create({ url: updateTargetUrl() });
        chrome.notifications.clear('ytpro-update');
    }
});

// Register the periodic alarm and run an immediate check on install / browser start
chrome.alarms.get(UPDATE_ALARM_NAME, (alarm) => {
    if (!alarm) {
        chrome.alarms.create(UPDATE_ALARM_NAME, {
            delayInMinutes:  1,               // first check 1 min after SW wakes
            periodInMinutes: UPDATE_INTERVAL_MIN
        });
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM_NAME) checkForUpdate();
});

// Also check whenever the extension is installed or updated
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install' || details.reason === 'update') {
        // Small delay so the SW is fully awake before hitting the network
        setTimeout(checkForUpdate, 3000);
    }
});

// ─── Update messages (popup + updater.html only) ─────────────────────────────
//  YTPRO_CHECK_UPDATE  → run a fresh check, reply with the result object
//  YTPRO_SMOOTH_STATUS → { hasFolder, folderName, permission }
//  YTPRO_SMOOTH_APPLY  → install the pending update in place, then reload.
//                        Replies { needsUser:true } when the user must first pick
//                        the folder / re-allow access (updater.html handles that).

/** Content scripts also carry our extension id, so require an extension-page url. */
function isOwnExtensionPage(sender) {
    return !!(sender && sender.id === chrome.runtime.id && sender.url &&
              sender.url.startsWith(chrome.runtime.getURL('')));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'YTPRO_CHECK_UPDATE') {
        if (!isOwnExtensionPage(sender)) return;
        checkForUpdate().then(sendResponse);
        return true;
    }

    if (msg.type === 'YTPRO_SMOOTH_STATUS') {
        if (!isOwnExtensionPage(sender)) return;
        YtProSmoothUpdate.status()
            .then(sendResponse)
            .catch(() => sendResponse({ hasFolder: false, folderName: '', permission: 'none' }));
        return true;
    }

    if (msg.type === 'YTPRO_SMOOTH_APPLY') {
        if (!isOwnExtensionPage(sender)) return;
        (async () => {
            // The service worker may be evicted mid-install; keep it awake meanwhile.
            const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
            try {
                let info = (await chrome.storage.local.get(UPDATE_CHECK_KEY))[UPDATE_CHECK_KEY];
                if (!info || !info.ok || Date.now() - (info.checkedAt || 0) > 30 * 60 * 1000) info = await checkForUpdate();
                if (!info || !info.ok || !info.updateAvailable) return sendResponse({ ok: false, error: 'No update available.' });
                if (!info.zipUrl) return sendResponse({ ok: false, error: 'This release has no downloadable package yet — use "Download manually".' });
                try {
                    const r = await YtProSmoothUpdate.applyUpdate({
                        zipUrl: info.zipUrl, sha256: info.sha256, expectedVersion: info.latestVersion, sizeHint: info.zipSize,
                        onProgress: (p) => { chrome.storage.session.set({ [SMOOTH_PROGRESS_KEY]: p }).catch(() => {}); }
                    });
                    sendResponse({ ok: true, version: r.version });
                    setTimeout(() => chrome.runtime.reload(), 700);
                } catch (e) {
                    const needsUser = ['NO_FOLDER', 'NEEDS_PERMISSION', 'WRONG_FOLDER'].includes(e.code);
                    sendResponse({ ok: false, needsUser, code: e.code, error: e.message });
                }
            } finally {
                clearInterval(keepAlive);
            }
        })();
        return true;
    }
});

// ─── Remote Announcement / Notification System ───────────────────────────────
// Checks a simple JSON file hosted on GitHub for one-off announcements
// (e.g. new feature callouts, important notices). Each announcement has a
// unique "id" — once shown, that id is saved locally so it is NEVER shown
// again, even across restarts, browser updates, or repeated checks.
//
// To publish a notification: edit annoucement.json in the storage-project-files
// repo with a NEW "id" (any value different from last time) plus "message"
// (required), and optional "title" / "url". Leave "id" blank, or leave the
// file empty/invalid JSON, to show nothing.

const ANNOUNCEMENT_URL         = 'https://raw.githubusercontent.com/Archimetrix/storage-project-files/main/annoucement.json';
const ANNOUNCEMENT_ALARM_NAME  = 'ytpro-announcement-check';
const ANNOUNCEMENT_CHECK_MIN   = 360; // re-check every 6 hours while the browser stays open
const ANNOUNCEMENT_NOTIF_ID    = 'ytpro-announcement';

async function checkForAnnouncement() {
    try {
        const res = await fetch(ANNOUNCEMENT_URL, { cache: 'no-store' });
        if (!res.ok) return;

        const text = (await res.text()).trim();
        if (!text) return; // empty file — nothing to show

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            return; // malformed JSON — ignore silently
        }

        // Accept either a single announcement object OR an array of them,
        // so multiple messages can be queued in one edit of the JSON file.
        const items = Array.isArray(data) ? data : [data];

        const { announcementHistory = [] } = await chrome.storage.local.get(['announcementHistory']);
        const knownIds = new Set(announcementHistory.map(a => a.id));

        // Build fresh records for any id we haven't stored before, oldest first,
        // so the history stays in the order they were added to the file.
        const newRecords = [];
        for (const item of items) {
            const id = item && item.id ? String(item.id).trim() : '';
            if (!id || !item.message || knownIds.has(id)) continue;
            const parsedTs = item.timestamp ? new Date(item.timestamp).getTime() : NaN;
            newRecords.push({
                id,
                title:     item.title || 'YouTube Pro+',
                message:   item.message,
                url:       item.url || null,
                timestamp: !isNaN(parsedTs) ? parsedTs : Date.now()
            });
            knownIds.add(id);
        }

        if (!newRecords.length) return; // nothing new — never repeat old ones

        // Mark as shown FIRST so a crash/race right after this can't cause a repeat.
        // Newest first in history. unreadAnnouncementIds tracks EVERY new item from
        // this batch (not just the latest) so the inbox can highlight all of them,
        // and the bell's red dot stays lit until the inbox is actually opened.
        const newHistory = [...newRecords.reverse(), ...announcementHistory].slice(0, 20); // keep last 20
        const latest = newRecords[0]; // after reverse(), index 0 is the most recently added

        const { unreadAnnouncementIds = [] } = await chrome.storage.local.get(['unreadAnnouncementIds']);
        const newUnreadIds = [...new Set([...newRecords.map(r => r.id), ...unreadAnnouncementIds])];

        await chrome.storage.local.set({
            announcementHistory:     newHistory,
            unreadAnnouncementIds:   newUnreadIds
        });

        // The OS-level notification is just a heads-up ping — it's small and
        // gets truncated by the OS, so the full, permanent text lives in the
        // popup's Updates inbox (see popup.js) instead of relying on this bubble.
        const pingMessage = newRecords.length === 1
            ? 'New update — click the extension icon to read it.'
            : `${newRecords.length} new updates — click the extension icon to read them.`;

        const notifTitle = newRecords.length === 1 ? latest.title : 'YouTube Pro+';
        try {
            chrome.notifications.create(ANNOUNCEMENT_NOTIF_ID, {
                type:     'basic',
                iconUrl:  'imgs/icon128.png',
                title:    notifTitle,
                message:  pingMessage,
                priority: 2,
                requireInteraction: true
            });
        } catch (notifErr) {
            try {
                chrome.notifications.create(ANNOUNCEMENT_NOTIF_ID, {
                    type:    'basic',
                    iconUrl: 'imgs/icon128.png',
                    title:   notifTitle,
                    message: pingMessage
                });
            } catch (fallbackErr) {
                console.warn('[YT Pro+] OS notification unsupported on this browser:', fallbackErr.message);
            }
        }

        console.log(`[YT Pro+] ${newRecords.length} new announcement(s) shown`);
    } catch (err) {
        console.warn('[YT Pro+] Announcement check failed:', err.message);
    }
}

// Clicking the small OS bubble opens the extension popup (where the FULL text
// lives), rather than a link — so the person can actually read it. If the
// browser can't programmatically open the popup, fall back to the URL (if any).
chrome.notifications.onClicked.addListener(async (notifId) => {
    if (notifId !== ANNOUNCEMENT_NOTIF_ID) return;
    chrome.notifications.clear(notifId);
    try {
        await chrome.action.openPopup();
    } catch (e) {
        const { announcementHistory = [] } = await chrome.storage.local.get(['announcementHistory']);
        const url = announcementHistory[0] && announcementHistory[0].url;
        if (url) chrome.tabs.create({ url });
    }
});

// Register the periodic alarm
chrome.alarms.get(ANNOUNCEMENT_ALARM_NAME, (alarm) => {
    if (!alarm) {
        chrome.alarms.create(ANNOUNCEMENT_ALARM_NAME, {
            delayInMinutes:  1,
            periodInMinutes: ANNOUNCEMENT_CHECK_MIN
        });
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ANNOUNCEMENT_ALARM_NAME) checkForAnnouncement();
});

// Check on install/update and on every browser startup
chrome.runtime.onInstalled.addListener(() => {
    setTimeout(checkForAnnouncement, 4000);
});

chrome.runtime.onStartup.addListener(() => {
    setTimeout(checkForAnnouncement, 4000);
});
