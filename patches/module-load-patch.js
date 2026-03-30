'use strict';
/**
 * module-load-patch.js
 *
 * Single, shared Module._load override that other patches register with.
 *
 * Problem: multiple patches (shell-env-patch.js, native-frame.js) each
 * saved Module._load at initialization time and replaced it with their own
 * wrapper.  This created a fragile chain — if the require() order changed,
 * one override could shadow the other.
 *
 * Solution: this module wraps Module._load exactly once and exposes a
 * registry.  Other patches call registerModuleInterceptor(name, fn) to
 * add a post-load transform.  The interceptor fn receives (request, mod)
 * and may return a replacement module or undefined to pass through.
 *
 * Must be require()'d before any patch that calls registerModuleInterceptor.
 */

const INIT_SYM = Symbol.for('__claudeModuleLoadPatchInitialised');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;

  /** @type {Map<string, (request: string, mod: any) => any>} */
  const interceptors = new Map();

  const Module = require('module');
  const origLoad = Module._load;

  Module._load = function patchedModuleLoad(request, parent, isMain) {
    const mod = origLoad.call(this, request, parent, isMain);

    for (const [, fn] of interceptors) {
      const replacement = fn(request, mod);
      if (replacement !== undefined) return replacement;
    }

    return mod;
  };

  /**
   * Register a module-load interceptor.
   *
   * @param {string} name   Unique name for this interceptor (for logging/debugging).
   * @param {(request: string, mod: any) => any} fn
   *   Called after the original Module._load.  Return a replacement module
   *   to override, or undefined to pass through to the next interceptor.
   */
  global.__claudeRegisterModuleInterceptor = function registerModuleInterceptor(name, fn) {
    interceptors.set(name, fn);
    process.stderr.write(`[module-load-patch] Registered interceptor: ${name}\n`);
  };

  process.stderr.write('[module-load-patch] Shared Module._load override installed.\n');
}
