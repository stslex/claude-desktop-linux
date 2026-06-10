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
 *       const n = r instanceof <ApiError> && r.status === 404;   // only this class+404
 *       if (!n) return;                       // anything else: give up
 *       await writePersistedRemoteSessionId(null);
 *     }
 *     // only reached on "gone" / no session → create a fresh session
 *
 * When the persisted session has been reaped server-side, `reconnectSession`
 * returns **HTTP 400** with body "Session not found". The sessions-api error
 * helper only wraps 401/403/404/409 in the `<ApiError>` class (with a `.status`
 * field); EVERYTHING ELSE — including 400 — hits `default: throw new Error(...)`,
 * i.e. a plain `Error` with NO `.status`. So `r instanceof <ApiError>` is already
 * false for the 400, the status test never runs, `n` is false, and the bridge
 * keeps the dead `remoteSessionId` forever. Every message the phone sends is then
 * routed to a session that can never attach a transport (`worker/register` → 400):
 * messages arrive on the desktop, but Dispatch never answers.
 *
 * (An earlier version of this patch only broadened `r.status===404` to
 * `||r.status===400`. That was insufficient: the `r instanceof <ApiError>` guard
 * short-circuits to false for the plain-Error 400, so the status test was never
 * reached. Confirmed on the 1.11847.5 build — the log shows
 * `Failed to reconnect session …: ReconnectSession: Failed with status 400:
 * Session not found` with no "creating fresh" and no "Created session".)
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 * Replace the whole recovery test
 *
 *     r instanceof <ApiError> && r.status === 404
 *
 * with one that also recognises the plain-Error "Session not found" via the
 * error MESSAGE (which both the 404 and the 400 path carry):
 *
 *     (r instanceof <ApiError> && (r.status === 404 || r.status === 400))
 *       || (r && typeof r.message === "string" && /not found/i.test(r.message))
 *
 * The first clause preserves the original 404 behaviour exactly; the second
 * catches the plain-Error 400 "Session not found" (and is narrow — transient
 * network failures don't say "not found", so a momentarily unreachable session
 * is not abandoned). After this, a reaped orchestrator session self-heals into a
 * fresh one on the next launch.
 *
 * Target is located by AST: the function whose source contains the stable
 * literal "Dispatch background conversation", then the single LogicalExpression
 * `<err> instanceof <Class> && <…status…>` inside it. Minified identifiers are
 * read from the AST, not assumed.
 *
 * Usage:
 *   node patches/fix-bridge-reconnect-recovery.mjs [--bundle <path>]
 *
 * Exit codes:
 *   0  Patched, already patched (idempotent), or the anchor is absent.
 *   1  Anchor found but the recovery test could not be located, or parse/IO
 *      error, or the patched bundle no longer parses. patch-cowork.sh treats a
 *      non-zero exit as a non-fatal WARNING, so default builds are unaffected.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

const ANCHOR = 'Dispatch background conversation';
// Marker of an already-applied fix (the message clause we add).
const IDEMPOTENT_RE = /\/not found\/i\.test\(/;

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
// Locate: the recovery test `<err> instanceof <Class> && <…status…>` inside the
// function whose body contains the ANCHOR literal.
// ---------------------------------------------------------------------------
const targets = []; // { start, end, err, cls }
let anchorFnFound = false;
let alreadyPatched = false;

/**
 * True if the subtree contains a `<…>.status === 404` comparison — the defining
 * check of the reconnect recovery test. Requiring it (rather than merely "the
 * right operand mentions .status") keeps this default-on patch from rewriting an
 * unrelated sibling guard that happens to live in the same function, e.g.
 * `r instanceof q0 && r.status === 409`, into the recovery expression.
 * It still matches both the original `r.status===404` and an already-broadened
 * `(r.status===404||r.status===400)` right-hand side.
 */
function hasStatus404(node) {
  let found = false;
  simple(node, {
    BinaryExpression(b) {
      if (
        b.operator === '===' &&
        b.right.type === 'Literal' &&
        b.right.value === 404 &&
        b.left.type === 'MemberExpression' &&
        (b.left.property?.name === 'status' || b.left.property?.value === 'status')
      ) {
        found = true;
      }
    },
  });
  return found;
}

function checkFn(node) {
  if (!node.body) return;
  const fnSrc = src.slice(node.start, node.end);
  if (!fnSrc.includes(ANCHOR)) return;
  anchorFnFound = true;

  if (IDEMPOTENT_RE.test(fnSrc)) {
    alreadyPatched = true;
    return;
  }

  simple(node, {
    LogicalExpression(x) {
      if (x.operator !== '&&') return;
      if (!x.left || x.left.type !== 'BinaryExpression' || x.left.operator !== 'instanceof') return;
      if (!x.left.left || x.left.left.type !== 'Identifier') return;
      // The right operand must be the recovery's `=== 404` test specifically —
      // NOT merely any `.status` access. This excludes the warn-log ternary
      // (`r instanceof Error ? …`, not an `&&`) and, crucially, any unrelated
      // sibling guard such as `r instanceof q0 && r.status === 409` that may
      // share this function.
      if (!hasStatus404(x.right)) return;
      targets.push({
        start: x.start,
        end: x.end,
        err: src.slice(x.left.left.start, x.left.left.end),
        cls: src.slice(x.left.right.start, x.left.right.end),
      });
    },
  });
}

simple(ast, {
  FunctionDeclaration: checkFn,
  FunctionExpression: checkFn,
  ArrowFunctionExpression: checkFn,
});

const unique = [...new Map(targets.map((t) => [t.start, t])).values()];

if (alreadyPatched && unique.length === 0) {
  process.stderr.write(
    '[fix-bridge-reconnect-recovery] Recovery test already message-aware — ' +
    'nothing to do (idempotent).\n'
  );
  process.exit(0);
}

if (unique.length === 0) {
  if (!anchorFnFound) {
    process.stderr.write(
      `[fix-bridge-reconnect-recovery] Anchor "${ANCHOR}" present but not inside ` +
      'a recognised function body — skipping. (Non-fatal.)\n'
    );
    process.exit(0);
  }
  process.stderr.write(
    `[fix-bridge-reconnect-recovery] Anchor "${ANCHOR}" found but no ` +
    '`<err> instanceof <Class> && <…status…>` recovery test inside it — bundle ' +
    'shape changed. Re-derive the target. (Non-fatal.)\n'
  );
  process.exit(1);
}

if (unique.length > 1) {
  process.stderr.write(
    `[fix-bridge-reconnect-recovery] WARNING: ${unique.length} candidate recovery ` +
    'tests in the anchor function; patching all of them.\n'
  );
}

// ---------------------------------------------------------------------------
// Apply (descending offset order to preserve earlier positions)
// ---------------------------------------------------------------------------
unique.sort((a, b) => b.start - a.start);

let patched = src;
let count = 0;
for (const t of unique) {
  const replacement =
    `(${t.err} instanceof ${t.cls}&&(${t.err}.status===404||${t.err}.status===400))` +
    `||${t.err}&&typeof ${t.err}.message=="string"&&/not found/i.test(${t.err}.message)`;
  const orig = patched.slice(t.start, t.end);
  patched = patched.slice(0, t.start) + replacement + patched.slice(t.end);
  count++;
  process.stderr.write(
    `[fix-bridge-reconnect-recovery] Rewrote recovery test at [${t.start}..${t.end}]\n` +
    `    from: ${orig}\n` +
    `    to:   ${replacement}\n`
  );
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
  `[fix-bridge-reconnect-recovery] Done — ${count} recovery test(s) made message-aware in ${bundlePath}.\n`
);
process.exit(0);
