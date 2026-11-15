// ── YouTube Pro + · Sound Booster ────────────────────────────────────────────
// Ported from YouTube Volume Booster by ToLIMan (MIT)
// Injects a "Volume Boost" button + slider into the YouTube player controls,
// exactly as the tampermonkey script does. Max gain: 14× (1400%).
(async function () {
  // ── Star-gate liveness guard ────────────────────────────────────────────
  // This feature only runs while the background confirms (a) it is actually
  // running stargate.js (not deleted/broken) and (b) this browser is
  // currently verified as having starred the repo. No response / not
  // verified => this script does nothing else, at all.
  const __ytppGateOK = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'YTPP_STAR_GATE_LIVE_CHECK' }, (res) => {
        resolve(!chrome.runtime.lastError && !!res?.ok && !!res?.verified);
      });
      setTimeout(() => resolve(false), 4000);
    } catch (e) {
      resolve(false);
    }
  });
  if (!__ytppGateOK) return;

    'use strict';
    if (window.top !== window.self) return;
    if (window._ytProSoundBooster) return;
    window._ytProSoundBooster = true;

    const VIDEO_SEL = '.video-stream, #movie_player video, .html5-main-video';

    let audioCtx   = null;
    let gainNode   = null;
    let limiter    = null;   // DynamicsCompressor used as a limiter (stops hard clipping)
    let shaper     = null;   // soft-knee saturator: last line of defence, never exceeds ±0.96
    let videoEl    = null;
    const routed   = new WeakSet(); // elements already wired in (createMediaElementSource only works once per element)
    let storeTimer = null;
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
    // Why this is more than "source → gain → speakers":
    //  * Gain above 1× pushes samples past full scale (±1.0). The sound card
    //    hard-clips them, which is the crackling/distortion you hear on loud
    //    parts of a video. So the boosted signal goes through a limiter whose
    //    threshold follows the boost level, then a soft saturator that can
    //    never exceed full scale.
    //  * Changing gain instantly makes a click ("zipper noise"), so every change
    //    glides over ~15 ms instead.
    //  * latencyHint:'playback' uses bigger audio buffers, which avoids
    //    underruns (crackle) while the YouTube page is busy.
    //  * The graph is only built when a boost is actually applied. At 100%
    //    the browser's own audio path is left completely alone.

    // Linear up to 0.85, then rounds off smoothly and tops out below 1.0.
    function makeSoftClipCurve() {
        const n = 4096, curve = new Float32Array(n), KNEE = 0.85, HEAD = 0.14;
        for (let i = 0; i < n; i++) {
            const x = (i / (n - 1)) * 2 - 1;
            const a = Math.abs(x);
            const y = a <= KNEE ? a : KNEE + HEAD * Math.tanh((a - KNEE) / HEAD);
            curve[i] = x < 0 ? -y : y;
        }
        return curve;
    }

    // Limiter threshold vs boost, measured on real Web Audio graphs so that
    // nothing exceeds full scale up to the 14x maximum:
    //   up to ~3x -> -6 dB, sliding to -14 dB at 14x.
    function limiterThresholdFor(gain) {
        const db = 20 * Math.log10(Math.max(gain, 1));
        return -(6 + 0.6 * Math.max(0, db - 9.5));
    }

    function resumeCtx() {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    }

    // Wire one <video> into the existing graph (once per element).
    function routeElement(video) {
        if (!audioCtx || !gainNode || !video || routed.has(video)) return;
        try {
            const src = audioCtx.createMediaElementSource(video);
            src.connect(gainNode);
            routed.add(video);
            video.addEventListener('play', resumeCtx);
        } catch (e) { /* element already captured elsewhere — leave its audio alone */ }
    }

    function connectAudio(video) {
        if (audioCtx) { routeElement(video); return true; }
        if (!video) return false;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            try { audioCtx = new AC({ latencyHint: 'playback' }); }
            catch (e) { audioCtx = new AC(); }

            gainNode = audioCtx.createGain();
            gainNode.gain.value = 1.0;

            limiter = audioCtx.createDynamicsCompressor();
            limiter.threshold.value = -6;
            limiter.knee.value      = 0;
            limiter.ratio.value     = 1;      // transparent until a boost is applied
            limiter.attack.value    = 0.003;
            limiter.release.value   = 0.15;

            shaper = audioCtx.createWaveShaper();
            shaper.curve = makeSoftClipCurve();
            shaper.oversample = '2x';

            gainNode.connect(limiter);
            limiter.connect(shaper);
            shaper.connect(audioCtx.destination);

            routeElement(video);
            resumeCtx();
            return true;
        } catch (e) {
            try { audioCtx && audioCtx.close(); } catch (e2) {}
            audioCtx = null; gainNode = null; limiter = null; shaper = null;
            return false;
        }
    }

    function setGain(sliderValue) {
        // sliderValue 0-1400 -> gain 0-14x
        const g = Math.max(0, sliderValue / 100);
        if (!gainNode) {
            if (g === 1) return; // nothing to boost: don't touch the native audio path
            if (!connectAudio(videoEl || document.querySelector(VIDEO_SEL))) return;
        }
        resumeCtx();
        const t = audioCtx.currentTime;
        gainNode.gain.cancelScheduledValues(t);
        gainNode.gain.setTargetAtTime(g, t, 0.015);
        limiter.ratio.cancelScheduledValues(t);
        limiter.ratio.setTargetAtTime(g > 1 ? 20 : 1, t, 0.05);
        limiter.threshold.cancelScheduledValues(t);
        limiter.threshold.setTargetAtTime(limiterThresholdFor(g), t, 0.05);
    }

    function resetGain() {
        if (gainNode) setGain(100);
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
        const video    = document.querySelector(VIDEO_SEL);
        if (!controls || !video) return; // player not ready yet

        videoEl = video;
        // If YouTube swapped in a new <video>, carry an existing boost over to it.
        if (gainNode) routeElement(video);

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
            // Dragging fires this hundreds of times a second; save once it settles.
            clearTimeout(storeTimer);
            storeTimer = setTimeout(() => browser.storage.local.set({ boostLevel: val }), 250);
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

    // keepGain: true while just navigating between videos, so the boost doesn't
    // drop to 1x and jump back up ~1.2 s later (a loud pop between videos).
    function removeInjection(keepGain) {
        const btn    = document.getElementById('ytpb-btn');
        const slider = document.getElementById('ytpb-slider');
        if (btn)    btn.remove();
        if (slider) slider.remove();
        injected = false;
        if (!keepGain) resetGain();
    }

    // ── Wait for YouTube player then inject ───────────────────────────────────
    function tryInject(level) {
        if (!enabled) return;
        if (injected) return;
        if (document.querySelector('.ytp-chrome-controls') &&
            document.querySelector(VIDEO_SEL)) {
            inject(level);
        } else {
            // Player not ready — observe DOM for it
            if (retryTimer) return;
            retryTimer = setInterval(() => {
                if (!enabled) { clearInterval(retryTimer); retryTimer = null; return; }
                if (document.querySelector('.ytp-chrome-controls') &&
                    document.querySelector(VIDEO_SEL)) {
                    inject(level);
                    clearInterval(retryTimer);
                    retryTimer = null;
                }
            }, 400);
        }
    }

    // YouTube SPA: re-inject after navigation. Uses YouTube's own navigation
    // event rather than a MutationObserver on the whole document (which ran on
    // every single DOM change YouTube makes).
    let _lastUrl = location.href;
    document.addEventListener('yt-navigate-finish', () => {
        if (location.href === _lastUrl) return;
        _lastUrl = location.href;
        removeInjection(true); // clean up button + reset flag, keep the boost
        if (enabled) {
            // Restore stored boost level after navigation
            setTimeout(() => {
                browser.storage.local.get('boostLevel', r => {
                    tryInject(r.boostLevel || 100);
                });
            }, 1200);
        }
    });

    // ── Stranded-script watchdog ──────────────────────────────────────────────
    // Reloading, updating, disabling or removing the extension while a YouTube
    // tab stays open leaves this script running in the page ("orphaned"): its
    // audio graph keeps processing but the extension can no longer control it,
    // and a freshly loaded version does NOT replace it until the tab is
    // refreshed. Notice that and put the audio back to normal.
    const strandedWatch = setInterval(() => {
        let alive = true;
        try { alive = !!chrome.runtime?.id; } catch (e) { alive = false; }
        if (alive) return;
        clearInterval(strandedWatch);
        enabled = false;
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
        try { removeInjection(); } catch (e) {}   // UI out, gain glides back to 1x
    }, 2000);

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
