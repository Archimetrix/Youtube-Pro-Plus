// UI helpers: remembers the last settings tab, and replaces native <select>
// popups (which can't be styled) with a liquid-glass dropdown. The original
// <select> stays in the DOM, hidden, so popup.js keeps reading/writing it.
(function () {
    // ── tab memory ─────────────────────────────────────────────────────────
    const tabs = document.querySelectorAll('#tabs input[name="tab"]');
    if (tabs.length && typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get('popupTab', (r) => {
            const saved = r && r.popupTab;
            const match = Array.from(tabs).find(t => t.value === saved);
            if (match) match.checked = true;
        });
        tabs.forEach(t => t.addEventListener('change', () => {
            if (t.checked) chrome.storage.local.set({ popupTab: t.value });
        }));
    }

    // ── glass dropdown ─────────────────────────────────────────────────────
    const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    const CHEV = '<svg class="gs-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    let openMenu = null;

    function closeMenu(immediate) {
        if (!openMenu) return;
        const { menu, btn } = openMenu;
        openMenu = null;
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('open');
        if (immediate) { menu.remove(); return; }
        menu.classList.add('leaving');
        setTimeout(() => menu.remove(), 140);
    }

    function enhance(sel) {
        sel.classList.add('gs-native');
        sel.tabIndex = -1;

        const wrap = document.createElement('div');
        wrap.className = 'gs';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gs-btn';
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
        btn.innerHTML = '<span class="gs-label"></span>' + CHEV;
        wrap.appendChild(btn);
        sel.parentNode.insertBefore(wrap, sel);
        wrap.appendChild(sel);

        const label = btn.querySelector('.gs-label');
        const sync = () => {
            const o = sel.options[sel.selectedIndex];
            label.textContent = o ? o.textContent : '';
        };
        // popup.js sets .value programmatically (no change event) – keep the label in step
        Object.defineProperty(sel, 'value', {
            configurable: true,
            get() { return valueDesc.get.call(sel); },
            set(v) { valueDesc.set.call(sel, v); sync(); }
        });
        sync();

        function choose(opt) {
            valueDesc.set.call(sel, opt.value);
            sync();
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            closeMenu();
            btn.focus();
        }

        function open() {
            closeMenu(true);
            const menu = document.createElement('div');
            menu.className = 'gs-menu';
            menu.setAttribute('role', 'listbox');
            Array.from(sel.options).forEach(o => {
                const it = document.createElement('button');
                it.type = 'button';
                it.className = 'gs-opt' + (o.value === sel.value ? ' selected' : '');
                it.setAttribute('role', 'option');
                it.setAttribute('aria-selected', o.value === sel.value ? 'true' : 'false');
                it.innerHTML = '<span>' + o.textContent + '</span>' + CHECK;
                it.addEventListener('click', () => choose(o));
                menu.appendChild(it);
            });
            document.body.appendChild(menu);

            const r = btn.getBoundingClientRect();
            menu.style.minWidth = Math.max(r.width, 120) + 'px';
            const mh = menu.offsetHeight, mw = menu.offsetWidth;
            const below = window.innerHeight - r.bottom - 10;
            const up = below < mh && r.top > below;
            menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
            menu.style.top = (up ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + 'px';
            menu.style.transformOrigin = (up ? 'bottom' : 'top') + ' right';
            btn.classList.add('open');
            btn.setAttribute('aria-expanded', 'true');
            openMenu = { menu, btn };
            const cur = menu.querySelector('.selected') || menu.firstChild;
            cur && cur.focus({ preventScroll: true });
        }

        btn.addEventListener('click', () => (openMenu && openMenu.btn === btn) ? closeMenu() : open());
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
        });
    }

    document.addEventListener('keydown', (e) => {
        if (!openMenu) return;
        const items = Array.from(openMenu.menu.querySelectorAll('.gs-opt'));
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const b = openMenu.btn; closeMenu(); b.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    }, true);
    document.addEventListener('pointerdown', (e) => {
        if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.btn.contains(e.target)) closeMenu();
    }, true);
    window.addEventListener('blur', () => closeMenu(true));

    document.querySelectorAll('select').forEach(enhance);
})();
