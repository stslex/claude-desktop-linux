#!/usr/bin/env node
/**
 * apply-platform-gate.mjs
 *
 * Splice the platform-gate function body in a minified JS bundle,
 * replacing it with an unconditional `return { status: "supported" }`.
 *
 * Usage:
 *   node apply-platform-gate.mjs <bundle.js> <offsets-json>
 *
 *   <offsets-json>  Path to a JSON file containing { bodyStart, bodyEnd }
 *                   as written by find-platform-gate.mjs, OR "-" to read
 *                   the JSON from stdin.
 *
 * The bundle is patched in-place. A backup is written to <bundle.js>.orig
 * before any modification.
 *
 * Exit 1 on any error.
 */

import { readFileSync, writeFileSync, copyFileSync } from 'fs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const [, , bundlePath, offsetsArg] = process.argv;

if (!bundlePath || !offsetsArg) {
  process.stderr.write(
    'Usage: apply-platform-gate.mjs <bundle.js> <offsets.json|->\n'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load offsets
// ---------------------------------------------------------------------------
let offsets;
try {
  const raw = offsetsArg === '-'
    ? readFileSync('/dev/stdin', 'utf8')
    : readFileSync(offsetsArg, 'utf8');
  offsets = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`[apply-platform-gate] Cannot read offsets: ${err.message}\n`);
  process.exit(1);
}

const { bodyStart, bodyEnd } = offsets;

if (typeof bodyStart !== 'number' || typeof bodyEnd !== 'number') {
  process.stderr.write('[apply-platform-gate] offsets JSON must contain numeric bodyStart and bodyEnd\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load bundle
// ---------------------------------------------------------------------------
const src = readFileSync(bundlePath, 'utf8');

// Sanity: offsets must be within the file.
if (bodyStart < 0 || bodyEnd > src.length || bodyStart >= bodyEnd) {
  process.stderr.write(
    `[apply-platform-gate] Offsets [${bodyStart}..${bodyEnd}] are out of range ` +
    `for file of length ${src.length}. Was the file modified between find and apply?\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Verify we're replacing the right thing — the existing body should contain
// the string "unsupported" (a quick sanity check before we clobber it).
// ---------------------------------------------------------------------------
const existingBody = src.slice(bodyStart, bodyEnd);
if (!existingBody.includes('unsupported')) {
  process.stderr.write(
    `[apply-platform-gate] WARNING: existing body at [${bodyStart}..${bodyEnd}] ` +
    `does not contain "unsupported". Offsets may be stale.\n` +
    `  Existing body: ${existingBody.slice(0, 200)}\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Patch — string splice, no re-parsing.
// ---------------------------------------------------------------------------
const REPLACEMENT = '{return{status:"supported"}}';

const patched =
  src.slice(0, bodyStart) +
  REPLACEMENT +
  src.slice(bodyEnd);

// Write backup first.
copyFileSync(bundlePath, bundlePath + '.orig');
writeFileSync(bundlePath, patched, 'utf8');

process.stderr.write(
  `[apply-platform-gate] Patched ${bundlePath}\n` +
  `  Replaced [${bodyStart}..${bodyEnd}] (${bodyEnd - bodyStart} chars) ` +
  `with "${REPLACEMENT}" (${REPLACEMENT.length} chars)\n` +
  `  Backup: ${bundlePath}.orig\n`
);
