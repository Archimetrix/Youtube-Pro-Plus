// ─── Extension context guard ─────────────────────────────────────────────────
// Prevents "Extension context invalidated" crashes when the extension is
// reloaded/updated while a YouTube tab is still open with the old script.
function isCtxValid() {
    try { return !!chrome.runtime?.id; } catch(e) { return false; }
}

// ─── YT Pro Plus: Asset Injectors ────────────────────────────────────────────
function injectCSS(file) {
    const link = document.createElement("link");
    link.href = chrome.runtime.getURL(file);
    link.type = "text/css";
    link.rel = "stylesheet";
    link.classList.add('yt-pro-injected-asset');
    document.head.appendChild(link);
}

function injectScript(file) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(file);
    script.classList.add('yt-pro-injected-asset');
    script.onload = function() { this.remove(); };
    (document.head || document.documentElement).appendChild(script);
}

// Always block the interruption toast, regardless of master toggle
injectCSS('block-popups.css');
// Always inject premium logo + ambient styles so they work independently of the theme toggle
injectCSS('features.css');

// ─── Shorts Auto-Scroller ─────────────────────────────────────────────────────
let autoScrollInterval = null;

function getShortsActiveVideo() {
    // Prefer the video inside the active reel renderer — avoids picking up
    // lingering regular-video elements left in the DOM during SPA transitions.
    const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
    if (activeRenderer) {
        const v = activeRenderer.querySelector('video');
        if (v && v.readyState > 2) return v;
    }
    // Fallback: any playing video while on a shorts URL
    return Array.from(document.querySelectorAll('video'))
        .find(v => !v.paused && v.readyState > 2) || null;
}

function forceDisableLoop(video) {
    if (!video || !video.loop) return;
    video.loop = false;
}

function initAutoScroll() {
    if (autoScrollInterval) clearInterval(autoScrollInterval);

    // ── When YouTube SPA-navigates TO a shorts page, immediately seize the
    // video and kill loop — before YouTube's own init can re-enable it.
    document.addEventListener('yt-navigate-finish', () => {
        if (!window.location.pathname.includes('/shorts/')) return;

        // Try immediately, then retry a few times to win the race against
        // YouTube's late loop-setter that runs after yt-navigate-finish.
        [0, 100, 300, 600, 1000].forEach(delay => {
            setTimeout(() => {
                const v = getShortsActiveVideo() ||
                    document.querySelector('ytd-reel-video-renderer[is-active] video') ||
                    document.querySelector('ytd-shorts video');
                if (v) forceDisableLoop(v);
            }, delay);
        });
    });

    autoScrollInterval = setInterval(() => {
        if (!window.location.pathname.includes('/shorts/')) return;

        const activeVideo = getShortsActiveVideo();
        if (!activeVideo) return;

        forceDisableLoop(activeVideo);

        if (activeVideo.duration > 0 && (activeVideo.duration - activeVideo.currentTime) < 0.4) {
            const nextBtn =
                document.querySelector('ytd-reel-video-renderer[is-active] #navigation-button-down button') ||
                document.querySelector('#navigation-button-down ytd-button-renderer button') ||
                document.querySelector('#navigation-button-down button');

            if (nextBtn) {
                activeVideo.currentTime = 0;
                nextBtn.click();
            } else {
                window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
            }
        }
    }, 200);
}

// ─── Smart Download Button Override ──────────────────────────────────────────
let downloadInterceptActive = false;
let downloadButtonObserver = null;

// Selectors that cover YouTube's download entry point in all its forms.
// YouTube has moved this around over time — from a dedicated player-area
// button, to a masthead button, to (currently) a line item inside the
// "⋮" (more actions) overflow menu. The overflow-menu version isn't a
// <button> at all, it's a menu-item custom element, so we match broadly
// and rely on isDownloadLabel() below to filter to the right one.
const DL_BTN_SELECTORS = [
    'ytd-download-button-renderer button',
    'button[aria-label="Download video"]',
    'button[aria-label*="Download" i]',
    '.ytp-download-button',
    'yt-button-shape button',
    // Overflow ("...") menu — rendered as menu-item elements, not buttons.
    'tp-yt-paper-item',
    'ytd-menu-service-item-renderer',
    'yt-list-item-view-model',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
].join(', ');

// True only for elements whose visible text/label is actually "Download" —
// needed because several of the selectors above (menu items, list items)
// match plenty of unrelated UI too (Save, Report, Clip, etc).
function isDownloadLabel(el) {
    if (!el) return false;
    const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '')
        .trim()
        .toLowerCase();
    // Match "download" as a whole word-ish token so we don't accidentally
    // match something like "downloaded" mid-sentence in an unrelated string.
    return /(^|[^a-z])download([^a-z]|$)/.test(label);
}

// Force-enable a single button regardless of YouTube's disabled state
function forceEnableDownloadButton(btn) {
    if (btn.dataset.ytProForced === '1') return; // already done
    btn.dataset.ytProForced = '1';

    btn.removeAttribute('disabled');
    btn.removeAttribute('aria-disabled');
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    btn.style.cursor = 'pointer';

    // Also un-disable wrapper elements YouTube uses
    const renderer = btn.closest('ytd-download-button-renderer, yt-button-shape, .yt-button-shape-with-explainer, tp-yt-paper-item, ytd-menu-service-item-renderer');
    if (renderer) {
        renderer.removeAttribute('disabled');
        renderer.removeAttribute('aria-disabled');
        renderer.style.pointerEvents = 'auto';
        renderer.style.opacity = '1';
    }
}

// Watch for download buttons being added or toggled into a disabled state
function startDownloadButtonWatcher() {
    if (downloadButtonObserver) return;

    // Enable any buttons already on the page
    document.querySelectorAll(DL_BTN_SELECTORS).forEach(btn => {
        if (isDownloadLabel(btn)) forceEnableDownloadButton(btn);
    });

    downloadButtonObserver = new MutationObserver(() => {
        document.querySelectorAll(DL_BTN_SELECTORS).forEach(btn => {
            if (!isDownloadLabel(btn)) return; // leave unrelated menu items alone
            // Re-enable whenever YouTube disables the button again
            if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true' ||
                btn.style.pointerEvents === 'none' || btn.dataset.ytProForced !== '1') {
                btn.dataset.ytProForced = '0'; // reset so forceEnable runs again
                forceEnableDownloadButton(btn);
            }
        });
    });

    downloadButtonObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'style'],
    });
}

function stopDownloadButtonWatcher() {
    if (downloadButtonObserver) {
        downloadButtonObserver.disconnect();
        downloadButtonObserver = null;
    }
}

function initDownloadIntercept() {
    if (downloadInterceptActive) return;
    downloadInterceptActive = true;
    document.addEventListener('click', handleDownloadClick, true);
    startDownloadButtonWatcher();
}

function removeDownloadIntercept() {
    downloadInterceptActive = false;
    document.removeEventListener('click', handleDownloadClick, true);
    stopDownloadButtonWatcher();
}

function handleDownloadClick(e) {
    // composedPath() sees through shadow-DOM boundaries the overflow menu's
    // popup may be rendered in; e.target alone can get retargeted to a
    // shadow host and miss the actual menu-item element.
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    let btn = null;
    for (const node of path) {
        if (!(node instanceof Element)) continue;
        const match = node.closest ? node.closest(DL_BTN_SELECTORS) : null;
        if (match && isDownloadLabel(match)) { btn = match; break; }
    }
    if (!btn) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const videoUrl = getCleanVideoUrl();

    try {
        navigator.clipboard.writeText(videoUrl).catch(() => {});
    } catch (_) {}

    chrome.storage.local.set({
        ssvid_pending_url: videoUrl,
        ssvid_pending_ts:  Date.now()
    }, () => {
        window.open('https://vidssave.com/youtube-video-downloader-8hs', '_blank', 'noopener,noreferrer');
    });
}

function getCleanVideoUrl() {
    const url = new URL(window.location.href);
    const videoId = url.searchParams.get('v');
    if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return `https://www.youtube.com${url.pathname}`;
}

// ─── Resume Duration Badge on Thumbnails ─────────────────────────────────────
let badgeVideoData = {};
let badgeObserverActive = false;

function extractWatchIDForBadge(link) {
    if (!link) return null;
    const m = link.match(/[?&]v=([^&#]+)/);
    return m ? m[1] : null;
}

function formatTimeForBadge(sec) {
    if (!sec || isNaN(sec) || sec < 5) return null;
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = n => n < 10 ? '0' + n : '' + n;
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

// ── Thumbnail targets: covers every surface YouTube renders thumbnails on ──────
const THUMB_LINK_SELECTORS = [
    // Standard watch page / homepage / search
    'ytd-thumbnail a#thumbnail[href]',
    // Playlist panel (the queue panel shown in screenshot)
    'ytd-playlist-panel-video-renderer a#thumbnail[href]',
    // Mini playlist / mix panel items
    'ytd-compact-video-renderer a#thumbnail[href]',
    // Related / sidebar
    'ytd-compact-radio-renderer a#thumbnail[href]',
    // Channel page grid
    'ytd-grid-video-renderer a#thumbnail[href]',
    // Search results
    'ytd-video-renderer a#thumbnail[href]',
    // Shorts shelf items
    'ytd-reel-item-renderer a#thumbnail[href]',
    // Watch later / saved playlists
    'ytd-playlist-video-renderer a#thumbnail[href]',
].join(', ');

function getThumbContainer(thumbLink) {
    // Walk up to find the real image host (ytd-thumbnail or the link itself)
    return (
        thumbLink.querySelector('ytd-animated-thumbnail') ||
        thumbLink.querySelector('#img') ||
        thumbLink.querySelector('yt-image') ||
        thumbLink.querySelector('img') ||
        thumbLink
    );
}

function injectBadgesOnPage() {
    if (!Object.keys(badgeVideoData).length) return;

    document.querySelectorAll(THUMB_LINK_SELECTORS).forEach(thumb => {
        const href    = thumb.getAttribute('href') || '';
        const fullUrl = href.startsWith('http') ? href : 'https://www.youtube.com' + href;
        const videoId = extractWatchIDForBadge(fullUrl);
        if (!videoId) return;

        const stored = badgeVideoData[videoId];
        if (!stored || stored.doNotResume) return;

        const pct      = stored.duration > 0 ? Math.min(stored.time / stored.duration, 1) : 0;
        const timeStr  = formatTimeForBadge(stored.time);
        if (pct < 0.01 || !timeStr) return;   // skip if barely watched

        const container = getThumbContainer(thumb);
        container.style.position = 'relative';

        // ── 1. Progress bar at the very bottom (like YouTube's red line) ─────
        let bar = container.querySelector('.yt-pro-pbar-wrap');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'yt-pro-pbar-wrap';
            bar.style.cssText = [
                'position:absolute', 'bottom:0', 'left:0', 'right:0',
                'height:5px',                          // bolder than before (was 3px)
                'background:rgba(255,255,255,0.12)',
                'pointer-events:none', 'z-index:200',  // higher z-index to sit above YT bar
                'border-radius:0 0 2px 2px'
            ].join(';');
            const fill = document.createElement('div');
            fill.className = 'yt-pro-pbar-fill';
            fill.style.cssText = [
                'height:100%', 'background:#00d2ff',
                'border-radius:0 0 0 2px', 'transition:width 0.4s ease',
                'box-shadow:0 0 4px rgba(0,210,255,0.6)'   // subtle glow so it pops
            ].join(';');
            bar.appendChild(fill);
            container.appendChild(bar);
        }
        // Always update width so it refreshes as you watch
        bar.querySelector('.yt-pro-pbar-fill').style.width = (pct * 100).toFixed(2) + '%';

        // ── 2. Time badge (bottom-left corner) ───────────────────────────────
        let badge = container.querySelector('.yt-pro-resume-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'yt-pro-resume-badge';
            badge.style.cssText = [
                'position:absolute', 'bottom:6px', 'left:4px',
                'background:rgba(0,0,0,0.82)', 'color:#00d2ff',
                'font-size:10px', 'font-weight:700', 'padding:2px 6px',
                'border-radius:3px', 'pointer-events:none',
                'font-family:Roboto,Arial,sans-serif', 'letter-spacing:0.3px',
                'border:1px solid rgba(0,210,255,0.45)', 'z-index:102',
                'line-height:14px'
            ].join(';');
            container.appendChild(badge);
        }
        badge.textContent = '▶ ' + timeStr;
    });
}

function loadBadgeData(cb) {
    if (!isCtxValid()) return;
    chrome.storage.local.get('ytProVideos', (data) => {
        badgeVideoData = {};
        (data.ytProVideos || []).forEach(v => {
            const id = extractWatchIDForBadge(v.videolink);
            if (id) badgeVideoData[id] = v;
        });
        injectBadgesOnPage();
        if (cb) cb();
    });
}

function initBadgeInjection() {
    // Suppress YouTube's native red resume-playback bar so only our blue one shows
    if (!document.getElementById('yt-pro-hide-native-bar')) {
        const style = document.createElement('style');
        style.id = 'yt-pro-hide-native-bar';
        style.textContent = `
            ytd-thumbnail-overlay-resume-playback-renderer,
            ytd-thumbnail-overlay-resume-playback-renderer * {
                display: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    loadBadgeData();
    if (!badgeObserverActive) {
        badgeObserverActive = true;
        let badgeTimer = null;
        new MutationObserver(() => {
            clearTimeout(badgeTimer);
            badgeTimer = setTimeout(injectBadgesOnPage, 250);
        }).observe(document.body, { childList: true, subtree: true });
        // Refresh stored data every 5 s so progress bars stay in sync while watching
        setInterval(() => loadBadgeData(), 5000);
    }
}

// ─── Auto Resume Feature ──────────────────────────────────────────────────────
const RESUME_CHANNEL_SELECTOR = "ytd-video-owner-renderer ytd-channel-name a";
const RESUME_ICON_ACTIVE   = chrome.runtime.getURL("imgs/playericon.svg");
const RESUME_ICON_INACTIVE = chrome.runtime.getURL("imgs/playericon_inactive.svg");

let resumeInitialLinkIsVideo = false;
let resumeNavLoop = false;
let resumeUserSettings = {};
let resumeBlacklist = false;
let resumeActive = false;
let resumeTimeUpdateAbort = null; // AbortController for timeupdate listener cleanup
const sessionTrackedVideos = new Set(); // DEPRECATED — kept to avoid reference errors, no longer used
let currentNavVideoId      = null;  // video ID active in the current navigation
let currentNavIncremented  = false; // whether watchCount was already incremented this navigation

class YTProAutoResume {
    constructor() {
        window.addEventListener('load', this.initialize.bind(this));
    }

    async initialize() {
        await this.initStorage();
        resumeUserSettings = await this.getUserSettings();

        // Check master enable + feature toggle
        const result = await new Promise(r => chrome.storage.local.get(['masterEnabled', 'autoResume'], r));
        if (result.masterEnabled === false) return;
        if (result.autoResume === false) return;

        resumeActive = true;
        this.start();
    }

    start() {
        if (resumeUserSettings.pauseResume) return;

        resumeInitialLinkIsVideo = this.checkWatchable(window.location.href);
        if (resumeInitialLinkIsVideo) this.injectPlayerButton();

        this.setupEventListeners();

        if (resumeInitialLinkIsVideo && !resumeNavLoop) {
            this.runMainVideoProcess();
        }
    }

    setupEventListeners() {
        document.addEventListener('yt-navigate-finish', async () => {
            // ── Kill the previous timeupdate listener IMMEDIATELY on navigation ──
            // Without this, the old listener fires with the old video's currentTime
            // but the new URL, causing the new video to be saved with a wrong timestamp.
            if (resumeTimeUpdateAbort) {
                resumeTimeUpdateAbort.abort();
                resumeTimeUpdateAbort = null;
            }

            // Reset per-navigation watch-count tracking so the new video
            // (or a revisited video) gets its count incremented fresh.
            currentNavVideoId     = null;
            currentNavIncremented = false;

            if (resumeInitialLinkIsVideo) {
                resumeInitialLinkIsVideo = false;
                await this.resetButton();
                this.runMainVideoProcess();
            } else {
                await this.resetButton();
                this.runMainVideoProcess();
                resumeNavLoop = true;
            }
        });
        window.addEventListener('yt-pro-title-change', this.handleTitleChange.bind(this));
    }

    handleTitleChange(event) {
        this.runMainVideoProcess(event.detail.title);
    }

    dispatchTitleChangeEvent(newTitle) {
        window.dispatchEvent(new CustomEvent('yt-pro-title-change', { detail: { title: newTitle } }));
    }

    async injectPlayerButton() {
        // Don't stack a second button if one's already there.
        if (document.querySelector("#yt-pro-resume-switch")) return;

        const blacklisted = await this.checkBlacklist(window.location.href);
        const imgSrc   = blacklisted ? RESUME_ICON_INACTIVE : RESUME_ICON_ACTIVE;
        const tooltip  = blacklisted ? "Video will not auto-resume" : "Video will auto-resume";
        const button   = this.createPlayerButton(imgSrc, tooltip);

        this.mountButtonWhenReady(button);
    }

    // The player controls (div.ytp-right-controls) aren't guaranteed to exist
    // the instant we try to inject — YouTube's player can still be mounting
    // asynchronously after the page's `load` event, especially on a cold
    // cache or a slower machine/connection. A single querySelector attempt
    // silently drops the button in that case and nothing ever retries it
    // (the only other trigger is a full SPA navigation). So: poll for a
    // bounded time, and back it with a MutationObserver so we catch it the
    // instant it appears rather than waiting for the next poll tick.
    mountButtonWhenReady(button, attempts = 0) {
        if (document.querySelector("#yt-pro-resume-switch")) return; // got mounted another way already

        const controls = document.querySelector("div.ytp-right-controls");
        if (controls) {
            controls.prepend(button);
            return;
        }

        if (attempts >= 100) return; // ~30s ceiling — give up quietly past that

        if (attempts === 0) {
            const observer = new MutationObserver(() => {
                const c = document.querySelector("div.ytp-right-controls");
                if (c && !document.querySelector("#yt-pro-resume-switch")) {
                    c.prepend(button);
                    observer.disconnect();
                } else if (document.querySelector("#yt-pro-resume-switch")) {
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            // Safety net in case the observer never fires (e.g. controls
            // appear via an attribute change rather than a new node).
            setTimeout(() => observer.disconnect(), 30000);
        }

        setTimeout(() => this.mountButtonWhenReady(button, attempts + 1), 300);
    }

    createPlayerButton(imgSrc, tooltip) {
        const button = document.createElement("div");
        button.classList.add("ytp-button", "yt-pro-resume-btn");
        button.id    = "yt-pro-resume-switch";
        button.title = tooltip;
        button.ariaLabel = tooltip;
        button.style.verticalAlign = "top";
        button.onclick = this.onPlayerButtonClick.bind(this);

        const img    = document.createElement("img");
        img.id       = "yt-pro-resume-icon";
        img.src      = imgSrc;
        img.style.height  = "90%";
        img.style.display = "block";
        img.style.margin  = "auto";
        button.appendChild(img);
        return button;
    }

    async onPlayerButtonClick() {
        await this.grabTitle();
        const video     = document.querySelector("video");
        const markPlayed = video.duration - video.currentTime < resumeUserSettings.markPlayedTime;
        resumeBlacklist  = document.querySelector("#yt-pro-resume-switch").checked;
        this.togglePlayerButtonState(resumeBlacklist, markPlayed, video);
    }

    async togglePlayerButtonState(blacklist, markPlayed, video) {
        const switchIcon = document.querySelector("#yt-pro-resume-icon");
        const switchBtn  = document.querySelector("#yt-pro-resume-switch");

        switchIcon.src   = blacklist ? RESUME_ICON_INACTIVE : RESUME_ICON_ACTIVE;
        switchBtn.title  = blacklist ? "Video will not auto-resume" : "Video will auto-resume";
        switchBtn.checked = !blacklist;

        await this.setTime({
            videolink: window.location.href,
            time:      video.currentTime,
            duration:  video.duration,
            title:     document.querySelector("h1.title.style-scope.ytd-video-primary-info-renderer")?.textContent || document.title,
            channel:   document.querySelector(RESUME_CHANNEL_SELECTOR)?.textContent || "",
            complete:  markPlayed,
            doNotResume: blacklist,
            timestamp: Date.now()
        });
    }

    async resetButton() {
        const button = document.querySelector("#yt-pro-resume-switch");
        if (button) {
            const blacklisted = await this.checkBlacklist(window.location.href);
            const imgSrc  = blacklisted ? RESUME_ICON_INACTIVE : RESUME_ICON_ACTIVE;
            const tooltip = blacklisted ? "Video will not auto-resume" : "Video will auto-resume";
            button.title     = tooltip;
            button.ariaLabel = tooltip;
            button.checked   = !blacklisted;
            document.querySelector("#yt-pro-resume-icon").src = imgSrc;
        } else {
            await this.injectPlayerButton();
        }
    }

    getUserSettings() {
        return new Promise(resolve => {
            chrome.storage.local.get("resumeSettings", data => {
                resolve(data.resumeSettings || {
                    pauseResume: false,
                    minWatchTime: 60,
                    minVideoLength: 120,
                    markPlayedTime: 10,
                    deleteAfter: 0
                });
            });
        });
    }

    initStorage() {
        return Promise.all([this.initDB(), this.initSettings()]);
    }

    initDB() {
        return new Promise(resolve => {
            chrome.storage.local.getBytesInUse("ytProVideos", bytes => {
                if (bytes === 0 || bytes === undefined) {
                    chrome.storage.local.set({ ytProVideos: [] }, resolve);
                } else {
                    resolve();
                }
            });
        });
    }

    initSettings() {
        return new Promise(resolve => {
            chrome.storage.local.getBytesInUse("resumeSettings", bytes => {
                if (bytes === 0 || bytes === undefined) {
                    chrome.storage.local.set({
                        resumeSettings: {
                            pauseResume: false,
                            minWatchTime: 60,
                            minVideoLength: 120,
                            markPlayedTime: 10,
                            deleteAfter: 0
                        }
                    }, resolve);
                } else {
                    resolve();
                }
            });
        });
    }

    extractWatchID(link) {
        if (!link) return '';
        const m = link.match(/[?&]v=([^&#]+)/);
        return m ? m[1] : '';
    }

    grabTitle() {
        return new Promise(resolve => {
            let el = document.querySelector("h1.title.style-scope.ytd-video-primary-info-renderer");
            if (el) return resolve(el.textContent);
            const interval = setInterval(() => {
                el = document.querySelector("h1.title.style-scope.ytd-video-primary-info-renderer");
                if (el) { clearInterval(interval); resolve(el.textContent); }
            }, 2000);
        });
    }

    checkWatchable(link) {
        return link.includes("watch?") && !link.includes("?t=");
    }

    checkBlacklist(link) {
        return new Promise(resolve => {
            chrome.storage.local.get("ytProVideos", data => {
                const bl = (data.ytProVideos || []).some(v =>
                    this.extractWatchID(v.videolink) === this.extractWatchID(link) && v.doNotResume
                );
                resolve(bl);
            });
        });
    }

    setTime(video, incrementCount = false) {
        return new Promise(resolve => {
            chrome.storage.local.get("ytProVideos", data => {
                const existing = (data.ytProVideos || []).find(v =>
                    this.extractWatchID(v.videolink) === this.extractWatchID(video.videolink)
                );

                const currentCount = existing?.watchCount ?? 0;
                const watchCount = incrementCount ? currentCount + 1 : currentCount;

                const videos = (data.ytProVideos || []).filter(v =>
                    this.extractWatchID(v.videolink) !== this.extractWatchID(video.videolink)
                );
                videos.push({ ...video, watchCount });
                chrome.storage.local.set({ ytProVideos: videos }, () => {
                    // Immediately refresh badge/progress data so in-page bars stay current
                    loadBadgeData();
                    resolve();
                });
            });
        });
    }

    async runMainVideoProcess(newTitle = null) {
        await this.mainVideoProcess(newTitle);
        resumeNavLoop = true;
    }

    async mainVideoProcess(newTitle = null) {
        return new Promise(async resolve => {
            if (!this.checkWatchable(window.location.href)) {
                resolve();
                return;
            }
            const durationOk = await this.checkDuration();
            if (!durationOk) {
                resolve();
                return;
            }

            const videoTitle = newTitle || await this.grabTitle();
            if (!resumeInitialLinkIsVideo && !resumeNavLoop) { resolve(); return; }

            try {
                const storedVideo = await this.checkStoredLinks(window.location.href);
                if (storedVideo.time > resumeUserSettings.minWatchTime &&
                    !storedVideo.complete && !storedVideo.doNotResume) {
                    document.querySelector("video").currentTime = storedVideo.time;
                }
                resumeBlacklist = storedVideo.doNotResume;
            } catch {
                resumeBlacklist = false;
            }

            this.monitorVideoTime(resolve);
        });
    }

    checkDuration() {
        return new Promise(resolve => {
            const video = document.querySelector("video");
            if (!video) return resolve(false);

            // Duration already available
            if (video.duration && !isNaN(video.duration) && video.duration > 0) {
                return resolve(video.duration >= resumeUserSettings.minVideoLength);
            }

            // Wait for metadata to load (max 8 seconds)
            const timeout = setTimeout(() => {
                video.removeEventListener('loadedmetadata', onMeta);
                video.removeEventListener('durationchange', onMeta);
                resolve(false);
            }, 8000);

            function onMeta() {
                if (!video.duration || isNaN(video.duration) || video.duration <= 0) return;
                clearTimeout(timeout);
                video.removeEventListener('loadedmetadata', onMeta);
                video.removeEventListener('durationchange', onMeta);
                resolve(video.duration >= resumeUserSettings.minVideoLength);
            }

            video.addEventListener('loadedmetadata', onMeta);
            video.addEventListener('durationchange', onMeta);
        });
    }

    checkStoredLinks(link) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get("ytProVideos", data => {
                const found = (data.ytProVideos || []).find(v =>
                    this.extractWatchID(v.videolink) === this.extractWatchID(link)
                );
                if (found) {
                    if (found.timestamp && resumeUserSettings.deleteAfter && this.daysSince(found.timestamp) > resumeUserSettings.deleteAfter) {
                        this.deleteVideo(found).then(() => reject(-1));
                    } else {
                        resolve(found);
                    }
                } else {
                    reject(-1);
                }
            });
        });
    }

    deleteVideo(video) {
        return new Promise(resolve => {
            chrome.storage.local.get("ytProVideos", data => {
                const videos = (data.ytProVideos || []).filter(v =>
                    this.extractWatchID(v.videolink) !== this.extractWatchID(video.videolink)
                );
                chrome.storage.local.set({ ytProVideos: videos }, resolve);
            });
        });
    }

    daysSince(time1) {
        return Math.round((Date.now() - time1) / 86400000);
    }

    monitorVideoTime(resolve) {
        const video = document.querySelector("video");
        if (!video) return resolve();

        // Cancel any previous timeupdate listener to prevent stacking duplicates
        if (resumeTimeUpdateAbort) resumeTimeUpdateAbort.abort();
        resumeTimeUpdateAbort = new AbortController();
        const signal = resumeTimeUpdateAbort.signal;

        // ── Capture the video ID NOW so the listener can self-validate ──────
        // If YouTube navigates away mid-playback the URL changes before the
        // listener is aborted; this guard stops it saving stale data.
        const guardedVideoId = this.extractWatchID(window.location.href);

        // Support both old and new YouTube title DOM structures
        const getTitleEl = () =>
            document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
            document.querySelector("ytd-watch-metadata h1 yt-formatted-string") ||
            document.querySelector("h1.title.style-scope.ytd-video-primary-info-renderer") ||
            document.querySelector("h1[class*='title']");

        let lastTitle = getTitleEl()?.textContent?.trim() || "";

        video.addEventListener('timeupdate', () => {
            // ── Guard: bail out if the page has already moved to a new video ──
            if (this.extractWatchID(window.location.href) !== guardedVideoId) return;

            // Small grace period: skip the very first instant (avoids saving 0.0s)
            if (video.currentTime < 3) return;

            const currentTitle = getTitleEl()?.textContent?.trim() || "";

            if (currentTitle && currentTitle !== lastTitle) {
                lastTitle = currentTitle;
                this.dispatchTitleChangeEvent(currentTitle);
            }

            if (!resumeBlacklist) {
                // ── Smart complete detection ──────────────────────────────────
                // Default markPlayedTime (120s) is too aggressive for short music videos
                // (a 3:41 song would be "complete" after watching past 1:41).
                // Use 10% of video duration as the minimum threshold so short videos
                // only count as complete when within the last ~20 seconds.
                const completionWindow = Math.min(
                    resumeUserSettings.markPlayedTime || 10,
                    video.duration * 0.10
                );
                const markPlayed = (video.duration - video.currentTime) < completionWindow;

                const videoId = guardedVideoId;

                // ── Per-navigation watch-count increment ──────────────────────
                // Reset tracking whenever we're looking at a different video ID
                // (handles title-change re-calls of monitorVideoTime for same video).
                if (videoId !== currentNavVideoId) {
                    currentNavVideoId     = videoId;
                    currentNavIncremented = false;
                }

                const pastMinWatch    = video.currentTime >= (resumeUserSettings.minWatchTime || 60);
                const shouldIncrement = pastMinWatch && !currentNavIncremented;
                if (shouldIncrement) currentNavIncremented = true;

                this.setTime({
                    videolink:   window.location.href,
                    time:        video.currentTime,
                    duration:    video.duration,
                    title:       currentTitle || document.title,
                    channel:     document.querySelector(RESUME_CHANNEL_SELECTOR)?.textContent?.trim() || "",
                    complete:    markPlayed,
                    doNotResume: false,
                    timestamp:   Date.now()
                }, shouldIncrement);
            }
        }, { signal });
    }
}

// ─── Initialise everything ────────────────────────────────────────────────────
// ─── Masthead Glass Guard ─────────────────────────────────────────────────────
// YouTube sets the masthead background via requestAnimationFrame on every scroll
// tick, so MutationObserver alone always loses the last-frame race.
// We fight back with our OWN rAF loop running at the same cadence — every frame
// we force the exact glass styles, so the browser never paints the black state.
let _mastheadRAFId   = null;
let _mastheadActive  = false;

const GLASS_SF     = '#00000022';
const GLASS_BLUR   = '10px';
const GLASS_SHADOW = '0 4px 24px #00000030, 2px 2px 1px #ffffff20 inset, -2px -2px 1px #ffffff10 inset';

function _enforceGlass() {
    // ── ALL CSS variables YouTube uses for masthead background ──────────────
    // YouTube has added new variables on the watch page — cover every known one.
    const VARS = [
        '--yt-masthead-background-color',
        '--ytd-masthead-color',
        '--yt-masthead-custom-background-color',
        '--ytd-masthead-background',
        '--yt-spec-base-background',
        '--yt-masthead-scrolled-background-color',
    ];

    // ── Clear variables on EVERY ancestor YouTube might target ───────────────
    // On the watch page YouTube now also sets vars on ytd-watch-flexy, body, html
    [
        document.documentElement,
        document.body,
        document.querySelector('ytd-app'),
        document.querySelector('ytd-watch-flexy'),
        document.querySelector('ytd-page-manager'),
    ].forEach(el => {
        if (!el) return;
        VARS.forEach(v => el.style.setProperty(v, 'transparent', 'important'));
    });

    // ── Enforce on the masthead elements directly ────────────────────────────
    const outer     = document.getElementById('masthead-container');
    const mast      = document.querySelector('ytd-masthead');
    // Exact inner Polymer element YouTube targets on the watch page
    // (found via uBlock Origin: #masthead > .ytd-masthead.style-scope)
    const mastInner = document.querySelector('#masthead > .ytd-masthead.style-scope')
                   || document.querySelector('#masthead > ytd-masthead');
    const pill      = document.querySelector('ytd-masthead #container');

    if (outer) {
        outer.style.setProperty('background',       'transparent', 'important');
        outer.style.setProperty('background-color', 'transparent', 'important');
        outer.style.setProperty('box-shadow',       'none',        'important');
        VARS.forEach(v => outer.style.setProperty(v, 'transparent', 'important'));
    }
    if (mast) {
        mast.style.setProperty('background',       'transparent', 'important');
        mast.style.setProperty('background-color', 'transparent', 'important');
        mast.style.setProperty('box-shadow',       'none',        'important');
        VARS.forEach(v => mast.style.setProperty(v, 'transparent', 'important'));
    }
    // Force the inner Polymer-scoped element — this is where YouTube writes
    // the solid background on the watch page, overriding everything else
    if (mastInner) {
        mastInner.style.setProperty('background',       'transparent', 'important');
        mastInner.style.setProperty('background-color', 'transparent', 'important');
        mastInner.style.setProperty('box-shadow',       'none',        'important');
        VARS.forEach(v => mastInner.style.setProperty(v, 'transparent', 'important'));
    }
    if (pill) {
        pill.style.setProperty('background',              GLASS_SF,              'important');
        pill.style.setProperty('background-color',        GLASS_SF,              'important');
        pill.style.setProperty('backdrop-filter',         `blur(${GLASS_BLUR})`, 'important');
        pill.style.setProperty('-webkit-backdrop-filter', `blur(${GLASS_BLUR})`, 'important');
        pill.style.setProperty('border-radius',           '3000px',              'important');
        pill.style.setProperty('box-shadow',              GLASS_SHADOW,          'important');
        pill.style.setProperty('border',                  'none',                'important');
        pill.style.setProperty('margin',                  '1px',                 'important');
        VARS.forEach(v => pill.style.setProperty(v, 'transparent', 'important'));
    }

    if (_mastheadActive) _mastheadRAFId = requestAnimationFrame(_enforceGlass);
}

// ── Inject a hard CSS fallback so even non-JS-set backgrounds are overridden ─
// This catches cases where YouTube sets background via a stylesheet rule rather
// than inline JS, which the rAF loop alone cannot override.
function _injectMastheadCSS() {
    const id = 'yt-pro-masthead-override';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
        #masthead-container,
        ytd-masthead,
        #masthead-container.ytd-app,
        ytd-masthead.ytd-app,
        #masthead > .ytd-masthead.style-scope,
        #masthead > ytd-masthead {
            background: transparent !important;
            background-color: transparent !important;
            box-shadow: none !important;
            --yt-masthead-background-color: transparent !important;
            --ytd-masthead-color: transparent !important;
            --yt-masthead-custom-background-color: transparent !important;
            --ytd-masthead-background: transparent !important;
            --yt-masthead-scrolled-background-color: transparent !important;
        }
        ytd-masthead #container {
            background: ${GLASS_SF} !important;
            background-color: ${GLASS_SF} !important;
            backdrop-filter: blur(${GLASS_BLUR}) !important;
            -webkit-backdrop-filter: blur(${GLASS_BLUR}) !important;
            border-radius: 3000px !important;
            box-shadow: ${GLASS_SHADOW} !important;
            border: none !important;
        }
    `;
    document.head.appendChild(style);
}

function initMastheadGuard() {
    if (_mastheadActive) return;
    _mastheadActive = true;
    _injectMastheadCSS();
    _mastheadRAFId  = requestAnimationFrame(_enforceGlass);
}

function destroyMastheadGuard() {
    _mastheadActive = false;
    if (_mastheadRAFId) { cancelAnimationFrame(_mastheadRAFId); _mastheadRAFId = null; }
    document.getElementById('yt-pro-masthead-override')?.remove();
    const props = [
        'background','background-color','backdrop-filter','-webkit-backdrop-filter',
        'border-radius','box-shadow','border','margin',
        '--ytd-masthead-color','--yt-masthead-background-color',
        '--yt-masthead-custom-background-color','--ytd-masthead-background',
        '--yt-spec-base-background','--yt-masthead-scrolled-background-color',
    ];
    [
        document.documentElement, document.body,
        document.querySelector('ytd-app'),
        document.querySelector('ytd-watch-flexy'),
        document.querySelector('ytd-page-manager'),
        document.getElementById('masthead-container'),
        document.querySelector('ytd-masthead'),
        document.querySelector('ytd-masthead #container'),
    ].forEach(el => { if (el) props.forEach(p => el.style.removeProperty(p)); });
}

// ─── Cinematic Mode — preset value maps ──────────────────────────────────────
const CINE_PRESETS = {
    blur: { low: '50px',  med: '90px',  high: '130px' },
    sat:  { low: '120%',  med: '160%',  high: '210%'  },
    dim:  { low: '0.35',  med: '0.55',  high: '0.78'  },
};
function buildCineFilter(s) {
    const blur = CINE_PRESETS.blur[(s && s.blur) || 'med'];
    const sat  = CINE_PRESETS.sat [(s && s.sat)  || 'med'];
    return `blur(${blur}) saturate(${sat}) brightness(0.95)`;
}
function getCineDim(s) {
    return CINE_PRESETS.dim[(s && s.dim) || 'med'];
}

// ─── Cinematic Mode — ultra-efficient GPU-composited background glow ───────────
//
// Full rendering pipeline (zero CPU pixel work, zero decoder contention):
//
//  1. requestVideoFrameCallback (rVFC) — fires once per decoded video frame,
//     IN SYNC with the video's own presentation. No rAF cadence mismatch,
//     no main/decoder-thread synchronization pressure on any browser.
//     Chrome 83+, Firefox 132+. Falls back to setInterval at 20fps.
//
//  2. createImageBitmap(video, {resizeWidth, resizeHeight, resizeQuality:'low'})
//     — GPU-accelerated snapshot + downscale in a single async call. The resize
//     happens on the GPU at capture time, so the ImageBitmap we receive is
//     already the target size. CPU never touches a pixel.
//
//  3. ImageBitmapRenderingContext.transferFromImageBitmap(bmp)
//     — ZERO-COPY canvas update: transfers ownership of the GPU-side bitmap
//     to the canvas backing store by swapping a pointer. No memcpy, no
//     drawImage overhead, no pixel format conversion. The canvas texture is
//     updated entirely on the GPU side. Chrome 66+, Firefox 65+.
//
//  4. CSS filter (blur/saturate/brightness) on the canvas element
//     — Applied by the GPU compositor, never involves JS or CPU.
//     The canvas lives on its own compositor layer (will-change: transform).
//
//  5. Throttle to 20fps max — the ambient glow is blurred 50-130px. At that
//     radius, frame rate above 15fps is visually imperceptible. Throttling
//     cuts GPU texture upload work by 3x on 60fps content.
//
//  6. Skip when paused, tab hidden, video stalled, or a bitmap is already
//     in-flight — zero wasted GPU work in every idle/background state.
//
//  7. 64x36 internal canvas — 1/4 the GPU texture memory of the previous 128x72.
//     At blur(90px) there is literally zero visible difference.
//
// Net result: video decoder, JS main thread, and GPU compositor operate
// completely independently with no synchronization stalls anywhere.
(function () {
    let canvas      = null;
    let ctx         = null;   // ImageBitmapRenderingContext — zero-copy path
    let raf         = null;
    let retryTimer  = null;
    let lastUrl     = location.href;
    let cineSettings = { blur: 'med', sat: 'med', dim: 'med' };

    // 64x36 — 1/4 the GPU cost of 128x72, visually identical at any blur preset.
    const DRAW_W = 64;
    const DRAW_H = 36;

    // Glow update cap: 20fps. Imperceptible on a 50-130px blurred canvas.
    // At 60fps content this cuts GPU bitmap uploads from 60/s down to 20/s.
    const FRAME_MS = 50;

    let lastDrawTime  = 0;
    let lastVideoTime = -1; // stall detection — skip if currentTime hasn't moved
    let drawPending   = false; // guard against overlapping createImageBitmap calls

    function isWatchPage() { return location.pathname === '/watch'; }

    // Hide the canvas immediately on navigation / source change.
    // With bitmaprenderer we don't need to clearRect — just fade out.
    function clearCanvas() {
        if (!canvas) return;
        canvas.style.transition = 'opacity 0.3s ease';
        canvas.style.opacity    = '0';
        lastVideoTime = -1;
    }

    function attach() {
        if (canvas) return;
        const video = document.querySelector('video.html5-main-video');
        if (!video) { retryTimer = setTimeout(attach, 600); return; }
        if (!isCtxValid()) return;
        chrome.storage.local.get('cinematicSettings', (r) => {
            cineSettings = r.cinematicSettings || { blur: 'med', sat: 'med', dim: 'med' };
            _doAttach(video);
        });
    }

    function _doAttach(video) {
        if (canvas) return; // guard against double-call

        // Tiny canvas — CSS scales it to 100vw x 100vh
        canvas = document.createElement('canvas');
        canvas.id     = 'yt-pro-cinematic-canvas';
        canvas.width  = DRAW_W;
        canvas.height = DRAW_H;
        Object.assign(canvas.style, {
            position:        'fixed',
            top:             '0',
            left:            '0',
            width:           '100vw',
            height:          '100vh',
            zIndex:          '0',
            pointerEvents:   'none',
            filter:          buildCineFilter(cineSettings),
            opacity:         '0',             // fades in on first 'playing' event
            transform:       'scale(1.08)',
            transformOrigin: 'center center',
            // Own compositor layer — canvas repaints never trigger page repaints.
            // Prevents opacity animations from forcing layer promotions later.
            willChange:      'transform, opacity',
        });

        document.body.insertBefore(canvas, document.body.firstChild);

        // ImageBitmapRenderingContext: transferFromImageBitmap() swaps the
        // canvas backing texture by pointer — zero pixel copy, zero CPU work.
        ctx = canvas.getContext('bitmaprenderer');

        // Fade in once the video starts playing
        function onPlaying() {
            if (!canvas) return;
            canvas.style.transition = 'opacity 0.6s ease';
            canvas.style.opacity    = getCineDim(cineSettings);
        }
        video.addEventListener('playing', onPlaying);
        canvas._onPlaying = () => { video.removeEventListener('playing', onPlaying); };

        // Race-condition guard: if the video started playing fast (cached,
        // short clip, preloaded) it may have already fired 'playing' BEFORE
        // this listener was attached (attach() is delayed ~600ms to let
        // YouTube swap the video element on SPA navigation). In that case
        // the canvas would stay stuck at opacity 0 forever, only recovering
        // if the user manually paused/played the video again. Catch that
        // "already playing" state immediately instead of waiting on a future
        // event that isn't coming.
        if (!video.paused && !video.ended && video.readyState >= 2) {
            onPlaying();
        }

        // Wipe canvas instantly when YouTube swaps the video source
        function onSourceChange() { clearCanvas(); }
        video.addEventListener('emptied',   onSourceChange);
        video.addEventListener('loadstart', onSourceChange);
        canvas._removeSourceListeners = () => {
            video.removeEventListener('emptied',   onSourceChange);
            video.removeEventListener('loadstart', onSourceChange);
        };

        // Core draw function
        function drawFrame(now) {
            if (!canvas || !document.body.classList.contains('yt-pro-cinematic')) return;
            if (!isWatchPage()) return;

            // Skip when tab is hidden — no visual benefit, pure waste
            if (document.hidden) return;

            // Skip when video is paused — glow doesn't need updating
            if (video.paused) return;

            // Skip if video hasn't buffered enough to have a renderable frame
            if (video.readyState < 2) return;

            // Throttle: cap glow updates at 20fps regardless of video frame rate
            if (now - lastDrawTime < FRAME_MS) return;

            // Skip if the video is stalled (currentTime not advancing)
            // Prevents hammering the GPU during buffering events
            const vt = video.currentTime;
            if (vt === lastVideoTime) return;
            lastVideoTime = vt;

            // Guard: don't start a new capture while the previous one is still
            // in-flight. Protects against slow GPU or throttled tabs.
            if (drawPending) return;
            drawPending   = true;
            lastDrawTime  = now;

            // createImageBitmap with resize options:
            //   - The browser/GPU performs the downscale during capture,
            //     so the returned ImageBitmap is already DRAW_W x DRAW_H.
            //   - resizeQuality:'low' = nearest-neighbor, fastest possible,
            //     quality is irrelevant at 50-130px CSS blur.
            //   - The Promise resolves off the critical path — video decoder
            //     and main thread are both free the moment this fires.
            createImageBitmap(video, {
                resizeWidth:   DRAW_W,
                resizeHeight:  DRAW_H,
                resizeQuality: 'low',
            }).then(bmp => {
                drawPending = false;
                if (!ctx || !canvas) { bmp.close(); return; }
                // transferFromImageBitmap: GPU pointer swap — the fastest
                // possible canvas update. After this call bmp is neutered
                // (ownership transferred), so we must NOT call bmp.close().
                ctx.transferFromImageBitmap(bmp);
            }).catch(() => {
                // createImageBitmap can fail if the video is in a tainted/
                // cross-origin state. Silently skip this frame.
                drawPending = false;
            });
        }

        // Draw scheduling: rVFC > setInterval fallback
        if (typeof video.requestVideoFrameCallback === 'function') {
            // rVFC fires once per decoded frame, in sync with the video's own
            // presentation pipeline. No rAF mismatch, no decoder contention.
            // Chrome 83+, Firefox 132+.
            function onVideoFrame(now) {
                if (!canvas || !document.body.classList.contains('yt-pro-cinematic')) return;
                drawFrame(now);
                raf = video.requestVideoFrameCallback(onVideoFrame);
            }
            raf = video.requestVideoFrameCallback(onVideoFrame);
            canvas._cancelDraw = () => {
                if (raf != null) { video.cancelVideoFrameCallback(raf); raf = null; }
            };
        } else {
            // Fallback for Firefox < 132: setInterval at 20fps.
            // Does not trigger main/decoder thread synchronization the way rAF
            // does, so it avoids stutter on older Firefox.
            raf = setInterval(() => drawFrame(performance.now()), FRAME_MS);
            canvas._cancelDraw = () => {
                if (raf != null) { clearInterval(raf); raf = null; }
            };
        }
    }

    function stop() {
        drawPending  = false;
        lastDrawTime = 0;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (canvas) {
            if (canvas._cancelDraw)            canvas._cancelDraw();
            if (canvas._onPlaying)             canvas._onPlaying();
            if (canvas._removeSourceListeners) canvas._removeSourceListeners();
            canvas.remove();
            canvas = null;
            ctx    = null;
            raf    = null;
        }
    }

    // Primary nav signal: yt-navigate-finish
    document.addEventListener('yt-navigate-finish', () => {
        lastUrl = location.href;
        if (!document.body.classList.contains('yt-pro-cinematic')) return;
        clearCanvas();
        stop();
        if (isWatchPage()) retryTimer = setTimeout(attach, 600);
    });

    // Fallback URL poll (handles cases where yt-navigate-finish misfires)
    setInterval(() => {
        const currentUrl = location.href;
        if (currentUrl === lastUrl) return;
        lastUrl = currentUrl;
        if (!document.body.classList.contains('yt-pro-cinematic')) return;
        clearCanvas();
        stop();
        if (isWatchPage()) retryTimer = setTimeout(attach, 600);
    }, 300);

    // Re-attach if YouTube's SPA removes our canvas from the DOM
    const navObserver = new MutationObserver(() => {
        if (!document.body.classList.contains('yt-pro-cinematic')) return;
        if (!document.getElementById('yt-pro-cinematic-canvas') && isWatchPage() && !retryTimer && !canvas) {
            retryTimer = setTimeout(attach, 300);
        }
    });
    navObserver.observe(document.body, { childList: true, subtree: false });

    // Pause drawing when tab goes into background, resume on return
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            // Reset stall detection so the first visible frame is drawn immediately
            lastVideoTime = -1;
            lastDrawTime  = 0;
        }
    });

    // Expose so the message listener can call start/stop/applySettings
    window._ytProCinematic = {
        attach,
        stop,
        applySettings(s) {
            cineSettings = s;
            if (!canvas) return;
            canvas.style.filter = buildCineFilter(s);
            if (parseFloat(canvas.style.opacity) > 0) {
                canvas.style.opacity = getCineDim(s);
            }
        }
    };
})();

// ─── Player Screenshot Feature ───────────────────────────────────────────────
// Captures ONLY the actual video frame — native resolution, no player chrome,
// no controls, no overlays — by drawing the <video> element onto an offscreen
// canvas. This is what makes it crop to "just the video" automatically: the
// canvas only ever contains decoded video pixels, never surrounding DOM.
let screenshotFeatureActive = false;
let screenshotPollInterval  = null;
let screenshotKeyHandler    = null;

function getActiveVideoForScreenshot() {
    if (window.location.pathname.includes('/shorts/')) {
        const shortsVideo = getShortsActiveVideo();
        if (shortsVideo) return shortsVideo;
    }
    return document.querySelector('.html5-video-player video.html5-main-video') ||
           document.querySelector('video.html5-main-video') ||
           document.querySelector('video');
}

function ytProShotToast(message, isError) {
    document.getElementById('yt-pro-shot-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'yt-pro-shot-toast';
    toast.textContent = message;
    toast.style.cssText = [
        'position:fixed', 'bottom:28px', 'left:50%',
        'transform:translateX(-50%) translateY(10px)',
        'background:rgba(20,20,20,0.85)',
        'color:' + (isError ? '#ff6b6b' : '#00d2ff'),
        'padding:10px 18px', 'border-radius:999px',
        'font:600 13px/1.2 "SF Pro Text",Roboto,Arial,sans-serif',
        'letter-spacing:.2px', 'z-index:2147483647',
        'backdrop-filter:blur(14px)', '-webkit-backdrop-filter:blur(14px)',
        'border:1px solid rgba(255,255,255,0.14)',
        'box-shadow:0 8px 28px rgba(0,0,0,0.45)',
        'opacity:0', 'pointer-events:none',
        'transition:opacity .25s ease, transform .25s ease'
    ].join(';');
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity   = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(() => {
        toast.style.opacity   = '0';
        toast.style.transform = 'translateX(-50%) translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 1800);
}

// Quick white flash over the EXACT video element's rect — both a "shutter"
// confirmation and a visual proof that only that rect is being captured.
function ytProShotFlash(video) {
    const rect = video.getBoundingClientRect();
    const flash = document.createElement('div');
    flash.style.cssText = [
        'position:fixed',
        `top:${rect.top}px`, `left:${rect.left}px`,
        `width:${rect.width}px`, `height:${rect.height}px`,
        'background:#fff', 'opacity:0.85', 'pointer-events:none',
        'z-index:2147483647', 'transition:opacity 0.35s ease'
    ].join(';');
    document.body.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 400);
}

function ytProShotFilename(video) {
    const titleEl = document.querySelector(
        'h1.ytd-watch-metadata yt-formatted-string, h1.title.style-scope.ytd-video-primary-info-renderer'
    );
    let title = (titleEl?.textContent || document.title || 'youtube-video').trim();
    title = title.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 60) || 'youtube-video';

    const t = Math.max(0, Math.floor(video.currentTime || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const pad = n => String(n).padStart(2, '0');
    const stamp = h > 0 ? `${h}-${pad(m)}-${pad(s)}` : `${pad(m)}-${pad(s)}`;

    return `${title}_${stamp}.png`;
}

function ytProCaptureFrame(video) {
    if (!video || video.readyState < 2) {
        ytProShotToast('Video frame not ready yet', true);
        return;
    }
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) {
        ytProShotToast('Could not read video frame', true);
        return;
    }

    ytProShotFlash(video);

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    try {
        ctx.drawImage(video, 0, 0, w, h);
    } catch (e) {
        // Tainted canvas — shouldn't happen on YouTube's own player, guard anyway
        ytProShotToast('Screenshot blocked for this video', true);
        return;
    }

    canvas.toBlob((blob) => {
        if (!blob) { ytProShotToast('Screenshot failed', true); return; }
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = ytProShotFilename(video);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        ytProShotToast('Screenshot saved');
    }, 'image/png');
}

function ytProTakeScreenshot() {
    const video = getActiveVideoForScreenshot();
    if (!video) {
        ytProShotToast('No video found', true);
        return;
    }

    const wasPlaying = !video.paused && !video.ended;
    if (wasPlaying) video.pause();

    // drawImage() inside ytProCaptureFrame() is synchronous, so the frame is
    // already locked into the canvas by the time we get here — safe to resume.
    ytProCaptureFrame(video);

    if (wasPlaying) {
        video.play().catch(() => {}); // .catch silences rare autoplay-policy errors
    }
}

function createScreenshotButton() {
    const button = document.createElement('button');
    button.classList.add('ytp-button', 'yt-pro-screenshot-btn');
    button.id    = 'yt-pro-screenshot-btn';
    button.title = 'Screenshot video frame (Alt+Shift+S)';
    button.setAttribute('aria-label', 'Screenshot video frame');
    button.style.cssText = 'background:transparent;border:0;outline:none;cursor:pointer;padding:0;vertical-align:top;';
    button.innerHTML =
        '<svg viewBox="0 0 24 24" width="24" height="24" style="display:block;margin:auto;" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M9 4 L7.5 6 H5 a2 2 0 0 0 -2 2 v9 a2 2 0 0 0 2 2 h14 a2 2 0 0 0 2 -2 V8 a2 2 0 0 0 -2 -2 h-2.5 L15 4 Z" fill="#fff"/>' +
        '<circle cx="12" cy="13" r="3.4" fill="#0f0f0f"/>' +
        '<circle cx="12" cy="13" r="2.2" fill="#fff"/>' +
        '</svg>';
    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ytProTakeScreenshot();
    });
    return button;
}

function injectScreenshotButton() {
    if (document.getElementById('yt-pro-screenshot-btn')) return;
    const rightControls = document.querySelector('div.ytp-right-controls');
    if (!rightControls) return;

    const button    = createScreenshotButton();
    const resumeBtn = document.getElementById('yt-pro-resume-switch');
    if (resumeBtn && resumeBtn.parentElement === rightControls) {
        resumeBtn.insertAdjacentElement('afterend', button);
    } else {
        rightControls.prepend(button);
    }
}

function initScreenshotFeature() {
    if (screenshotFeatureActive) return;
    screenshotFeatureActive = true;

    injectScreenshotButton();

    if (!screenshotPollInterval) {
        // Re-inject if YouTube's SPA rebuilds the player controls on navigation
        screenshotPollInterval = setInterval(() => {
            if (screenshotFeatureActive) injectScreenshotButton();
        }, 1000);
    }

    if (!screenshotKeyHandler) {
        screenshotKeyHandler = (e) => {
            if (!e.altKey || !e.shiftKey || e.key.toLowerCase() !== 's') return;
            const active     = document.activeElement;
            const tag        = (active?.tagName || '').toLowerCase();
            const isEditable = active?.isContentEditable || tag === 'input' || tag === 'textarea';
            if (isEditable) return; // don't hijack the shortcut while user is typing

            e.preventDefault();
            e.stopPropagation();
            ytProTakeScreenshot();
        };
        document.addEventListener('keydown', screenshotKeyHandler, true);
    }
}

function removeScreenshotFeature() {
    screenshotFeatureActive = false;
    if (screenshotPollInterval) { clearInterval(screenshotPollInterval); screenshotPollInterval = null; }
    if (screenshotKeyHandler)   { document.removeEventListener('keydown', screenshotKeyHandler, true); screenshotKeyHandler = null; }
    document.getElementById('yt-pro-screenshot-btn')?.remove();
}


// ─── Auto Mini Player ─────────────────────────────────────────────────────────
// Shrinks the YouTube player into a small draggable floating window whenever
// the player scrolls out of view, and restores it to normal size when it
// scrolls back into view. Adapted from "YouTube Mini Player" userscript by
// AkiyaKiko (https://github.com/AkiyaKiko/YouTubeMiniPlayer), integrated to
// respect this extension's master/feature toggle system.
let miniPlayerFeatureActive = false;

const ytProMP = {
    className: 'yt-pro-mini-player-active',
    playerElement: null,
    outerContainer: null,
    innerContainer: null,
    videoElement: null,
    ivVideoContent: null,
    bottomChrome: null,

    originalOuterStyle: null,
    originalInnerStyle: null,
    originalVideoStyle: null,
    originalIvStyle: null,

    intersectionObserver: null,
    setupObserver: null,
    resizeHandler: null,

    isActive: false,
    initializedUrl: null,
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,

    isFullscreen() {
        return !!document.fullscreenElement;
    },

    // Audio-only "song" tracks render on a static album-art background
    // instead of a real video frame, so outerContainer/video offsetHeight
    // can come back as 0 (or otherwise not reflect a real 16:9 frame).
    // That turns aspectRatio into Infinity/NaN and collapses the mini
    // player to zero height. Fall back to the video's own intrinsic
    // dimensions, then to standard 16:9, whenever the measured ratio
    // isn't a sane finite number.
    getSafeAspectRatio() {
        const w = this.outerContainer?.offsetWidth;
        const h = this.outerContainer?.offsetHeight;
        let ratio = w && h ? w / h : NaN;

        if (!isFinite(ratio) || ratio <= 0) {
            const vw = this.videoElement?.videoWidth;
            const vh = this.videoElement?.videoHeight;
            ratio = vw && vh ? vw / vh : NaN;
        }

        if (!isFinite(ratio) || ratio <= 0) ratio = 16 / 9;
        return ratio;
    },

    isAudioOnlyTrack() {
        // Audio-only "song" tracks never get real decoded video frames,
        // so videoWidth/videoHeight stay 0 once metadata has loaded.
        // The miniplayer's background-art scaling is unreliable for these
        // (YouTube's own song-mode DOM/CSS shifts around), so we simply
        // don't float it for audio-only playback rather than show a
        // broken/cropped miniplayer.
        const v = this.videoElement;
        return !!v && v.readyState >= 1 && v.videoWidth === 0 && v.videoHeight === 0;
    },

    minimize() {
        if (!this.outerContainer || this.isActive || this.isFullscreen()) return;
        if (this.isAudioOnlyTrack()) return;

        this.originalOuterStyle = this.outerContainer.getAttribute('style');
        this.originalInnerStyle = this.innerContainer?.getAttribute('style');
        this.originalVideoStyle = this.videoElement?.getAttribute('style');
        this.originalIvStyle    = this.ivVideoContent?.getAttribute('style');

        const storedPlayerHeight = this.playerElement.offsetHeight;
        this.originalPlayerWidth = this.playerElement.style.width;
        this.originalPlayerBg    = this.playerElement.style.backgroundSize + '|' + this.playerElement.style.backgroundPosition;
        this.playerElement.style.height = `${storedPlayerHeight}px`;

        const floatingWidth  = window.innerWidth / 5;
        const aspectRatio    = this.getSafeAspectRatio();
        const floatingHeight = floatingWidth / aspectRatio;
        const rightOffset    = window.innerWidth * 0.03;
        const bottomOffset   = window.innerHeight * 0.02;

        Object.assign(this.outerContainer.style, {
            position: 'fixed',
            bottom: `${bottomOffset}px`,
            right: `${rightOffset}px`,
            left: 'auto',
            top: 'auto',
            width: `${floatingWidth}px`,
            height: `${floatingHeight}px`,
            zIndex: '3000',
            boxShadow: '2px 2px 5px rgba(0, 0, 0, 0.3)',
            minWidth: '0px',
        });
        this.outerContainer.classList.add(this.className);
        this.isActive = true;

        if (this.innerContainer) {
            this.innerContainer.style.width = `${floatingWidth}px`;
            this.innerContainer.style.height = `${floatingHeight}px`;
            this.innerContainer.style.paddingTop = '0px';
        }
        if (this.bottomChrome) this.bottomChrome.style.display = 'none';
        if (this.videoElement) {
            this.videoElement.style.width = `${floatingWidth}px`;
            this.videoElement.style.height = `${floatingHeight}px`;
        }
        if (this.ivVideoContent) {
            this.ivVideoContent.style.width = `${floatingWidth}px`;
            this.ivVideoContent.style.height = `${floatingHeight}px`;
        }

        // Audio-only "song" tracks paint their album art as a CSS
        // background-image directly on #movie_player (behind the blank
        // video element), sized for the full player. Without forcing
        // cover/center here, shrinking the container just crops a tiny
        // corner of that background instead of scaling the art down.
        this.playerElement.style.width = `${floatingWidth}px`;
        this.playerElement.style.backgroundSize = 'cover';
        this.playerElement.style.backgroundPosition = 'center';

        this.enableDragging();
    },

    restore() {
        if (!this.outerContainer || !this.isActive || this.isFullscreen()) return;

        this.outerContainer.setAttribute('style', this.originalOuterStyle || '');
        this.outerContainer.classList.remove(this.className);
        this.isActive = false;

        if (this.playerElement) {
            this.playerElement.style.height = '';
            this.playerElement.style.width  = this.originalPlayerWidth || '';
            const [bgSize, bgPos] = (this.originalPlayerBg || '|').split('|');
            this.playerElement.style.backgroundSize = bgSize || '';
            this.playerElement.style.backgroundPosition = bgPos || '';
        }
        if (this.innerContainer) this.innerContainer.setAttribute('style', this.originalInnerStyle || '');
        if (this.bottomChrome) this.bottomChrome.style.display = '';
        if (this.videoElement) this.videoElement.setAttribute('style', this.originalVideoStyle || '');
        if (this.ivVideoContent) this.ivVideoContent.setAttribute('style', this.originalIvStyle || '');

        this.disableDragging();

        // YouTube's own player only recalculates the control/progress bar
        // width in response to an actual resize event. Since we resize the
        // player via direct inline styles (no browser resize event fires),
        // .ytp-chrome-bottom can stay stuck at the floating-miniplayer width
        // even after we've restored the container to full size. Nudge it.
        requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
            this.playerElement?.dispatchEvent(new Event('resize'));
        });
    },

    enableDragging() {
        if (!this.outerContainer) return;
        this._onMouseDown = this._onMouseDown || this.onMouseDown.bind(this);
        this.outerContainer.addEventListener('mousedown', this._onMouseDown);
    },

    disableDragging() {
        if (!this.outerContainer || !this._onMouseDown) return;
        this.outerContainer.removeEventListener('mousedown', this._onMouseDown);
    },

    onMouseDown(e) {
        if (!this.isActive) return;
        this.isDragging = true;
        const rect = this.outerContainer.getBoundingClientRect();
        this.dragOffsetX = e.clientX - rect.left;
        this.dragOffsetY = e.clientY - rect.top;
        this._onMouseMove = this._onMouseMove || this.onMouseMove.bind(this);
        this._onMouseUp   = this._onMouseUp   || this.onMouseUp.bind(this);
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
        e.preventDefault();
    },

    onMouseMove(e) {
        if (!this.isDragging) return;
        this.outerContainer.style.left   = `${e.clientX - this.dragOffsetX}px`;
        this.outerContainer.style.top    = `${e.clientY - this.dragOffsetY}px`;
        this.outerContainer.style.right  = 'auto';
        this.outerContainer.style.bottom = 'auto';
    },

    onMouseUp() {
        this.isDragging = false;
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
    },

    observeVisibility() {
        if (!this.playerElement) return;
        if (this.intersectionObserver) this.intersectionObserver.disconnect();

        this.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                const rect = entry.boundingClientRect;
                if (rect.bottom < 0) {
                    if (!this.isFullscreen()) this.minimize();
                } else {
                    this.restore();
                }
            });
        }, { threshold: 0 });

        this.intersectionObserver.observe(this.playerElement);
    },

    handleResize() {
        if (!this.outerContainer || !this.outerContainer.classList.contains(this.className)) return;

        const floatingWidth  = window.innerWidth / 5;
        const aspectRatio    = this.getSafeAspectRatio();
        const floatingHeight = floatingWidth / aspectRatio;
        const rightOffset    = window.innerWidth * 0.03;
        const bottomOffset   = window.innerHeight * 0.02;

        Object.assign(this.outerContainer.style, {
            width: `${floatingWidth}px`,
            height: `${floatingHeight}px`,
            right: `${rightOffset}px`,
            bottom: `${bottomOffset}px`,
            left: 'auto',
            top: 'auto',
        });

        if (this.innerContainer) {
            this.innerContainer.style.width = `${floatingWidth}px`;
            this.innerContainer.style.height = `${floatingHeight}px`;
        }
        if (this.videoElement) {
            this.videoElement.style.width = `${floatingWidth}px`;
            this.videoElement.style.height = `${floatingHeight}px`;
        }
        if (this.ivVideoContent) {
            this.ivVideoContent.style.width = `${floatingWidth}px`;
            this.ivVideoContent.style.height = `${floatingHeight}px`;
        }
        if (this.playerElement) {
            this.playerElement.style.width = `${floatingWidth}px`;
        }
    },

    waitForElements() {
        if (this.setupObserver) return;
        this.setupObserver = new MutationObserver((mutations, obs) => {
            if (!miniPlayerFeatureActive) { obs.disconnect(); this.setupObserver = null; return; }
            if (document.getElementById('player') &&
                document.getElementById('player-container-outer') &&
                document.getElementById('player-container-inner') &&
                document.querySelector('video.video-stream.html5-main-video') &&
                document.getElementById('contents')) {
                obs.disconnect();
                this.setupObserver = null;
                this.setup();
            }
        });
        this.setupObserver.observe(document.body, { childList: true, subtree: true });
    },

    setup() {
        if (!miniPlayerFeatureActive) return;

        this.playerElement   = document.getElementById('player');
        this.outerContainer  = document.getElementById('player-container-outer');
        this.innerContainer  = document.getElementById('player-container-inner');
        this.videoElement    = document.querySelector('video.video-stream.html5-main-video');
        this.ivVideoContent  = document.querySelector('.ytp-iv-video-content');
        this.bottomChrome    = document.querySelector('.ytp-chrome-bottom');

        if (this.playerElement && this.outerContainer && this.innerContainer && this.videoElement) {
            this.observeVisibility();

            if (!this.resizeHandler) {
                this.resizeHandler = this.handleResize.bind(this);
                window.addEventListener('resize', this.resizeHandler);
            }

            this.isActive = false;
            const rect = this.playerElement.getBoundingClientRect();
            if (rect.bottom < 0) this.minimize(); else this.restore();

            this.initializedUrl = location.href;
        } else {
            this.waitForElements();
        }
    },

    teardown() {
        if (this.intersectionObserver) { this.intersectionObserver.disconnect(); this.intersectionObserver = null; }
        if (this.setupObserver)        { this.setupObserver.disconnect(); this.setupObserver = null; }
        if (this.resizeHandler)        { window.removeEventListener('resize', this.resizeHandler); this.resizeHandler = null; }
        this.restore();

        this.playerElement  = null;
        this.outerContainer = null;
        this.innerContainer = null;
        this.videoElement   = null;
        this.ivVideoContent = null;
        this.bottomChrome   = null;
        this.initializedUrl = null;
        this.isActive       = false;
        this.isDragging     = false;
    },

    checkUrlAndSetup() {
        if (!miniPlayerFeatureActive) return;
        if (location.pathname.startsWith('/watch')) {
            if (location.href !== this.initializedUrl) {
                this.teardown();
                setTimeout(() => { if (miniPlayerFeatureActive) this.setup(); }, 500);
            }
        } else {
            this.teardown();
        }
    },

    urlWatcherInterval: null,
    lastUrl: null,

    startUrlWatcher() {
        if (this.urlWatcherInterval) return;
        this.lastUrl = location.href;
        this.urlWatcherInterval = setInterval(() => {
            if (!miniPlayerFeatureActive) return;
            if (location.href !== this.lastUrl) {
                this.lastUrl = location.href;
                this.checkUrlAndSetup();
            }
        }, 300);
    },

    stopUrlWatcher() {
        if (this.urlWatcherInterval) { clearInterval(this.urlWatcherInterval); this.urlWatcherInterval = null; }
    },
};

function initMiniPlayerFeature() {
    if (miniPlayerFeatureActive) return;
    miniPlayerFeatureActive = true;

    if (!document.getElementById('yt-pro-miniplayer-style')) {
        const style = document.createElement('style');
        style.id = 'yt-pro-miniplayer-style';
        style.textContent = `
            .${ytProMP.className} {
                transition: width 0.3s ease, height 0.3s ease, right 0.3s ease, bottom 0.3s ease, top 0.3s ease, left 0.3s ease;
                cursor: move;
            }
        `;
        document.head.appendChild(style);
    }

    ytProMP.checkUrlAndSetup();
    ytProMP.startUrlWatcher();
}

function removeMiniPlayerFeature() {
    miniPlayerFeatureActive = false;
    ytProMP.stopUrlWatcher();
    ytProMP.teardown();
    document.getElementById('yt-pro-miniplayer-style')?.remove();
}

if (isCtxValid()) chrome.storage.local.get(['masterEnabled', 'theme', 'premium', 'ambient', 'cinematic', 'speed', 'autoscroll', 'download', 'autoResume', 'screenshot', 'miniplayer', 'returnDislike'], (result) => {
    if (result.masterEnabled === false) return;

    if (result.theme    !== false) {
        injectCSS('theme.css');
        initMastheadGuard();
    }
    if (result.premium  !== false) document.body.classList.add('yt-pro-premium');
    if (result.ambient  !== false) {
        document.body.classList.add('yt-pro-ambient');
    }
    if (result.cinematic === true) {
        document.body.classList.add('yt-pro-cinematic');
        setTimeout(() => window._ytProCinematic?.attach(), 800);
    }
    if (result.speed    !== false) injectScript('inject-speed.js');
    if (result.autoscroll !== false) initAutoScroll();
    if (result.download === true) initDownloadIntercept();
    if (result.autoResume !== false) initBadgeInjection();
    if (result.screenshot !== false) initScreenshotFeature();
    if (result.miniplayer !== false) initMiniPlayerFeature();
    if (result.returnDislike !== false) window._ytProReturnDislike?.init();
});

// Auto Resume is initialised inside the class (checks its own toggle)
new YTProAutoResume();

// ─── Message Listener ─────────────────────────────────────────────────────────
if (isCtxValid()) chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'masterToggleChanged') {
        if (!request.state) {
            document.body.classList.remove('yt-pro-premium', 'yt-pro-ambient', 'yt-pro-cinematic');
            window._ytProCinematic?.stop();
            if (autoScrollInterval) clearInterval(autoScrollInterval);
            removeDownloadIntercept();
            removeScreenshotFeature();
            removeMiniPlayerFeature();
            window._ytProReturnDislike?.teardown();
            document.querySelectorAll('link.yt-pro-injected-asset').forEach(el => el.remove());
            destroyMastheadGuard();
            // Remove resume button from player if present
            document.querySelector('#yt-pro-resume-switch')?.remove();
        } else {
            location.reload();
        }
        return;
    }

    if (request.action === 'togglepremium') {
        document.body.classList.toggle('yt-pro-premium', request.state);
    } else if (request.action === 'toggleambient') {
        document.body.classList.toggle('yt-pro-ambient', request.state);
    } else if (request.action === 'togglecinematic') {
        document.body.classList.toggle('yt-pro-cinematic', request.state);
        if (request.state) { window._ytProCinematic?.attach(); } else { window._ytProCinematic?.stop(); }
    } else if (request.action === 'cinematicSettingsChanged') {
        window._ytProCinematic?.applySettings(request.settings);
    } else if (request.action === 'toggledownload') {
        request.state ? initDownloadIntercept() : removeDownloadIntercept();
    } else if (request.action === 'togglescreenshot') {
        request.state ? initScreenshotFeature() : removeScreenshotFeature();
    } else if (request.action === 'toggleminiplayer') {
        request.state ? initMiniPlayerFeature() : removeMiniPlayerFeature();
    } else if (request.action === 'togglereturnDislike') {
        request.state ? window._ytProReturnDislike?.init() : window._ytProReturnDislike?.teardown();
    } else if (request.action === 'toggleautoResume') {
        if (!request.state) {
            document.querySelector('#yt-pro-resume-switch')?.remove();
        } else {
            location.reload();
        }

    // ── Popup open → pause; popup close → resume ─────────────────────────
    // Only pauses if the video is actually playing; only resumes if WE paused it
    // (so user-paused videos are never accidentally restarted).
    } else if (request.action === 'pauseForPopup') {
        const video = document.querySelector('video');
        if (video && !video.paused) {
            video._pausedByPopup = true;
            video.pause();
        }
    } else if (request.action === 'resumeAfterPopup') {
        const video = document.querySelector('video');
        if (video && video._pausedByPopup) {
            video._pausedByPopup = false;
            video.play().catch(() => {});  // .catch so autoplay-policy errors are silent
        }
    }
});
