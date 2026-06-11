'use strict';

const { EventEmitter } = require('events');
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

  /**
   * Report virtualization support.
   * The orchestrator checks this before starting the VM; "supported" lets it proceed.
   * Called both synchronously (require().vm.isVirtualizationSupported()) and
   * via go() (async vm object).  On Linux there is no VM — always report supported.
   * @returns {string}
   */
  isVirtualizationSupported() { return 'supported'; },

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

// ===========================================================================
// computerUse namespace resolution (EXPERIMENTAL — DISABLED BY DEFAULT)
//
// Three states, chosen by env flags:
//   COMPUTER_USE_RECON=1  → install a logging Proxy that records the live call
//                           sequence to /tmp/cd-computeruse-recon.md and returns
//                           permissive stand-ins (Phase-1 runtime recon). This
//                           NEVER touches the bundle; it just reveals the
//                           contract. Active ONLY with the flag.
//   ENABLE_COMPUTER_USE=1 → delegate to stubs/computer-use-linux.js (grim/ydotool
//                           backend). The module is only present next to this
//                           stub when the build ran with ENABLE_EXPERIMENTAL_PATCHES=1,
//                           so BOTH conditions are required (recon §8.5).
//   (neither)             → null, exactly as before. The orchestrator does
//                           `if(!A.computerUse) throw` only ON USE, so a null
//                           value is inert until a computer-use task starts.
//
// RECON takes precedence when both flags are set (it is the diagnostic path).
// Every branch is wrapped so a failure degrades to null + a log line, never a
// crash — `main` with default env is byte-for-byte unchanged in behaviour.
// ===========================================================================
const COMPUTER_USE_RECON_LOG = '/tmp/cd-computeruse-recon.md';

/** Build a valid ≥1024-byte PNG (gradient) for recon screenshot stand-ins.
 *  A 1×1 PNG would fail the orchestrator's decoded-length check (Lgt=1024)
 *  and short-circuit the task — defeating the recon. See recon §8.6. */
function _buildReconPngBase64(w, h) {
  const zlib = require('zlib');
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // no filter
    for (let x = 0; x < w; x++) {
      raw[o++] = (x * 255 / w) | 0; raw[o++] = (y * 255 / h) | 0; raw[o++] = 128; raw[o++] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

function _installReconProxy() {
  const fs = require('fs');
  const RECON_W = 1920, RECON_H = 1080;
  let pngB64;
  try { pngB64 = _buildReconPngBase64(160, 120); } // gradient → comfortably >1024 bytes
  catch (_) { pngB64 = ''; }

  let seq = 0;
  const appendLog = (line) => {
    try { fs.appendFileSync(COMPUTER_USE_RECON_LOG, line + '\n'); } catch (_) {}
  };
  const shortArgs = (args) => {
    try {
      return JSON.stringify(args.map((a) => {
        if (Buffer.isBuffer(a)) return `<Buffer ${a.length}>`;
        if (typeof a === 'string' && a.length > 60) return a.slice(0, 60) + '…';
        if (typeof a === 'function') return '<fn>';
        return a;
      })).slice(0, 300);
    } catch (_) { return '<unserialisable>'; }
  };

  // Permissive stand-ins keyed by full dotted path — chosen so the orchestrator
  // PROCEEDS (recon §8.6) rather than erroring out.
  const screenshotObj = () => ({
    base64: pngB64, width: RECON_W, height: RECON_H,
    displayWidth: RECON_W, displayHeight: RECON_H, displayId: 0, originX: 0, originY: 0,
  });
  const standIn = (path) => {
    switch (path) {
      case 'screenshot.captureExcluding': return screenshotObj();
      case 'screenshot.captureRegion':    return { base64: pngB64 };
      case 'resolvePrepareCapture':       return { ...screenshotObj(), hidden: [], activated: null };
      case 'display.getSize':             return { width: RECON_W, height: RECON_H, scaleFactor: 1, originX: 0, originY: 0 };
      case 'display.listAll':             return [{ displayId: 0, width: RECON_W, height: RECON_H, scaleFactor: 1, originX: 0, originY: 0, isPrimary: true, label: 'recon-0' }];
      case 'tcc.checkAccessibility':
      case 'tcc.checkScreenRecording':
      case 'tcc.requestAccessibility':
      case 'tcc.requestScreenRecording':  return true;
      case 'apps.prepareDisplay':         return { activated: null, hidden: [] };
      case 'apps.previewHideSet':
      case 'apps.findWindowDisplays':
      case 'apps.listInstalled':
      case 'apps.listRunning':            return [];
      case 'apps.appUnderPoint':
      case 'apps.iconDataUrl':            return null;
      default:                            return undefined; // open/unhide and unknowns
    }
  };

  const logged = (path) => function (...args) {
    appendLog(`${String(++seq).padStart(4, '0')} | computerUse.${path} | argc=${args.length} | ${shortArgs(args)}`);
    return standIn(path);
  };
  const subNs = (prefix) => new Proxy({}, {
    get(_t, p) {
      if (typeof p === 'symbol') return undefined;
      if (p === 'then') return undefined;
      return logged(`${prefix}${String(p)}`);
    },
  });

  appendLog(`\n## 7.live — COMPUTER_USE_RECON session (pid ${process.pid})`);
  appendLog('seq | method | argc | args');
  process.stderr.write('[claude-swift stub] COMPUTER_USE_RECON=1 — logging computerUse proxy installed → ' + COMPUTER_USE_RECON_LOG + '\n');

  return new Proxy({}, {
    get(_t, p) {
      if (typeof p === 'symbol') return undefined;
      if (p === 'then') return undefined; // never thenable
      const key = String(p);
      // Known sub-namespaces return a logging sub-proxy; everything else is a
      // logged root-level method (e.g. resolvePrepareCapture).
      if (key === 'apps' || key === 'display' || key === 'screenshot' || key === 'tcc') {
        return subNs(`${key}.`);
      }
      return logged(key);
    },
  });
}

function resolveComputerUse() {
  // Recon proxy first (diagnostic; self-contained; needs no backend module).
  if (process.env.COMPUTER_USE_RECON === '1') {
    try { return _installReconProxy(); }
    catch (e) { process.stderr.write(`[claude-swift stub] recon proxy install failed: ${e.message}\n`); return null; }
  }
  // Real Linux backend — requires BOTH the runtime flag AND the module being
  // present (copied next to this stub only under ENABLE_EXPERIMENTAL_PATCHES=1).
  if (process.env.ENABLE_COMPUTER_USE === '1') {
    try {
      const backend = require('./computer-use-linux.js');
      process.stderr.write('[claude-swift stub] ENABLE_COMPUTER_USE=1 — Linux computer-use backend active (EXPERIMENTAL)\n');
      return backend.createComputerUse();
    } catch (e) {
      process.stderr.write(
        `[claude-swift stub] ENABLE_COMPUTER_USE=1 but backend unavailable (${e.message}); ` +
        'computerUse stays null. Did the build run with ENABLE_EXPERIMENTAL_PATCHES=1?\n');
      return null;
    }
  }
  return null; // default: identical to prior behaviour
}

// ---------------------------------------------------------------------------
// Export shape — the app loads via dynamic import():
//   Nr = (await import("@ant/claude-swift")).default
// Node's CJS→ESM interop makes module.exports the `.default` property.
//
// 1.11187.4 CHANGE: the orchestrator now treats the default export itself as
// an EventEmitter — vfr() calls Nr.removeListener() and Nr.on() immediately
// on load (FLe/OLe), before any other method.  We therefore export an
// EventEmitter instance that also carries .vm and the other namespaces the
// orchestrator reads on the default export.  Events never fire on Linux (no
// native Quick Entry / dictation / VM-lifecycle source) — harmless.
//
// `then: undefined` keeps the export non-thenable under `await import()`.
// ---------------------------------------------------------------------------
const _module = new EventEmitter();
_module.setMaxListeners(0);          // orchestrator subscribes to ~10 events
_module.vm           = vm;           // existing Proxy, unchanged
_module.then         = undefined;    // prevent thenable detection
_module.api          = { setCredentials() {} };
_module.quickAccess  = {
  overlay:   { setLoggedIn() {}, setRecentChats() {}, setActiveChatId() {}, toggle() {} },
  dictation: { stop() {}, show() {}, toggle() {}, setLanguage() {} },
};
_module.midnightOwl  = { setEnabled() {} };
_module.wakeScheduler = null;        // accessed as Nr?.wakeScheduler ?? null — null-guarded
// EXPERIMENTAL, default OFF: null unless COMPUTER_USE_RECON=1 or ENABLE_COMPUTER_USE=1.
// The orchestrator does `if(!A.computerUse) throw` only ON USE, so null is inert.
_module.computerUse  = resolveComputerUse();
module.exports = _module;
