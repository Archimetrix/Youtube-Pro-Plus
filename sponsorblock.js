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
    let skipReady = false;
    let skipReadyTimer = null;
    let pendingSkip = null; // { end, category } — set while we wait for a seek to actually land
    let submitBtnPollTimer = null;
    let panelOpen = false;
    let markedStart = null;
    let markedEnd = null;
    let selectedCategory = 'sponsor';
    let userId = null;

    function cLog() { /* console.debug('[SponsorBlock]', ...arguments); */ }

    // ── Local submission memory ─────────────────────────────────────────────
    // sponsor.ajay.app caches GET /api/skipSegments responses for a few
    // minutes server-side. That means right after you submit a segment, a
    // fresh fetch (even with cache: 'no-store') can still come back without
    // it — the submission landed fine, but the read is stale. To avoid it
    // looking like the segment "disappeared" when you navigate away and
    // back, we remember segments we've submitted (per videoID, in
    // chrome.storage.local so it survives navigation) and keep merging them
    // into whatever the server returns until either the server starts
    // including them for real, or 30 minutes pass (by which point the
    // server-side cache will definitely have refreshed).
    const LOCAL_SUB_TTL_MS = 30 * 60 * 1000;

    function getLocalSubs(vid) {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get(['sbLocalSubs'], (r) => {
                    if (chrome.runtime?.lastError) return resolve([]);
                    resolve(((r.sbLocalSubs || {})[vid]) || []);
                });
            } catch (e) {
                resolve([]);
            }
        });
    }

    function saveLocalSub(vid, sub) {
        try {
            chrome.storage.local.get(['sbLocalSubs'], (r) => {
                if (chrome.runtime?.lastError) return;
                const all = r.sbLocalSubs || {};
                const now = Date.now();
                // Prune expired entries across all videos while we're here.
                Object.keys(all).forEach((k) => {
                    all[k] = (all[k] || []).filter(s => now - s.submittedAt < LOCAL_SUB_TTL_MS);
                    if (!all[k].length) delete all[k];
                });
                const list = all[vid] || [];
                list.push(sub);
                all[vid] = list;
                chrome.storage.local.set({ sbLocalSubs: all });
            });
        } catch (e) { /* extension context invalidated — ignore */ }
    }

    // Merge locally-remembered submissions into a freshly-fetched segment
    // list, skipping any that the server is already returning (matched by
    // close start/end times) and dropping any that have expired.
    function mergeLocalSubs(serverSegments, localSubs) {
        const now = Date.now();
        const fresh = localSubs.filter(s => now - s.submittedAt < LOCAL_SUB_TTL_MS);
        const merged = serverSegments.slice();
        fresh.forEach((sub) => {
            const alreadyPresent = serverSegments.some(seg =>
                seg.category === sub.category &&
                Math.abs(seg.segment[0] - sub.segment[0]) < 1.5 &&
                Math.abs(seg.segment[1] - sub.segment[1]) < 1.5
            );
            if (!alreadyPresent && enabledCategories[sub.category]) merged.push(Object.assign({}, sub, { isLocalOnly: true }));
        });
        return merged;
    }

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
            // Merge in anything we've submitted ourselves recently, in case
            // the server's response is still a cached pre-submission read.
            const localSubs = await getLocalSubs(videoId);
            return localSubs.length ? mergeLocalSubs(serverSegments, localSubs) : serverSegments;
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
                position: absolute;
                pointer-events: none;
                z-index: 1000;
                opacity: 0;
                transition: opacity 0.15s ease;
            }
            .yt-pro-sb-marker {
                position: absolute;
                top: 0;
                height: 100%;
                opacity: 0.75;
                pointer-events: none;
            }
            #yt-pro-sb-submit-btn { background:transparent;border:0;outline:none;cursor:pointer;padding:0;vertical-align:top; }
            #yt-pro-sb-panel {
                position: absolute;
                right: 10px;
                bottom: 50px;
                z-index: 80;
                width: 230px;
                background: rgba(20,20,20,0.97);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 10px;
                padding: 12px;
                font: 500 12px/1.3 "Roboto", Arial, sans-serif;
                color: #fff;
                box-shadow: 0 4px 18px rgba(0,0,0,0.5);
            }
            #yt-pro-sb-panel .sb-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; display:flex; align-items:center; justify-content:space-between; }
            #yt-pro-sb-panel .sb-close { cursor:pointer; opacity:0.6; font-size:15px; line-height:1; }
            #yt-pro-sb-panel .sb-close:hover { opacity:1; }
            #yt-pro-sb-panel .sb-row { display:flex; gap:6px; margin-bottom:8px; }
            #yt-pro-sb-panel button.sb-mark { flex:1; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.14); color:#fff; border-radius:6px; padding:6px 4px; cursor:pointer; font-size:11.5px; }
            #yt-pro-sb-panel button.sb-mark:hover { background:rgba(255,255,255,0.16); }
            #yt-pro-sb-panel button.sb-mark.marked { border-color: var(--accent, #6366f1); color: var(--accent, #8b8bf5); }
            #yt-pro-sb-panel select.sb-cat-select { width:100%; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.14); color:#fff; border-radius:6px; padding:6px; margin-bottom:8px; font-size:11.5px; }
            #yt-pro-sb-panel .sb-submit-btn { width:100%; background:#00d400; color:#0a0a0a; border:0; border-radius:6px; padding:7px 0; font-weight:700; cursor:pointer; font-size:12px; }
            #yt-pro-sb-panel .sb-submit-btn:disabled { opacity:0.4; cursor:not-allowed; }
            #yt-pro-sb-panel .sb-submit-btn:not(:disabled):hover { background:#1fe61f; }
            #yt-pro-sb-panel .sb-status { margin-top:6px; font-size:11px; opacity:0.75; min-height: 14px; }
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
        markerTrack?.remove();
        markerTrack = null;
        controlsObserver?.disconnect();
        controlsObserver = null;
    }

    function getProgressBarEl() {
        // The actual thin visible bar YouTube draws the played/buffered fill in.
        // Falls back through a couple of known selectors since YouTube has
        // changed this markup before.
        return document.querySelector('.ytp-progress-bar-container') ||
               document.querySelector('.ytp-progress-bar');
    }

    function renderMarkers() {
        if (!active || !video || !video.duration || !isFinite(video.duration) || video.duration <= 0) return;
        const player = document.querySelector('.html5-video-player');
        const bar = getProgressBarEl();
        if (!player || !bar) return;

        const playerRect = player.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        if (barRect.width <= 0) return; // player not laid out yet (e.g. hidden tab)

        if (!markerTrack || !markerTrack.isConnected) {
            markerTrack = document.createElement('div');
            markerTrack.id = 'yt-pro-sb-track';
            player.appendChild(markerTrack);

            // React instantly to controls show/hide instead of waiting for
            // the next 500ms poll tick, so the overlay never lags visibly
            // behind the real controls fading in/out.
            controlsObserver?.disconnect();
            controlsObserver = new MutationObserver(() => {
                if (markerTrack) {
                    markerTrack.style.opacity = player.classList.contains('ytp-autohide') ? '0' : '1';
                }
            });
            controlsObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
        }

        // Keep the overlay glued exactly on top of YouTube's real bar, even
        // as it resizes (theater mode, fullscreen, hover-expand, etc).
        markerTrack.style.left = (barRect.left - playerRect.left) + 'px';
        markerTrack.style.top = (barRect.top - playerRect.top) + 'px';
        markerTrack.style.width = barRect.width + 'px';
        markerTrack.style.height = Math.max(barRect.height, 3) + 'px';

        // Match YouTube's own behavior: the progress bar (and our overlay
        // riding on top of it) is only meaningfully visible while the native
        // controls are shown. Without this, the markers stayed pinned in
        // place even while controls were hidden/faded, making them look like
        // stray disconnected chips floating over the video.
        const controlsHidden = player.classList.contains('ytp-autohide');
        markerTrack.style.opacity = controlsHidden ? '0' : '1';

        markerTrack.innerHTML = '';
        const duration = video.duration;
        segments.forEach(seg => {
            const [start, end] = seg.segment;
            const left = Math.max(0, Math.min(100, (start / duration) * 100));
            const width = Math.max(0.3, Math.min(100 - left, ((end - start) / duration) * 100));
            const marker = document.createElement('div');
            marker.className = 'yt-pro-sb-marker';
            marker.style.left = left + '%';
            marker.style.width = width + '%';
            // Locally-remembered segments that the server hasn't confirmed
            // yet (still cached/stale) render white, so it's obvious at a
            // glance which markers are "yours, unconfirmed" vs "confirmed
            // by the server for everyone".
            marker.style.background = seg.isLocalOnly ? '#ffffff' : (CATEGORY_COLORS[seg.category] || '#00d400');
            markerTrack.appendChild(marker);
        });
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
        closeSubmitPanel();
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

    function getUserId(cb) {
        if (userId) return cb(userId);
        try {
            chrome.storage.local.get(['sponsorblockUserID'], (r) => {
                if (r.sponsorblockUserID) {
                    userId = r.sponsorblockUserID;
                } else {
                    userId = (crypto.randomUUID ? crypto.randomUUID() : 'ytpp-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
                    chrome.storage.local.set({ sponsorblockUserID: userId });
                }
                cb(userId);
            });
        } catch (e) {
            userId = userId || ('ytpp-' + Math.random().toString(36).slice(2));
            cb(userId);
        }
    }

    function fmtTime(t) {
        if (t == null) return '—';
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function createSubmitButton() {
        const button = document.createElement('button');
        button.classList.add('ytp-button');
        button.id = 'yt-pro-sb-submit-btn';
        button.title = 'Submit a SponsorBlock segment';
        button.setAttribute('aria-label', 'Submit a SponsorBlock segment');
        button.innerHTML =
            '<svg viewBox="0 0 24 24" width="22" height="22" style="display:block;margin:auto;" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M12 2.2 L19 4.6 V11.2 C19 16.4 15.8 19.9 12 21.8 C8.2 19.9 5 16.4 5 11.2 V4.6 Z" fill="#e01e2b"/>' +
            '<path d="M12 3.5 L17.7 5.5 V11.1 C17.7 15.5 15.1 18.5 12 20.3 C8.9 18.5 6.3 15.5 6.3 11.1 V5.5 Z" fill="#fff"/>' +
            '<path d="M10.2 8.5 L15.1 11.4 L10.2 14.3 Z" fill="#e01e2b"/>' +
            '<circle cx="17.6" cy="17.6" r="4.2" fill="#f5a623" stroke="#8a5a06" stroke-width="0.6"/>' +
            '<text x="17.6" y="19.4" font-size="5.4" font-weight="700" font-family="Arial, sans-serif" text-anchor="middle" fill="#8a5a06">$</text>' +
            '</svg>';
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            panelOpen ? closeSubmitPanel() : openSubmitPanel();
        });
        return button;
    }

    function injectSubmitButton() {
        if (!active || document.getElementById('yt-pro-sb-submit-btn')) return;
        const rightControls = document.querySelector('div.ytp-right-controls');
        if (!rightControls) return;
        rightControls.prepend(createSubmitButton());
    }

    function removeSubmitButton() {
        document.getElementById('yt-pro-sb-submit-btn')?.remove();
        closeSubmitPanel();
    }

    function closeSubmitPanel() {
        panelOpen = false;
        document.getElementById('yt-pro-sb-panel')?.remove();
    }

    function refreshPanelUI(panel) {
        panel.querySelector('#sb-mark-start').classList.toggle('marked', markedStart !== null);
        panel.querySelector('#sb-mark-start').textContent = markedStart !== null ? `Start: ${fmtTime(markedStart)}` : 'Mark Start';
        panel.querySelector('#sb-mark-end').classList.toggle('marked', markedEnd !== null);
        panel.querySelector('#sb-mark-end').textContent = markedEnd !== null ? `End: ${fmtTime(markedEnd)}` : 'Mark End';
        const canSubmit = markedStart !== null && markedEnd !== null && markedEnd > markedStart;
        panel.querySelector('.sb-submit-btn').disabled = !canSubmit;
    }

    function openSubmitPanel() {
        if (!video) return;
        closeSubmitPanel();
        panelOpen = true;
        markedStart = null;
        markedEnd = null;

        const player = document.querySelector('.html5-video-player');
        if (!player) return;

        const panel = document.createElement('div');
        panel.id = 'yt-pro-sb-panel';
        panel.innerHTML = `
            <div class="sb-title"><span style="display:flex;align-items:center;gap:6px;"><svg viewBox="0 0 24 24" width="15" height="15" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.2 L19 4.6 V11.2 C19 16.4 15.8 19.9 12 21.8 C8.2 19.9 5 16.4 5 11.2 V4.6 Z" fill="#e01e2b"/><path d="M12 3.5 L17.7 5.5 V11.1 C17.7 15.5 15.1 18.5 12 20.3 C8.9 18.5 6.3 15.5 6.3 11.1 V5.5 Z" fill="#fff"/><path d="M10.2 8.5 L15.1 11.4 L10.2 14.3 Z" fill="#e01e2b"/><circle cx="17.6" cy="17.6" r="4.2" fill="#f5a623" stroke="#8a5a06" stroke-width="0.6"/><text x="17.6" y="19.4" font-size="5.4" font-weight="700" font-family="Arial, sans-serif" text-anchor="middle" fill="#8a5a06">$</text></svg>Submit a Segment</span><span class="sb-close" id="sb-close-btn">&times;</span></div>
            <div class="sb-row">
                <button class="sb-mark" id="sb-mark-start">Mark Start</button>
                <button class="sb-mark" id="sb-mark-end">Mark End</button>
            </div>
            <select class="sb-cat-select" id="sb-cat-select">
                ${Object.keys(CATEGORY_LABELS).filter(c => c !== 'poi_highlight').map(c => `<option value="${c}">${CATEGORY_LABELS[c]}</option>`).join('')}
            </select>
            <button class="sb-submit-btn" id="sb-submit-btn" disabled>Submit to SponsorBlock</button>
            <div class="sb-status" id="sb-status"></div>
        `;
        player.appendChild(panel);

        panel.querySelector('#sb-cat-select').value = selectedCategory;
        panel.querySelector('#sb-close-btn').addEventListener('click', closeSubmitPanel);
        panel.querySelector('#sb-cat-select').addEventListener('change', (e) => { selectedCategory = e.target.value; });
        panel.querySelector('#sb-mark-start').addEventListener('click', () => {
            markedStart = video.currentTime;
            refreshPanelUI(panel);
        });
        panel.querySelector('#sb-mark-end').addEventListener('click', () => {
            markedEnd = video.currentTime;
            refreshPanelUI(panel);
        });
        panel.querySelector('#sb-submit-btn').addEventListener('click', () => submitSegment(panel));

        refreshPanelUI(panel);
    }

    function submitSegment(panel) {
        const status = panel.querySelector('#sb-status');
        const submitBtn = panel.querySelector('#sb-submit-btn');
        if (markedStart === null || markedEnd === null || markedEnd <= markedStart) return;
        if (!currentVideoId) { status.textContent = 'No video detected.'; return; }

        submitBtn.disabled = true;
        status.textContent = 'Submitting…';

        getUserId((uid) => {
            const params = new URLSearchParams({
                videoID: currentVideoId,
                startTime: markedStart.toFixed(3),
                endTime: markedEnd.toFixed(3),
                category: selectedCategory,
                userID: uid,
                actionType: 'skip',
            });
            fetch(`${API_BASE}/skipSegments?${params.toString()}`, { method: 'POST' })
                .then(async (resp) => {
                    if (resp.ok) {
                        status.textContent = 'Submitted! Thanks for contributing.';
                        // Shown in its real category color right away — this is
                        // the current session's optimistic add, not a
                        // cross-session merge, so there's no ambiguity yet.
                        const newSeg = { segment: [markedStart, markedEnd], category: selectedCategory, actionType: 'skip', UUID: 'local-' + Date.now(), submittedAt: Date.now() };
                        // Optimistically show it right away without waiting on cache
                        segments = segments.concat([newSeg]);
                        renderMarkers();
                        // Remember it so it keeps showing on revisit even if the
                        // server's read-cache hasn't picked it up yet (see
                        // fetchSegments / mergeLocalSubs above).
                        saveLocalSub(currentVideoId, newSeg);
                        setTimeout(closeSubmitPanel, 1800);
                    } else {
                        const text = await resp.text().catch(() => '');
                        status.textContent = resp.status === 409
                            ? 'That segment already exists.'
                            : (text || `Failed (${resp.status})`);
                        submitBtn.disabled = false;
                    }
                })
                .catch(() => {
                    status.textContent = 'Network error — try again.';
                    submitBtn.disabled = false;
                });
        });
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
            injectSubmitButton();
            if (!submitBtnPollTimer) {
                submitBtnPollTimer = setInterval(() => { if (active) injectSubmitButton(); }, 1500);
            }
        },
        setCategories(categories) {
            enabledCategories = Object.assign({}, DEFAULT_CATEGORY_STATE, categories);
            if (active) refetchCurrentVideo();
        },
        teardown() {
            active = false;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (submitBtnPollTimer) { clearInterval(submitBtnPollTimer); submitBtnPollTimer = null; }
            clearTimeout(toastTimeout);
            detachVideo();
            removeMarkers();
            removeSubmitButton();
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
