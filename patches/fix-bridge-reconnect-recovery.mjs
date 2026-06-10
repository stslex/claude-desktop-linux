#!/usr/bin/env node
/**
 * fix-bridge-reconnect-recovery.mjs
 *
 * Make the Dispatch / Local-Agent-Mode sessions-bridge recover from a dead
 * orchestrator session.
 *
 * ── The bug ───────────────────────────────────────────────────────────────
 * On startup the bridge reconnects its persisted orchestrator session
 * ("Dispatch background conversation") via `ensureSession()`:
 *
 *     await apiClient.reconnectSession(environmentId, remoteSessionId)
 *     ... catch (r) {
 *       const n = r instanceof <ApiError> && r.status === 404;   // ← only 404
 *       if (!n) return;                       // ← anything else: give up
 *       await writePersistedRemoteSessionId(null);
 *     }
 *     // only reached on 404 / no session:
 *     await apiClient.createSession(environmentId, "Dispatch background conversation", …)
 *
 * When the persisted session has been reaped server-side, `reconnectSession`
 * returns **HTTP 400** with body "Session not found" — NOT 404. The recovery
 * only treats 404 as "gone → create a fresh session", so the 400 falls into
 * `if (!n) return;`: the bridge keeps the dead `remoteSessionId` forever, never
 * creates a fresh orchestrator, and every message the phone sends is routed to
 * a session that can never attach a transport (`worker/register` → 400). Result:
 * messages arrive on the desktop but Dispatch never answers. The only way out
 * is a manual reset. (Observed on 1.11847.5; symptom in the log:
 * `Failed to reconnect session …: ReconnectSession: Failed with status 400:
 * Session not found` on every launch.)
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 * Broaden the recovery test so a "not found" reconnect is treated as recoverable
 * whether the server signals it as 404 or 400:
 *
 *     r.status === 404   →   (r.status === 404 || r.status === 400)
 *
 * `reconnectSession`'s only 4xx-with-no-retry outcome is an unreconnectable
 * session, so creating a fresh one is the correct response either way — the old
 * session was already unusable, nothing is lost. After this, a dead orchestrator
 * session self-heals on the next launch instead of staying stuck.
 *
 * Target is located by AST: the function whose source contains the stable
 * literal "Dispatch background conversation" (the createSession title), then its
 * single `<err>.status === 404` comparison. Minified identifiers are not relied
 * upon.
 *
 * Usage:
 *   node patches/fix-bridge-reconnect-recovery.mjs [--bundle <path>]
 *
 * Exit codes:
 *   0  Patched, or the anchor function is absent (feature changed / not present).
 *   1  Anchor found but the 404 check could not be located, or parse/IO error,
 *      or the patched bundle no longer parses. patch-cowork.sh treats a non-zero
 *      exit as a non-fatal WARNING, so default builds are unaffected.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

const ANCHOR = 'Dispatch background conversation';

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
  bundlePath = join(buildDir, 'app-extracted', '.vite', 'build', 'index.js');
}

if (!existsSync(bundlePath)) {
  process.stderr.write(`[fix-bridge-reconnect-recovery] Bundle not found: ${bundlePath}\n`);
  process.exit(1);
}

const src = readFileSync(bundlePath, 'utf8');
process.stderr.write(
  `[fix-bridge-reconnect-recovery] Scanning ${bundlePath} (${src.length} chars)...\n`
);

// Cheap pre-filter: if the anchor is gone, there is nothing to do.
if (!src.includes(ANCHOR)) {
  process.stderr.write(
    `[fix-bridge-reconnect-recovery] Anchor "${ANCHOR}" not present — ` +
    'nothing to patch (feature absent or renamed). Skipping.\n'
  );
  process.exit(0);
}

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
    process.stderr.write(`[fix-bridge-reconnect-recovery] Parse error: ${e.message}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Locate: the `<err>.status === 404` comparison inside the function whose body
// contains the ANCHOR literal.
// ---------------------------------------------------------------------------
const targets = []; // { start, end, objSrc }
let anchorFnFound = false;
let alreadyPatched = false;

// Recognises the broadened form this patch writes, e.g.
// `r.status===404||r.status===400` (idempotency guard).
const BROADENED_RE = /status\s*===\s*404\s*\|\|\s*[^)]*status\s*===\s*400/;

function checkFn(node) {
  if (!node.body) return;
  const fnSrc = src.slice(node.start, node.end);
  if (!fnSrc.includes(ANCHOR)) return;
  anchorFnFound = true;

  // Idempotency (INVARIANTS.md): if the recovery check is already broadened,
  // do nothing — and do NOT collect the still-present `…===404` operand as a
  // target, which would re-wrap it on every run.
  if (BROADENED_RE.test(fnSrc)) {
    alreadyPatched = true;
    return;
  }

  simple(node, {
    BinaryExpression(x) {
      if (
        x.operator === '===' &&
        x.right.type === 'Literal' &&
        x.right.value === 404 &&
        x.left.type === 'MemberExpression' &&
        x.left.property &&
        (x.left.property.name === 'status' || x.left.property.value === 'status')
      ) {
        targets.push({
          start: x.start,
          end: x.end,
          objSrc: src.slice(x.left.object.start, x.left.object.end),
        });
      }
    },
  });
}

simple(ast, {
  FunctionDeclaration: checkFn,
  FunctionExpression: checkFn,
  ArrowFunctionExpression: checkFn,
});

// Deduplicate by offset (the anchor function may be visited via nested nodes).
const unique = [...new Map(targets.map((t) => [t.start, t])).values()];

if (alreadyPatched && unique.length === 0) {
  process.stderr.write(
    '[fix-bridge-reconnect-recovery] Recovery check already broadened — ' +
    'nothing to do (idempotent).\n'
  );
  process.exit(0);
}

if (unique.length === 0) {
  if (!anchorFnFound) {
    process.stderr.write(
      `[fix-bridge-reconnect-recovery] Anchor "${ANCHOR}" present but not inside ` +
      'a function body we recognised — skipping. (Non-fatal.)\n'
    );
    process.exit(0);
  }
  process.stderr.write(
    `[fix-bridge-reconnect-recovery] Anchor "${ANCHOR}" found but no ` +
    '`<err>.status === 404` recovery check inside it — bundle shape changed. ' +
    'Re-derive the target. (Non-fatal.)\n'
  );
  process.exit(1);
}

if (unique.length > 1) {
  process.stderr.write(
    `[fix-bridge-reconnect-recovery] WARNING: ${unique.length} candidate 404 ` +
    'checks in the anchor function; patching all of them.\n'
  );
}

// ---------------------------------------------------------------------------
// Apply (descending offset order to preserve earlier positions)
// ---------------------------------------------------------------------------
unique.sort((a, b) => b.start - a.start);

let patched = src;
let count = 0;
for (const t of unique) {
  const orig = patched.slice(t.start, t.end);
  if (orig !== `${t.objSrc}.status===404` && !/\.status\s*===\s*404$/.test(orig)) {
    process.stderr.write(
      `[fix-bridge-reconnect-recovery] Unexpected slice at [${t.start}..${t.end}]: ` +
      `${JSON.stringify(orig)} — skipping.\n`
    );
    continue;
  }
  const replacement = `(${t.objSrc}.status===404||${t.objSrc}.status===400)`;
  patched = patched.slice(0, t.start) + replacement + patched.slice(t.end);
  count++;
  process.stderr.write(
    `[fix-bridge-reconnect-recovery] Broadened ${orig} → ${replacement} ` +
    `at [${t.start}..${t.end}]\n`
  );
}

if (count === 0) {
  process.stderr.write('[fix-bridge-reconnect-recovery] Nothing applied.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Self-validate: the result must still parse.
// ---------------------------------------------------------------------------
let ok = false;
for (const st of ['module', 'script']) {
  try {
    parse(patched, { ecmaVersion: 'latest', sourceType: st, allowReserved: true });
    ok = true;
    break;
  } catch {
    /* try next */
  }
}
if (!ok) {
  process.stderr.write(
    '[fix-bridge-reconnect-recovery] ERROR: patched bundle no longer parses — refusing to write.\n'
  );
  process.exit(1);
}

writeFileSync(bundlePath, patched, 'utf8');
process.stderr.write(
  `[fix-bridge-reconnect-recovery] Done — ${count} recovery check(s) broadened in ${bundlePath}.\n`
);
process.exit(0);
