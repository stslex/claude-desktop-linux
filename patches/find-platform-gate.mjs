#!/usr/bin/env node
/**
 * find-platform-gate.mjs
 *
 * Locate the Cowork platform-gate function inside the minified .vite/build/
 * bundle by recursively scanning a directory and using the acorn AST parser.
 *
 * Usage:
 *   node find-platform-gate.mjs <build-dir> [--output <path>] [--dump-candidates]
 *
 *   <build-dir>   Directory to scan (e.g. .vite/build/)
 *   --output      Where to write gate-location.json
 *                 Default: $BUILD_DIR/gate-location.json, or ./gate-location.json
 *   --dump-candidates  Print all scored candidates to stderr regardless of outcome
 *
 * Stdout (JSON) on success:
 *   { "file": "...", "start": N, "end": N, "score": 5, "preview": "..." }
 *
 *   start/end are character offsets of the matched function *body* (BlockStatement).
 *   Pass them directly to apply-platform-gate.mjs.
 *
 * Exit codes:
 *   0  Exactly one max-score candidate found.
 *   1  No match, ambiguous match, or parse/IO error.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, join }                            from 'path';
import { parse }                                    from 'acorn';
import { simple }                                   from 'acorn-walk';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const dumpAll = rawArgs.includes('--dump-candidates');
// --all: output every match above threshold, not just the single best
const outputAll = rawArgs.includes('--all');

// --output <path>
let outputPath = null;
const outputIdx = rawArgs.indexOf('--output');
if (outputIdx !== -1 && outputIdx + 1 < rawArgs.length) {
  outputPath = rawArgs[outputIdx + 1];
}

// Positional argument: build directory (first non-flag arg, not the --output value)
const skipIdx = new Set(outputIdx !== -1 ? [outputIdx, outputIdx + 1] : []);
const dirArg  = rawArgs.find((a, i) => !skipIdx.has(i) && !a.startsWith('--'));

if (!dirArg) {
  process.stderr.write(
    'Usage: find-platform-gate.mjs <build-dir> [--output <path>] [--dump-candidates]\n'
  );
  process.exit(1);
}

const buildDir = resolve(dirArg);

// Default output path: $BUILD_DIR env var → cwd
if (!outputPath) {
  outputPath = process.env.BUILD_DIR
    ? join(process.env.BUILD_DIR, 'gate-location.json')
    : join(process.cwd(), 'gate-location.json');
}

// ---------------------------------------------------------------------------
// Recursively collect .js files
// ---------------------------------------------------------------------------
function findJsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`[find-platform-gate] Warning: cannot read directory ${dir}: ${err.message}\n`);
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
// Scoring criteria  (7 points total, threshold = 4)
//
// Target (pre-minification):
//
//   function isCoworkSupported() {
//     const platform = getPlatform()       // stub returns "darwin"
//     if (platform === 'darwin') return { status: 'supported' }
//     if (platform === 'win32')  return { status: 'supported' }
//     return { status: 'unsupported' }
//   }
//
// After minification the name changes; string literals are stable.
// Some versions use "available"/"unavailable" instead of
// "supported"/"unsupported", and may include extra properties like
// { status: "unsupported", reason: ... }.
//
// Newer versions may:
//   - Drop "win32" and add "linux"
//   - Use different status strings (e.g. "enabled"/"disabled")
//   - Return an object with a platform display name
//
//   1.  Function body contains a conditional chain (if / ternary / switch)
//   2.  Function body references "darwin"
//   3.  Function body references "win32" OR "linux"          (platform literal)
//   4.  { status: "supported"|"available"|"enabled" }        (positive status)
//   5.  { status: "unsupported"|"unavailable"|"disabled" }   (negative status)
//   6.  Function body is compact (< 500 chars) — gate functions are small
//   7.  Function body references "platform" as a string OR calls getPlatform
// ---------------------------------------------------------------------------
const MAX_SCORE   = 7;
const THRESHOLD   = 4;  // Accept candidates scoring ≥ 4

/** Collect all string literal values in a subtree. */
function collectStrings(node) {
  const out = new Set();
  simple(node, {
    Literal(n) {
      if (typeof n.value === 'string') out.add(n.value);
    },
  });
  return out;
}

/** True if node is an ObjectExpression containing a status: <value> property. */
function isStatusObject(node, value) {
  if (!node || node.type !== 'ObjectExpression' || node.properties.length === 0) return false;
  return node.properties.some(prop => {
    const keyName = prop.key?.name ?? prop.key?.value;
    return keyName === 'status' && prop.value?.value === value;
  });
}

/**
 * True if any ObjectExpression { status: <value> } exists anywhere in the
 * subtree — covers both direct `return { status: "x" }` and the common
 * minified ternary form `return cond ? { status: "x" } : { status: "y" }`.
 */
function hasStatusValueAnywhere(node, value) {
  let found = false;
  simple(node, {
    ObjectExpression(n) {
      if (isStatusObject(n, value)) found = true;
    },
  });
  return found;
}

/**
 * True if any ObjectExpression has a property whose key is "status",
 * regardless of the value.  Catches renamed status strings we haven't seen.
 */
function hasAnyStatusProperty(node) {
  let found = false;
  simple(node, {
    ObjectExpression(n) {
      if (n.properties.some(p => (p.key?.name ?? p.key?.value) === 'status')) found = true;
    },
  });
  return found;
}

/**
 * True if the subtree contains at least one ReturnStatement (meaning the body
 * uses returns at all, not just falls off the end).
 */
function hasReturnStatement(node) {
  let found = false;
  simple(node, { ReturnStatement() { found = true; } });
  return found;
}

/** True if the subtree contains any conditional branching construct. */
function hasConditionalChain(node) {
  let found = false;
  simple(node, {
    IfStatement()          { found = true; },
    ConditionalExpression(){ found = true; },
    SwitchStatement()      { found = true; },
  });
  return found;
}

/** True if the subtree contains a call to a function whose name contains "platform" (case-insensitive). */
function callsPlatformFunction(node) {
  let found = false;
  simple(node, {
    CallExpression(n) {
      const callee = n.callee;
      const name = callee?.name || callee?.property?.name || '';
      if (/platform/i.test(name)) found = true;
    },
  });
  return found;
}

/** Score a BlockStatement body node 0-7. */
function scoreBody(body, src) {
  let score = 0;

  // criterion 1: conditional chain
  if (hasConditionalChain(body))                   score++;

  const strings = collectStrings(body);

  // criterion 2: "darwin" literal
  if (strings.has('darwin'))                       score++;

  // criterion 3: "win32" OR "linux" literal (newer versions may add linux)
  if (strings.has('win32') || strings.has('linux')) score++;

  // criterion 4: positive status object
  if (hasStatusValueAnywhere(body, 'supported') ||
      hasStatusValueAnywhere(body, 'available') ||
      hasStatusValueAnywhere(body, 'enabled'))     score++;

  // criterion 5: negative status object
  if (hasStatusValueAnywhere(body, 'unsupported') ||
      hasStatusValueAnywhere(body, 'unavailable') ||
      hasStatusValueAnywhere(body, 'disabled'))    score++;

  // criterion 6: compact body (gate functions are typically < 500 chars)
  const bodyLen = body.end - body.start;
  if (bodyLen > 0 && bodyLen < 500)                score++;

  // criterion 7: references "platform" string or calls a *platform* function
  if (strings.has('platform') ||
      callsPlatformFunction(body))                 score++;

  return score;
}

// ---------------------------------------------------------------------------
// Walk every .js file and collect scored candidates
// ---------------------------------------------------------------------------
const jsFiles = findJsFiles(buildDir);

if (jsFiles.length === 0) {
  process.stderr.write(`[find-platform-gate] No .js files found in ${buildDir}\n`);
  process.exit(1);
}

/**
 * @type {Array<{
 *   file:    string,
 *   score:   number,
 *   start:   number,
 *   end:     number,
 *   preview: string,
 * }>}
 */
const candidates = [];

for (const filePath of jsFiles) {
  let src;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`[find-platform-gate] Warning: cannot read ${filePath}: ${err.message}\n`);
    continue;
  }

  let ast;
  try {
    ast = parse(src, {
      ecmaVersion: 'latest',
      sourceType:  'module',
      onComment:   () => {},     // discard comments; satisfies the handler requirement
    });
  } catch {
    // Retry as script — some bundles use CJS syntax
    try {
      ast = parse(src, {
        ecmaVersion: 'latest',
        sourceType:  'script',
        onComment:   () => {},
        allowReserved: true,
      });
    } catch (err2) {
      process.stderr.write(`[find-platform-gate] Warning: skipping ${filePath}: ${err2.message}\n`);
      continue;
    }
  }

  function checkFunction(node) {
    const body = node.body;
    if (!body || body.type !== 'BlockStatement') return;

    const score = scoreBody(body, src);
    if (score === 0) return;

    candidates.push({
      file:    filePath,
      score,
      start:   body.start,
      end:     body.end,
      preview: src
        .slice(node.start, Math.min(node.start + 120, node.end))
        .replace(/\n/g, ' '),
    });
  }

  simple(ast, {
    FunctionDeclaration:     checkFunction,
    FunctionExpression:      checkFunction,
    ArrowFunctionExpression: checkFunction,
  });
}

// Best-first
candidates.sort((a, b) => b.score - a.score);

// ---------------------------------------------------------------------------
// --dump-candidates
// ---------------------------------------------------------------------------
if (dumpAll) {
  process.stderr.write(`\n--- Platform-gate candidates (${candidates.length} total) ---\n`);
  for (const c of candidates) {
    process.stderr.write(
      `score=${c.score}/${MAX_SCORE}  ${c.file}  body=[${c.start}..${c.end}]\n` +
      `  ${c.preview}\n\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Evaluate outcome — accept candidates scoring ≥ THRESHOLD
// ---------------------------------------------------------------------------
const topMatches = candidates.filter(c => c.score >= THRESHOLD);

// --- zero matches ---
if (topMatches.length === 0) {
  const best = candidates[0];
  process.stderr.write(
    '[find-platform-gate] ERROR: No platform gate function found.\n' +
    `  Threshold: ${THRESHOLD}/${MAX_SCORE}  Best score: ${best ? best.score : 0}/${MAX_SCORE}\n`
  );
  if (candidates.length > 0) {
    process.stderr.write('  Partial matches:\n');
    for (const c of candidates.slice(0, 10)) {
      process.stderr.write(
        `    score=${c.score}/${MAX_SCORE}  ${c.file}:[${c.start}..${c.end}]\n` +
        `      ${c.preview}\n`
      );
    }
  }
  process.stderr.write(
    '  Re-run with --dump-candidates to inspect all partial matches.\n' +
    '  See CLAUDE.md § "Updating After a Claude Desktop Release".\n'
  );
  process.exit(1);
}

// Sort: best score first, then shortest body within same score (most concise = most likely the gate)
topMatches.sort((a, b) => b.score - a.score || (a.end - a.start) - (b.end - b.start));

if (topMatches.length > 1) {
  if (outputAll) {
    process.stderr.write(
      `[find-platform-gate] ${topMatches.length} matches above threshold (${THRESHOLD}/${MAX_SCORE}); ` +
      `outputting all (--all mode).\n`
    );
  } else {
    process.stderr.write(
      `[find-platform-gate] ${topMatches.length} matches above threshold (${THRESHOLD}/${MAX_SCORE}); ` +
      `selecting best (score=${topMatches[0].score}, ${topMatches[0].end - topMatches[0].start} chars).\n`
    );
  }
  for (const c of topMatches.slice(0, 5)) {
    process.stderr.write(
      `  score=${c.score}/${MAX_SCORE}  ${c.end - c.start} chars  ${c.file}:[${c.start}..${c.end}]  ${c.preview}\n`
    );
  }
}

// --- Build output ---
let result;
if (outputAll) {
  // --all mode: output every match above threshold so apply-platform-gate can patch all of them.
  // This is important when Cowork and Dispatch have separate gate functions in the same bundle.
  // Deduplicate overlapping ranges: if one candidate is nested inside another
  // (e.g. a gate function inside a module wrapper that also scores above
  // threshold), keep only the more specific (shorter) one.  This prevents
  // apply-platform-gate from aborting on overlapping ranges.
  const deduped = [];
  for (const c of topMatches) {
    // Check if this candidate is a superset of an already-kept candidate
    const containsExisting = deduped.some(
      d => d.file === c.file && c.start <= d.start && c.end >= d.end
    );
    if (containsExisting) {
      // c is an outer function that contains a more-specific match — skip it
      continue;
    }
    // Check if an already-kept candidate is a superset of this one
    const idx = deduped.findIndex(
      d => d.file === c.file && d.start <= c.start && d.end >= c.end
    );
    if (idx !== -1) {
      // Replace the broader match with this more-specific one
      deduped[idx] = c;
    } else {
      deduped.push(c);
    }
  }

  if (deduped.length < topMatches.length) {
    process.stderr.write(
      `[find-platform-gate] Deduplicated ${topMatches.length} → ${deduped.length} gate(s) ` +
      `(removed nested/overlapping ranges).\n`
    );
  }

  result = {
    gates: deduped.map(c => ({
      file:    c.file,
      start:   c.start,
      end:     c.end,
      score:   c.score,
      preview: c.preview,
    })),
  };
  process.stderr.write(
    `[find-platform-gate] Emitting ${result.gates.length} gate(s) in multi-gate mode.\n`
  );
} else {
  // Default: single best match (legacy format)
  const best = topMatches[0];
  result = {
    file:    best.file,
    start:   best.start,
    end:     best.end,
    score:   best.score,
    preview: best.preview,
  };
}

const json = JSON.stringify(result, null, 2) + '\n';
process.stdout.write(json);

try {
  writeFileSync(outputPath, json, 'utf8');
  process.stderr.write(`[find-platform-gate] Gate location written to ${outputPath}\n`);
} catch (err) {
  process.stderr.write(
    `[find-platform-gate] Warning: could not write ${outputPath}: ${err.message}\n`
  );
}
