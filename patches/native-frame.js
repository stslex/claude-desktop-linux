'use strict';
/**
 * native-frame.js
 *
 * Patches BrowserWindow and Tray for Linux compatibility:
 *
 * 1. BrowserWindow: forces native OS window decorations (frame:true) and sets
 *    the window icon so it appears in title bars, taskbars, and alt-tab.
 *
 * 2. Tray: replaces the macOS-specific tray icon (which resolves to nothing on
 *    Linux, showing three dots) with the Claude icon, and wires up a click
 *    handler to show/focus the main window.
 *
 * Icons are resolved in order: system-installed (RPM/DEB/pacman), then the
 * PNG/SVG bundled inside the ASAR by patch-cowork.sh as a fallback.
 *
 * Injected at the top of the main-process bundle by patch-cowork.sh so it runs
 * before the app's BrowserWindow/Tray creation code.
 */

const INIT_SYM = Symbol.for('__claudeNativeFrameInitialised');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;
  try {
    const path = require('path');
    const fs = require('fs');
    const electron = require('electron');
    const OrigBrowserWindow = electron.BrowserWindow;
    const OrigTray = electron.Tray;
    const debug = process.env.DEBUG;

    // Helper: try to load a nativeImage from a path, return null on failure.
    function tryLoadIcon(iconPath) {
      try {
        if (fs.existsSync(iconPath)) {
          const img = electron.nativeImage.createFromPath(iconPath);
          if (!img.isEmpty()) {
            if (debug) process.stderr.write(`[native-frame] Loaded icon: ${iconPath}\n`);
            return img;
          }
        }
      } catch (_) {
        // ignore and try next
      }
      return null;
    }

    // Resolve icon: prefer system-installed icons (from RPM/DEB/pacman packages),
    // then fall back to the icon bundled inside the ASAR by patch-cowork.sh.
    let appIcon = null;

    // 1. System-installed icons (highest resolution first).
    const systemPaths = [
      '/usr/share/icons/hicolor/512x512/apps/claude-desktop.png',
      '/usr/share/icons/hicolor/256x256/apps/claude-desktop.png',
      '/usr/share/icons/hicolor/128x128/apps/claude-desktop.png',
    ];
    for (const iconPath of systemPaths) {
      appIcon = tryLoadIcon(iconPath);
      if (appIcon) break;
    }

    // 2. Bundled icon inside the ASAR (PNG preferred, SVG as last resort).
    if (!appIcon) {
      const bundledCandidates = [
        path.join(__dirname, 'claude-desktop.png'),
        path.join(__dirname, 'claude-desktop.svg'),
      ];
      for (const iconPath of bundledCandidates) {
        appIcon = tryLoadIcon(iconPath);
        if (appIcon) break;
      }
    }

    // Tray icons should be smaller (typically 16-24px on Linux).
    // Resize the app icon for the tray, or try to load a smaller system icon.
    let trayIcon = null;
    if (appIcon) {
      const smallSystemPaths = [
        '/usr/share/icons/hicolor/32x32/apps/claude-desktop.png',
        '/usr/share/icons/hicolor/48x48/apps/claude-desktop.png',
        '/usr/share/icons/hicolor/16x16/apps/claude-desktop.png',
      ];
      for (const iconPath of smallSystemPaths) {
        trayIcon = tryLoadIcon(iconPath);
        if (trayIcon) break;
      }
      if (!trayIcon) {
        // Resize the app icon to a tray-appropriate size.
        trayIcon = appIcon.resize({ width: 32, height: 32 });
      }
    }

    // -------------------------------------------------------------------------
    // Patch BrowserWindow
    // -------------------------------------------------------------------------
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
        // Set the window icon if we have one and the caller didn't set one.
        if (appIcon && !patched.icon) {
          patched.icon = appIcon;
        }
        return Reflect.construct(Target, [patched, ...rest], Target);
      },
    });

    // -------------------------------------------------------------------------
    // Patch Tray
    // -------------------------------------------------------------------------
    // The macOS app creates a Tray with a template image that doesn't exist on
    // Linux, resulting in three dots and no click behavior.  Replace the icon
    // and add a click handler that shows/focuses the main window.
    const PatchedTray = new Proxy(OrigTray, {
      construct(Target, [icon, ...rest]) {
        // Replace the icon if it's empty/broken or if we have a better one.
        let resolvedIcon = icon;
        if (trayIcon) {
          try {
            // Check if the original icon is a valid, non-empty nativeImage.
            const orig = (typeof icon === 'string')
              ? electron.nativeImage.createFromPath(icon)
              : icon;
            if (!orig || orig.isEmpty()) {
              resolvedIcon = trayIcon;
            }
          } catch (_) {
            resolvedIcon = trayIcon;
          }
        }

        const tray = Reflect.construct(Target, [resolvedIcon, ...rest], Target);

        // Wire up click to show/focus the main window (macOS handles this
        // natively but Linux tray click does nothing by default).
        tray.on('click', () => {
          const wins = electron.BrowserWindow.getAllWindows();
          const mainWin = wins.find(w => !w.isDestroyed()) || null;
          if (mainWin) {
            if (mainWin.isMinimized()) mainWin.restore();
            mainWin.show();
            mainWin.focus();
          }
        });

        if (debug) process.stderr.write('[native-frame] Tray patched: icon replaced, click handler added\n');
        return tray;
      },
    });

    // -------------------------------------------------------------------------
    // Apply patches to electron module
    // -------------------------------------------------------------------------
    // In newer Electron versions, properties on the electron module may be
    // non-configurable, causing Object.defineProperty to throw.  Try direct
    // property definition first; if that fails, override Module._load to
    // intercept all require('electron') calls and return a Proxy with
    // patched constructors.
    let bwPatched = false;
    let trayPatched = false;

    try {
      Object.defineProperty(electron, 'BrowserWindow', {
        value: PatchedBrowserWindow, writable: true, configurable: true, enumerable: true,
      });
      bwPatched = true;
    } catch (_) { /* non-configurable — will use fallback */ }

    try {
      Object.defineProperty(electron, 'Tray', {
        value: PatchedTray, writable: true, configurable: true, enumerable: true,
      });
      trayPatched = true;
    } catch (_) { /* non-configurable — will use fallback */ }

    if (!bwPatched || !trayPatched) {
      // Fallback: override Module._load to intercept all require('electron')
      // calls and return a Proxy with patched constructors.  This is more
      // reliable than patching Module._cache because Electron's built-in
      // modules may bypass the standard module cache entirely.
      const Module = require('module');
      const origLoad = Module._load;
      const electronProxy = new Proxy(electron, {
        get(target, prop, receiver) {
          if (!bwPatched && prop === 'BrowserWindow') return PatchedBrowserWindow;
          if (!trayPatched && prop === 'Tray') return PatchedTray;
          return Reflect.get(target, prop, receiver);
        },
      });
      Module._load = function(request, parent, isMain) {
        if (request === 'electron') return electronProxy;
        return origLoad.call(this, request, parent, isMain);
      };
      process.stderr.write('[native-frame] Used Module._load Proxy fallback for patching\n');
    }

    // Safety net: if BrowserWindow was not patched via defineProperty, at least
    // set the icon on windows as they are created.
    if (!bwPatched && appIcon) {
      const app = electron.app || electron.default?.app;
      if (app) {
        app.on('browser-window-created', (_event, win) => {
          try { win.setIcon(appIcon); } catch (_) { /* best effort */ }
        });
      }
    }

    if (debug) {
      process.stderr.write(`[native-frame] BrowserWindow patched: frame=true, icon=${appIcon ? 'set' : 'none'}\n`);
      process.stderr.write(`[native-frame] Tray patched: icon=${trayIcon ? 'set' : 'none'}\n`);
    }
  } catch (e) {
    process.stderr.write(`[native-frame] setup failed: ${e.message}\n`);
  }
}
