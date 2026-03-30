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
  // -- Platform-gate statuses (always rewritten) --
  const NEGATIVE_STATUSES = new Set([
    'unsupported', 'unavailable', 'disabled',
  ]);

  // -- Update/download gate statuses (only rewritten on CCD/cowork channels) --
  const UPDATE_STATUSES = new Set([
    'update_required', 'download_required', 'out_of_date', 'outdated',
    'requires_update', 'update_available', 'needs_update', 'not_ready',
  ]);

  /**
   * Returns true when `channel` refers to a CCD / cowork / plugin subsystem
   * whose update signals should be suppressed (there is no CCD binary on
   * Linux).  Generic channels (e.g. "app-update") are left untouched so
   * Claude Desktop's own update notifications can pass through.
   */
  const CCD_CHANNEL_RE = /ccd|cowork|binary|plugin/i;
  function isCcdChannel(channel) {
    return CCD_CHANNEL_RE.test(channel);
  }

  /**
   * Recursively rewrite platform-gate fields in an object tree.
   *
   * Two categories of rewrites:
   *   1. Platform gates (status: "unsupported", supported: false) — always
   *      rewritten regardless of channel.
   *   2. Update/download gates (needsUpdate, updateRequired, …) — only
   *      rewritten when the channel matches CCD/cowork/binary/plugin so that
   *      Claude Desktop's own update notifications are not suppressed.
   *
   * Returns true if any rewrite was performed.
   */
  function rewriteStatus(obj, channel, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return false;
    let changed = false;
    const ccd = isCcdChannel(channel);

    // --- Platform gate rewrites (always apply) ---

    if (typeof obj.status === 'string') {
      const lower = obj.status.toLowerCase();
      if (NEGATIVE_STATUSES.has(lower)) {
        process.stderr.write(
          `[platform-override] [gate] "${channel}": status "${obj.status}" → "supported"\n`
        );
        obj.status = 'supported';
        changed = true;
      } else if (ccd && UPDATE_STATUSES.has(lower)) {
        process.stderr.write(
          `[platform-override] [ccd-update] "${channel}": status "${obj.status}" → "supported"\n`
        );
        obj.status = 'supported';
        changed = true;
      }
    }

    if (obj.supported === false) {
      process.stderr.write(
        `[platform-override] [gate] "${channel}": supported: false → true\n`
      );
      obj.supported = true;
      changed = true;
    }

    // --- Update/download suppression (CCD channels only) ---

    if (ccd) {
      if (obj.needsUpdate === true) {
        process.stderr.write(`[platform-override] [ccd-update] "${channel}": needsUpdate → false\n`);
        obj.needsUpdate = false;
        changed = true;
      }
      if (obj.updateRequired === true) {
        process.stderr.write(`[platform-override] [ccd-update] "${channel}": updateRequired → false\n`);
        obj.updateRequired = false;
        changed = true;
      }
      if (obj.downloadRequired === true) {
        process.stderr.write(`[platform-override] [ccd-update] "${channel}": downloadRequired → false\n`);
        obj.downloadRequired = false;
        changed = true;
      }
      if (obj.isUpdateAvailable === true) {
        process.stderr.write(`[platform-override] [ccd-update] "${channel}": isUpdateAvailable → false\n`);
        obj.isUpdateAvailable = false;
        changed = true;
      }
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
            // NOTE: These sets must be kept in sync with the main-process
            // equivalents above.  Duplicated because the renderer runs in a
            // separate V8 context and cannot share Node.js variables.
            try {
              // Platform-gate statuses — always rewritten
              var NEGATIVE = new Set([
                'unsupported','unavailable','disabled',
              ]);
              // Update/download statuses — only rewritten in CCD/cowork messages
              var UPDATE_NEG = new Set([
                'update_required','download_required','out_of_date','outdated',
                'requires_update','update_available','needs_update','not_ready',
              ]);
              var CCD_RE = /ccd|cowork|binary|plugin/i;

              function rewriteObj(o, depth, isCcd) {
                if (!o || typeof o !== 'object' || depth > 4) return;
                if (typeof o.status === 'string') {
                  var sl = o.status.toLowerCase();
                  if (NEGATIVE.has(sl)) {
                    o.status = 'supported';
                  } else if (isCcd && UPDATE_NEG.has(sl)) {
                    o.status = 'supported';
                  }
                }
                if (o.supported === false) o.supported = true;
                // Update flags — only suppress for CCD/cowork channels
                if (isCcd) {
                  if (o.needsUpdate === true)       o.needsUpdate = false;
                  if (o.updateRequired === true)    o.updateRequired = false;
                  if (o.downloadRequired === true)  o.downloadRequired = false;
                  if (o.isUpdateAvailable === true) o.isUpdateAvailable = false;
                }
                var keys = Object.keys(o);
                for (var i = 0; i < keys.length; i++) {
                  var v = o[keys[i]];
                  if (v && typeof v === 'object' && !Array.isArray(v)) rewriteObj(v, depth + 1, isCcd);
                }
              }
              var origPostMessage = window.postMessage;
              window.postMessage = function(msg) {
                if (msg && typeof msg === 'object') {
                  // Determine if this message relates to CCD/cowork subsystem
                  var channelHint = (msg.channel || msg.type || '');
                  rewriteObj(msg, 0, CCD_RE.test(channelHint));
                }
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
