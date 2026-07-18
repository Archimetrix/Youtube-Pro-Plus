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

    const toggles = ['theme', 'premium', 'ambient', 'cinematic', 'speed', 'audio', 'autoscroll', 'download', 'fullscreen', 'autoResume', 'screenshot', 'watchparty'];
    const masterToggleBtn = document.getElementById('master-toggle');

    // ── Load all settings ───────────────────────────────────────────────────
    chrome.storage.local.get(['masterEnabled', 'cinematicSettings', ...toggles], (result) => {
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
            const isEnabled = (toggle === 'fullscreen' || toggle === 'cinematic')
                ? result[toggle] === true
                : result[toggle] !== false;
            document.getElementById(`toggle-${toggle}`).checked = isEnabled;
        });

        checkFullscreenHint(result.fullscreen === true);

        // ── Cinematic sub-controls ──────────────────────────────────────────
        const cineSettings = result.cinematicSettings || { blur: 'med', sat: 'med', dim: 'med' };
        initCineControls(cineSettings, result.cinematic === true);
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

            chrome.storage.local.set({ [toggle]: isChecked });

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

            if (['premium', 'ambient', 'cinematic', 'download', 'autoResume', 'screenshot', 'watchparty'].includes(toggle)) {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: `toggle${toggle}`, state: isChecked }).catch(() => {});
                });
            }
        });
    });

    // ── Helpers ─────────────────────────────────────────────────────────────
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

    document.getElementById('open-resume-history').addEventListener('click', () => {
        resumePanel.classList.add('visible');
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
        recapPanel.classList.add('visible');
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
            topVideos.forEach((v, i) => {
                const watchId = extractWatchID(v.videolink);
                const thumb   = `https://img.youtube.com/vi/${watchId}/mqdefault.jpg`;
                const row     = document.createElement('a');
                row.className = 'recap-row';
                row.href      = v.videolink;
                row.target    = '_blank';
                row.innerHTML = `
                    <span class="recap-rank">#${i + 1}</span>
                    <img class="recap-thumb" src="${thumb}" alt="">
                    <div class="recap-info">
                        <div class="recap-title">${escapeHtml(v.title || 'Untitled')}</div>
                        <div class="recap-channel">${escapeHtml(v.channel || '')}</div>
                    </div>
                    <span class="recap-count">${v.watchCount || 1}×</span>`;
                videosEl.appendChild(row);
            });
        }

        // Render top channels
        if (!topChannels.length) {
            channelsEl.innerHTML = '<div class="recap-empty">No channels found yet.</div>';
        } else {
            channelsEl.innerHTML = '';
            topChannels.forEach(([ch, stats], i) => {
                const row = document.createElement('div');
                row.className = 'recap-channel-row';
                row.innerHTML = `
                    <span class="recap-rank">#${i + 1}</span>
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
        resumeSettingsPanel.classList.add('visible');
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
            body:  'If you are a YouTube Premium subscriber, keep Smart Download turned OFF. This feature uses a third-party downloader and may conflict with YouTube Premium\'s built-in download feature.'
        },
        screenshot: {
            title: 'Video Screenshot',
            body:  'Adds a camera button to the player and the Alt+Shift+S shortcut. Captures only the video frame itself — no controls, no overlays. If the video is playing it pauses for the capture, then resumes automatically.'
        },
        watchparty: {
            title: 'Watch Party',
            body:  'Adds a Watch Party button next to Create in the YouTube header. Create a room to host and share the code, or join a room to follow along — only the host controls playback. Turn this off to remove the button entirely.'
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
        reportPanel.classList.add('visible');
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
