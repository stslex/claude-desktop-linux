#!/usr/bin/env node
/**
 * fix-bundle-download.mjs
 *
 * Patches the claude-code bundle download function to allow downloads on Linux.
 *
 * The app checks process.platform (or a getHostPlatform() equivalent) before
 * fetching the claude-code binary bundle.  On unrecognised platforms the download
 * is skipped, leaving spawn() with nothing to run.
 *
 * Strategy:
 *   1. Parse the main bundle with acorn.
 *   2. Find functions that:
 *      - Reference string literals related to binary downloading:
 *        "claude-code", "download", "bundle", "getBinary", "sdk_prepare"
 *      - Contain a platform conditional ("darwin", "win32")
 *      - Are compact (likely a gate, not the whole orchestrator)
 *   3. For each match, prepend a Linux early-pass so the download proceeds.
 *
 * If the binary is already present at the expected location, the patch is
 * still applied (the download function should no-op if the binary exists).
 *
 * Usage:
 *   node patches/fix-bundle-download.mjs [--bundle <path>]
 *
 * Exit codes:
 *   0  Patch applied or no gate found (download may not be gated).
 *   1  Parse error or IO failure.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple, ancestor as walkAncestor } from 'acorn-walk';

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
  const appDir   = join(buildDir, 'app-extracted');
  bundlePath = join(appDir, '.vite', 'build', 'index.js');
}

if (!existsSync(bundlePath)) {
  process.stderr.write(`[fix-bundle-download] Bundle not found: ${bundlePath}\n`);
  process.exit(1);
}

const src = readFileSync(bundlePath, 'utf8');
process.stderr.write(`[fix-bundle-download] Parsing ${bundlePath} (${src.length} chars)...\n`);

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
    process.stderr.write(`[fix-bundle-download] Parse error: ${e.message}\n`);
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
    TemplateLiteral(n) {
      for (const q of n.quasis) {
        if (q.value && q.value.raw) out.add(q.value.raw);
      }
    },
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

// ---------------------------------------------------------------------------
// Score candidates — functions that gate binary downloads behind platform
// ---------------------------------------------------------------------------
const FUNC_TYPES = new Set([
  'FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration',
]);

/**
 * Score a function body for likelihood of being a download gate.
 *
 * Criteria:
 *   1. Contains "darwin" or "win32" string  (+2 each, max 4)
 *   2. Contains download-related strings    (+1 each, max 3)
 *   3. Has conditional logic                (+1)
 *   4. References process.platform          (+1)
 *   5. Is compact (< 2000 chars)            (+1)
 *
 * Max score: 10
 */
function scoreBody(body) {
  const strings = collectStrings(body);
  let score = 0;

  if (strings.has('darwin'))  score += 2;
  if (strings.has('win32'))   score += 2;

  const downloadHints = ['claude-code', 'download', 'bundle', 'getBinary',
                         'sdk_prepare', 'binary', 'fetch'];
  for (const hint of downloadHints) {
    for (const s of strings) {
      if (s.toLowerCase().includes(hint.toLowerCase())) { score++; break; }
    }
    if (score >= 7) break; // cap download hints at 3
  }

  if (hasConditional(body)) score++;

  // Check for process.platform reference
  let hasPlatformRef = false;
  simple(body, {
    MemberExpression(n) {
      if (n.object?.name === 'process' &&
          (n.property?.name === 'platform' || n.property?.value === 'platform')) {
        hasPlatformRef = true;
      }
    },
  });
  if (hasPlatformRef) score++;

  if ((body.end - body.start) < 2000) score++;

  return score;
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

  // Quick filter: must reference at least one platform string AND one download hint
  const hasPlatform = strings.has('darwin') || strings.has('win32');
  if (!hasPlatform) return;

  const downloadHints = ['claude-code', 'download', 'bundle', 'getBinary',
                         'sdk_prepare', 'binary'];
  const hasDownload = downloadHints.some(h => {
    for (const s of strings) {
      if (s.toLowerCase().includes(h.toLowerCase())) return true;
    }
    return false;
  });
  if (!hasDownload) return;

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
    '[fix-bundle-download] No download gate function found.\n' +
    '  This may mean the download is not platform-gated, or the pattern changed.\n' +
    '  Proceeding without patching (download may still work via header spoofing).\n'
  );
  // Exit 0 — not finding a gate is acceptable (header spoofing may suffice)
  process.exit(0);
}

process.stderr.write(`[fix-bundle-download] Found ${candidates.length} candidate(s):\n`);
for (const c of candidates.slice(0, 5)) {
  process.stderr.write(`  score=${c.score}  [${c.start}..${c.end}]  ${c.preview}\n`);
}

// Threshold: at least score 5 to be confident
const THRESHOLD = 5;
const matches = candidates.filter(c => c.score >= THRESHOLD);

if (matches.length === 0) {
  process.stderr.write(
    `[fix-bundle-download] Best score ${candidates[0].score} below threshold ${THRESHOLD}.\n` +
    '  Skipping patch — download may still work via header spoofing.\n'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply patch — prepend Linux platform allowance in each matched function
// ---------------------------------------------------------------------------
// We patch from highest offset first so earlier offsets remain valid.
matches.sort((a, b) => b.start - a.start);

let patched = src;
let patchCount = 0;

for (const match of matches) {
  if (patched[match.start] !== '{') {
    process.stderr.write(
      `[fix-bundle-download] Range [${match.start}..${match.end}] ` +
      `does not start with '{' — skipping.\n`
    );
    continue;
  }

  // Insert a platform alias right after the opening brace:
  // On Linux, spoof process.platform as "darwin" within this function scope
  // so the existing platform checks pass.
  const PATCH = 'const __origPlatform=process.platform;Object.defineProperty(process,"platform",{value:"darwin",configurable:true});try{';
  const SUFFIX = '}finally{Object.defineProperty(process,"platform",{value:__origPlatform,configurable:true});}';

  const body = patched.slice(match.start, match.end);
  const patchedBody = '{' + PATCH + body.slice(1, -1) + SUFFIX + '}';

  patched = patched.slice(0, match.start) + patchedBody + patched.slice(match.end);
  patchCount++;

  process.stderr.write(
    `[fix-bundle-download] Patched function at [${match.start}..${match.end}] (score=${match.score})\n`
  );
}

if (patchCount === 0) {
  process.stderr.write('[fix-bundle-download] No functions patched.\n');
  process.exit(0);
}

writeFileSync(bundlePath, patched, 'utf8');
process.stderr.write(`[fix-bundle-download] Done — ${patchCount} function(s) patched in ${bundlePath}.\n`);
