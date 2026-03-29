'use strict';
/**
 * native-frame.js
 *
 * Forces native OS window decorations (title bar + resize/move handles) on all
 * BrowserWindow instances and sets the window/tray icon.
 *
 * The macOS app requests frameless windows (frame:false, titleBarStyle:'hiddenInset')
 * to render its own custom title bar inside the web content.  On Linux this leaves
 * a borderless window the WM cannot decorate.  This patch intercepts every
 * BrowserWindow constructor call before the main bundle runs and forces frame:true.
 *
 * It also sets the `icon` property on every BrowserWindow so the window and
 * taskbar show the Claude icon.  The icon is loaded from a PNG bundled alongside
 * the main entry point (copied there by patch-cowork.sh).
 *
 * Injected at the top of the main-process bundle by patch-cowork.sh so it runs
 * before the app's BrowserWindow creation code.
 */

const INIT_SYM = Symbol.for('__claudeNativeFrameInitialised');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;
  try {
    const path = require('path');
    const fs = require('fs');
    const electron = require('electron');
    const OrigBrowserWindow = electron.BrowserWindow;

    // Load the app icon.  Try PNG first (best for nativeImage), then SVG.
    // The icon file is copied next to this script by patch-cowork.sh.
    let appIcon = null;
    const iconCandidates = [
      path.join(__dirname, 'claude-desktop.png'),
      path.join(__dirname, 'claude-desktop.svg'),
    ];
    for (const iconPath of iconCandidates) {
      if (fs.existsSync(iconPath)) {
        try {
          appIcon = electron.nativeImage.createFromPath(iconPath);
          if (!appIcon.isEmpty()) {
            process.stderr.write(`[native-frame] Loaded icon: ${iconPath}\n`);
            break;
          }
          appIcon = null;
        } catch (_) {
          // try next candidate
        }
      }
    }

    // Also try to find icons installed in standard system paths (RPM/DEB).
    if (!appIcon) {
      const systemPaths = [
        '/usr/share/icons/hicolor/256x256/apps/claude-desktop.png',
        '/usr/share/icons/hicolor/128x128/apps/claude-desktop.png',
        '/usr/share/icons/hicolor/512x512/apps/claude-desktop.png',
      ];
      for (const iconPath of systemPaths) {
        if (fs.existsSync(iconPath)) {
          try {
            appIcon = electron.nativeImage.createFromPath(iconPath);
            if (!appIcon.isEmpty()) {
              process.stderr.write(`[native-frame] Loaded system icon: ${iconPath}\n`);
              break;
            }
            appIcon = null;
          } catch (_) {
            // try next
          }
        }
      }
    }

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

    // Replace BrowserWindow in the cached electron module so all downstream
    // require('electron').BrowserWindow and destructured references get our proxy.
    Object.defineProperty(electron, 'BrowserWindow', {
      value: PatchedBrowserWindow,
      writable: true,
      configurable: true,
      enumerable: true,
    });

    // Set the Electron app dock/tray icon as well (shows in taskbar on some DEs).
    electron.app.whenReady().then(() => {
      if (appIcon) {
        try {
          // app.dock is macOS-only but setBadgeCount/etc exist — Linux uses
          // the BrowserWindow icon, but setting it on app level doesn't hurt.
          if (typeof electron.app.dock !== 'undefined' && electron.app.dock) {
            electron.app.dock.setIcon(appIcon);
          }
        } catch (_) {
          // dock API is macOS-only, ignore on Linux
        }
      }
    });

    process.stderr.write('[native-frame] BrowserWindow patched: frame=true, icon=set\n');
  } catch (e) {
    process.stderr.write(`[native-frame] setup failed: ${e.message}\n`);
  }
}
