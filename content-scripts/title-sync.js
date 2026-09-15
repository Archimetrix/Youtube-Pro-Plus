// title-sync.js
// Keeps the browser tab title matching the video that is actually playing.
//
// The bug this fixes: YouTube's own tab-title updates are driven by page
// timers that Chrome throttles hard once a tab has been in the background
// for a while (a normal Chrome policy, separate from PiP Mode). So when a
// playlist/Mix autoplays the next song while the tab is unfocused, the tab
// title can stay stuck on the previous song's name until you switch back
// to the tab. This previously only "looked fixed" when PiP Mode was on,
// because an active native Picture-in-Picture window happens to exempt the
// tab from that throttling — it wasn't actually PiP Mode syncing the title.
//
// Fix: re-read the real video title straight from the player/page whenever
// (a) the underlying <video> element swaps to a new source, or (b) a ping
// arrives from the background service worker (background.js sets up a
// recurring alarm for this — alarms run in the extension process, not the
// page, so they aren't subject to the page's own timer throttling).

(function () {
    'use strict';

    function isCtxValid() {
        try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
    }

    function getMainVideo() {
        const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
        if (activeRenderer) {
            const v = activeRenderer.querySelector('video');
            if (v) return v;
        }
        return document.querySelector('.html5-video-player video') || document.querySelector('video');
    }

    // Only pages that actually host a video have a title worth taking over.
    // On any other page (home, subscriptions, search, channel...) there is
    // no reliable on-page title element, and falling back to og:title used
    // to grab stale/unrelated text -- e.g. a video ad's advertiser title
    // (like a "Flipkart Big Billion Days" ad) that YouTube's SPA nav
    // doesn't always refresh in that meta tag once you navigate away. The
    // background alarm pings every YouTube tab on a timer regardless of
    // page, so that stale value could stomp the correct native title even
    // while sitting on the home feed. Gate on path + a real video/title
    // element, and never fall back to og:title.
    function isVideoPage() {
        return /^\/(watch|shorts)(\/|$)/.test(location.pathname);
    }

    function getRealTitle() {
        if (!isVideoPage()) return null;
        const candidates = [
            document.querySelector('.ytp-title-link'),
            document.querySelector('ytd-watch-metadata h1 yt-formatted-string'),
            document.querySelector('h1.title.style-scope.ytd-video-primary-info-renderer'),
        ];
        for (const el of candidates) {
            const text = el && el.textContent && el.textContent.trim();
            if (text) return text;
        }
        return null;
    }

    // While an ad plays it uses the SAME <video> element as the real
    // content, so ad start/stop fires the exact loadstart/playing events
    // we listen for -- and .ytp-title-link briefly shows the advertiser's
    // title (e.g. "Flipkart Big Billion Days") instead of the video's.
    // Without this guard that flashes into the tab title for a moment
    // both when the ad starts and, via the same path, right before the
    // real title reasserts itself when it ends.
    function isAdShowing() {
        return !!document.querySelector(
            '.html5-video-player.ad-showing, .html5-video-player.ad-interrupting, .ytp-ad-player-overlay'
        );
    }

    function syncTitle() {
        if (!isVideoPage() || isAdShowing()) return;
        const title = getRealTitle();
        if (!title) return;
        const expected = `${title} - YouTube`;
        if (document.title !== expected) {
            document.title = expected;
        }
    }

    // Retry a few times shortly after a video swap — YouTube fills in the
    // new title text over a couple of DOM updates, not always instantly.
    function syncTitleWithRetries() {
        syncTitle();
        [200, 600, 1200, 2500].forEach(delay => setTimeout(syncTitle, delay));
    }

    // Once an ad ends, content playback fires its own loadstart/playing,
    // which already calls syncTitleWithRetries -- so no separate ad-end
    // watcher is needed beyond the isAdShowing() guard above.

    let lastVideo = null;
    function attachVideoListeners() {
        const video = getMainVideo();
        if (!video || video === lastVideo) return;
        lastVideo = video;
        video.addEventListener('loadstart', syncTitleWithRetries);
        video.addEventListener('playing', syncTitleWithRetries);
    }

    if (isCtxValid()) {
        chrome.runtime.onMessage.addListener((request) => {
            if (request && request.action === 'ytpp-sync-title') {
                syncTitle();
            }
        });
    }

    // YouTube is a SPA — the player/video element gets re-created on
    // navigation and on autoplay-to-next-video, so keep re-attaching.
    const observer = new MutationObserver(() => {
        attachVideoListeners();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    attachVideoListeners();
    syncTitle();
})();
