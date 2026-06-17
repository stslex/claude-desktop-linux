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

    // On Linux AppImages, setAsDefaultProtocolClient fails because process.execPath
    // points to a temporary mount path (/tmp/.mount_xxx/...) that the OS cannot
    // use to re-launch the app.  Work around this by manually writing a .desktop
    // file that points to $APPIMAGE (the real AppImage path) and registering it
    // as the x-scheme-handler/claude via xdg-mime.
    if (!registered && process.platform === 'linux' && process.env.APPIMAGE) {
      try {
        const { execFileSync } = require('child_process');
        const path = require('path');
        const fs   = require('fs');
        const os   = require('os');

        const appImagePath = process.env.APPIMAGE;
        const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
        fs.mkdirSync(appsDir, { recursive: true });

        const desktopPath = path.join(appsDir, 'claude-desktop.desktop');
        const desktopContent = [
          '[Desktop Entry]',
          'Name=Claude',
          'Exec=' + appImagePath + ' %u',
          'Terminal=false',
          'Type=Application',
          'Categories=Network;',
          'Icon=claude-desktop',
          'MimeType=x-scheme-handler/claude;',
          // StartupWMClass is the X11 WM_CLASS match key (and is also consulted by
          // Wayland bars like waybar's wlr/taskbar). The window reports app_id /
          // WM_CLASS "claude" (product name; overrides --class), so set it to
          // "claude" so the window maps to this entry + Icon.
          'StartupWMClass=claude',
          '',
        ].join('\n');

        fs.writeFileSync(desktopPath, desktopContent, { mode: 0o644 });
        process.stderr.write(`[open-url-bridge] Wrote .desktop file: ${desktopPath}\n`);

        try {
          execFileSync('xdg-mime', ['default', 'claude-desktop.desktop', 'x-scheme-handler/claude'],
            { stdio: 'pipe' });
          process.stderr.write(`[open-url-bridge] xdg-mime default registered x-scheme-handler/claude\n`);
        } catch (e) {
          process.stderr.write(`[open-url-bridge] xdg-mime failed: ${e.message}\n`);
        }

        try {
          execFileSync('update-desktop-database', [appsDir], { stdio: 'pipe' });
          process.stderr.write(`[open-url-bridge] update-desktop-database done\n`);
        } catch (_) {
          // update-desktop-database may not be available on all distros; non-fatal.
        }
      } catch (e) {
        process.stderr.write(`[open-url-bridge] AppImage protocol registration failed: ${e.message}\n`);
      }
    }

    // Enforce single-instance on Linux.  The macOS app never calls
    // requestSingleInstanceLock() — macOS guarantees a single app instance
    // natively via LaunchServices, so the bundle has zero single-instance
    // code.  On Linux there is no such guarantee: every launcher click / OS
    // protocol-handler invocation spawns a brand-new process.  Without a lock
    // (and a quit when the lock is lost) each launch opens a new window and a
    // new tray, and the duplicate StatusNotifierItem registrations collide.
    //
    // So WE own single-instance here: the first process keeps the lock; any
    // later process fails to get it and must quit immediately.  Electron
    // delivers that process's argv to the first instance via "second-instance"
    // (handled below), where we focus the existing window.
    const hadLock = app.hasSingleInstanceLock();
    const gotLock = hadLock || app.requestSingleInstanceLock();
    process.stderr.write(`[open-url-bridge] single-instance lock: gotLock=${gotLock} (hadLock=${hadLock})\n`);
    if (!gotLock) {
      // We are a secondary instance.  The primary already received this
      // process's argv via Electron's "second-instance" event (handled in the
      // primary, below), so quit before the app bundle creates a window / tray.
      // app.quit() before 'ready' prevents any window from being created.
      process.stderr.write('[open-url-bridge] secondary instance — quitting (primary will focus)\n');
      app.quit();
    } else {
      // Primary instance.  Focus (restore + show + raise) the main window.
      const focusMainWindow = () => {
        try {
          const BW = electron.BrowserWindow || electron.default?.BrowserWindow;
          if (!BW) return;
          const win = BW.getAllWindows().find((w) => !w.isDestroyed());
          if (win) {
            if (win.isMinimized()) win.restore();
            if (!win.isVisible()) win.show();
            win.focus();
          }
        } catch (e) {
          process.stderr.write(`[open-url-bridge] focusMainWindow failed: ${e.message}\n`);
        }
      };

      // ---------------------------------------------------------------------
      // second-instance: a second launch occurred (launcher click, or OS
      // protocol handler).  Bring the running window forward — the
      // single-instance UX the macOS-only code path provides natively — and,
      // if a claude:// URL was passed (e.g. after OAuth), bridge it to
      // "open-url" (a macOS-only event the app listens for).
      // ---------------------------------------------------------------------
      app.on('second-instance', (event, argv) => {
        focusMainWindow();
        const url = argv.find(a => typeof a === 'string' && /^claude:\/\//i.test(a));
        if (url) {
          process.stderr.write(`[open-url-bridge] second-instance → open-url: ${url}\n`);
          app.emit('open-url', event, url);
        }
      });

      // ---------------------------------------------------------------------
      // Handle startup with a claude:// URL in argv (first launch as protocol
      // handler before any instance is running).
      // ---------------------------------------------------------------------
      const startupUrl = process.argv.slice(1).find(
        a => typeof a === 'string' && /^claude:\/\//i.test(a)
      );
      if (startupUrl) {
        app.once('ready', () => {
          process.stderr.write(`[open-url-bridge] startup argv → open-url: ${startupUrl}\n`);
          // Minimal event-like object so event.preventDefault() won't throw.
          app.emit('open-url', { preventDefault() {} }, startupUrl);
        });
      }
    }

  } catch (e) {
    process.stderr.write(`[open-url-bridge] setup failed: ${e.message}\n`);
  }
}
