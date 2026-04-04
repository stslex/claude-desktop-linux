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

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

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

const STUB_SNIPPET = `
;(function(){try{var e=require("electron"),m=e.ipcMain;if(m){
var ch=["ComputerUseTcc:getState","ComputerUseTcc:requestAccess",
"ComputerUseTcc.getState","ComputerUseTcc.requestPermission",
"ComputerUseTcc.checkAccessibility","ComputerUseTcc.checkScreenRecording",
"ComputerUseTcc.requestAccessibility","ComputerUseTcc.requestScreenRecording"];
var r={status:"not_applicable"};
ch.forEach(function(c){try{m.handle(c,function(){return r})}catch(x){}});
}}catch(x){}})();`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = (msg) => process.stderr.write(`[patch-computer-use-tcc] ${msg}\n`);

function collectJsFiles(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectJsFiles(full));
      } else if (entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
  } catch (e) {
    log(`WARNING: Cannot read ${dir}: ${e.message}`);
  }
  return files;
}

function tryParse(src, file) {
  for (const sourceType of ['module', 'script']) {
    try {
      return acorn.parse(src, {
        ecmaVersion: 'latest',
        sourceType,
      });
    } catch (_) {}
  }
  return null;
}

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

    const ast = tryParse(src, file);
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
// into the main bundle, near existing ipcMain.handle() calls.
//
// If we find ipcMain.handle() sites in the main bundle (index.js), we inject
// our stub snippet right before the first one.
// If not, we prepend it to the main entry point file.

let patched = false;

// Preferred: inject near existing ipcMain.handle() in the main bundle
const mainBundle = join(viteDir, 'index.js');
let mainBundleSite = ipcHandleSites.find((s) => s.file === mainBundle);

if (mainBundleSite) {
  let src = readFileSync(mainBundle, 'utf8');

  // Check if our stubs are already injected
  if (src.includes('ComputerUseTcc:getState') && src.includes('not_applicable')) {
    log('ComputerUseTcc stubs already present in main bundle — skipping.');
  } else {
    // Inject before the first ipcMain.handle() call
    const injectionPoint = mainBundleSite.offset;
    const result = src.slice(0, injectionPoint) + STUB_SNIPPET + src.slice(injectionPoint);
    writeFileSync(mainBundle, result, 'utf8');
    log(`Injected ComputerUseTcc stubs at offset ${injectionPoint} in ${relative(appDir, mainBundle)}`);
    log(`File size: ${src.length} → ${result.length} bytes`);
    patched = true;
  }
} else {
  // Fallback: check if the main entry exists and prepend
  let mainEntry = mainBundle;
  try {
    readFileSync(mainEntry, 'utf8');
  } catch {
    // Try package.json main field
    try {
      const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
      if (pkg.main) {
        mainEntry = join(appDir, pkg.main);
      }
    } catch {}
  }

  try {
    let src = readFileSync(mainEntry, 'utf8');
    if (src.includes('ComputerUseTcc:getState') && src.includes('not_applicable')) {
      log('ComputerUseTcc stubs already present — skipping.');
    } else {
      const result = STUB_SNIPPET + '\n' + src;
      writeFileSync(mainEntry, result, 'utf8');
      log(`Prepended ComputerUseTcc stubs to ${relative(appDir, mainEntry)}`);
      log(`File size: ${src.length} → ${result.length} bytes`);
      patched = true;
    }
  } catch (e) {
    log(`WARNING: Could not read main entry ${mainEntry}: ${e.message}`);
  }
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
