'use strict';
/**
 * platform-override.js
 *
 * Last-resort fallback for the Cowork and Dispatch platform gates.
 *
 * If the AST-based patch (apply-platform-gate.mjs) fails to locate or patch
 * the gate function, this module provides a runtime safety net.  It monkey-
 * patches Electron's ipcMain so that any IPC message returning a platform-
 * gate "unsupported" / "unavailable" status is rewritten to "supported".
 *
 * Coverage:
 *   - ipcMain.handle()      — request/response IPC (invoke/handle pattern)
 *   - ipcMain.handleOnce()  — one-shot request/response IPC
 *   - ipcMain.on()          — event-based IPC (intercepts event.reply / event.sender.send)
 *   - webContents           — renderer-side navigator.platform + Notification API
 *
 * Injected via require() at the top of the main-process bundle by
 * patch-cowork.sh.
 */

try {
  const { ipcMain, app, Notification: ElectronNotification } = require('electron');

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  const NEGATIVE_STATUSES = new Set([
    // Core platform gate negatives
    'unsupported', 'unavailable', 'disabled',
    // Update/download gate negatives — shown when CCD binary is missing/outdated
    // or when the app thinks a newer Claude Desktop is required.
    'update_required', 'download_required', 'out_of_date', 'outdated',
    'requires_update', 'update_available', 'needs_update', 'not_ready',
  ]);

  /**
   * Recursively rewrite any { status: <negative> } to { status: "supported" }
   * and flip boolean "blocked" flags in an object tree.  Returns true if any
   * rewrite was performed.
   */
  function rewriteStatus(obj, channel, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return false;
    let changed = false;

    // Direct status property
    if (typeof obj.status === 'string' && NEGATIVE_STATUSES.has(obj.status.toLowerCase())) {
      process.stderr.write(
        `[platform-override] Rewriting IPC "${channel}" status ` +
        `"${obj.status}" → "supported"\n`
      );
      obj.status = 'supported';
      changed = true;
    }

    // Boolean support flags: { supported: false } → { supported: true }
    if (obj.supported === false) {
      process.stderr.write(
        `[platform-override] Rewriting IPC "${channel}" supported: false → true\n`
      );
      obj.supported = true;
      changed = true;
    }

    // Update/download flags: flip to "no update needed"
    if (obj.needsUpdate === true) {
      process.stderr.write(`[platform-override] Rewriting IPC "${channel}" needsUpdate: true → false\n`);
      obj.needsUpdate = false;
      changed = true;
    }
    if (obj.updateRequired === true) {
      process.stderr.write(`[platform-override] Rewriting IPC "${channel}" updateRequired: true → false\n`);
      obj.updateRequired = false;
      changed = true;
    }
    if (obj.downloadRequired === true) {
      process.stderr.write(`[platform-override] Rewriting IPC "${channel}" downloadRequired: true → false\n`);
      obj.downloadRequired = false;
      changed = true;
    }
    if (obj.isUpdateAvailable === true) {
      process.stderr.write(`[platform-override] Rewriting IPC "${channel}" isUpdateAvailable: true → false\n`);
      obj.isUpdateAvailable = false;
      changed = true;
    }

    // Recurse into nested objects (but not arrays of primitives)
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (rewriteStatus(val, channel + '.' + key, depth + 1)) changed = true;
      }
    }
    return changed;
  }

  // -------------------------------------------------------------------------
  // 1. Intercept ipcMain.handle() — request/response pattern
  // -------------------------------------------------------------------------
  if (ipcMain && typeof ipcMain.handle === 'function') {
    const origHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = function patchedHandle(channel, listener) {
      return origHandle(channel, async function wrappedListener(event, ...args) {
        const result = await listener(event, ...args);
        if (result && typeof result === 'object') {
          rewriteStatus(result, channel, 0);
        }
        return result;
      });
    };
  }

  // -------------------------------------------------------------------------
  // 2. Intercept ipcMain.handleOnce() — one-shot request/response pattern
  // -------------------------------------------------------------------------
  if (ipcMain && typeof ipcMain.handleOnce === 'function') {
    const origHandleOnce = ipcMain.handleOnce.bind(ipcMain);
    ipcMain.handleOnce = function patchedHandleOnce(channel, listener) {
      return origHandleOnce(channel, async function wrappedListener(event, ...args) {
        const result = await listener(event, ...args);
        if (result && typeof result === 'object') {
          rewriteStatus(result, channel, 0);
        }
        return result;
      });
    };
  }

  // -------------------------------------------------------------------------
  // 3. Intercept ipcMain.on() — event-based IPC
  //    Wraps event.reply() and event.sender.send() so responses flowing back
  //    to the renderer also get status rewriting.
  // -------------------------------------------------------------------------
  if (ipcMain && typeof ipcMain.on === 'function') {
    const origOn = ipcMain.on.bind(ipcMain);
    ipcMain.on = function patchedOn(channel, listener) {
      return origOn(channel, function wrappedListener(event, ...args) {
        // Wrap event.reply
        if (typeof event.reply === 'function') {
          const origReply = event.reply.bind(event);
          event.reply = function patchedReply(replyChannel, ...replyArgs) {
            for (const arg of replyArgs) {
              if (arg && typeof arg === 'object') {
                rewriteStatus(arg, replyChannel, 0);
              }
            }
            return origReply(replyChannel, ...replyArgs);
          };
        }

        // Wrap event.sender.send
        if (event.sender && typeof event.sender.send === 'function') {
          const origSend = event.sender.send.bind(event.sender);
          event.sender.send = function patchedSend(sendChannel, ...sendArgs) {
            for (const arg of sendArgs) {
              if (arg && typeof arg === 'object') {
                rewriteStatus(arg, sendChannel, 0);
              }
            }
            return origSend(sendChannel, ...sendArgs);
          };
        }

        return listener(event, ...args);
      });
    };
  }

  // -------------------------------------------------------------------------
  // 4. Patch webContents to intercept renderer-side platform and feature
  //    checks.  Covers: navigator.platform, Notification API (for Dispatch),
  //    and any renderer-side feature gate objects.
  // -------------------------------------------------------------------------
  if (app) {
    app.on('web-contents-created', (_event, webContents) => {
      webContents.on('dom-ready', () => {
        webContents.executeJavaScript(`
          (function() {
            // --- navigator.platform override ---
            // Some renderer-side checks use navigator.platform to determine
            // feature availability.
            try {
              if (typeof navigator !== 'undefined' && navigator.platform &&
                  navigator.platform.toLowerCase().startsWith('linux')) {
                Object.defineProperty(navigator, 'platform', {
                  get: function() { return 'MacIntel'; },
                  configurable: true,
                });
              }
            } catch(e) {}

            // --- Notification API polyfill for Dispatch ---
            // Dispatch uses push notifications (APNs on macOS).  On Linux,
            // Electron's Notification API works via libnotify/dbus but the
            // app may check Notification.isSupported() which can return false
            // on some Linux desktop environments.  Ensure it always reports
            // as supported so the Dispatch UI is not gated.
            try {
              if (typeof window !== 'undefined') {
                // Ensure Notification.permission is 'granted'
                if (typeof Notification !== 'undefined') {
                  if (Notification.permission !== 'granted') {
                    Object.defineProperty(Notification, 'permission', {
                      get: function() { return 'granted'; },
                      configurable: true,
                    });
                  }
                  // Override requestPermission to always resolve 'granted'
                  Notification.requestPermission = function() {
                    return Promise.resolve('granted');
                  };
                }
              }
            } catch(e) {}

            // --- Feature gate object interception ---
            // Some renderer-side code checks feature objects like
            // { dispatch: { supported: false } } or { cowork: { status: "unsupported" } }.
            // We intercept window.postMessage and MessagePort to catch these.
            // NOTE: This set must be kept in sync with NEGATIVE_STATUSES in the
            // main-process section above.  It is duplicated here because the renderer
            // runs in a separate V8 context and cannot share Node.js variables.
            try {
              var NEGATIVE = new Set([
                'unsupported','unavailable','disabled',
                'update_required','download_required','out_of_date','outdated',
                'requires_update','update_available','needs_update','not_ready',
              ]);
              function rewriteObj(o, depth) {
                if (!o || typeof o !== 'object' || depth > 4) return;
                if (typeof o.status === 'string' && NEGATIVE.has(o.status.toLowerCase())) {
                  o.status = 'supported';
                }
                if (o.supported === false) o.supported = true;
                if (o.needsUpdate === true)       o.needsUpdate = false;
                if (o.updateRequired === true)    o.updateRequired = false;
                if (o.downloadRequired === true)  o.downloadRequired = false;
                if (o.isUpdateAvailable === true) o.isUpdateAvailable = false;
                var keys = Object.keys(o);
                for (var i = 0; i < keys.length; i++) {
                  var v = o[keys[i]];
                  if (v && typeof v === 'object' && !Array.isArray(v)) rewriteObj(v, depth + 1);
                }
              }
              var origPostMessage = window.postMessage;
              window.postMessage = function(msg) {
                if (msg && typeof msg === 'object') rewriteObj(msg, 0);
                return origPostMessage.apply(this, arguments);
              };
            } catch(e) {}

            // --- Dispatch input event passthrough ---
            // Dispatch's message input may be gated behind a feature-availability
            // check that runs synchronously on the React render cycle.  We listen
            // for the 'dispatch-feature-check' custom event and immediately respond
            // with a 'dispatch-feature-ready' event so the input is never blocked.
            try {
              window.addEventListener('dispatch-feature-check', function() {
                window.dispatchEvent(new CustomEvent('dispatch-feature-ready', {
                  detail: { status: 'supported', supported: true }
                }));
              });
            } catch(e) {}
          })();
        `).catch(() => {});
      });
    });

    // -----------------------------------------------------------------------
    // 5. Ensure Electron Notification.isSupported() returns true
    //    (main-process side — the app may check this before enabling Dispatch)
    // -----------------------------------------------------------------------
    if (ElectronNotification && typeof ElectronNotification.isSupported === 'function') {
      const origIsSupported = ElectronNotification.isSupported;
      if (!origIsSupported()) {
        try {
          Object.defineProperty(ElectronNotification, 'isSupported', {
            value: function() { return true; },
            configurable: true,
            writable: true,
          });
          process.stderr.write(
            '[platform-override] Patched Notification.isSupported() → true\n'
          );
        } catch (e) {
          process.stderr.write(
            `[platform-override] Warning: could not patch Notification.isSupported: ${e.message}\n`
          );
        }
      }
    }
  }

  process.stderr.write('[platform-override] Platform override hooks installed (handle + handleOnce + on + renderer).\n');
} catch (e) {
  process.stderr.write(`[platform-override] Warning: ${e.message}\n`);
}
