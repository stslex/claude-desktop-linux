'use strict';
/**
 * computer-use-linux.js  —  EXPERIMENTAL Linux backend for Cowork "computer use".
 *
 * DISABLED BY DEFAULT.  This module is only loaded when BOTH of these hold:
 *   - build-time : ENABLE_EXPERIMENTAL_PATCHES=1 (scripts/patch-cowork.sh copies
 *                  this file next to the injected @ant/claude-swift stub);
 *   - run-time   : ENABLE_COMPUTER_USE=1 (checked in stubs/claude-swift.js,
 *                  which require()s this module and sets `computerUse`).
 * With neither flag, claude-swift.js leaves `computerUse = null` and the app
 * behaves exactly as before.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS IMPLEMENTS — and the boundary that recon established
 * ───────────────────────────────────────────────────────────────────────────
 * The full contract is in /tmp/cd-computeruse-recon.md (Section 8).  Two
 * separate native surfaces back "computer use" on macOS/Windows:
 *
 *   1. @ant/claude-swift  .computerUse  ← THIS module's `createComputerUse()`
 *        display.getSize / display.listAll
 *        screenshot.captureExcluding / screenshot.captureRegion
 *        resolvePrepareCapture            (root-level fn)
 *        tcc.checkAccessibility / tcc.checkScreenRecording / request*
 *        apps.{prepareDisplay,previewHideSet,findWindowDisplays,appUnderPoint,
 *              listInstalled,iconDataUrl,listRunning,open,unhide}
 *      → screenshots via `grim`; resize+JPEG via Electron nativeImage.
 *
 *   2. @ant/claude-native  (mouse/keyboard)  ← THIS module's `createInput()`
 *        moveMouse / mouseButton / mouseScroll / keys / key / typeText /
 *        mouseLocation / getFrontmostAppInfo
 *      → `ydotool` (absolute pointer + click + type + key + scroll),
 *        keyboard fallback `wtype`.
 *
 * Putting input methods on the `computerUse` namespace would CONTRADICT the
 * recon (they are not members of it) — guessing the contract has caused a
 * SIGSEGV regression here before — so `createInput()` is exported separately
 * for a future, deliberate wiring into stubs/claude-native.js.  It is NOT wired
 * by this change.
 *
 * IMPORTANT — this module alone does NOT enable end-to-end computer use on
 * Linux.  The stock bundle hard-gates Linux in three places (recon §8.5):
 *   (a) hBA = Set(["darwin","win32"])  → ib() false → tool reports "disabled";
 *   (b) executor dispatch is `win32?createWin32Executor:createDarwinExecutor`
 *       with NO linux branch → it THROWS at construction on Linux;
 *   (c) no linux capability profile.
 * Lifting those requires AST patches in the minified bundle and contradicts the
 * INVARIANTS.md "No Computer Use" non-goal → a maintainer decision, out of scope.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * COORDINATE SPACE — the single correctness risk (recon §8.4)
 * ───────────────────────────────────────────────────────────────────────────
 * The orchestrator's converter Yx maps model coords (in the downsampled
 * screenshot-image pixel space) to click coords with:
 *     clickX = round(modelX * lastShot.displayWidth / lastShot.width) + originX
 * and passes the result UNTRANSFORMED to the input backend.  So the ONE
 * invariant a Linux backend must hold is:
 *     screenshot.{displayWidth,displayHeight,originX,originY}  (and
 *     display.getSize().{width,height,scaleFactor,originX,originY})  MUST be
 *     in the SAME coordinate space that ydotool's absolute pointer consumes.
 * All of that mapping is centralised in ONE function: coordSpace() below.
 *
 * v1 ASSUMPTION (documented + asserted): a SINGLE output, scaleFactor = 1, no
 * fractional scaling, origin (0,0).  Then native px == logical px == ydotool
 * absolute px and the transform is the identity.  Multi-output (originX/originY
 * offsets, per-output grim `-o`) and fractional scaling (DIP↔px) are TODO.
 */

const { spawn, execFileSync } = require('child_process');

const TAG = '[computer-use-linux]';
const DEBUG = process.env.COWORK_DEBUG === '1' || process.env.COMPUTER_USE_DEBUG === '1';

function log(msg)  { process.stderr.write(`${TAG} ${msg}\n`); }
function debug(msg) { if (DEBUG) process.stderr.write(`${TAG} ${msg}\n`); }

// ---------------------------------------------------------------------------
// Electron handles (this module runs in the Electron main process).  Resolved
// lazily and defensively so the file is require()-able under plain Node too
// (the build-time `node --check` / self-test path).
// ---------------------------------------------------------------------------
function electron() {
  try { return require('electron'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Tool detection — runs ONCE at module load.  Missing tools degrade to a
// logged no-op; they never throw or crash the app.
// ---------------------------------------------------------------------------
function detectTool(bin) {
  try {
    // `which` resolves in well under this; the short timeout caps the worst case
    // so the (load-time, experimental-only) detection can't stall startup for
    // long on a pathological PATH. 3 tools × 600ms ≈ 1.8s worst case.
    execFileSync('which', [bin], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 600 });
    return true;
  } catch { return false; }
}

const TOOLS = {
  grim:    detectTool('grim'),
  ydotool: detectTool('ydotool'),
  wtype:   detectTool('wtype'),
};

(function reportToolsOnce() {
  const present = Object.entries(TOOLS).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(TOOLS).filter(([, v]) => !v).map(([k]) => k);
  log(`tools present: [${present.join(', ') || 'none'}]  missing: [${missing.join(', ') || 'none'}]`);
  if (!TOOLS.grim) {
    log('WARNING: `grim` not found — screenshots will be no-ops. Install: grim');
  }
  if (!TOOLS.ydotool && !TOOLS.wtype) {
    log('WARNING: neither `ydotool` nor `wtype` found — input will be no-ops. Install: ydotool (+ydotoold) and/or wtype');
  }
})();

// ---------------------------------------------------------------------------
// Process helper — spawn a tool, collect stdout as a Buffer, time-limited.
// Rejects on non-zero exit / spawn error / timeout.  Never throws synchronously.
// ---------------------------------------------------------------------------
function run(bin, args, { timeout = 8000, input } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`spawn ${bin} failed: ${e.message}`));
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done(reject, new Error(`${bin} timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => done(reject, new Error(`${bin}: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) done(resolve, Buffer.concat(out));
      else done(reject, new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString().trim().slice(0, 200)}`));
    });

    if (input != null) {
      child.stdin.on('error', () => {}); // ignore EPIPE
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

// ===========================================================================
// COORDINATE SPACE — the single centralized transform (recon §8.4).
// ===========================================================================
/**
 * Given a canonical display descriptor, return the mapping between the
 * captured screenshot's native pixels and the global click space that the
 * input backend (ydotool absolute) consumes.
 *
 * v1: single output, scaleFactor forced to 1, origin (0,0) — identity.
 * Multi-output / fractional scaling = TODO (see file header).
 *
 * @param {{width:number,height:number,scaleFactor:number,originX:number,originY:number}} display
 * @returns {{pxWidth:number,pxHeight:number,originX:number,originY:number,scaleFactor:number}}
 */
let _warnedScale = false;

/**
 * THE v1 scale assumption, in ONE place. v1 supports only scaleFactor == 1.
 * If the compositor reports fractional/HiDPI scaling we force 1 anyway (so the
 * whole pipeline — getSize, listAll, capture — stays internally consistent) and
 * warn LOUDLY once, because clicks WILL be miscalibrated until multi-scale
 * support lands. Never silently produce wrong coordinates.
 */
function assumedScaleFactor(display) {
  if (display && display.scaleFactor && display.scaleFactor !== 1 && !_warnedScale) {
    _warnedScale = true;
    log(`WARNING: display reports scaleFactor=${display.scaleFactor}; v1 supports ONLY 1 ` +
        '(single output, no fractional scaling). Forcing 1 — clicks will be MISCALIBRATED ' +
        'on this display until multi-scale support is added (TODO).');
  }
  return 1;
}

function coordSpace(display) {
  // v1 hard assumption: no fractional scaling — routed through assumedScaleFactor().
  const scaleFactor = assumedScaleFactor(display);
  return {
    pxWidth:  Math.max(1, Math.round(display.width  * scaleFactor)),
    pxHeight: Math.max(1, Math.round(display.height * scaleFactor)),
    // v1 single output => origin is (0,0); preserved here so multi-output is a
    // one-function change.
    originX: display.originX | 0,
    originY: display.originY | 0,
    scaleFactor,
  };
}

// ---------------------------------------------------------------------------
// Display enumeration.  Prefer Electron's screen API (authoritative — it is
// the same source the win32 path uses for display rects).  Fall back to a
// single synthetic display derived from a grim capture if Electron is absent.
// ---------------------------------------------------------------------------
function sanitizeLabel(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^A-Za-z0-9 _.\-]/g, '').trim().slice(0, 40);
}

let _fallbackDims = null; // cached {width,height} from a probe capture

function describeDisplays() {
  const e = electron();
  if (e && e.screen) {
    try {
      const all = e.screen.getAllDisplays();
      const primaryId = e.screen.getPrimaryDisplay().id;
      if (all && all.length) {
        return all.map((d) => ({
          displayId: d.id,
          width: d.size.width,
          height: d.size.height,
          scaleFactor: d.scaleFactor || 1,
          originX: (d.bounds && d.bounds.x) | 0,
          originY: (d.bounds && d.bounds.y) | 0,
          isPrimary: d.id === primaryId,
          label: sanitizeLabel(d.label) || `display ${d.id}`,
        }));
      }
    } catch (err) {
      debug(`electron screen enumeration failed: ${err.message}`);
    }
  }
  // Fallback: a single display, size from a cached grim probe (or a default).
  const w = (_fallbackDims && _fallbackDims.width) || 1920;
  const h = (_fallbackDims && _fallbackDims.height) || 1080;
  return [{
    displayId: 0, width: w, height: h, scaleFactor: 1,
    originX: 0, originY: 0, isPrimary: true, label: 'display 0',
  }];
}

function resolveDisplay(displayId) {
  const all = describeDisplays();
  return all.find((d) => d.displayId === displayId)
      || all.find((d) => d.isPrimary)
      || all[0];
}

// ---------------------------------------------------------------------------
// Screenshot capture: grim → (Electron nativeImage resize + JPEG) → base64.
// Mirrors the win32 path (nativeImage.resize().toJPEG()) so the return shape
// and the image/jpeg mimeType the orchestrator hardcodes both hold.
// `geometry` (optional) = { x, y, w, h } in display logical points → grim -g.
// ---------------------------------------------------------------------------
let _multiOutputChecked = false;

async function grimCapture(display, geometry) {
  if (!TOOLS.grim) throw new Error('grim not installed');
  // v1: single output → no `-o`, so grim captures the whole layout. When more
  // than one output exists this can disagree with the per-display geometry we
  // report (displayWidth/Height/origin*) and miscalibrate clicks on secondary
  // monitors. Probe once (regardless of count) so describeDisplays() doesn't
  // run on every capture; warn if multi-output. Per-output `-o` targeting +
  // origin offsets are the multi-output TODO (see file header / coordSpace).
  if (!_multiOutputChecked) {
    _multiOutputChecked = true;
    const outputs = describeDisplays().length;
    if (outputs > 1) {
      log(`WARNING: ${outputs} outputs detected; v1 captures the whole layout ` +
          '(no -o targeting). Screenshot/click coordinates are only reliable on a ' +
          'SINGLE-output setup — multi-output is a TODO.');
    }
  }
  const args = [];
  if (geometry) {
    args.push('-g', `${Math.round(geometry.x)},${Math.round(geometry.y)} ${Math.round(geometry.w)}x${Math.round(geometry.h)}`);
  }
  args.push('-t', 'png', '-'); // PNG to stdout (lossless source; re-encoded below)
  const png = await run('grim', args, { timeout: 8000 });
  if (!png || png.length === 0) throw new Error('grim produced no output');
  return png;
}

/**
 * Capture + encode to the orchestrator's contract.
 * @returns {{base64,width,height,displayWidth,displayHeight,displayId,originX,originY}}
 */
async function captureToContract(display, targetMaxW, targetMaxH, quality, geometry) {
  const space = coordSpace(display);
  const png = await grimCapture(display, geometry);
  const q = Math.max(1, Math.min(100, Math.round((quality == null ? 0.75 : quality) * 100)));

  const e = electron();
  let base64, outW, outH;
  if (e && e.nativeImage) {
    let img = e.nativeImage.createFromBuffer(png);
    if (img.isEmpty()) throw new Error('nativeImage decode failed (empty)');
    if (targetMaxW && targetMaxH) {
      img = img.resize({ width: Math.round(targetMaxW), height: Math.round(targetMaxH), quality: 'good' });
    }
    const sz = img.getSize();
    outW = sz.width; outH = sz.height;
    base64 = img.toJPEG(q).toString('base64');
  } else {
    // No Electron (self-test / headless): grim the JPEG directly, no resize.
    const jpeg = await run('grim', [
      ...(geometry ? ['-g', `${Math.round(geometry.x)},${Math.round(geometry.y)} ${Math.round(geometry.w)}x${Math.round(geometry.h)}`] : []),
      '-t', 'jpeg', '-q', String(q), '-',
    ], { timeout: 8000 });
    base64 = jpeg.toString('base64');
    outW = geometry ? Math.round(geometry.w) : space.pxWidth;
    outH = geometry ? Math.round(geometry.h) : space.pxHeight;
    if (!_fallbackDims && !geometry) _fallbackDims = { width: outW, height: outH };
  }

  return {
    base64,
    width: outW,
    height: outH,
    displayWidth: space.pxWidth,
    displayHeight: space.pxHeight,
    displayId: display.displayId,
    originX: space.originX,
    originY: space.originY,
  };
}

/**
 * The win32-parity graceful-failure shape. Returned (never thrown) by every
 * capture method when grim is missing or fails, so a direct caller surfaces a
 * clean `captureError` instead of aborting — matching this module's documented
 * "missing tools degrade to a no-op" contract. The screenshot tool handler
 * checks `captureError` and returns capture_failed; handlers that only read
 * `.base64` (e.g. zoom) get an empty string rather than an exception.
 *
 * @param {number|undefined} displayId
 * @param {unknown} err
 */
function captureFailure(displayId, err) {
  return {
    base64: '', width: 0, height: 0, displayWidth: 0, displayHeight: 0,
    displayId: displayId != null ? displayId : 0, originX: 0, originY: 0,
    captureError: err instanceof Error ? err.message : String((err && err.message) || err || 'Screenshot capture failed'),
  };
}

/** captureToContract with the graceful-failure shape on any error. */
async function safeCapture(display, targetMaxW, targetMaxH, quality, geometry) {
  try {
    return await captureToContract(display, targetMaxW, targetMaxH, quality, geometry);
  } catch (err) {
    return captureFailure(display ? display.displayId : undefined, err);
  }
}

// ===========================================================================
// computerUse NAMESPACE  (the @ant/claude-swift surface)
// ===========================================================================
function buildComputerUse() {
  const impl = {
    // -- display ------------------------------------------------------------
    display: {
      getSize(displayId) {
        const d = resolveDisplay(displayId);
        if (!d) throw new Error('No displays enumerated');
        // scaleFactor routed through the v1 assumption so the executor's
        // width*scaleFactor capture-target math matches the px we report.
        return {
          width: d.width, height: d.height, scaleFactor: assumedScaleFactor(d),
          originX: d.originX, originY: d.originY,
        };
      },
      listAll() {
        return describeDisplays().map((d) => ({
          displayId: d.displayId, width: d.width, height: d.height,
          scaleFactor: assumedScaleFactor(d), originX: d.originX, originY: d.originY,
          isPrimary: d.isPrimary, label: d.label,
        }));
      },
    },

    // -- screenshot ---------------------------------------------------------
    screenshot: {
      // captureExcluding(allowedBundleIds, quality, targetMaxW, targetMaxH, displayId)
      // Wayland has no per-window exclusion via grim; allowedBundleIds is
      // accepted and ignored (v1). Whole-display capture. On grim missing/failure
      // returns the graceful captureError shape (never rejects) — same as
      // resolvePrepareCapture — so direct callers surface a clean failure.
      async captureExcluding(_allowedBundleIds, quality, targetMaxW, targetMaxH, displayId) {
        const d = resolveDisplay(displayId);
        return safeCapture(d, targetMaxW, targetMaxH, quality, null);
      },
      // captureRegion(allowedBundleIds, x, y, w, h, targetMaxW, targetMaxH, quality, displayId)
      // x/y/w/h in display logical points. Only .base64 is consumed downstream;
      // we return the full contract shape, and the graceful captureError shape
      // (with base64:"") on failure rather than rejecting.
      async captureRegion(_allowedBundleIds, x, y, w, h, targetMaxW, targetMaxH, quality, displayId) {
        const d = resolveDisplay(displayId);
        return safeCapture(d, targetMaxW, targetMaxH, quality, { x, y, w, h });
      },
    },

    // -- resolvePrepareCapture (root-level fn) ------------------------------
    // (allowedBundleIds, hostBundleId, quality, targetMaxW, targetMaxH,
    //  preferredDisplayId, autoResolve, doHide) → capture + {hidden, activated}.
    // We do not hide apps on Wayland (no equivalent), so hidden=[] activated=null.
    async resolvePrepareCapture(allowedBundleIds, _hostBundleId, quality, targetMaxW, targetMaxH, preferredDisplayId, _autoResolve, _doHide) {
      const d = resolveDisplay(preferredDisplayId);
      // safeCapture yields either a full shot or the win32-parity captureError
      // shape; either way we add hidden/activated so the contract holds.
      const shot = await safeCapture(d, targetMaxW, targetMaxH, quality, null);
      return { ...shot, hidden: [], activated: null };
    },

    // -- tcc (Linux has no TCC; permission is implicit) ---------------------
    // ensureOsPermissions (DPA) needs BOTH check* truthy to grant on non-win32.
    tcc: {
      checkAccessibility() { return true; },
      checkScreenRecording() { return true; },
      requestAccessibility() { return true; },
      requestScreenRecording() { return true; },
    },

    // -- apps (no Wayland equivalent for global app/window enumeration) -----
    // All return the consumer's safe-default shapes (recon §8.2) so the grant
    // dialog / hide flow degrade gracefully instead of breaking the loop.
    apps: {
      prepareDisplay(_allowedBundleIds, _hostBundleId, _displayId) { return { activated: null, hidden: [] }; },
      previewHideSet(_bundleIds, _displayId) { return []; },
      findWindowDisplays(_bundleIds) { return []; },
      appUnderPoint(_x, _y) { return null; },
      listInstalled() { return []; },
      iconDataUrl(_path) { return null; },
      listRunning() { return []; },
      async open(_bundleId) { /* no-op (no bundle-id launch model on Linux) */ },
      async unhide(_bundleIds) { /* no-op (nothing is hidden) */ },
    },
  };

  // Wrap in a logging Proxy so any namespace member NOT positively identified
  // in Phase 1 degrades to a logged no-op (returning undefined) rather than
  // throwing — keeping `main` green. Mirrors the `vm` Proxy in claude-swift.js.
  const warned = new Set();
  const noop = (path) => function (...a) {
    if (!warned.has(path)) { warned.add(path); log(`UNIMPLEMENTED computerUse.${path} (${a.length} args) — logging no-op`); }
    return undefined;
  };
  const wrapNs = (obj, prefix) => new Proxy(obj, {
    get(t, p) {
      // Guard `then` BEFORE the unknown-property no-op: otherwise `then` would
      // resolve to a function, making the sub-namespace a thenable, so
      // `await computerUse.display` (or Promise.resolve of it) would hang.
      // Mirrors the root proxy and the vm/recon proxies in claude-swift.js.
      if (p === 'then') return undefined;
      if (p in t) return t[p];
      if (typeof p === 'symbol') return t[p];
      return noop(`${prefix}${String(p)}`);
    },
  });

  return new Proxy(impl, {
    get(t, p) {
      if (typeof p === 'symbol') return t[p];
      if (p === 'then') return undefined; // never thenable
      const v = t[p];
      if (v && typeof v === 'object' && !Array.isArray(v)) return wrapNs(v, `${String(p)}.`);
      if (p in t) return v;
      return noop(String(p));
    },
  });
}

// ===========================================================================
// INPUT primitives  (the @ant/claude-native surface — exported, NOT wired)
// ===========================================================================
// macOS-style key name → wtype `-k` xkb keysym name (best-effort, common keys).
const WTYPE_KEYSYMS = {
  command: 'Super_L', cmd: 'Super_L', meta: 'Super_L', super: 'Super_L', win: 'Super_L',
  control: 'Control_L', ctrl: 'Control_L', option: 'Alt_L', alt: 'Alt_L',
  shift: 'Shift_L', return: 'Return', enter: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape',
  space: 'space', backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
};
const WTYPE_MODS = new Set(['Super_L', 'Control_L', 'Alt_L', 'Shift_L']);

// ydotool 1.x click argument nibbles: 0x40=down, 0x80=up, 0xC0=down+up; +button.
const YDO_BUTTON = { left: 0x00, right: 0x01, middle: 0x02 };

function buildInput() {
  async function tryRun(bin, args, opts) {
    try { await run(bin, args, opts); return true; }
    catch (e) { debug(`${bin} ${args.join(' ')} → ${e.message}`); return false; }
  }

  return {
    /** moveMouse(x, y, _animate) — absolute, in the ydotool/native click space. */
    async moveMouse(x, y, _animate) {
      if (!TOOLS.ydotool) { debug('moveMouse no-op (ydotool absent)'); return; }
      // ydotool 1.x: `mousemove -a -x X -y Y` (absolute).
      await tryRun('ydotool', ['mousemove', '-a', '-x', String(Math.round(x)), '-y', String(Math.round(y))]);
    },

    /** mouseButton(button, action, count?) — action: "click"|"press"|"release". */
    async mouseButton(button, action, count) {
      if (!TOOLS.ydotool) { debug('mouseButton no-op (ydotool absent)'); return; }
      const b = YDO_BUTTON[button] != null ? YDO_BUTTON[button] : 0x00;
      let nibble;
      if (action === 'press') nibble = 0x40;
      else if (action === 'release') nibble = 0x80;
      else nibble = 0xC0; // click (down+up)
      const code = '0x' + (nibble | b).toString(16).toUpperCase().padStart(2, '0');
      const n = Math.max(1, count || 1);
      const args = ['click'];
      if (n > 1) args.push('--repeat', String(n), '--next-delay', '40');
      args.push(code);
      await tryRun('ydotool', args);
    },

    /** mouseScroll(amount, dir) — dir: "vertical"|"horizontal". */
    async mouseScroll(amount, dir) {
      if (!TOOLS.ydotool) { debug('mouseScroll no-op (ydotool absent)'); return; }
      const a = Math.round(amount) || 0;
      if (a === 0) return;
      // ydotool wheel: `mousemove -w -x H -y V`.
      const args = dir === 'horizontal'
        ? ['mousemove', '-w', '-x', String(a), '-y', '0']
        : ['mousemove', '-w', '-x', '0', '-y', String(a)];
      await tryRun('ydotool', args);
    },

    /** keys(arr) — chord, e.g. ["command","v"]. Prefer wtype (named keys). */
    async keys(arr) {
      const list = Array.isArray(arr) ? arr : [arr];
      if (TOOLS.wtype) {
        // Build: press modifiers (-M), tap last key (-k), release modifiers (-m).
        const syms = list.map((k) => WTYPE_KEYSYMS[String(k).toLowerCase()] || k);
        const mods = syms.filter((s) => WTYPE_MODS.has(s));
        const keys = syms.filter((s) => !WTYPE_MODS.has(s));
        const args = [];
        for (const m of mods) args.push('-M', m);
        for (const k of keys) args.push('-k', k);
        for (const m of mods.reverse()) args.push('-m', m);
        if (args.length) { await tryRun('wtype', args); return; }
      }
      debug(`keys no-op for [${list.join('+')}] (wtype absent or unmapped; ydotool keycode map is TODO)`);
    },

    /** key(name, action) — action: "press"|"release". Best-effort via wtype. */
    async key(name, action) {
      const sym = WTYPE_KEYSYMS[String(name).toLowerCase()] || name;
      if (TOOLS.wtype) {
        if (action === 'press') await tryRun('wtype', ['-P', sym]);
        else if (action === 'release') await tryRun('wtype', ['-p', sym]);
        else await tryRun('wtype', ['-k', sym]);
        return;
      }
      debug(`key no-op for ${name}/${action} (wtype absent)`);
    },

    /** typeText(str) — Unicode text entry. ydotool primary, wtype fallback. */
    async typeText(str) {
      const text = String(str == null ? '' : str);
      if (text.length === 0) return;
      if (TOOLS.ydotool && await tryRun('ydotool', ['type', '--', text])) return;
      if (TOOLS.wtype && await tryRun('wtype', [text])) return;
      debug('typeText no-op (ydotool/wtype absent)');
    },

    /** mouseLocation() → {x,y}. Electron screen.getCursorScreenPoint(). */
    mouseLocation() {
      const e = electron();
      try {
        if (e && e.screen) { const p = e.screen.getCursorScreenPoint(); return { x: p.x, y: p.y }; }
      } catch {}
      return { x: 0, y: 0 };
    },

    /** getFrontmostAppInfo() → {bundleId,appName}|null. No model on Wayland. */
    getFrontmostAppInfo() { return null; },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  createComputerUse: buildComputerUse,
  createInput: buildInput,
  // exported for tests / future wiring
  _internals: { coordSpace, describeDisplays, captureToContract, detectTool, TOOLS },
};

// ---------------------------------------------------------------------------
// Self-test: `node stubs/computer-use-linux.js --selftest`
// Validates the module loads, the namespace shape is complete, the coordinate
// transform is consistent, and (if grim is present) a real capture round-trips.
// ---------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    let failures = 0;
    const check = (name, cond) => { process.stdout.write(`${cond ? 'ok  ' : 'FAIL'} ${name}\n`); if (!cond) failures++; };

    const cu = buildComputerUse();
    check('computerUse.display.getSize is fn', typeof cu.display.getSize === 'function');
    check('computerUse.display.listAll is fn', typeof cu.display.listAll === 'function');
    check('computerUse.screenshot.captureExcluding is fn', typeof cu.screenshot.captureExcluding === 'function');
    check('computerUse.screenshot.captureRegion is fn', typeof cu.screenshot.captureRegion === 'function');
    check('computerUse.resolvePrepareCapture is fn', typeof cu.resolvePrepareCapture === 'function');
    check('computerUse.tcc.checkAccessibility()===true', cu.tcc.checkAccessibility() === true);
    check('computerUse.tcc.checkScreenRecording()===true', cu.tcc.checkScreenRecording() === true);
    for (const m of ['prepareDisplay', 'previewHideSet', 'findWindowDisplays', 'appUnderPoint', 'listInstalled', 'iconDataUrl', 'listRunning', 'open', 'unhide']) {
      check(`computerUse.apps.${m} is fn`, typeof cu.apps[m] === 'function');
    }
    check('apps.prepareDisplay shape', JSON.stringify(cu.apps.prepareDisplay()) === '{"activated":null,"hidden":[]}');
    check('apps.listInstalled() === []', Array.isArray(cu.apps.listInstalled()) && cu.apps.listInstalled().length === 0);
    check('unknown namespace member → no-op (no throw)', (() => { try { return cu.nope === undefined ? true : cu.nope() === undefined; } catch { return false; } })());
    check('sub-namespaces are not thenable (await-safe)', cu.apps.then === undefined && cu.display.then === undefined && cu.screenshot.then === undefined && cu.tcc.then === undefined);
    const _appsNs = cu.apps; // capture once (each access returns a fresh sub-proxy)
    check('await of a sub-namespace resolves (no hang)', (await Promise.resolve(_appsNs)) === _appsNs);

    // coordSpace identity (v1)
    const cs = coordSpace({ width: 2560, height: 1440, scaleFactor: 1, originX: 0, originY: 0 });
    check('coordSpace pxWidth=2560', cs.pxWidth === 2560);
    check('coordSpace pxHeight=1440', cs.pxHeight === 1440);
    check('coordSpace forces scaleFactor=1', cs.scaleFactor === 1);

    const input = buildInput();
    for (const m of ['moveMouse', 'mouseButton', 'mouseScroll', 'keys', 'key', 'typeText', 'mouseLocation', 'getFrontmostAppInfo']) {
      check(`input.${m} is fn`, typeof input[m] === 'function');
    }

    if (TOOLS.grim) {
      try {
        const display = { displayId: 0, width: 1920, height: 1080, scaleFactor: 1, originX: 0, originY: 0 };
        const shot = await captureToContract(display, 1568, 882, 0.75, null);
        const bytes = Buffer.from(shot.base64, 'base64').length;
        check('live grim capture base64 non-empty', shot.base64.length > 0);
        check('live capture decoded >= 1024 bytes (Lgt)', bytes >= 1024);
        check('live capture reports displayWidth/Height', shot.displayWidth > 0 && shot.displayHeight > 0);
        process.stdout.write(`     captured ${shot.width}x${shot.height} (display ${shot.displayWidth}x${shot.displayHeight}), ${bytes} bytes\n`);
      } catch (e) {
        check(`live grim capture (${e.message})`, false);
      }
    } else {
      process.stdout.write('skip live capture (grim absent)\n');
    }

    // Failure path: with grim forced absent, captureExcluding/captureRegion/
    // resolvePrepareCapture must RETURN the captureError shape, never reject.
    {
      const savedGrim = TOOLS.grim;
      TOOLS.grim = false; // _internals.TOOLS is the same object the methods read
      try {
        const a = await cu.screenshot.captureExcluding([], 0.75, 1568, 882, 0);
        check('captureExcluding(no grim) returns captureError (no throw)', a && typeof a.captureError === 'string' && a.base64 === '');
        const b = await cu.screenshot.captureRegion([], 0, 0, 10, 10, 16, 16, 0.75, 0);
        check('captureRegion(no grim) returns captureError (no throw)', b && typeof b.captureError === 'string');
        const c = await cu.resolvePrepareCapture([], 'host', 0.75, 1568, 882, 0, true, true);
        check('resolvePrepareCapture(no grim) → captureError + hidden/activated', c && typeof c.captureError === 'string' && Array.isArray(c.hidden) && c.activated === null);
      } catch (e) {
        check(`capture failure path threw (${e.message})`, false);
      } finally {
        TOOLS.grim = savedGrim;
      }
    }

    process.stdout.write(failures === 0 ? '\nSELFTEST PASS\n' : `\nSELFTEST FAIL (${failures})\n`);
    process.exit(failures === 0 ? 0 : 1);
  })();
}
