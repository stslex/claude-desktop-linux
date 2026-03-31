'use strict';
/**
 * dispatch-polyfill.js
 *
 * Makes Dispatch work in the foreground on Linux:
 *
 * 1. IPC handler stubs — registers handlers the renderer expects for
 *    notification permissions and push token registration.
 *
 * 2. Foreground polling skeleton — when a polling endpoint can be discovered
 *    from the app's API client config, periodically checks for pending
 *    Dispatch tasks.  Currently disabled by default (see TODO below).
 *
 * 3. Native Linux notifications — when a Dispatch task arrives, shows a
 *    system notification via Electron's Notification API.
 *
 * Environment variables:
 *   DISPATCH_POLL_INTERVAL_MS  Polling interval in ms (default: 30000)
 *   SKIP_DISPATCH_POLL         Set to "1" to disable polling entirely
 *   DISPATCH_DEBUG             Set to "1" for verbose logging
 *
 * Injected at the top of the main-process bundle by patch-cowork.sh.
 */

const INIT_SYM = Symbol.for('__claudeDispatchPolyfillInitialised');

if (!global[INIT_SYM] && process.type === 'browser') {
  global[INIT_SYM] = true;

  const POLL_INTERVAL = parseInt(process.env.DISPATCH_POLL_INTERVAL_MS, 10) || 30000;
  const SKIP_POLL     = process.env.SKIP_DISPATCH_POLL === '1';
  const DEBUG         = process.env.DISPATCH_DEBUG === '1';

  const log   = (msg) => process.stderr.write(`[dispatch-polyfill] ${msg}\n`);
  const debug = (msg) => { if (DEBUG) log(msg); };

  try {
    const { ipcMain, app, BrowserWindow, Notification: ElectronNotification } = require('electron');

    if (!ipcMain) {
      log('ipcMain not available — skipping');
    } else {
      // -------------------------------------------------------------------
      // 1. Dispatch IPC handler stubs
      // -------------------------------------------------------------------
      const DISPATCH_CHANNELS = {
        'Dispatch.getNotificationPermission':     () => 'granted',
        'Dispatch.requestNotificationPermission': () => 'granted',
        'Dispatch.registerPushToken':             () => ({ success: true }),
        'Dispatch.getPushToken':                  () => {
          // Return the synthetic token from claude-native stub
          try {
            const native = require('@ant/claude-native');
            const token = typeof native.getPushToken === 'function'
              ? native.getPushToken() : null;
            return token || 'linux-dispatch-stub';
          } catch (_) {
            return 'linux-dispatch-stub';
          }
        },
        'Dispatch.getState':                      () => ({
          status: 'available',
          supported: true,
          notificationPermission: 'granted',
        }),
        'Dispatch.isAvailable':                   () => true,
        'Dispatch.getAvailability':               () => ({
          status: 'available',
          supported: true,
        }),
      };

      let registeredCount = 0;
      for (const [channel, handler] of Object.entries(DISPATCH_CHANNELS)) {
        try {
          ipcMain.handle(channel, (_event, ..._args) => {
            debug(`${channel} → ${JSON.stringify(handler())}`);
            return handler();
          });
          registeredCount++;
        } catch (e) {
          // Handler already registered by the app — that's fine
          debug(`${channel} already registered: ${e.message}`);
        }
      }

      // Catch-all: log once per unknown Dispatch.* channel, return safe default
      const _warnedChannels = new Set();
      const _origHandleForDispatch = ipcMain.handle.bind(ipcMain);

      // We wrap handle to detect if an unknown Dispatch.* channel is queried.
      // This is done via the ipcMain.handle wrapper chain — if the app's own
      // handler throws, the error propagates.  We only need to handle
      // UNREGISTERED channels, which we do by intercepting invocations.
      //
      // Electron's ipcMain doesn't have a catch-all, so we use the
      // 'ipc-message' event on webContents as a fallback detection mechanism.
      if (app) {
        app.on('web-contents-created', (_event, webContents) => {
          webContents.on('ipc-message', (_ipcEvent, channel, ..._args) => {
            if (typeof channel === 'string' && channel.startsWith('Dispatch.') &&
                !DISPATCH_CHANNELS[channel] && !_warnedChannels.has(channel)) {
              _warnedChannels.add(channel);
              log(`Unhandled Dispatch IPC channel: ${channel} (no stub registered)`);
            }
          });
        });
      }

      log(`Registered ${registeredCount} Dispatch IPC stubs`);

      // -------------------------------------------------------------------
      // 2. Foreground polling skeleton
      // -------------------------------------------------------------------
      // TODO: The exact API endpoint for fetching pending Dispatch tasks is
      // not publicly documented.  The polling skeleton is in place but
      // disabled until the endpoint can be discovered by inspecting IPC
      // traffic with DISPATCH_DEBUG=1.
      //
      // To discover the endpoint:
      //   1. Set DISPATCH_DEBUG=1 and COWORK_DEBUG=1
      //   2. Send a Dispatch task from mobile while the app is open
      //   3. Look for HTTP requests to api.anthropic.com containing
      //      "dispatch", "task", "message", or "notification" in the URL
      //   4. Once found, implement the fetch loop below
      //
      // The polling approach:
      //   - Only poll when a BrowserWindow is focused (not hidden/minimised)
      //   - Use the app's existing auth token (discovered from the session
      //     cookie or API client config)
      //   - Interval: DISPATCH_POLL_INTERVAL_MS (default 30s)
      //   - On new task: show Electron Notification, focus window on click

      let _pollTimer = null;
      let _pollEndpoint = null;  // Set when discovered

      /**
       * Discover the polling endpoint from IPC traffic.
       * Currently returns null — see TODO above.
       */
      function discoverPollEndpoint() {
        // Placeholder: when DISPATCH_DEBUG=1, we log all IPC traffic above.
        // Once the endpoint pattern is known, implement detection here.
        return null;
      }

      /**
       * Show a native Linux notification for a Dispatch task.
       */
      function showTaskNotification(task) {
        try {
          if (!ElectronNotification || !ElectronNotification.isSupported()) {
            debug('Notification API not supported — skipping notification');
            return;
          }

          const title = task.title || 'Dispatch Task';
          const body  = task.body || task.message || task.content || 'New task received';

          const notification = new ElectronNotification({ title, body });

          notification.on('click', () => {
            // Focus the main window
            const wins = BrowserWindow.getAllWindows();
            const mainWin = wins.find(w => !w.isDestroyed());
            if (mainWin) {
              if (mainWin.isMinimized()) mainWin.restore();
              mainWin.show();
              mainWin.focus();

              // Navigate to the task if we have an ID
              if (task.id || task.taskId) {
                const taskId = task.id || task.taskId;
                mainWin.webContents.send('dispatch:navigate-to-task', { taskId });
                debug(`Notification click → navigate to task ${taskId}`);
              }
            }
          });

          notification.show();
          debug(`Showed notification: "${title}"`);
        } catch (e) {
          log(`Notification error: ${e.message}`);
        }
      }

      /**
       * Poll for pending Dispatch tasks (once per interval).
       */
      async function pollForTasks() {
        if (!_pollEndpoint) return;

        try {
          // TODO: Implement actual HTTP fetch to _pollEndpoint
          // using the app's auth credentials.
          //
          // const response = await net.fetch(_pollEndpoint, { ... });
          // const data = await response.json();
          // if (data.tasks && data.tasks.length > 0) {
          //   for (const task of data.tasks) {
          //     showTaskNotification(task);
          //   }
          // }
          debug('Poll tick (endpoint not yet implemented)');
        } catch (e) {
          debug(`Poll error: ${e.message}`);
        }
      }

      function startPolling() {
        if (_pollTimer) return;  // already running
        if (SKIP_POLL) {
          debug('Polling disabled (SKIP_DISPATCH_POLL=1)');
          return;
        }

        _pollEndpoint = discoverPollEndpoint();
        if (!_pollEndpoint) {
          debug('Polling endpoint not discovered — polling disabled');
          return;
        }

        log(`Starting Dispatch polling (interval=${POLL_INTERVAL}ms)`);
        _pollTimer = setInterval(pollForTasks, POLL_INTERVAL);
        // Don't keep the event loop alive just for polling
        if (_pollTimer.unref) _pollTimer.unref();
      }

      function stopPolling() {
        if (_pollTimer) {
          clearInterval(_pollTimer);
          _pollTimer = null;
          debug('Polling stopped');
        }
      }

      // Start/stop polling based on window focus
      if (app) {
        app.on('browser-window-focus', () => {
          startPolling();
        });

        app.on('browser-window-blur', () => {
          // Only stop if ALL windows are blurred
          const anyFocused = BrowserWindow.getAllWindows().some(
            w => !w.isDestroyed() && w.isFocused()
          );
          if (!anyFocused) {
            stopPolling();
          }
        });

        // Also try to start polling when the app is ready (in case a window
        // is already focused)
        app.once('ready', () => {
          setImmediate(() => {
            const anyFocused = BrowserWindow.getAllWindows().some(
              w => !w.isDestroyed() && w.isFocused()
            );
            if (anyFocused) startPolling();
          });
        });
      }

      // -------------------------------------------------------------------
      // 3. IPC traffic logging (when DISPATCH_DEBUG=1)
      // -------------------------------------------------------------------
      if (DEBUG && app) {
        app.on('web-contents-created', (_event, webContents) => {
          webContents.on('ipc-message', (_ipcEvent, channel, ...args) => {
            if (typeof channel === 'string' &&
                /dispatch|notification|push|token/i.test(channel)) {
              process.stderr.write(
                `[dispatch-polyfill] [ipc-message] ${channel} args=${JSON.stringify(args).slice(0, 200)}\n`
              );
            }
          });
          webContents.on('ipc-message-sync', (_ipcEvent, channel, ...args) => {
            if (typeof channel === 'string' &&
                /dispatch|notification|push|token/i.test(channel)) {
              process.stderr.write(
                `[dispatch-polyfill] [ipc-message-sync] ${channel} args=${JSON.stringify(args).slice(0, 200)}\n`
              );
            }
          });
        });
        log('IPC traffic logging enabled (DISPATCH_DEBUG=1)');
      }
    }

    log('Dispatch polyfill installed');
  } catch (e) {
    log(`Setup failed: ${e.message}`);
  }
}
