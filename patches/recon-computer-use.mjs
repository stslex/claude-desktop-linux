#!/usr/bin/env node
/**
 * recon-computer-use.mjs
 *
 * READ-ONLY diagnostic for the computer-use workstream.  It does NOT modify
 * the bundle, repack the asar, or write anything except a single markdown
 * report.
 *
 * Goal: establish *ground truth* about how the orchestrator consumes the
 * `computerUse` namespace on the @ant/claude-swift default export, BEFORE any
 * Linux backend is written.  Guessing the contract is forbidden — guessed
 * shapes have caused SIGSEGV regressions in this repo before (see
 * scripts/patch-cowork.sh, ENABLE_EXPERIMENTAL_PATCHES block).
 *
 * What it records, per call site:
 *   - the full member-access chain rooted at `.computerUse`
 *     (e.g. computerUse.apps.prepareDisplay), including accesses through
 *     local aliases (`const dAA = A.computerUse; dAA.apps.…`);
 *   - whether the access is a call, the source text of every argument;
 *   - return-contract hints: await usage, destructured result keys;
 *   - ±context so a human can read the minified surroundings.
 *
 * It also scans for the keyword strings "computerUse", "screenshot",
 * "screencapture", "click", "mouseMove", "cursor", "type", "keyPress",
 * "scroll" — full detail for the rare ones, per-file counts for the generic
 * ones (click/type/scroll/cursor appear thousands of times in DOM code).
 *
 * Usage:
 *   node patches/recon-computer-use.mjs [app-extracted-dir]
 *
 *   app-extracted-dir  default: $BUILD_DIR/app-extracted (BUILD_DIR default
 *                      /tmp/claude-build).  Scans <dir>/.vite/build.
 *
 * Output:
 *   - Markdown report written to /tmp/cd-computeruse-recon.md
 *     (the COMPUTER_USE_RECON=1 runtime proxy in stubs/claude-swift.js
 *     appends live call logs to the same file).
 *   - Concise summary echoed to stderr.
 *
 * Exit codes:
 *   0  Scan completed and report written (zero findings is a valid result).
 *   1  Could not scan at all (app-extracted dir missing or no .js files).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import * as walk from 'acorn-walk';
import { collectJsFiles, tryParse, createLogger } from './patch-utils.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SURROUND = 260;   // ~chars of source context around each finding
const ARG_CAP  = 160;   // cap printed source per call argument
const ALIAS_PASSES = 3; // alias-of-alias resolution depth

// Rare keywords: report every string literal that CONTAINS one (case-insens).
const RARE_KEYWORDS = ['computerUse', 'screencapture', 'screenshot', 'mouseMove', 'keyPress'];
// Generic keywords: exact-match string literals, per-file counts only
// (full detail would drown the report — "click"/"type" are DOM staples).
const GENERIC_KEYWORDS = ['click', 'cursor', 'type', 'scroll'];

const log = createLogger('recon-computer-use');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const buildDir = process.env.BUILD_DIR || '/tmp/claude-build';
const appDir = process.argv[2] || join(buildDir, 'app-extracted');
const viteDir = join(appDir, '.vite', 'build');
const reportPath = '/tmp/cd-computeruse-recon.md';

if (!existsSync(viteDir)) {
  log(`ERROR: ${viteDir} not found — run fetch-and-extract.sh first.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

/** Property name of a MemberExpression, or null when dynamically computed. */
function propName(member) {
  if (!member.computed && member.property.type === 'Identifier') {
    return member.property.name;
  }
  if (member.computed && member.property.type === 'Literal' &&
      typeof member.property.value === 'string') {
    return member.property.value;
  }
  return null;
}

/** One-line, whitespace-collapsed source slice. */
function slice(src, start, end, cap) {
  let s = src.slice(Math.max(0, start), Math.min(src.length, end));
  s = s.replace(/\s+/g, ' ');
  if (cap && s.length > cap) s = s.slice(0, cap) + '…';
  return s;
}

/** Markdown-safe cell text. */
function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/`/g, "'");
}

/**
 * Starting from a MemberExpression node (whose property is `.computerUse` or
 * whose object is a known alias), climb the ancestor chain to collect the
 * full access path, call info, and return-contract hints.
 *
 * @returns {{
 *   chain: string[], isCall: boolean, args: object[]|null,
 *   awaited: boolean, resultKeys: string[]|null, aliasTo: string|null,
 *   destructuredKeys: string[]|null, top: object
 * }}
 */
function climb(node, ancestors) {
  const chain = [];
  let current = node;
  let i = ancestors.length - 2; // ancestors[last] === node

  // Extend through `.a.b.c` as long as the parent member-accesses us.
  while (i >= 0 && ancestors[i].type === 'MemberExpression' && ancestors[i].object === current) {
    chain.push(propName(ancestors[i]) ?? '[computed]');
    current = ancestors[i];
    i--;
  }

  // Call?
  let isCall = false;
  let args = null;
  if (i >= 0 && ancestors[i].type === 'CallExpression' && ancestors[i].callee === current) {
    isCall = true;
    args = ancestors[i].arguments;
    current = ancestors[i];
    i--;
  }

  // Skip ChainExpression wrappers (optional chaining).
  while (i >= 0 && ancestors[i].type === 'ChainExpression') {
    current = ancestors[i];
    i--;
  }

  // Awaited?
  let awaited = false;
  if (i >= 0 && ancestors[i].type === 'AwaitExpression') {
    awaited = true;
    current = ancestors[i];
    i--;
  }

  // Result destructuring / alias assignment.
  let aliasTo = null;
  let resultKeys = null;
  let destructuredKeys = null;
  if (i >= 0) {
    const p = ancestors[i];
    let target = null;
    if (p.type === 'VariableDeclarator' && p.init === current) target = p.id;
    if (p.type === 'AssignmentExpression' && p.right === current) target = p.left;
    if (target) {
      if (target.type === 'Identifier') {
        if (isCall) {
          // result alias, not a namespace alias — record nothing
        } else {
          aliasTo = target.name;
        }
      } else if (target.type === 'ObjectPattern') {
        const keys = target.properties
          .map((pr) => (pr.key && pr.key.name) || (pr.key && pr.key.value) || '[computed]');
        if (isCall) resultKeys = keys;
        else destructuredKeys = keys;
      }
    }
  }

  return { chain, isCall, args, awaited, resultKeys, aliasTo, destructuredKeys, top: current };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
const files = collectJsFiles(viteDir, log);
if (files.length === 0) {
  log(`ERROR: no .js files under ${viteDir}`);
  process.exit(1);
}

const accesses = [];        // computerUse-rooted member accesses / calls
const aliasDecls = [];      // { file, name, root, offset }
const rareLiterals = [];    // { file, value, offset, context }
const genericCounts = {};   // file → keyword → count
const rarePropHits = [];    // member accesses with rare keyword prop names

for (const file of files) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { continue; }
  const relFile = relative(appDir, file);

  const lower = src.toLowerCase();
  const hasAny =
    src.includes('computerUse') ||
    RARE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
  // Generic keywords are counted only in files that matter for this recon;
  // still record their counts everywhere so the report shows the noise floor.
  const ast = tryParse(src, file, {}, log);
  if (!ast) continue;

  // ---- pass 1: direct `.computerUse` member accesses + literals ----------
  const fileAliases = new Map(); // name → level (1 = computerUse itself)

  walk.fullAncestor(ast, (node, _st, ancestors) => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      const v = node.value;
      const vl = v.toLowerCase();
      for (const k of RARE_KEYWORDS) {
        if (vl.includes(k.toLowerCase())) {
          rareLiterals.push({
            file: relFile,
            value: v.length > 80 ? v.slice(0, 80) + '…' : v,
            offset: node.start,
            context: slice(src, node.start - SURROUND / 2, node.end + SURROUND / 2, SURROUND),
          });
          break;
        }
      }
      if (GENERIC_KEYWORDS.includes(v)) {
        genericCounts[relFile] ??= {};
        genericCounts[relFile][v] = (genericCounts[relFile][v] || 0) + 1;
      }
      return;
    }

    if (node.type !== 'MemberExpression') return;
    const pn = propName(node);
    if (pn === 'computerUse') {
      const info = climb(node, ancestors);
      const rootSrc = slice(src, node.object.start, node.object.end, 60);
      accesses.push({
        file: relFile, offset: node.start, root: `${rootSrc}.computerUse`,
        via: 'direct', ...info,
        argSrc: info.args ? info.args.map((a) => slice(src, a.start, a.end, ARG_CAP)) : null,
        context: slice(src, node.start - SURROUND, node.start + SURROUND, SURROUND * 2),
      });
      if (info.aliasTo && info.chain.length === 0) {
        fileAliases.set(info.aliasTo, 1);
        aliasDecls.push({ file: relFile, name: info.aliasTo, root: rootSrc, offset: node.start });
      }
      return;
    }
    // Rare keyword used as a method/property name anywhere — these are
    // uncommon enough to record globally (screenshot, mouseMove, keyPress…).
    if (pn) {
      const pl = pn.toLowerCase();
      if (RARE_KEYWORDS.some((k) => k !== 'computerUse' && pl.includes(k.toLowerCase()))) {
        const info = climb(node, ancestors);
        rarePropHits.push({
          file: relFile, offset: node.start,
          access: `${slice(src, node.object.start, node.object.end, 60)}.${pn}`,
          isCall: info.isCall,
          argSrc: info.args ? info.args.map((a) => slice(src, a.start, a.end, ARG_CAP)) : null,
          context: slice(src, node.start - SURROUND / 2, node.start + SURROUND / 2, SURROUND),
        });
      }
    }
  });

  // ---- pass 2..N: accesses through aliases --------------------------------
  // Name-based within the file: minified identifiers may collide across
  // scopes, so every alias hit carries context for human verification.
  for (let pass = 0; pass < ALIAS_PASSES && fileAliases.size > 0; pass++) {
    const newAliases = new Map();
    walk.fullAncestor(ast, (node, _st, ancestors) => {
      if (node.type !== 'MemberExpression') return;
      if (node.object.type !== 'Identifier') return;
      const lvl = fileAliases.get(node.object.name);
      if (!lvl) return;
      // Only the *base* of a chain — inner links are covered by climb().
      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === 'MemberExpression' && parent.object !== node) return;

      const info = climb(node, ancestors);
      const fullChain = [propName(node) ?? '[computed]', ...info.chain];
      const already = accesses.some((a) => a.file === relFile && a.offset === node.start);
      if (already) return;
      accesses.push({
        file: relFile, offset: node.start,
        root: `${node.object.name}<alias L${lvl}>`,
        via: `alias:${node.object.name}`,
        ...info, chain: fullChain,
        argSrc: info.args ? info.args.map((a) => slice(src, a.start, a.end, ARG_CAP)) : null,
        context: slice(src, node.start - SURROUND, node.start + SURROUND, SURROUND * 2),
      });
      if (info.aliasTo && !fileAliases.has(info.aliasTo)) {
        newAliases.set(info.aliasTo, lvl + 1);
        aliasDecls.push({
          file: relFile, name: info.aliasTo,
          root: `${node.object.name}.${fullChain.join('.')}`, offset: node.start,
        });
      }
    });
    for (const [k, v] of newAliases) fileAliases.set(k, v);
    if (newAliases.size === 0) break;
  }

  if (hasAny) log(`scanned ${relFile} (${src.length} bytes)`);
}

// ---------------------------------------------------------------------------
// Aggregate: method → arg shapes → return hints → frequency
// ---------------------------------------------------------------------------
const methods = new Map(); // chainKey → { count, calls: [], reads: [] }
for (const a of accesses) {
  const key = a.chain.length ? a.chain.join('.') : '(bare computerUse access)';
  const m = methods.get(key) || { count: 0, calls: [], reads: [] };
  m.count++;
  if (a.isCall) m.calls.push(a);
  else m.reads.push(a);
  methods.set(key, m);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const out = [];
out.push('# computerUse interface recon');
out.push('');
out.push(`Generated by \`patches/recon-computer-use.mjs\` from \`${viteDir}\`.`);
out.push(`Files scanned: ${files.length}.  Direct/alias namespace accesses: ${accesses.length}.`);
out.push('');
out.push('## 1. Method summary (static): method → args → return contract → frequency');
out.push('');
out.push('| method (chain on computerUse) | calls | args (source, per site) | return hints | freq |');
out.push('|---|---|---|---|---|');
for (const [key, m] of [...methods.entries()].sort((x, y) => y[1].count - x[1].count)) {
  const argSets = m.calls.map((c) => `(${(c.argSrc || []).join(', ')})`);
  const hints = m.calls.map((c) => {
    const h = [];
    if (c.awaited) h.push('awaited');
    if (c.resultKeys) h.push(`result destructured → {${c.resultKeys.join(', ')}}`);
    return h.join('; ');
  }).filter(Boolean);
  out.push(`| ${cell(key)} | ${m.calls.length} | ${cell(argSets.join(' ; ') || '—')} | ${cell([...new Set(hints)].join(' ; ') || '—')} | ${m.count} |`);
}
out.push('');
out.push('## 2. Every namespace access (with context)');
out.push('');
for (const a of accesses.sort((x, y) => x.file.localeCompare(y.file) || x.offset - y.offset)) {
  out.push(`### ${a.file} @ ${a.offset} — \`${a.root}${a.chain.length ? '.' + a.chain.join('.') : ''}\``);
  out.push(`- via: ${a.via}; call: ${a.isCall}; awaited: ${a.awaited}`);
  if (a.argSrc) out.push(`- args: \`(${a.argSrc.join(', ')})\``);
  if (a.resultKeys) out.push(`- result destructured → \`{${a.resultKeys.join(', ')}}\``);
  if (a.destructuredKeys) out.push(`- namespace destructured → \`{${a.destructuredKeys.join(', ')}}\``);
  if (a.aliasTo) out.push(`- aliased to local \`${a.aliasTo}\``);
  out.push('```');
  out.push(a.context);
  out.push('```');
  out.push('');
}
out.push('## 3. Alias declarations');
out.push('');
out.push('| file | alias | bound to | offset |');
out.push('|---|---|---|---|');
for (const d of aliasDecls) {
  out.push(`| ${cell(d.file)} | ${cell(d.name)} | ${cell(d.root)} | ${d.offset} |`);
}
out.push('');
out.push(`## 4. Rare keyword string literals (${RARE_KEYWORDS.join(', ')})`);
out.push('');
for (const r of rareLiterals) {
  out.push(`- **${cell(r.file)}** @ ${r.offset}: \`"${cell(r.value)}"\``);
  out.push('  ```');
  out.push('  ' + r.context);
  out.push('  ```');
}
out.push('');
out.push('## 5. Rare keyword property accesses (screenshot / screencapture / mouseMove / keyPress)');
out.push('');
for (const r of rarePropHits) {
  out.push(`- **${cell(r.file)}** @ ${r.offset}: \`${cell(r.access)}\` call=${r.isCall}${r.argSrc ? ` args=(${cell(r.argSrc.join(', '))})` : ''}`);
  out.push('  ```');
  out.push('  ' + r.context);
  out.push('  ```');
}
out.push('');
out.push(`## 6. Generic keyword literal counts per file (exact match: ${GENERIC_KEYWORDS.join(', ')})`);
out.push('');
out.push('| file | ' + GENERIC_KEYWORDS.join(' | ') + ' |');
out.push('|---|' + GENERIC_KEYWORDS.map(() => '---|').join(''));
for (const [f, counts] of Object.entries(genericCounts)) {
  out.push(`| ${cell(f)} | ` + GENERIC_KEYWORDS.map((k) => counts[k] || 0).join(' | ') + ' |');
}
out.push('');
out.push('## 7. Runtime call log (appended by COMPUTER_USE_RECON=1 proxy)');
out.push('');
out.push('_Run the app with `COMPUTER_USE_RECON=1` and start a computer-use task;');
out.push('the proxy in stubs/claude-swift.js appends `method | argCount | args` lines below._');
out.push('');

writeFileSync(reportPath, out.join('\n'), 'utf8');

// ---------------------------------------------------------------------------
// Summary to stderr
// ---------------------------------------------------------------------------
log(`Report written to ${reportPath}`);
log(`Namespace accesses: ${accesses.length}; aliases: ${aliasDecls.length}; ` +
    `rare literals: ${rareLiterals.length}; rare prop hits: ${rarePropHits.length}`);
for (const [key, m] of methods) {
  log(`  computerUse.${key} — ${m.calls.length} call(s), ${m.count} access(es)`);
}
process.exit(0);
