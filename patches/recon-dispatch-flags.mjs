#!/usr/bin/env node
/**
 * recon-dispatch-flags.mjs
 *
 * READ-ONLY diagnostic for the Dispatch workstream.  It does NOT modify the
 * bundle, repack the asar, or write anything except a single text report.
 *
 * Goal: establish *ground truth* about the structure surrounding the three
 * GrowthBook feature-flag hash constants we need to flip for Dispatch on
 * Linux, plus the platform-label function that must learn to return "Linux".
 *
 * The previous (disabled) patches/patch-dispatch.mjs corrupted the bundle
 * because it used a fuzzy "nearest !0/!1 boolean" heuristic that flipped the
 * wrong literal.  Before writing any real patch we want to SEE, per flag:
 *   - every numeric Literal occurrence, with surrounding source and AST shape;
 *   - the nearest !0/!1 boolean *initializer/assignment* in the same scope,
 *     including its variable name, current value, and source slice — so a human
 *     can judge whether "nearest" is actually the right target.
 *
 * Reference behaviour we are replicating (patrickjaja/claude-desktop-bin):
 *   flag 3572572142 -> sessions-bridge init gate, forced ON  (let X=!1 => let X=!0)
 *   flag 2216414644 -> remote session control check, bypassed (!fn(...) => !1)
 *   flag 1143815894 -> hostLoopMode (direction TBD; reference forces OFF)
 *   a platform-label function (their "HI()") returning "Darwin"/"Windows"
 *     that must learn to return "Linux".
 *
 * Usage:
 *   node patches/recon-dispatch-flags.mjs [app-extracted-dir]
 *
 *   app-extracted-dir  default: $BUILD_DIR/app-extracted (BUILD_DIR default
 *                      /tmp/claude-build).  Scans <dir>/.vite/build first and
 *                      falls back to the whole tree for any target not found.
 *
 * Output:
 *   - Full report written to $BUILD_DIR/dispatch-recon.txt
 *   - Concise summary echoed to stderr.
 *
 * Exit codes:
 *   0  Scan completed and report written (zero findings is a valid result).
 *   1  Could not scan at all (app-extracted dir missing or no .js files).
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as walk from 'acorn-walk';
import { collectJsFiles, tryParse, createLogger } from './patch-utils.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TARGET_FLAGS = [
  { hash: 3572572142, label: 'sessions-bridge init gate (reference: forced ON, let X=!1 => !0)' },
  { hash: 2216414644, label: 'remote session control check (reference: bypassed, !fn(...) => !1)' },
  { hash: 1143815894, label: 'hostLoopMode (reference: forced OFF; direction TBD)' },
];
const TARGET_HASHES = TARGET_FLAGS.map((f) => f.hash);

const SURROUND = 250; // ~chars of source context around each flag literal
const FN_SRC_CAP = 600; // cap printed platform-label function source
const NEAREST_BOOL_LIST = 6; // how many nearby boolean inits to list per flag

const log = createLogger('recon-dispatch-flags');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const buildDir = process.env.BUILD_DIR || '/tmp/claude-build';
const appDir = process.argv[2] || join(buildDir, 'app-extracted');
const viteDir = join(appDir, '.vite', 'build');
const reportPath = join(buildDir, 'dispatch-recon.txt');

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

/** Readable name for a call/member callee (e.g. "Wt", "os.platform"). */
function calleeName(callee) {
  if (!callee) return '';
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    const prop = callee.property && (callee.property.name ?? callee.property.value);
    const obj = callee.object && callee.object.type === 'Identifier' ? callee.object.name : null;
    return obj ? `${obj}.${prop ?? '?'}` : String(prop ?? '?');
  }
  return callee.type;
}

/** Readable source name for an assignment/declaration target node. */
function targetName(node, src) {
  if (!node) return '<anon>';
  if (node.type === 'Identifier') return node.name;
  // MemberExpression or anything else: use the raw source slice (kept short).
  const raw = src.slice(node.start, node.end);
  return raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
}

/** True for `process.platform` (dot or computed form). */
function isProcessPlatform(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  if (!node.object || node.object.type !== 'Identifier' || node.object.name !== 'process') return false;
  if (!node.computed) return node.property && node.property.name === 'platform';
  return node.property && node.property.type === 'Literal' && node.property.value === 'platform';
}

/** True if an object property's key is `status` (ignores spreads). */
function isStatusProp(p) {
  if (!p || !p.key) return false;
  return (p.key.name ?? p.key.value) === 'status';
}

/** Find the nearest enclosing scope (function or block) walking ancestors. */
function findEnclosingScope(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (
      a.type === 'FunctionDeclaration' ||
      a.type === 'FunctionExpression' ||
      a.type === 'ArrowFunctionExpression' ||
      a.type === 'BlockStatement'
    ) {
      return a;
    }
  }
  return null;
}

/** Find the nearest enclosing function (skipping plain blocks). */
function findEnclosingFunction(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (
      a.type === 'FunctionDeclaration' ||
      a.type === 'FunctionExpression' ||
      a.type === 'ArrowFunctionExpression'
    ) {
      return a;
    }
  }
  return null;
}

/**
 * Classify the AST shape of a flag-hash literal from its parent.
 * Returns a one-line human-readable description.
 */
function classifyFlagShape(parent, node, src) {
  if (!parent) return 'top-level / no parent';

  if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
    const idx = parent.arguments ? parent.arguments.indexOf(node) : -1;
    if (idx >= 0) {
      return `argument[${idx}] to ${parent.type} (callee=${calleeName(parent.callee) || '?'})`;
    }
    if (parent.callee === node) return `callee of ${parent.type}`;
    return `inside ${parent.type}`;
  }

  if (parent.type === 'Property') {
    if (parent.value === node) {
      const key = parent.key && (parent.key.name ?? parent.key.value);
      return `property VALUE (key=${key ?? '?'})`;
    }
    if (parent.key === node) return 'property KEY';
    return 'inside Property';
  }

  if (parent.type === 'ArrayExpression') {
    const idx = parent.elements.indexOf(node);
    return `array element[${idx}]`;
  }

  if (parent.type === 'VariableDeclarator' && parent.init === node) {
    return `variable initializer (var ${targetName(parent.id, src)})`;
  }

  if (parent.type === 'AssignmentExpression' && parent.right === node) {
    return `assignment RHS (${targetName(parent.left, src)} ${parent.operator} …)`;
  }

  if (parent.type === 'BinaryExpression') {
    const side = parent.left === node ? 'left' : 'right';
    const other = side === 'left' ? parent.right : parent.left;
    return `operand (${side}) of '${parent.operator}' comparison vs ${src.slice(other.start, other.end).slice(0, 40)}`;
  }

  if (parent.type === 'ReturnStatement') return 'return value';

  return `child of ${parent.type}`;
}

/**
 * Within `scope`, collect every `!0`/`!1` UnaryExpression that is a
 * VariableDeclarator init OR an AssignmentExpression RHS.  Returns an array of
 * { start, end, value, name, raw, distance } sorted nearest-first to `target`.
 *
 * This is deliberately a *report*, not a picker: the old patch blindly took the
 * nearest one.  We surface several so a human can judge.
 */
function collectBooleanInits(scope, target, src) {
  const out = [];
  walk.ancestor(scope, {
    UnaryExpression(node, _state, ancestors) {
      if (
        node.operator !== '!' ||
        !node.argument ||
        node.argument.type !== 'Literal' ||
        (node.argument.value !== 0 && node.argument.value !== 1)
      ) {
        return;
      }
      const parent = ancestors[ancestors.length - 2];
      const isVarInit = parent && parent.type === 'VariableDeclarator' && parent.init === node;
      const isAssign = parent && parent.type === 'AssignmentExpression' && parent.right === node;
      if (!isVarInit && !isAssign) return;

      const value = node.argument.value === 0; // !0 = true, !1 = false
      const name = isVarInit ? targetName(parent.id, src) : targetName(parent.left, src);
      out.push({
        start: node.start,
        end: node.end,
        value,
        name,
        kind: isVarInit ? 'declarator' : 'assignment',
        raw: src.slice(parent.start, parent.end),
        distance: Math.abs(node.start - target),
      });
    },
  });
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/**
 * Walk a function node's own body WITHOUT descending into nested functions.
 * `visit(node)` is called for every node in the function's own scope.
 */
function walkOwnScope(fnNode, visit) {
  const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'parent', 'sourceType', 'comments']);
  function rec(node) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    // Do not descend into nested function bodies (other than the root).
    if (node !== fnNode && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      return;
    }
    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const c of val) if (c && typeof c.type === 'string') rec(c);
      } else if (val && typeof val.type === 'string') {
        rec(val);
      }
    }
  }
  rec(fnNode);
}

/** Collect string literals that are actually *returned* (follow value positions). */
function collectReturnedStrings(arg, set) {
  if (!arg) return;
  switch (arg.type) {
    case 'Literal':
      if (typeof arg.value === 'string') set.add(arg.value);
      return;
    case 'ConditionalExpression':
      collectReturnedStrings(arg.consequent, set);
      collectReturnedStrings(arg.alternate, set);
      return;
    case 'LogicalExpression':
      collectReturnedStrings(arg.left, set);
      collectReturnedStrings(arg.right, set);
      return;
    case 'SequenceExpression':
      collectReturnedStrings(arg.expressions[arg.expressions.length - 1], set);
      return;
    default:
      return;
  }
}

/**
 * Analyse a function for the platform-label criteria.
 * Returns null if it does not qualify, else a descriptor object.
 *
 * Criteria:
 *   - own-scope string set contains "darwin" AND ("win32" OR "Windows")
 *   - has at least one ReturnStatement returning a string literal
 *   - does NOT contain an object with a `status` property (that is the Cowork gate)
 */
function analysePlatformLabel(fnNode, file, relFile, src) {
  const allStrings = new Set();
  const returnedStrings = new Set();
  const platformCalls = new Set();
  let hasStatusObject = false;
  let usesProcessPlatform = false;
  let returnsAnyString = false;

  walkOwnScope(fnNode, (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string') allStrings.add(node.value);
    if (node.type === 'ReturnStatement') {
      const before = returnedStrings.size;
      collectReturnedStrings(node.argument, returnedStrings);
      if (returnedStrings.size > before) returnsAnyString = true;
    }
    if (node.type === 'ObjectExpression' && node.properties.some(isStatusProp)) hasStatusObject = true;
    if (isProcessPlatform(node)) usesProcessPlatform = true;
    if (node.type === 'CallExpression') {
      const nm = calleeName(node.callee);
      if (nm && /platform/i.test(nm)) platformCalls.add(nm);
    }
  });

  const hasDarwin = allStrings.has('darwin') || allStrings.has('Darwin');
  const hasWin = allStrings.has('win32') || allStrings.has('Windows');
  if (!hasDarwin || !hasWin) return null;
  if (!returnsAnyString) return null;
  if (hasStatusObject) return null; // Cowork gate — explicitly excluded

  return {
    file,
    relFile,
    start: fnNode.start,
    end: fnNode.end,
    fnType: fnNode.type,
    fnSrc: src.slice(fnNode.start, fnNode.end),
    allStrings,
    returnedStrings,
    platformCalls,
    usesProcessPlatform,
  };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

// Per-hash occurrence list.
const occurrences = new Map(TARGET_HASHES.map((h) => [h, []]));
const platformCandidates = [];
const scannedFiles = new Set();
const parseFailures = [];

function scanFile(file) {
  if (scannedFiles.has(file)) return;
  scannedFiles.add(file);

  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return;
  }

  const hasAnyHash = TARGET_HASHES.some((h) => src.includes(String(h)));
  const hasPlatformText =
    (src.includes('darwin') || src.includes('Darwin')) &&
    (src.includes('win32') || src.includes('Windows'));
  if (!hasAnyHash && !hasPlatformText) return;

  const ast = tryParse(src, file, { locations: true }, log);
  if (!ast) {
    parseFailures.push(file);
    return;
  }

  const relFile = relative(appDir, file);

  if (hasAnyHash) {
    walk.ancestor(ast, {
      Literal(node, _state, ancestors) {
        if (typeof node.value !== 'number') return;
        const list = occurrences.get(node.value);
        if (!list) return;

        const parent = ancestors[ancestors.length - 2];
        const scope = findEnclosingScope(ancestors);
        const fn = findEnclosingFunction(ancestors);

        const ctxStart = Math.max(0, node.start - Math.floor(SURROUND / 2));
        const ctxEnd = Math.min(src.length, node.end + Math.ceil(SURROUND / 2));

        list.push({
          file,
          relFile,
          offset: node.start,
          line: node.loc ? node.loc.start.line : null,
          col: node.loc ? node.loc.start.column : null,
          shape: classifyFlagShape(parent, node, src),
          context: src.slice(ctxStart, ctxEnd),
          ctxStart,
          booleanInits: scope ? collectBooleanInits(scope, node.start, src) : [],
          scopeType: scope ? scope.type : null,
          fnRange: fn ? [fn.start, fn.end] : null,
        });
      },
    });
  }

  if (hasPlatformText) {
    const seen = new Set();
    const check = (node) => {
      if (seen.has(node.start)) return;
      seen.add(node.start);
      const cand = analysePlatformLabel(node, file, relFile, src);
      if (cand) platformCandidates.push(cand);
    };
    walk.simple(ast, {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    });
  }
}

// ---------------------------------------------------------------------------
// Pre-flight: app-extracted must exist (self-validation, INVARIANTS.md)
// ---------------------------------------------------------------------------
if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
  log(`ERROR: app-extracted directory not found: ${appDir}`);
  log('Run scripts/fetch-and-extract.sh and scripts/inject-stubs.sh first.');
  process.exit(1);
}

// Phase 1: scan .vite/build.
const viteFiles = existsSync(viteDir) ? collectJsFiles(viteDir, log) : [];
if (!existsSync(viteDir)) {
  log(`WARNING: ${viteDir} not found — scanning whole app-extracted tree instead.`);
}
for (const f of viteFiles) scanFile(f);

// Phase 2: fall back to the whole tree for any target not yet found.
const missingHash = TARGET_HASHES.some((h) => occurrences.get(h).length === 0);
const missingPlatform = platformCandidates.length === 0;
let fallbackUsed = false;
if (missingHash || missingPlatform || viteFiles.length === 0) {
  fallbackUsed = true;
  log(
    `Falling back to whole tree (missingHash=${missingHash}, ` +
      `missingPlatform=${missingPlatform}, viteFiles=${viteFiles.length}).`,
  );
  const allFiles = collectJsFiles(appDir, log);
  for (const f of allFiles) scanFile(f);
}

if (scannedFiles.size === 0) {
  log(`ERROR: No .js files found under ${appDir}. Nothing to scan.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dedupe platform candidates: drop any that strictly contain another (prefer
// the innermost / most-specific function), then sort by source length.
// ---------------------------------------------------------------------------
const dedupedPlatform = [];
for (const c of platformCandidates) {
  const containsAnother = platformCandidates.some(
    (d) => d !== c && d.file === c.file && c.start <= d.start && c.end >= d.end && (c.end - c.start) > (d.end - d.start),
  );
  if (!containsAnother) dedupedPlatform.push(c);
}
dedupedPlatform.sort((a, b) => (a.end - a.start) - (b.end - b.start));

// ---------------------------------------------------------------------------
// Build the report
// ---------------------------------------------------------------------------
const lines = [];
const w = (s = '') => lines.push(s);

const readMeta = (name) => {
  try {
    return readFileSync(join(buildDir, name), 'utf8').trim();
  } catch {
    return '(unknown)';
  }
};

w('='.repeat(78));
w('DISPATCH FEATURE-FLAG RECON REPORT  (read-only; nothing was modified)');
w('='.repeat(78));
w(`Generated      : ${new Date().toISOString()}`);
w(`BUILD_DIR      : ${buildDir}`);
w(`app-extracted  : ${appDir}`);
w(`.vite/build    : ${viteDir}${existsSync(viteDir) ? '' : '  (NOT FOUND)'}`);
w(`App version    : ${readMeta('VERSION')}`);
w(`Electron       : ${readMeta('ELECTRON_VERSION')}`);
w(`Files scanned  : ${scannedFiles.size} (.vite/build: ${viteFiles.length}; whole-tree fallback: ${fallbackUsed ? 'yes' : 'no'})`);
if (parseFailures.length) {
  w(`Parse failures : ${parseFailures.length} file(s) could not be parsed (skipped)`);
}
w('');
w('Target flags (reference: patrickjaja/claude-desktop-bin):');
for (const f of TARGET_FLAGS) w(`  ${f.hash}  — ${f.label}`);
w('');

// ---- Per-flag sections ----
for (const flag of TARGET_FLAGS) {
  const list = occurrences.get(flag.hash);
  w('-'.repeat(78));
  w(`FLAG ${flag.hash}  — ${flag.label}`);
  w(`  occurrences: ${list.length}`);
  w('-'.repeat(78));

  if (list.length === 0) {
    w('  NOT FOUND in any scanned file.');
    w('');
    continue;
  }

  list.forEach((o, i) => {
    w(`  [#${i + 1}] ${o.relFile}`);
    w(`        byte offset : ${o.offset}${o.line != null ? `  (line ${o.line}, col ${o.col})` : ''}`);
    w(`        AST shape   : ${o.shape}`);
    w(`        enclosing   : ${o.scopeType || 'none'}${o.fnRange ? `  fn=[${o.fnRange[0]}..${o.fnRange[1]}]` : ''}`);
    w(`        context (~${SURROUND} chars, from offset ${o.ctxStart}):`);
    w(`          …${o.context.replace(/\n/g, '\\n')}…`);
    if (o.booleanInits.length === 0) {
      w('        nearest !0/!1 init/assign in scope: NONE');
    } else {
      const nearest = o.booleanInits[0];
      w(`        nearest !0/!1 init/assign in scope:`);
      w(`          -> ${nearest.name} = ${nearest.value ? '!0 (true)' : '!1 (false)'}  ` +
        `[${nearest.kind}, dist ${nearest.distance}, offset ${nearest.start}]`);
      w(`             slice: ${nearest.raw.slice(0, 160)}`);
      const more = o.booleanInits.slice(1, NEAREST_BOOL_LIST);
      if (more.length) {
        w(`          other nearby boolean inits (for disambiguation):`);
        for (const b of more) {
          w(`            ${b.name} = ${b.value ? '!0(true)' : '!1(false)'}  ` +
            `[${b.kind}, dist ${b.distance}, offset ${b.start}]  ${b.raw.slice(0, 100)}`);
        }
      }
    }
    w('');
  });
}

// ---- Platform-label section ----
w('-'.repeat(78));
w('PLATFORM-LABEL FUNCTION  (reference "HI()": returns "Darwin"/"Windows";');
w('  must learn to return "Linux".  Cowork gate {status:...} excluded.)');
w(`  candidates (deduped): ${dedupedPlatform.length}`);
w('-'.repeat(78));

if (dedupedPlatform.length === 0) {
  w('  NOT FOUND. No function matched (darwin AND (win32|Windows)) with string');
  w('  returns and no {status} object. Re-check after a bundle update, or the');
  w('  label may be inlined / table-driven rather than a dedicated function.');
  w('');
} else {
  dedupedPlatform.forEach((c, i) => {
    const interp = c.usesProcessPlatform
      ? 'reads process.platform DIRECTLY -> sub-patch C (add a "linux" case) likely NEEDED'
      : c.platformCalls.size
        ? `delegates to ${[...c.platformCalls].join(', ')}() -> value controlled by claude-native stub ` +
          '(getPlatform()="darwin"); verify stub return/casing — may still need a Linux mapping'
        : 'neither process.platform nor a /platform/i call found -> manual review';
    w(`  [#${i + 1}] ${c.relFile}  (${c.fnType})`);
    w(`        byte offset : ${c.start}  fn=[${c.start}..${c.end}]  (${c.end - c.start} chars)`);
    w(`        returned strings : ${[...c.returnedStrings].map((s) => JSON.stringify(s)).join(', ') || '(none direct; see body strings)'}`);
    w(`        body strings     : ${[...c.allStrings].map((s) => JSON.stringify(s)).join(', ')}`);
    w(`        process.platform : ${c.usesProcessPlatform ? 'YES (direct)' : 'no'}`);
    w(`        /platform/i calls: ${c.platformCalls.size ? [...c.platformCalls].join(', ') : 'none'}`);
    w(`        => ${interp}`);
    w(`        source (cap ${FN_SRC_CAP} chars):`);
    const body = c.fnSrc.length > FN_SRC_CAP ? c.fnSrc.slice(0, FN_SRC_CAP) + ' …[truncated]' : c.fnSrc;
    w(`          ${body.replace(/\n/g, '\\n')}`);
    w('');
  });
}

// ---- Footer summary ----
w('='.repeat(78));
w('SUMMARY');
w('='.repeat(78));
for (const flag of TARGET_FLAGS) {
  const list = occurrences.get(flag.hash);
  if (list.length === 0) {
    w(`  ${flag.hash}: NOT FOUND`);
  } else {
    const o = list[0];
    const nb = o.booleanInits[0];
    const nbStr = nb ? `${nb.name}=${nb.value ? '!0' : '!1'}@${nb.distance}` : 'no-bool';
    w(`  ${flag.hash}: ${list.length} occ — ${o.shape}; nearest bool ${nbStr}`);
  }
}
if (dedupedPlatform.length === 0) {
  w('  platform-label: NOT FOUND');
} else {
  const c = dedupedPlatform[0];
  w(`  platform-label: FOUND ${c.relFile}@${c.start} (${c.usesProcessPlatform ? 'process.platform direct' : c.platformCalls.size ? `via ${[...c.platformCalls][0]}()` : 'indirect'})`);
}
w('');

const report = lines.join('\n');

// ---------------------------------------------------------------------------
// Write report + echo concise summary to stderr
// ---------------------------------------------------------------------------
try {
  writeFileSync(reportPath, report, 'utf8');
} catch (e) {
  log(`ERROR: could not write report to ${reportPath}: ${e.message}`);
  process.exit(1);
}

log('------------------------------------------------------------');
log(`Recon complete. Report: ${reportPath}`);
for (const flag of TARGET_FLAGS) {
  const list = occurrences.get(flag.hash);
  if (list.length === 0) {
    log(`  ${flag.hash}: NOT FOUND`);
  } else {
    const o = list[0];
    const nb = o.booleanInits[0];
    const nbStr = nb ? `nearest-bool ${nb.name}=${nb.value ? '!0(true)' : '!1(false)'}@dist${nb.distance}` : 'no-bool-in-scope';
    log(`  ${flag.hash}: ${list.length} occurrence(s) — ${o.shape}; ${nbStr}`);
  }
}
if (dedupedPlatform.length === 0) {
  log('  platform-label: NOT FOUND');
} else {
  const c = dedupedPlatform[0];
  const how = c.usesProcessPlatform
    ? 'process.platform DIRECT (sub-patch C needed)'
    : c.platformCalls.size
      ? `via ${[...c.platformCalls][0]}() (stub-controlled)`
      : 'indirect (manual review)';
  log(`  platform-label: FOUND ${c.relFile}@${c.start} — ${how}`);
}
log('------------------------------------------------------------');

process.exit(0);
