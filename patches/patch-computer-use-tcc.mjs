/**
 * patch-computer-use-tcc.mjs
 *
 * AST-based patch that injects ComputerUseTcc IPC handler stubs directly into
 * the main process bundle.  This complements stubs/ipc-stubs.js (which
 * registers handlers at module load time) by also patching any inline
 * ComputerUseTcc references in the bundle that might fire before the stubs
 * are loaded.
 *
 * What it does:
 *   1. Finds ipcMain.handle() registration sites in the bundle
 *   2. Adds ComputerUseTcc handler registrations nearby
 *   3. Finds any ComputerUseTcc.getState / requestAccess calls in the
 *      renderer preload and ensures they have fallback values
 *
 * If no suitable injection site is found (the existing stubs/ipc-stubs.js
 * handles it at runtime), this patch exits 0 gracefully.
 *
 * Usage:
 *   node patches/patch-computer-use-tcc.mjs <app-extracted-dir>
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import * as walk from 'acorn-walk';
import { collectJsFiles, tryParse, createLogger } from './patch-utils.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TCC_CHANNELS = [
  'ComputerUseTcc:getState',
  'ComputerUseTcc:requestAccess',
  'ComputerUseTcc.getState',
  'ComputerUseTcc.requestPermission',
  'ComputerUseTcc.checkAccessibility',
  'ComputerUseTcc.checkScreenRecording',
  'ComputerUseTcc.requestAccessibility',
  'ComputerUseTcc.requestScreenRecording',
];

// IMPORTANT: The snippet must start with a semicolon (no leading newline) so
// it is safe to prepend to a minified bundle.  A leading newline followed by
// `;` can trigger ASI issues if the previous token was mid-expression.  By
// starting with `;` on the same (first) line we guarantee a clean statement
// boundary regardless of what precedes it.
const STUB_SNIPPET = [
  `;(function(){try{var e=require("electron"),m=e.ipcMain;if(m){`,
  `var ch=${JSON.stringify(TCC_CHANNELS)};`,
  `var r={status:"not_applicable"};`,
  `ch.forEach(function(c){try{m.handle(c,function(){return r})}catch(x){}});`,
  `}}catch(x){}})();\n`,
].join('');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = createLogger('patch-computer-use-tcc');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const appDir = process.argv[2];
if (!appDir) {
  log('Usage: node patches/patch-computer-use-tcc.mjs <app-extracted-dir>');
  process.exit(1);
}

const viteDir = join(appDir, '.vite', 'build');
const scanDirs = [viteDir, appDir];

log('Scanning for ComputerUseTcc references...');

let tccRefCount = 0;
let ipcHandleSites = []; // { file, src, offset }
let tccStringRefs = []; // { file, relFile, value, offset }

for (const scanDir of scanDirs) {
  const files = collectJsFiles(scanDir);

  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    if (!src.includes('ComputerUseTcc') && !src.includes('ipcMain')) continue;

    const ast = tryParse(src, file, {}, log);
    if (!ast) continue;

    const relFile = relative(appDir, file);

    walk.simple(ast, {
      Literal(node) {
        if (typeof node.value !== 'string') return;

        // Track ComputerUseTcc string references
        if (node.value.includes('ComputerUseTcc')) {
          tccStringRefs.push({
            file,
            relFile,
            value: node.value,
            offset: node.start,
          });
          tccRefCount++;
        }
      },
      CallExpression(node) {
        // Track ipcMain.handle() call sites
        if (
          node.callee &&
          node.callee.type === 'MemberExpression' &&
          node.callee.property &&
          (node.callee.property.name === 'handle' ||
            node.callee.property.value === 'handle')
        ) {
          const callerSrc = src.slice(
            Math.max(0, node.start - 50),
            node.start,
          );
          if (callerSrc.includes('ipcMain') || callerSrc.includes('ipc')) {
            ipcHandleSites.push({
              file,
              relFile,
              offset: node.start,
            });
          }
        }
      },
    });
  }

  if (tccRefCount > 0 || ipcHandleSites.length > 0) break;
}

// ---------------------------------------------------------------------------
// Report findings
// ---------------------------------------------------------------------------
log(`Found ${tccStringRefs.length} ComputerUseTcc string reference(s):`);
for (const ref of tccStringRefs) {
  log(`  ${ref.relFile} [${ref.offset}]: "${ref.value}"`);
}

log(`Found ${ipcHandleSites.length} ipcMain.handle() call site(s)`);

// ---------------------------------------------------------------------------
// Strategy decision
// ---------------------------------------------------------------------------
// The runtime stubs/ipc-stubs.js already handles ComputerUseTcc at module
// load time.  This AST patch adds a belt-and-suspenders injection directly
// into the main bundle.
//
// IMPORTANT: We always PREPEND the snippet to the file instead of injecting
// at an ipcMain.handle() CallExpression offset.  In minified code, a
// CallExpression can appear inside a larger expression (e.g.
// `var x=ipcMain.handle(...)` or `a(),ipcMain.handle(...)`).  Injecting a
// statement (`;\n(function(){...})();`) at a CallExpression offset that is
// mid-expression produces invalid JS (e.g. `var x=;(function...`).
//
// Prepending is safe because the snippet is a self-contained IIFE wrapped in
// try/catch, preceded by `;` for ASI safety.

let patched = false;

// Resolve the main entry point — prefer package.json main field (matches
// patch-cowork.sh behaviour), fall back to viteDir/index.js.
let mainEntry = null;
try {
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  if (pkg.main) {
    const pkgMainEntry = join(appDir, pkg.main);
    readFileSync(pkgMainEntry, 'utf8'); // verify it exists
    mainEntry = pkgMainEntry;
  }
} catch {}

if (!mainEntry) {
  try {
    const viteMainEntry = join(viteDir, 'index.js');
    readFileSync(viteMainEntry, 'utf8'); // verify it exists
    mainEntry = viteMainEntry;
  } catch {}
}

if (!mainEntry) {
  log('WARNING: Could not locate main entry point — skipping TCC stub injection.');
  process.exit(0);
}

try {
  let src = readFileSync(mainEntry, 'utf8');
  if (src.includes('ComputerUseTcc:getState') && src.includes('not_applicable')) {
    log('ComputerUseTcc stubs already present — skipping.');
  } else {
    const result = STUB_SNIPPET + src;
    writeFileSync(mainEntry, result, 'utf8');
    log(`Prepended ComputerUseTcc stubs to ${relative(appDir, mainEntry)}`);
    log(`File size: ${src.length} → ${result.length} bytes`);
    patched = true;
  }
} catch (e) {
  log(`WARNING: Could not read main entry ${mainEntry}: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (patched) {
  log('ComputerUseTcc IPC stubs injected into main bundle.');
} else {
  log('No AST injection needed — runtime stubs (ipc-stubs.js) will handle ComputerUseTcc.');
}

// Always exit 0 — the runtime stubs provide a safety net
process.exit(0);
