#!/usr/bin/env node
/**
 * apply-platform-gate.mjs
 *
 * Splice the platform-gate function body in a minified JS bundle,
 * replacing it with an unconditional `return { status: "supported" }`.
 *
 * Usage:
 *   node patches/apply-platform-gate.mjs [--input <gate-location.json>]
 *
 *   --input   Path to gate-location.json written by find-platform-gate.mjs.
 *             Default: $BUILD_DIR/gate-location.json, or ./gate-location.json.
 *
 * The JSON must contain { file, start, end }.
 * The bundle at `file` is patched in-place.
 *
 * Exit 0 on success. Exit 1 if the file doesn't exist, JSON is malformed,
 * or the character range is out of bounds.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

let inputPath = null;
const inputIdx = args.indexOf('--input');
if (inputIdx !== -1 && inputIdx + 1 < args.length) {
  inputPath = args[inputIdx + 1];
}

if (!inputPath) {
  inputPath = process.env.BUILD_DIR
    ? join(process.env.BUILD_DIR, 'gate-location.json')
    : './gate-location.json';
}

// ---------------------------------------------------------------------------
// Load gate-location.json
// ---------------------------------------------------------------------------
let gateInfo;
try {
  if (!existsSync(inputPath)) {
    process.stderr.write(`[apply-platform-gate] File not found: ${inputPath}\n`);
    process.exit(1);
  }
  const raw = readFileSync(inputPath, 'utf8');
  gateInfo = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`[apply-platform-gate] Cannot read/parse ${inputPath}: ${err.message}\n`);
  process.exit(1);
}

const { file: bundlePath, start, end } = gateInfo;

if (typeof bundlePath !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
  process.stderr.write(
    '[apply-platform-gate] JSON must contain { file: string, start: number, end: number }\n'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load bundle
// ---------------------------------------------------------------------------
let src;
try {
  if (!existsSync(bundlePath)) {
    process.stderr.write(`[apply-platform-gate] Bundle not found: ${bundlePath}\n`);
    process.exit(1);
  }
  src = readFileSync(bundlePath, 'utf8');
} catch (err) {
  process.stderr.write(`[apply-platform-gate] Cannot read ${bundlePath}: ${err.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Bounds check
// ---------------------------------------------------------------------------
if (start < 0 || end > src.length || start >= end) {
  process.stderr.write(
    `[apply-platform-gate] Character range [${start}..${end}] is out of bounds ` +
    `for file of length ${src.length}.\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Sanity: verify the range looks like a function body
// ---------------------------------------------------------------------------
const originalBody = src.slice(start, end);

if (originalBody[0] !== '{' || originalBody[originalBody.length - 1] !== '}') {
  process.stderr.write(
    `[apply-platform-gate] Range [${start}..${end}] does not look like a function body ` +
    `(expected to start with '{' and end with '}').\n` +
    `  Starts with: ${JSON.stringify(originalBody.slice(0, 20))}\n` +
    `  Ends with:   ${JSON.stringify(originalBody.slice(-20))}\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Patch — string splice, no regex, no re-parsing
// ---------------------------------------------------------------------------
const REPLACEMENT = '{return{status:"supported"}}';

const patched =
  src.slice(0, start) +
  REPLACEMENT +
  src.slice(end);

writeFileSync(bundlePath, patched, 'utf8');

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
process.stderr.write(
  `[apply-platform-gate] Patched ${bundlePath}\n` +
  `  Original body length : ${originalBody.length}\n` +
  `  Patched body length  : ${REPLACEMENT.length}\n` +
  `  Original body preview: ${originalBody.slice(0, 80)}\n`
);
