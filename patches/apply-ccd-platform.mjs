#!/usr/bin/env node
/**
 * apply-ccd-platform.mjs
 *
 * Patches the CCD (Claude Code Desktop) binary manager in the minified bundle
 * to add Linux support:
 *
 *  1. getHostPlatform — adds "linux-x64" and "linux-arm64" return paths so the
 *     function no longer throws "Unsupported platform: linux-x64".
 *
 *  2. getBinaryPathIfReady — prepends a Linux fast-path that looks for the
 *     `claude` or `claude-code` binary already on PATH (e.g. from the npm
 *     global install of @anthropic/claude-code).  If found it is returned
 *     immediately, bypassing the download/checksum logic that only knows about
 *     macOS binaries.
 *
 * Usage:
 *   node patches/apply-ccd-platform.mjs [--input <ccd-platform-location.json>]
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
    ? join(process.env.BUILD_DIR, 'ccd-platform-location.json')
    : './ccd-platform-location.json';
}

// ---------------------------------------------------------------------------
// Load location JSON
// ---------------------------------------------------------------------------
let locations;
try {
  if (!existsSync(inputPath)) {
    process.stderr.write(`[apply-ccd-platform] File not found: ${inputPath}\n`);
    process.exit(1);
  }
  locations = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (e) {
  process.stderr.write(`[apply-ccd-platform] Cannot read/parse ${inputPath}: ${e.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate — at minimum we need getHostPlatform
// ---------------------------------------------------------------------------
if (!locations.getHostPlatform) {
  process.stderr.write('[apply-ccd-platform] getHostPlatform location missing — cannot patch.\n');
  process.exit(1);
}

// Both patches operate on the same file.
const bundlePath = locations.getHostPlatform.file;
let src = readFileSync(bundlePath, 'utf8');

// ---------------------------------------------------------------------------
// Patch 1 — getHostPlatform: add linux-x64 and linux-arm64
// ---------------------------------------------------------------------------
const GP = locations.getHostPlatform;
if (src[GP.start] !== '{' || src[GP.end - 1] !== '}') {
  process.stderr.write(
    `[apply-ccd-platform] getHostPlatform range [${GP.start}..${GP.end}] ` +
    `does not look like a block statement.\n`
  );
  process.exit(1);
}

const GP_REPLACEMENT =
  '{' +
  'if(process.platform==="darwin"&&process.arch==="x64")return"darwin-x64";' +
  'if(process.platform==="darwin"&&process.arch==="arm64")return"darwin-arm64";' +
  'if(process.platform==="linux"&&process.arch==="x64")return"linux-x64";' +
  'if(process.platform==="linux"&&process.arch==="arm64")return"linux-arm64";' +
  'throw new Error("Unsupported platform: "+process.platform+"-"+process.arch)' +
  '}';

process.stderr.write(`[apply-ccd-platform] Patching getHostPlatform [${GP.start}..${GP.end}]\n`);
process.stderr.write(`  Original (first 100): ${src.slice(GP.start, GP.start + 100)}\n`);

src = src.slice(0, GP.start) + GP_REPLACEMENT + src.slice(GP.end);

// ---------------------------------------------------------------------------
// Patch 2 — getBinaryPathIfReady: prepend Linux PATH fallback
// ---------------------------------------------------------------------------
// After patch 1 the offsets have shifted.  Re-calculate using the delta.
if (locations.getBinaryPathIfReady) {
  const delta = GP_REPLACEMENT.length - (GP.end - GP.start);
  const BPAR  = locations.getBinaryPathIfReady;

  // Adjust for the shift introduced by patch 1 (getBinaryPathIfReady comes
  // after getHostPlatform in the file, so add the delta).
  const adjStart = BPAR.start + (BPAR.start > GP.start ? delta : 0);
  const adjEnd   = BPAR.end   + (BPAR.end   > GP.start ? delta : 0);

  if (src[adjStart] !== '{' || src[adjEnd - 1] !== '}') {
    process.stderr.write(
      `[apply-ccd-platform] getBinaryPathIfReady range [${adjStart}..${adjEnd}] ` +
      `does not look like a block statement — skipping this patch.\n`
    );
  } else {
    // Prepend a Linux fast-path that returns the system claude binary from PATH.
    // child_process and fs are always available in the main process.
    const LINUX_PATH_PROBE =
      'if(process.platform==="linux"){' +
        'try{' +
          'const{execSync:__ex}=require("child_process");' +
          'const{existsSync:__ex2}=require("fs");' +
          'for(const __b of["claude","claude-code"]){' +
            'try{' +
              'const __p=__ex("which "+__b+" 2>/dev/null",{stdio:"pipe",encoding:"utf8"}).trim();' +
              'if(__p&&__ex2(__p))return __p;' +
            '}catch(__e2){}' +
          '}' +
        '}catch(__e){}' +
      '}';

    const originalBody = src.slice(adjStart, adjEnd);
    // Insert the probe right after the opening brace.
    const BPAR_REPLACEMENT = '{' + LINUX_PATH_PROBE + originalBody.slice(1);

    process.stderr.write(
      `[apply-ccd-platform] Patching getBinaryPathIfReady [${adjStart}..${adjEnd}]\n`
    );

    src = src.slice(0, adjStart) + BPAR_REPLACEMENT + src.slice(adjEnd);
  }
} else {
  process.stderr.write(
    '[apply-ccd-platform] getBinaryPathIfReady not in location JSON — skipping patch 2.\n'
  );
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
writeFileSync(bundlePath, src, 'utf8');
process.stderr.write(`[apply-ccd-platform] Done — ${bundlePath} patched.\n`);
