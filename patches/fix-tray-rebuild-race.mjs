#!/usr/bin/env node
/**
 * fix-tray-rebuild-race.mjs
 *
 * Fixes the dead tray menu bug on Linux. The upstream macOS bundle rebuilds
 * the Tray on every nativeTheme.updated event with `Pu.destroy(); Pu = new
 * Tray(...); Pu.setContextMenu(...)` and no synchronization. On Linux, GTK
 * fires multiple nativeTheme.updated events during startup, each one races
 * SNI/dbusmenu registration on the user's tray host — the host ends up
 * bound to a stale Tray and Activate signals never reach the live menu
 * handlers. Tray icon shows, menu items appear, clicking them does nothing
 * and the user must pkill to exit.
 *
 * Same four behaviors as aaddrick/claude-desktop-debian's tray.sh, but
 * re-derived structurally against our (macOS-extracted) bundle via AST —
 * does NOT depend on the minifier's specific renamed identifiers.
 *
 * Edits (idempotent, all-or-none):
 *   A.  Make the rebuild fn async                        (required by D)
 *   B.  Mutex prologue at start of body                  (drops re-entry inside 1500ms)
 *   C.  In-place setImage+setContextMenu fast-path       (skips destroy/recreate entirely
 *                                                          when tray already exists)
 *   D.  Awaited 250ms delay after <TRAY>.destroy()       (waits for SNI unregister to
 *                                                          complete before new Tray()
 *                                                          re-registers)
 *   E.  3-second uptime gate on the nativeTheme.updated  (suppresses rebuilds during the
 *       → rebuild() call                                   startup theme-detection storm)
 *
 * Compatibility: the in-place fast-path is safe with patches/native-frame.js's
 * Tray Proxy (which traps construct only — setImage is shadowed per-instance and
 * forwards through, setContextMenu is untouched).
 *
 * Usage:
 *   node patches/fix-tray-rebuild-race.mjs <app-extracted-dir> [--bundle <path>]
 *
 * Exit codes:
 *   0  Patch applied, or all five markers already present (idempotent no-op).
 *   1  Bundle missing, signature didn't resolve to a unique match, partial-
 *      patch state detected, post-edit parse failed, or post-edit marker
 *      check failed.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);

let bundleOverride = null;
const bundleIdx = rawArgs.indexOf('--bundle');
if (bundleIdx !== -1 && bundleIdx + 1 < rawArgs.length) {
  bundleOverride = rawArgs[bundleIdx + 1];
}

const appDir = rawArgs.find(
  (a, i) => !a.startsWith('--') && i !== bundleIdx + 1
) || join(process.env.BUILD_DIR || '/tmp/claude-build', 'app-extracted');

const bundlePath = bundleOverride || join(appDir, '.vite', 'build', 'index.js');

const log = (msg) => process.stderr.write(`[fix-tray-rebuild-race] ${msg}\n`);
const die = (msg) => { log(msg); process.exit(1); };

if (!existsSync(bundlePath)) die(`Bundle not found: ${bundlePath}`);

const src0 = readFileSync(bundlePath, 'utf8');
log(`Parsing ${bundlePath} (${src0.length} chars)...`);

let ast;
try {
  ast = parse(src0, { ecmaVersion: 'latest', sourceType: 'module' });
} catch {
  try {
    ast = parse(src0, { ecmaVersion: 'latest', sourceType: 'script', allowReserved: true });
  } catch (e) {
    die(`Parse failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// (1) Locate the tray-rebuild function by structural signature.
//
// Required (5/5 score):
//   - <X>.app.isReady() call
//   - <TRAY>.destroy() call where <TRAY> is an Identifier
//   - new <X>.Tray(<X>.nativeImage.createFromPath(<P>)) construction
//   - <TRAY>.setContextMenu(<M>()) call
//   - a CallExpression with first argument literal "menuBarEnabled"
//     (the `Ei("menuBarEnabled")` config read)
//
// Threshold 4 (allowing one missing) but we still REQUIRE all five resolved
// identifiers below — partial signatures get rejected by the explicit
// `missing` check.
// ---------------------------------------------------------------------------
const candidates = [];

function inspectFunction(node) {
  if (node.type !== 'FunctionDeclaration') return;
  if (!node.id?.name) return;
  const body = node.body;
  if (!body || body.type !== 'BlockStatement') return;

  const sig = { destroy: 0, newTray: 0, setContextMenu: 0, menuBarEnabled: 0, isReady: 0 };
  let trayVarName, electronVarName, menuFuncName, iconPathVar, enabledLocalName;
  // State for indirect menuFuncName resolution: upstream may hoist the builder call
  // into an assignment (vT = builder()) before passing the variable to setContextMenu.
  let _menuArgIdent  = null;   // Identifier name used as setContextMenu arg
  let _menuArgOffset = Infinity; // AST offset of that setContextMenu call
  let _menuFuncNameForm = null;  // 'direct call' | 'assignment to <ident>' (for logging)

  simple(body, {
    CallExpression(n) {
      const c = n.callee;
      if (c?.type === 'MemberExpression' && c.property?.name === 'isReady'
          && c.object?.type === 'MemberExpression' && c.object.property?.name === 'app') {
        sig.isReady++;
      }
      if (c?.type === 'MemberExpression' && c.property?.name === 'destroy'
          && c.object?.type === 'Identifier') {
        sig.destroy++;
        trayVarName ||= c.object.name;
      }
      if (c?.type === 'MemberExpression' && c.property?.name === 'setContextMenu'
          && c.object?.type === 'Identifier') {
        sig.setContextMenu++;
        const arg = n.arguments?.[0];
        if (arg?.type === 'CallExpression' && arg.callee?.type === 'Identifier') {
          // Direct form: rE.setContextMenu(builder())
          if (!menuFuncName) {
            menuFuncName = arg.callee.name;
            _menuFuncNameForm = 'direct call';
          }
        } else if (!menuFuncName && arg?.type === 'Identifier') {
          // Indirect form: rE.setContextMenu(vT) — record for second-pass resolution.
          // Update on every occurrence so we track the last (rightmost) call site.
          _menuArgIdent  = arg.name;
          _menuArgOffset = n.start;
        }
      }
      if (n.arguments?.[0]?.type === 'Literal'
          && n.arguments[0].value === 'menuBarEnabled') {
        sig.menuBarEnabled++;
      }
    },
    NewExpression(n) {
      const c = n.callee;
      if (c?.type === 'MemberExpression' && c.property?.name === 'Tray'
          && c.object?.type === 'Identifier') {
        sig.newTray++;
        electronVarName ||= c.object.name;
        const a0 = n.arguments?.[0];
        if (a0?.type === 'CallExpression'
            && a0.callee?.type === 'MemberExpression'
            && a0.callee.property?.name === 'createFromPath'
            && a0.arguments?.[0]?.type === 'Identifier') {
          iconPathVar ||= a0.arguments[0].name;
        }
      }
    },
    VariableDeclarator(n) {
      if (n.init?.type === 'CallExpression'
          && n.init.arguments?.[0]?.type === 'Literal'
          && n.init.arguments[0].value === 'menuBarEnabled'
          && n.id?.type === 'Identifier') {
        enabledLocalName ||= n.id.name;
      }
    },
  });

  // Second pass: indirect menuFuncName resolution.
  // If setContextMenu received an Identifier (vT), find the last AssignmentExpression
  // or VariableDeclarator inside this function body that assigns a CallExpression with
  // an Identifier callee to that variable, at an offset before the setContextMenu call.
  if (!menuFuncName && _menuArgIdent !== null) {
    let bestOffset = -1;
    simple(body, {
      AssignmentExpression(n) {
        if (n.operator !== '='
            || n.left?.type  !== 'Identifier' || n.left.name  !== _menuArgIdent
            || n.right?.type !== 'CallExpression'
            || n.right.callee?.type !== 'Identifier'
            || n.start > _menuArgOffset) return;
        if (n.start > bestOffset) {
          bestOffset        = n.start;
          menuFuncName      = n.right.callee.name;
          _menuFuncNameForm = `assignment to ${_menuArgIdent}`;
        }
      },
      VariableDeclarator(n) {
        if (n.id?.type  !== 'Identifier' || n.id.name   !== _menuArgIdent
            || n.init?.type !== 'CallExpression'
            || n.init.callee?.type !== 'Identifier'
            || n.start > _menuArgOffset) return;
        if (n.start > bestOffset) {
          bestOffset        = n.start;
          menuFuncName      = n.init.callee.name;
          _menuFuncNameForm = `VariableDeclarator for ${_menuArgIdent}`;
        }
      },
    });
  }

  const score = (sig.destroy ? 1 : 0) + (sig.newTray ? 1 : 0)
              + (sig.setContextMenu ? 1 : 0) + (sig.menuBarEnabled ? 1 : 0)
              + (sig.isReady ? 1 : 0);

  if (score >= 4) {
    candidates.push({
      name: node.id.name,
      fnNode: node,
      fnStart: node.start, fnEnd: node.end,
      bodyStart: body.start, bodyEnd: body.end,
      score, sig,
      trayVarName, electronVarName, menuFuncName, iconPathVar, enabledLocalName,
      _menuFuncNameForm,
    });
  }
}

simple(ast, {
  FunctionDeclaration: inspectFunction,
});

if (candidates.length === 0) {
  die('No tray-rebuild function found — bundle structure may have changed.');
}
if (candidates.length > 1) {
  log(`Ambiguous tray-rebuild function (${candidates.length} candidates):`);
  for (const c of candidates) {
    log(`  ${c.name}() [${c.fnStart}..${c.fnEnd}] score=${c.score}/5 sig=${JSON.stringify(c.sig)}`);
  }
  die('Refusing to patch — expected exactly one match.');
}

const m = candidates[0];

const missing = [];
if (!m.trayVarName)        missing.push('trayVarName');
if (!m.electronVarName)    missing.push('electronVarName');
if (!m.menuFuncName)       missing.push('menuFuncName');
if (!m.iconPathVar)        missing.push('iconPathVar');
if (!m.enabledLocalName)   missing.push('enabledLocalName');
if (missing.length) {
  // Dump the located function so the CI log captures the exact upstream
  // shape. Patching minified third-party code is inherently brittle: when a
  // new upstream version renames variables or restructures the rebuild fn,
  // the extractor above stops resolving one of the five identifiers. Printing
  // the body here lets the extractor be repaired without needing the bundle
  // in hand (it is otherwise only reachable inside CI). patch-cowork.sh treats
  // this exit non-fatally, so the dump surfaces as a build warning.
  const SNIPPET_LIMIT = 2400;
  const fnSrc = src0.slice(m.fnStart, Math.min(m.fnEnd, m.fnStart + SNIPPET_LIMIT));
  const truncated = m.fnEnd - m.fnStart > SNIPPET_LIMIT ? ' (truncated)' : '';
  log(`sig=${JSON.stringify(m.sig)} resolved={tray:${m.trayVarName},electron:${m.electronVarName},menu:${m.menuFuncName},iconPath:${m.iconPathVar},enabled:${m.enabledLocalName}}`);
  log(`--- ${m.name}() source${truncated} ---`);
  log(fnSrc);
  log(`--- end ${m.name}() source ---`);
  die(`Located ${m.name}() but failed to extract identifiers: ${missing.join(', ')}`);
}

log(`Rebuild fn: ${m.name}() body=[${m.bodyStart}..${m.bodyEnd}] score=${m.score}/5`);
log(`  electron=${m.electronVarName}  tray=${m.trayVarName}  menu=${m.menuFuncName}()  iconPath=${m.iconPathVar}  enabledLocal=${m.enabledLocalName}`);
log(`  menuFuncName=${m.menuFuncName} resolved via ${m._menuFuncNameForm || 'unknown'}`);

// ---------------------------------------------------------------------------
// (2) Locate nativeTheme.on("updated", cb) where cb calls m.name().
// ---------------------------------------------------------------------------
const themeHandlers = [];
simple(ast, {
  CallExpression(n) {
    const c = n.callee;
    if (c?.type !== 'MemberExpression' || c.property?.name !== 'on') return;
    if (c.object?.type !== 'MemberExpression' || c.object.property?.name !== 'nativeTheme') return;
    if (n.arguments?.[0]?.type !== 'Literal' || n.arguments[0].value !== 'updated') return;
    const cb = n.arguments[1];
    if (!cb) return;
    const rebuildCalls = [];
    simple(cb, {
      CallExpression(mm) {
        if (mm.callee?.type === 'Identifier' && mm.callee.name === m.name) {
          rebuildCalls.push(mm);
        }
      },
    });
    if (rebuildCalls.length === 1) {
      themeHandlers.push({ onCall: n, cb, rebuildCall: rebuildCalls[0] });
    }
  },
});

if (themeHandlers.length === 0) {
  die(`No nativeTheme.on("updated", cb) handler calls ${m.name}().`);
}
if (themeHandlers.length > 1) {
  log(`Ambiguous nativeTheme.updated handlers (${themeHandlers.length}):`);
  for (const t of themeHandlers) {
    log(`  on() at [${t.onCall.start}..${t.onCall.end}]`);
  }
  die('Refusing to patch — expected exactly one match.');
}
const themeHandler = themeHandlers[0];
log(`nativeTheme.updated handler: rebuild call at [${themeHandler.rebuildCall.start}..${themeHandler.rebuildCall.end}]`);

// ---------------------------------------------------------------------------
// (4) Locate the destroy+recreate IfStatement inside the rebuild fn.
//
//   The block looks like:  if(<TRAY> && (<TRAY>.destroy(), <TRAY> = null)) {...}
//   We find the IfStatement whose subtree contains BOTH:
//     - a CallExpression <TRAY>.destroy(), and
//     - an AssignmentExpression <TRAY> = null.
//   The =null assignment's `end` offset is the splice point for the await.
// ---------------------------------------------------------------------------
let destroyIfStmt = null;
let trayNullAssign = null;

simple(m.fnNode.body, {
  IfStatement(n) {
    let foundDestroy = false;
    let foundNull = null;
    simple(n, {
      CallExpression(c) {
        if (c.callee?.type === 'MemberExpression'
            && c.callee.property?.name === 'destroy'
            && c.callee.object?.type === 'Identifier'
            && c.callee.object.name === m.trayVarName) {
          foundDestroy = true;
        }
      },
      AssignmentExpression(c) {
        if (c.operator === '='
            && c.left?.type === 'Identifier' && c.left.name === m.trayVarName
            && c.right?.type === 'Literal' && c.right.value === null) {
          foundNull = c;
        }
      },
    });
    if (foundDestroy && foundNull && !destroyIfStmt) {
      destroyIfStmt = n;
      trayNullAssign = foundNull;
    }
  },
});

if (!destroyIfStmt) die('Could not locate destroy+recreate IfStatement inside rebuild fn.');
if (!trayNullAssign) die('Could not locate <TRAY>=null AssignmentExpression.');

log(`destroy+recreate IfStatement: [${destroyIfStmt.start}..${destroyIfStmt.end}]`);
log(`<${m.trayVarName}>=null assignment: [${trayNullAssign.start}..${trayNullAssign.end}]`);

// ---------------------------------------------------------------------------
// Secondary validation of the menu builder (3): function body should contain
// the literal "Show App"/"Quit" and a `buildFromTemplate` call. This is
// validation only — it does not affect the splice locations.
// ---------------------------------------------------------------------------
let menuValid = false;
simple(ast, {
  FunctionDeclaration(n) {
    if (n.id?.name !== m.menuFuncName) return;
    let hasBuild = false, hasShow = false, hasQuit = false;
    simple(n.body, {
      CallExpression(c) {
        if (c.callee?.type === 'MemberExpression' && c.callee.property?.name === 'buildFromTemplate') {
          hasBuild = true;
        }
      },
      Literal(c) {
        if (c.value === 'Show App') hasShow = true;
        if (c.value === 'Quit')     hasQuit = true;
      },
    });
    if (hasBuild && hasShow && hasQuit) menuValid = true;
  },
});
if (!menuValid) {
  die(`Menu-builder ${m.menuFuncName}() does not match expected shape (buildFromTemplate + "Show App" + "Quit").`);
}
log(`Menu builder ${m.menuFuncName}() validated.`);

// ---------------------------------------------------------------------------
// Idempotency check — five markers.
// ---------------------------------------------------------------------------
const escName = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const N = escName(m.name);
const T = escName(m.trayVarName);
const E = escName(m.electronVarName);
const P = escName(m.iconPathVar);

const markers = {
  asyncFn:     new RegExp(`\\basync\\s+function\\s+${N}\\s*\\(`),
  mutex:       new RegExp(`${N}\\._running\\b`),
  fastPath:    new RegExp(`${T}\\.setImage\\(\\s*${E}\\.nativeImage\\.createFromPath\\(\\s*${P}\\s*\\)`),
  await250:    /await\s+new\s+Promise\(\s*\w+\s*=>\s*setTimeout\(\s*\w+\s*,\s*250\s*\)\s*\)/,
  uptimeGate:  new RegExp(`process\\.uptime\\(\\)\\s*>\\s*3\\s*&&\\s*${N}\\s*\\(`),
};
const presence = Object.fromEntries(
  Object.entries(markers).map(([k, re]) => [k, re.test(src0)])
);
const presentCount = Object.values(presence).filter(Boolean).length;

if (presentCount === 5) {
  log('All five markers already present — idempotent no-op.');
  process.exit(0);
}
if (presentCount !== 0) {
  log('PARTIAL patch state detected — refusing to proceed:');
  for (const [k, v] of Object.entries(presence)) log(`  ${k}: ${v ? 'present' : 'MISSING'}`);
  die('Bundle is in inconsistent state. Re-extract from upstream and retry.');
}

// ---------------------------------------------------------------------------
// Compute the five edits.
// ---------------------------------------------------------------------------
const edits = [];

// A. Insert "async " before "function <name>"
edits.push({
  tag: 'A:async',
  start: m.fnStart, end: m.fnStart,
  repl: 'async ',
});

// B. Mutex prologue immediately after the body's opening "{"
const mutex =
  `if(${m.name}._running)return;` +
  `${m.name}._running=true;` +
  `setTimeout(()=>{${m.name}._running=false},1500);`;
edits.push({
  tag: 'B:mutex',
  start: m.bodyStart + 1, end: m.bodyStart + 1,
  repl: mutex,
});

// C. In-place fast-path inserted immediately before the destroy IfStatement
const fastPath =
  `if(${m.trayVarName}&&${m.enabledLocalName}!==false){` +
    `${m.trayVarName}.setImage(${m.electronVarName}.nativeImage.createFromPath(${m.iconPathVar}));` +
    `process.platform!=="darwin"&&${m.trayVarName}.setContextMenu(${m.menuFuncName}());` +
    `return;` +
  `}`;
edits.push({
  tag: 'C:fast-path',
  start: destroyIfStmt.start, end: destroyIfStmt.start,
  repl: fastPath,
});

// D. Append `,await new Promise(r=>setTimeout(r,250))` immediately after <TRAY>=null
edits.push({
  tag: 'D:await250',
  start: trayNullAssign.end, end: trayNullAssign.end,
  repl: ',await new Promise(r=>setTimeout(r,250))',
});

// E. Prepend `process.uptime()>3&&` immediately before the j3A() call inside
//    the nativeTheme.updated callback (no hoisted timestamp needed)
edits.push({
  tag: 'E:uptime-gate',
  start: themeHandler.rebuildCall.start, end: themeHandler.rebuildCall.start,
  repl: 'process.uptime()>3&&',
});

// Apply in DESCENDING offset order so earlier edits don't shift later offsets.
edits.sort((a, b) => b.start - a.start);

let src = src0;
for (const e of edits) {
  if (e.start < 0 || e.end > src.length || e.start > e.end) {
    die(`Edit ${e.tag} out of bounds: [${e.start}..${e.end}] (file length ${src.length}).`);
  }
  src = src.slice(0, e.start) + e.repl + src.slice(e.end);
  log(`Applied ${e.tag} at offset ${e.start} (+${e.repl.length} chars)`);
}

// ---------------------------------------------------------------------------
// Post-edit validation: re-parse and verify all five markers.
// ---------------------------------------------------------------------------
try {
  parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReserved: true });
} catch (e) {
  die(`Post-edit parse FAILED: ${e.message}`);
}

const postPresence = Object.fromEntries(
  Object.entries(markers).map(([k, re]) => [k, re.test(src)])
);
const postOk = Object.values(postPresence).every(Boolean);
if (!postOk) {
  log('Post-edit marker check FAILED:');
  for (const [k, v] of Object.entries(postPresence)) log(`  ${k}: ${v ? 'OK' : 'MISSING'}`);
  die('Patch produced inconsistent output — refusing to write.');
}

writeFileSync(bundlePath, src, 'utf8');
log('------------------------------------------------------------');
log(`Patched ${bundlePath}`);
log(`  A: async ${m.name}()`);
log(`  B: re-entrancy mutex (${m.name}._running, 1500ms auto-clear)`);
log(`  C: in-place setImage+setContextMenu fast-path`);
log(`  D: 250ms await after ${m.trayVarName}.destroy()`);
log(`  E: process.uptime()>3 gate on nativeTheme.updated → ${m.name}()`);
log('------------------------------------------------------------');
