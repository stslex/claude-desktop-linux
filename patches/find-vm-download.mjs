#!/usr/bin/env node
/**
 * find-vm-download.mjs
 *
 * Locates the VM download step function ("download_and_sdk_prepare") in the
 * minified bundle so apply-vm-download.mjs can prepend a Linux early-return.
 *
 * Strategy:
 *   1. Find the string literal "download_and_sdk_prepare" in the AST.
 *   2. Walk ancestors to find the nearest enclosing function (the step
 *      callback or orchestrator function).
 *   3. Record the function body location so the apply script can patch it.
 *
 * Output: $BUILD_DIR/vm-download-location.json
 *   { file, start, end }
 *
 * Usage:
 *   node patches/find-vm-download.mjs [--bundle <path>]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { ancestor as walkAncestor } from 'acorn-walk';

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
  process.stderr.write(`[find-vm-download] Bundle not found: ${bundlePath}\n`);
  process.exit(1);
}

const src = readFileSync(bundlePath, 'utf8');
process.stderr.write(`[find-vm-download] Parsing ${bundlePath} (${src.length} chars)...\n`);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
let ast;
try {
  ast = parse(src, { ecmaVersion: 2022, sourceType: 'script' });
} catch (e) {
  process.stderr.write(`[find-vm-download] Parse error: ${e.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Walk — find "download_and_sdk_prepare" and its enclosing function body
// ---------------------------------------------------------------------------
const FUNC_TYPES = new Set([
  'FunctionExpression',
  'ArrowFunctionExpression',
  'FunctionDeclaration',
]);

let result = null;

walkAncestor(ast, {
  Literal(node, _state, ancestors) {
    if (result) return; // take the first match
    if (node.value !== 'download_and_sdk_prepare') return;

    process.stderr.write(
      `[find-vm-download] Found "download_and_sdk_prepare" at offset ${node.start}\n`
    );

    // Walk ancestors from innermost to outermost, looking for the enclosing
    // function.  Skip the innermost function if it's tiny (likely just a
    // callback wrapper) and prefer the next one up — the step implementation.
    const funcAncestors = [];
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (FUNC_TYPES.has(ancestors[i].type)) {
        funcAncestors.push(ancestors[i]);
      }
    }

    if (funcAncestors.length === 0) {
      process.stderr.write('[find-vm-download] No enclosing function found.\n');
      return;
    }

    // Pick the best candidate:
    // - If there are multiple enclosing functions, pick the innermost one
    //   that has a block statement body (not a concise arrow).
    let target = null;
    for (const fn of funcAncestors) {
      const body = fn.body;
      if (body && body.type === 'BlockStatement') {
        target = fn;
        break;
      }
    }

    if (!target) {
      // Fall back to the outermost function with any body
      target = funcAncestors[funcAncestors.length - 1];
    }

    const body = target.body;
    if (body && body.type === 'BlockStatement') {
      result = { start: body.start, end: body.end };
      const preview = src.slice(body.start, Math.min(body.start + 120, body.end));
      process.stderr.write(
        `[find-vm-download] Enclosing function body: [${body.start}..${body.end}]\n`
      );
      process.stderr.write(`  preview: ${preview.replace(/\n/g, ' ')}\n`);
    } else {
      process.stderr.write('[find-vm-download] Enclosing function has no BlockStatement body.\n');
    }
  },
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (!result) {
  process.stderr.write('[find-vm-download] "download_and_sdk_prepare" not found in bundle.\n');
  process.exit(1);
}

const buildDir = process.env.BUILD_DIR || '/tmp/claude-build';
const outPath  = join(buildDir, 'vm-download-location.json');
const output   = { file: bundlePath, ...result };
writeFileSync(outPath, JSON.stringify(output, null, 2));
process.stderr.write(`[find-vm-download] Written to ${outPath}\n`);
