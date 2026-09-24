// ─── SponsorBlock ────────────────────────────────────────────────────────────
// Built-in integration with the community-run SponsorBlock API
// (https://sponsor.ajay.app) so sponsored segments, intros, outros, and other
// skippable sections are auto-skipped right inside the extension — no need to
// also install the separate SponsorBlock extension.
//
// Exposes window._ytProSponsorBlock with init()/teardown() so it plugs into
// the same on/off toggle system as the other features (return-youtube-dislike.js
// is the template this follows).

(function () {
    if (window._ytProSponsorBlock) return; // already installed
    if (location.hostname === 'music.youtube.com') return;

    const API_BASE = 'https://sponsor.ajay.app/api';

    // Categories enabled by default — the ones almost everyone wants
    // auto-skipped. "filler" and "music_offtopic" are left out by default
    // since they're more subjective / can clip content some viewers want.
    // The user can turn any of these on/off individually from the popup panel.
    const DEFAULT_CATEGORY_STATE = {
        sponsor: true, selfpromo: true, interaction: true,
        intro: true, outro: true, preview: true,
        filler: false, music_offtopic: false,
    };

    let enabledCategories = Object.assign({}, DEFAULT_CATEGORY_STATE);

    function activeCategoryList() {
        return Object.keys(enabledCategories).filter(c => enabledCategories[c]);
    }

    const CATEGORY_LABELS = {
        sponsor: 'Sponsor',
        selfpromo: 'Self-Promotion',
        interaction: 'Interaction Reminder',
        intro: 'Intermission/Intro',
        outro: 'Endcards/Credits',
        preview: 'Preview/Recap',
        filler: 'Filler Tangent',
        music_offtopic: 'Non-Music Section',
        poi_highlight: 'Highlight',
    };

    const CATEGORY_COLORS = {
        sponsor: '#00d400',
        selfpromo: '#ffff00',
        interaction: '#cc3fff',
        intro: '#00ffff',
        outro: '#0202ed',
        preview: '#008fd6',
        filler: '#7300FF',
        music_offtopic: '#ff9900',
        poi_highlight: '#ff1684',
    };

    let active = false;
    let video = null;
    let segments = [];
    let currentVideoId = null;
    let pollTimer = null;
    let toastTimeout = null;
    let lastSkipEndTime = -1;
    let boundTimeUpdate = null;
    let boundLoadedMeta = null;
    let boundSeeked = null;
    let markerTrack = null;
    let controlsObserver = null;
    let playerDomObserver = null;
    let markerRenderRaf = 0;
    let observedBar = null;
    let markerResizeObserver = null;
    let markerHost = null;
    let markerSyncRaf = 0;
    let skipReady = false;
    let skipReadyTimer = null;
    let pendingSkip = null; // { end, category } — set while we wait for a seek to actually land

    function cLog() { /* console.debug('[SponsorBlock]', ...arguments); */ }

    function getVideoId() {
        const urlObject = new URL(window.location.href);
        const pathname = urlObject.pathname;
        if (pathname.startsWith('/shorts')) return pathname.slice(8);
        return urlObject.searchParams.get('v');
    }

    async function fetchSegments(videoId) {
        try {
            const activeCats = activeCategoryList();
            if (!activeCats.length) return [];
            const categories = JSON.stringify(activeCats);
            const url = `${API_BASE}/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${encodeURIComponent(categories)}`;
            // cache: 'no-store' is critical here — without it the browser's HTTP
            // cache happily serves back the *first* response it ever got for this
            // exact URL (often a 404 "no segments yet", from before you submitted
            // one). That's why a freshly-submitted segment shows up immediately
            // but then vanishes if you navigate away and come back to the video:
            // you were being served a stale cached "no segments" response instead
            // of hitting the network again.
            const resp = await fetch(url, { cache: 'no-store' });
            let serverSegments = [];
            if (resp.status === 404) {
                serverSegments = []; // no segments for this video — normal, not an error
            } else if (!resp.ok) {
                serverSegments = [];
            } else {
                const data = await resp.json();
                serverSegments = Array.isArray(data)
                    ? data.filter(s => s.actionType === 'skip' && Array.isArray(s.segment) && s.segment.length === 2)
                    : [];
            }
            return serverSegments;
        } catch (e) {
            cLog('fetch failed', e);
            return [];
        }
    }

    function injectStyles() {
        if (document.getElementById('yt-pro-sb-style')) return;
        const style = document.createElement('style');
        style.id = 'yt-pro-sb-style';
        style.textContent = `
            #yt-pro-sb-toast {
                position: absolute;
                left: 12px;
                bottom: 60px;
                z-index: 71;
                background: rgba(20, 20, 20, 0.92);
                color: #fff;
                font: 500 13px/1 "Roboto", Arial, sans-serif;
                padding: 9px 14px;
                border-radius: 8px;
                display: flex;
                align-items: center;
                gap: 8px;
                opacity: 0;
                transform: translateY(6px);
                transition: opacity 0.18s ease, transform 0.18s ease;
                pointer-events: none;
                box-shadow: 0 2px 10px rgba(0,0,0,0.35);
            }
            #yt-pro-sb-toast.show { opacity: 1; transform: translateY(0); }
            #yt-pro-sb-toast .yt-pro-sb-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
            #yt-pro-sb-track {
                position: absolute !important;
                inset: 0 !important;
                box-sizing: border-box;
                pointer-events: none !important;
                z-index: 2147483000 !important;
                opacity: 0;
                visibility: hidden;
                transition: opacity 0.15s ease;
                overflow: visible !important;
                border-radius: 2px;
            }
            .yt-pro-sb-marker {
                position: absolute !important;
                top: 0 !important;
                bottom: 0 !important;
                height: 100% !important;
                min-width: 2px;
                opacity: 0.95;
                pointer-events: none !important;
                border-radius: 1px;
                z-index: 2147483001 !important;
                display: block !important;
            }
        `;
        document.head.appendChild(style);
    }

    function showSkipToast(category) {
        const player = document.querySelector('.html5-video-player');
        if (!player) return;
        let toast = document.getElementById('yt-pro-sb-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'yt-pro-sb-toast';
            toast.innerHTML = `<span class="yt-pro-sb-dot"></span><span class="yt-pro-sb-text"></span>`;
            player.appendChild(toast);
        }
        toast.querySelector('.yt-pro-sb-dot').style.background = CATEGORY_COLORS[category] || '#00d400';
        toast.querySelector('.yt-pro-sb-text').textContent = `Skipped ${CATEGORY_LABELS[category] || category}`;
        toast.classList.add('show');
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    function removeMarkers() {
        if (markerSyncRaf) {
            cancelAnimationFrame(markerSyncRaf);
            markerSyncRaf = 0;
        }
        if (markerRenderRaf) {
            cancelAnimationFrame(markerRenderRaf);
            markerRenderRaf = 0;
        }
        markerResizeObserver?.disconnect();
        markerResizeObserver = null;
        controlsObserver?.disconnect();
        controlsObserver = null;
        playerDomObserver?.disconnect();
        playerDomObserver = null;
        observedBar = null;
        markerHost = null;
        markerTrack?.remove();
        markerTrack = null;
    }

    function getPlayer() {
        return document.querySelector('.html5-video-player');
    }

    function getProgressHost() {
        const player = getPlayer();
        if (!player) return null;

        // YouTube can keep more than one progress-bar container alive while it
        // moves between normal-player and miniplayer layouts. querySelector()
        // is therefore unsafe: it can return the old/hidden container. Pick the
        // currently visible, largest progress surface instead.
        const candidates = [
            ...player.querySelectorAll('.ytp-progress-bar-container'),
            ...player.querySelectorAll('.ytp-progress-bar')
        ];

        let best = null;
        let bestScore = -1;
        for (const el of candidates) {
            if (!el || !el.isConnected) continue;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 20 || r.height < 1) continue;

            // Prefer the actual container, then the widest visible surface.
            const containerBonus = el.classList.contains('ytp-progress-bar-container') ? 1e9 : 0;
            const score = containerBonus + (r.width * Math.max(r.height, 1));
            if (score > bestScore) {
                best = el;
                bestScore = score;
            }
        }

        return best || player.querySelector('.ytp-progress-bar-container') ||
               player.querySelector('.ytp-progress-bar') || null;
    }

    function getProgressBarEl(host) {
        return host?.querySelector?.('.ytp-progress-bar') || host || null;
    }

    function scheduleMarkerGeometrySync(host) {
        if (markerSyncRaf) return;
        markerSyncRaf = requestAnimationFrame(() => {
            markerSyncRaf = 0;
            if (!markerTrack || !host || markerTrack.parentElement !== host) return;
            // The track fills the current progress-bar container. No player-level
            // coordinates are used, so moving between normal/miniplayer does not
            // leave stale absolute coordinates behind.
            markerTrack.style.left = '0';
            markerTrack.style.top = '0';
            markerTrack.style.width = '100%';
            markerTrack.style.height = '100%';
        });
    }

    function scheduleMarkerRender() {
        if (!active || markerRenderRaf) return;
        markerRenderRaf = requestAnimationFrame(() => {
            markerRenderRaf = 0;
            renderMarkers();
        });
    }

    function installPlayerDomObserver(player) {
        if (playerDomObserver) return;
        // Observe the document rather than only the player. During normal ↔
        // miniplayer transitions YouTube can reparent/replace the progress
        // controls, and the relevant DOM mutation is not guaranteed to happen
        // underneath the same player node that held our previous marker layer.
        const root = document.body || document.documentElement;
        if (!root) return;
        playerDomObserver = new MutationObserver((mutations) => {
            if (!active) return;
            const relevant = mutations.some(m => {
                if (m.type === 'attributes') {
                    return m.target?.classList?.contains('html5-video-player') ||
                           m.target?.classList?.contains('ytp-progress-bar-container') ||
                           m.target?.classList?.contains('ytp-progress-bar');
                }
                if (m.target === markerTrack || m.target?.closest?.('#yt-pro-sb-track')) return false;
                const nodes = [...m.addedNodes, ...m.removedNodes];
                return nodes.some(n => {
                    if (n.nodeType !== Node.ELEMENT_NODE) return false;
                    return n.matches?.('.html5-video-player, .ytp-progress-bar-container, .ytp-progress-bar') ||
                           !!n.querySelector?.('.html5-video-player, .ytp-progress-bar-container, .ytp-progress-bar');
                });
            });
            if (relevant) scheduleMarkerRender();
        });
        playerDomObserver.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    }

    function installMarkerLayer(host, player) {
        if (markerTrack && markerTrack.isConnected && markerTrack.parentElement === host) return;

        markerResizeObserver?.disconnect();
        markerResizeObserver = null;
        markerTrack?.remove();

        markerTrack = document.createElement('div');
        markerTrack.id = 'yt-pro-sb-track';
        markerTrack.setAttribute('aria-hidden', 'true');
        host.appendChild(markerTrack);
        markerHost = host;
        observedBar = getProgressBarEl(host);

        const computedPosition = getComputedStyle(host).position;
        if (computedPosition === 'static') host.style.position = 'relative';

        markerResizeObserver = new ResizeObserver(() => scheduleMarkerGeometrySync(host));
        markerResizeObserver.observe(host);
        if (observedBar && observedBar !== host) markerResizeObserver.observe(observedBar);

        controlsObserver?.disconnect();
        controlsObserver = new MutationObserver(() => scheduleMarkerRender());
        controlsObserver.observe(player, { attributes: true, attributeFilter: ['class'] });

        scheduleMarkerGeometrySync(host);
    }

    function renderMarkers() {
        if (!active || !video || !video.duration || !isFinite(video.duration) || video.duration <= 0) return;

        const player = getPlayer();
        const host = getProgressHost();
        if (!player || !host) return;

        // Native PiP has its own browser surface; page-side markers must be
        // hidden there and recreated against YouTube's current DOM on return.
        if (document.pictureInPictureElement) {
            if (markerTrack) markerTrack.style.visibility = 'hidden';
            return;
        }

        installPlayerDomObserver(player);
        installMarkerLayer(host, player);
        scheduleMarkerGeometrySync(host);

        const hostRect = host.getBoundingClientRect();
        const hostStyle = getComputedStyle(host);
        const hostVisible = hostRect.width > 20 && hostRect.height > 0 &&
            hostStyle.display !== 'none' && hostStyle.visibility !== 'hidden' &&
            Number(hostStyle.opacity) > 0;
        markerTrack.style.visibility = hostVisible ? 'visible' : 'hidden';
        markerTrack.style.opacity = hostVisible ? '1' : '0';

        markerTrack.innerHTML = '';
        const duration = video.duration;
        for (const seg of segments) {
            const [start, end] = seg.segment;
            if (!isFinite(start) || !isFinite(end) || end <= start) continue;
            const left = Math.max(0, Math.min(100, (start / duration) * 100));
            const width = Math.max(0.35, Math.min(100 - left, ((end - start) / duration) * 100));
            const marker = document.createElement('div');
            marker.className = 'yt-pro-sb-marker';
            marker.style.left = `${left}%`;
            marker.style.width = `${width}%`;
            marker.style.background = seg.isLocalOnly ? '#ffffff' : (CATEGORY_COLORS[seg.category] || '#00d400');
            markerTrack.appendChild(marker);
        }
    }

    function onTimeUpdate() {
        if (!active || !video || !segments.length || !skipReady) return;
        // Don't act until the video can actually be seeked reliably — this is
        // what previously caused a "Skipped" toast with no real skip: we were
        // setting currentTime before the player had a real source loaded, so
        // YouTube's own init silently overwrote it right back to 0.
        if (video.readyState < 2) return;

        const t = video.currentTime;
        for (const seg of segments) {
            const [start, end] = seg.segment;
            // Small epsilon guards against re-triggering right at a segment's own end
            if (t >= start && t < end - 0.05 && end !== lastSkipEndTime) {
                lastSkipEndTime = end;
                pendingSkip = { end, category: seg.category };
                video.currentTime = end;
                break;
            }
        }
    }

    function onSeeked() {
        // Only announce the skip once the seek has actually landed near the
        // target — confirms it wasn't silently reverted by the page.
        if (!pendingSkip || !video) return;
        if (Math.abs(video.currentTime - pendingSkip.end) < 1.5) {
            showSkipToast(pendingSkip.category);
        }
        pendingSkip = null;
    }

    function attachVideo(v) {
        if (video === v) return;
        detachVideo();
        video = v;
        skipReady = false;
        clearTimeout(skipReadyTimer);
        // Give YouTube's own player init a moment to finish setting up
        // (resume position, ad handling, etc.) before we start acting on
        // timeupdate — acting too early is what caused false-positive
        // "skipped" toasts with no actual skip taking effect.
        skipReadyTimer = setTimeout(() => { skipReady = true; }, 1200);

        boundTimeUpdate = onTimeUpdate;
        boundLoadedMeta = () => renderMarkers();
        boundSeeked = onSeeked;
        video.addEventListener('timeupdate', boundTimeUpdate);
        video.addEventListener('loadedmetadata', boundLoadedMeta);
        video.addEventListener('seeked', boundSeeked);
    }

    function detachVideo() {
        if (!video) return;
        if (boundTimeUpdate) video.removeEventListener('timeupdate', boundTimeUpdate);
        if (boundLoadedMeta) video.removeEventListener('loadedmetadata', boundLoadedMeta);
        if (boundSeeked) video.removeEventListener('seeked', boundSeeked);
        video = null;
        boundTimeUpdate = null;
        boundLoadedMeta = null;
        boundSeeked = null;
        clearTimeout(skipReadyTimer);
        skipReady = false;
        pendingSkip = null;
    }

    async function onVideoChange() {
        const vid = getVideoId();
        if (!vid || vid === currentVideoId) return;
        currentVideoId = vid;
        segments = [];
        lastSkipEndTime = -1;
        removeMarkers();
        segments = await fetchSegments(vid);
        cLog(`Loaded ${segments.length} segment(s) for`, vid);
        renderMarkers();
    }

    async function refetchCurrentVideo() {
        if (!currentVideoId) return;
        segments = [];
        lastSkipEndTime = -1;
        removeMarkers();
        segments = await fetchSegments(currentVideoId);
        renderMarkers();
    }

    function pollLoop() {
        pollTimer = setInterval(() => {
            if (!active) return;
            const v = document.querySelector('video');
            if (v && v !== video) attachVideo(v);
            onVideoChange();
            renderMarkers();
        }, 500);
    }

    window._ytProSponsorBlock = {
        init(categories) {
            if (categories) enabledCategories = Object.assign({}, DEFAULT_CATEGORY_STATE, categories);
            if (active) return;
            active = true;
            injectStyles();
            currentVideoId = null; // force a fetch even if returning to a previously-seen id
            const v = document.querySelector('video');
            if (v) attachVideo(v);
            onVideoChange();
            pollLoop();
        },
        setCategories(categories) {
            enabledCategories = Object.assign({}, DEFAULT_CATEGORY_STATE, categories);
            if (active) refetchCurrentVideo();
        },
        teardown() {
            active = false;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            clearTimeout(toastTimeout);
            detachVideo();
            removeMarkers();
            document.getElementById('yt-pro-sb-toast')?.remove();
            document.getElementById('yt-pro-sb-style')?.remove();
            segments = [];
            currentVideoId = null;
            lastSkipEndTime = -1;
            pendingSkip = null;
        },
    };

    // ── Own message listener — keeps this feature fully self-contained so it
    // doesn't require touching content.js's dispatcher.
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((request) => {
            if (request.action === 'togglesponsorblock') {
                request.state ? window._ytProSponsorBlock.init() : window._ytProSponsorBlock.teardown();
            } else if (request.action === 'sponsorblockCategoriesChanged') {
                window._ytProSponsorBlock.setCategories(request.categories || {});
            } else if (request.action === 'masterToggleChanged' && request.state === false) {
                window._ytProSponsorBlock.teardown();
            }
        });
    }

    document.addEventListener('leavepictureinpicture', () => {
        setTimeout(() => {
            if (!active) return;
            markerTrack?.remove();
            markerTrack = null;
            markerHost = null;
            observedBar = null;
            scheduleMarkerRender();
        }, 50);
    });
    document.addEventListener('enterpictureinpicture', () => {
        if (markerTrack) markerTrack.style.visibility = 'hidden';
    });
    document.addEventListener('fullscreenchange', () => {
        setTimeout(() => {
            if (active) scheduleMarkerRender();
        }, 50);
    });

    function selfInit() {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
        try {
            chrome.storage.local.get(['masterEnabled', 'sponsorblock', 'sponsorblockCategories'], (result) => {
                if (chrome.runtime?.lastError) return;
                if (result.masterEnabled === false) return;
                if (result.sponsorblockCategories) {
                    enabledCategories = Object.assign({}, DEFAULT_CATEGORY_STATE, result.sponsorblockCategories);
                }
                if (result.sponsorblock !== false) window._ytProSponsorBlock.init();
            });
        } catch (e) {
            // extension context invalidated (e.g. mid-reload) — ignore
        }
    }

    selfInit();
})();
