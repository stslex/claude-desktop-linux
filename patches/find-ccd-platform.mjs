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

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple as walkSimple } from 'acorn-walk';

// ---------------------------------------------------------------------------
// Resolve bundle path
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let bundlePath = null;
const bundleIdx = args.indexOf('--bundle');
if (bundleIdx !== -1 && bundleIdx + 1 < args.length) {
  bundlePath = args[bundleIdx + 1];
}

if (!bundlePath) {
  const buildDir = process.env.BUILD_DIR || '/tmp/claude-build';
  const appDir   = join(buildDir, 'app-extracted');
  bundlePath = join(appDir, '.vite', 'build', 'index.js');
}

if (!existsSync(bundlePath)) {
  process.stderr.write(`[find-ccd-platform] Bundle not found: ${bundlePath}\n`);
  process.exit(1);
}

const src = readFileSync(bundlePath, 'utf8');
process.stderr.write(`[find-ccd-platform] Parsing ${bundlePath} (${src.length} chars)...\n`);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
let ast;
try {
  ast = parse(src, { ecmaVersion: 2022, sourceType: 'script' });
} catch (e) {
  process.stderr.write(`[find-ccd-platform] Parse error: ${e.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Walk — collect method bodies by name
// ---------------------------------------------------------------------------
const TARGETS = ['getHostPlatform', 'getBinaryPathIfReady'];
const found   = {};

function recordMethod(keyName, valueNode) {
  if (!TARGETS.includes(keyName)) return;
  if (found[keyName]) return; // take the first occurrence
  const body = valueNode.body ?? valueNode; // FunctionExpression → .body is BlockStatement
  if (body && body.type === 'BlockStatement') {
    found[keyName] = { start: body.start, end: body.end };
  }
}

walkSimple(ast, {
  // class Foo { getHostPlatform() { ... } }
  MethodDefinition(node) {
    const key = node.key;
    if (key && (key.name || key.value)) {
      recordMethod(key.name ?? key.value, node.value);
    }
  },
  // { getHostPlatform: function() { ... } }  or  { getHostPlatform() { ... } }
  Property(node) {
    const key = node.key;
    if (key && (key.name || key.value)) {
      recordMethod(key.name ?? key.value, node.value);
    }
  },
});

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
  output[name] = { file: bundlePath, ...loc };
  const preview = src.slice(loc.start, Math.min(loc.start + 120, loc.end));
  process.stderr.write(`[find-ccd-platform] ${name}: [${loc.start}..${loc.end}]\n`);
  process.stderr.write(`  preview: ${preview.replace(/\n/g, ' ')}\n`);
}

const buildDir = process.env.BUILD_DIR || '/tmp/claude-build';
const outPath  = join(buildDir, 'ccd-platform-location.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
process.stderr.write(`[find-ccd-platform] Written to ${outPath}\n`);
