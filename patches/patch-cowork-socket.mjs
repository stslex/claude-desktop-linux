/**
 * patch-cowork-socket.mjs
 *
 * AST-based patch that redirects the Cowork VM client's transport endpoint
 * from a Windows named pipe to a Linux Unix domain socket.
 *
 * On Windows, the app connects to: \\.\pipe\cowork-vm-service
 * On Linux, we redirect to:       $XDG_RUNTIME_DIR/cowork-vm-service.sock
 *
 * The patch also ensures that any `process.platform === 'win32'` or
 * `process.platform === 'darwin'` guards on the VM client class accept
 * 'linux' as well.
 *
 * Usage:
 *   node patches/patch-cowork-socket.mjs <app-extracted-dir>
 *
 * Exits 0 on success, 1 if the pattern is not found.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import * as walk from 'acorn-walk';
import { collectJsFiles, tryParse, createLogger } from './patch-utils.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PIPE_PATTERNS = [
  'cowork-vm-service',
  '\\\\.\\pipe\\',
  '\\\\\\\\.\\\\pipe\\\\',
  'pipe\\cowork',
];

const SOCKET_REPLACEMENT =
  `(process.platform==="linux"` +
  `?(process.env.XDG_RUNTIME_DIR||"/run/user/"+process.getuid())+"/cowork-vm-service.sock"` +
  `:"\\\\\\\\.\\\\pipe\\\\cowork-vm-service")`;

const PLATFORM_LINUX_ADDITION = `||process.platform==="linux"`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = createLogger('patch-cowork-socket');

function collectStrings(node) {
  const strings = new Set();
  walk.simple(node, {
    Literal(n) {
      if (typeof n.value === 'string') strings.add(n.value);
    },
    TemplateLiteral(n) {
      for (const q of n.quasis) {
        if (q.value && q.value.raw) strings.add(q.value.raw);
      }
    },
  });
  return strings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const appDir = process.argv[2];
if (!appDir) {
  log('Usage: node patches/patch-cowork-socket.mjs <app-extracted-dir>');
  process.exit(1);
}

const viteDir = join(appDir, '.vite', 'build');
let scanDirs = [viteDir, appDir];

log(`Scanning for cowork socket transport patterns...`);

// ---------------------------------------------------------------------------
// Phase 1: Find files containing pipe/cowork-vm-service references
// ---------------------------------------------------------------------------
let pipeMatches = []; // { file, src, offset, literal, context }
let platformGuardMatches = []; // { file, src, offset, context }

for (const scanDir of scanDirs) {
  const files = collectJsFiles(scanDir);

  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Quick text check before parsing
    const hasPipeRef = PIPE_PATTERNS.some((p) => src.includes(p));
    const hasPlatformGuard =
      src.includes('cowork') &&
      (src.includes('process.platform') || src.includes('"win32"'));

    if (!hasPipeRef && !hasPlatformGuard) continue;

    const ast = tryParse(src, file, { locations: true }, log);
    if (!ast) continue;

    const relFile = relative(appDir, file);

    // Find pipe path string literals
    if (hasPipeRef) {
      walk.simple(ast, {
        Literal(node) {
          if (typeof node.value !== 'string') return;
          const val = node.value;
          if (
            val.includes('cowork-vm-service') ||
            val.includes('\\\\.\\pipe\\') ||
            val.includes('\\\\pipe\\')
          ) {
            pipeMatches.push({
              file,
              relFile,
              src,
              start: node.start,
              end: node.end,
              literal: val,
              raw: src.slice(node.start, node.end),
            });
          }
        },
        TemplateLiteral(node) {
          for (const q of node.quasis) {
            if (
              q.value &&
              q.value.raw &&
              (q.value.raw.includes('cowork-vm-service') ||
                q.value.raw.includes('\\\\.\\pipe\\'))
            ) {
              pipeMatches.push({
                file,
                relFile,
                src,
                start: node.start,
                end: node.end,
                literal: q.value.raw,
                raw: src.slice(node.start, node.end),
              });
            }
          }
        },
      });
    }

    // Find platform guards near cowork references
    if (hasPlatformGuard) {
      walk.ancestor(ast, {
        BinaryExpression(node, _state, ancestors) {
          // Look for: process.platform === "win32" or process.platform === "darwin"
          if (node.operator !== '===' && node.operator !== '==') return;

          const isProcessPlatform =
            (node.left.type === 'MemberExpression' &&
              node.left.object &&
              node.left.object.name === 'process' &&
              node.left.property &&
              node.left.property.name === 'platform') ||
            (node.right.type === 'MemberExpression' &&
              node.right.object &&
              node.right.object.name === 'process' &&
              node.right.property &&
              node.right.property.name === 'platform');

          if (!isProcessPlatform) return;

          const platformValue =
            (node.left.type === 'Literal' && typeof node.left.value === 'string'
              ? node.left.value
              : null) ||
            (node.right.type === 'Literal' &&
            typeof node.right.value === 'string'
              ? node.right.value
              : null);

          if (
            platformValue !== 'win32' &&
            platformValue !== 'darwin'
          )
            return;

          // Check if this is near cowork-related code by examining enclosing function
          const enclosingFn = [...ancestors]
            .reverse()
            .find(
              (a) =>
                a.type === 'FunctionDeclaration' ||
                a.type === 'FunctionExpression' ||
                a.type === 'ArrowFunctionExpression',
            );

          if (!enclosingFn) return;

          const fnStrings = collectStrings(enclosingFn);
          const isCoworkRelated = [...fnStrings].some(
            (s) =>
              s.includes('cowork') ||
              s.includes('vm-service') ||
              s.includes('vmStarted') ||
              s.includes('apiReachable') ||
              s.includes('subscribeEvents') ||
              s.includes('writeStdin') ||
              s.includes('isGuestConnected'),
          );

          if (!isCoworkRelated) return;

          platformGuardMatches.push({
            file,
            relFile,
            src,
            start: node.start,
            end: node.end,
            platformValue,
            raw: src.slice(node.start, node.end),
            fnStart: enclosingFn.start,
            fnEnd: enclosingFn.end,
          });
        },
      });
    }
  }

  // If we found matches in the first scan dir, no need to scan more broadly
  if (pipeMatches.length > 0) break;
}

// ---------------------------------------------------------------------------
// Phase 2: Report findings
// ---------------------------------------------------------------------------
log(`Found ${pipeMatches.length} pipe path reference(s)`);
for (const m of pipeMatches) {
  log(`  ${m.relFile} [${m.start}..${m.end}]: ${m.raw}`);
}

log(`Found ${platformGuardMatches.length} platform guard(s) near cowork code`);
for (const m of platformGuardMatches) {
  log(`  ${m.relFile} [${m.start}..${m.end}]: ${m.raw}`);
}

if (pipeMatches.length === 0 && platformGuardMatches.length === 0) {
  log('ERROR: No cowork socket transport patterns found.');
  log('Searching for any string containing "cowork" or "pipe" for diagnostics...');

  for (const scanDir of scanDirs) {
    const files = collectJsFiles(scanDir);
    for (const file of files) {
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!src.includes('cowork') && !src.includes('pipe')) continue;

      const ast = tryParse(src, file, { locations: true }, log);
      if (!ast) continue;

      const relFile = relative(appDir, file);
      const matches = [];
      walk.simple(ast, {
        Literal(node) {
          if (typeof node.value !== 'string') return;
          if (
            node.value.includes('cowork') ||
            (node.value.includes('pipe') && node.value.length < 100)
          ) {
            matches.push(`  [${node.start}] ${JSON.stringify(node.value)}`);
          }
        },
      });
      if (matches.length > 0) {
        log(`Diagnostic — ${relFile}:`);
        for (const m of matches) log(m);
      }
    }
  }

  process.exit(1);
}

// ---------------------------------------------------------------------------
// Phase 3: Apply patches
// ---------------------------------------------------------------------------
// Group patches by file
const patchesByFile = new Map();

for (const m of pipeMatches) {
  if (!patchesByFile.has(m.file)) {
    patchesByFile.set(m.file, { src: m.src, patches: [] });
  }
  patchesByFile.get(m.file).patches.push({
    type: 'pipe-redirect',
    start: m.start,
    end: m.end,
    replacement: SOCKET_REPLACEMENT,
    description: `Pipe path "${m.literal}" → platform-aware socket/pipe`,
  });
}

for (const m of platformGuardMatches) {
  if (!patchesByFile.has(m.file)) {
    patchesByFile.set(m.file, { src: m.src, patches: [] });
  }

  // For platform guards like `process.platform === "win32"` or `=== "darwin"`,
  // wrap with `(original || process.platform === "linux")`
  patchesByFile.get(m.file).patches.push({
    type: 'platform-guard',
    start: m.start,
    end: m.end,
    replacement: `(${m.raw}${PLATFORM_LINUX_ADDITION})`,
    description: `Platform guard: ${m.raw} → includes linux`,
  });
}

let totalPatched = 0;

for (const [file, { src, patches }] of patchesByFile) {
  const relFile = relative(appDir, file);

  // Deduplicate overlapping ranges — keep the longer (more specific) patch
  const sorted = patches.sort((a, b) => a.start - b.start);
  const deduped = [];
  for (const p of sorted) {
    const last = deduped[deduped.length - 1];
    if (last && p.start >= last.start && p.end <= last.end) {
      // p is contained within last — skip if same type
      if (p.type === last.type) continue;
    }
    if (last && p.start < last.end) {
      // Overlapping — keep the pipe-redirect over platform-guard
      if (p.type === 'pipe-redirect') {
        deduped[deduped.length - 1] = p;
      }
      continue;
    }
    deduped.push(p);
  }

  // Apply patches from end to start to preserve offsets
  let patched = src;
  const reversed = deduped.sort((a, b) => b.start - a.start);

  for (const p of reversed) {
    log(`Applying ${p.type}: ${p.description}`);
    patched = patched.slice(0, p.start) + p.replacement + patched.slice(p.end);
    totalPatched++;
  }

  writeFileSync(file, patched, 'utf8');
  log(`Wrote ${relFile} (${src.length} → ${patched.length} bytes)`);
}

// ---------------------------------------------------------------------------
// If no pipe matches but we found platform guards, that's still useful
// ---------------------------------------------------------------------------
if (pipeMatches.length === 0 && platformGuardMatches.length > 0) {
  log('NOTE: No pipe path found (may already use a different transport).');
  log('Applied platform guard patches only.');
}

log(`Done. Applied ${totalPatched} patch(es).`);
process.exit(0);
