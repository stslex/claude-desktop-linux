#!/usr/bin/env node
/**
 * find-platform-gate.mjs
 *
 * Locate the Cowork platform-gate function inside the minified
 * .vite/build/index.js bundle using the acorn AST parser.
 *
 * Usage:
 *   node find-platform-gate.mjs <bundle.js>
 *   node find-platform-gate.mjs <bundle.js> --dump-candidates
 *
 * Stdout (JSON) on success:
 *   { "bodyStart": <charOffset>, "bodyEnd": <charOffset> }
 *
 * Exit 1 on failure (pattern not found or score below threshold).
 */

import { readFileSync } from 'fs';
import { parse }        from 'acorn';
import { simple }       from 'acorn-walk';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args         = process.argv.slice(2);
const dumpAll      = args.includes('--dump-candidates');
const bundlePath   = args.find(a => !a.startsWith('--'));

if (!bundlePath) {
  process.stderr.write('Usage: find-platform-gate.mjs <bundle.js> [--dump-candidates]\n');
  process.exit(1);
}

const src = readFileSync(bundlePath, 'utf8');

// ---------------------------------------------------------------------------
// Scoring criteria
//
// The target function (pre-minification) looks like:
//
//   function isCoworkSupported() {
//     const platform = getPlatform()
//     if (platform === 'darwin') return { status: 'supported' }
//     if (platform === 'win32')  return { status: 'supported' }
//     return { status: 'unsupported' }
//   }
//
// After minification the name changes; string literals are stable.
// We score each function/arrow on five criteria (1 pt each):
//
//   1. Contains a ReturnStatement whose argument is { status: "supported" }
//   2. Contains a ReturnStatement whose argument is { status: "unsupported" }
//   3. Contains the string literal "darwin"
//   4. Contains the string literal "win32"
//   5. The only return values are objects with a "status" key
//
// All five must match (score === MAX_SCORE).
// ---------------------------------------------------------------------------
const MAX_SCORE = 5;

/**
 * Collect all literal string values inside a subtree.
 * @param {import('acorn').Node} node
 * @returns {Set<string>}
 */
function collectStrings(node) {
  const strings = new Set();
  simple(node, {
    Literal(n) {
      if (typeof n.value === 'string') strings.add(n.value);
    },
  });
  return strings;
}

/**
 * Return true if node is an ObjectExpression { status: <string> }.
 * @param {import('acorn').Node|null|undefined} node
 * @param {string} value  Expected value of the status property.
 */
function isStatusObject(node, value) {
  return (
    node &&
    node.type === 'ObjectExpression' &&
    node.properties.length === 1 &&
    node.properties[0].key &&
    (node.properties[0].key.name === 'status' || node.properties[0].key.value === 'status') &&
    node.properties[0].value &&
    node.properties[0].value.value === value
  );
}

/**
 * Collect all ReturnStatement argument nodes in a subtree.
 * @param {import('acorn').Node} node
 * @returns {Array<import('acorn').Node|null>}
 */
function collectReturnValues(node) {
  const vals = [];
  simple(node, {
    ReturnStatement(n) { vals.push(n.argument); },
  });
  return vals;
}

/**
 * Score a function body node.
 * @param {import('acorn').Node} body
 * @returns {number}
 */
function scoreBody(body) {
  let score = 0;
  const strings   = collectStrings(body);
  const returns   = collectReturnValues(body);

  const hasSupported   = returns.some(r => isStatusObject(r, 'supported'));
  const hasUnsupported = returns.some(r => isStatusObject(r, 'unsupported'));
  const onlyStatus     = returns.length > 0 &&
    returns.every(r => r === null || isStatusObject(r, 'supported') || isStatusObject(r, 'unsupported'));

  if (hasSupported)   score++;
  if (hasUnsupported) score++;
  if (strings.has('darwin')) score++;
  if (strings.has('win32'))  score++;
  if (onlyStatus)     score++;

  return score;
}

// ---------------------------------------------------------------------------
// AST walk — collect candidate functions with their body offsets.
// ---------------------------------------------------------------------------
let ast;
try {
  ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
} catch (err) {
  process.stderr.write(`[find-platform-gate] Parse error: ${err.message}\n`);
  process.exit(1);
}

/** @type {Array<{ score: number, bodyStart: number, bodyEnd: number, snippet: string }>} */
const candidates = [];

function checkFunction(node) {
  const body = node.body;
  if (!body || body.type !== 'BlockStatement') return;
  const score = scoreBody(body);
  if (score > 0) {
    candidates.push({
      score,
      bodyStart: body.start,
      bodyEnd:   body.end,
      snippet:   src.slice(node.start, Math.min(node.start + 120, node.end)).replace(/\n/g, ' '),
    });
  }
}

simple(ast, {
  FunctionDeclaration:  checkFunction,
  FunctionExpression:   checkFunction,
  ArrowFunctionExpression: checkFunction,
});

// Sort best-first.
candidates.sort((a, b) => b.score - a.score);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
if (dumpAll) {
  process.stderr.write('\n--- Platform-gate candidates ---\n');
  for (const c of candidates) {
    process.stderr.write(`score=${c.score}/${MAX_SCORE}  body=[${c.bodyStart}..${c.bodyEnd}]\n  ${c.snippet}\n\n`);
  }
}

const best = candidates[0];

if (!best || best.score < MAX_SCORE) {
  process.stderr.write(
    `[find-platform-gate] ERROR: No function matched all ${MAX_SCORE} criteria.\n` +
    `  Best score: ${best ? best.score : 0}/${MAX_SCORE}\n` +
    `  Re-run with --dump-candidates to inspect partial matches.\n` +
    `  This usually means a new Claude Desktop release changed the gate function shape.\n` +
    `  See CLAUDE.md § "Updating After a Claude Desktop Release".\n`
  );
  process.exit(1);
}

process.stdout.write(JSON.stringify({ bodyStart: best.bodyStart, bodyEnd: best.bodyEnd }) + '\n');
