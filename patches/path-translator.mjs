'use strict';
/**
 * path-translator.mjs  (CommonJS — loaded via require())
 *
 * Injected as the first require() at the main-process entry point.
 * Monkey-patches Node.js `path` and `fs` to redirect Cowork VM paths
 * to real host paths.
 *
 * Translation rule:
 *   /sessions/<uuid>/mnt/<mount-name>/…
 *     → ~/.local/share/claude-linux/sessions/<uuid>/<mount-name>/…
 *
 * Set COWORK_DEBUG=1 to log every translated path to stderr.
 */

// ---------------------------------------------------------------------------
// Guard against double-initialisation
// ---------------------------------------------------------------------------
const INIT_SYM = Symbol.for('__claudePathTranslatorInitialised');
if (global[INIT_SYM]) {
  module.exports = { translatePath: global[Symbol.for('__claudeTranslatePath')] };
  return; // already patched
}
global[INIT_SYM] = true;

// Self-activate only in the Electron main process.
if (process.type !== 'browser') {
  module.exports = { translatePath: p => p };
  return;
}

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const DEBUG = process.env.COWORK_DEBUG === '1';

// ---------------------------------------------------------------------------
// Session base directory
// ---------------------------------------------------------------------------
const SESSION_BASE = path.join(os.homedir(), '.local', 'share', 'claude-linux', 'sessions');

// Create it eagerly so callers can write without additional checks.
fs.mkdirSync(SESSION_BASE, { recursive: true });

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------
const SESSION_RE = /^\/sessions\/([^/]+)\/mnt\/([^/]+)(\/.*)?$/;

/**
 * Translate a /sessions/… path to its host equivalent.
 * Returns the original path if it does not match the pattern.
 * @param {string} inputPath
 * @returns {string}
 */
function translatePath(inputPath) {
  if (typeof inputPath !== 'string') return inputPath;
  const m = SESSION_RE.exec(inputPath);
  if (!m) return inputPath;

  const [, uuid, mountName, rest = ''] = m;
  const translated = path.join(SESSION_BASE, uuid, mountName) + rest;

  if (DEBUG) {
    process.stderr.write(`[path-translator] ${inputPath} → ${translated}\n`);
  }
  return translated;
}

// Expose via global symbol so the guard block above can re-export it.
global[Symbol.for('__claudeTranslatePath')] = translatePath;

// ---------------------------------------------------------------------------
// Monkey-patch path.join and path.resolve
// ---------------------------------------------------------------------------
const _origJoin    = path.join.bind(path);
const _origResolve = path.resolve.bind(path);

path.join = (...segments) => translatePath(_origJoin(...segments));
path.resolve = (...segments) => translatePath(_origResolve(...segments));

// ---------------------------------------------------------------------------
// Monkey-patch fs.promises methods
// ---------------------------------------------------------------------------
const _promiseMethods = ['open', 'readFile', 'writeFile', 'stat', 'readdir'];

for (const method of _promiseMethods) {
  if (typeof fs.promises[method] !== 'function') continue;
  const _orig = fs.promises[method].bind(fs.promises);
  fs.promises[method] = (p, ...rest) => _orig(translatePath(p), ...rest);
}

// ---------------------------------------------------------------------------
// Monkey-patch fs.realpathSync and fs.realpath
// ---------------------------------------------------------------------------
if (typeof fs.realpathSync === 'function') {
  const _orig = fs.realpathSync.bind(fs);
  fs.realpathSync = (p, ...rest) => _orig(translatePath(p), ...rest);
  // Preserve any sub-properties (e.g. fs.realpathSync.native)
  if (typeof _orig.native === 'function') {
    fs.realpathSync.native = (p, ...rest) => _orig.native(translatePath(p), ...rest);
  }
}

if (typeof fs.realpath === 'function') {
  const _orig = fs.realpath.bind(fs);
  fs.realpath = (p, ...rest) => _orig(translatePath(p), ...rest);
  if (typeof _orig.native === 'function') {
    fs.realpath.native = (p, ...rest) => _orig.native(translatePath(p), ...rest);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { translatePath };
