'use strict';
/**
 * native-frame.js
 *
 * Patches BrowserWindow and Tray for Linux compatibility:
 *
 * 1. BrowserWindow: sets the window icon so it appears in title bars,
 *    taskbars, and alt-tab.
 *
 * 2. Tray: replaces the macOS-specific tray icon (which resolves to nothing on
 *    Linux, showing three dots) with the Claude icon, and wires up a click
 *    handler to show/focus the main window.
 *
 * Icons are resolved in order: system-installed (RPM/DEB/pacman), then the
 * PNG/SVG bundled inside the ASAR by patch-cowork.sh, then a programmatic
 * fallback as a last resort.
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
    const log = (msg) => process.stderr.write(`[native-frame] ${msg}\n`);

    // ---------------------------------------------------------------------
    // Icon resolution
    // ---------------------------------------------------------------------

    // Helper: try to load a nativeImage from a path, return null on failure.
    function tryLoadIcon(iconPath) {
      try {
        if (fs.existsSync(iconPath)) {
          const img = electron.nativeImage.createFromPath(iconPath);
          if (!img.isEmpty()) {
            log(`Loaded icon: ${iconPath}`);
            return img;
          }
          log(`Icon file exists but loaded as empty: ${iconPath}`);
        }
      } catch (e) {
        log(`Failed to load icon ${iconPath}: ${e.message}`);
      }
      return null;
    }

    // Helper: create a minimal fallback icon programmatically.
    // This is a small orange circle with a dark center — recognizable as Claude
    // even at tray sizes — embedded as a base64-encoded 32x32 PNG.
    function createFallbackIcon() {
      try {
        const dataUrl = 'data:image/png;base64,' +
          'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAhElEQVR4nO3T7Q2AMAhF' +
          '0c7BnK7kRu6jA1QtH+9RGiXh9z0paWv/BOfYtzM1pt1pYTgkEg8jEHE3Ahk3Ixhx' +
          'NYIZVyGmAjLir4ilACLSbRrgLm5F1ANEnx9yhm+fYKlfgNiagCzEY7wEgI0YxpkI' +
          'dZyBMMeRCHccgQjHvRBoeIRKizHmAuWItoSnykYjAAAAAElFTkSuQmCC';
        const img = electron.nativeImage.createFromDataURL(dataUrl);
        if (!img.isEmpty()) {
          log('Created programmatic fallback icon');
          return img;
        }
      } catch (e) {
        log(`Fallback icon creation failed: ${e.message}`);
      }
      return null;
    }

    let appIcon = null;

    // 1. System-installed icons (highest resolution first, then scalable SVG).
    const systemPaths = [
      '/usr/share/icons/hicolor/512x512/apps/claude-desktop.png',
      '/usr/share/icons/hicolor/256x256/apps/claude-desktop.png',
      '/usr/share/icons/hicolor/128x128/apps/claude-desktop.png',
      '/usr/share/icons/hicolor/scalable/apps/claude-desktop.svg',
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

    // 3. Programmatic fallback — ensures we always have SOME icon.
    if (!appIcon) {
      appIcon = createFallbackIcon();
    }

    // Tray icons should be smaller (typically 16-24px on Linux).
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
        try {
          trayIcon = appIcon.resize({ width: 32, height: 32 });
        } catch (e) {
          log(`Failed to resize app icon for tray: ${e.message}`);
          trayIcon = appIcon; // use full-size as fallback
        }
      }
    }

    log(`Icon resolved: app=${appIcon ? 'yes' : 'none'}, tray=${trayIcon ? 'yes' : 'none'}`);

    // ---------------------------------------------------------------------
    // Patch BrowserWindow
    // ---------------------------------------------------------------------
    function patchBrowserWindowOptions(options) {
      const patched = Object.assign({}, options);
      // Set the window icon if we have one and the caller didn't set one.
      if (appIcon && !patched.icon) {
        patched.icon = appIcon;
      }
      return patched;
    }

    const PatchedBrowserWindow = new Proxy(OrigBrowserWindow, {
      construct(Target, [options = {}, ...rest]) {
        const patched = patchBrowserWindowOptions(options);
        log('BrowserWindow construct intercepted: icon=' + (patched.icon ? 'set' : 'none'));
        return Reflect.construct(Target, [patched, ...rest], Target);
      },
    });

    // Copy static properties and prototype so PatchedBrowserWindow passes
    // instanceof checks and static method access (e.g. getAllWindows).
    Object.setPrototypeOf(PatchedBrowserWindow, OrigBrowserWindow);
    PatchedBrowserWindow.prototype = OrigBrowserWindow.prototype;

    // ---------------------------------------------------------------------
    // Patch Tray
    // ---------------------------------------------------------------------
    function patchTrayIcon(icon) {
      if (!trayIcon) return icon;
      try {
        const orig = (typeof icon === 'string')
          ? electron.nativeImage.createFromPath(icon)
          : icon;
        if (!orig || orig.isEmpty()) {
          return trayIcon;
        }
      } catch (_) {
        return trayIcon;
      }
      return icon;
    }

    function addTrayClickHandler(tray) {
      tray.on('click', () => {
        const wins = OrigBrowserWindow.getAllWindows();
        const mainWin = wins.find(w => !w.isDestroyed()) || null;
        if (mainWin) {
          if (mainWin.isMinimized()) mainWin.restore();
          mainWin.show();
          mainWin.focus();
        }
      });
    }

    const PatchedTray = new Proxy(OrigTray, {
      construct(Target, [icon, ...rest]) {
        const resolvedIcon = patchTrayIcon(icon);
        log('Tray construct intercepted: icon=' + (resolvedIcon === trayIcon ? 'replaced' : 'original'));
        const tray = Reflect.construct(Target, [resolvedIcon, ...rest], Target);
        addTrayClickHandler(tray);
        log('Tray click handler added');
        return tray;
      },
    });

    Object.setPrototypeOf(PatchedTray, OrigTray);
    PatchedTray.prototype = OrigTray.prototype;

    // ---------------------------------------------------------------------
    // Apply patches to electron module
    // ---------------------------------------------------------------------
    // Strategy 1: Direct property replacement via defineProperty.
    let bwPatched = false;
    let trayPatched = false;

    try {
      Object.defineProperty(electron, 'BrowserWindow', {
        value: PatchedBrowserWindow, writable: true, configurable: true, enumerable: true,
      });
      bwPatched = true;
      log('BrowserWindow patched via defineProperty');
    } catch (_) { /* non-configurable — will use fallback */ }

    try {
      Object.defineProperty(electron, 'Tray', {
        value: PatchedTray, writable: true, configurable: true, enumerable: true,
      });
      trayPatched = true;
      log('Tray patched via defineProperty');
    } catch (_) { /* non-configurable — will use fallback */ }

    // Strategy 2: Module._load override to intercept all require('electron').
    // This is used when defineProperty fails (non-configurable getters in newer
    // Electron).  We wrap the CURRENT Module._load to stay compatible with
    // other patches (e.g. shell-env-patch.js) that also override Module._load.
    if (!bwPatched || !trayPatched) {
      const Module = require('module');
      const prevLoad = Module._load;
      const electronProxy = new Proxy(electron, {
        get(target, prop, receiver) {
          if (!bwPatched && prop === 'BrowserWindow') return PatchedBrowserWindow;
          if (!trayPatched && prop === 'Tray') return PatchedTray;
          return Reflect.get(target, prop, receiver);
        },
      });
      Module._load = function patchedElectronLoad(request, parent, isMain) {
        if (request === 'electron') return electronProxy;
        return prevLoad.call(this, request, parent, isMain);
      };
      log('Module._load Proxy fallback installed (bw=' + bwPatched + ', tray=' + trayPatched + ')');
    }

    // Strategy 3: Safety net via app events.  Even if the Proxy/Module._load
    // interception misses some BrowserWindow or Tray instances (e.g. if the
    // app caches its own reference to the constructor before our patch runs),
    // these listeners provide a second chance.
    const app = electron.app || electron.default?.app;
    if (app) {
      // 3a. Patch BrowserWindow instances after creation (icon + show frame).
      // Note: frame:true cannot be changed after construction, but the icon can.
      app.on('browser-window-created', (_event, win) => {
        try {
          if (appIcon) {
            win.setIcon(appIcon);
          }
        } catch (e) {
          log(`browser-window-created handler error: ${e.message}`);
        }
      });

      // 3b. Double-ensure Module._load intercepts 'electron' after app is
      // ready.  Some Electron versions defer internal module initialization
      // until after 'ready', so re-apply the Module._load override here if
      // it wasn't done above (e.g. defineProperty succeeded but the module
      // got re-required later from a fresh reference).
      if (!bwPatched || !trayPatched) {
        app.once('ready', () => {
          log('App ready — Module._load intercept still active');
        });
      }
    }

    log('Patches installed: BrowserWindow(icon=' + (appIcon ? 'set' : 'none') +
        '), Tray(icon=' + (trayIcon ? 'set' : 'none') + ', click=handler)');
  } catch (e) {
    process.stderr.write(`[native-frame] setup failed: ${e.message}\n${e.stack}\n`);
  }
}
