'use strict';

const { spawn: cpSpawn } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// State — module-scope singletons.
// ---------------------------------------------------------------------------
/**
 * Callbacks registered via setEventCallbacks().
 * The orchestrator passes 7 individual function arguments (not an object):
 *   setEventCallbacks(onStdout, onStderr, onExit, onError,
 *                     onNetworkStatus, onApiReachability, onStartupStep)
 *
 * Callback signatures (id = UUID string assigned by the orchestrator):
 *   onStdout(id, data: Buffer)
 *   onStderr(id, data: Buffer)
 *   onExit(id, code: number|null, signal: string|null)
 *   onError(id, message: string)
 */
let _callbacks = {};

/** @type {Map<string, import('child_process').ChildProcess>}  keyed by UUID */
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
 *
 * The orchestrator's fx() helper replaces "$HOME" with "/sessions/<name>",
 * so on the host we must reverse that mapping:
 *   /sessions/<name>/mnt/<mount>/…  → SESSION_BASE/<name>/<mount>/…
 *   /sessions/<name>/…              → $HOME/…   (reverse of fx)
 *
 * @param {string} p
 * @returns {string}
 */
function translatePath(p) {
  if (typeof p !== 'string') return p;

  // Pattern 1: /sessions/<name>/mnt/<mount>/…
  const m = SESSION_RE.exec(p);
  if (m) {
    const [, uuid, mountName, rest] = m;
    return path.join(SESSION_BASE, uuid, mountName) + (rest || '');
  }

  // Pattern 2: /sessions/<name>/… — reverse of fx("$HOME/…", name)
  if (p.startsWith('/sessions/')) {
    const m2 = /^\/sessions\/[^/]+(\/.*)?$/.exec(p);
    if (m2) {
      const rest = m2[1];
      return rest && rest.length > 1
        ? path.join(os.homedir(), rest)
        : os.homedir();
    }
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

// ---------------------------------------------------------------------------
// VM interface — matches the shape the Cowork orchestrator expects.
// ---------------------------------------------------------------------------
const _vmBase = {
  /**
   * Store the event callbacks.
   * The orchestrator passes 7 individual functions, NOT an object.
   */
  setEventCallbacks(onStdout, onStderr, onExit, onError, onNetworkStatus, onApiReachability, onStartupStep) {
    _callbacks = { onStdout, onStderr, onExit, onError, onNetworkStatus, onApiReachability, onStartupStep };
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
   * The orchestrator calls:
   *   vm.spawn(id, processName, command, args, cwd, env,
   *            additionalMounts, isResume, allowedDomains, oneShot,
   *            mountSkeletonHome, mountConda)
   *
   * Processes are tracked by UUID (`id`), not OS PID — the orchestrator
   * uses the same UUID for writeStdin / kill / callbacks.
   *
   * @returns {Promise<void>}
   */
  spawn(id, processName, command, args, cwd, env, additionalMounts,
        isResume, allowedDomains, oneShot, mountSkeletonHome, mountConda) {

    if (!Array.isArray(args)) args = [];

    // Always log spawn parameters so failures are diagnosable.
    process.stderr.write(
      `[claude-swift stub] spawn id=${id} name=${processName} ` +
      `cmd=${command} args=[${args.join(' ')}] cwd=${cwd || '(none)'}\n`
    );

    // Translate VM paths → host paths.
    const resolvedCommand = translatePath(command);
    const binary = resolveBinary(resolvedCommand);
    const resolvedArgs = args.map(a => typeof a === 'string' ? translatePath(a) : a);
    const resolvedCwd = cwd ? translatePath(cwd) : undefined;

    // Translate env PATH entries.
    let resolvedEnv = env;
    if (env && typeof env.PATH === 'string') {
      resolvedEnv = {
        ...env,
        PATH: env.PATH.split(':').map(p => translatePath(p)).join(':'),
      };
    }

    const sessionDir = resolvedCwd || path.join(SESSION_BASE, processName || 'default');
    fs.mkdirSync(sessionDir, { recursive: true });

    process.stderr.write(
      `[claude-swift stub] spawn resolved: binary=${binary} ` +
      `cwd=${sessionDir} args=[${resolvedArgs.join(' ')}]\n`
    );

    let spawnBin, argv;
    if (COWORK_BACKEND === 'bubblewrap') {
      const bwrap = bwrapPrefix(sessionDir);
      spawnBin = bwrap[0];
      argv = [...bwrap.slice(1), binary, ...resolvedArgs];
    } else {
      spawnBin = binary;
      argv = resolvedArgs;
    }

    const child = cpSpawn(spawnBin, argv, {
      cwd: sessionDir,
      env: { ...process.env, ...resolvedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Key by UUID — the orchestrator uses the UUID for writeStdin/kill.
    _procs.set(id, child);

    child.stdout.on('data', (data) => {
      if (typeof _callbacks.onStdout === 'function') _callbacks.onStdout(id, data);
    });
    child.stderr.on('data', (data) => {
      if (typeof _callbacks.onStderr === 'function') _callbacks.onStderr(id, data);
    });
    child.on('exit', (code, signal) => {
      _procs.delete(id);
      if (typeof _callbacks.onExit === 'function') _callbacks.onExit(id, code, signal);
    });
    child.on('error', (err) => {
      process.stderr.write(`[claude-swift stub] spawn error (${spawnBin}): ${err.message}\n`);
      _procs.delete(id);
      if (typeof _callbacks.onExit === 'function') _callbacks.onExit(id, 1, null);
    });

    return Promise.resolve();
  },

  /**
   * Kill a previously spawned process.
   * @param {string} id  UUID assigned by the orchestrator.
   * @param {string} [signal]
   * @returns {Promise<void>}
   */
  kill(id, signal) {
    const child = _procs.get(id);
    if (child) {
      child.kill(signal || 'SIGTERM');
      _procs.delete(id);
    }
    return Promise.resolve();
  },

  /**
   * Write data to the stdin of a spawned process.
   * @param {string} id  UUID assigned by the orchestrator.
   * @param {Buffer|string} data
   */
  writeStdin(id, data) {
    const child = _procs.get(id);
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
   * @param {string} id  UUID assigned by the orchestrator.
   * @returns {Promise<{running: boolean, exitCode?: number}>}
   */
  isProcessRunning(id) {
    return Promise.resolve({ running: _procs.has(id) });
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
   * @returns {{ totalBytes: number, freeBytes: number, sessions: Array }}
   */
  getSessionsDiskInfo() {
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    return { totalBytes: totalMB * 1024 * 1024, freeBytes: totalMB * 1024 * 1024, sessions: [] };
  },

  /**
   * Delete session directories.
   * @param {string[]} _names
   * @returns {{ deleted: string[], errors: object }}
   */
  deleteSessionDirs(_names) {
    return Promise.resolve({ deleted: [], errors: {} });
  },

  /**
   * Stop the VM — on Linux, kill all tracked child processes and reset state.
   */
  stopVM() {
    const entries = [..._procs.entries()];
    _procs.clear();
    for (const [id, child] of entries) {
      try { child.kill('SIGTERM'); } catch {}
      if (typeof _callbacks.onExit === 'function') {
        process.nextTick(() => _callbacks.onExit(id, null, 'SIGTERM'));
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
