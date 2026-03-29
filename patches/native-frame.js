'use strict';
/**
 * native-frame.js
 *
 * Forces native OS window decorations (title bar + resize/move handles) on all
 * BrowserWindow instances and sets the window icon.
 *
 * The macOS app requests frameless windows (frame:false, titleBarStyle:'hiddenInset')
 * to render its own custom title bar inside the web content.  On Linux this leaves
 * a borderless window the WM cannot decorate.  This patch intercepts every
 * BrowserWindow constructor call before the main bundle runs and forces frame:true.
 *
 * It also sets the `icon` property on every BrowserWindow so the window and
 * taskbar show the Claude icon.  The icon is resolved in order: system-installed
 * icons (from RPM/DEB/pacman), then the PNG/SVG bundled inside the ASAR by
 * patch-cowork.sh as a fallback.
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

    if (debug) {
      process.stderr.write(`[native-frame] BrowserWindow patched: frame=true, icon=${appIcon ? 'set' : 'none'}\n`);
    }
  } catch (e) {
    process.stderr.write(`[native-frame] setup failed: ${e.message}\n`);
  }
}
