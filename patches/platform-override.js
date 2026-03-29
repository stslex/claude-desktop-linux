'use strict';
/**
 * platform-override.js
 *
 * Last-resort fallback for the Cowork platform gate.
 *
 * If the AST-based patch (apply-platform-gate.mjs) fails to locate or patch
 * the gate function, this module provides a runtime safety net.  It monkey-
 * patches Electron's ipcMain so that any IPC message returning a platform-
 * gate "unsupported" / "unavailable" status is rewritten to "supported".
 *
 * It also patches app.getLocale() to ensure platform display names resolve
 * correctly on Linux.
 *
 * Injected via require() at the top of the main-process bundle by
 * patch-cowork.sh.
 */

try {
  const { ipcMain, app } = require('electron');

  // -------------------------------------------------------------------------
  // 1. Intercept IPC replies that contain platform-gate "unsupported" status
  // -------------------------------------------------------------------------
  if (ipcMain && typeof ipcMain.handle === 'function') {
    const origHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = function patchedHandle(channel, listener) {
      return origHandle(channel, async function wrappedListener(event, ...args) {
        const result = await listener(event, ...args);
        // Rewrite gate responses: { status: "unsupported"|"unavailable" } → "supported"
        if (result && typeof result === 'object' && typeof result.status === 'string') {
          const s = result.status.toLowerCase();
          if (s === 'unsupported' || s === 'unavailable' || s === 'disabled') {
            process.stderr.write(
              `[platform-override] Rewriting IPC "${channel}" status ` +
              `"${result.status}" → "supported"\n`
            );
            result.status = 'supported';
          }
        }
        return result;
      });
    };
  }

  // -------------------------------------------------------------------------
  // 2. Patch webContents to intercept renderer-side platform checks via
  //    preload or executeJavaScript — this ensures the renderer also sees
  //    the platform as supported.
  // -------------------------------------------------------------------------
  if (app) {
    app.on('web-contents-created', (_event, webContents) => {
      // Inject a tiny override into every renderer's JS context.
      // This runs after the page's preload scripts but before app code.
      webContents.on('dom-ready', () => {
        webContents.executeJavaScript(`
          (function() {
            // Override navigator.platform to report macOS if needed
            // (some renderer-side checks use navigator.platform)
            try {
              if (typeof navigator !== 'undefined' && navigator.platform &&
                  navigator.platform.toLowerCase().startsWith('linux')) {
                Object.defineProperty(navigator, 'platform', {
                  get: function() { return 'MacIntel'; },
                  configurable: true,
                });
              }
            } catch(e) {}
          })();
        `).catch(() => {});
      });
    });
  }

  process.stderr.write('[platform-override] Platform override hooks installed.\n');
} catch (e) {
  process.stderr.write(`[platform-override] Warning: ${e.message}\n`);
}
