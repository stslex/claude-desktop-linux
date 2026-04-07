/**
 * patch-dispatch.mjs
 *
 * AST-based patches that force-enable GrowthBook feature flags required for
 * Dispatch on Linux.  These flags are hash constants that appear as plain
 * numeric literals in the minified JS.
 *
 * Sub-patches:
 *   A) Sessions-bridge init gate   (hash: 3572572142)
 *   B) Remote session control check (hash: 2216414644)
 *   C) Platform label               (function returning "Darwin"/"Windows" for platform)
 *   D) hostLoopMode                 (hash: 1143815894)
 *
 * Usage:
 *   node patches/patch-dispatch.mjs <app-extracted-dir>
 *
 * Exits 0 on success, 1 if critical sub-patches fail.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import * as walk from 'acorn-walk';
import { collectJsFiles, tryParse, createLogger } from './patch-utils.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const FLAG_HASHES = {
  sessionsBridge: 3572572142,
  remoteSessionControl: 2216414644,
  hostLoopMode: 1143815894,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = createLogger('patch-dispatch');

/**
 * Walk ancestors to find the nearest enclosing scope (function or block).
 */
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

/**
 * Find a nearby boolean init (`!1` or `!0`) within a scope.
 * Returns { start, end, currentValue } or null.
 *
 * "Nearby" means: within the same function/block scope as the flag hash literal.
 * The boolean is typically in a VariableDeclarator init or an assignment.
 */
function findNearbyBooleanInit(ast, src, flagNode, scope) {
  const candidates = [];

  // Use ancestor walk so we can verify the boolean is in a VariableDeclarator
  // init or AssignmentExpression right-hand side — not an arbitrary expression
  // like a function argument or conditional test.
  walk.ancestor(scope, {
    UnaryExpression(node, _state, ancestors) {
      // Match `!0` (true) or `!1` (false)
      if (
        node.operator === '!' &&
        node.argument &&
        node.argument.type === 'Literal' &&
        (node.argument.value === 0 || node.argument.value === 1)
      ) {
        // Verify this boolean is an initializer or assignment target, not
        // an arbitrary expression (e.g. function argument, return value).
        const parent = ancestors[ancestors.length - 2];
        const isVarInit = parent &&
          parent.type === 'VariableDeclarator' &&
          parent.init === node;
        const isAssignment = parent &&
          parent.type === 'AssignmentExpression' &&
          parent.right === node;
        if (!isVarInit && !isAssignment) return;

        candidates.push({
          start: node.start,
          end: node.end,
          currentValue: node.argument.value === 0, // !0 = true, !1 = false
          raw: src.slice(node.start, node.end),
        });
      }
    },
  });

  if (candidates.length === 0) return null;

  // Find the closest boolean init to the flag hash.
  // Prefer `!1` (false) since we want to flip false→true.
  const falseCandidates = candidates.filter((c) => !c.currentValue);

  // Pick the closest one to the flag literal by offset distance
  const target = flagNode.start;
  const pool = falseCandidates.length > 0 ? falseCandidates : candidates;
  pool.sort((a, b) => Math.abs(a.start - target) - Math.abs(b.start - target));

  return pool[0] || null;
}

/**
 * Find a conditional expression that uses the result of a call containing
 * the flag hash, and make it evaluate to the desired value.
 */
function findConditionalNearFlag(ast, src, flagNode, scope) {
  const candidates = [];

  walk.ancestor(scope, {
    ConditionalExpression(node, _state, ancestors) {
      // Check if the test references code near our flag
      const testSrc = src.slice(node.test.start, node.test.end);
      if (
        Math.abs(node.start - flagNode.start) < 2000 &&
        node.test.type === 'UnaryExpression' &&
        node.test.operator === '!'
      ) {
        candidates.push({
          type: 'conditional-test',
          start: node.test.start,
          end: node.test.end,
          raw: testSrc,
        });
      }
    },
    IfStatement(node, _state, ancestors) {
      const testSrc = src.slice(node.test.start, node.test.end);
      if (
        Math.abs(node.start - flagNode.start) < 2000 &&
        node.test.type === 'UnaryExpression' &&
        node.test.operator === '!'
      ) {
        candidates.push({
          type: 'if-test',
          start: node.test.start,
          end: node.test.end,
          raw: testSrc,
        });
      }
    },
  });

  return candidates[0] || null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const appDir = process.argv[2];
if (!appDir) {
  log('Usage: node patches/patch-dispatch.mjs <app-extracted-dir>');
  process.exit(1);
}

const viteDir = join(appDir, '.vite', 'build');
const scanDirs = [viteDir, appDir];

log('Scanning for Dispatch feature flag patterns...');

// ---------------------------------------------------------------------------
// Phase 1: Find all files containing our flag hashes
// ---------------------------------------------------------------------------
const flagLocations = new Map(); // hash → [{ file, src, ast, node, scope }]

for (const hash of Object.values(FLAG_HASHES)) {
  flagLocations.set(hash, []);
}

// Also track platform label function candidates
const platformLabelCandidates = []; // { file, src, fnNode }

for (const scanDir of scanDirs) {
  const files = collectJsFiles(scanDir);

  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Quick text filter
    const hasAnyHash = Object.values(FLAG_HASHES).some((h) =>
      src.includes(String(h)),
    );
    const hasPlatformLabel =
      src.includes('"darwin"') ||
      src.includes('"Darwin"') ||
      src.includes('"win32"');

    if (!hasAnyHash && !hasPlatformLabel) continue;

    const ast = tryParse(src, file, { locations: true }, log);
    if (!ast) continue;

    const relFile = relative(appDir, file);

    // Find flag hash literals
    if (hasAnyHash) {
      walk.ancestor(ast, {
        Literal(node, _state, ancestors) {
          if (typeof node.value !== 'number') return;
          const locations = flagLocations.get(node.value);
          if (!locations) return;

          const scope = findEnclosingScope(ancestors);
          locations.push({
            file,
            relFile,
            src,
            ast,
            node,
            scope,
            ancestors: [...ancestors],
          });
        },
      });
    }

    // Find platform label function (Sub-patch C)
    // A function containing "darwin" and "win32" that returns a string like
    // "Darwin", "Windows", "macOS", etc.
    if (hasPlatformLabel) {
      walk.simple(ast, {
        FunctionDeclaration(node) {
          checkPlatformLabelFn(node, file, relFile, src);
        },
        FunctionExpression(node) {
          checkPlatformLabelFn(node, file, relFile, src);
        },
        ArrowFunctionExpression(node) {
          checkPlatformLabelFn(node, file, relFile, src);
        },
      });
    }
  }

  // Check if we found all hashes in this scan dir
  const allFound = [...flagLocations.values()].every((l) => l.length > 0);
  if (allFound && platformLabelCandidates.length > 0) break;
}

function checkPlatformLabelFn(node, file, relFile, src) {
  if (!node.body) return;

  const body = node.body.type === 'BlockStatement' ? node.body : node.body;
  const fnSrc = src.slice(node.start, node.end);

  // Must contain both "darwin" and "win32"
  if (!fnSrc.includes('"darwin"') && !fnSrc.includes("'darwin'")) return;
  if (!fnSrc.includes('"win32"') && !fnSrc.includes("'win32'")) return;

  // Must return a string (look for return statements with string literals)
  const strings = new Set();
  walk.simple(body.type === 'BlockStatement' ? body : { type: 'ExpressionStatement', expression: body }, {
    ReturnStatement(n) {
      if (n.argument && n.argument.type === 'Literal' && typeof n.argument.value === 'string') {
        strings.add(n.argument.value);
      }
    },
  });

  // Should NOT return { status: ... } objects (that's the Cowork gate)
  let hasStatusReturn = false;
  walk.simple(body.type === 'BlockStatement' ? body : { type: 'ExpressionStatement', expression: body }, {
    ReturnStatement(n) {
      if (
        n.argument &&
        n.argument.type === 'ObjectExpression' &&
        n.argument.properties &&
        n.argument.properties.some(
          (p) => p.key && (p.key.name === 'status' || p.key.value === 'status'),
        )
      ) {
        hasStatusReturn = true;
      }
    },
  });

  if (hasStatusReturn) return;

  // Must return at least one human-readable platform name
  const platformNames = ['Darwin', 'Windows', 'macOS', 'Mac', 'Win'];
  const hasPlatformName = [...strings].some((s) =>
    platformNames.some((pn) => s.includes(pn)),
  );

  if (!hasPlatformName && strings.size === 0) return;

  // Compact: < 500 chars
  if (fnSrc.length > 500) return;

  platformLabelCandidates.push({
    file,
    relFile,
    src,
    fnNode: node,
    bodyNode: body,
    strings,
    fnSrc,
  });
}

// ---------------------------------------------------------------------------
// Phase 2: Report findings
// ---------------------------------------------------------------------------
const subPatchResults = {
  A: { name: 'sessions-bridge', hash: FLAG_HASHES.sessionsBridge, applied: false },
  B: { name: 'remote-session-control', hash: FLAG_HASHES.remoteSessionControl, applied: false },
  C: { name: 'platform-label', hash: null, applied: false },
  D: { name: 'hostLoopMode', hash: FLAG_HASHES.hostLoopMode, applied: false },
};

for (const [key, locs] of flagLocations) {
  const name = Object.entries(FLAG_HASHES).find(([, v]) => v === key)?.[0] || 'unknown';
  log(`Flag ${name} (${key}): ${locs.length} occurrence(s)`);
  for (const loc of locs) {
    log(`  ${loc.relFile} [${loc.node.start}]`);
  }
}

log(`Platform label candidates: ${platformLabelCandidates.length}`);
for (const c of platformLabelCandidates) {
  log(`  ${c.relFile} [${c.fnNode.start}..${c.fnNode.end}]: returns ${[...c.strings].join(', ')}`);
}

// ---------------------------------------------------------------------------
// Phase 3: Apply sub-patches
// ---------------------------------------------------------------------------
// Track all patches grouped by file for correct offset management
const allPatches = new Map(); // file → [{ start, end, replacement, description }]

function addPatch(file, src, start, end, replacement, description) {
  if (!allPatches.has(file)) {
    allPatches.set(file, { src, patches: [] });
  }
  allPatches.get(file).patches.push({ start, end, replacement, description });
}

// --- Sub-patch A: Sessions-bridge init gate ---
{
  const locs = flagLocations.get(FLAG_HASHES.sessionsBridge);
  if (locs.length > 0) {
    for (const loc of locs) {
      if (!loc.scope) {
        log(`Sub-patch A: No enclosing scope for flag at ${loc.relFile}:${loc.node.start}`);
        continue;
      }

      const boolInit = findNearbyBooleanInit(loc.ast, loc.src, loc.node, loc.scope);
      if (boolInit && !boolInit.currentValue) {
        addPatch(
          loc.file, loc.src,
          boolInit.start, boolInit.end,
          '!0',
          `Sub-patch A: Flip ${boolInit.raw} → !0 near sessionsBridge flag`,
        );
        subPatchResults.A.applied = true;
        log(`Sub-patch A: Will flip ${boolInit.raw} → !0 at ${loc.relFile}:${boolInit.start}`);
        break; // Only patch the first occurrence
      }
    }
    if (!subPatchResults.A.applied) {
      log('Sub-patch A: Found flag but no nearby boolean to flip.');
    }
  } else {
    log('Sub-patch A: Flag 3572572142 not found.');
  }
}

// --- Sub-patch B: Remote session control check ---
{
  const locs = flagLocations.get(FLAG_HASHES.remoteSessionControl);
  if (locs.length > 0) {
    for (const loc of locs) {
      if (!loc.scope) {
        log(`Sub-patch B: No enclosing scope for flag at ${loc.relFile}:${loc.node.start}`);
        continue;
      }

      const cond = findConditionalNearFlag(loc.ast, loc.src, loc.node, loc.scope);
      if (cond) {
        addPatch(
          loc.file, loc.src,
          cond.start, cond.end,
          '!1',
          `Sub-patch B: Replace ${cond.raw} → !1 near remoteSessionControl flag`,
        );
        subPatchResults.B.applied = true;
        log(`Sub-patch B: Will replace ${cond.raw} → !1 at ${loc.relFile}:${cond.start}`);
        break;
      }

      // Fallback: try to find a nearby boolean init like sub-patch A
      const boolInit = findNearbyBooleanInit(loc.ast, loc.src, loc.node, loc.scope);
      if (boolInit && !boolInit.currentValue) {
        addPatch(
          loc.file, loc.src,
          boolInit.start, boolInit.end,
          '!0',
          `Sub-patch B: Flip ${boolInit.raw} → !0 near remoteSessionControl flag`,
        );
        subPatchResults.B.applied = true;
        log(`Sub-patch B: Will flip ${boolInit.raw} → !0 at ${loc.relFile}:${boolInit.start}`);
        break;
      }
    }
    if (!subPatchResults.B.applied) {
      log('Sub-patch B: Found flag but no conditional/boolean to patch.');
    }
  } else {
    log('Sub-patch B: Flag 2216414644 not found.');
  }
}

// --- Sub-patch C: Platform label ---
{
  if (platformLabelCandidates.length > 0) {
    // Pick the best candidate (shortest, most platform names)
    const best = platformLabelCandidates[0];
    const bodyNode = best.bodyNode;

    if (bodyNode.type === 'BlockStatement') {
      // Find the last return statement for the "unsupported" fallback
      // and add a linux case before it.
      // Strategy: find the conditional chain and add linux case.
      // Simpler approach: prepend a linux check at the start of the function body.
      const bodyStart = bodyNode.start; // points to '{'
      const patch =
        `{if(process.platform==="linux")return"Linux";` +
        best.src.slice(bodyNode.start + 1, bodyNode.end);

      addPatch(
        best.file, best.src,
        bodyNode.start, bodyNode.end,
        patch,
        `Sub-patch C: Add "linux" → "Linux" case to platform label function`,
      );
      subPatchResults.C.applied = true;
      log(`Sub-patch C: Will add linux case to platform label at ${best.relFile}:${bodyNode.start}`);
    } else {
      // Concise arrow: expr → { if (linux) return "Linux"; return <expr>; }
      const origExpr = best.src.slice(bodyNode.start, bodyNode.end);
      const patch = `{if(process.platform==="linux")return"Linux";return ${origExpr}}`;

      addPatch(
        best.file, best.src,
        bodyNode.start, bodyNode.end,
        patch,
        `Sub-patch C: Wrap concise arrow with linux case`,
      );
      subPatchResults.C.applied = true;
      log(`Sub-patch C: Will wrap concise arrow at ${best.relFile}:${bodyNode.start}`);
    }
  } else {
    log('Sub-patch C: No platform label function found.');
  }
}

// --- Sub-patch D: hostLoopMode ---
{
  const locs = flagLocations.get(FLAG_HASHES.hostLoopMode);
  if (locs.length > 0) {
    for (const loc of locs) {
      if (!loc.scope) {
        log(`Sub-patch D: No enclosing scope for flag at ${loc.relFile}:${loc.node.start}`);
        continue;
      }

      const boolInit = findNearbyBooleanInit(loc.ast, loc.src, loc.node, loc.scope);
      if (boolInit && !boolInit.currentValue) {
        addPatch(
          loc.file, loc.src,
          boolInit.start, boolInit.end,
          '!0',
          `Sub-patch D: Flip ${boolInit.raw} → !0 near hostLoopMode flag`,
        );
        subPatchResults.D.applied = true;
        log(`Sub-patch D: Will flip ${boolInit.raw} → !0 at ${loc.relFile}:${boolInit.start}`);
        break;
      }
    }
    if (!subPatchResults.D.applied) {
      log('Sub-patch D: Found flag but no nearby boolean to flip.');
    }
  } else {
    log('Sub-patch D: Flag 1143815894 not found.');
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Write patched files
// ---------------------------------------------------------------------------
let totalPatched = 0;

for (const [file, { src, patches }] of allPatches) {
  const relFile = relative(appDir, file);

  // Sort patches by descending start offset to preserve earlier offsets
  const sorted = patches.sort((a, b) => b.start - a.start);

  let patched = src;
  for (const p of sorted) {
    log(`Applying: ${p.description}`);
    patched = patched.slice(0, p.start) + p.replacement + patched.slice(p.end);
    totalPatched++;
  }

  writeFileSync(file, patched, 'utf8');
  log(`Wrote ${relFile} (${src.length} → ${patched.length} bytes)`);
}

// ---------------------------------------------------------------------------
// Phase 5: Summary and exit
// ---------------------------------------------------------------------------
log('------------------------------------------------------------');
log('Dispatch patch summary:');
for (const [key, result] of Object.entries(subPatchResults)) {
  const status = result.applied ? 'APPLIED' : 'NOT FOUND';
  const hashStr = result.hash ? ` (${result.hash})` : '';
  log(`  Sub-patch ${key} — ${result.name}${hashStr}: ${status}`);
}
log(`Total patches applied: ${totalPatched}`);
log('------------------------------------------------------------');

// Exit 1 only if ALL sub-patches failed (no useful patches at all)
if (totalPatched === 0) {
  log('ERROR: No Dispatch patches could be applied. The minified code may have changed structure.');
  process.exit(1);
}

// Warn if some sub-patches didn't apply (non-fatal)
const notApplied = Object.entries(subPatchResults).filter(([, r]) => !r.applied);
if (notApplied.length > 0) {
  log(`WARNING: ${notApplied.length} sub-patch(es) did not apply. Dispatch may be partially functional.`);
}

process.exit(0);
