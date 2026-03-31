#!/usr/bin/env node
/**
 * fix-dispatch-gate.mjs
 *
 * Finds and patches a Dispatch-specific availability gate function (if one
 * exists separately from the Cowork gate).
 *
 * In many Claude Desktop versions, Dispatch shares the same platform gate as
 * Cowork — both are caught by find-platform-gate.mjs with --all.  If a
 * separate Dispatch gate exists, this script patches it to return the
 * "available"/"supported" state on Linux.
 *
 * Signature to look for:
 *   - Function that checks platform ("darwin" / "win32")
 *   - References Dispatch-related strings ("dispatch", "notification",
 *     "push", "token")
 *   - Returns an availability/status object
 *   - Compact (< 500 chars)
 *
 * If no separate gate is found: exit 0 with a message (this is expected —
 * the shared gate or platform-override.js covers Dispatch).
 *
 * Usage:
 *   node patches/fix-dispatch-gate.mjs [--bundle <path>]
 *
 * Exit codes:
 *   0  Patch applied, or no separate Dispatch gate found (both OK).
 *   1  Parse or IO error.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let bundlePath = null;
const bundleIdx = args.indexOf('--bundle');
if (bundleIdx !== -1 && bundleIdx + 1 < args.length) {
  bundlePath = args[bundleIdx + 1];
}

if (!bundlePath) {
  const buildDir = process.env.BUILD_DIR || '/tmp/claude-build';
  bundlePath = join(buildDir, 'app-extracted', '.vite', 'build', 'index.js');
}

if (!existsSync(bundlePath)) {
  process.stderr.write(`[fix-dispatch-gate] Bundle not found: ${bundlePath}\n`);
  process.exit(1);
}

const src = readFileSync(bundlePath, 'utf8');
process.stderr.write(`[fix-dispatch-gate] Parsing ${bundlePath} (${src.length} chars)...\n`);

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
    process.stderr.write(`[fix-dispatch-gate] Parse error: ${e.message}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function collectStrings(node) {
  const out = new Set();
  simple(node, {
    Literal(n) { if (typeof n.value === 'string') out.add(n.value); },
  });
  return out;
}

function hasConditional(node) {
  let found = false;
  simple(node, {
    IfStatement()           { found = true; },
    ConditionalExpression() { found = true; },
    SwitchStatement()       { found = true; },
  });
  return found;
}

function hasStatusObject(node) {
  let found = false;
  simple(node, {
    ObjectExpression(n) {
      if (n.properties.some(p => (p.key?.name ?? p.key?.value) === 'status')) {
        found = true;
      }
    },
  });
  return found;
}

// ---------------------------------------------------------------------------
// Score candidates
// ---------------------------------------------------------------------------
const DISPATCH_HINTS = ['dispatch', 'notification', 'push', 'token', 'apns', 'fcm'];

function scoreBody(body) {
  const strings = collectStrings(body);
  let score = 0;

  // +2: platform conditional
  if (strings.has('darwin'))  score++;
  if (strings.has('win32'))   score++;

  // +3: dispatch-related strings (max 3)
  let dispatchScore = 0;
  for (const hint of DISPATCH_HINTS) {
    for (const s of strings) {
      if (s.toLowerCase().includes(hint)) { dispatchScore++; break; }
    }
    if (dispatchScore >= 3) break;
  }
  score += dispatchScore;

  // +1: conditional logic
  if (hasConditional(body)) score++;

  // +1: returns status object
  if (hasStatusObject(body)) score++;

  // +1: compact
  if ((body.end - body.start) < 500) score++;

  return score;  // max 8
}

// ---------------------------------------------------------------------------
// Walk and collect candidates
// ---------------------------------------------------------------------------
const candidates = [];

simple(ast, {
  FunctionDeclaration: checkFunc,
  FunctionExpression: checkFunc,
  ArrowFunctionExpression: checkFunc,
});

function checkFunc(node) {
  const body = node.body;
  if (!body || body.type !== 'BlockStatement') return;

  const strings = collectStrings(body);

  // Quick filter: must have a platform string AND a dispatch hint
  const hasPlatform = strings.has('darwin') || strings.has('win32');
  if (!hasPlatform) return;

  const hasDispatch = DISPATCH_HINTS.some(h => {
    for (const s of strings) {
      if (s.toLowerCase().includes(h)) return true;
    }
    return false;
  });
  if (!hasDispatch) return;

  const score = scoreBody(body);
  candidates.push({
    start: body.start,
    end:   body.end,
    score,
    preview: src.slice(node.start, Math.min(node.start + 120, node.end)).replace(/\n/g, ' '),
  });
}

candidates.sort((a, b) => b.score - a.score);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (candidates.length === 0) {
  process.stderr.write(
    '[fix-dispatch-gate] No separate Dispatch gate function found.\n' +
    '  This is expected — Dispatch likely shares the Cowork gate (already patched\n' +
    '  by find-platform-gate.mjs) or is handled by platform-override.js at runtime.\n'
  );
  process.exit(0);
}

process.stderr.write(`[fix-dispatch-gate] Found ${candidates.length} candidate(s):\n`);
for (const c of candidates.slice(0, 5)) {
  process.stderr.write(`  score=${c.score}  [${c.start}..${c.end}]  ${c.preview}\n`);
}

const THRESHOLD = 5;
const matches = candidates.filter(c => c.score >= THRESHOLD);

if (matches.length === 0) {
  process.stderr.write(
    `[fix-dispatch-gate] Best score ${candidates[0].score} below threshold ${THRESHOLD}.\n` +
    '  No confident match — skipping patch (platform-override.js handles this at runtime).\n'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply patch — replace function body with unconditional success return
// ---------------------------------------------------------------------------
matches.sort((a, b) => b.start - a.start);

let patched = src;
let patchCount = 0;

for (const match of matches) {
  if (patched[match.start] !== '{') {
    process.stderr.write(
      `[fix-dispatch-gate] Range [${match.start}..${match.end}] ` +
      `does not start with '{' — skipping.\n`
    );
    continue;
  }

  const replacement = '{return{status:"supported",supported:true}}';
  patched = patched.slice(0, match.start) + replacement + patched.slice(match.end);
  patchCount++;

  process.stderr.write(
    `[fix-dispatch-gate] Patched function at [${match.start}..${match.end}] (score=${match.score})\n`
  );
}

if (patchCount === 0) {
  process.stderr.write('[fix-dispatch-gate] No functions patched.\n');
  process.exit(0);
}

writeFileSync(bundlePath, patched, 'utf8');
process.stderr.write(`[fix-dispatch-gate] Done — ${patchCount} function(s) patched in ${bundlePath}.\n`);
