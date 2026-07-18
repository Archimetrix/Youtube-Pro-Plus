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
    const CHAT_RENDER_LIMIT = 200;     // how many recent chat lines we keep in memory client-side
    const AVATAR_COUNT = 50;           // matches the server's MAX_CLIENTS_PER_ROOM — one look per possible member

    let ws = null;
    let roomCode = null;
    let clientId = null;
    let hostToken = null;      // lets a dropped host reclaim the SAME room/code
    let guestToken = null;     // lets a dropped guest silently resume the SAME identity (no join/leave spam)
    let isHost = false;
    let memberCount = 1;
    let ignoreLocalEventsUntil = 0;
    let hostBroadcastTimer = null;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let intentionalClose = false;
    let isSessionRestore = false; // true only for the fresh-script-load restore attempt in init()

    // ── Chat ─────────────────────────────────────────────────────────────
    // Chat is entirely tied to the current room session — it lives only in
    // this in-memory array while the room is open. It is never written to
    // chrome.storage/disk, and it's wiped the moment the room ends
    // (host leaves, the server closes the room, or we leave/disconnect).
    let displayName = null;
    let chatLog = [];
    let chatSendTimestamps = []; // mirrors server-side rate limiting, see sendChatMessage()
    const CHAT_NAME_KEY = 'ytProRoomDisplayName';
    const CHAT_CLIENT_RATE_LIMIT = 5;          // keep in sync with server CHAT_RATE_LIMIT
    const CHAT_CLIENT_RATE_WINDOW_MS = 8000;   // keep in sync with server CHAT_RATE_WINDOW_MS

    function randomGuestName() {
        return 'Guest' + Math.floor(1000 + Math.random() * 9000);
    }
    async function getDisplayName() {
        if (displayName) return displayName;
        const data = await getStorage([CHAT_NAME_KEY]);
        displayName = data[CHAT_NAME_KEY] || randomGuestName();
        return displayName;
    }
    function setDisplayName(name) {
        const trimmed = (name || '').trim().slice(0, 24);
        displayName = trimmed || randomGuestName();
        setStorage({ [CHAT_NAME_KEY]: displayName });
        return displayName;
    }

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
            roomCode, clientId, hostToken, guestToken, isHost,
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
    //
    // Note: even when this falls back to a hard reload, it's not fatal —
    // restoreSessionIfAny() on the next script load resumes the same guest
    // identity via guestToken, so a rare fallback here doesn't cause any
    // visible "left the room" / "joined the room" chat spam.
    function spaNavigate(url) {
        try {
            const targetVideoId = new URL(url, location.href).searchParams.get('v');
            const a = document.createElement('a');
            a.href = url;
            a.style.display = 'none';
            document.body.appendChild(a);
            // Fire a fuller, more "real" event sequence — some SPA routers key
            // off pointerdown/mousedown rather than just the synthetic click.
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
                a.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            a.remove();
            // Fallback: if YouTube's router didn't pick it up (e.g. structure
            // changed) within a generous window, the URL won't have actually
            // changed — hard-navigate as a last resort.
            setTimeout(() => {
                const currentVideoId = new URLSearchParams(location.search).get('v');
                if (targetVideoId && currentVideoId !== targetVideoId) {
                    location.href = url;
                }
            }, 1800);
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
            @keyframes yt-pro-spin { to { transform: rotate(360deg); } }
            @keyframes yt-pro-panel-in {
                from { opacity: 0; transform: translateY(-6px) scale(0.98); }
                to   { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes yt-pro-msg-in {
                from { opacity: 0; transform: translateY(4px); }
                to   { opacity: 1; transform: translateY(0); }
            }

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

            /* ── Liquid glass panel ───────────────────────────────────────
               Frosted, translucent surface: backdrop-filter blur + saturation,
               a soft inner highlight along the top edge, and a subtle gradient
               wash so it reads as "glass" rather than a flat dark card. */
            #yt-pro-room-panel {
                position: fixed; top: 62px; right: 24px; z-index: 999999;
                width: 350px; color: #f2f2f2;
                border-radius: 22px; padding: 18px;
                font-family: 'Roboto', Arial, sans-serif; font-size: 13px;
                background:
                    linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02)),
                    linear-gradient(145deg, rgba(40,20,30,0.55), rgba(15,15,20,0.55));
                -webkit-backdrop-filter: blur(24px) saturate(180%);
                backdrop-filter: blur(24px) saturate(180%);
                border: 1px solid rgba(255,255,255,0.16);
                box-shadow:
                    0 12px 40px rgba(0,0,0,0.45),
                    inset 0 1px 0 rgba(255,255,255,0.18),
                    inset 0 0 40px rgba(255,255,255,0.02);
                animation: yt-pro-panel-in .18s ease-out;
            }
            #yt-pro-room-panel.hidden { display: none; }
            #yt-pro-room-panel h3 {
                margin: 0 0 10px; font-size: 14.5px; font-weight: 700;
                display: flex; align-items: center; gap: 6px;
                text-shadow: 0 1px 2px rgba(0,0,0,0.3);
            }
            #yt-pro-room-panel input {
                width: 100%; box-sizing: border-box; padding: 9px 12px; margin-bottom: 8px;
                background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
                border-radius: 12px; color: #f2f2f2; font-size: 13px;
                -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
                transition: border-color .15s ease, background-color .15s ease;
            }
            #yt-pro-room-panel input::placeholder { color: rgba(240,240,240,0.45); }
            #yt-pro-room-panel input:focus {
                outline: none; border-color: rgba(255,80,130,0.65); background: rgba(255,255,255,0.09);
            }
            #yt-pro-room-panel input:disabled { opacity: 0.5; }
            #yt-pro-room-panel button {
                position: relative; width: 100%; padding: 10px; margin-bottom: 8px;
                border: 1px solid rgba(255,255,255,0.18); border-radius: 12px;
                color: #fff; font-weight: 600; cursor: pointer; font-size: 13px;
                background: linear-gradient(135deg, rgba(255,59,107,0.95), rgba(255,90,140,0.85));
                box-shadow: 0 4px 14px rgba(255,59,107,0.25), inset 0 1px 0 rgba(255,255,255,0.25);
                transition: filter .12s ease, transform .1s ease, box-shadow .15s ease;
            }
            #yt-pro-room-panel button.secondary {
                background: rgba(255,255,255,0.08);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.12);
            }
            #yt-pro-room-panel button:hover:not(:disabled) {
                filter: brightness(1.12); transform: translateY(-1px);
                box-shadow: 0 6px 18px rgba(255,59,107,0.32), inset 0 1px 0 rgba(255,255,255,0.3);
            }
            #yt-pro-room-panel button.secondary:hover:not(:disabled) {
                box-shadow: 0 4px 14px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16);
            }
            #yt-pro-room-panel button:active:not(:disabled) { transform: scale(0.97); }
            #yt-pro-room-panel button:disabled { cursor: default; opacity: 0.85; }

            /* Loading progress bar shown along the bottom edge of whichever
               button (Create or Join) was actually clicked, while we wait
               ~2-3s for the relay to respond. Only the clicked button gets
               the bar — the other one is just disabled, not "loading" too. */
            #yt-pro-room-panel button { overflow: hidden; } /* clip the bar to the button's rounded corners */
            #yt-pro-room-panel button .btn-progress {
                display: none; position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
                background: rgba(255,255,255,0.18); overflow: hidden;
            }
            #yt-pro-room-panel button .btn-progress-fill {
                position: absolute; top: 0; bottom: 0; width: 40%;
                background: #fff; border-radius: 2px;
                animation: yt-pro-progress-sweep 1.1s ease-in-out infinite;
            }
            #yt-pro-room-panel button.loading .btn-progress { display: block; }
            @keyframes yt-pro-progress-sweep {
                0%   { left: -40%; }
                100% { left: 100%; }
            }

            #yt-pro-room-panel .yt-pro-room-status {
                font-size: 11.5px; color: rgba(240,240,240,0.7); margin-bottom: 10px; line-height: 1.5;
            }
            #yt-pro-room-panel .yt-pro-room-member-row {
                display: flex; align-items: center; gap: 8px; margin-bottom: 2px;
            }
            #yt-pro-room-panel .yt-pro-room-member-row .yt-pro-room-status { margin-bottom: 0; }
            #yt-pro-room-panel .yt-pro-avatar-stack {
                display: flex; flex: 0 0 auto;
            }
            #yt-pro-room-panel .yt-pro-avatar {
                width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto;
                display: flex; align-items: center; justify-content: center;
                box-shadow: 0 2px 6px rgba(0,0,0,0.35);
                overflow: hidden;
            }
            #yt-pro-room-panel .yt-pro-avatar svg { display: block; width: 100%; height: 100%; }
            #yt-pro-room-panel .yt-pro-avatar-stacked {
                margin-left: -8px; border: 2px solid rgba(20,14,18,0.9);
                transition: transform .12s ease;
            }
            #yt-pro-room-panel .yt-pro-avatar-stacked:first-child { margin-left: 0; }
            #yt-pro-room-panel .yt-pro-avatar-stacked:hover { transform: translateY(-2px); z-index: 2; }
            #yt-pro-room-panel .yt-pro-avatar-host {
                box-shadow: 0 0 0 2px #ffcf5c, 0 2px 6px rgba(0,0,0,0.35);
            }
            #yt-pro-room-panel .yt-pro-avatar-more {
                background: rgba(255,255,255,0.14); color: #f2f2f2; font-size: 10.5px; font-weight: 700;
                border: 2px solid rgba(20,14,18,0.9);
            }
            #yt-pro-room-panel .yt-pro-room-code {
                font-size: 21px; font-weight: 700; letter-spacing: 3px; text-align: center;
                background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.14);
                border-radius: 14px; padding: 11px; margin-bottom: 10px;
                color: #6fe8d9; cursor: pointer; text-shadow: 0 0 16px rgba(111,232,217,0.35);
                transition: background-color .15s ease;
            }
            #yt-pro-room-panel .yt-pro-room-code:hover { background: rgba(255,255,255,0.11); }
            #yt-pro-room-panel .yt-pro-room-close {
                position: absolute; top: 12px; right: 14px; cursor: pointer; color: rgba(240,240,240,0.6);
                width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
                border-radius: 50%; transition: background-color .12s ease, color .12s ease;
            }
            #yt-pro-room-panel .yt-pro-room-close:hover { background: rgba(255,255,255,0.12); color: #fff; }
            #yt-pro-room-panel .yt-pro-room-note {
                font-size: 11px; color: rgba(240,240,240,0.45); text-align: center; margin-top: 2px;
            }

            /* ── Chat ─────────────────────────────────────────────────── */
            #yt-pro-room-panel .yt-pro-chat-wrap { margin-bottom: 10px; }
            #yt-pro-room-panel .yt-pro-chat-log {
                height: 220px; overflow-y: auto;
                background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.10);
                border-radius: 14px; padding: 10px; margin-bottom: 8px;
                display: flex; flex-direction: column; gap: 7px;
                scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.25) transparent;
                -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
            }
            #yt-pro-room-panel .yt-pro-chat-log::-webkit-scrollbar { width: 6px; }
            #yt-pro-room-panel .yt-pro-chat-log::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.2); border-radius: 3px;
            }
            #yt-pro-room-panel .yt-pro-chat-empty {
                color: rgba(240,240,240,0.35); font-size: 12px; text-align: center; margin: auto; padding: 12px 8px;
            }
            #yt-pro-room-panel .yt-pro-chat-row {
                display: flex; align-items: flex-end; gap: 7px; max-width: 100%;
                animation: yt-pro-msg-in .15s ease-out;
            }
            #yt-pro-room-panel .yt-pro-chat-row.mine { flex-direction: row-reverse; align-self: flex-end; }
            #yt-pro-room-panel .yt-pro-chat-row .yt-pro-avatar { width: 24px; height: 24px; }
            #yt-pro-room-panel .yt-pro-chat-col {
                display: flex; flex-direction: column; gap: 2px; max-width: 78%; min-width: 0;
            }
            #yt-pro-room-panel .yt-pro-chat-row.mine .yt-pro-chat-col { align-items: flex-end; }
            #yt-pro-room-panel .yt-pro-chat-name {
                color: #ff9fb8; font-weight: 600; font-size: 10.5px; padding: 0 3px;
            }
            #yt-pro-room-panel .yt-pro-chat-row.mine .yt-pro-chat-name { color: #6fe8d9; }
            #yt-pro-room-panel .yt-pro-chat-msg {
                font-size: 12.5px; line-height: 1.45; word-break: break-word;
                background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.08);
                border-radius: 14px; border-bottom-left-radius: 4px; padding: 7px 11px;
            }
            #yt-pro-room-panel .yt-pro-chat-msg.mine {
                border-radius: 14px; border-bottom-right-radius: 4px;
                background: linear-gradient(135deg, rgba(111,232,217,0.20), rgba(111,232,217,0.08));
                border: 1px solid rgba(111,232,217,0.30);
            }
            #yt-pro-room-panel .yt-pro-chat-msg.system {
                align-self: center; background: transparent; border: none; color: rgba(240,240,240,0.4);
                font-style: italic; font-size: 11px; text-align: center; padding: 2px 4px; max-width: 100%;
            }
            #yt-pro-room-panel .yt-pro-chat-text { color: #f2f2f2; }

            #yt-pro-room-panel .yt-pro-chat-input-row {
                display: flex; align-items: stretch; gap: 6px; margin-bottom: 6px;
            }
            /* Higher specificity than the generic "#yt-pro-room-panel input" rule
               above, so width:100% doesn't fight the flex layout here — that
               mismatch was the cause of the squished input box. */
            #yt-pro-room-panel .yt-pro-chat-input-row input {
                width: auto; flex: 1 1 auto; min-width: 0; margin-bottom: 0;
            }
            #yt-pro-room-panel .yt-pro-chat-input-row button {
                width: 44px; flex: 0 0 44px; margin-bottom: 0; padding: 0;
                display: flex; align-items: center; justify-content: center; font-size: 15px;
                box-shadow: 0 3px 10px rgba(255,59,107,0.25), inset 0 1px 0 rgba(255,255,255,0.25);
            }
            #yt-pro-room-panel .yt-pro-chat-input-row button:disabled {
                background: rgba(255,255,255,0.06); cursor: default; filter: none; opacity: 0.5; box-shadow: none;
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
                <input id="yt-pro-display-name" placeholder="Your name (optional)" maxlength="24" />
                <button id="yt-pro-create-room"><span class="btn-label">✨ Create Room</span><span class="btn-progress"><span class="btn-progress-fill"></span></span></button>
                <input id="yt-pro-join-code" placeholder="Enter room code" maxlength="6" style="text-transform:uppercase" />
                <button id="yt-pro-join-room" class="secondary"><span class="btn-label">🔗 Join Room</span><span class="btn-progress"><span class="btn-progress-fill"></span></span></button>
                <input id="yt-pro-server-url" style="display:none" />
                <div class="yt-pro-room-note">Only the host can control playback.</div>
            </div>
            <div id="yt-pro-room-active" class="hidden">
                <div class="yt-pro-room-code" id="yt-pro-room-code-display" title="Click to copy"></div>
                <div class="yt-pro-room-member-row">
                    <div class="yt-pro-avatar-stack" id="yt-pro-avatar-stack"></div>
                    <div class="yt-pro-room-status" id="yt-pro-room-member-count"></div>
                </div>
                <div class="yt-pro-chat-wrap">
                    <div id="yt-pro-chat-log" class="yt-pro-chat-log"></div>
                    <div class="yt-pro-chat-input-row">
                        <input id="yt-pro-chat-input" placeholder="Message the room…" maxlength="500" />
                        <button id="yt-pro-chat-send" type="button">➤</button>
                    </div>
                    <div class="yt-pro-room-note">Chat is temporary — it disappears when the room ends.</div>
                </div>
                <button id="yt-pro-leave-room" class="secondary">🚪 Leave Room</button>
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

        const nameInput = panelEl.querySelector('#yt-pro-display-name');
        getDisplayName().then((name) => { nameInput.value = name; });
        nameInput.addEventListener('change', () => setDisplayName(nameInput.value));

        const chatInput = panelEl.querySelector('#yt-pro-chat-input');
        const chatSendBtn = panelEl.querySelector('#yt-pro-chat-send');
        chatSendBtn.title = 'Send';
        const sendFromInput = () => {
            sendChatMessage(chatInput.value);
            chatInput.value = '';
            chatSendBtn.disabled = true;
        };
        chatSendBtn.disabled = true;
        chatSendBtn.onclick = sendFromInput;
        chatInput.addEventListener('input', () => {
            chatSendBtn.disabled = chatInput.value.trim().length === 0;
        });
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && chatInput.value.trim()) { e.preventDefault(); sendFromInput(); }
            e.stopPropagation(); // don't let YouTube's global hotkeys (space = pause, etc) eat the keystrokes
        });
        chatInput.addEventListener('keyup', (e) => e.stopPropagation());

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
            // Opening the panel is exactly when the "shows from the top"
            // bug bites — the chat log was rendered while display:none,
            // so scrollHeight was 0 and the scroll-to-bottom was a no-op.
            // Redo it now that the panel actually has layout.
            if (!panelEl.classList.contains('hidden')) scrollChatToBottom();
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
        renderAvatarStack();
        scrollChatToBottom();
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
            clearConnectWatchdog();
            setIdleControlsLoading(false);
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
            } else {
                // Never got past the initial connect (e.g. create_room never
                // got a response) — don't leave the buttons spinning forever.
                clearConnectWatchdog();
                setIdleControlsLoading(false);
            }
        };
        ws.onerror = () => {
            setStatus('Connection error — check the server URL.');
            clearConnectWatchdog();
            setIdleControlsLoading(false);
        };
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
            getDisplayName().then((name) => {
                connect(() => {
                    if (isHost && hostToken) {
                        // Try to resume the SAME room/code rather than minting a new one.
                        ws.send(JSON.stringify({ type: 'reclaim_host', code: roomCode, hostToken, name }));
                    } else if (isHost) {
                        ws.send(JSON.stringify({ type: 'create_room', name }));
                    } else {
                        ws.send(JSON.stringify({ type: 'join_room', code: roomCode, name, rejoinToken: guestToken }));
                    }
                });
            });
        }, delay);
    }

    function handleServerMessage(msg) {
        switch (msg.type) {
            case 'room_created':
                clearConnectWatchdog();
                setIdleControlsLoading(false);
                roomCode = msg.code;
                clientId = msg.clientId;
                hostToken = msg.hostToken;
                isHost = true;
                memberCount = 1;
                resetChatLog();
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
                loadChatHistory(msg.messages);
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
                clearConnectWatchdog();
                setIdleControlsLoading(false);
                roomCode = msg.code;
                clientId = msg.clientId;
                isHost = false;
                guestToken = msg.guestToken || guestToken;
                memberCount = msg.memberCount || 1;
                loadChatHistory(msg.messages);
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
                    renderAvatarStack();
                }
                break;

            case 'host_disconnected':
                if (!isHost) setStatus('Host disconnected — waiting for them to reconnect…');
                break;

            case 'sync':
                if (!isHost) setStatus('Connected — syncing with host.');
                applyRemoteState(msg.event);
                break;

            case 'chat':
                appendChatMessage(msg.message);
                break;

            case 'room_closed':
                setStatus('Host ended the watch party.');
                teardownRoom(); // wipes chatLog too — messages don't outlive the room
                break;

            case 'error':
                setStatus(msg.message || 'Something went wrong.');
                if (msg.transient) break; // e.g. chat rate-limit — stay connected, just show the notice
                // A join/reclaim attempt failed outright (e.g. restoring a
                // session whose room no longer exists) — don't keep it around.
                clearConnectWatchdog();
                setIdleControlsLoading(false);
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

    // ── Avatars ─────────────────────────────────────────────────────────
    // A room can have up to 50 members (server's MAX_CLIENTS_PER_ROOM), so
    // we deterministically derive one of 50 distinct little gradient-circle
    // "profile svgs" per person from their stable clientId — same person
    // always gets the same look, no server round trip, no storage needed.
    const avatarSvgCache = new Map(); // clientId -> cached <svg> markup string

    function hashSeed(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
        return h;
    }

    function avatarSvgFor(seedId, name) {
        const key = String(seedId || 'guest');
        if (avatarSvgCache.has(key)) return avatarSvgCache.get(key);
        const idx = hashSeed(key) % AVATAR_COUNT;
        const hue1 = Math.round((360 / AVATAR_COUNT) * idx);
        const hue2 = (hue1 + 46 + (idx % 5) * 7) % 360;
        const shapeSeed = (idx * 2654435761) % 997;
        const cx = 9 + (shapeSeed % 13);
        const cy = 9 + ((shapeSeed >> 3) % 13);
        const r = 5 + (idx % 4);
        const rot = (idx * 47) % 360;
        const letter = ((name || '?').trim()[0] || '?').toUpperCase();
        const svg = `<svg viewBox="0 0 32 32" width="26" height="26" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
            `<defs><linearGradient id="ytpav${idx}" x1="0%" y1="0%" x2="100%" y2="100%">` +
            `<stop offset="0%" stop-color="hsl(${hue1},72%,58%)"/>` +
            `<stop offset="100%" stop-color="hsl(${hue2},72%,42%)"/></linearGradient></defs>` +
            `<circle cx="16" cy="16" r="16" fill="url(#ytpav${idx})"/>` +
            `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255,255,255,0.20)" transform="rotate(${rot} 16 16)"/>` +
            `<text x="16" y="21" text-anchor="middle" font-size="13" font-weight="700" ` +
            `fill="rgba(255,255,255,0.95)" font-family="Roboto, Arial, sans-serif">${letter}</text></svg>`;
        avatarSvgCache.set(key, svg);
        return svg;
    }

    function makeAvatarEl(seedId, name, extraClass) {
        const el = document.createElement('div');
        el.className = 'yt-pro-avatar' + (extraClass ? ' ' + extraClass : '');
        el.innerHTML = avatarSvgFor(seedId, name);
        el.title = name || 'Guest';
        return el;
    }

    // Tracks who's currently in the room, purely client-side — used to
    // render the little avatar stack in the header. Built by replaying
    // join/leave system notes and chat messages, so someone who's actually
    // left drops back out instead of leaving a stale avatar behind forever.
    const knownMembers = new Map(); // clientId -> { name, isHost }

    function noteMember(clientId, name, isHost) {
        if (!clientId) return;
        knownMembers.set(clientId, { name: name || 'Guest', isHost: !!isHost });
        renderAvatarStack();
    }

    function forgetMember(clientId) {
        if (!clientId || !knownMembers.has(clientId)) return;
        knownMembers.delete(clientId);
        renderAvatarStack();
    }

    // Applies a single chat/system message's effect on the known-members
    // list — shared by both the history replay and live messages so the
    // two can never drift out of sync with each other.
    function applyMemberPresence(message) {
        if (!message || !message.clientId) return;
        if (message.system && typeof message.text === 'string' && message.text.endsWith('left the room')) {
            forgetMember(message.clientId);
        } else {
            noteMember(message.clientId, message.name, message.isHost);
        }
    }

    function resetKnownMembers() {
        knownMembers.clear();
        renderAvatarStack();
    }

    function renderAvatarStack() {
        const stack = panelEl && panelEl.querySelector('#yt-pro-avatar-stack');
        if (!stack) return;
        stack.innerHTML = '';
        const entries = Array.from(knownMembers.entries());
        const shown = entries.slice(0, 3);
        shown.forEach(([id, info]) => {
            const el = makeAvatarEl(id, info.name, 'yt-pro-avatar-stacked' + (info.isHost ? ' yt-pro-avatar-host' : ''));
            stack.appendChild(el);
        });
        const overflow = Math.max(entries.length, memberCount) - shown.length;
        if (overflow > 0) {
            const more = document.createElement('div');
            more.className = 'yt-pro-avatar yt-pro-avatar-stacked yt-pro-avatar-more';
            more.textContent = '+' + overflow;
            stack.appendChild(more);
        }
    }

    // ── Chat: rendering + sending ────────────────────────────────────────
    // Everything here operates on the in-memory `chatLog` array only. There
    // is no local persistence — refreshing the tab or the server dropping
    // the room clears it completely.
    function resetChatLog() {
        chatLog = [];
        chatSendTimestamps = [];
        resetKnownMembers();
        renderChatLog();
    }

    function loadChatHistory(messages) {
        chatLog = Array.isArray(messages) ? messages.slice(-CHAT_RENDER_LIMIT) : [];
        resetKnownMembers();
        chatLog.forEach(applyMemberPresence);
        renderChatLog();
    }

    function appendChatMessage(message) {
        if (!message) return;
        chatLog.push(message);
        if (chatLog.length > CHAT_RENDER_LIMIT) chatLog.shift();
        applyMemberPresence(message);
        renderChatMessageEl(message, true);
    }

    function chatListEl() {
        return panelEl ? panelEl.querySelector('#yt-pro-chat-log') : null;
    }

    function renderChatLog() {
        const list = chatListEl();
        if (!list) return;
        list.innerHTML = '';
        if (chatLog.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'yt-pro-chat-empty';
            empty.textContent = 'No messages yet — say hi 👋';
            list.appendChild(empty);
            return;
        }
        chatLog.forEach((m) => renderChatMessageEl(m, false));
        scrollChatToBottom();
    }

    function renderChatMessageEl(message, scroll) {
        const list = chatListEl();
        if (!list) return;
        const emptyHint = list.querySelector('.yt-pro-chat-empty');
        if (emptyHint) emptyHint.remove();

        if (message.system) {
            const row = document.createElement('div');
            row.className = 'yt-pro-chat-msg system';
            row.textContent = message.text; // small joined/left note
            list.appendChild(row);
            if (scroll) scrollChatToBottom();
            return;
        }

        const mine = message.clientId === clientId;
        const row = document.createElement('div');
        row.className = 'yt-pro-chat-row' + (mine ? ' mine' : '');

        row.appendChild(makeAvatarEl(message.clientId, message.name, message.isHost ? 'yt-pro-avatar-host' : ''));

        const col = document.createElement('div');
        col.className = 'yt-pro-chat-col';

        const nameEl = document.createElement('div');
        nameEl.className = 'yt-pro-chat-name';
        nameEl.textContent = (mine ? 'You' : (message.name || 'Guest')) + (message.isHost ? ' · host' : '');
        col.appendChild(nameEl);

        const bubble = document.createElement('div');
        bubble.className = 'yt-pro-chat-msg' + (mine ? ' mine' : '');
        const textEl = document.createElement('span');
        textEl.className = 'yt-pro-chat-text';
        textEl.textContent = message.text; // textContent only — never render as HTML
        bubble.appendChild(textEl);
        col.appendChild(bubble);

        row.appendChild(col);
        list.appendChild(row);
        if (scroll) scrollChatToBottom();
    }

    function scrollChatToBottom() {
        const list = chatListEl();
        if (!list) return;
        // Two rAFs: the first lets the browser finish layout after any class
        // toggle (e.g. unhiding the panel) that just ran this tick, the
        // second runs after that layout is actually painted — a single rAF
        // sometimes fires before scrollHeight reflects the unhidden panel.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
        });
    }

    function sendChatMessage(text) {
        const trimmed = (text || '').trim();
        if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return;
        // Client-side mirror of the server's chat rate limit — gives instant
        // feedback instead of waiting on a round trip to get told to slow down.
        const now = Date.now();
        while (chatSendTimestamps.length && now - chatSendTimestamps[0] > CHAT_CLIENT_RATE_WINDOW_MS) {
            chatSendTimestamps.shift();
        }
        if (chatSendTimestamps.length >= CHAT_CLIENT_RATE_LIMIT) {
            setStatus("You're sending messages too fast — wait a second.");
            return;
        }
        chatSendTimestamps.push(now);
        ws.send(JSON.stringify({ type: 'chat_message', text: trimmed }));
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

    // ── Button loading state ─────────────────────────────────────────────
    // Create/Join talk to the relay over the network, which can take a
    // couple seconds — show a spinner in the button (instead of leaving it
    // looking unresponsive) and guard against it hanging forever.
    const CONNECT_WATCHDOG_MS = 12000;
    let connectWatchdogTimer = null;

    function setButtonLoading(btn, loading) {
        if (!btn) return;
        btn.disabled = loading;
        btn.classList.toggle('loading', loading);
    }
    // `loading` disables both buttons (so you can't fire off a second action
    // mid-connect) but only `activeBtnId` gets the progress-bar treatment —
    // the other one just looks disabled, it doesn't also appear to be loading.
    function setIdleControlsLoading(loading, activeBtnId) {
        if (!panelEl) return;
        const createBtn = panelEl.querySelector('#yt-pro-create-room');
        const joinBtn = panelEl.querySelector('#yt-pro-join-room');
        [createBtn, joinBtn].forEach((btn) => {
            if (!btn) return;
            btn.disabled = loading;
            btn.classList.toggle('loading', loading && btn.id === activeBtnId);
        });
        const nameInput = panelEl.querySelector('#yt-pro-display-name');
        const codeInput = panelEl.querySelector('#yt-pro-join-code');
        if (nameInput) nameInput.disabled = loading;
        if (codeInput) codeInput.disabled = loading;
    }
    function startConnectWatchdog() {
        clearConnectWatchdog();
        connectWatchdogTimer = setTimeout(() => {
            setIdleControlsLoading(false);
            setStatus('Taking longer than expected — check the server and try again.');
        }, CONNECT_WATCHDOG_MS);
    }
    function clearConnectWatchdog() {
        if (connectWatchdogTimer) { clearTimeout(connectWatchdogTimer); connectWatchdogTimer = null; }
    }

    // ── Room lifecycle actions (wired to the UI buttons) ────────────────────
    function createRoom() {
        setIdleControlsLoading(true, 'yt-pro-create-room');
        startConnectWatchdog();
        setStatus('Creating room…');
        getDisplayName().then((name) => {
            connect(() => ws.send(JSON.stringify({ type: 'create_room', name })));
        });
    }

    function joinRoom(code) {
        roomCode = code; // set ahead of connect so reconnect logic knows it
        guestToken = null; // fresh manual join, not a reconnect — don't reuse a stale identity
        setIdleControlsLoading(true, 'yt-pro-join-room');
        startConnectWatchdog();
        setStatus('Joining room…');
        getDisplayName().then((name) => {
            connect(() => ws.send(JSON.stringify({ type: 'join_room', code, name })));
        });
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
        guestToken = null;
        isHost = false;
        memberCount = 1;
        reconnectAttempts = 0;
        clearSession();
        resetChatLog(); // room is gone — its chat goes with it, nothing kept around
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
        guestToken = session.guestToken;
        isHost = session.isHost;
        isSessionRestore = true;
        if (panelEl) panelEl.querySelector('#yt-pro-server-url').value = session.serverUrl || DEFAULT_SERVER_URL;
        setStatus('Restoring watch party…');

        const name = await getDisplayName();
        connect(() => {
            if (isHost && hostToken) {
                ws.send(JSON.stringify({ type: 'reclaim_host', code: roomCode, hostToken, name }));
            } else if (!isHost) {
                // rejoinToken lets the server recognize this as the SAME guest
                // resuming (e.g. after the tab hard-reloaded when the host
                // changed videos) instead of a stranger joining fresh — so it
                // won't post "left the room" / "joined the room" chat spam.
                ws.send(JSON.stringify({ type: 'join_room', code: roomCode, name, rejoinToken: guestToken }));
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
