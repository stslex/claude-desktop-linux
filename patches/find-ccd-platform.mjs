#!/usr/bin/env node
/**
 * find-ccd-platform.mjs
 *
 * Locates the getHostPlatform and getBinaryPathIfReady method bodies in the
 * minified app bundle so apply-ccd-platform.mjs can splice in Linux support.
 *
 * Searches by method name (property names are NOT mangled by minifiers), so
 * this is version-resilient as long as Anthropic keeps these method names.
 *
 * Output: $BUILD_DIR/ccd-platform-location.json
 *   { getHostPlatform: { file, start, end },
 *     getBinaryPathIfReady: { file, start, end } }
 *
 * Usage:
 *   node patches/find-ccd-platform.mjs [--bundle <path>]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple as walkSimple } from 'acorn-walk';

// ---------------------------------------------------------------------------
// Resolve bundle path(s)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let explicitBundle = null;
const bundleIdx = args.indexOf('--bundle');
if (bundleIdx !== -1 && bundleIdx + 1 < args.length) {
  explicitBundle = args[bundleIdx + 1];
}

const buildDir = process.env.BUILD_DIR || '/tmp/claude-build';
const appDir   = join(buildDir, 'app-extracted');
const viteBuildDir = join(appDir, '.vite', 'build');

// ---------------------------------------------------------------------------
// Recursively collect .js files (same pattern as find-platform-gate.mjs)
// ---------------------------------------------------------------------------
function findJsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`[find-ccd-platform] Warning: cannot read directory ${dir}: ${err.message}\n`);
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Parse helper — try module then script (matches find-platform-gate.mjs)
// ---------------------------------------------------------------------------
function tryParse(src, filePath) {
  try {
    return parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    try {
      return parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReserved: true });
    } catch (e) {
      process.stderr.write(`[find-ccd-platform] Warning: skipping ${filePath}: ${e.message}\n`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Walk a single file — collect method bodies by name
// ---------------------------------------------------------------------------
const TARGETS = ['getHostPlatform', 'getBinaryPathIfReady'];
const found   = {};

function recordMethod(keyName, valueNode, filePath) {
  if (!TARGETS.includes(keyName)) return;
  if (found[keyName]) return; // take the first occurrence
  const body = valueNode.body ?? valueNode; // FunctionExpression → .body is BlockStatement
  if (body && body.type === 'BlockStatement') {
    found[keyName] = { file: filePath, start: body.start, end: body.end };
  }
}

function scanFile(filePath) {
  let src;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`[find-ccd-platform] Warning: cannot read ${filePath}: ${err.message}\n`);
    return;
  }

  process.stderr.write(`[find-ccd-platform] Parsing ${filePath} (${src.length} chars)...\n`);

  const ast = tryParse(src, filePath);
  if (!ast) return;

  walkSimple(ast, {
    // class Foo { getHostPlatform() { ... } }
    MethodDefinition(node) {
      const key = node.key;
      if (key && (key.name || key.value)) {
        recordMethod(key.name ?? key.value, node.value, filePath);
      }
    },
    // { getHostPlatform: function() { ... } }  or  { getHostPlatform() { ... } }
    Property(node) {
      const key = node.key;
      if (key && (key.name || key.value)) {
        recordMethod(key.name ?? key.value, node.value, filePath);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Search strategy:
//   1. If --bundle given explicitly, scan only that file.
//   2. Otherwise try .vite/build/index.js first (fast path).
//   3. If getHostPlatform not found, fall back to recursive scan.
// ---------------------------------------------------------------------------
if (explicitBundle) {
  if (!existsSync(explicitBundle)) {
    process.stderr.write(`[find-ccd-platform] Bundle not found: ${explicitBundle}\n`);
    process.exit(1);
  }
  scanFile(explicitBundle);
} else {
  const indexJs = join(viteBuildDir, 'index.js');
  if (existsSync(indexJs)) {
    scanFile(indexJs);
  }

  if (!found.getHostPlatform) {
    process.stderr.write(
      `[find-ccd-platform] getHostPlatform not in index.js — scanning all .js files in ${viteBuildDir}\n`
    );
    const jsFiles = findJsFiles(viteBuildDir);
    // Skip index.js (already scanned) and scan the rest
    for (const f of jsFiles) {
      if (f === indexJs) continue;
      scanFile(f);
      // Stop early once both targets are found
      if (TARGETS.every(t => found[t])) break;
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const missing = TARGETS.filter(t => !found[t]);
if (missing.length > 0) {
  process.stderr.write(`[find-ccd-platform] Methods not found: ${missing.join(', ')}\n`);
  // Non-fatal if at least getHostPlatform is found
  if (!found.getHostPlatform) process.exit(1);
}

const output = {};
for (const [name, loc] of Object.entries(found)) {
  output[name] = loc; // already has { file, start, end }
  const fileSrc = readFileSync(loc.file, 'utf8');
  const preview = fileSrc.slice(loc.start, Math.min(loc.start + 120, loc.end));
  process.stderr.write(`[find-ccd-platform] ${name}: ${loc.file} [${loc.start}..${loc.end}]\n`);
  process.stderr.write(`  preview: ${preview.replace(/\n/g, ' ')}\n`);
}

const outPath = join(buildDir, 'ccd-platform-location.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
process.stderr.write(`[find-ccd-platform] Written to ${outPath}\n`);
