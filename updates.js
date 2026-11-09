(function () {
    'use strict';

    const MANIFEST_URL = 'https://raw.githubusercontent.com/Archimetrix/Youtube-Pro-Plus/main/manifest.json';
    const RELEASES_URL = 'https://github.com/Archimetrix/Youtube-Pro-Plus/releases/latest';
    const AMO_URL      = 'https://addons.mozilla.org/en-US/firefox/addon/youtube-pro-plus/';

    const $ = (id) => document.getElementById(id);
    const manifest = chrome.runtime.getManifest();
    const localVersion = manifest.version;
    const isFirefox = !!manifest.browser_specific_settings || /Firefox\//.test(navigator.userAgent);
    const demo = () => window.__YTPRO_DEMO__ || null;   // test hook only

    const states = ['st-checking', 'st-ok', 'st-err', 'st-new'];
    const show = (id) => states.forEach(s => { $(s).hidden = s !== id; });

    function isNewerVersion(local, remote) {
        const parse = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
        const l = parse(local), r = parse(remote);
        for (let i = 0; i < Math.max(l.length, r.length); i++) {
            const a = l[i] || 0, b = r[i] || 0;
            if (b > a) return true;
            if (b < a) return false;
        }
        return false;
    }

    /* ── state renderers ──────────────────────────────────────────────── */
    let stopFx = null;

    function renderUpToDate() {
        stopFx && stopFx(); stopFx = null;
        $('ok-ver').textContent = 'v' + localVersion;
        $('ok-time').textContent = 'Last checked just now';
        show('st-ok');
    }

    let shownVersion = null;
    function renderUpdate(version) {
        if (shownVersion === version && !$('st-new').hidden) return;
        shownVersion = version;
        const v = 'v' + version;
        $('new-ver').textContent = v;
        $('new-ver-2').textContent = v;
        $('old-ver').textContent = 'v' + localVersion;
        $('ff-ver').textContent = 'v' + version;
        $('dl-btn').href = isFirefox ? AMO_URL : RELEASES_URL;
        $('dl-label').textContent = isFirefox ? 'Update on Firefox Add-ons' : 'Download update';
        $('note-chromium').hidden = isFirefox;
        $('note-firefox').hidden = !isFirefox;
        show('st-new');
        stopFx && stopFx();
        stopFx = startRandomFx();
    }

    /* ── checking ─────────────────────────────────────────────────────── */
    let busy = false;
    async function check(manual) {
        if (busy) return;
        busy = true;
        $('check-btn').disabled = true;
        $('check-btn').classList.add('busy');
        $('check-label').textContent = 'Checking…';
        if (manual) show('st-checking');
        const minWait = new Promise(r => setTimeout(r, manual ? 650 : 0));

        try {
            let remoteVersion;
            if (demo()) {
                remoteVersion = demo().version || bump(localVersion);
            } else {
                const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                remoteVersion = (await res.json()).version;
            }
            await minWait;
            const found = isNewerVersion(localVersion, remoteVersion);
            if (!demo()) {
                chrome.storage.local.set({
                    lastUpdateCheck: Date.now(),
                    updateAvailable: found ? { version: remoteVersion, url: RELEASES_URL } : null
                });
            }
            found ? renderUpdate(remoteVersion) : renderUpToDate();
        } catch (e) {
            await minWait;
            show('st-err');
        } finally {
            busy = false;
            $('check-btn').disabled = false;
            $('check-btn').classList.remove('busy');
            $('check-label').textContent = 'Check for updates';
        }
    }
    function bump(v) { const p = v.split('.').map(Number); p[p.length - 1] = (p[p.length - 1] || 0) + 1; return p.join('.'); }

    /* ── random animation themes ──────────────────────────────────────── */
    const PALETTES = [
        ['#7c5cff', '#2bd9ff'], ['#ff5c8a', '#ffb45c'], ['#34e0a1', '#2bb8ff'],
        ['#ffd166', '#ff7a45'], ['#a78bfa', '#f0abfc'], ['#5eead4', '#60a5fa']
    ];
    const THEMES = ['aurora', 'liquid', 'pulse', 'orbit', 'embers', 'confetti', 'warp'];

    function pick(arr, avoid) {
        let x; do { x = arr[Math.floor(Math.random() * arr.length)]; } while (arr.length > 1 && x === avoid);
        return x;
    }
    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    };

    function startRandomFx() {
        const hero = $('hero'), layer = $('fx-layer'), logoFx = $('logo-fx'), canvas = $('fx-canvas');
        layer.innerHTML = ''; logoFx.innerHTML = '';
        THEMES.concat(['t-aurora']).forEach(t => hero.classList.remove('t-' + t));

        const forced = demo() && demo().anim;
        const theme = forced && THEMES.includes(forced) ? forced : pick(THEMES, store.get('ytpro_last_fx'));
        const pal = PALETTES[Math.floor(Math.random() * PALETTES.length)];
        store.set('ytpro_last_fx', theme);
        hero.style.setProperty('--c1', pal[0]);
        hero.style.setProperty('--c2', pal[1]);
        hero.classList.add('t-' + theme);

        const mk = (parent, tag, n) => { for (let i = 0; i < n; i++) parent.appendChild(document.createElement(tag)); };
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';

        if (theme === 'aurora' || theme === 'liquid') { mk(layer, 'div', 3); layer.querySelectorAll('div').forEach(d => d.className = 'blob'); return null; }
        if (theme === 'pulse') { mk(logoFx, 'i', 4); return null; }
        if (theme === 'orbit') { mk(logoFx, 'i', 3); return null; }
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
        canvas.style.display = 'block';
        return runCanvas(theme, canvas, hero, pal);
    }

    function runCanvas(theme, canvas, hero, pal) {
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let W = 0, H = 0, ox = 0, oy = 0, parts = [], raf = 0, alive = true, last = performance.now(), t0 = last, burstAt = 0;

        function size() {
            const r = hero.getBoundingClientRect(), l = $('logo-wrap').getBoundingClientRect();
            W = r.width; H = r.height;
            canvas.width = W * dpr; canvas.height = H * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ox = l.left - r.left + l.width / 2; oy = l.top - r.top + l.height / 2;
        }
        size();
        const ro = new ResizeObserver(size); ro.observe(hero);
        const rnd = (a, b) => a + Math.random() * (b - a);
        const cols = [pal[0], pal[1], '#ffffff', pal[0], pal[1]];

        function spawn() {
            if (theme === 'embers') {
                return { x: rnd(0, W), y: H + rnd(0, 40), vx: rnd(-8, 8), vy: -rnd(18, 60), r: rnd(1, 3.2), life: rnd(4, 8), age: 0, c: cols[(Math.random() * cols.length) | 0], ph: rnd(0, 6.28) };
            }
            if (theme === 'warp') {
                const a = rnd(0, 6.2832); const d = rnd(10, 40);
                return { x: ox + Math.cos(a) * d, y: oy + Math.sin(a) * d, a, v: rnd(40, 120), r: rnd(.6, 1.8), age: 0, life: rnd(1.5, 3.4), c: cols[(Math.random() * cols.length) | 0], px: 0, py: 0 };
            }
            return null;
        }
        function burst() {
            for (let i = 0; i < 90; i++) {
                const a = rnd(0, 6.2832), s = rnd(120, 420);
                parts.push({ x: ox, y: oy, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, w: rnd(5, 10), h: rnd(3, 6), rot: rnd(0, 6.28), vr: rnd(-9, 9), life: rnd(3, 5), age: 0, c: cols[(Math.random() * cols.length) | 0] });
            }
        }
        if (theme === 'embers') for (let i = 0; i < 46; i++) { const p = spawn(); p.y = rnd(0, H); p.age = rnd(0, p.life); parts.push(p); }
        if (theme === 'warp') for (let i = 0; i < 90; i++) { const p = spawn(); p.age = rnd(0, p.life); parts.push(p); }

        function frame(now) {
            if (!alive) return;
            const dt = Math.min(0.05, (now - last) / 1000); last = now;
            ctx.clearRect(0, 0, W, H);

            if (theme === 'embers') {
                ctx.globalCompositeOperation = 'lighter';
                parts.forEach((p, i) => {
                    p.age += dt; p.x += (p.vx + Math.sin(now / 900 + p.ph) * 10) * dt; p.y += p.vy * dt;
                    const k = p.age / p.life, a = Math.sin(Math.min(1, k) * Math.PI) * .9;
                    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
                    g.addColorStop(0, p.c); g.addColorStop(1, 'transparent');
                    ctx.globalAlpha = a * .55; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 5, 0, 6.2832); ctx.fill();
                    ctx.globalAlpha = a; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * .7, 0, 6.2832); ctx.fill();
                    if (k >= 1 || p.y < -20) parts[i] = spawn();
                });
            } else if (theme === 'warp') {
                ctx.globalCompositeOperation = 'lighter';
                parts.forEach((p, i) => {
                    p.age += dt; p.v *= 1 + 1.5 * dt;
                    const nx = p.x + Math.cos(p.a) * p.v * dt, ny = p.y + Math.sin(p.a) * p.v * dt;
                    const k = p.age / p.life, a = Math.min(1, k * 4) * (1 - k);
                    ctx.globalAlpha = a; ctx.strokeStyle = p.c; ctx.lineWidth = p.r; ctx.lineCap = 'round';
                    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
                    p.x = nx; p.y = ny;
                    if (k >= 1 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) parts[i] = spawn();
                });
            } else if (theme === 'confetti') {
                if (now - burstAt > 3800) { burstAt = now; burst(); }
                ctx.globalCompositeOperation = 'source-over';
                parts = parts.filter(p => p.age < p.life);
                parts.forEach(p => {
                    p.age += dt; p.vy += 520 * dt; p.vx *= 1 - 1.4 * dt; p.vy *= 1 - .5 * dt;
                    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
                    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.rot * 1.7));
                    ctx.globalAlpha = Math.min(1, (p.life - p.age) * 1.2); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
                });
            }
            raf = requestAnimationFrame(frame);
        }
        raf = requestAnimationFrame(frame);
        const vis = () => { if (document.hidden) { cancelAnimationFrame(raf); } else { last = performance.now(); raf = requestAnimationFrame(frame); } };
        document.addEventListener('visibilitychange', vis);
        return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', vis); ctx.clearRect(0, 0, W, H); canvas.style.display = 'none'; };
    }

    /* ── wire up ──────────────────────────────────────────────────────── */
    const view = $('update-view');
    $('cur-ver').textContent = 'v' + localVersion;
    $('check-btn').addEventListener('click', () => check(true));
    $('copy-addons').addEventListener('click', (e) => {
        const b = e.currentTarget;
        const done = () => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy about:addons'), 1600); };
        (navigator.clipboard ? navigator.clipboard.writeText('about:addons') : Promise.reject()).then(done, done);
    });

    function open() {
        view.classList.add('visible');
        // show a known update instantly, then verify it live
        chrome.storage.local.get('updateAvailable', (r) => {
            const info = r && r.updateAvailable;
            if (info && info.version && isNewerVersion(localVersion, info.version) && !demo()) renderUpdate(info.version);
            else show('st-checking');
            check(false);
        });
    }
    function close() {
        view.classList.remove('visible');
        stopFx && stopFx(); stopFx = null; shownVersion = null;
    }
    $('update-back').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.classList.contains('visible') && !document.querySelector('.gs-menu')) close(); });

    window.YTProUpdates = { open, close };
})();
