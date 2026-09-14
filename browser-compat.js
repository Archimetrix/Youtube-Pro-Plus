/**
 * browser-compat.js — YouTube Pro +
 *
 * Bidirectional shim so both `chrome.*` and `browser.*` always resolve:
 *  - Firefox exposes `browser` (and sometimes `chrome`) → ensure `chrome` exists.
 *  - Chrome/Edge expose only `chrome` → ensure `browser` exists.
 * This lets every script use either namespace without branching.
 */
(function () {
    const root = typeof globalThis !== 'undefined' ? globalThis
                : typeof window     !== 'undefined' ? window
                : this;

    // Firefox without chrome alias → point chrome at browser
    if (typeof root.chrome === 'undefined' && typeof root.browser !== 'undefined') {
        root.chrome = root.browser;
    }

    // Chrome/Edge without browser alias → point browser at chrome
    if (typeof root.browser === 'undefined' && typeof root.chrome !== 'undefined') {
        root.browser = root.chrome;
    }
})();
