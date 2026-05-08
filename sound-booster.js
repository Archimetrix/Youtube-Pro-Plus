// ── YouTube Pro + · Sound Booster ────────────────────────────────────────────
// Ported from YouTube Volume Booster by ToLIMan (MIT)
// Injects a "Volume Boost" button + slider into the YouTube player controls,
// exactly as the tampermonkey script does. Max gain: 14× (1400%).
(function () {
    'use strict';
    if (window.top !== window.self) return;
    if (window._ytProSoundBooster) return;
    window._ytProSoundBooster = true;

    let audioCtx   = null;
    let gainNode   = null;
    let videoEl    = null;
    let injected   = false;  // true when button/slider are in the DOM
    let enabled    = false;  // mirrors the popup toggle state
    let retryTimer = null;

    // ── OSD (same as tampermonkey original) ──────────────────────────────────
    function showVolumeOSD(volume) {
        const old = document.getElementById('ytpb-osd');
        if (old) old.remove();
        const d = document.createElement('div');
        d.id = 'ytpb-osd';
        Object.assign(d.style, {
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%,-50%)',
            background: 'rgba(0,0,0,0.72)', color: '#fff',
            padding: '10px 18px', borderRadius: '6px',
            fontSize: '15px', fontFamily: 'sans-serif', fontWeight: '600',
            zIndex: '2147483647', pointerEvents: 'none', letterSpacing: '0.5px'
        });
        d.textContent = `🔊 Volume: ${Math.round(volume)}%`;
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 1000);
    }

    // ── Audio graph ───────────────────────────────────────────────────────────
    function connectAudio(video) {
        if (audioCtx) return; // already connected
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            gainNode = audioCtx.createGain();
            gainNode.gain.value = 1.0;
            gainNode.connect(audioCtx.destination);
            const src = audioCtx.createMediaElementSource(video);
            src.connect(gainNode);
            video.addEventListener('play', () => {
                if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            });
            audioCtx.resume().catch(() => {});
        } catch (e) {
            audioCtx = null; gainNode = null;
        }
    }

    function setGain(sliderValue) {
        // tampermonkey formula: gain = sliderValue / 100
        // sliderValue 0-1400 → gain 0-14×
        if (!gainNode) return;
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        gainNode.gain.value = sliderValue / 100;
    }

    function resetGain() {
        if (gainNode) gainNode.gain.value = 1.0;
    }

    // ── Apply a boost level and update slider + OSD if injected ──────────────
    function applyLevel(level) {
        setGain(level);
        const slider = document.getElementById('ytpb-slider');
        if (slider) slider.value = String(level);
        showVolumeOSD(level);
    }

    // ── Inject button + slider into .ytp-chrome-controls ─────────────────────
    function inject(initialLevel) {
        if (injected) return;
        if (document.getElementById('ytpb-btn')) return; // guard against DOM duplicates

        const controls = document.querySelector('.ytp-chrome-controls');
        const video    = document.querySelector('.video-stream, #movie_player video, .html5-main-video');
        if (!controls || !video) return; // player not ready yet

        videoEl = video;
        connectAudio(video);

        // ── Volume Boost button (matches tampermonkey style exactly) ──
        const btn = document.createElement('button');
        btn.id = 'ytpb-btn';
        btn.innerText = 'Volume Boost';
        Object.assign(btn.style, {
            background: 'none', border: 'none', cursor: 'pointer',
            marginRight: '10px', color: '#fff', fontWeight: 'bold',
            fontSize: '13px', padding: '0', lineHeight: '1',
            alignSelf: 'center', flexShrink: '0'
        });

        // ── Slider (0-1400, default = stored boostLevel or 100) ──
        const slider = document.createElement('input');
        slider.id   = 'ytpb-slider';
        slider.type = 'range';
        slider.min  = '0';
        slider.max  = '1400';
        slider.step = '1';
        slider.value = String(initialLevel || 100);
        Object.assign(slider.style, {
            width: '120px',
            display: 'none',  // hidden until button is clicked
            transform: 'scaleX(-1)', // tampermonkey flips it
            alignSelf: 'center',
            cursor: 'pointer',
            accentColor: '#ff0050'
        });

        // Apply the stored boost level immediately on inject
        setGain(initialLevel || 100);

        // Slider input → update gain + OSD + persist to storage
        slider.addEventListener('input', function () {
            const val = parseFloat(this.value);
            setGain(val);
            showVolumeOSD(val);
            browser.storage.local.set({ boostLevel: val });
        });

        // Button toggles slider visibility; restores stored level when opening
        btn.addEventListener('click', function () {
            const hidden = slider.style.display === 'none';
            slider.style.display = hidden ? 'inline-block' : 'none';
            if (hidden) {
                browser.storage.local.get('boostLevel', r => {
                    const level = r.boostLevel || 100;
                    slider.value = String(level);
                    setGain(level);
                    showVolumeOSD(level);
                });
            }
        });

        // Prepend button, append slider — same as tampermonkey
        controls.insertBefore(btn, controls.firstChild);
        controls.appendChild(slider);

        injected = true;
    }

    function removeInjection() {
        const btn    = document.getElementById('ytpb-btn');
        const slider = document.getElementById('ytpb-slider');
        if (btn)    btn.remove();
        if (slider) slider.remove();
        injected = false;
        resetGain();
    }

    // ── Wait for YouTube player then inject ───────────────────────────────────
    function tryInject(level) {
        if (!enabled) return;
        if (injected) return;
        if (document.querySelector('.ytp-chrome-controls') &&
            document.querySelector('.video-stream, #movie_player video, .html5-main-video')) {
            inject(level);
        } else {
            // Player not ready — observe DOM for it
            if (retryTimer) return;
            retryTimer = setInterval(() => {
                if (!enabled) { clearInterval(retryTimer); retryTimer = null; return; }
                if (document.querySelector('.ytp-chrome-controls') &&
                    document.querySelector('.video-stream, #movie_player video, .html5-main-video')) {
                    inject(level);
                    clearInterval(retryTimer);
                    retryTimer = null;
                }
            }, 400);
        }
    }

    // YouTube SPA: re-inject after navigation
    let _lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== _lastUrl) {
            _lastUrl = location.href;
            removeInjection(); // clean up button + reset flag on navigation
            if (enabled) {
                // Restore stored boost level after navigation
                setTimeout(() => {
                    browser.storage.local.get('boostLevel', r => {
                        tryInject(r.boostLevel || 100);
                    });
                }, 1200);
            }
        }
    }).observe(document, { subtree: true, childList: true });

    // ── Boot: check stored toggle state + boost level ─────────────────────────
    browser.storage.local.get(['masterEnabled', 'audio', 'boostLevel'], res => {
        if (res.masterEnabled === false || res.audio === false) return;
        enabled = true;
        tryInject(res.boostLevel || 100);
    });

    // ── Messages from popup ───────────────────────────────────────────────────
    browser.runtime.onMessage.addListener((msg, _s, sendResponse) => {
        if (msg.action === 'toggleaudio') {
            enabled = msg.state;
            if (enabled) {
                const level = msg.level || 100;
                if (injected) {
                    // Already in DOM — just apply the level directly
                    applyLevel(level);
                } else {
                    tryInject(level);
                }
            } else {
                if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
                removeInjection();
            }
            sendResponse({ ok: true });
            return false;

        } else if (msg.action === 'masterToggleChanged' && !msg.state) {
            enabled = false;
            if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
            removeInjection();
            sendResponse({ ok: true });
            return false;
        }
        return false;
    });
})();
