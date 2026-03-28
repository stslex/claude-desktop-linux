'use strict';
/**
 * native-frame.js
 *
 * Forces native OS window decorations (title bar + resize/move handles) on all
 * BrowserWindow instances.
 *
 * The macOS app requests frameless windows (frame:false, titleBarStyle:'hiddenInset')
 * to render its own custom title bar inside the web content.  On Linux this leaves
 * a borderless window the WM cannot decorate.  This patch intercepts every
 * BrowserWindow constructor call before the main bundle runs and forces frame:true.
 *
 * The in-app title bar is still visible inside the window — you'll have both the
 * native WM frame and the app's custom title bar.  Removing the in-app bar would
 * require deeper AST surgery on the renderer bundle; this is the minimal change
 * that makes the window manageable under GNOME/KDE/etc.
 *
 * Injected at the top of the main-process bundle by patch-cowork.sh so it runs
 * before the app's BrowserWindow creation code.
 */

const INIT_SYM = Symbol.for('__claudeNativeFrameInitialised');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;
  try {
    const electron = require('electron');
    const OrigBrowserWindow = electron.BrowserWindow;

    const PatchedBrowserWindow = new Proxy(OrigBrowserWindow, {
      construct(Target, [options = {}, ...rest]) {
        const patched = Object.assign({}, options, {
          frame: true,
          transparent: false,
        });
        // titleBarStyle / titleBarOverlay are macOS-specific and conflict with
        // frame:true on Linux — drop them so the WM draws a standard title bar.
        delete patched.titleBarStyle;
        delete patched.titleBarOverlay;
        return Reflect.construct(Target, [patched, ...rest], Target);
      },
    });

    // Replace BrowserWindow in the cached electron module so all downstream
    // require('electron').BrowserWindow and destructured references get our proxy.
    Object.defineProperty(electron, 'BrowserWindow', {
      value: PatchedBrowserWindow,
      writable: true,
      configurable: true,
      enumerable: true,
    });

    process.stderr.write('[native-frame] BrowserWindow patched: frame=true\n');
  } catch (e) {
    process.stderr.write(`[native-frame] setup failed: ${e.message}\n`);
  }
}
