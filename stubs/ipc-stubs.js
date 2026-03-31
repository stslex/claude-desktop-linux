'use strict';
/**
 * ipc-stubs.js
 *
 * Registers stub IPC handlers for macOS-only subsystems that the renderer
 * queries but are not available on Linux.  Without these stubs, repeated
 * unhandled IPC errors destabilise the session.
 *
 * Currently stubbed:
 *   - ComputerUseTcc.*  — macOS Accessibility / Screen Recording permission
 *     checks used by the Computer Use feature.  On Linux there is no TCC
 *     framework; we return { status: 'not_applicable' } for all queries.
 *
 * Injected at the top of the main-process bundle by patch-cowork.sh.
 */

const INIT_SYM = Symbol.for('__claudeIpcStubsInitialised');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;

  try {
    const { ipcMain } = require('electron');
    const DEBUG = process.env.COWORK_DEBUG === '1';
    const log = (msg) => {
      if (DEBUG) process.stderr.write(`[ipc-stubs] ${msg}\n`);
    };

    if (!ipcMain) {
      process.stderr.write('[ipc-stubs] ipcMain not available — skipping\n');
    } else {
      // -----------------------------------------------------------------------
      // ComputerUseTcc stubs
      // -----------------------------------------------------------------------
      const TCC_CHANNELS = [
        'ComputerUseTcc.getState',
        'ComputerUseTcc.requestPermission',
        'ComputerUseTcc.checkAccessibility',
        'ComputerUseTcc.checkScreenRecording',
        'ComputerUseTcc.requestAccessibility',
        'ComputerUseTcc.requestScreenRecording',
      ];

      const TCC_RESPONSE = { status: 'not_applicable' };

      for (const channel of TCC_CHANNELS) {
        try {
          ipcMain.handle(channel, (_event, ..._args) => {
            log(`${channel} → ${JSON.stringify(TCC_RESPONSE)}`);
            return TCC_RESPONSE;
          });
        } catch (e) {
          // Handler may already be registered (e.g. by the app itself on macOS)
          log(`${channel} already registered: ${e.message}`);
        }
      }

      // -----------------------------------------------------------------------
      // Catch-all for any other ComputerUseTcc.* channel not in the list above
      // -----------------------------------------------------------------------
      const origHandle = ipcMain.handle.bind(ipcMain);
      const _hookedHandle = ipcMain.handle;

      // Intercept future handle() registrations — if the app tries to register
      // a ComputerUseTcc.* handler that we already registered, remove ours first
      // so the app's handler takes precedence.
      ipcMain.handle = function patchedHandle(channel, handler) {
        if (typeof channel === 'string' && channel.startsWith('ComputerUseTcc.')) {
          try { ipcMain.removeHandler(channel); } catch (_) {}
        }
        return origHandle(channel, handler);
      };

      // Copy any properties from the original (unlikely, but be safe)
      Object.setPrototypeOf(ipcMain.handle, origHandle);

      process.stderr.write(`[ipc-stubs] Registered ${TCC_CHANNELS.length} ComputerUseTcc stub handlers\n`);
    }
  } catch (e) {
    process.stderr.write(`[ipc-stubs] Setup failed: ${e.message}\n`);
  }
}
