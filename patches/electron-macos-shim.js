'use strict';
/**
 * electron-macos-shim.js
 *
 * Polyfills macOS-only Electron methods as no-ops on platforms where Electron
 * does not implement them (Linux, and partially Windows).  Covers the `app`
 * singleton and the `BrowserWindow` prototype.  (The macOS-only
 * `systemPreferences` NSUserDefaults write methods are handled by the sibling
 * systempreferences-shim.js, which predates this file.)
 *
 * Why this is needed
 * ------------------
 * Up to Claude Desktop 1.12603.1 each macOS-only call below was wrapped in a
 * `process.platform === "darwin"` guard, so the Linux port never reached it.
 * Release 1.13576.0 began removing those guards, exposing UNCONDITIONAL calls
 * to macOS-only Electron APIs that are `undefined` on Linux and therefore
 * throw `TypeError: … is not a function`:
 *
 *   - At top-level module load, before any window exists, a HARD crash
 *     ("Claude Desktop failed to launch"):
 *
 *         app.configureWebAuthn({ touchID: { keychainAccessGroup: "<team>.com.anthropic.claude.webauthn" } })
 *
 *   - During main-window setup, an unhandled promise rejection that aborts the
 *     window-show chain (the window never appears):
 *
 *         win.setWindowButtonPosition({ x, y })   // reposition macOS traffic-lights
 *
 * Rather than re-inserting brittle AST guards at each call site — which are
 * re-minified to a different shape every release, so the regression recurs —
 * we stub the missing methods on the shared `electron` singletons.  This is a
 * single table that future guard-removals can extend with one line each.
 *
 * Methods shimmed (all return no meaningful value on macOS, so a no-op is a
 * faithful substitute on Linux):
 *
 *   app.configureWebAuthn          Touch-ID/passkey authenticator setup. The
 *                                  confirmed 1.13576.0 HARD load-time crash.
 *                                  Linux Electron has its own WebAuthn handling,
 *                                  so skipping the macOS keychain wiring is
 *                                  correct.
 *   app.hide                       NSApplication "hide application". Called
 *                                  unguarded in the stealth-relaunch path
 *                                  (`app.hide()` when another app is fullscreen,
 *                                  to avoid a macOS Space switch). Latent — not
 *                                  reached at load and practically unreachable
 *                                  on Linux (no Spaces) — but genuinely
 *                                  unguarded, so we no-op it defensively.
 *   BrowserWindow.setWindowButtonPosition
 *                                  Reposition the macOS traffic-light buttons.
 *                                  Called from the main-window helper with only
 *                                  a window-alive guard (no platform guard), so
 *                                  it throws on Linux during window setup and
 *                                  the window fails to show. Irrelevant on Linux
 *                                  (custom frame via native-frame.js, no traffic
 *                                  lights).
 *   BrowserWindow.setHiddenInMissionControl
 *                                  Hide the window from macOS Mission Control.
 *                                  Two call sites are darwin-guarded; the
 *                                  quick-entry window's call is unguarded —
 *                                  latent crash when that window opens.
 *   BrowserWindow.setTrafficLightPosition
 *                                  Position macOS traffic-lights. Currently
 *                                  guarded by an `isMac()` check, so unreached
 *                                  on Linux today; stubbed defensively because
 *                                  it is the same macOS-only void method and the
 *                                  guard has a history of being removed.
 *
 * Scope: ONLY void macOS-only methods that are pure side effects. Methods whose
 * RETURN VALUE is consumed by the caller (app.getApplicationInfoForProtocol →
 * { name, icon, path }; app.moveToApplicationsFolder → boolean;
 * BrowserWindow.getWindowButtonPosition) are intentionally NOT shimmed — faking
 * their results would change behaviour, and every such call site in the bundle
 * is already wrapped in try/catch and degrades gracefully when the method is
 * absent.
 *
 * Define-if-missing: a genuine macOS build keeps its native implementations
 * untouched; only absent methods are stubbed.
 *
 * BrowserWindow note: this shim runs (via the require() prepend) BEFORE
 * native-frame.js installs its BrowserWindow Proxy. native-frame's Proxy wraps
 * the *original* BrowserWindow and forwards prototype lookups to
 * `OrigBrowserWindow.prototype` (see native-frame.js), so the methods stubbed
 * here on `BrowserWindow.prototype` are inherited by every window instance
 * regardless of construction path.
 *
 * Injected via require() at the top of the main-process bundle (before
 * index.js is required) by patch-cowork.sh.
 */

const INIT_SYM = Symbol.for('__claudeElectronMacosShimInitialised');

if (!global[INIT_SYM]) {
  global[INIT_SYM] = true;

  try {
    const electron = require('electron');

    // Each target pairs a host object with the macOS-only VOID methods to stub
    // when absent. Extend with one line per future guard-removal.
    const TARGETS = [
      { label: 'app', host: electron.app, methods: ['configureWebAuthn', 'hide'] },
      {
        label: 'BrowserWindow.prototype',
        host: electron.BrowserWindow && electron.BrowserWindow.prototype,
        methods: ['setWindowButtonPosition', 'setHiddenInMissionControl', 'setTrafficLightPosition'],
      },
    ];

    for (const { label, host, methods } of TARGETS) {
      if (!host) continue;
      for (const name of methods) {
        if (typeof host[name] !== 'function') {
          host[name] = function shimmedMacOsNoop() {};
          process.stderr.write(
            `[electron-macos-shim] Stubbed missing ${label}.${name}() → no-op\n`
          );
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[electron-macos-shim] Warning: ${e.message}\n`);
  }
}
