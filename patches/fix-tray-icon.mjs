#!/usr/bin/env node
/**
 * fix-tray-icon.mjs
 *
 * Fixes a Vite minifier bug where the tray icon creation function uses an
 * undefined variable on the non-Windows (Linux/macOS) code path.
 *
 * The minified code looks like:
 *
 *   sa ? e = Ae.nativeTheme.shouldUseDarkColors ? "Tray-Win32-Dark.ico" : "Tray-Win32.ico"
 *      : e = oe.nativeTheme.shouldUseDarkColors ? "TrayIconTemplate-Dark.png" : "TrayIconTemplate.png"
 *
 * Where:
 *   sa = process.platform === "win32"
 *   Ae = require("electron")  (correct, used in the Windows branch)
 *   oe = undefined            (wrong — should be Ae, used in the non-Windows branch)
 *
 * Strategy:
 *   1. Parse the bundle with acorn.
 *   2. Find ConditionalExpression nodes whose branches contain the tray icon
 *      string literals ("Tray-Win32-Dark.ico" / "Tray-Win32.ico" and
 *      "TrayIconTemplate-Dark.png" / "TrayIconTemplate.png").
 *   3. In the Windows branch (containing "Tray-Win32"), identify the correct
 *      Electron module identifier (the object before .nativeTheme.shouldUseDarkColors).
 *   4. In the non-Windows branch (containing "TrayIconTemplate"), find the
 *      wrong identifier in the same structural position.
 *   5. If they differ, replace the wrong one with the correct one.
 *
 * Usage:
 *   node patches/fix-tray-icon.mjs <app-extracted-dir>
 *   node patches/fix-tray-icon.mjs               # uses $BUILD_DIR/app-extracted
 *
 * Exit codes:
 *   0  Patch applied (or no patch needed — identifiers already match).
 *   1  No match, ambiguous match, or error.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);

// --bundle <path>  — explicit bundle path (preferred)
let bundleOverride = null;
const bundleIdx = rawArgs.indexOf('--bundle');
if (bundleIdx !== -1 && bundleIdx + 1 < rawArgs.length) {
  bundleOverride = rawArgs[bundleIdx + 1];
}

// Positional arg: app-extracted directory (fallback if --bundle not given)
const appDir = rawArgs.find((a, i) => !a.startsWith('--') && i !== bundleIdx + 1)
  || join(process.env.BUILD_DIR || '/tmp/claude-build', 'app-extracted');

const bundlePath = bundleOverride || join(appDir, '.vite', 'build', 'index.js');

const log = (msg) => process.stderr.write(`[fix-tray-icon] ${msg}\n`);

if (!existsSync(bundlePath)) {
  log(`Bundle not found: ${bundlePath}`);
  process.exit(1);
}

const src = readFileSync(bundlePath, 'utf8');
log(`Parsing ${bundlePath} (${src.length} chars)...`);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
let ast;
try {
  ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
} catch {
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReserved: true });
  } catch (e) {
    log(`Parse error: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all string literal values in a subtree (single walk). */
function collectStrings(node) {
  const out = new Set();
  simple(node, {
    Literal(n) { if (typeof n.value === 'string') out.add(n.value); },
  });
  return out;
}

/**
 * Extract the identifier name from a `<id>.nativeTheme.shouldUseDarkColors`
 * member expression chain within a subtree.
 *
 * We look for:
 *   MemberExpression {
 *     object: MemberExpression {
 *       object: Identifier { name: ??? }  <-- this is what we want
 *       property: "nativeTheme"
 *     }
 *     property: "shouldUseDarkColors"
 *   }
 */
function findNativeThemeIdentifier(node) {
  const results = [];
  simple(node, {
    MemberExpression(n) {
      const prop = n.property;
      if ((prop.name || prop.value) !== 'shouldUseDarkColors') return;
      const obj = n.object;
      if (!obj || obj.type !== 'MemberExpression') return;
      const innerProp = obj.property;
      if ((innerProp.name || innerProp.value) !== 'nativeTheme') return;
      const root = obj.object;
      if (root && root.type === 'Identifier') {
        results.push({ name: root.name, start: root.start, end: root.end });
      }
    },
  });
  return results;
}

// ---------------------------------------------------------------------------
// Search — find the tray icon conditional
// ---------------------------------------------------------------------------
// We look for ConditionalExpression nodes where one branch contains Win32
// tray icon strings and the other contains Template tray icon strings.

const WIN32_STRINGS = ['Tray-Win32-Dark.ico', 'Tray-Win32.ico'];
const TEMPLATE_STRINGS = ['TrayIconTemplate-Dark.png', 'TrayIconTemplate.png'];

/**
 * @typedef {{ winBranch: object, nonWinBranch: object, node: object }} TrayConditional
 */

/** @type {TrayConditional[]} */
const candidates = [];

simple(ast, {
  ConditionalExpression(node) {
    // Collect all strings in each branch in a single pass (avoids O(N*subtree)).
    const consStrings = collectStrings(node.consequent);
    const altStrings  = collectStrings(node.alternate);
    const consHasWin = WIN32_STRINGS.some(s => consStrings.has(s));
    const consHasTpl = TEMPLATE_STRINGS.some(s => consStrings.has(s));
    const altHasWin  = WIN32_STRINGS.some(s => altStrings.has(s));
    const altHasTpl  = TEMPLATE_STRINGS.some(s => altStrings.has(s));

    let winBranch = null;
    let nonWinBranch = null;

    if (consHasWin && altHasTpl) {
      winBranch = node.consequent;
      nonWinBranch = node.alternate;
    } else if (altHasWin && consHasTpl) {
      winBranch = node.alternate;
      nonWinBranch = node.consequent;
    }

    if (winBranch && nonWinBranch) {
      candidates.push({ winBranch, nonWinBranch, node });
    }
  },
});

// Also check parent ternaries — the pattern may be nested. Sometimes the
// Win32/Template branches are inside an outer conditional (the platform check).
// Walk AssignmentExpression and SequenceExpression for broader patterns.
simple(ast, {
  AssignmentExpression(node) {
    // Pattern: e = cond ? ... "Tray-Win32" ... : ... "TrayIconTemplate" ...
    if (node.right && node.right.type === 'ConditionalExpression') {
      // Already caught by ConditionalExpression walk above
      return;
    }
  },
});

if (candidates.length === 0) {
  log('No tray icon conditional found in bundle.');
  log('The upstream minifier bug may have been fixed, or the code structure changed.');
  process.exit(1);
}

if (candidates.length > 1) {
  log(`Found ${candidates.length} tray icon conditionals — using innermost.`);
}

// Use the innermost (first found in a depth-first walk is fine since acorn-walk
// simple() visits children before siblings for expressions).
// Actually, pick the one with the smallest span.
candidates.sort((a, b) =>
  (a.node.end - a.node.start) - (b.node.end - b.node.start)
);

const match = candidates[0];
const preview = src.slice(match.node.start, Math.min(match.node.start + 150, match.node.end));
log(`Found tray icon conditional at offset ${match.node.start}..${match.node.end}`);
log(`  preview: ${preview.replace(/\n/g, ' ')}`);

// ---------------------------------------------------------------------------
// Extract identifiers from both branches
// ---------------------------------------------------------------------------
const winIds    = findNativeThemeIdentifier(match.winBranch);
const nonWinIds = findNativeThemeIdentifier(match.nonWinBranch);

if (winIds.length === 0) {
  log('Could not find nativeTheme.shouldUseDarkColors identifier in Windows branch.');
  log(`  Windows branch: ${src.slice(match.winBranch.start, match.winBranch.end)}`);
  process.exit(1);
}

if (nonWinIds.length === 0) {
  log('Could not find nativeTheme.shouldUseDarkColors identifier in non-Windows branch.');
  log(`  Non-Windows branch: ${src.slice(match.nonWinBranch.start, match.nonWinBranch.end)}`);
  process.exit(1);
}

const correctId = winIds[0].name;
const wrongId   = nonWinIds[0].name;
const wrongStart = nonWinIds[0].start;
const wrongEnd   = nonWinIds[0].end;

log(`Windows branch uses: ${correctId} (correct Electron reference)`);
log(`Non-Windows branch uses: ${wrongId} at offset ${wrongStart}..${wrongEnd}`);

if (correctId === wrongId) {
  log('Identifiers already match — no patch needed.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply patch — replace the wrong identifier with the correct one
// ---------------------------------------------------------------------------
const patched = src.slice(0, wrongStart) + correctId + src.slice(wrongEnd);

// Verify the patch didn't change length unexpectedly
const expectedLen = src.length - (wrongEnd - wrongStart) + correctId.length;
if (patched.length !== expectedLen) {
  log(`Length mismatch after patch: expected ${expectedLen}, got ${patched.length}`);
  process.exit(1);
}

writeFileSync(bundlePath, patched, 'utf8');

log('------------------------------------------------------------');
log(`Patched ${bundlePath}`);
log(`  offset: ${wrongStart}..${wrongEnd}`);
log(`  old identifier: ${wrongId}`);
log(`  new identifier: ${correctId}`);
log('------------------------------------------------------------');
