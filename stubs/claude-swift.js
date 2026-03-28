'use strict';

const { spawn: cpSpawn } = require('child_process');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// State — one Map per module instance (module-scope singleton).
// ---------------------------------------------------------------------------
/** @type {{ onReady?: Function, onExit?: Function, onStdout?: Function, onStderr?: Function }} */
let _callbacks = {};

/** @type {Map<number, import('child_process').ChildProcess>} */
const _processes = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const COWORK_BACKEND = process.env.COWORK_BACKEND || 'bubblewrap';
const SESSION_BASE   = path.join(os.homedir(), '.local', 'share', 'claude-linux', 'sessions');

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
    // /lib64 may not exist on all distros
    ...( require('fs').existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : [] ),
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', os.homedir(), os.homedir(),
    '--bind', sessionDir, sessionDir,
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    '--',
  ];
}

// ---------------------------------------------------------------------------
// VM interface — matches the shape the Cowork orchestrator expects.
// ---------------------------------------------------------------------------
const vm = {
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
   *
   * @param {string}   binary  Executable to run.
   * @param {string[]} args    Arguments.
   * @param {{ cwd?: string, env?: object, additionalMounts?: Array<{name: string, hostPath: string}> }} opts
   * @returns {Promise<number>}  The child process PID (used as stable handle).
   */
  spawn(binary, args = [], opts = {}) {
    const { cwd, env, additionalMounts = [] } = opts;

    // Determine the session directory from cwd or a default.
    const sessionDir = cwd || path.join(SESSION_BASE, 'default');
    require('fs').mkdirSync(sessionDir, { recursive: true });

    // Register mounts with the path translator if it's loaded.
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

    _processes.set(child.pid, child);

    child.stdout.on('data', (data) => {
      if (typeof _callbacks.onStdout === 'function') _callbacks.onStdout(child.pid, data);
    });
    child.stderr.on('data', (data) => {
      if (typeof _callbacks.onStderr === 'function') _callbacks.onStderr(child.pid, data);
    });
    child.on('exit', (code, signal) => {
      _processes.delete(child.pid);
      if (typeof _callbacks.onExit === 'function') _callbacks.onExit(child.pid, code, signal);
    });
    child.on('error', (err) => {
      process.stderr.write(`[claude-swift stub] spawn error (${spawnBin}): ${err.message}\n`);
      _processes.delete(child.pid);
      if (typeof _callbacks.onExit === 'function') _callbacks.onExit(child.pid, 1, null);
    });

    return Promise.resolve(child.pid);
  },

  /**
   * Kill a previously spawned process.
   * @param {number} pid
   */
  kill(pid) {
    const child = _processes.get(pid);
    if (child) {
      child.kill();
      _processes.delete(pid);
    }
  },

  /**
   * Write data to the stdin of a spawned process.
   * @param {number} pid
   * @param {Buffer|string} data
   */
  writeStdin(pid, data) {
    const child = _processes.get(pid);
    if (child && child.stdin) {
      child.stdin.write(data);
    }
  },

  /**
   * Check whether a spawned process is still running.
   * @param {number} pid
   * @returns {boolean}
   */
  isRunning(pid) {
    return _processes.has(pid);
  },
};

// ---------------------------------------------------------------------------
// Export shape — the app does: require('@ant/claude-swift').default.vm
// ---------------------------------------------------------------------------
module.exports = { default: { vm } };
