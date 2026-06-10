#!/usr/bin/env node
/**
 * patch-dispatch.mjs  —  EXPERIMENTAL (ENABLE_EXPERIMENTAL_PATCHES=1 only)
 *
 * Force-enables the GrowthBook feature flags that gate Dispatch / "Local Agent
 * Mode" (LAM) so the sessions-bridge can run on the Linux repackage.
 *
 * ── Why this rewrite ──────────────────────────────────────────────────────
 * The previous version of this script searched for the three reference flag
 * hashes (3572572142 / 2216414644 / 1143815894) as *numeric* literals and then
 * flipped the nearest `!0`/`!1` boolean it could find.  On 1.11187.4 that is
 * doubly wrong:
 *   1. The hashes are no longer numeric literals — they appear as *string*
 *      keys passed to the flag store (`tQ("3572572142", …)`,
 *      `lt("1143815894")`).  An AST walk that only inspects numeric Literal
 *      nodes (as the old recon did) reports them as "NOT FOUND".  They ARE
 *      present; the recon had a false negative.
 *   2. "Flip the nearest boolean" is a fragile heuristic that mutated unrelated
 *      code and corrupted the bundle (SIGSEGV on launch) — which is why this
 *      patch was quarantined behind the experimental flag in the first place.
 *
 * ── What this version does ────────────────────────────────────────────────
 * Dispatch flags are served by a GrowthBook-style store.  In the minified main
 * bundle the store is a module-local object (`zd` in 1.11187.4) replaced
 * wholesale by a single setter:
 *
 *     function KAt(A){ const e=zd; zd=A, mF=!0; … emit per-key change events … }
 *
 * Readers consult it two ways, both of which we must satisfy:
 *     lt(id)  ->  (zd[id]?.on) ?? false                 // isFeatureOn
 *     V7A     =  !!(zd["3572572142"]?.on) || SAn        // direct .on read
 *
 * So flipping the *reader* (lt) is not enough — `V7A` reads `.on` straight off
 * the store entry.  The robust, single-site fix is to force the target flag
 * entries `on:true` *inside the store setter*, before `zd` is published.  The
 * setter's own diff/emit logic then notifies every subscriber (including the
 * one that recomputes `V7A` and starts the bridge), and the override survives
 * every flag refresh because the setter runs on every refresh.
 *
 * We match the setter by SHAPE (not by minified name): an assignment
 * `STORE = <param>` immediately followed by `READY = !0` in the same sequence,
 * where STORE is an identifier that is elsewhere indexed and has `.on` read off
 * it (the isFeatureOn signature) and <param> is the setter's sole parameter.
 * The right-hand `<param>` is rewritten to an IIFE that force-enables the flags
 * and returns the (mutated) object.
 *
 * Flags forced on (all verified to gate Dispatch on 1.11187.4):
 *   3572572142  sessions-bridge init gate   — drives V7A; without it the bridge
 *               never calls .start() (logs "init skipped — gate off
 *               (yukon_silver_cuttlefish_desktop)").
 *   1143815894  hostLoopMode                — Cdt()=lt("1143815894"); makes
 *               yD() pick host-loop execution (run the dispatched session
 *               directly on the host) instead of the macOS VM, which does not
 *               exist on Linux.
 *   2216414644  remote session control      — lt("2216414644"); without it a
 *               mobile-channel ("dispatched from phone") session throws
 *               "Remote session control is disabled".
 *
 * This patch is purely client-side.  It does NOT, and cannot, satisfy the
 * server-side requirements: the account must be entitled for Cowork / Claude
 * Code sessions (registration POST /v1/environments/bridge returns 403
 * "Cowork OAuth denied" otherwise), and background wake-up of a closed app
 * still depends on APNs/FCM push, which is out of scope.  See the build summary
 * and docs for the full caveat list.
 *
 * Usage:
 *   node patches/patch-dispatch.mjs <app-extracted-dir>
 *
 * Optional env:
 *   DISPATCH_FORCE_FLAGS   Comma-separated extra/override flag ids to force on
 *                          (added to the defaults above).
 *
 * Exit codes (INVARIANTS.md — patches self-validate):
 *   0  Store setter found and patched.
 *   1  Store setter pattern not found (the bundle shape changed) or the
 *      resulting bundle no longer parses.  patch-cowork.sh treats this as a
 *      non-fatal WARNING, so `main`/default builds are unaffected.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as walk from 'acorn-walk';
import { collectJsFiles, tryParse, createLogger } from './patch-utils.mjs';

const log = createLogger('patch-dispatch');

// ---------------------------------------------------------------------------
// Flags to force on. The three defaults all gate Dispatch/LAM on 1.11187.4.
// ---------------------------------------------------------------------------
const DEFAULT_FLAGS = [
  { id: '3572572142', name: 'sessions-bridge init gate (drives V7A → bridge start)' },
  { id: '1143815894', name: 'hostLoopMode (run dispatched session on host, no VM)' },
  { id: '2216414644', name: 'remote session control (mobile/dispatched channel)' },
];

const extraFlags = (process.env.DISPATCH_FORCE_FLAGS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((id) => ({ id, name: 'extra (DISPATCH_FORCE_FLAGS)' }));

const FLAGS = [...DEFAULT_FLAGS, ...extraFlags];
const FLAG_IDS = [...new Set(FLAGS.map((f) => f.id))];

// ---------------------------------------------------------------------------
// CLI / paths
// ---------------------------------------------------------------------------
const appDir = process.argv[2];
if (!appDir) {
  log('Usage: node patches/patch-dispatch.mjs <app-extracted-dir>');
  process.exit(1);
}

const viteDir = join(appDir, '.vite', 'build');
const mainBundle = join(viteDir, 'index.js');

// The store setter lives in the main bundle. Prefer it, but fall back to a
// scan so the patch still works if the entry point is renamed.
const candidateFiles = existsSync(mainBundle)
  ? [mainBundle, ...collectJsFiles(viteDir, log).filter((f) => f !== mainBundle)]
  : collectJsFiles(viteDir, log);

if (candidateFiles.length === 0) {
  log(`ERROR: No .js files found under ${viteDir}.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Sole-parameter name of a function node, or null. */
function soleParamName(fn) {
  if (!fn || !Array.isArray(fn.params) || fn.params.length !== 1) return null;
  const p = fn.params[0];
  return p && p.type === 'Identifier' ? p.name : null;
}

/**
 * True if `fn` calls `Object.keys(STORE)` or `Object.entries(STORE)` on the
 * given store identifier. The GrowthBook store setter is the only function that
 * both assigns the store from its parameter AND diffs it key-by-key to emit
 * change events (`for (const [r,n] of Object.entries(STORE)) … BD.emit(r,n)`),
 * so this structurally distinguishes it from incidental `X = param, Y = !0`
 * setters elsewhere in the bundle.
 */
function fnIteratesStore(fn, storeName) {
  let found = false;
  walk.simple(fn, {
    CallExpression(node) {
      if (found) return;
      const c = node.callee;
      if (!c || c.type !== 'MemberExpression') return;
      if (!c.object || c.object.type !== 'Identifier' || c.object.name !== 'Object') return;
      const m = c.property && (c.property.name ?? c.property.value);
      if (m !== 'keys' && m !== 'entries') return;
      const arg = node.arguments && node.arguments[0];
      if (arg && arg.type === 'Identifier' && arg.name === storeName) found = true;
    },
  });
  return found;
}

/**
 * Find the GrowthBook store setter: an AssignmentExpression `STORE = PARAM`
 * that sits in a SequenceExpression immediately before `READY = !0`, where
 * PARAM is the enclosing function's sole parameter AND that function also
 * iterates STORE via Object.keys/entries (the change-emit diff). Returns
 * { fnNode, assign, paramName, storeName } or null.
 */
function findStoreSetter(ast) {
  let found = null;

  walk.ancestor(ast, {
    AssignmentExpression(node, _state, ancestors) {
      if (found) return;
      if (node.operator !== '=') return;
      if (!node.left || node.left.type !== 'Identifier') return;
      if (!node.right || node.right.type !== 'Identifier') return;
      const storeName = node.left.name;
      const paramName = node.right.name;

      // Must be inside a SequenceExpression with a following `<id> = !0`.
      const seq = ancestors[ancestors.length - 2];
      if (!seq || seq.type !== 'SequenceExpression') return;
      const idx = seq.expressions.indexOf(node);
      if (idx === -1) return;
      const next = seq.expressions[idx + 1];
      const isReadyTrue =
        next &&
        next.type === 'AssignmentExpression' &&
        next.operator === '=' &&
        next.left.type === 'Identifier' &&
        next.right.type === 'UnaryExpression' &&
        next.right.operator === '!' &&
        next.right.argument.type === 'Literal' &&
        next.right.argument.value === 0;
      if (!isReadyTrue) return;

      // PARAM must be the sole parameter of the nearest enclosing function.
      let fn = null;
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i];
        if (
          a.type === 'FunctionDeclaration' ||
          a.type === 'FunctionExpression' ||
          a.type === 'ArrowFunctionExpression'
        ) {
          fn = a;
          break;
        }
      }
      if (!fn) return;
      if (soleParamName(fn) !== paramName) return;

      // The store setter diffs/emits over the store — incidental `X=p,Y=!0`
      // setters do not. This is the discriminator.
      if (!fnIteratesStore(fn, storeName)) return;

      found = { fnNode: fn, assign: node, paramName, storeName };
    },
  });

  return found;
}

/** Build the replacement expression for the setter's right-hand side. */
function buildForceExpr(paramName) {
  const idsArr = JSON.stringify(FLAG_IDS);
  // (t=>{ const o = (t && typeof t==="object") ? t : {};
  //       for (const k of IDS)
  //         o[k] = { on:true,
  //                  value:(o[k] && typeof o[k]==="object" && o[k].value && typeof o[k].value==="object") ? o[k].value : {} };
  //       return o; })(PARAM)
  return (
    `(t=>{const o=t&&typeof t=="object"?t:{};` +
    `for(const k of ${idsArr})` +
    `o[k]={on:!0,value:o[k]&&typeof o[k]=="object"&&o[k].value&&typeof o[k].value=="object"?o[k].value:{}};` +
    `return o})(${paramName})`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
log(`Forcing Dispatch/LAM flags on: ${FLAG_IDS.join(', ')}`);

let patchedFile = null;

for (const file of candidateFiles) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  // Cheap text pre-filter: the gate flag id must appear as a string key.
  if (!FLAG_IDS.some((id) => src.includes(`"${id}"`) || src.includes(`'${id}'`))) {
    continue;
  }

  const ast = tryParse(src, file, {}, log);
  if (!ast) continue;

  const setter = findStoreSetter(ast);
  if (!setter) continue;

  // Replace the right-hand `PARAM` with the force-enable IIFE.
  const r = setter.assign.right;
  const replacement = buildForceExpr(setter.paramName);
  const out = src.slice(0, r.start) + replacement + src.slice(r.end);

  // Self-validate: the result must still parse.
  const reparsed = tryParse(out, file, {}, log);
  if (!reparsed) {
    log(`ERROR: Patched ${file} no longer parses — refusing to write.`);
    process.exit(1);
  }

  writeFileSync(file, out, 'utf8');
  patchedFile = file;
  log(
    `Patched store setter in ${file}: ` +
      `store="${setter.storeName}" param="${setter.paramName}" ` +
      `(${src.length} → ${out.length} bytes).`
  );
  for (const f of FLAGS) log(`  forced on: ${f.id}  — ${f.name}`);
  break;
}

if (!patchedFile) {
  log('ERROR: GrowthBook store setter not found.');
  log('  Looked for an assignment `STORE = <param>` followed by `READY = !0`');
  log('  where STORE is read as `STORE[k].on` elsewhere (isFeatureOn shape).');
  log('  The minified bundle shape likely changed — re-derive with:');
  log('    node patches/recon-dispatch-flags.mjs <app-extracted-dir>');
  log('  (Dispatch flags will NOT be forced; main/default builds are unaffected.)');
  process.exit(1);
}

log('Dispatch flag override applied.');
process.exit(0);
