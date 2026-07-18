// ─────────────────────────────────────────────────────────────────────────
// YouTube Pro+ — Watch Party (room sync)
// Lets the host create a room + code; guests join with that code and their
// player mirrors the host's play/pause/seek/video-change in real time.
// All the actual video logic lives here in the tab; the server is a dumb
// relay (see room-server/index.js).
//
// v2: the toggle button now docks into the YouTube masthead next to the
// "Create" button instead of floating over the page, and reconnects
// "reclaim" the same room/code instead of silently spawning a new one.
// ─────────────────────────────────────────────────────────────────────────

(function () {
    if (window.__ytProRoomSyncLoaded) return;
    window.__ytProRoomSyncLoaded = true;

    const DEFAULT_SERVER_URL = 'wss://ytproplusserver.onrender.com/';
    const DRIFT_TOLERANCE_SEC = 1.5;   // resync if viewer time is off by more than this
    const HOST_BROADCAST_MS  = 5000;   // host sends a heartbeat/time-sync every 5s
    const REMOTE_GUARD_MS    = 400;    // ignore our own listeners right after a remote update
    const MAX_RECONNECT_ATTEMPTS = 8;  // ~ covers a slow Render free-tier cold start

    let ws = null;
    let roomCode = null;
    let clientId = null;
    let hostToken = null;      // lets a dropped host reclaim the SAME room/code
    let isHost = false;
    let memberCount = 1;
    let ignoreLocalEventsUntil = 0;
    let hostBroadcastTimer = null;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let intentionalClose = false;
    let isSessionRestore = false; // true only for the fresh-script-load restore attempt in init()

    // ── Small storage helpers (mirrors the pattern used elsewhere in the extension) ──
    function getStorage(keys) {
        return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }
    function setStorage(obj) {
        return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    }

    // ── Session persistence ──────────────────────────────────────────────
    // Safety net for the (hopefully rare, now that navigation is SPA-based)
    // case where the tab genuinely reloads mid-party — a real YouTube link
    // that isn't intercepted, browser restore, extension reload, etc. On
    // init we check for a recent session and silently rejoin/reclaim.
    const SESSION_KEY = 'ytProRoomSession';
    const SESSION_MAX_AGE_MS = 5 * 60 * 1000; // stale sessions aren't worth resuming

    function saveSession() {
        if (!roomCode) { clearSession(); return; }
        setStorage({ [SESSION_KEY]: {
            roomCode, clientId, hostToken, isHost,
            serverUrl: getServerUrl(),
            savedAt: Date.now()
        }});
    }
    function clearSession() {
        setStorage({ [SESSION_KEY]: null });
    }
    async function loadSession() {
        const data = await getStorage([SESSION_KEY]);
        const s = data[SESSION_KEY];
        if (!s || !s.roomCode) return null;
        if (Date.now() - s.savedAt > SESSION_MAX_AGE_MS) return null;
        return s;
    }

    // ── Video element lookup (matches the approach content.js already uses) ──
    function getActiveVideo() {
        return document.querySelector('ytd-reel-video-renderer[is-active] video')
            || document.querySelector('video.html5-main-video')
            || document.querySelector('video');
    }

    function getCurrentVideoId() {
        try {
            return new URL(location.href).searchParams.get('v');
        } catch { return null; }
    }

    // Navigate to another video WITHOUT a hard page reload. A plain
    // `location.href = ...` reloads the whole tab, which kills the content
    // script (and with it the WebSocket, room code, host token — everything).
    // YouTube's own router intercepts real <a> click events and does a
    // client-side (SPA) navigation instead, so we simulate exactly that.
    function spaNavigate(url) {
        try {
            const a = document.createElement('a');
            a.href = url;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            a.remove();
            // Fallback: if YouTube's router didn't pick it up (e.g. structure
            // changed), the URL won't have actually changed — hard-navigate then.
            setTimeout(() => {
                if (!location.href.includes(url.split('?v=')[1])) {
                    location.href = url;
                }
            }, 1200);
        } catch {
            location.href = url; // last resort
        }
    }

    function withRemoteGuard(fn) {
        ignoreLocalEventsUntil = Date.now() + REMOTE_GUARD_MS;
        fn();
    }
    function isGuarded() {
        return Date.now() < ignoreLocalEventsUntil;
    }

    // ── UI ──────────────────────────────────────────────────────────────────
    let panelEl = null;
    let toggleBtnEl = null;

    function injectStyles() {
        if (document.getElementById('yt-pro-room-styles')) return;
        const style = document.createElement('style');
        style.id = 'yt-pro-room-styles';
        style.textContent = `
            #yt-pro-room-toggle {
                display: inline-flex; align-items: center; justify-content: center;
                width: 40px; height: 40px; margin-right: 8px; flex: 0 0 auto;
                border-radius: 50%; border: none; background: transparent;
                cursor: pointer; font-size: 20px; line-height: 1;
                color: var(--yt-spec-icon-active-other, #fff);
                transition: background-color .15s ease, transform .15s ease;
            }
            #yt-pro-room-toggle:hover { background: var(--yt-spec-badge-chip-background, rgba(128,128,128,0.2)); }
            #yt-pro-room-toggle:active { transform: scale(0.94); }
            #yt-pro-room-toggle.connected {
                background: linear-gradient(135deg, rgba(46,204,113,.30), rgba(22,160,133,.30));
            }
            #yt-pro-room-panel {
                position: fixed; top: 62px; right: 24px; z-index: 999999;
                width: 280px; background: #181818; color: #eee;
                border-radius: 14px; padding: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.5);
                font-family: 'Roboto', Arial, sans-serif; font-size: 13px;
                border: 1px solid rgba(255,255,255,0.08);
            }
            #yt-pro-room-panel.hidden { display: none; }
            #yt-pro-room-panel h3 { margin: 0 0 10px; font-size: 14px; display: flex; align-items: center; gap: 6px; }
            #yt-pro-room-panel input {
                width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 8px;
                background: #262626; border: 1px solid #3a3a3a; border-radius: 8px;
                color: #eee; font-size: 13px;
            }
            #yt-pro-room-panel button {
                width: 100%; padding: 9px; margin-bottom: 8px; border: none; border-radius: 8px;
                background: #ff3b6b; color: #fff; font-weight: 600; cursor: pointer; font-size: 13px;
            }
            #yt-pro-room-panel button.secondary { background: #333; }
            #yt-pro-room-panel button:hover { filter: brightness(1.1); }
            #yt-pro-room-panel .yt-pro-room-status {
                font-size: 11.5px; color: #aaa; margin-bottom: 10px; line-height: 1.5;
            }
            #yt-pro-room-panel .yt-pro-room-code {
                font-size: 20px; font-weight: 700; letter-spacing: 3px; text-align: center;
                background: #262626; border-radius: 8px; padding: 10px; margin-bottom: 10px;
                color: #4fd1c5; cursor: pointer;
            }
            #yt-pro-room-panel .yt-pro-room-close { position: absolute; top: 10px; right: 12px; cursor: pointer; color: #888; }
            #yt-pro-room-panel .yt-pro-room-note {
                font-size: 11px; color: #777; text-align: center; margin-top: 2px;
            }
        `;
        document.head.appendChild(style);
    }

    function buildPanel() {
        panelEl = document.createElement('div');
        panelEl.id = 'yt-pro-room-panel';
        panelEl.className = 'hidden';
        panelEl.innerHTML = `
            <span class="yt-pro-room-close">✕</span>
            <h3>🎉 Watch Party</h3>
            <div class="yt-pro-room-status" id="yt-pro-room-status">Not connected.</div>
            <div id="yt-pro-room-idle">
                <button id="yt-pro-create-room">Create Room</button>
                <input id="yt-pro-join-code" placeholder="Enter room code" maxlength="6" style="text-transform:uppercase" />
                <button id="yt-pro-join-room" class="secondary">Join Room</button>
                <input id="yt-pro-server-url" style="display:none" />
                <div class="yt-pro-room-note">Only the host can control playback.</div>
            </div>
            <div id="yt-pro-room-active" class="hidden">
                <div class="yt-pro-room-code" id="yt-pro-room-code-display" title="Click to copy"></div>
                <div class="yt-pro-room-status" id="yt-pro-room-member-count"></div>
                <button id="yt-pro-leave-room" class="secondary">Leave Room</button>
            </div>
        `;
        document.body.appendChild(panelEl);

        panelEl.querySelector('.yt-pro-room-close').onclick = () => panelEl.classList.add('hidden');
        panelEl.querySelector('#yt-pro-create-room').onclick = createRoom;
        panelEl.querySelector('#yt-pro-join-room').onclick = () => {
            const code = panelEl.querySelector('#yt-pro-join-code').value.trim().toUpperCase();
            if (code) joinRoom(code);
        };
        panelEl.querySelector('#yt-pro-leave-room').onclick = leaveRoom;
        panelEl.querySelector('#yt-pro-room-code-display').onclick = () => {
            if (roomCode) navigator.clipboard.writeText(roomCode).catch(() => {});
        };

        // Close the panel when clicking elsewhere on the page.
        document.addEventListener('click', (e) => {
            if (panelEl.classList.contains('hidden')) return;
            if (panelEl.contains(e.target) || (toggleBtnEl && toggleBtnEl.contains(e.target))) return;
            panelEl.classList.add('hidden');
        });

        getStorage(['roomServerUrl']).then(({ roomServerUrl }) => {
            panelEl.querySelector('#yt-pro-server-url').value = roomServerUrl || DEFAULT_SERVER_URL;
        });
    }

    // ── Docking the toggle button into the masthead, beside "Create" ────────
    function buildToggleButton() {
        toggleBtnEl = document.createElement('button');
        toggleBtnEl.id = 'yt-pro-room-toggle';
        toggleBtnEl.type = 'button';
        toggleBtnEl.title = 'Watch Party';
        toggleBtnEl.textContent = '🎉';
        toggleBtnEl.onclick = (e) => {
            e.stopPropagation();
            panelEl.classList.toggle('hidden');
        };
        placeToggleButton();
        watchMastheadForButtonPlacement();
    }

    function findCreateButtonAnchor() {
        const selectors = [
            'ytd-masthead #end a[aria-label="Create" i]',
            'ytd-masthead #end button[aria-label="Create" i]',
            'ytd-masthead ytd-button-renderer a[href="/upload"]',
            'ytd-masthead yt-button-shape a[href="/upload"]',
            '#masthead-container #end a[aria-label="Create" i]',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el.closest('ytd-button-renderer, yt-button-shape') || el;
        }
        // Fallback: hunt for a leaf node whose text is exactly "Create".
        const scope = document.querySelector('ytd-masthead #end') || document.querySelector('ytd-masthead');
        if (scope) {
            const nodes = scope.querySelectorAll('yt-formatted-string, span, div');
            for (const n of nodes) {
                if (n.childElementCount === 0 && n.textContent.trim() === 'Create') {
                    return n.closest('ytd-button-renderer, yt-button-shape') || n.parentElement;
                }
            }
        }
        return null;
    }

    function placeToggleButton() {
        if (!toggleBtnEl) return;
        const anchor = findCreateButtonAnchor();
        if (anchor && anchor.parentElement) {
            if (toggleBtnEl.nextSibling !== anchor || toggleBtnEl.parentElement !== anchor.parentElement) {
                anchor.parentElement.insertBefore(toggleBtnEl, anchor);
            }
        } else if (!document.body.contains(toggleBtnEl)) {
            // Masthead not ready yet / structure changed — try again shortly via the observer below.
        }
    }

    function watchMastheadForButtonPlacement() {
        let rafId = null;
        const schedule = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => { rafId = null; placeToggleButton(); });
        };
        const target = document.getElementById('masthead-container') || document.body;
        const observer = new MutationObserver(schedule);
        observer.observe(target, { childList: true, subtree: true });
        window.addEventListener('yt-navigate-finish', schedule);
        schedule();
    }

    function setStatus(text) {
        const el = document.getElementById('yt-pro-room-status');
        if (el) el.textContent = text;
    }

    function showActiveState() {
        panelEl.querySelector('#yt-pro-room-idle').classList.add('hidden');
        panelEl.querySelector('#yt-pro-room-active').classList.remove('hidden');
        panelEl.querySelector('#yt-pro-room-code-display').textContent = roomCode;
        panelEl.querySelector('#yt-pro-room-member-count').textContent =
            isHost ? `You're hosting · ${memberCount} watching` : `Following host · ${memberCount} in room`;
        toggleBtnEl.classList.add('connected');
    }

    function showIdleState() {
        panelEl.querySelector('#yt-pro-room-idle').classList.remove('hidden');
        panelEl.querySelector('#yt-pro-room-active').classList.add('hidden');
        toggleBtnEl.classList.remove('connected');
    }

    // ── WebSocket connection ───────────────────────────────────────────────
    function getServerUrl() {
        const fromInput = panelEl?.querySelector('#yt-pro-server-url')?.value.trim();
        return fromInput || DEFAULT_SERVER_URL;
    }

    function connect(onOpen) {
        const url = getServerUrl();
        setStorage({ roomServerUrl: url });
        intentionalClose = false;

        try {
            ws = new WebSocket(url);
        } catch (e) {
            setStatus('Invalid server URL.');
            return;
        }

        ws.onopen = () => {
            reconnectAttempts = 0;
            onOpen();
        };
        ws.onmessage = (evt) => {
            let msg;
            try { msg = JSON.parse(evt.data); } catch { return; }
            handleServerMessage(msg);
        };
        ws.onclose = () => {
            if (roomCode && !intentionalClose) {
                attemptReconnect();
            }
        };
        ws.onerror = () => setStatus('Connection error — check the server URL.');
    }

    function attemptReconnect() {
        if (!roomCode) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            setStatus('Lost connection to the relay. Tap Create/Join again to restart the party.');
            return;
        }
        reconnectAttempts++;
        const delay = Math.min(1500 * reconnectAttempts, 12000);
        setStatus(`Disconnected — reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            connect(() => {
                if (isHost && hostToken) {
                    // Try to resume the SAME room/code rather than minting a new one.
                    ws.send(JSON.stringify({ type: 'reclaim_host', code: roomCode, hostToken }));
                } else if (isHost) {
                    ws.send(JSON.stringify({ type: 'create_room' }));
                } else {
                    ws.send(JSON.stringify({ type: 'join_room', code: roomCode }));
                }
            });
        }, delay);
    }

    function handleServerMessage(msg) {
        switch (msg.type) {
            case 'room_created':
                roomCode = msg.code;
                clientId = msg.clientId;
                hostToken = msg.hostToken;
                isHost = true;
                memberCount = 1;
                showActiveState();
                setStatus('Room created — share the code below.');
                startHostBroadcasting();
                saveSession();
                break;

            case 'room_reclaimed':
                // Same room, same code — the host's socket just came back.
                roomCode = msg.code;
                clientId = msg.clientId;
                hostToken = msg.hostToken || hostToken;
                isHost = true;
                memberCount = msg.memberCount || memberCount;
                showActiveState();
                setStatus("Reconnected — you're still hosting.");
                startHostBroadcasting();
                saveSession();
                isSessionRestore = false;
                break;

            case 'reclaim_failed':
                // The old room is genuinely gone (grace period ran out).
                if (isSessionRestore) {
                    // This was a fresh page load silently checking for a
                    // party to resume — NOT the user actively hosting right
                    // now. Don't spin up a surprise new room; just clear out
                    // and let them press "Create Room" if they want one.
                    isSessionRestore = false;
                    hostToken = null;
                    roomCode = null;
                    isHost = false;
                    clearSession();
                    if (ws) { try { ws.close(); } catch {} ws = null; }
                    if (panelEl) {
                        showIdleState();
                        setStatus('Your previous watch party expired. Tap Create Room to start a new one.');
                    }
                } else {
                    // Live reconnect mid-session (tab/script never died) — the
                    // host is actively still here, so continue the party under
                    // a new code rather than dropping it entirely.
                    setStatus('Previous room expired — starting a new one…');
                    hostToken = null;
                    ws.send(JSON.stringify({ type: 'create_room' }));
                }
                break;

            case 'room_joined':
                roomCode = msg.code;
                clientId = msg.clientId;
                isHost = false;
                memberCount = msg.memberCount || 1;
                showActiveState();
                setStatus(msg.hostPaused
                    ? 'Connected — host is reconnecting, hang tight…'
                    : 'Connected — syncing with host.');
                if (msg.state) applyRemoteState(msg.state);
                saveSession();
                isSessionRestore = false;
                break;

            case 'member_count':
                memberCount = msg.count;
                if (panelEl) {
                    panelEl.querySelector('#yt-pro-room-member-count').textContent =
                        isHost ? `You're hosting · ${memberCount} watching` : `Following host · ${memberCount} in room`;
                }
                break;

            case 'host_disconnected':
                if (!isHost) setStatus('Host disconnected — waiting for them to reconnect…');
                break;

            case 'sync':
                if (!isHost) setStatus('Connected — syncing with host.');
                applyRemoteState(msg.event);
                break;

            case 'room_closed':
                setStatus('Host ended the watch party.');
                teardownRoom();
                break;

            case 'error':
                setStatus(msg.message || 'Something went wrong.');
                // A join/reclaim attempt failed outright (e.g. restoring a
                // session whose room no longer exists) — don't keep it around.
                roomCode = null;
                isHost = false;
                isSessionRestore = false;
                clearSession();
                if (ws) { try { ws.close(); } catch {} ws = null; }
                if (panelEl) showIdleState();
                break;

            default:
                break;
        }
    }

    // ── Applying remote (host) state to our own player ─────────────────────
    function applyRemoteState(state) {
        if (!state) return;
        const video = getActiveVideo();

        if (state.videoId && state.videoId !== getCurrentVideoId()) {
            withRemoteGuard(() => {
                spaNavigate(`https://www.youtube.com/watch?v=${state.videoId}`);
            });
            return; // player swaps in-place via SPA nav; time/play state applied on next sync tick
        }

        if (!video) return;

        if (typeof state.time === 'number' && Math.abs(video.currentTime - state.time) > DRIFT_TOLERANCE_SEC) {
            withRemoteGuard(() => { video.currentTime = state.time; });
        }
        if (typeof state.playing === 'boolean') {
            withRemoteGuard(() => {
                if (state.playing && video.paused) video.play().catch(() => {});
                if (!state.playing && !video.paused) video.pause();
            });
        }
    }

    // ── Host: capturing local events and broadcasting them ─────────────────
    let hostListenersAttached = false;

    function sendHostEvent(event) {
        if (!isHost || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'host_event', event }));
    }

    function attachHostListeners() {
        if (hostListenersAttached) return;
        hostListenersAttached = true;

        document.addEventListener('play', (e) => {
            if (!isHost || isGuarded() || !isVideoEl(e.target)) return;
            sendHostEvent({ videoId: getCurrentVideoId(), time: e.target.currentTime, playing: true });
        }, true);

        document.addEventListener('pause', (e) => {
            if (!isHost || isGuarded() || !isVideoEl(e.target)) return;
            sendHostEvent({ videoId: getCurrentVideoId(), time: e.target.currentTime, playing: false });
        }, true);

        document.addEventListener('seeked', (e) => {
            if (!isHost || isGuarded() || !isVideoEl(e.target)) return;
            sendHostEvent({ videoId: getCurrentVideoId(), time: e.target.currentTime, playing: !e.target.paused });
        }, true);

        // YouTube SPA navigation — fires when the host switches to a new video.
        window.addEventListener('yt-navigate-finish', () => {
            if (!isHost) return;
            setTimeout(() => {
                const video = getActiveVideo();
                sendHostEvent({
                    videoId: getCurrentVideoId(),
                    time: video ? video.currentTime : 0,
                    playing: video ? !video.paused : true
                });
            }, 800); // let the new player mount first
        });
    }

    function isVideoEl(el) {
        return el && el.tagName === 'VIDEO';
    }

    function startHostBroadcasting() {
        attachHostListeners();
        stopHostBroadcasting();
        hostBroadcastTimer = setInterval(() => {
            if (!isHost) return;
            const video = getActiveVideo();
            if (!video) return;
            sendHostEvent({ videoId: getCurrentVideoId(), time: video.currentTime, playing: !video.paused });
        }, HOST_BROADCAST_MS);
    }
    function stopHostBroadcasting() {
        if (hostBroadcastTimer) clearInterval(hostBroadcastTimer);
        hostBroadcastTimer = null;
    }

    // ── Room lifecycle actions (wired to the UI buttons) ────────────────────
    function createRoom() {
        connect(() => ws.send(JSON.stringify({ type: 'create_room' })));
    }

    function joinRoom(code) {
        roomCode = code; // set ahead of connect so reconnect logic knows it
        connect(() => ws.send(JSON.stringify({ type: 'join_room', code })));
    }

    function leaveRoom() {
        intentionalClose = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'leave_room' }));
        }
        teardownRoom();
    }

    function teardownRoom() {
        intentionalClose = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        stopHostBroadcasting();
        if (ws) { try { ws.close(); } catch {} }
        ws = null;
        roomCode = null;
        clientId = null;
        hostToken = null;
        isHost = false;
        memberCount = 1;
        reconnectAttempts = 0;
        clearSession();
        if (panelEl) {
            showIdleState();
            setStatus('Not connected.');
        }
    }

    // ── Feature enable/disable (from the extension popup) ──────────────────
    let featureEnabled = true;
    let featureInitialized = false;

    function teardownUI() {
        if (toggleBtnEl) { toggleBtnEl.remove(); toggleBtnEl = null; }
        if (panelEl) { panelEl.remove(); panelEl = null; }
        const styleEl = document.getElementById('yt-pro-room-styles');
        if (styleEl) styleEl.remove();
        featureInitialized = false;
    }

    function enableFeature() {
        featureEnabled = true;
        if (featureInitialized) return;
        featureInitialized = true;
        injectStyles();
        buildPanel();
        buildToggleButton();
        restoreSessionIfAny();
    }

    function disableFeature() {
        featureEnabled = false;
        // Turning the feature off mid-party should behave like leaving —
        // tell the server so guests/host aren't left hanging silently.
        if (roomCode) leaveRoom();
        teardownUI();
    }

    if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg && msg.action === 'togglewatchparty') {
                if (msg.state) enableFeature(); else disableFeature();
            }
        });
    }

    // ── Init ─────────────────────────────────────────────────────────────
    async function restoreSessionIfAny() {
        const session = await loadSession();
        if (!session) return;

        // A hard reload happened mid-party. Restore local state and try to
        // resume seamlessly — reclaim if we were host, rejoin if we were a guest.
        roomCode = session.roomCode;
        clientId = session.clientId;
        hostToken = session.hostToken;
        isHost = session.isHost;
        isSessionRestore = true;
        if (panelEl) panelEl.querySelector('#yt-pro-server-url').value = session.serverUrl || DEFAULT_SERVER_URL;
        setStatus('Restoring watch party…');

        connect(() => {
            if (isHost && hostToken) {
                ws.send(JSON.stringify({ type: 'reclaim_host', code: roomCode, hostToken }));
            } else if (!isHost) {
                ws.send(JSON.stringify({ type: 'join_room', code: roomCode }));
            }
        });
    }

    function init() {
        getStorage(['watchparty']).then(({ watchparty }) => {
            if (watchparty === false) {
                featureEnabled = false;
                return; // user turned Watch Party off — don't build any UI
            }
            enableFeature();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
