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
 * Set COWORK_DEBUG=1 to log every translated path to stderr.
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
  // Monkey-patch path.join, path.resolve, path.normalize
  // -------------------------------------------------------------------------
  path.join      = (...segments) => translatePath(_origJoin(...segments));
  path.resolve   = (...segments) => translatePath(_origResolve(...segments));

  const _origNormalize = path.normalize.bind(path);
  path.normalize = (p) => translatePath(_origNormalize(p));

  // -------------------------------------------------------------------------
  // Monkey-patch fs.promises methods (first-arg is a path)
  // -------------------------------------------------------------------------
  const FS_PROMISES_SINGLE_PATH = [
    'open', 'readFile', 'writeFile', 'stat', 'lstat', 'readdir',
    'access', 'mkdir', 'unlink', 'rm', 'chmod', 'chown',
    'truncate', 'utimes', 'appendFile', 'realpath',
  ];

  for (const method of FS_PROMISES_SINGLE_PATH) {
    if (typeof fs.promises[method] !== 'function') continue;
    const _orig = fs.promises[method].bind(fs.promises);
    fs.promises[method] = (p, ...rest) => _orig(translatePath(p), ...rest);
  }

  // fs.promises methods with TWO path args
  const FS_PROMISES_DUAL_PATH = ['copyFile', 'rename', 'symlink', 'link'];
  for (const method of FS_PROMISES_DUAL_PATH) {
    if (typeof fs.promises[method] !== 'function') continue;
    const _orig = fs.promises[method].bind(fs.promises);
    fs.promises[method] = (p1, p2, ...rest) =>
      _orig(translatePath(p1), translatePath(p2), ...rest);
  }

  // -------------------------------------------------------------------------
  // Monkey-patch fs sync methods (first-arg is a path)
  // -------------------------------------------------------------------------
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

  // fs sync methods with TWO path args
  const FS_SYNC_DUAL_PATH = ['copyFileSync', 'renameSync', 'symlinkSync', 'linkSync'];
  for (const method of FS_SYNC_DUAL_PATH) {
    if (typeof fs[method] !== 'function') continue;
    const _orig = fs[method].bind(fs);
    fs[method] = (p1, p2, ...rest) =>
      _orig(translatePath(p1), translatePath(p2), ...rest);
  }

  // -------------------------------------------------------------------------
  // Monkey-patch fs callback methods (first-arg is a path)
  // -------------------------------------------------------------------------
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

  // fs callback methods with TWO path args
  const FS_CB_DUAL_PATH = ['copyFile', 'rename', 'symlink', 'link'];
  for (const method of FS_CB_DUAL_PATH) {
    if (typeof fs[method] !== 'function') continue;
    const _orig = fs[method].bind(fs);
    fs[method] = (p1, p2, ...rest) =>
      _orig(translatePath(p1), translatePath(p2), ...rest);
  }

  // -------------------------------------------------------------------------
  // Monkey-patch fs.realpath / fs.realpathSync (+ .native variants)
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

  // -------------------------------------------------------------------------
  // Monkey-patch fs.createReadStream / fs.createWriteStream
  // -------------------------------------------------------------------------
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
  // Monkey-patch child_process.spawn / execFile / exec
  // Translate cwd option and any string args containing /sessions/ paths.
  // -------------------------------------------------------------------------
  function translateSpawnArgs(command, argsOrOpts, opts) {
    // Normalize the overloaded signatures:
    //   spawn(cmd, args, opts)  or  spawn(cmd, opts)
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

    // Translate cwd
    if (options && typeof options.cwd === 'string') {
      const translated = translatePath(options.cwd);
      if (translated !== options.cwd) {
        options = { ...options, cwd: translated };
      }
    }

    // Translate string args containing /sessions/
    if (Array.isArray(args)) {
      const newArgs = args.map(a => (typeof a === 'string' ? translatePath(a) : a));
      const changed = newArgs.some((a, i) => a !== args[i]);
      if (changed) args = newArgs;
    }

    // Translate command if it contains /sessions/
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
    // execFile has signature: (file, args?, options?, callback?)
    // Detect which form is used
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
    // exec takes a command string — translate any /sessions/ paths in it
    if (typeof cmd === 'string') {
      cmd = cmd.replace(/\/sessions\/[^\s'"]+/g, (match) => translatePath(match));
    }
    return _origExec(cmd, ...rest);
  };

  // -------------------------------------------------------------------------
  // Monkey-patch net.connect / net.createConnection for socket paths
  // -------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Export translatePath for use by the claude-swift stub's spawn().
// Delegates to the global so it works whether or not we initialised above.
// ---------------------------------------------------------------------------
export function translatePath(inputPath) {
  const fn = global[TRANSLATE_SYM];
  return fn ? fn(inputPath) : (typeof inputPath === 'string' ? inputPath : inputPath);
}
