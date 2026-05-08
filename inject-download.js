(function () {
    'use strict';

    // ── 1. Read pending URL from extension storage ────────────────────────────
    chrome.storage.local.get(['ssvid_pending_url', 'ssvid_pending_ts'], (result) => {
        const ytUrl = result.ssvid_pending_url || '';
        const ts    = result.ssvid_pending_ts  || 0;

        if (!ytUrl || (Date.now() - ts) > 30000) return;

        chrome.storage.local.remove(['ssvid_pending_url', 'ssvid_pending_ts']);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => tryFillAndSubmit(ytUrl));
        } else {
            tryFillAndSubmit(ytUrl);
        }
    });

    // ── 2. React/Vue-safe value setter ────────────────────────────────────────
    function setNativeValue(el, value) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeSetter.call(el, value);
        ['input', 'change', 'keyup', 'paste'].forEach(evt =>
            el.dispatchEvent(new Event(evt, { bubbles: true, cancelable: true }))
        );
        el.dispatchEvent(new InputEvent('input', {
            bubbles: true, data: value, inputType: 'insertText'
        }));
    }

    // ── 3. Full mouse-event sequence that works with React event delegation ───
    // Plain .click() on a <div> often silently fails in React/Next.js apps.
    // Dispatching the full sequence (enter → over → down → up → click) triggers
    // React's synthetic event system reliably.
    function reactClick(el) {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window,
                       clientX: cx, clientY: cy };
        ['mouseenter','mouseover','mousemove','mousedown','mouseup','click'].forEach(type =>
            el.dispatchEvent(new MouseEvent(type, opts))
        );
        el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
        el.dispatchEvent(new PointerEvent('pointerup',   { ...opts, pointerId: 1 }));
    }

    // ── 4. STEP A: Fill the URL input and click the search/submit button ──────
    function tryFillAndSubmit(ytUrl, attempts = 0) {
        if (attempts > 60) return;

        const input = document.querySelector(
            'input[placeholder*="Paste" i], input[placeholder*="YouTube" i], ' +
            'input[type="url"], input[type="text"]'
        );
        const submitBtn = document.querySelector(
            'button[type="submit"], form button, ' +
            'button.download-btn, button.btn-download, ' +
            'button.search-btn, button.btn-search'
        ) || Array.from(document.querySelectorAll('button')).find(b =>
            /^(download|search|go|start)$/i.test(b.textContent.trim())
        );

        if (!input || !submitBtn) {
            setTimeout(() => tryFillAndSubmit(ytUrl, attempts + 1), 200);
            return;
        }

        input.focus();
        setNativeValue(input, ytUrl);

        setTimeout(() => {
            if (!input.value.includes('youtu')) setNativeValue(input, ytUrl);
            submitBtn.click();
            // 3-second head start so all format rows are fully rendered
            setTimeout(() => waitForFormatTable(), 3000);
        }, 400);
    }

    // ── 5. Extract resolution number from text ────────────────────────────────
    function qualityScore(text) {
        const m = text.match(/(\d{3,4})\s*p/i);
        return m ? parseInt(m[1]) : 0;
    }

    // Preferred ladder — 4K / 1440p are intentionally absent (hard cap ≤ 1080p)
    const PREFERRED = [1080, 720, 480, 360, 240, 144];

    // ── 6. STEP B: Wait for format rows ───────────────────────────────────────
    function waitForFormatTable(attempts = 0) {
        if (attempts > 80) return;

        const rows = collectRows();
        if (!rows.length) {
            setTimeout(() => waitForFormatTable(attempts + 1), 250);
            return;
        }

        pickBestAndDownload(rows);
    }

    // ── 7. Collect individual format rows ─────────────────────────────────────
    function collectRows() {
        // ssvid.net uses <li> rows inside a <ul>
        // Also catch table rows and generic format/quality containers on other sites
        const candidates = Array.from(document.querySelectorAll(
            'li, tr, .item, .format-row, .quality-row, ' +
            '[class*="format"], [class*="quality"], [class*="resolution"]'
        ));

        // Keep only leaf-level rows (rows that themselves mention a resolution,
        // but whose PARENT does NOT — avoids matching the wrapper <ul>/<tbody>)
        return candidates.filter(el => {
            const q = qualityScore(el.textContent);
            if (q === 0) return false;
            // Exclude wrapper elements whose children also have quality text
            const hasQualityChild = Array.from(el.children).some(
                c => qualityScore(c.textContent) > 0
            );
            return !hasQualityChild;
        });
    }

    // ── 8. STEP C: Pick best quality ≤ 1080p, click its download button ───────
    function pickBestAndDownload(rows, retries = 0) {
        const byQuality = {};
        rows.forEach(row => {
            const q = qualityScore(row.textContent);
            if (q > 0 && q <= 1080 && !byQuality[q]) byQuality[q] = row;
        });

        let bestRow = null, bestQ = 0;
        for (const q of PREFERRED) {
            if (byQuality[q]) { bestRow = byQuality[q]; bestQ = q; break; }
        }

        if (!bestRow) {
            if (retries < 10) setTimeout(() => pickBestAndDownload(collectRows(), retries + 1), 300);
            return;
        }

        console.log('[YT-Pro] Selecting quality:', bestQ + 'p');
        clickDownloadInRow(bestRow);
    }

    // ── 9. Find the download button/div inside a row and fire a React click ───
    function clickDownloadInRow(row) {
        // Strategy A: find a <span> or text node saying "Download",
        // then walk up to the nearest clickable ancestor (div with cursor-pointer)
        const allEls = Array.from(row.querySelectorAll('*'));

        // Find the element whose OWN text (not descendants) is "download"
        const dlSpan = allEls.find(el => {
            const own = Array.from(el.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent.trim().toLowerCase())
                .join('');
            return own.includes('download');
        });

        if (dlSpan) {
            // Walk up to the nearest cursor-pointer div (the actual clickable container)
            let clickTarget = dlSpan;
            let cur = dlSpan.parentElement;
            while (cur && cur !== row) {
                const cls = cur.className || '';
                if (cls.includes('cursor-pointer') || cur.tagName === 'BUTTON' ||
                    cur.tagName === 'A' || cur.getAttribute('role') === 'button') {
                    clickTarget = cur;
                    break;
                }
                cur = cur.parentElement;
            }
            console.log('[YT-Pro] Clicking:', clickTarget.tagName, clickTarget.className.slice(0, 60));
            fireClick(clickTarget);
            waitForFinalDownloadLink();
            return;
        }

        // Strategy B: direct file link
        const directLink = row.querySelector(
            'a[href$=".mp4"], a[href$=".webm"], a[href$=".mkv"], a[download], a[href*="download"]'
        );
        if (directLink && directLink.href && !directLink.href.startsWith('javascript')) {
            window.location.href = directLink.href;
            return;
        }

        // Strategy C: any cursor-pointer div or button in the row
        const btn = row.querySelector(
            'button, a[href], div[class*="cursor-pointer"], [role="button"]'
        );
        if (btn) { fireClick(btn); waitForFinalDownloadLink(); }
    }

    // ── 10. Unified click that works for both native elements and React divs ──
    function fireClick(el) {
        if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript')) {
            window.location.href = el.href;
            return;
        }
        if (el.tagName === 'BUTTON') {
            el.click();
            return;
        }
        // For React-rendered <div> / <span> — use the full mouse-event sequence
        reactClick(el);
    }

    // ── 11. STEP D: Watch for the final download confirmation ─────────────────
    function waitForFinalDownloadLink() {
        if (clickFinalDownloadIfPresent()) return;

        let giveUp = null;
        const obs = new MutationObserver(() => {
            if (clickFinalDownloadIfPresent()) { obs.disconnect(); clearTimeout(giveUp); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        giveUp = setTimeout(() => obs.disconnect(), 5 * 60 * 1000);
    }

    function clickFinalDownloadIfPresent() {
        // Only look inside modals / result panels — ignore nav/header noise
        const panels = Array.from(document.querySelectorAll(
            '[class*="modal"], [class*="result"], [class*="popup"], [class*="dialog"], [role="dialog"]'
        ));
        const scope = panels.length ? panels : [document.body];

        for (const panel of scope) {
            const all = Array.from(panel.querySelectorAll(
                'a, button, div[class*="cursor-pointer"], span[class*="cursor-pointer"], [role="button"]'
            ));
            const dlEl = all.find(el => {
                const inNoise = el.closest('header, footer, nav, [class*="banner"], [class*="ads"]');
                const t = el.textContent.trim().toLowerCase();
                const a = (el.getAttribute('aria-label') || '').toLowerCase();
                return !inNoise && (t.includes('download') || a.includes('download'));
            });
            if (!dlEl) continue;

            const rect = dlEl.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;

            fireClick(dlEl);
            return true;
        }
        return false;
    }

})();
