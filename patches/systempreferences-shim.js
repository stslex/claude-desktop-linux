'use strict';
/**
 * systempreferences-shim.js
 *
 * Polyfills macOS-only Electron `systemPreferences` NSUserDefaults write
 * methods as no-ops on platforms where Electron does not implement them
 * (Linux, and partially Windows).
 *
 * Why this is needed
 * ------------------
 * Claude Desktop's main bundle calls, UNCONDITIONALLY during app init:
 *
 *     systemPreferences.setUserDefault("NSAutoFillHeuristicsEnabled", "boolean", false)
 *
 * `setUserDefault` (and the sibling NSUserDefaults methods) only exist in
 * Electron's macOS build.  On Linux the method is `undefined`, so the call
 * throws `TypeError: systemPreferences.setUserDefault is not a function` at
 * top-level module load — before any window is created — and the app never
 * starts.
 *
 * Up to Claude Desktop 1.12603.1 this call was wrapped in an upstream
 * `process.platform === "darwin"` guard (`isMac && (...)`), so the Linux port
 * never reached it.  Release 1.13576.0 removed that guard, exposing the crash.
 * Rather than re-inserting a brittle AST guard at the call site — which is
 * re-minified to a different shape every release — we shim the missing methods
 * on the shared `electron` singleton so the unguarded call is harmless on
 * every platform.
 *
 * Scope: ONLY the write-side NSUserDefaults methods, which are pure side
 * effects with no meaningful return value on Linux.  Reader methods
 * (getUserDefault) and permission APIs (askForMediaAccess, promptTouchID,
 * getMediaAccessStatus) are intentionally NOT touched — faking their results
 * would change behaviour, and their call sites are already platform-guarded.
 *
 * Define-if-missing: a genuine macOS build keeps its native implementations
 * untouched; only absent methods are stubbed.
 *
 * Injected via require() at the top of the main-process bundle (before
 * index.js is required) by patch-cowork.sh.
 */

const INIT_SYM = Symbol.for('__claudeSystemPreferencesShimInitialised');

if (!global[INIT_SYM]) {
  global[INIT_SYM] = true;

  try {
    const { systemPreferences } = require('electron');

    if (systemPreferences) {
      // macOS-only NSUserDefaults write methods that are safe to no-op when
      // absent. Each returns no meaningful value on macOS, so a no-op is a
      // faithful substitute on Linux.
      const NOOP_METHODS = ['setUserDefault', 'removeUserDefault', 'registerDefaults'];

      for (const name of NOOP_METHODS) {
        if (typeof systemPreferences[name] !== 'function') {
          systemPreferences[name] = function shimmedNSUserDefaultsNoop() {};
          process.stderr.write(
            `[systempreferences-shim] Stubbed missing systemPreferences.${name}() → no-op\n`
          );
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[systempreferences-shim] Warning: ${e.message}\n`);
  }
}
