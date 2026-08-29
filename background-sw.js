/**
 * background-sw.js — YouTube Pro + (Chrome / Edge)
 *
 * Chrome MV3 requires a single service-worker file.
 * We use importScripts() to pull in the shared shim and the real logic
 * so the Firefox version (background.scripts array) stays untouched.
 */
importScripts('browser-compat.js', 'background.js', 'downloader-background.js', 'stargate.js');
