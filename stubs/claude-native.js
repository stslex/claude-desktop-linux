'use strict';

const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// KeyboardKey enum — Windows Virtual-Key codes used by the hotkey system.
// Values match the VK_* constants a hotkey system needs.
// ---------------------------------------------------------------------------
const KeyboardKey = {
  // Special / editing keys
  Back:      0x08,  // VK_BACK    — Backspace
  Tab:       0x09,  // VK_TAB
  Return:    0x0D,  // VK_RETURN  — Enter
  Escape:    0x1B,  // VK_ESCAPE
  Space:     0x20,  // VK_SPACE
  Prior:     0x21,  // VK_PRIOR   — Page Up
  Next:      0x22,  // VK_NEXT    — Page Down
  End:       0x23,  // VK_END
  Home:      0x24,  // VK_HOME
  Left:      0x25,  // VK_LEFT
  Up:        0x26,  // VK_UP
  Right:     0x27,  // VK_RIGHT
  Down:      0x28,  // VK_DOWN
  Delete:    0x2E,  // VK_DELETE

  // Modifier keys (main)
  Shift:     0x10,  // VK_SHIFT
  Control:   0x11,  // VK_CONTROL
  Menu:      0x12,  // VK_MENU    — Alt
  Capital:   0x14,  // VK_CAPITAL — Caps Lock
  LWin:      0x5B,  // VK_LWIN   — Left Super/Meta
  RWin:      0x5C,  // VK_RWIN   — Right Super/Meta

  // Left / right variants
  LShift:    0xA0,  // VK_LSHIFT
  RShift:    0xA1,  // VK_RSHIFT
  LControl:  0xA2,  // VK_LCONTROL
  RControl:  0xA3,  // VK_RCONTROL
  LMenu:     0xA4,  // VK_LMENU  — Left Alt
  RMenu:     0xA5,  // VK_RMENU  — Right Alt

  // Digits 0–9 (0x30–0x39)
  Zero:  0x30, One:   0x31, Two:   0x32, Three: 0x33, Four:  0x34,
  Five:  0x35, Six:   0x36, Seven: 0x37, Eight: 0x38, Nine:  0x39,

  // Letters A–Z (0x41–0x5A)
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47,
  H: 0x48, I: 0x49, J: 0x4A, K: 0x4B, L: 0x4C, M: 0x4D, N: 0x4E,
  O: 0x4F, P: 0x50, Q: 0x51, R: 0x52, S: 0x53, T: 0x54, U: 0x55,
  V: 0x56, W: 0x57, X: 0x58, Y: 0x59, Z: 0x5A,

  // Function keys F1–F12 (0x70–0x7B)
  F1:  0x70, F2:  0x71, F3:  0x72, F4:  0x73,
  F5:  0x74, F6:  0x75, F7:  0x76, F8:  0x77,
  F9:  0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
};

// ---------------------------------------------------------------------------
// Platform / version spoofs — required for the Cowork availability check.
// The in-process JS gate does getPlatform() === "darwin"; we satisfy it here.
// ---------------------------------------------------------------------------
function getOSVersion()        { return '14.0.0'; }  // macOS Sonoma spoof
function getPlatform()         { return 'darwin'; }   // must stay "darwin"
function getPlatformName()     { return 'macOS'; }    // display name for UI
function getPlatformInfo()     { return { platform: 'darwin', name: 'macOS', version: '14.0.0', arch: process.arch }; }
function isCoworkSupported()   { return true; }
function getCoworkAvailability() { return { status: 'supported' }; }

// ---------------------------------------------------------------------------
// AuthRequest — handles the claude:// OAuth deep-link callback.
// Uses detached+stdio:ignore+unref so the opener does not block Electron.
// ---------------------------------------------------------------------------
class AuthRequest {
  static isAvailable() { return true; }

  constructor() {
    this._callbackURLScheme = 'claude';
  }

  /**
   * Open the system browser for OAuth and return a Promise that resolves
   * with { callbackUrl: string } when the claude:// redirect arrives.
   *
   * The app calls: new AuthRequest(); then await request.start(url)
   * The URL is passed to start(), not the constructor.
   *
   * On Linux, open-url-bridge.js forwards the second-instance event to
   * app.emit('open-url', ...) which we listen for here.
   */
  start(url) {
    const scheme = this._callbackURLScheme;
    const authUrl = url;

    // Open the browser immediately (fire-and-forget).
    try {
      const child = spawn('xdg-open', [authUrl], { detached: true, stdio: 'ignore' });
      child.unref();
      process.stderr.write(`[claude-native stub] Opened browser for OAuth: ${authUrl}\n`);
    } catch {
      process.stderr.write(`[claude-native stub] xdg-open unavailable. Open manually:\n  ${authUrl}\n`);
    }

    // Return a Promise that resolves when the claude:// callback arrives.
    // open-url-bridge.js emits 'open-url' on the Electron app when a
    // second instance is launched with the callback URL in its argv.
    let app;
    try {
      app = require('electron').app;
    } catch {
      // Not running inside Electron — resolve immediately with a stub URL.
      process.stderr.write(`[claude-native stub] Not in Electron context; resolving stub callbackUrl.\n`);
      return Promise.resolve({ callbackUrl: `${scheme}://` });
    }

    return new Promise((resolve) => {
      const onOpenUrl = (event, cbUrl) => {
        if (typeof cbUrl === 'string' && cbUrl.toLowerCase().startsWith(`${scheme}://`)) {
          process.stderr.write(`[claude-native stub] OAuth callback received: ${cbUrl}\n`);
          app.removeListener('open-url', onOpenUrl);
          resolve({ callbackUrl: cbUrl });
        }
      };
      app.on('open-url', onOpenUrl);

      // Safety timeout: after 5 minutes give up so the UI can show an error.
      const timer = setTimeout(() => {
        app.removeListener('open-url', onOpenUrl);
        process.stderr.write(`[claude-native stub] OAuth timeout — no ${scheme}:// callback received.\n`);
        resolve({ callbackUrl: `${scheme}://timeout` });
      }, 5 * 60 * 1000);

      // Don't keep the Node event loop alive just for the timeout.
      if (timer.unref) timer.unref();
    });
  }

  // Legacy alias
  open(...args) { return this.start(...args); }
}

// ---------------------------------------------------------------------------
// Proxy — any unknown property returns a no-op function, with a one-time
// warning to stderr so callers are visible in logs.
// ---------------------------------------------------------------------------
const _warned = new Set();

const _base = {
  KeyboardKey, getOSVersion, getPlatform, getPlatformName, getPlatformInfo,
  isCoworkSupported, getCoworkAvailability, AuthRequest,
};

module.exports = new Proxy(_base, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (!_warned.has(prop)) {
      _warned.add(prop);
      process.stderr.write(`[claude-native stub] unknown property accessed: ${String(prop)}\n`);
    }
    return function noop() {};
  },
});
