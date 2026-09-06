
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

// ─── Auto Update Checker ──────────────────────────────────────────────────────
// Fetches the manifest.json from GitHub every 24 hours and compares versions.
// If a newer version is found it shows a Chrome notification and stores a flag
// in chrome.storage.local so the popup can also display an update banner.

const UPDATE_ALARM_NAME   = 'ytpro-update-check';
const UPDATE_CHECK_URL    = 'https://api.github.com/repos/Archimetrix/Youtube-Pro-Plus/contents/manifest.json';
const UPDATE_INTERVAL_MIN = 1440; // 24 hours in minutes
const GITHUB_DOWNLOAD_URL = 'https://github.com/Archimetrix/Youtube-Pro-Plus/archive/refs/heads/main.zip';

/** Semantic-version compare. Returns true if remote > local. */
function isNewerVersion(local, remote) {
    const toNum = v => v.split('.').map(n => parseInt(n, 10) || 0);
    const l = toNum(local);
    const r = toNum(remote);
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
        const a = l[i] || 0, b = r[i] || 0;
        if (b > a) return true;
        if (b < a) return false;
    }
    return false;
}

async function checkForUpdate() {
    try {
        // Accept: application/vnd.github.v3.raw → returns the file content directly,
        // bypassing GitHub's CDN cache which can hold stale content for minutes.
        const res = await fetch(UPDATE_CHECK_URL, {
            headers: { 'Accept': 'application/vnd.github.v3.raw' },
            cache: 'no-store'
        });
        if (!res.ok) return;

        const remoteManifest = await res.json();
        const remoteVersion  = remoteManifest.version;
        const localVersion   = chrome.runtime.getManifest().version;

        if (!remoteVersion || !isNewerVersion(localVersion, remoteVersion)) {
            // Up to date — clear any stale update flag
            chrome.storage.local.set({ updateAvailable: null });
            return;
        }

        // Store for popup banner
        chrome.storage.local.set({
            updateAvailable: { version: remoteVersion, url: GITHUB_DOWNLOAD_URL }
        });

        // Show a Chrome system notification
        chrome.notifications.create('ytpro-update', {
            type:     'basic',
            iconUrl:  'imgs/icon128.png',
            title:    'YouTube Pro+ Update Available 🎉',
            message:  `v${remoteVersion} is ready! Click the extension icon and tap "Update" for step-by-step instructions.`,
            priority: 1
        });

        console.log(`[YT Pro+] Update available: ${localVersion} → ${remoteVersion}`);
    } catch (err) {
        // Network errors are silent — check will retry next cycle
        console.warn('[YT Pro+] Update check failed:', err.message);
    }
}

// Open GitHub when the notification button is clicked
chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
    if (notifId === 'ytpro-update' && btnIndex === 0) {
        chrome.tabs.create({ url: GITHUB_DOWNLOAD_URL });
    }
});

// Also open GitHub when the notification body is clicked
chrome.notifications.onClicked.addListener((notifId) => {
    if (notifId === 'ytpro-update') {
        chrome.tabs.create({ url: GITHUB_DOWNLOAD_URL });
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
