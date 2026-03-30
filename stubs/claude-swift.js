'use strict';

const { spawn: cpSpawn } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// State — module-scope singletons.
// ---------------------------------------------------------------------------
/** @type {{ onReady?: Function, onExit?: Function, onStdout?: Function, onStderr?: Function }} */
let _callbacks = {};

/** @type {Map<number, import('child_process').ChildProcess>} */
const _procs = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const COWORK_BACKEND = process.env.COWORK_BACKEND || 'bubblewrap';
const DEBUG          = process.env.COWORK_DEBUG === '1';
const SESSION_BASE   = path.join(os.homedir(), '.local', 'share', 'claude-linux', 'sessions');

// Must stay in sync with the same regex in patches/path-translator.mjs.
const SESSION_RE = /^\/sessions\/([^/]+)\/mnt\/([^/]+)(\/.*)?$/;

/** Build bwrap argv prefix for the given session directory. */
function bwrapPrefix(sessionDir) {
  return [
    'bwrap',
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    ...( fs.existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : [] ),
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', os.homedir(), os.homedir(),
    '--bind', sessionDir, sessionDir,
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    '--',
  ];
}

/**
 * Translate VM-style /sessions/… paths in spawn opts to real host paths.
 *
 * path-translator.mjs patches path.join/path.resolve/fs.promises globally,
 * but child_process.spawn({cwd}) passes cwd directly to libuv without
 * going through path.join — so we must translate cwd (and additionalMounts
 * hostPath values) explicitly here.
 *
 * Translation rule (must stay in sync with patches/path-translator.mjs):
 *   /sessions/<uuid>/mnt/<mount-name>/…
 *     → SESSION_BASE/<uuid>/<mount-name>/…
 *
 * @param {object} opts
 * @returns {object}
 */
function translatePaths(opts) {
  if (!opts || typeof opts !== 'object') return opts;

  const result = { ...opts };

  // -- Translate cwd --
  if (typeof result.cwd === 'string') {
    const m = SESSION_RE.exec(result.cwd);
    if (m) {
      const [, uuid, mountName, rest] = m;
      const translated = path.join(SESSION_BASE, uuid, mountName) + (rest || '');
      if (DEBUG) {
        process.stderr.write(`[claude-swift stub] translatePaths cwd: ${result.cwd} → ${translated}\n`);
      }
      result.cwd = translated;
    }
  }

  // -- Translate additionalMounts[].hostPath --
  if (Array.isArray(result.additionalMounts)) {
    result.additionalMounts = result.additionalMounts.map((mount) => {
      if (!mount || typeof mount.hostPath !== 'string') return mount;
      const m = SESSION_RE.exec(mount.hostPath);
      if (!m) return mount;
      const [, uuid, mountName, rest] = m;
      const translated = path.join(SESSION_BASE, uuid, mountName) + (rest || '');
      if (DEBUG) {
        process.stderr.write(
          `[claude-swift stub] translatePaths mount "${mount.name}": ${mount.hostPath} → ${translated}\n`
        );
      }
      return { ...mount, hostPath: translated };
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// VM interface — matches the shape the Cowork orchestrator expects.
// ---------------------------------------------------------------------------
const _vmBase = {
  /**
   * Store the event callback set.
   * @param {{ onReady?: Function, onExit?: Function, onStdout?: Function, onStderr?: Function }} cbs
   */
  setEventCallbacks(cbs) {
    _callbacks = { ..._callbacks, ...cbs };
  },

  /**
   * "Start the VM" — on Linux there is no VM.
   * Signal readiness immediately so the orchestrator proceeds to spawn().
   * @param {object} _config  Ignored; kept for API compatibility.
   * @returns {Promise<void>}
   */
  startVM(_config) {
    return new Promise((resolve) => {
      setImmediate(() => {
        if (typeof _callbacks.onReady === 'function') _callbacks.onReady();
        resolve();
      });
    });
  },

  /**
   * Spawn a subprocess, optionally inside a bubblewrap sandbox.
   * Stores the child in _procs keyed by PID.
   *
   * @param {string}   binary  Executable to run.
   * @param {string[]} args    Arguments.
   * @param {{ cwd?: string, env?: object, additionalMounts?: Array<{name: string, hostPath: string}> }} opts
   * @returns {Promise<number>}  The child process PID (used as stable handle).
   */
  spawn(binary, args = [], opts = {}) {
    opts = translatePaths(opts);
    const { cwd, env, additionalMounts = [] } = opts;

    const sessionDir = cwd || path.join(SESSION_BASE, 'default');
    fs.mkdirSync(sessionDir, { recursive: true });

    if (typeof globalThis.__claudeRegisterMounts === 'function' && additionalMounts.length) {
      const sessionId = path.basename(sessionDir);
      globalThis.__claudeRegisterMounts(sessionId, additionalMounts);
    }

    let argv, spawnBin;
    if (COWORK_BACKEND === 'bubblewrap') {
      const bwrap = bwrapPrefix(sessionDir);
      spawnBin = bwrap[0];
      argv = [...bwrap.slice(1), binary, ...args];
    } else {
      spawnBin = binary;
      argv = args;
    }

    const child = cpSpawn(spawnBin, argv, {
      cwd: sessionDir,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    _procs.set(child.pid, child);

    child.stdout.on('data', (data) => {
      if (typeof _callbacks.onStdout === 'function') _callbacks.onStdout(child.pid, data);
    });
    child.stderr.on('data', (data) => {
      if (typeof _callbacks.onStderr === 'function') _callbacks.onStderr(child.pid, data);
    });
    child.on('exit', (code, signal) => {
      _procs.delete(child.pid);
      if (typeof _callbacks.onExit === 'function') _callbacks.onExit(child.pid, code, signal);
    });
    child.on('error', (err) => {
      process.stderr.write(`[claude-swift stub] spawn error (${spawnBin}): ${err.message}\n`);
      _procs.delete(child.pid);
      if (typeof _callbacks.onExit === 'function') _callbacks.onExit(child.pid, 1, null);
    });

    return Promise.resolve(child.pid);
  },

  /**
   * Kill a previously spawned process.
   * @param {number} pid
   */
  kill(pid) {
    const child = _procs.get(pid);
    if (child) {
      child.kill();
      _procs.delete(pid);
    }
  },

  /**
   * Write data to the stdin of a spawned process.
   * @param {number} pid
   * @param {Buffer|string} data
   */
  writeStdin(pid, data) {
    const child = _procs.get(pid);
    if (child && child.stdin) {
      child.stdin.write(data);
    }
  },

  /**
   * Report whether the VM is running.
   * On Linux there is no VM — always return true.
   * @returns {boolean}
   */
  isRunning() {
    return true;
  },

  /**
   * Report whether the VM is ready.
   * On Linux there is no VM — always return true.
   * @returns {boolean}
   */
  isReady() {
    return true;
  },
};

// Wrap vm in a Proxy so unknown method calls are logged to stderr.
const vm = new Proxy(_vmBase, {
  get(target, prop) {
    if (prop in target) return target[prop];
    process.stderr.write(`[claude-swift stub] unknown vm method called: ${String(prop)}\n`);
    return function noop() {};
  },
});

// ---------------------------------------------------------------------------
// Module state exposed for testing / path-translator integration.
// ---------------------------------------------------------------------------
vm._callbacks = _callbacks;
vm._procs     = _procs;

// ---------------------------------------------------------------------------
// Export shape — the app does: require('@ant/claude-swift').default.vm
// ---------------------------------------------------------------------------
module.exports = { default: { vm } };
