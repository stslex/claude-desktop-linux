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
const COWORK_BACKEND = (() => {
  const explicit = process.env.COWORK_BACKEND;
  if (explicit) return explicit;
  // Auto-detect: use bubblewrap only if bwrap is available
  try {
    require('child_process').execFileSync('which', ['bwrap'], { stdio: 'ignore', timeout: 2000 });
    return 'bubblewrap';
  } catch (_) {
    return 'direct';
  }
})();
const DEBUG          = process.env.COWORK_DEBUG === '1';
const SESSION_BASE   = path.join(os.homedir(), '.local', 'share', 'claude-linux', 'sessions');

// Must stay in sync with the same regex in patches/path-translator.mjs.
const SESSION_RE = /^\/sessions\/([^/]+)\/mnt\/([^/]+)(\/.*)?$/;

// VM binary path the orchestrator passes → we resolve to the real binary.
const VM_BINARY_PATHS = ['/usr/local/bin/claude', '/usr/local/bin/claude-code'];

/**
 * Resolve a single path, translating VM-style paths to real host paths.
 * @param {string} p
 * @returns {string}
 */
function translatePath(p) {
  if (typeof p !== 'string') return p;
  const m = SESSION_RE.exec(p);
  if (m) {
    const [, uuid, mountName, rest] = m;
    return path.join(SESSION_BASE, uuid, mountName) + (rest || '');
  }
  return p;
}

/**
 * Resolve the claude-code binary path.
 *
 * The orchestrator passes /usr/local/bin/claude (the VM path).  On the host
 * the actual binary lives at ~/.config/Claude/claude-code-vm/<version>/claude
 * or on PATH as `claude` / `claude-code`.
 *
 * @param {string} binary
 * @returns {string}
 */
function resolveBinary(binary) {
  if (!VM_BINARY_PATHS.includes(binary)) return binary;

  // 1. Check the claude-code-vm directory for the latest version.
  const vmDir = path.join(os.homedir(), '.config', 'Claude', 'claude-code-vm');
  try {
    if (fs.existsSync(vmDir)) {
      const versions = fs.readdirSync(vmDir)
        .filter(d => {
          try { return fs.statSync(path.join(vmDir, d)).isDirectory(); }
          catch (_) { return false; }
        })
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      if (versions.length > 0) {
        const latest = versions[versions.length - 1];
        const candidates = ['claude', 'claude-code'];
        for (const name of candidates) {
          const fullPath = path.join(vmDir, latest, name);
          try {
            fs.accessSync(fullPath, fs.constants.X_OK);
            if (DEBUG) {
              process.stderr.write(`[claude-swift stub] resolveBinary: ${binary} → ${fullPath}\n`);
            }
            return fullPath;
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    if (DEBUG) process.stderr.write(`[claude-swift stub] resolveBinary scan error: ${e.message}\n`);
  }

  // 2. Fall back to PATH lookup.
  const { execFileSync } = require('child_process');
  for (const name of ['claude', 'claude-code']) {
    try {
      const resolved = execFileSync('which', [name], { encoding: 'utf8', timeout: 3000 }).trim();
      if (resolved) {
        if (DEBUG) {
          process.stderr.write(`[claude-swift stub] resolveBinary: ${binary} → ${resolved} (via which)\n`);
        }
        return resolved;
      }
    } catch (_) {}
  }

  process.stderr.write(`[claude-swift stub] WARNING: could not resolve ${binary} — using as-is\n`);
  return binary;
}

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

  // -- Translate env.PATH entries --
  if (result.env && typeof result.env.PATH === 'string') {
    const translated = result.env.PATH
      .split(':')
      .map(p => translatePath(p))
      .join(':');
    if (translated !== result.env.PATH) {
      if (DEBUG) {
        process.stderr.write(`[claude-swift stub] translatePaths env.PATH: ${result.env.PATH} → ${translated}\n`);
      }
      result.env = { ...result.env, PATH: translated };
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
  spawn(...spawnArgs) {
    // The orchestrator may call with various signatures. Log all args for debugging.
    if (DEBUG) {
      process.stderr.write(`[claude-swift stub] spawn called with ${spawnArgs.length} args:\n`);
      spawnArgs.forEach((a, i) => process.stderr.write(`  [${i}] ${typeof a}: ${typeof a === 'string' ? a.substring(0, 80) : JSON.stringify(a).substring(0, 120)}\n`));
    }

    let binary, args, opts;

    // Find the opts object (last object arg that has cwd or env or cmd).
    // Find the binary (first string that looks like a path, not a UUID).
    const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-/.test(s);
    const isPath = (s) => typeof s === 'string' && (s.startsWith('/') || s.includes('claude'));

    // Strategy: iterate args, classify them.
    const strings = [];
    let configObj = null;
    for (const a of spawnArgs) {
      if (typeof a === 'string') strings.push(a);
      else if (a && typeof a === 'object' && !Array.isArray(a)) configObj = a;
      else if (Array.isArray(a)) args = a;
    }

    // If config has cmd, use it
    if (configObj && configObj.cmd) {
      binary = configObj.cmd;
      args = configObj.args || args || [];
      opts = configObj;
    } else {
      // Find binary: first non-UUID path-like string
      binary = strings.find(s => isPath(s) && !isUuid(s)) || strings.find(s => !isUuid(s)) || strings[0];
      // Find args: a string that starts with '--' (command args)
      const argsStr = strings.find(s => s.startsWith('--'));
      if (argsStr && !args) args = argsStr;
      if (!args) args = [];
      opts = configObj || {};
    }

    // The orchestrator may pass args as a single string — split it.
    if (typeof args === 'string') {
      args = args.split(/\s+/).filter(Boolean);
    }
    binary = resolveBinary(binary);
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
   * @param {string} [signal]
   * @returns {Promise<void>}
   */
  kill(pid, signal) {
    const child = _procs.get(pid);
    if (child) {
      child.kill(signal || 'SIGTERM');
      _procs.delete(pid);
    }
    return Promise.resolve();
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
   * Report whether the "guest" (VM/process) is connected.
   * On Linux there is no VM — always return true so the orchestrator proceeds.
   * @returns {Promise<boolean>}
   */
  isGuestConnected() {
    return Promise.resolve(true);
  },

  /**
   * Register a callback for guest requests (guest→host IPC).
   * On Linux there is no VM — store but never fire.
   * @param {Function} cb
   */
  setGuestRequestCallback(cb) {
    _callbacks.onGuestRequest = cb;
  },

  /**
   * Send a response back to the guest (host→guest IPC).
   * On Linux there is no VM — no-op.
   */
  sendGuestResponse() {},

  /**
   * Get memory balloon state.
   * On Linux there is no VM — return a neutral state.
   * @returns {{ currentMemoryMB: number, targetMemoryMB: number }}
   */
  getBalloonState() {
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    return { currentMemoryMB: totalMB, targetMemoryMB: totalMB };
  },

  /**
   * Get host memory info.
   * @returns {{ totalMemoryMB: number, freeMemoryMB: number }}
   */
  getHostMemoryInfo() {
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    const freeMB  = Math.round(os.freemem()  / (1024 * 1024));
    return { totalMemoryMB: totalMB, freeMemoryMB: freeMB };
  },

  /**
   * Check whether a spawned process is still running.
   * @param {number} pid
   * @returns {Promise<boolean>}
   */
  isProcessRunning(pid) {
    return Promise.resolve(_procs.has(pid));
  },

  /**
   * Install the SDK into the session directory.
   * On Linux the SDK (claude-code) is already on the host — no-op.
   * @returns {Promise<void>}
   */
  installSdk() {
    return Promise.resolve();
  },

  /**
   * Register an approved OAuth token for the MITM proxy.
   * On Linux there is no MITM proxy — no-op.
   */
  addApprovedOauthToken() {},

  /**
   * Get disk info for session directories.
   * @returns {{ totalBytes: number, freeBytes: number, usedBytes: number }}
   */
  getSessionsDiskInfo() {
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    return { totalBytes: totalMB * 1024 * 1024, freeBytes: totalMB * 1024 * 1024, usedBytes: 0 };
  },

  /**
   * Delete session directories.
   * @returns {Promise<void>}
   */
  deleteSessionDirs() {
    return Promise.resolve();
  },

  /**
   * Stop the VM — on Linux, kill all tracked child processes and reset state.
   */
  stopVM() {
    // Snapshot PIDs before clearing so callbacks fire with correct data.
    const entries = [..._procs.entries()];
    _procs.clear();
    for (const [pid, child] of entries) {
      try { child.kill('SIGTERM'); } catch {}
      if (typeof _callbacks.onExit === 'function') {
        const cbPid = pid;
        process.nextTick(() => _callbacks.onExit(cbPid, null, 'SIGTERM'));
      }
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

  /**
   * Get memory info for the VM.
   * On Linux there is no VM — return host memory info.
   * @returns {{ totalMemoryMB: number, freeMemoryMB: number }}
   */
  getMemoryInfo() {
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    const freeMB  = Math.round(os.freemem()  / (1024 * 1024));
    return { totalMemoryMB: totalMB, freeMemoryMB: freeMB };
  },

  // CRITICAL: `then` must be explicitly undefined (not a function) so that
  // the vm object is NOT treated as a thenable by the Promise resolution
  // protocol.  The Proxy below returns a function for any unknown property,
  // which would make `await vm` hang forever because the noop `then` never
  // calls resolve/reject.
  then: undefined,
};

// Getter-style properties that the orchestrator may check as properties or methods.
// On Linux there is no VM — always report started/reachable.
Object.defineProperty(_vmBase, 'vmStarted', {
  get() { return true; },
  enumerable: true,
});
Object.defineProperty(_vmBase, 'apiReachable', {
  get() { return true; },
  enumerable: true,
});

// Wrap vm in a Proxy so unknown method calls are logged to stderr.
const vm = new Proxy(_vmBase, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol') return target[prop];
    process.stderr.write(
      `[claude-swift stub] MISSING METHOD: ${String(prop)} — ` +
      `add explicit implementation to stubs/claude-swift.js\n`
    );
    return function noop(...args) {
      process.stderr.write(
        `[claude-swift stub] noop call: ${String(prop)}(${args.length} args)\n`
      );
      return undefined;
    };
  },
});

// ---------------------------------------------------------------------------
// Module state exposed for testing / path-translator integration.
// ---------------------------------------------------------------------------
vm._callbacks = _callbacks;
vm._procs     = _procs;

// ---------------------------------------------------------------------------
// Export shape — the app loads via dynamic import():
//   tN = (await import("@ant/claude-swift")).default
// Node's CJS→ESM interop makes module.exports the `.default` property,
// so we export { vm } directly (NOT { default: { vm } }) to avoid
// double-wrapping: import().default would become { default: { vm } }
// and .vm would be undefined.
// ---------------------------------------------------------------------------
// `then: undefined` prevents the CJS→ESM interop from treating this module
// as a thenable during `await import(...)`.  Without it, the Proxy on `vm`
// would return a function for `.then`, causing the dynamic import to hang.
module.exports = { vm, then: undefined };
