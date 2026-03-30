#!/usr/bin/env node
/**
 * apply-vm-download.mjs
 *
 * Patches the VM download step function to return early on Linux.
 *
 * On macOS, the VM download step fetches a real VM binary (rootfs).  On Linux,
 * there is no VM — claude-swift.js stubs the VM interface and runs processes
 * directly.  This patch makes the download step a no-op on Linux so the VM
 * orchestrator proceeds to the next step (where our claude-swift stub signals
 * readiness).
 *
 * Usage:
 *   node patches/apply-vm-download.mjs [--input <vm-download-location.json>]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args     = process.argv.slice(2);
let inputPath  = null;
const inputIdx = args.indexOf('--input');
if (inputIdx !== -1 && inputIdx + 1 < args.length) {
  inputPath = args[inputIdx + 1];
}
if (!inputPath) {
  inputPath = process.env.BUILD_DIR
    ? join(process.env.BUILD_DIR, 'vm-download-location.json')
    : './vm-download-location.json';
}

// ---------------------------------------------------------------------------
// Load location JSON
// ---------------------------------------------------------------------------
let location;
try {
  if (!existsSync(inputPath)) {
    process.stderr.write(`[apply-vm-download] File not found: ${inputPath}\n`);
    process.exit(1);
  }
  location = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (e) {
  process.stderr.write(`[apply-vm-download] Cannot read/parse ${inputPath}: ${e.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------
if (!location.file || location.start == null || location.end == null) {
  process.stderr.write('[apply-vm-download] Invalid location data.\n');
  process.exit(1);
}

const bundlePath = location.file;
let src = readFileSync(bundlePath, 'utf8');

if (src[location.start] !== '{' || src[location.end - 1] !== '}') {
  process.stderr.write(
    `[apply-vm-download] Range [${location.start}..${location.end}] ` +
    `does not look like a block statement.\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Patch — prepend a Linux early-return inside the function body
// ---------------------------------------------------------------------------
// Insert right after the opening brace.
const LINUX_RETURN = 'if(process.platform==="linux")return;';

const originalBody = src.slice(location.start, location.end);
const patchedBody = '{' + LINUX_RETURN + originalBody.slice(1);

process.stderr.write(
  `[apply-vm-download] Patching download step [${location.start}..${location.end}]\n`
);

src = src.slice(0, location.start) + patchedBody + src.slice(location.end);

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
writeFileSync(bundlePath, src, 'utf8');
process.stderr.write(`[apply-vm-download] Done — ${bundlePath} patched.\n`);
