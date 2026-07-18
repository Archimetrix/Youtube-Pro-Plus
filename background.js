
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

