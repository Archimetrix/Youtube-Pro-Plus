// ── First-Install Welcome Screen ─────────────────────────────────────────────
(function () {
    const welcomeScreen = document.getElementById('welcome-screen');
    const mainView      = document.getElementById('main-view');
    const starBtn       = document.getElementById('welcome-star-btn');
    const useBtn        = document.getElementById('welcome-use-btn');

    function showMainUI() {
        welcomeScreen.style.display = 'none';
        mainView.style.display      = '';
    }

    chrome.storage.local.get(['hasSeenWelcome'], (result) => {
        if (result.hasSeenWelcome) {
            showMainUI();
            return;
        }
        // First visit — show welcome screen, hide main UI
        mainView.style.display      = 'none';
        welcomeScreen.style.display = 'flex';

        starBtn.addEventListener('click', () => {
            chrome.storage.local.set({ hasSeenWelcome: true });
        });

        // Fix: coffee button also dismisses the welcome screen
        const coffeeBtn = document.getElementById('welcome-coffee-btn');
        if (coffeeBtn) {
            coffeeBtn.addEventListener('click', () => {
                chrome.storage.local.set({ hasSeenWelcome: true });
            });
        }

        // Show Skip button after 5 seconds
        setTimeout(() => {
            useBtn.textContent = 'No thanks, take me to the extension';
            useBtn.style.display = 'flex';
            useBtn.addEventListener('click', () => {
                chrome.storage.local.set({ hasSeenWelcome: true });
                showMainUI();
            });
        }, 5000);
    });
})();

document.addEventListener('DOMContentLoaded', () => {
    const vl = document.getElementById('ext-version-label');
    if (vl) { const m = chrome.runtime.getManifest(); vl.textContent = 'v' + m.version; }

    // ── Popup open/close video pause ────────────────────────────────────────
    // Cache the YouTube tab ID so we can send the resume message reliably
    // inside the pagehide handler (where async queries aren't possible).
    let _ytTabId = null;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url && tabs[0].url.includes('youtube.com')) {
            _ytTabId = tabs[0].id;
            chrome.tabs.sendMessage(_ytTabId, { action: 'pauseForPopup' }).catch(() => {});
        }
    });

    // pagehide fires reliably when the extension popup is closed by the user
    window.addEventListener('pagehide', () => {
        if (_ytTabId !== null) {
            chrome.tabs.sendMessage(_ytTabId, { action: 'resumeAfterPopup' }).catch(() => {});
        }
    });

    const toggles = ['theme', 'premium', 'ambient', 'cinematic', 'speed', 'audio', 'autoscroll', 'download', 'builtinDownloader', 'fullscreen', 'autoResume', 'screenshot', 'watchparty', 'miniplayer', 'returnDislike', 'sponsorblock'];
    const masterToggleBtn = document.getElementById('master-toggle');

    // ── Load all settings ───────────────────────────────────────────────────
    chrome.storage.local.get(['masterEnabled', 'cinematicSettings', 'sponsorblockCategories', ...toggles], (result) => {
        const isMasterEnabled = result.masterEnabled !== false;
        updateMasterUI(isMasterEnabled);

        masterToggleBtn.addEventListener('click', () => {
            const willBeEnabled = !masterToggleBtn.classList.contains('active');
            chrome.storage.local.set({ masterEnabled: willBeEnabled }, () => {
                updateMasterUI(willBeEnabled);
                chrome.runtime.sendMessage({ action: 'masterToggleChanged', state: willBeEnabled }).catch(() => {});
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'masterToggleChanged', state: willBeEnabled }).catch(() => {});
                });
            });
        });

        toggles.forEach(toggle => {
            const isEnabled = (toggle === 'fullscreen' || toggle === 'cinematic' || toggle === 'download')
                ? result[toggle] === true
                : result[toggle] !== false;
            document.getElementById(`toggle-${toggle}`).checked = isEnabled;
        });

        // ── Download / Built-in Downloader are mutually exclusive ───────────
        // Only one download method can be active at a time. If storage ever
        // ends up with both on (e.g. upgrading from an older version), Smart
        // Download wins since it was the explicit later choice, and Built-in
        // Downloader is switched off to match.
        if (document.getElementById('toggle-download').checked &&
            document.getElementById('toggle-builtinDownloader').checked) {
            document.getElementById('toggle-builtinDownloader').checked = false;
            chrome.storage.local.set({ builtinDownloader: false });
        }
        updateBuiltinDownloaderOpenBtn(document.getElementById('toggle-builtinDownloader').checked);

        checkFullscreenHint(result.fullscreen === true);

        // ── Cinematic sub-controls ──────────────────────────────────────────
        const cineSettings = result.cinematicSettings || { blur: 'med', sat: 'med', dim: 'med' };
        initCineControls(cineSettings, result.cinematic === true);

        // ── SponsorBlock category sub-controls ───────────────────────────────
        const sbDefaults = { sponsor: true, selfpromo: true, interaction: true, intro: true, outro: true, preview: true, filler: false, music_offtopic: false };
        const sbCategories = Object.assign({}, sbDefaults, result.sponsorblockCategories || {});
        initSponsorBlockControls(sbCategories, result.sponsorblock !== false);
    });

    // ── Individual toggle listeners ─────────────────────────────────────────
    toggles.forEach(toggle => {
        document.getElementById(`toggle-${toggle}`).addEventListener('change', (e) => {
            const isChecked = e.target.checked;

            // ── Cinematic Mode disclaimer gate ──────────────────────────────
            if (toggle === 'cinematic' && isChecked) {
                e.target.checked = false; // revert visually until user confirms
                showCinematicDisclaimer();
                return;
            }
            if (toggle === 'cinematic' && !isChecked) {
                setCineControlsVisible(false);
            }
            // ────────────────────────────────────────────────────────────────

            if (toggle === 'sponsorblock') {
                setSponsorBlockControlsVisible(isChecked);
            }
            // ────────────────────────────────────────────────────────────────

            chrome.storage.local.set({ [toggle]: isChecked });

            // ── Download / Built-in Downloader are mutually exclusive ────────
            // Turning one on always switches the other off — a user can only
            // have one active download method at a time.
            if (toggle === 'download' && isChecked) {
                const otherToggle = document.getElementById('toggle-builtinDownloader');
                if (otherToggle.checked) {
                    otherToggle.checked = false;
                    chrome.storage.local.set({ builtinDownloader: false });
                    updateBuiltinDownloaderOpenBtn(false);
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'togglebuiltinDownloader', state: false }).catch(() => {});
                    });
                }
            } else if (toggle === 'builtinDownloader' && isChecked) {
                const otherToggle = document.getElementById('toggle-download');
                if (otherToggle.checked) {
                    otherToggle.checked = false;
                    chrome.storage.local.set({ download: false });
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'toggledownload', state: false }).catch(() => {});
                    });
                }
            }
            // ──────────────────────────────────────────────────────────────────

            if (toggle === 'audio') {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) {
                        // level 150 = 1.5× gain (150% volume) — sensible default
                        chrome.storage.local.get('boostLevel', r => {
                            const level = r.boostLevel || 150;
                            chrome.tabs.sendMessage(tabs[0].id, { action: 'toggleaudio', state: isChecked, level }).catch(() => {});
                        });
                    }
                });
            }
            if (toggle === 'fullscreen') {
                checkFullscreenHint(isChecked);
                chrome.runtime.sendMessage({ action: 'fullscreenToggleChanged', state: isChecked }).catch(() => {});
            }

            if (toggle === 'builtinDownloader') {
                updateBuiltinDownloaderOpenBtn(isChecked);
            }

            if (['premium', 'ambient', 'cinematic', 'download', 'builtinDownloader', 'autoResume', 'screenshot', 'watchparty', 'miniplayer', 'returnDislike', 'sponsorblock'].includes(toggle)) {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: `toggle${toggle}`, state: isChecked }).catch(() => {});
                });
            }
        });
    });

    // ── Helpers ─────────────────────────────────────────────────────────────
    function updateBuiltinDownloaderOpenBtn(isEnabled) {
        const openBtn = document.getElementById('open-builtin-downloader');
        if (!openBtn) return;
        openBtn.disabled = !isEnabled;
        openBtn.style.opacity = isEnabled ? '1' : '0.5';
        openBtn.style.cursor = isEnabled ? 'pointer' : 'not-allowed';
    }

    function updateMasterUI(isEnabled) {
        if (isEnabled) {
            masterToggleBtn.classList.add('active');
            document.body.classList.remove('disabled-mode');
        } else {
            masterToggleBtn.classList.remove('active');
            document.body.classList.add('disabled-mode');
        }
    }

    // ── Cinematic Mode Disclaimer ────────────────────────────────────────────
    function showCinematicDisclaimer() {
        const overlay = document.getElementById('cinematic-disclaimer-overlay');
        if (overlay) overlay.style.display = 'flex';
    }

    function hideCinematicDisclaimer() {
        const overlay = document.getElementById('cinematic-disclaimer-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    document.getElementById('cinematic-confirm-btn').addEventListener('click', () => {
        const cinematicToggle = document.getElementById('toggle-cinematic');
        cinematicToggle.checked = true;
        chrome.storage.local.set({ cinematic: true });
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'togglecinematic', state: true }).catch(() => {});
        });
        setCineControlsVisible(true);
        hideCinematicDisclaimer();
    });

    document.getElementById('cinematic-cancel-btn').addEventListener('click', () => {
        hideCinematicDisclaimer();
    });
    // ─────────────────────────────────────────────────────────────────────────

    // ── Cinematic Sub-Controls ───────────────────────────────────────────────
    function setCineControlsVisible(visible) {
        const panel = document.getElementById('cine-controls');
        if (panel) panel.classList.toggle('visible', visible);
    }

    function initCineControls(settings, cinematicOn) {
        setCineControlsVisible(cinematicOn);

        // Mark the active button in each group
        ['blur', 'sat', 'dim'].forEach(ctrl => {
            document.querySelectorAll(`.cine-btn[data-ctrl="${ctrl}"]`).forEach(btn => {
                btn.classList.toggle('active', btn.dataset.val === (settings[ctrl] || 'med'));
            });
        });

        // Click handler for each chip button
        document.querySelectorAll('.cine-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const ctrl = btn.dataset.ctrl;
                const val  = btn.dataset.val;

                // Update active state visually
                document.querySelectorAll(`.cine-btn[data-ctrl="${ctrl}"]`).forEach(b => {
                    b.classList.toggle('active', b === btn);
                });

                // Persist and broadcast
                chrome.storage.local.get('cinematicSettings', r => {
                    const updated = Object.assign({ blur: 'med', sat: 'med', dim: 'med' }, r.cinematicSettings, { [ctrl]: val });
                    chrome.storage.local.set({ cinematicSettings: updated });
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'cinematicSettingsChanged', settings: updated }).catch(() => {});
                    });
                });
            });
        });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── SponsorBlock Sub-Controls ────────────────────────────────────────────
    function setSponsorBlockControlsVisible(visible) {
        const panel = document.getElementById('sb-controls');
        if (panel) panel.classList.toggle('visible', visible);
    }

    function initSponsorBlockControls(categories, sponsorblockOn) {
        setSponsorBlockControlsVisible(sponsorblockOn);

        document.querySelectorAll('.sb-controls input[data-cat]').forEach(input => {
            const cat = input.dataset.cat;
            input.checked = !!categories[cat];

            input.addEventListener('change', (e) => {
                chrome.storage.local.get('sponsorblockCategories', r => {
                    const updated = Object.assign(
                        { sponsor: true, selfpromo: true, interaction: true, intro: true, outro: true, preview: true, filler: false, music_offtopic: false },
                        r.sponsorblockCategories,
                        { [cat]: e.target.checked }
                    );
                    chrome.storage.local.set({ sponsorblockCategories: updated });
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'sponsorblockCategoriesChanged', categories: updated }).catch(() => {});
                    });
                });
            });
        });
    }
    // ─────────────────────────────────────────────────────────────────────────


    function checkFullscreenHint(isFullscreenEnabled) {
        const hint = document.getElementById('fullscreen-hint');
        if (hint) hint.style.display = isFullscreenEnabled ? 'flex' : 'none';
    }

    // ── Watch History / Resume Panel ────────────────────────────────────────
    const resumePanel        = document.getElementById('resume-panel');
    const rpList             = document.getElementById('rp-list');
    const rpSearchInput      = document.getElementById('rp-search-input');
    const resumeSettingsPanel = document.getElementById('resume-settings-panel');
    const recapPanel         = document.getElementById('recap-panel');

    let allVideos = [];

    // ── Force full-coverage overlay geometry via JS ─────────────────────────
    // Relying on CSS top:0/bottom:0 to stretch a panel to fill an ancestor
    // whose own height is "auto" (i.e. determined by document flow) is
    // unreliable in a Chrome extension popup, whose window auto-sizes to
    // content in ways that can leave the percentage-based stretch resolving
    // against the wrong box. Setting explicit pixel top/left/width/height
    // at the moment the panel opens sidesteps that entirely — it always
    // covers exactly what's on screen right now, regardless of any CSS
    // ambiguity upstream.
    function showFullscreenPanel(panel) {
        const w = document.documentElement.clientWidth || document.body.clientWidth || 320;
        const h = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            window.innerHeight || 0,
            400
        );
        panel.style.position = 'fixed';
        panel.style.top = '0px';
        panel.style.left = '0px';
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
        panel.style.bottom = 'auto';
        panel.style.right = 'auto';
        panel.classList.add('visible');
    }

    document.getElementById('open-resume-history').addEventListener('click', () => {
        showFullscreenPanel(resumePanel);
        loadResumeHistory();
    });

    document.getElementById('rp-close-btn').addEventListener('click', () => {
        resumePanel.classList.remove('visible');
    });

    document.getElementById('rp-settings-btn').addEventListener('click', () => {
        openResumeSettings();
    });

    document.getElementById('rp-recap-btn').addEventListener('click', () => {
        openRecapPanel();
    });

    rpSearchInput.addEventListener('input', () => {
        renderVideoList(rpSearchInput.value.trim().toLowerCase());
    });

    function loadResumeHistory() {
        chrome.storage.local.get(['ytProVideos', 'resumeSettings'], (data) => {
            const settings = data.resumeSettings || { deleteAfter: 0 };
            const now = Date.now();
            allVideos = (data.ytProVideos || []).filter(v => {
                if (!v.timestamp) return true;
                if (!settings.deleteAfter) return true; // 0 = Never
                const daysDiff = Math.round((now - v.timestamp) / 86400000);
                return daysDiff <= settings.deleteAfter;
            }).reverse(); // Most recent first
            renderVideoList('');
        });
    }

    // ── Date grouping helper ──────────────────────────────────────────────
    function groupVideosByDate(videos) {
        const now   = Date.now();
        const todayStart     = new Date(); todayStart.setHours(0,0,0,0);
        const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(todayStart.getDate() - 1);
        const weekStart      = new Date(todayStart); weekStart.setDate(todayStart.getDate() - 6);
        const monthStart     = new Date(todayStart); monthStart.setDate(todayStart.getDate() - 29);

        const groups = { 'Today': [], 'Yesterday': [], 'This Week': [], 'This Month': [], 'Older': [] };
        videos.forEach(v => {
            const ts = v.timestamp || 0;
            if      (ts >= todayStart.getTime())     groups['Today'].push(v);
            else if (ts >= yesterdayStart.getTime()) groups['Yesterday'].push(v);
            else if (ts >= weekStart.getTime())      groups['This Week'].push(v);
            else if (ts >= monthStart.getTime())     groups['This Month'].push(v);
            else                                     groups['Older'].push(v);
        });
        return groups;
    }

    // ── Virtual scroll constants ──────────────────────────────────────────
    const VS_CARD_HEIGHT   = 78;  // card: 56px thumb + padding + margin
    const VS_HEADER_HEIGHT = 30;  // date group header
    const VS_BUFFER        = 6;   // extra items above/below viewport

    let vsItems     = [];
    let vsScrollRAF = null;

    function buildFlatItems(filtered, useGroups) {
        const items = [];
        if (!useGroups) {
            filtered.forEach(v => items.push({ type: 'card', video: v }));
        } else {
            const groups = groupVideosByDate(filtered);
            ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'].forEach(groupName => {
                if (!groups[groupName].length) return;
                items.push({ type: 'header', label: groupName });
                groups[groupName].forEach(v => items.push({ type: 'card', video: v }));
            });
        }
        return items;
    }

    function vsItemHeight(item) {
        return item.type === 'header' ? VS_HEADER_HEIGHT : VS_CARD_HEIGHT;
    }

    function vsTotalHeight(items) {
        return items.reduce((sum, item) => sum + vsItemHeight(item), 0);
    }

    function vsFirstVisibleIndex(items, scrollTop) {
        let y = 0;
        for (let i = 0; i < items.length; i++) {
            const h = vsItemHeight(items[i]);
            if (y + h > scrollTop) return i;
            y += h;
        }
        return items.length - 1;
    }

    function vsOffsetOf(items, index) {
        let y = 0;
        for (let i = 0; i < index; i++) y += vsItemHeight(items[i]);
        return y;
    }

    function renderVisibleItems() {
        if (!vsItems.length) return;
        const scrollTop  = rpList.scrollTop;
        const viewHeight = rpList.clientHeight || 450;
        const startIdx   = Math.max(0, vsFirstVisibleIndex(vsItems, scrollTop) - VS_BUFFER);
        const endIdx     = Math.min(vsItems.length - 1, vsFirstVisibleIndex(vsItems, scrollTop + viewHeight) + VS_BUFFER);

        const topPad    = vsOffsetOf(vsItems, startIdx);
        const bottomPad = vsTotalHeight(vsItems) - vsOffsetOf(vsItems, endIdx + 1);

        const spacerTop    = rpList.querySelector('.vs-spacer-top');
        const spacerBottom = rpList.querySelector('.vs-spacer-bottom');

        // Remove rendered items, keep spacers
        Array.from(rpList.children).forEach(child => {
            if (!child.classList.contains('vs-spacer-top') && !child.classList.contains('vs-spacer-bottom')) {
                child.remove();
            }
        });

        spacerTop.style.height    = topPad    + 'px';
        spacerBottom.style.height = bottomPad + 'px';

        const frag = document.createDocumentFragment();
        for (let i = startIdx; i <= endIdx; i++) {
            const item = vsItems[i];
            if (item.type === 'header') {
                const hdr = document.createElement('div');
                hdr.className   = 'rp-date-header';
                hdr.textContent = item.label;
                frag.appendChild(hdr);
            } else {
                frag.appendChild(buildVideoCard(item.video));
            }
        }
        spacerTop.after(frag);
    }

    function renderVideoList(query) {
        const filtered = query
            ? allVideos.filter(v =>
                (v.title || '').toLowerCase().includes(query) ||
                (v.channel || '').toLowerCase().includes(query))
            : allVideos;

        if (!filtered.length) {
            rpList.innerHTML = `
                <div class="rp-empty">
                    <span class="rp-empty-icon"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="16" r="13"/><path d="M10 16 H22"/><path d="M10 11 H22"/><path d="M10 21 H17"/></svg></span>
                    ${query ? 'No results found.' : 'No watch history yet.<br>Start watching a YouTube video to build your history!'}
                </div>`;
            vsItems = [];
            return;
        }

        vsItems = buildFlatItems(filtered, !query);
        rpList.innerHTML = '<div class="vs-spacer-top" style="height:0"></div><div class="vs-spacer-bottom" style="height:0"></div>';
        renderVisibleItems();

        rpList.onscroll = () => {
            if (vsScrollRAF) cancelAnimationFrame(vsScrollRAF);
            vsScrollRAF = requestAnimationFrame(renderVisibleItems);
        };
    }

    function buildVideoCard(video) {
        const watchId    = extractWatchID(video.videolink);
        const thumbUrl   = `https://img.youtube.com/vi/${watchId}/mqdefault.jpg`;
        const progress   = video.duration > 0 ? Math.min(video.time / video.duration, 1) : 0;
        const timeStr    = formatTime(video.time);
        const durStr     = formatTime(video.duration);
        const isComplete = video.complete === true;

        const card = document.createElement('a');
        card.className   = 'rp-video-card';
        card.href        = video.videolink;
        card.target      = '_blank';
        card.title       = video.title || '';

        const wCount = video.watchCount || 1;
        card.innerHTML = `
            <img class="rp-thumb" src="${thumbUrl}" alt="" loading="lazy">
            <div class="rp-info">
                <div class="rp-title">${escapeHtml(video.title || 'Untitled')}</div>
                <div class="rp-channel">${escapeHtml(video.channel || '')}</div>
                <div class="rp-time-row">
                    ${isComplete
                        ? `<span class="rp-complete-badge">Completed</span>`
                        : `<span class="rp-time">${timeStr}</span>`
                    }
                    <span class="rp-duration">${durStr}</span>
                </div>
            </div>
            <div class="rp-right-col">
                <span class="rp-watch-count" title="Times played">${wCount}×</span>
                <button class="rp-delete-btn" data-id="${watchId}" title="Remove">Remove</button>
            </div>
            <div class="rp-progress-wrap">
                <div class="rp-progress-bar" style="width:${(progress * 100).toFixed(1)}%;${isComplete ? 'background:#4caf50;' : ''}"></div>
            </div>`;

        // Delete button
        card.querySelector('.rp-delete-btn').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            deleteVideo(watchId);
            allVideos = allVideos.filter(v => extractWatchID(v.videolink) !== watchId);
            vsItems   = vsItems.filter(item => !(item.type === 'card' && extractWatchID(item.video.videolink) === watchId));
            if (!allVideos.length) { renderVideoList(''); return; }
            renderVisibleItems();
        });

        return card;
    }

    function deleteVideo(watchId) {
        chrome.storage.local.get('ytProVideos', (data) => {
            const videos = (data.ytProVideos || []).filter(v => extractWatchID(v.videolink) !== watchId);
            chrome.storage.local.set({ ytProVideos: videos });
        });
    }

    // ── Recap Panel ─────────────────────────────────────────────────────────
    // Same idea as showFullscreenPanel, but for panels that should cover
    // their parent panel (e.g. recap / resume-settings, nested inside the
    // already-sized #resume-panel) rather than the whole popup.
    function showSubPanel(panel, hostPanel) {
        const rect = hostPanel.getBoundingClientRect();
        panel.style.position = 'absolute';
        panel.style.top = '0px';
        panel.style.left = '0px';
        panel.style.width = rect.width + 'px';
        panel.style.height = rect.height + 'px';
        panel.style.bottom = 'auto';
        panel.style.right = 'auto';
        panel.classList.add('visible');
    }

    function openRecapPanel() {
        chrome.storage.local.get('ytProVideos', (data) => {
            const videos = data.ytProVideos || [];

            // Top 5 videos by watchCount
            const topVideos = [...videos]
                .filter(v => v.title)
                .sort((a, b) => (b.watchCount || 1) - (a.watchCount || 1))
                .slice(0, 5);

            // Top 5 channels by distinct video count
            const channelMap = {};
            videos.forEach(v => {
                const ch = (v.channel || '').trim();
                if (!ch) return;
                if (!channelMap[ch]) channelMap[ch] = { count: 0, watchCount: 0 };
                channelMap[ch].count++;
                channelMap[ch].watchCount += (v.watchCount || 1);
            });
            const topChannels = Object.entries(channelMap)
                .sort((a, b) => b[1].watchCount - a[1].watchCount)
                .slice(0, 5);

            renderRecapPanel(topVideos, topChannels, videos.length);
        });
        showSubPanel(recapPanel, resumePanel);
    }

    function renderRecapPanel(topVideos, topChannels, totalCount) {
        const videosEl   = document.getElementById('recap-videos-list');
        const channelsEl = document.getElementById('recap-channels-list');
        const totalEl    = document.getElementById('recap-total');

        if (totalEl) totalEl.textContent = `${totalCount} video${totalCount !== 1 ? 's' : ''} in your history`;

        // Render top videos
        if (!topVideos.length) {
            videosEl.innerHTML = '<div class="recap-empty">No data yet — start watching!</div>';
        } else {
            videosEl.innerHTML = '';
            const maxVCount = Math.max(...topVideos.map(v => v.watchCount || 1));
            topVideos.forEach((v, i) => {
                const watchId = extractWatchID(v.videolink);
                const thumb   = `https://img.youtube.com/vi/${watchId}/mqdefault.jpg`;
                const count   = v.watchCount || 1;
                const pct     = Math.max(10, Math.round((count / maxVCount) * 100));
                const row     = document.createElement('a');
                row.className = `recap-row${i < 3 ? ' rank-' + (i + 1) : ''}`;
                row.href      = v.videolink;
                row.target    = '_blank';
                row.innerHTML = `
                    <span class="recap-rank">${i < 3 ? ['🥇','🥈','🥉'][i] : '#' + (i + 1)}</span>
                    <img class="recap-thumb" src="${thumb}" alt="">
                    <div class="recap-info">
                        <div class="recap-title">${escapeHtml(v.title || 'Untitled')}</div>
                        <div class="recap-channel">${escapeHtml(v.channel || '')}</div>
                        <div class="recap-bar-track"><div class="recap-bar-fill" style="width:${pct}%"></div></div>
                    </div>
                    <span class="recap-count">${count}×</span>`;
                videosEl.appendChild(row);
            });
        }

        // Render top channels
        if (!topChannels.length) {
            channelsEl.innerHTML = '<div class="recap-empty">No channels found yet.</div>';
        } else {
            channelsEl.innerHTML = '';
            const avatarPairs = [
                ['#f43f5e','#f59e0b'], ['#7c7bff','#2dd9f0'], ['#22c55e','#0ea5e9'],
                ['#f59e0b','#ec4899'], ['#8b5cf6','#22d3ee']
            ];
            topChannels.forEach(([ch, stats], i) => {
                const row = document.createElement('div');
                row.className = `recap-channel-row${i < 3 ? ' rank-' + (i + 1) : ''}`;
                const initial = (ch.trim()[0] || '?');
                const [av1, av2] = avatarPairs[i % avatarPairs.length];
                row.innerHTML = `
                    <span class="recap-rank">${i < 3 ? ['🥇','🥈','🥉'][i] : '#' + (i + 1)}</span>
                    <div class="recap-avatar" style="--av-a:${av1};--av-b:${av2}">${escapeHtml(initial)}</div>
                    <div class="recap-info">
                        <div class="recap-title">${escapeHtml(ch)}</div>
                        <div class="recap-channel">${stats.count} video${stats.count !== 1 ? 's' : ''} watched</div>
                    </div>
                    <span class="recap-count">${stats.watchCount}×</span>`;
                channelsEl.appendChild(row);
            });
        }
    }

    document.getElementById('recap-back-btn').addEventListener('click', () => {
        recapPanel.classList.remove('visible');
    });

    // ── Toast helper ────────────────────────────────────────────────────────
    let toastTimer = null;
    function showToast(text) {
        const toastEl     = document.getElementById('yt-pro-toast');
        const toastTextEl = document.getElementById('yt-pro-toast-text');
        if (!toastEl) return;
        toastTextEl.textContent = text;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
    }

    // ── Recap → Downloadable PNG Card ───────────────────────────────────────
    // Renders a shareable stats card (canvas → PNG) covering the user's
    // watch history from the first recorded video up to "now".
    function truncateText(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let out = text;
        while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
            out = out.slice(0, -1);
        }
        return out + '…';
    }

    function roundRectPath(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function formatCardDate(d) {
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    // Loads an <img> for use inside the canvas. Uses crossOrigin so the
    // canvas isn't tainted (YouTube's img.youtube.com CDN serves permissive
    // CORS headers), and resolves with null on any failure so a single
    // missing thumbnail never breaks the whole card.
    function loadCanvasImage(src) {
        return new Promise(resolve => {
            if (!src) { resolve(null); return; }
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload  = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function drawThumb(ctx, img, x, y, w, h, r) {
        roundRectPath(ctx, x, y, w, h, r);
        ctx.save();
        ctx.clip();
        if (img) {
            // Cover-fit crop
            const scale = Math.max(w / img.width, h / img.height);
            const dw = img.width * scale, dh = img.height * scale;
            ctx.drawImage(img, x - (dw - w) / 2, y - (dh - h) / 2, dw, dh);
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fillRect(x, y, w, h);
        }
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        roundRectPath(ctx, x, y, w, h, r);
        ctx.stroke();
    }

    async function buildRecapCardBlob(range) {
        const data     = await new Promise(r => chrome.storage.local.get('ytProVideos', r));
        const allVideos = data.ytProVideos || [];

        // Filter by the requested date range (if any). Videos without a
        // usable timestamp are only kept when no range filter is active.
        let videos = allVideos;
        let startDate = null, endDate = new Date();
        if (range && (range.from || range.to)) {
            const fromMs = range.from ? range.from.getTime() : -Infinity;
            const toMs   = range.to ? range.to.getTime() : Infinity;
            videos = allVideos.filter(v => typeof v.timestamp === 'number' && v.timestamp >= fromMs && v.timestamp <= toMs);
            startDate = range.from || null;
            endDate   = range.to || new Date();
        } else {
            const timestamps = allVideos.map(v => v.timestamp).filter(t => typeof t === 'number' && t > 0);
            startDate = timestamps.length ? new Date(Math.min(...timestamps)) : null;
            endDate   = new Date();
        }

        const topVideos = [...videos]
            .filter(v => v.title)
            .sort((a, b) => (b.watchCount || 1) - (a.watchCount || 1))
            .slice(0, 5);

        const channelMap = {};
        videos.forEach(v => {
            const ch = (v.channel || '').trim();
            if (!ch) return;
            if (!channelMap[ch]) channelMap[ch] = { count: 0, watchCount: 0 };
            channelMap[ch].count++;
            channelMap[ch].watchCount += (v.watchCount || 1);
        });
        const topChannels = Object.entries(channelMap)
            .sort((a, b) => b[1].watchCount - a[1].watchCount)
            .slice(0, 5);

        // Pre-load video thumbnails so they're ready before we draw the frame.
        const thumbImgs = await Promise.all(topVideos.map(v => {
            const watchId = extractWatchID(v.videolink);
            return loadCanvasImage(watchId ? `https://img.youtube.com/vi/${watchId}/mqdefault.jpg` : null);
        }));

        // ── Layout pass: figure out how tall the card needs to be before we
        // create the canvas, so the footer never overlaps the content list. ──
        const ROW_H = 74, ROW_GAP = 14, ROW_STEP = ROW_H + ROW_GAP;
        const SECTION_TITLE_H = 56;
        let contentBottom = 430;
        if (topVideos.length) contentBottom += SECTION_TITLE_H + topVideos.length * ROW_STEP + 16;
        if (topChannels.length) contentBottom += SECTION_TITLE_H + topChannels.length * ROW_STEP;
        if (!topVideos.length && !topChannels.length) contentBottom += 60;
        const FOOTER_H = 140;
        const W = 1080;
        const H = Math.max(900, contentBottom + FOOTER_H);

        // Load the extension logo (bundled asset — same-origin, won't taint the canvas).
        const logoImg = await new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = chrome.runtime.getURL('imgs/icon128.png');
        });

        // ── Canvas setup ──────────────────────────────────────────────────
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');

        // Background
        const bg = ctx.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, '#0a0a12');
        bg.addColorStop(1, '#111120');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        const glow = (x, y, r, color) => {
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, color);
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
        };
        glow(120, 40, 620, 'rgba(244,63,94,0.22)');
        glow(W - 60, 60, 620, 'rgba(34,211,238,0.20)');
        glow(W / 2, H, 700, 'rgba(245,158,11,0.10)');

        ctx.textBaseline = 'alphabetic';

        // Header — logo + wordmark
        const logoSize = 56, logoX = 64, logoY = 50;
        if (logoImg) {
            roundRectPath(ctx, logoX, logoY, logoSize, logoSize, 14);
            ctx.save();
            ctx.clip();
            ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
            ctx.restore();
        }
        const headerTextX = logoImg ? logoX + logoSize + 18 : 64;

        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '600 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText('YOUTUBE PRO PLUS', headerTextX, logoY + 24);

        const titleGrad = ctx.createLinearGradient(64, 0, 780, 0);
        titleGrad.addColorStop(0, '#ffffff');
        titleGrad.addColorStop(0.6, '#67e8f9');
        titleGrad.addColorStop(1, '#fbbf24');
        ctx.fillStyle = titleGrad;
        ctx.font = '800 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText('My Recap', headerTextX, logoY + logoSize + 8);

        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.font = '500 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        const rangeText = startDate
            ? `${formatCardDate(startDate)}  →  ${formatCardDate(endDate)}`
            : `As of ${formatCardDate(endDate)}`;
        ctx.fillText(rangeText, 64, 224);

        // Big total-videos stat pill
        roundRectPath(ctx, 64, 256, W - 128, 120, 22);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = '800 56px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(String(videos.length), 96, 336);
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '600 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        const totalLabel = `video${videos.length !== 1 ? 's' : ''} watched`;
        ctx.font = '800 56px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        const bigNumW = ctx.measureText(String(videos.length)).width;
        ctx.font = '600 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(totalLabel, 96 + bigNumW + 18, 330);

        // ── Section renderer (shared by videos + channels) ─────────────────
        const medalColors = [['#fde68a', '#f59e0b'], ['#e5e7eb', '#9ca3af'], ['#fdba74', '#b45309']];
        let y = 430;

        const sectionTitle = (label) => {
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.font = '700 30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
            ctx.fillText(label, 64, y);
            y += 24;
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath(); ctx.moveTo(64, y); ctx.lineTo(W - 64, y); ctx.stroke();
            y += 32;
        };

        const rowBg = (rowY, rowH) => {
            roundRectPath(ctx, 64, rowY, W - 128, rowH, 14);
            ctx.fillStyle = 'rgba(255,255,255,0.035)';
            ctx.fill();
        };

        // Draws a solid rank badge for every position — top-3 get a
        // gold/silver/bronze gradient, the rest a themed gradient — so the
        // rank is always visible regardless of the system's emoji font.
        const rankBadge = (cx, cy, i, colorA, colorB) => {
            const [ga, gb] = i < 3 ? medalColors[i] : [colorA, colorB];
            ctx.beginPath();
            ctx.arc(cx, cy, 20, 0, Math.PI * 2);
            const g = ctx.createLinearGradient(cx - 20, cy - 20, cx + 20, cy + 20);
            g.addColorStop(0, ga); g.addColorStop(1, gb);
            ctx.fillStyle = g;
            ctx.fill();
            ctx.fillStyle = i < 3 ? '#1a1206' : '#ffffff';
            ctx.font = '700 18px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('#' + (i + 1), cx, cy + 6);
            ctx.textAlign = 'left';
        };

        // Top videos
        if (topVideos.length) {
            sectionTitle('Top Videos');
            topVideos.forEach((v, i) => {
                const rowH = 74, rowY = y;
                rowBg(rowY, rowH);
                rankBadge(104, rowY + rowH / 2, i, '#f43f5e', '#f59e0b');

                const thumbW = 96, thumbH = 54, thumbX = 140, thumbY = rowY + (rowH - thumbH) / 2;
                drawThumb(ctx, thumbImgs[i], thumbX, thumbY, thumbW, thumbH, 8);
                const textX = thumbX + thumbW + 18;

                ctx.fillStyle = '#f1f1f6';
                ctx.font = '700 25px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
                ctx.fillText(truncateText(ctx, v.title || 'Untitled', 560), textX, rowY + 32);

                ctx.fillStyle = 'rgba(255,255,255,0.55)';
                ctx.font = '500 21px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
                ctx.fillText(truncateText(ctx, v.channel || '', 440), textX, rowY + 60);

                ctx.fillStyle = '#67e8f9';
                ctx.font = '700 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
                const countTxt = `${v.watchCount || 1}×`;
                ctx.fillText(countTxt, W - 64 - 20 - ctx.measureText(countTxt).width, rowY + rowH / 2 + 8);

                y += rowH + 14;
            });
            y += 16;
        }

        // Top channels
        if (topChannels.length) {
            sectionTitle('Top Channels');
            const avatarPairs = [['#f43f5e','#f59e0b'], ['#7c7bff','#2dd9f0'], ['#22c55e','#0ea5e9'], ['#f59e0b','#ec4899'], ['#8b5cf6','#22d3ee']];
            topChannels.forEach(([ch, stats], i) => {
                const rowH = 74, rowY = y;
                rowBg(rowY, rowH);
                rankBadge(104, rowY + rowH / 2, i, '#7c7bff', '#2dd9f0');

                const avR = 24, avCx = 140 + avR, avCy = rowY + rowH / 2;
                const [av1, av2] = avatarPairs[i % avatarPairs.length];
                ctx.beginPath();
                ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
                const avg = ctx.createLinearGradient(avCx - avR, avCy - avR, avCx + avR, avCy + avR);
                avg.addColorStop(0, av1); avg.addColorStop(1, av2);
                ctx.fillStyle = avg;
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = '700 22px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText((ch.trim()[0] || '?').toUpperCase(), avCx, avCy + 8);
                ctx.textAlign = 'left';
                const textX = 140 + avR * 2 + 18;

                ctx.fillStyle = '#f1f1f6';
                ctx.font = '700 25px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
                ctx.fillText(truncateText(ctx, ch, 520), textX, rowY + 32);

                ctx.fillStyle = 'rgba(255,255,255,0.55)';
                ctx.font = '500 21px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
                ctx.fillText(`${stats.count} video${stats.count !== 1 ? 's' : ''} watched`, textX, rowY + 60);

                ctx.fillStyle = '#67e8f9';
                ctx.font = '700 24px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
                const countTxt = `${stats.watchCount}×`;
                ctx.fillText(countTxt, W - 64 - 20 - ctx.measureText(countTxt).width, rowY + rowH / 2 + 8);

                y += rowH + 14;
            });
        }

        if (!topVideos.length && !topChannels.length) {
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.font = '500 26px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
            ctx.fillText('No watch data yet — start watching!', 64, y + 20);
        }

        // Footer
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath(); ctx.moveTo(64, H - 76); ctx.lineTo(W - 64, H - 76); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '500 20px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText('Generated with YouTube Pro Plus', 64, H - 40);
        const genTxt = formatCardDate(endDate);
        ctx.fillText(genTxt, W - 64 - ctx.measureText(genTxt).width, H - 40);

        return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    }

    // Triggers the actual canvas → PNG build + file download, then toasts.
    async function generateAndDownloadRecap(range, triggerBtn) {
        const prevHTML = triggerBtn ? triggerBtn.innerHTML : null;
        if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = 'Generating…'; }
        try {
            const blob = await buildRecapCardBlob(range);
            if (!blob) throw new Error('canvas produced no blob');
            const url = URL.createObjectURL(blob);
            const stamp = new Date().toISOString().slice(0, 10);
            const a = document.createElement('a');
            a.href = url;
            a.download = `youtube-recap-${stamp}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            showToast('Recap downloaded ✓');
            return true;
        } catch (err) {
            console.error('[YT-Pro] Recap PNG generation failed:', err);
            showToast('Couldn\'t generate recap — try again');
            return false;
        } finally {
            if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.innerHTML = prevHTML; }
        }
    }

    // ── Recap → Date Range Panel ────────────────────────────────────────────
    const recapRangePanel   = document.getElementById('recap-range-panel');
    const recapRangeFrom    = document.getElementById('recap-range-from');
    const recapRangeTo      = document.getElementById('recap-range-to');
    const recapRangeError   = document.getElementById('recap-range-error');
    const recapRangeGenBtn  = document.getElementById('recap-range-generate-btn');
    const recapRangePresets = document.getElementById('recap-range-presets');

    function toDateInputValue(d) {
        return d.toISOString().slice(0, 10);
    }

    function setActivePreset(days) {
        recapRangePresets.querySelectorAll('.recap-range-preset').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.preset === String(days));
        });
    }

    recapRangePresets.addEventListener('click', (e) => {
        const btn = e.target.closest('.recap-range-preset');
        if (!btn) return;
        const preset = btn.dataset.preset;
        const today = new Date();
        if (preset === 'all') {
            recapRangeFrom.value = '';
            recapRangeTo.value = '';
        } else {
            const from = new Date(today);
            from.setDate(from.getDate() - Number(preset));
            recapRangeFrom.value = toDateInputValue(from);
            recapRangeTo.value   = toDateInputValue(today);
        }
        recapRangeError.textContent = '';
        setActivePreset(preset);
    });

    [recapRangeFrom, recapRangeTo].forEach(input => {
        input.addEventListener('input', () => setActivePreset(null));
    });

    const recapDownloadBtn = document.getElementById('recap-download-btn');
    if (recapDownloadBtn) {
        recapDownloadBtn.addEventListener('click', () => {
            recapRangeFrom.value = '';
            recapRangeTo.value = '';
            recapRangeError.textContent = '';
            setActivePreset('all');
            showSubPanel(recapRangePanel, recapPanel);
        });
    }

    document.getElementById('recap-range-back-btn').addEventListener('click', () => {
        recapRangePanel.classList.remove('visible');
    });

    recapRangeGenBtn.addEventListener('click', async () => {
        const fromVal = recapRangeFrom.value;
        const toVal   = recapRangeTo.value;

        let from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
        let to   = toVal ? new Date(toVal + 'T23:59:59') : null;

        if (from && to && from > to) {
            recapRangeError.textContent = 'The "From" date must be before the "To" date.';
            return;
        }
        recapRangeError.textContent = '';

        const ok = await generateAndDownloadRecap({ from, to }, recapRangeGenBtn);
        if (ok) recapRangePanel.classList.remove('visible');
    });

    // ── Resume Settings Sub-panel ───────────────────────────────────────────
    function openResumeSettings() {
        chrome.storage.local.get('resumeSettings', (data) => {
            const s = data.resumeSettings || {
                pauseResume: false, minWatchTime: 60,
                minVideoLength: 120, markPlayedTime: 10, deleteAfter: 0
            };
            document.getElementById('rsp-pause-toggle').checked = !s.pauseResume;
            document.getElementById('rsp-min-length').value     = Math.round(s.minVideoLength / 60);
            document.getElementById('rsp-min-watch').value      = Math.round(s.minWatchTime / 60);
            document.getElementById('rsp-mark-played').value    = s.markPlayedTime;   // seconds, not minutes
            // Snap stored value to nearest dropdown option (handles old arbitrary day values)
            const storedDays = s.deleteAfter !== undefined ? s.deleteAfter : 0;
            const options = [180, 365, 1095, 0];
            const closest = options.reduce((prev, curr) =>
                Math.abs(curr - storedDays) < Math.abs(prev - storedDays) ? curr : prev
            );
            document.getElementById('rsp-delete-after').value = closest;
        });
        showSubPanel(resumeSettingsPanel, resumePanel);
        document.getElementById('rsp-saved-msg').classList.remove('show');
    }

    document.getElementById('rsp-back-btn').addEventListener('click', () => {
        resumeSettingsPanel.classList.remove('visible');
        loadResumeHistory(); // Always reload from storage when returning to list
    });

    document.getElementById('rsp-save-btn').addEventListener('click', () => {
        const newSettings = {
            pauseResume:    !document.getElementById('rsp-pause-toggle').checked,
            minVideoLength: parseInt(document.getElementById('rsp-min-length').value || 2) * 60,
            minWatchTime:   parseInt(document.getElementById('rsp-min-watch').value  || 1) * 60,
            markPlayedTime: parseInt(document.getElementById('rsp-mark-played').value || 10), // already in seconds
            deleteAfter:    parseInt(document.getElementById('rsp-delete-after').value, 10)
        };
        chrome.storage.local.set({ resumeSettings: newSettings }, () => {
            const msg = document.getElementById('rsp-saved-msg');
            msg.classList.add('show');
            setTimeout(() => msg.classList.remove('show'), 2000);
        });
    });

    // ── Backup & Restore ────────────────────────────────────────────────────
    document.getElementById('rsp-backup-btn').addEventListener('click', () => {
        chrome.storage.local.get(['ytProVideos', 'resumeSettings'], (data) => {
            // Sort oldest-first — matches internal storage order (loadResumeHistory reverses to show newest first)
            const sortedVideos = (data.ytProVideos || [])
                .slice()
                .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
                .map(v => ({
                    title:              v.title || '',
                    channel:            v.channel || '',
                    videolink:          v.videolink || '',
                    watchedDate:        v.timestamp ? new Date(v.timestamp).toLocaleString() : '',
                    timesWatched:       v.watchCount || 1,
                    resumeTime:         formatTime(v.time),
                    totalDuration:      formatTime(v.duration),
                    resumeSeconds:      v.time || 0,
                    durationSeconds:    v.duration || 0,
                    complete:           v.complete || false,
                    doNotResume:        v.doNotResume || false,
                    timestamp:          v.timestamp || 0
                }));

            const backup = {
                version:        2,
                exportedAt:     new Date().toISOString(),
                totalVideos:    sortedVideos.length,
                ytProVideos:    sortedVideos,
                resumeSettings: data.resumeSettings || {}
            };
            const json = JSON.stringify(backup, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const date = new Date().toISOString().slice(0, 10);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `ytpro-backup-${date}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            const msg = document.getElementById('rsp-backup-msg');
            msg.textContent = `Backed up ${sortedVideos.length} videos!`;
            msg.classList.add('show');
            setTimeout(() => msg.classList.remove('show'), 3000);
        });
    });

    // Restore button — opens a dedicated tab to avoid Firefox popup-closes-on-file-dialog bug
    document.getElementById('rsp-restore-btn').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('restore-page.html') });
    });

    // When restore-page.html finishes writing storage, reload history here
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'restoreComplete') {
            loadResumeHistory();
            rpList.scrollTop = 0;
            const msg = document.getElementById('rsp-backup-msg');
            msg.textContent = 'Restore complete. History reloaded.';
            msg.classList.add('show');
            setTimeout(() => msg.classList.remove('show'), 4000);
        }
    });

    // ── Utility functions ───────────────────────────────────────────────────
    function extractWatchID(link) {
        if (!link) return '';
        const m = link.match(/[?&]v=([^&#]+)/);
        return m ? m[1] : '';
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const s = Math.floor(seconds);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        const pad = n => n < 10 ? '0' + n : '' + n;
        return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
    }

    function escapeHtml(str) {
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Info tooltip (i) buttons ─────────────────────────────────────────────
    const tipBox   = document.getElementById('info-tooltip-box');
    const tipTitle = document.getElementById('info-tooltip-title');
    const tipBody  = document.getElementById('info-tooltip-body');

    const tipContent = {
        theme: {
            title: 'Note from the developer',
            body:  "I know about all UI bugs. YouTube constantly changes its code — when I fix one thing, 2 more break the next day. It's a constant back-and-forth. As a solo dev I can't chase every change instantly. Thanks for your patience!"
        },
        ambient: {
            title: 'Dark Mode Only',
            body:  'This only works with dark mode. Change your browser theme to dark mode to use this feature.'
        },
        cinematic: {
            title: 'Cinematic Mode',
            body:  'This feature works in both Light & Dark mode of YouTube. If using Dark Mode, you must turn off Ambient Mode from YouTube player settings and from this panel — otherwise Cinematic Mode will not work as expected.'
        },
        download: {
            title: ' Premium Users — Important',
            body:  'Smart Download and the Built-in Downloader can\'t both be on — turning this on switches Built-in Downloader off automatically. If you are a YouTube Premium subscriber, keep Smart Download turned OFF. This feature uses a third-party downloader and may conflict with YouTube Premium\'s built-in download feature.'
        },
        screenshot: {
            title: 'Video Screenshot',
            body:  'Adds a camera button to the player and the Alt+Shift+S shortcut. Captures only the video frame itself — no controls, no overlays. If the video is playing it pauses for the capture, then resumes automatically.'
        },
        watchparty: {
            title: 'Watch Party',
            body:  'Adds a Watch Party button next to Create in the YouTube header. Create a room to host and share the code, or join a room to follow along — only the host controls playback. Turn this off to remove the button entirely.'
        },
        miniplayer: {
            title: 'Auto Mini Player',
            body:  'Automatically shrinks the video into a small floating window you can drag anywhere once you scroll past the player, then restores it to normal size when you scroll back up. Turn this off to disable the auto-shrink behavior.'
        },
        returnDislike: {
            title: 'Return Youtube Dislike',
            body:  'Brings back the dislike count next to Like on every video, powered by the community-run returnyoutubedislike.com API. Turn this off to stop the extra network request and hide the count again.'
        },
        sponsorblock: {
            title: 'SponsorBlock',
            body:  'Automatically skips sponsor segments, intros, outros, self-promo, previews, and interaction reminders using the community-run SponsorBlock database (sponsor.ajay.app) — no separate extension needed. A small marker appears on the seek bar for each skipped section, and a toast shows what was skipped. This is skip-only — it doesn\'t submit new segments.'
        },
        'builtin-downloader': {
            title: 'Built-in Downloader',
            body:  'Opens a separate downloader window that fetches video/audio directly from YouTube (no third-party site). Pick a video, choose a format and quality, and it downloads straight to your device. This is on by default. It can\'t be on at the same time as Smart Download — turning this on switches Smart Download off automatically. Use the switch to turn the whole service off.'
        }
    };

    document.querySelectorAll('.info-btn[data-tip]').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            const key = btn.getAttribute('data-tip');
            const content = tipContent[key];
            if (content && tipBox && tipTitle && tipBody) {
                const titleTextNode = tipTitle.lastChild;
                if (titleTextNode && titleTextNode.nodeType === 3) {
                    titleTextNode.textContent = content.title;
                } else {
                    tipTitle.appendChild(document.createTextNode(content.title));
                }
                tipBody.textContent  = content.body;
                tipBox.style.visibility = 'visible';
                tipBox.style.opacity    = '1';
            }
        });
        btn.addEventListener('mouseleave', () => {
            if (tipBox) {
                tipBox.style.opacity    = '0';
                tipBox.style.visibility = 'hidden';
            }
        });
    });

    // ── Report an Issue Panel ────────────────────────────────────────────────
    const reportPanel     = document.getElementById('report-panel');
    const reportCloseBtn  = document.getElementById('report-close-btn');
    const reportFileInput = document.getElementById('report-file-input');
    const reportPreview   = document.getElementById('report-preview-grid');
    const reportSubmitBtn = document.getElementById('report-submit-btn');
    const reportStatus    = document.getElementById('report-status');

    let reportImageFiles = [];

    document.getElementById('open-report-panel').addEventListener('click', () => {
        showFullscreenPanel(reportPanel);
        reportStatus.textContent = '';
        reportStatus.className   = '';
    });

    reportCloseBtn.addEventListener('click', () => {
        reportPanel.classList.remove('visible');
    });

    reportFileInput.addEventListener('change', () => {
        Array.from(reportFileInput.files).forEach(file => {
            if (reportImageFiles.length >= 3 || !file.type.startsWith('image/')) return;
            reportImageFiles.push(file);
        });
        reportFileInput.value = '';
        renderReportPreviews();
    });

    function renderReportPreviews() {
        reportPreview.innerHTML = '';
        reportImageFiles.forEach((file, idx) => {
            const url  = URL.createObjectURL(file);
            const item = document.createElement('div');
            item.className = 'report-preview-item';
            const img  = document.createElement('img');
            img.src    = url;
            img.onload = () => URL.revokeObjectURL(url);
            const rmBtn = document.createElement('button');
            rmBtn.className   = 'report-preview-remove';
            rmBtn.textContent = '×';
            rmBtn.addEventListener('click', () => {
                reportImageFiles.splice(idx, 1);
                renderReportPreviews();
            });
            item.appendChild(img);
            item.appendChild(rmBtn);
            reportPreview.appendChild(item);
        });
        const uploadArea = document.getElementById('report-upload-area');
        if (uploadArea) uploadArea.style.display = reportImageFiles.length >= 3 ? 'none' : '';
    }

    reportSubmitBtn.addEventListener('click', async () => {
        const name    = (document.getElementById('report-name').value    || '').trim();
        const message = (document.getElementById('report-message').value || '').trim();

        if (!message) {
            reportStatus.className   = 'error';
            reportStatus.textContent = '\u26a0\ufe0f Please describe the issue before sending.';
            return;
        }

        reportSubmitBtn.disabled   = true;
        reportStatus.className     = '';
        reportStatus.textContent   = '\ud83d\udce4 Sending\u2026';

        try {
            // Upload each screenshot to catbox.moe (free, anonymous, permanent hosting).
            // Gmail blocks data: URLs but renders normal https:// image links fine.
            const uploadToCatbox = async (file) => {
                const fd = new FormData();
                fd.append('reqtype',     'fileupload');
                fd.append('fileToUpload', file, file.name || 'screenshot.jpg');
                const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
                if (!r.ok) throw new Error('catbox upload failed: ' + r.status);
                const url = (await r.text()).trim();
                if (!url.startsWith('https://')) throw new Error('Bad catbox response: ' + url);
                return url;
            };

            let screenshotHtml = '';
            if (reportImageFiles.length > 0) {
                const urls = await Promise.all(reportImageFiles.map(uploadToCatbox));
                const imgTags = urls.map((url, i) =>
                    `<div style="margin:8px 0;"><strong>Screenshot ${i + 1}</strong><br><a href="${url}"><img src="${url}" alt="Screenshot ${i + 1}" style="max-width:600px;display:block;border:1px solid #ccc;border-radius:4px;margin-top:4px;"></a></div>`
                ).join('');
                screenshotHtml = `<br><br><hr style="border:none;border-top:1px solid #ccc;margin:12px 0;"><strong>Screenshots (${urls.length})</strong><br><br>${imgTags}`;
            }

            const formData = new FormData();
            formData.append('Name',    name || 'Anonymous');
            formData.append('Message', message + screenshotHtml);
            formData.append('Browser', navigator.userAgent);

            const res  = await fetch('https://formbold.com/s/3A7PM', {
                method: 'POST',
                body:   formData
            });

            if (res.ok) {
                reportStatus.className   = 'success';
                reportStatus.textContent = '\u2705 Report sent! We will look into it soon. Thank you!';
                document.getElementById('report-name').value    = '';
                document.getElementById('report-message').value = '';
                reportImageFiles = [];
                renderReportPreviews();
                // Clean up any leftover download grid from previous attempts
                const oldGrid = document.getElementById('report-download-grid');
                if (oldGrid) oldGrid.remove();
            } else {
                throw new Error('Server returned ' + res.status);
            }
        } catch (err) {
            reportStatus.className   = 'error';
            reportStatus.textContent = '\u274c Failed to send. Check your internet and try again.';
            console.error('[Report] Error:', err);
        }

        reportSubmitBtn.disabled = false;
    });
    // ─────────────────────────────────────────────────────────────────────────
});


// ─── Update Banner + Instructions Panel ──────────────────────────────────────
// Reads the updateAvailable flag set by the background service worker.
// Shows a dismissable top banner; "How to Update" opens a step-by-step panel
// that guides the user to overwrite their existing folder (preserving storage).

(function () {
    const banner        = document.getElementById('update-banner');
    const versionSpan   = document.getElementById('update-banner-version');
    const downloadBtn   = document.getElementById('update-banner-btn');
    const dismissBtn    = document.getElementById('update-banner-dismiss');

    if (!banner) return;

    const DOWNLOAD_URL = 'https://github.com/Archimetrix/Youtube-Pro-Plus/archive/refs/heads/main.zip';

    chrome.storage.local.get(['updateAvailable', 'updateBannerDismissed'], (result) => {
        const info = result.updateAvailable;
        if (!info || !info.version) return;

        // Don't re-show if user already dismissed this exact version
        if (result.updateBannerDismissed === info.version) return;

        // Populate banner with the version number
        versionSpan.textContent = 'v' + info.version;
        banner.classList.add('visible');

        // ── Download button → trigger the ZIP download directly ──
        downloadBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: info.url || DOWNLOAD_URL });
        });

        // ── Dismiss banner — remember per version ──
        dismissBtn.addEventListener('click', () => {
            chrome.storage.local.set({ updateBannerDismissed: info.version });
            banner.classList.remove('visible');
        });
    });
})();


// ─── Manual Update Checker ────────────────────────────────────────────────────
// Lets users trigger an on-demand update check from the "Check for Update"
// button, in addition to the 24-hour automatic background alarm check.

(function () {
    const btn    = document.getElementById('check-update-btn');
    const label  = document.getElementById('check-update-label');
    if (!btn || !label) return;

    const MANIFEST_URL  = 'https://api.github.com/repos/Archimetrix/Youtube-Pro-Plus/contents/manifest.json';
    const DOWNLOAD_URL  = 'https://github.com/Archimetrix/Youtube-Pro-Plus/archive/refs/heads/main.zip';
    let busy = false;

    function isNewerVersion(local, remote) {
        const parse = v => v.split('.').map(n => parseInt(n, 10) || 0);
        const l = parse(local), r = parse(remote);
        for (let i = 0; i < Math.max(l.length, r.length); i++) {
            const a = l[i] || 0, b = r[i] || 0;
            if (b > a) return true;
            if (b < a) return false;
        }
        return false;
    }

    function setState(state, text) {
        btn.classList.remove('is-checking', 'is-uptodate', 'is-found', 'is-error');
        if (state) btn.classList.add(state);
        label.textContent = text;
        btn.disabled = (state === 'is-checking');
    }

    function resetAfter(ms) {
        setTimeout(() => {
            setState(null, 'Check for Update');
            busy = false;
        }, ms);
    }

    function showUpdateBanner(version) {
        // Populate and reveal the top banner
        const banner      = document.getElementById('update-banner');
        const versionSpan = document.getElementById('update-banner-version');
        if (banner && versionSpan) {
            versionSpan.textContent = 'v' + version;
            banner.classList.add('visible');
        }
    }

    btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;

        setState('is-checking', 'Checking…');

        try {
            const res = await fetch(MANIFEST_URL, {
                headers: { 'Accept': 'application/vnd.github.v3.raw' },
                cache: 'no-store'
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const remote       = await res.json();
            const localVersion = chrome.runtime.getManifest().version;

            if (isNewerVersion(localVersion, remote.version)) {
                // Save flag so the automatic banner still works too
                chrome.storage.local.set({
                    updateAvailable:       { version: remote.version, url: DOWNLOAD_URL },
                    updateBannerDismissed: null
                });
                setState('is-found', 'Update Available!');
                // Directly open the ZIP download — no extra steps needed
                chrome.tabs.create({ url: DOWNLOAD_URL });
                resetAfter(3000);
            } else {
                setState('is-uptodate', 'Up to date ✓');
                resetAfter(3000);
            }

        } catch (err) {
            setState('is-error', 'Check failed — retry');
            resetAfter(3000);
        }
    });
})();

// ── Built-in Downloader launcher ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const openDownloaderBtn = document.getElementById('open-builtin-downloader');
    if (openDownloaderBtn) {
        openDownloaderBtn.addEventListener('click', () => {
            if (openDownloaderBtn.disabled) return;
            chrome.windows.create({
                url: chrome.runtime.getURL('downloader-popup.html'),
                type: 'popup',
                width: 420,
                height: 640
            });
        });
    }
});
