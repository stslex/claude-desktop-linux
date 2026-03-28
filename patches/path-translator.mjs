/**
 * path-translator.mjs
 *
 * Injected as `import '<path>'` at the top of the main-process bundle by
 * patch-cowork.sh.  Self-activates only when process.type === "browser"
 * (Electron main process).
 *
 * Translation rule:
 *   /sessions/<uuid>/mnt/<mount-name>/…
 *     → ~/.local/share/claude-linux/sessions/<uuid>/<mount-name>/…
 *
 * Set COWORK_DEBUG=1 to log every translated path to stderr.
 */

import path from 'path';
import fs   from 'fs';
import os   from 'os';

// ---------------------------------------------------------------------------
// Double-init guard  (ESM modules are cached by URL, but guard anyway in case
// the bundle is concatenated or the module URL changes between builds)
// ---------------------------------------------------------------------------
const INIT_SYM      = Symbol.for('__claudePathTranslatorInitialised');
const TRANSLATE_SYM = Symbol.for('__claudeTranslatePath');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;

  const DEBUG = process.env.COWORK_DEBUG === '1';

  // -------------------------------------------------------------------------
  // Session base directory
  // -------------------------------------------------------------------------
  const SESSION_BASE = path.join(
    os.homedir(), '.local', 'share', 'claude-linux', 'sessions'
  );

  // Create eagerly so callers can write without additional checks.
  fs.mkdirSync(SESSION_BASE, { recursive: true });

  // -------------------------------------------------------------------------
  // Translation
  // -------------------------------------------------------------------------
  const SESSION_RE = /^\/sessions\/([^/]+)\/mnt\/([^/]+)(\/.*)?$/;

  // Save originals before patching so translatePath itself is not recursive.
  const _origJoin    = path.join.bind(path);
  const _origResolve = path.resolve.bind(path);

  function translatePath(inputPath) {
    if (typeof inputPath !== 'string') return inputPath;
    const m = SESSION_RE.exec(inputPath);
    if (!m) return inputPath;

    const [, uuid, mountName, rest = ''] = m;
    const translated = _origJoin(SESSION_BASE, uuid, mountName) + rest;

    if (DEBUG) {
      process.stderr.write(`[path-translator] ${inputPath} → ${translated}\n`);
    }
    return translated;
  }

  // Expose via global symbol so the exported wrapper below can reach it.
  global[TRANSLATE_SYM] = translatePath;

  // -------------------------------------------------------------------------
  // Monkey-patch path.join and path.resolve
  // -------------------------------------------------------------------------
  path.join    = (...segments) => translatePath(_origJoin(...segments));
  path.resolve = (...segments) => translatePath(_origResolve(...segments));

  // -------------------------------------------------------------------------
  // Monkey-patch fs.promises methods
  // -------------------------------------------------------------------------
  for (const method of ['open', 'readFile', 'writeFile', 'stat', 'readdir']) {
    if (typeof fs.promises[method] !== 'function') continue;
    const _orig = fs.promises[method].bind(fs.promises);
    fs.promises[method] = (p, ...rest) => _orig(translatePath(p), ...rest);
  }

  // -------------------------------------------------------------------------
  // Monkey-patch fs.realpathSync and fs.realpath
  // -------------------------------------------------------------------------
  if (typeof fs.realpathSync === 'function') {
    const _origSync = fs.realpathSync.bind(fs);
    const _origNative = typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native.bind(fs.realpathSync)
      : null;
    fs.realpathSync = (p, ...rest) => _origSync(translatePath(p), ...rest);
    if (_origNative) {
      fs.realpathSync.native = (p, ...rest) => _origNative(translatePath(p), ...rest);
    }
  }

  if (typeof fs.realpath === 'function') {
    const _origRealpath = fs.realpath.bind(fs);
    const _origNative = typeof fs.realpath.native === 'function'
      ? fs.realpath.native.bind(fs.realpath)
      : null;
    fs.realpath = (p, ...rest) => _origRealpath(translatePath(p), ...rest);
    if (_origNative) {
      fs.realpath.native = (p, ...rest) => _origNative(translatePath(p), ...rest);
    }
  }
}

// ---------------------------------------------------------------------------
// Export translatePath for use by the claude-swift stub's spawn().
// Delegates to the global so it works whether or not we initialised above.
// ---------------------------------------------------------------------------
export function translatePath(inputPath) {
  const fn = global[TRANSLATE_SYM];
  return fn ? fn(inputPath) : (typeof inputPath === 'string' ? inputPath : inputPath);
}
