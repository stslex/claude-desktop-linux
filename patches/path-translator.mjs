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
 * This eliminates the need for a /sessions → ~/.local/share/claude-linux/sessions
 * symlink on the root filesystem.  All path translation happens in-process by
 * monkey-patching Node.js built-in modules (fs, path, child_process, net).
 *
 * Env vars:
 *   COWORK_DEBUG=1                    — log every translated path to stderr
 *   CLAUDE_EXTENDED_PATH_TRANSLATION=1
 *                                     — enable the aggressive monkey-patch set
 *                                       (path.normalize, fs sync/callback
 *                                       methods, child_process spawn/execFile/
 *                                       exec, net.connect/createConnection).
 *                                       Off by default because at least one of
 *                                       these wrappers was correlated with a
 *                                       pre-main.js SIGSEGV on dev-channel
 *                                       builds built against upstream
 *                                       Claude Desktop 1.1617.0+.  With this
 *                                       flag unset we fall back to the core
 *                                       wrapping set (path.join, path.resolve,
 *                                       fs.promises open/readFile/writeFile/
 *                                       stat/readdir, fs.realpath*,
 *                                       fs.createReadStream/WriteStream) that
 *                                       matches the stable channel on main.
 */

import path from 'path';
import fs   from 'fs';
import os   from 'os';
import child_process from 'child_process';
import net  from 'net';

// ---------------------------------------------------------------------------
// Double-init guard  (ESM modules are cached by URL, but guard anyway in case
// the bundle is concatenated or the module URL changes between builds)
// ---------------------------------------------------------------------------
const INIT_SYM      = Symbol.for('__claudePathTranslatorInitialised');
const TRANSLATE_SYM = Symbol.for('__claudeTranslatePath');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;

  const DEBUG    = process.env.COWORK_DEBUG === '1';
  // Gate the aggressive monkey-patch set. See the header comment and
  // https://github.com/stslex/claude-desktop-linux/pull/... for why this
  // defaults off on dev-channel builds.
  const EXTENDED = process.env.CLAUDE_EXTENDED_PATH_TRANSLATION === '1';

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

  /** Set of session IDs whose directories have already been created. */
  const _createdSessionDirs = new Set();

  function translatePath(inputPath) {
    if (typeof inputPath !== 'string') return inputPath;
    const m = SESSION_RE.exec(inputPath);
    if (!m) return inputPath;

    const [, uuid, mountName, rest = ''] = m;
    const translated = _origJoin(SESSION_BASE, uuid, mountName) + rest;

    // Auto-create session directory on first encounter.
    if (!_createdSessionDirs.has(uuid)) {
      _createdSessionDirs.add(uuid);
      try {
        fs.mkdirSync(_origJoin(SESSION_BASE, uuid), { recursive: true });
      } catch (_) { /* best-effort */ }
    }

    if (DEBUG) {
      process.stderr.write(`[path-translator] ${inputPath} → ${translated}\n`);
    }
    return translated;
  }

  // Expose via global symbol so the exported wrapper below can reach it.
  global[TRANSLATE_SYM] = translatePath;

  // -------------------------------------------------------------------------
  // CORE SET — always active.  This matches the subset on the stable
  // channel (main branch) that is known to not break Electron startup.
  // -------------------------------------------------------------------------

  // path.join, path.resolve
  path.join    = (...segments) => translatePath(_origJoin(...segments));
  path.resolve = (...segments) => translatePath(_origResolve(...segments));

  // fs.promises: open / readFile / writeFile / stat / readdir
  for (const method of ['open', 'readFile', 'writeFile', 'stat', 'readdir']) {
    if (typeof fs.promises[method] !== 'function') continue;
    const _orig = fs.promises[method].bind(fs.promises);
    fs.promises[method] = (p, ...rest) => _orig(translatePath(p), ...rest);
  }

  // fs.realpath / fs.realpathSync (+ .native variants)
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

  // fs.createReadStream / fs.createWriteStream
  if (typeof fs.createReadStream === 'function') {
    const _orig = fs.createReadStream.bind(fs);
    fs.createReadStream = (p, ...rest) =>
      _orig(typeof p === 'string' ? translatePath(p) : p, ...rest);
  }

  if (typeof fs.createWriteStream === 'function') {
    const _orig = fs.createWriteStream.bind(fs);
    fs.createWriteStream = (p, ...rest) =>
      _orig(typeof p === 'string' ? translatePath(p) : p, ...rest);
  }

  // -------------------------------------------------------------------------
  // EXTENDED SET — opt-in via CLAUDE_EXTENDED_PATH_TRANSLATION=1.
  //
  // These wrappers cover more of the Node.js path surface (path.normalize,
  // all fs sync/callback methods, dual-path fs methods, child_process,
  // net).  They are correlated with a pre-main.js SIGSEGV on dev-channel
  // builds built against upstream Claude Desktop 1.1617.0+ — the main
  // process crashes during Chromium's DBus init before any JS log line
  // is flushed.  Root cause not yet confirmed; possible culprits include
  // net.connect/createConnection wrapping (which Electron uses internally
  // for main↔renderer IPC) and child_process.spawn wrapping (which
  // changes the overloaded signature handling in subtle ways).
  //
  // When this flag is off we preserve the CORE SET above, which matches
  // the main-branch behaviour that is known-good in the stable channel.
  // Users who need /sessions path translation in more places can opt in
  // via `CLAUDE_EXTENDED_PATH_TRANSLATION=1 claude-desktop` after we
  // identify and fix the specific wrapper that breaks.
  // -------------------------------------------------------------------------
  if (EXTENDED) {
    process.stderr.write(
      '[path-translator] CLAUDE_EXTENDED_PATH_TRANSLATION=1 — enabling ' +
      'aggressive monkey-patch set (experimental).\n'
    );

    // path.normalize
    const _origNormalize = path.normalize.bind(path);
    path.normalize = (p) => translatePath(_origNormalize(p));

    // Expanded fs.promises single-path set
    const FS_PROMISES_EXTENDED = [
      'lstat', 'access', 'mkdir', 'unlink', 'rm', 'chmod', 'chown',
      'truncate', 'utimes', 'appendFile', 'realpath',
    ];
    for (const method of FS_PROMISES_EXTENDED) {
      if (typeof fs.promises[method] !== 'function') continue;
      const _orig = fs.promises[method].bind(fs.promises);
      fs.promises[method] = (p, ...rest) => _orig(translatePath(p), ...rest);
    }

    // fs.promises dual-path
    const FS_PROMISES_DUAL_PATH = ['copyFile', 'rename', 'symlink', 'link'];
    for (const method of FS_PROMISES_DUAL_PATH) {
      if (typeof fs.promises[method] !== 'function') continue;
      const _orig = fs.promises[method].bind(fs.promises);
      fs.promises[method] = (p1, p2, ...rest) =>
        _orig(translatePath(p1), translatePath(p2), ...rest);
    }

    // fs sync single-path
    const FS_SYNC_SINGLE_PATH = [
      'readFileSync', 'writeFileSync', 'openSync', 'statSync', 'lstatSync',
      'readdirSync', 'accessSync', 'mkdirSync', 'unlinkSync', 'rmSync',
      'chmodSync', 'chownSync', 'truncateSync', 'utimesSync', 'appendFileSync',
      'existsSync',
    ];
    for (const method of FS_SYNC_SINGLE_PATH) {
      if (typeof fs[method] !== 'function') continue;
      const _orig = fs[method].bind(fs);
      fs[method] = (p, ...rest) => _orig(translatePath(p), ...rest);
    }

    // fs sync dual-path
    const FS_SYNC_DUAL_PATH = ['copyFileSync', 'renameSync', 'symlinkSync', 'linkSync'];
    for (const method of FS_SYNC_DUAL_PATH) {
      if (typeof fs[method] !== 'function') continue;
      const _orig = fs[method].bind(fs);
      fs[method] = (p1, p2, ...rest) =>
        _orig(translatePath(p1), translatePath(p2), ...rest);
    }

    // fs callback single-path
    const FS_CB_SINGLE_PATH = [
      'open', 'readFile', 'writeFile', 'stat', 'lstat', 'readdir',
      'access', 'mkdir', 'unlink', 'rm', 'chmod', 'chown',
      'truncate', 'utimes', 'appendFile',
    ];
    for (const method of FS_CB_SINGLE_PATH) {
      if (typeof fs[method] !== 'function') continue;
      const _orig = fs[method].bind(fs);
      fs[method] = (p, ...rest) => _orig(translatePath(p), ...rest);
    }

    // fs callback dual-path
    const FS_CB_DUAL_PATH = ['copyFile', 'rename', 'symlink', 'link'];
    for (const method of FS_CB_DUAL_PATH) {
      if (typeof fs[method] !== 'function') continue;
      const _orig = fs[method].bind(fs);
      fs[method] = (p1, p2, ...rest) =>
        _orig(translatePath(p1), translatePath(p2), ...rest);
    }

    // child_process.spawn / execFile / exec
    function translateSpawnArgs(command, argsOrOpts, opts) {
      let args, options;
      if (Array.isArray(argsOrOpts)) {
        args = argsOrOpts;
        options = opts || {};
      } else if (argsOrOpts && typeof argsOrOpts === 'object') {
        args = undefined;
        options = argsOrOpts;
      } else {
        args = argsOrOpts;
        options = opts || {};
      }

      if (options && typeof options.cwd === 'string') {
        const translated = translatePath(options.cwd);
        if (translated !== options.cwd) {
          options = { ...options, cwd: translated };
        }
      }

      if (Array.isArray(args)) {
        const newArgs = args.map(a => (typeof a === 'string' ? translatePath(a) : a));
        const changed = newArgs.some((a, i) => a !== args[i]);
        if (changed) args = newArgs;
      }

      command = translatePath(command);

      return { command, args, options };
    }

    const _origSpawn = child_process.spawn.bind(child_process);
    child_process.spawn = (cmd, argsOrOpts, opts) => {
      const t = translateSpawnArgs(cmd, argsOrOpts, opts);
      return t.args !== undefined
        ? _origSpawn(t.command, t.args, t.options)
        : _origSpawn(t.command, t.options);
    };

    const _origExecFile = child_process.execFile.bind(child_process);
    child_process.execFile = (cmd, argsOrOpts, opts, cb) => {
      if (typeof argsOrOpts === 'function') {
        return _origExecFile(translatePath(cmd), argsOrOpts);
      }
      if (typeof opts === 'function') {
        const t = translateSpawnArgs(cmd, argsOrOpts, {});
        return t.args !== undefined
          ? _origExecFile(t.command, t.args, opts)
          : _origExecFile(t.command, t.options, opts);
      }
      const t = translateSpawnArgs(cmd, argsOrOpts, opts);
      return t.args !== undefined
        ? _origExecFile(t.command, t.args, t.options, cb)
        : _origExecFile(t.command, t.options, cb);
    };

    const _origExec = child_process.exec.bind(child_process);
    child_process.exec = (cmd, ...rest) => {
      if (typeof cmd === 'string') {
        cmd = cmd
          .replace(/'(\/sessions\/[^']+)'/g, (_m, p) => `'${translatePath(p)}'`)
          .replace(/"(\/sessions\/[^"]+)"/g, (_m, p) => `"${translatePath(p)}"`)
          .replace(/(?<=['"\s]|^)(\/sessions\/[^\s'";&|<>()]+)/g, (_m, p) => translatePath(p));
      }
      return _origExec(cmd, ...rest);
    };

    // net.connect / net.createConnection
    function wrapNetConnect(orig) {
      return function (optionsOrPath, ...rest) {
        if (typeof optionsOrPath === 'string') {
          return orig.call(this, translatePath(optionsOrPath), ...rest);
        }
        if (optionsOrPath && typeof optionsOrPath === 'object' &&
            typeof optionsOrPath.path === 'string') {
          const translated = translatePath(optionsOrPath.path);
          if (translated !== optionsOrPath.path) {
            optionsOrPath = { ...optionsOrPath, path: translated };
          }
        }
        return orig.call(this, optionsOrPath, ...rest);
      };
    }

    net.connect          = wrapNetConnect(net.connect.bind(net));
    net.createConnection = wrapNetConnect(net.createConnection.bind(net));
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
