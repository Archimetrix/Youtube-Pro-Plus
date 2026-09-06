// pip-mode.js
// Auto-floats the YouTube video in a Picture-in-Picture window the instant
// the person switches away from the tab (another tab, another app, minimized
// window — anything that takes focus off this tab), and automatically closes
// it and resumes playback the instant they come back.
//
// Why this approach instead of a custom Document-PiP window:
// Chrome only allows a custom floating window (documentPictureInPicture) to
// be OPENED from a direct user click — it cannot be auto-triggered when the
// tab loses focus, because there's no user gesture at that moment. The
// browser's native Picture-in-Picture API solves this exact case on purpose:
// setting a video's `autoPictureInPicture` property tells Chrome to float
// that video automatically on tab-switch/minimize, and un-float it
// automatically when the person returns. It also gets the aspect ratio
// right natively, fixing the "video looks cut off" issue from a custom
// window's CSS.

(function () {
    'use strict';

    if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
        // Not supported in this browser — fail silently.
        return;
    }

    // -- Settings gate --------------------------------------------------------
    let pipModeEnabled = true;

    function isCtxValid() {
        try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
    }

    if (isCtxValid()) {
        chrome.storage.local.get(['pipmode'], (result) => {
            pipModeEnabled = result.pipmode !== false;
            applyEnabledState();
        });

        chrome.runtime.onMessage.addListener((request) => {
            if (request && request.action === 'togglepipmode') {
                pipModeEnabled = request.state !== false;
                applyEnabledState();
            }
        });
    }

    const STATE = { video: null, lastAppliedEnabled: null };

    function getMainVideo() {
        const activeRenderer = document.querySelector('ytd-reel-video-renderer[is-active]');
        if (activeRenderer) {
            const v = activeRenderer.querySelector('video');
            if (v) return v;
        }
        return document.querySelector('.html5-video-player video') || document.querySelector('video');
    }

    function enableAutoPip(video) {
        if (!video) return;
        video.disablePictureInPicture = false;
        // Kept for installed-PWA cases where this property alone is honored,
        // but on a regular tab like youtube.com the real hook Chrome checks
        // is the MediaSession action handler registered below.
        try { video.autoPictureInPicture = true; } catch (_) {}

        // This is the mechanism Chrome actually calls when the tab loses
        // focus and the "browser-initiated Auto Picture-in-Picture" feature
        // is active (Chrome 134+, currently rolling out — can be forced on
        // now at chrome://flags/#auto-picture-in-picture-for-video-playback).
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.setActionHandler('enterpictureinpicture', () => {
                    if (document.pictureInPictureElement !== video && !video.paused) {
                        video.requestPictureInPicture().catch(() => {});
                    }
                });
            } catch (_) {
                // Some Chrome versions don't yet support this action name — safe to ignore.
            }
        }

        // Requirement: coming back to the tab should always resume playback,
        // whether it happened to be paused or playing right as PiP closed.
        video.addEventListener('leavepictureinpicture', () => {
            video.play().catch(() => {});
        });
    }

    function disableAutoPip(video) {
        if (!video) return;
        try { video.autoPictureInPicture = false; } catch (_) {}
        // This is the flag that actually blocks PiP entry from EVERY trigger
        // source — our button, our mediaSession hook, AND the browser's own
        // "browser-initiated automatic picture-in-picture" heuristic (the
        // Brave/Chrome flag), which runs independently of page JavaScript
        // and otherwise ignores this extension's setting entirely.
        try { video.disablePictureInPicture = true; } catch (_) {}
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.setActionHandler('enterpictureinpicture', null); } catch (_) {}
        }
        if (document.pictureInPictureElement === video) {
            document.exitPictureInPicture().catch(() => {});
        }
    }

    function setup() {
        const video = getMainVideo();
        const videoChanged = video && video !== STATE.video;
        if (videoChanged) {
            STATE.video = video;
            STATE.lastAppliedEnabled = null; // force re-apply on a fresh element
        }
        // Always explicitly enable or disable on whatever video is currently
        // in the page — this must run even when the feature is OFF, because
        // YouTube frequently swaps in a new <video> element (ad breaks,
        // switching videos) and a fresh element defaults to PiP-allowed.
        // Skipping this step when disabled was the bug: any new video after
        // a toggle-off silently reverted to being PiP-eligible again.
        if (STATE.video && STATE.lastAppliedEnabled !== pipModeEnabled) {
            if (pipModeEnabled) enableAutoPip(STATE.video);
            else disableAutoPip(STATE.video);
            STATE.lastAppliedEnabled = pipModeEnabled;
        }
        if (pipModeEnabled) {
            injectButton();
        } else {
            const btn = document.getElementById('ytpp-pip-button');
            if (btn) btn.remove();
        }
    }

    function applyEnabledState() {
        STATE.lastAppliedEnabled = null; // force re-apply even if video is unchanged
        setup();
    }

    // -- Manual button ---------------------------------------------------------
    // autoPictureInPicture only fires on a real tab-switch/minimize. This
    // button covers the case where someone wants to pop it out immediately
    // without switching tabs first.
    function injectStyle() {
        if (document.getElementById('ytpp-pip-style')) return;
        const style = document.createElement('style');
        style.id = 'ytpp-pip-style';
        style.textContent = `
            #ytpp-pip-button {
                background: transparent; border: none; cursor: pointer;
                color: #fff; opacity: 0.9; padding: 0 8px;
                display: inline-flex; align-items: center; justify-content: center;
                height: 100%;
            }
            #ytpp-pip-button:hover { opacity: 1; }
        `;
        document.head.appendChild(style);
    }

    function makeButton() {
        const btn = document.createElement('button');
        btn.id = 'ytpp-pip-button';
        btn.type = 'button';
        btn.title = 'Pop out mini player now';
        btn.setAttribute('aria-label', 'Pop out mini player');
        btn.innerHTML = `
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/>
                <rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor"/>
            </svg>`;
        return btn;
    }

    function injectButton() {
        if (!pipModeEnabled) return;
        injectStyle();
        if (document.getElementById('ytpp-pip-button')) return;
        const controls = document.querySelector('.ytp-right-controls');
        if (!controls) return;

        const btn = makeButton();
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const video = getMainVideo();
            if (!video) return;
            if (document.pictureInPictureElement === video) {
                document.exitPictureInPicture().catch(() => {});
            } else {
                video.requestPictureInPicture().catch(() => {});
            }
        });
        controls.prepend(btn);
    }

    // YouTube is a SPA -- the player and its controls get re-rendered on
    // navigation between videos, so re-run setup whenever the DOM changes.
    const observer = new MutationObserver(() => setup());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setup();
})();
