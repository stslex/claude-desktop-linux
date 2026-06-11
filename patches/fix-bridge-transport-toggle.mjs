#!/usr/bin/env node
/**
 * fix-bridge-transport-toggle.mjs
 *
 * Add a runtime opt-out from the Dispatch sessions-bridge "SDK adapter"
 * transport so it can fall back to the CCR transport that runs over
 * Electron's network stack.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * The bridge picks its transport in one function (minified `w4r`):
 *
 *     if (lt("583857784")) return …"gate on — using SDK adapter"…, I4r(A);  // axios
 *     … CCR transport over electron.net (r4r + /worker/events/stream) …
 *
 * Flag 583857784 is force-on, so the bridge always uses the SDK adapter, whose
 * `worker/register` runs over **axios (Node http)**. On networks where
 * api.anthropic.com is reached via a proxy and/or behind Cloudflare bot
 * protection, that axios request fails with HTTP 400 (`Failed to connect
 * transport … status code 400`) even for a freshly-created session — while the
 * bridge's own register/poll calls, which use **electron.net** (Chromium:
 * solves Cloudflare challenges, shares cookies, honours the system proxy),
 * succeed against the very same host. The CCR transport also uses electron.net,
 * so routing onto it sidesteps the axios-specific failure.
 *
 * ── What ──────────────────────────────────────────────────────────────────
 * Rewrites the transport-selector test from
 *
 *     if (lt("583857784"))
 * to
 *     if (lt("583857784") && process.env.FORCE_CCR_TRANSPORT !== "1")
 *
 * Default behaviour is UNCHANGED (the SDK adapter is still used). Setting the
 * env var `FORCE_CCR_TRANSPORT=1` at launch makes the bridge use the CCR /
 * electron.net transport instead — no rebuild needed to flip it. This is why
 * the patch is safe to run by default: it only adds an opt-out, it does not
 * change what happens unless the operator sets the variable.
 *
 * Target is located by AST: the IfStatement whose consequent contains the
 * stable log string "gate on — using SDK adapter". Minified identifiers are not
 * relied upon.
 *
 * Usage:
 *   node patches/fix-bridge-transport-toggle.mjs [--bundle <path>]
 *
 * Exit codes:
 *   0  Patched, already patched (idempotent), or the anchor is absent.
 *   1  Anchor present but the if-gate could not be located, or parse/IO error,
 *      or the patched bundle no longer parses. patch-cowork.sh treats a non-zero
 *      exit as a non-fatal WARNING, so default builds are unaffected.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

const ANCHOR = 'gate on — using SDK adapter';
const ENV_GUARD = 'process.env.FORCE_CCR_TRANSPORT';

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
  process.stderr.write(`[fix-bridge-transport-toggle] Bundle not found: ${bundlePath}\n`);
  process.exit(1);
}

const src = readFileSync(bundlePath, 'utf8');
process.stderr.write(
  `[fix-bridge-transport-toggle] Scanning ${bundlePath} (${src.length} chars)...\n`
);

if (!src.includes(ANCHOR)) {
  process.stderr.write(
    `[fix-bridge-transport-toggle] Anchor "${ANCHOR}" not present — ` +
    'nothing to patch (transport selector absent or renamed). Skipping.\n'
  );
  process.exit(0);
}
if (src.includes(ENV_GUARD)) {
  process.stderr.write(
    '[fix-bridge-transport-toggle] FORCE_CCR_TRANSPORT guard already present — ' +
    'nothing to do (idempotent).\n'
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
    process.stderr.write(`[fix-bridge-transport-toggle] Parse error: ${e.message}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Locate: the IfStatement whose consequent contains the ANCHOR log string.
// ---------------------------------------------------------------------------
const targets = []; // { testStart, testEnd, testSrc }

simple(ast, {
  IfStatement(node) {
    if (!node.consequent) return;
    const consSrc = src.slice(node.consequent.start, node.consequent.end);
    if (!consSrc.includes(ANCHOR)) return;
    targets.push({
      testStart: node.test.start,
      testEnd: node.test.end,
      testSrc: src.slice(node.test.start, node.test.end),
    });
  },
});

const unique = [...new Map(targets.map((t) => [t.testStart, t])).values()];

if (unique.length === 0) {
  process.stderr.write(
    `[fix-bridge-transport-toggle] Anchor "${ANCHOR}" found but not in an ` +
    'IfStatement consequent — bundle shape changed. (Non-fatal.)\n'
  );
  process.exit(1);
}
if (unique.length > 1) {
  process.stderr.write(
    `[fix-bridge-transport-toggle] WARNING: ${unique.length} candidate gates; ` +
    'patching all.\n'
  );
}

// ---------------------------------------------------------------------------
// Apply (descending offset order)
// ---------------------------------------------------------------------------
unique.sort((a, b) => b.testStart - a.testStart);

let patched = src;
let count = 0;
for (const t of unique) {
  const replacement = `(${t.testSrc})&&${ENV_GUARD}!=="1"`;
  patched = patched.slice(0, t.testStart) + replacement + patched.slice(t.testEnd);
  count++;
  process.stderr.write(
    `[fix-bridge-transport-toggle] Gated SDK-adapter selector at ` +
    `[${t.testStart}..${t.testEnd}]: ${t.testSrc} → ${replacement}\n`
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
    '[fix-bridge-transport-toggle] ERROR: patched bundle no longer parses — refusing to write.\n'
  );
  process.exit(1);
}

writeFileSync(bundlePath, patched, 'utf8');
process.stderr.write(
  `[fix-bridge-transport-toggle] Done — ${count} selector(s) gated behind ` +
  'FORCE_CCR_TRANSPORT in ' + bundlePath + '.\n'
);
process.exit(0);
