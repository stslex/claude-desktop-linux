#!/usr/bin/env node
/**
 * apply-platform-gate.mjs
 *
 * Splice the platform-gate function body (or bodies) in a minified JS bundle,
 * replacing each with an unconditional `return { status: "supported" }`.
 *
 * Usage:
 *   node patches/apply-platform-gate.mjs [--input <gate-location.json>]
 *
 *   --input   Path to gate-location.json written by find-platform-gate.mjs.
 *             Default: $BUILD_DIR/gate-location.json, or ./gate-location.json.
 *
 * The JSON must contain EITHER:
 *   { file, start, end }                          — single gate (legacy format)
 *   { gates: [{ file, start, end }, ...] }        — multi-gate format (--all mode)
 *
 * All bundles are patched in-place.
 *
 * Exit 0 on success. Exit 1 if the file doesn't exist, JSON is malformed,
 * or any character range is out of bounds.
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

// Also accept a plain positional path argument (first non-flag arg)
if (!inputPath) {
  const skipIdx = new Set(inputIdx !== -1 ? [inputIdx, inputIdx + 1] : []);
  const positional = args.find((a, i) => !skipIdx.has(i) && !a.startsWith('--'));
  if (positional) inputPath = positional;
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

// ---------------------------------------------------------------------------
// Normalise: accept either single-gate { file, start, end } or
// multi-gate { gates: [...] } format (written by find-platform-gate --all).
// ---------------------------------------------------------------------------
let gates;
if (Array.isArray(gateInfo.gates)) {
  gates = gateInfo.gates;
  process.stderr.write(`[apply-platform-gate] Multi-gate mode: ${gates.length} gate(s) to patch.\n`);
} else if (typeof gateInfo.file === 'string' && typeof gateInfo.start === 'number' && typeof gateInfo.end === 'number') {
  gates = [{ file: gateInfo.file, start: gateInfo.start, end: gateInfo.end }];
} else {
  process.stderr.write(
    '[apply-platform-gate] JSON must contain { file, start, end } or { gates: [...] }\n'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Patch each gate — string splice, no regex, no re-parsing
//
// When multiple gates live in the SAME file we must apply them from last to
// first (descending start offset) so that patching one gate doesn't shift
// the character offsets of subsequent gates.
// ---------------------------------------------------------------------------
const REPLACEMENT = '{return{status:"supported"}}';

// Group by file
/** @type {Map<string, Array<{ start: number, end: number }>>} */
let totalPatched = 0;
let totalSkipped = 0;

const byFile = new Map();
for (const gate of gates) {
  if (typeof gate.file !== 'string' || typeof gate.start !== 'number' || typeof gate.end !== 'number') {
    process.stderr.write(`[apply-platform-gate] Skipping malformed gate entry: ${JSON.stringify(gate)}\n`);
    totalSkipped++;
    continue;
  }
  if (!byFile.has(gate.file)) byFile.set(gate.file, []);
  byFile.get(gate.file).push({ start: gate.start, end: gate.end });
}

for (const [bundlePath, locs] of byFile) {
  // Load bundle
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

  // Sort descending so later offsets are patched first (preserves earlier offsets).
  locs.sort((a, b) => b.start - a.start);

  // Overlap check: after sorting descending, each range's start must be >= the
  // previous range's end to guarantee non-overlap.  If overlapping ranges
  // remain (e.g. nested functions), keep only the more specific (shorter) one.
  {
    const cleaned = [];
    for (const loc of locs) {
      // Check if this range contains (is a superset of) an already-kept range
      const containsExisting = cleaned.some(
        d => loc.start <= d.start && loc.end >= d.end
      );
      if (containsExisting) {
        process.stderr.write(
          `[apply-platform-gate] Skipping broader overlapping range [${loc.start}..${loc.end}] in ${bundlePath}\n`
        );
        totalSkipped++;
        continue;
      }
      cleaned.push(loc);
    }
    locs.length = 0;
    locs.push(...cleaned);
    locs.sort((a, b) => b.start - a.start);
  }

  for (const { start, end } of locs) {
    // Bounds check
    if (start < 0 || end > src.length || start >= end) {
      process.stderr.write(
        `[apply-platform-gate] Character range [${start}..${end}] is out of bounds ` +
        `for file of length ${src.length} — skipping.\n`
      );
      totalSkipped++;
      continue;
    }

    // Sanity: range must look like a function body
    const originalBody = src.slice(start, end);
    const trimmedBody  = originalBody.trim();
    if (trimmedBody[0] !== '{' || trimmedBody[trimmedBody.length - 1] !== '}') {
      process.stderr.write(
        `[apply-platform-gate] Range [${start}..${end}] does not look like a function body ` +
        `(expected '{' … '}') — skipping.\n` +
        `  Starts with: ${JSON.stringify(originalBody.slice(0, 20))}\n` +
        `  Ends with:   ${JSON.stringify(originalBody.slice(-20))}\n`
      );
      totalSkipped++;
      continue;
    }

    src = src.slice(0, start) + REPLACEMENT + src.slice(end);

    process.stderr.write(
      `[apply-platform-gate] Patched [${start}..${end}] in ${bundlePath}\n` +
      `  Original length : ${originalBody.length}  →  Replacement length: ${REPLACEMENT.length}\n` +
      `  Preview: ${originalBody.slice(0, 80)}\n`
    );
    totalPatched++;
  }

  writeFileSync(bundlePath, src, 'utf8');
}

if (totalSkipped > 0) {
  process.stderr.write(`[apply-platform-gate] WARNING: ${totalSkipped} gate(s) were skipped due to validation errors.\n`);
}

if (totalPatched === 0) {
  process.stderr.write('[apply-platform-gate] ERROR: No gates were patched (all entries were skipped).\n');
  process.exit(1);
}

process.stderr.write(`[apply-platform-gate] Done — ${totalPatched} gate(s) patched.\n`);
