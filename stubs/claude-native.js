'use strict';

const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// KeyboardKey enum — integer constants used by the global hotkey system.
// Values copied from existing community ports (k3d3/patchy-cnb, etc.).
// ---------------------------------------------------------------------------
const KeyboardKey = {
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
  K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19,
  U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
  Zero: 26, One: 27, Two: 28, Three: 29, Four: 30,
  Five: 31, Six: 32, Seven: 33, Eight: 34, Nine: 35,
  F1: 36, F2: 37, F3: 38, F4: 39, F5: 40, F6: 41,
  F7: 42, F8: 43, F9: 44, F10: 45, F11: 46, F12: 47,
  Space: 48, Enter: 49, Tab: 50, Backspace: 51, Escape: 52,
  Up: 53, Down: 54, Left: 55, Right: 56,
  Shift: 57, Control: 58, Alt: 59, Meta: 60,
};

// ---------------------------------------------------------------------------
// Platform / version spoofs — required for the Cowork availability check.
// The in-process JS gate does getPlatform() === "darwin"; we satisfy it here.
// ---------------------------------------------------------------------------
function getOSVersion() { return '14.0.0'; }   // macOS Sonoma spoof
function getPlatform()  { return 'darwin'; }    // must stay "darwin"

// ---------------------------------------------------------------------------
// AuthRequest — handles the claude:// OAuth deep-link callback.
// The .desktop file + RPM %post register the URI scheme via xdg-mime so the
// system routes claude:// back to us.
// ---------------------------------------------------------------------------
class AuthRequest {
  constructor(url) {
    this._url = url;
  }

  open() {
    try {
      execFileSync('xdg-open', [this._url], { stdio: 'ignore' });
    } catch {
      // xdg-open not available — print the URL so the user can open it manually.
      process.stderr.write(`[claude-native stub] xdg-open unavailable. Open manually:\n  ${this._url}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Everything else — silent no-ops. The app calls some of these but does not
// rely on their return values for core functionality.
// ---------------------------------------------------------------------------
function noop() { return undefined; }

module.exports = {
  KeyboardKey,
  getOSVersion,
  getPlatform,
  AuthRequest,
  // Clipboard helpers
  getClipboardText:    noop,
  setClipboardText:    noop,
  // Notification bridge
  showNotification:    noop,
  // Hardware identifier
  getMachineId:        noop,
  getSerialNumber:     noop,
  // Window / dock helpers
  setDockBadge:        noop,
  getDockBadge:        noop,
  setWindowVibrancy:   noop,
  // Misc
  getSystemIdleTime:   noop,
  registerGlobalShortcut:   noop,
  unregisterGlobalShortcut: noop,
};
