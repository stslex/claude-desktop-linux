/**
 * patch-utils.mjs
 *
 * Shared utilities for AST-based patches.  All three patch scripts
 * (patch-cowork-socket, patch-dispatch, patch-computer-use-tcc)
 * previously duplicated these helpers.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import * as acorn from 'acorn';

/**
 * Recursively collect all .js files under `dir`.
 * @param {string} dir
 * @param {(msg: string) => void} [log] — optional logger for warnings
 * @returns {string[]}
 */
export function collectJsFiles(dir, log) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectJsFiles(full, log));
      } else if (entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
  } catch (e) {
    if (log) log(`WARNING: Cannot read ${dir}: ${e.message}`);
  }
  return files;
}

/**
 * Try to parse `src` as ESM first, then as CJS script.
 * @param {string} src
 * @param {string} file — path (used only in warning messages)
 * @param {object} [extraOpts] — additional acorn options (e.g. `{ locations: true }`)
 * @param {(msg: string) => void} [log]
 * @returns {import('acorn').Node | null}
 */
export function tryParse(src, file, extraOpts, log) {
  for (const sourceType of ['module', 'script']) {
    try {
      return acorn.parse(src, {
        ecmaVersion: 'latest',
        sourceType,
        ...extraOpts,
      });
    } catch (_) {
      // try next sourceType
    }
  }
  if (log) log(`WARNING: Could not parse ${file} — skipping.`);
  return null;
}

/**
 * Create a prefixed logger that writes to stderr.
 * @param {string} prefix — e.g. "patch-cowork-socket"
 * @returns {(msg: string) => void}
 */
export function createLogger(prefix) {
  return (msg) => process.stderr.write(`[${prefix}] ${msg}\n`);
}
