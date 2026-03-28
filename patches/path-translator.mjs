/**
 * path-translator.mjs
 *
 * Injected as the first require/import in the main-process bundle.
 * Monkey-patches Node.js `path` and `fs.promises` to redirect Cowork VM paths
 * to real host paths.
 *
 * Translation rule:
 *   /sessions/<uuid>/mnt/<mount-name>/…
 *     → ~/.local/share/claude-linux/sessions/<uuid>/<mount-name>/…
 *
 * The mount table is populated by the claude-swift stub via
 * globalThis.__claudeRegisterMounts(sessionId, mounts).
 *
 * Set COWORK_DEBUG=1 to log intercepted paths to stderr.
 */

import path from 'path';
import fs   from 'fs';
import os   from 'os';

const DEBUG       = process.env.COWORK_DEBUG === '1';
const SESSION_BASE = path.join(os.homedir(), '.local', 'share', 'claude-linux', 'sessions');

// ---------------------------------------------------------------------------
// Mount table: Map<sessionId, Map<mountName, hostPath>>
// ---------------------------------------------------------------------------
/** @type {Map<string, Map<string, string>>} */
const mountTable = new Map();

/**
 * Called by the claude-swift stub before spawning a Cowork session.
 * @param {string} sessionId
 * @param {Array<{name: string, hostPath: string}>} mounts
 */
globalThis.__claudeRegisterMounts = function registerMounts(sessionId, mounts) {
  const m = new Map();
  for (const { name, hostPath } of mounts) {
    m.set(name, hostPath);
    if (DEBUG) process.stderr.write(`[path-translator] register mount [${sessionId}] ${name} → ${hostPath}\n`);
  }
  mountTable.set(sessionId, m);
};

// ---------------------------------------------------------------------------
// Translation logic
// ---------------------------------------------------------------------------
const SESSION_RE = /^\/sessions\/([^/]+)\/mnt\/([^/]+)(\/.*)?$/;

/**
 * Translate a /sessions/… path to its host equivalent.
 * Returns the original path if it does not match the pattern.
 * @param {string} p
 * @returns {string}
 */
function translate(p) {
  if (typeof p !== 'string') return p;
  const m = SESSION_RE.exec(p);
  if (!m) return p;

  const [, sessionId, mountName, rest = ''] = m;
  const mounts = mountTable.get(sessionId);

  let hostBase;
  if (mounts && mounts.has(mountName)) {
    hostBase = mounts.get(mountName);
  } else {
    // Fallback: map to the session directory under SESSION_BASE.
    hostBase = path.join(SESSION_BASE, sessionId, mountName);
  }

  const translated = hostBase + rest;
  if (DEBUG) process.stderr.write(`[path-translator] ${p} → ${translated}\n`);
  return translated;
}

// ---------------------------------------------------------------------------
// Patch path.join and path.resolve
// ---------------------------------------------------------------------------
const origJoin    = path.join.bind(path);
const origResolve = path.resolve.bind(path);

path.join = (...segments) => {
  const result = origJoin(...segments);
  return translate(result);
};

path.resolve = (...segments) => {
  const result = origResolve(...segments);
  return translate(result);
};

// ---------------------------------------------------------------------------
// Wrap fs.promises methods that take a path as their first argument.
// ---------------------------------------------------------------------------
const FS_METHODS = [
  'open', 'readFile', 'writeFile', 'appendFile',
  'stat', 'lstat', 'access', 'chmod', 'chown',
  'mkdir', 'readdir', 'rmdir', 'rm', 'rename',
  'copyFile', 'symlink', 'readlink', 'unlink',
  'truncate', 'utimes',
];

for (const method of FS_METHODS) {
  if (typeof fs.promises[method] !== 'function') continue;
  const original = fs.promises[method].bind(fs.promises);
  fs.promises[method] = (p, ...rest) => original(translate(p), ...rest);
}

// Also patch the synchronous variants for completeness.
const FS_SYNC_METHODS = [
  'readFileSync', 'writeFileSync', 'statSync', 'lstatSync',
  'accessSync', 'mkdirSync', 'readdirSync', 'rmdirSync',
  'rmSync', 'renameSync', 'copyFileSync', 'symlinkSync',
  'readlinkSync', 'unlinkSync', 'openSync', 'chmodSync',
];

for (const method of FS_SYNC_METHODS) {
  if (typeof fs[method] !== 'function') continue;
  const original = fs[method].bind(fs);
  fs[method] = (p, ...rest) => original(translate(p), ...rest);
}
