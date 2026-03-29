'use strict';
/**
 * shell-env-patch.js
 *
 * Fixes the "Shell path worker not found" error on Linux.
 *
 * Claude Desktop uses a Worker thread (shellPathWorker.js) to extract the
 * user's shell environment by spawning their login shell.  The worker path is
 * resolved relative to process.resourcesPath, which on Linux points to the
 * system Electron's resources directory — not the app's actual ASAR location.
 *
 * On Linux the app already runs inside the user's shell environment, so
 * process.env contains the correct PATH and other variables.  Rather than
 * fixing the path, we intercept the worker_threads.Worker constructor and
 * provide a tiny inline worker that returns process.env directly.
 *
 * Injected at the top of the main-process bundle by patch-cowork.sh.
 */

const INIT_SYM = Symbol.for('__claudeShellEnvPatchInitialised');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;
  try {
    const Module = require('module');
    const origLoad = Module._load;

    Module._load = function (request, parent, isMain) {
      const mod = origLoad.call(this, request, parent, isMain);

      // Intercept worker_threads to patch the Worker constructor.
      if (request === 'worker_threads' || request === 'node:worker_threads') {
        if (mod && mod.Worker && !mod.__shellEnvPatched) {
          const OrigWorker = mod.Worker;

          mod.Worker = function PatchedWorker(filename, options) {
            // Detect the shell path worker by filename.
            if (typeof filename === 'string' && filename.includes('shellPathWorker')) {
              // First, try to construct the original worker as-is. If that fails
              // due to a missing/unloadable script, fall back to an inline worker
              // that immediately posts back process.env.
              try {
                return new OrigWorker(filename, options);
              } catch (err) {
                const code = err && err.code;
                if (
                  code === 'ENOENT' ||
                  code === 'MODULE_NOT_FOUND' ||
                  code === 'ERR_MODULE_NOT_FOUND' ||
                  code === 'ERR_WORKER_NOT_FOUND'
                ) {
                  process.stderr.write(`[shell-env-patch] Original worker failed (${code}), using inline fallback.\n`);
                  const workerCode = `
                    const { parentPort } = require('worker_threads');
                    parentPort.on('message', () => {
                      parentPort.postMessage({ env: process.env });
                    });
                  `;
                  return new OrigWorker(workerCode, {
                    ...options,
                    eval: true,
                  });
                }
                throw err;
              }
            }
            return new OrigWorker(filename, options);
          };

          // Preserve prototype chain for instanceof checks.
          mod.Worker.prototype = OrigWorker.prototype;
          mod.__shellEnvPatched = true;
        }
      }

      return mod;
    };

    process.stderr.write('[shell-env-patch] Shell environment worker patch installed.\n');
  } catch (e) {
    process.stderr.write(`[shell-env-patch] Warning: ${e.message}\n`);
  }
}
