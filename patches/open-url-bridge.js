'use strict';
/**
 * open-url-bridge.js
 *
 * On Linux, when the system handles a claude:// deep link (e.g. after OAuth),
 * it launches a new app process with the URL as a command-line argument.
 * Electron forwards this to the already-running first instance via the
 * "second-instance" event.  The macOS app code only listens for "open-url"
 * (a macOS-only Electron event).  This bridge emits "open-url" when either:
 *
 *   a) A second instance is launched with a claude:// URL in its argv, or
 *   b) This (first) instance was launched with a claude:// URL as argv[1+].
 *
 * Injected at the very top of the main-process bundle by patch-cowork.sh so
 * it runs before the app registers its own second-instance handler.
 */

const INIT_SYM = Symbol.for('__claudeOpenUrlBridgeInitialised');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;

  try {
    const electron = require('electron');
    const app = electron.app || electron.default?.app;
    if (!app) throw new Error('electron.app not available');

    // Register claude:// as a handled protocol so Electron knows about it.
    const registered = app.setAsDefaultProtocolClient('claude');
    process.stderr.write(`[open-url-bridge] setAsDefaultProtocolClient('claude') => ${registered}\n`);
    process.stderr.write(`[open-url-bridge] execPath: ${process.execPath}\n`);

    // Ensure the single-instance lock is held.  Without it, a second process
    // launched by the OS to handle claude:// will NOT trigger second-instance
    // on the first — it will just start a second window instead.
    const hadLock = app.hasSingleInstanceLock();
    if (!hadLock) {
      const gotLock = app.requestSingleInstanceLock();
      process.stderr.write(`[open-url-bridge] requestSingleInstanceLock() => ${gotLock} (hadLock=false)\n`);
    } else {
      process.stderr.write(`[open-url-bridge] already holds single instance lock\n`);
    }

    // -----------------------------------------------------------------------
    // Bridge second-instance → open-url
    // Fires when the OS launches a second copy of the app with a claude:// URL
    // (e.g. after OAuth completes in the browser).
    // -----------------------------------------------------------------------
    app.on('second-instance', (event, argv) => {
      const url = argv.find(a => typeof a === 'string' && /^claude:\/\//i.test(a));
      if (url) {
        process.stderr.write(`[open-url-bridge] second-instance → open-url: ${url}\n`);
        app.emit('open-url', event, url);
      }
    });

    // -----------------------------------------------------------------------
    // Handle startup with a claude:// URL in argv (first launch as protocol
    // handler before any instance is running).
    // -----------------------------------------------------------------------
    const startupUrl = process.argv.slice(1).find(
      a => typeof a === 'string' && /^claude:\/\//i.test(a)
    );
    if (startupUrl) {
      app.once('ready', () => {
        process.stderr.write(`[open-url-bridge] startup argv → open-url: ${startupUrl}\n`);
        // Provide a minimal event-like object so event.preventDefault() won't throw.
        app.emit('open-url', { preventDefault() {} }, startupUrl);
      });
    }

  } catch (e) {
    process.stderr.write(`[open-url-bridge] setup failed: ${e.message}\n`);
  }
}
