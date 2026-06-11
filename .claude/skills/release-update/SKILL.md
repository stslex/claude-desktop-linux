---
name: release-update
description: Adapt claude-desktop-linux to a new Claude Desktop release when a build breaks because the minified bundle changed shape. Use when find-platform-gate.mjs (or another AST patch) exits non-zero on a new version, when "could not find the platform gate" / pattern-not-found errors appear, when bumping to a newer upstream DMG, or when a stub method that used to work now logs "MISSING METHOD". Walks the diagnosis: dump AST candidates, locate the new function/symbol shape, update the pattern, re-validate.
---

# Update after a new Claude Desktop release

The patches key off the *shape* of minified functions, not their names (the
minifier renames every release). When upstream changes that shape, a patch's
`find-*.mjs` exits non-zero — **do not suppress it**; update the pattern.

## 1. Identify what broke

A failing `patch-cowork.sh` names the script that exited non-zero. The common one
requires the extracted-bundle dir as a positional arg (the same one
`patch-cowork.sh` passes as `$VITE_BUILD_DIR`/`$APP_DIR`); without it the script
exits 1 with a usage error:

```sh
node patches/find-platform-gate.mjs "${BUILD_DIR:-/tmp/claude-build}/app-extracted" --dump-candidates
```

This prints every function that partially matches the platform-gate shape
(reads `process.platform`, compares to `"darwin"`/`"win32"`, returns a
`{status:...}` object).

## 2. Locate the new shape (minified bundle is one ~13 MB line)

NEVER open `.vite/build/index.js` with a whole-file read. Slice byte ranges and
print offsets first (see the `bundle-recon` skill for the full technique):

```sh
export BUNDLE=/tmp/claude-build/app-extracted/.vite/build/index.js   # export so child `node` sees it
# find candidate strings/symbols
node -e 'const s=require("fs").readFileSync(process.env.BUNDLE,"utf8");const re=/process\.platform/g;let m,n=0;while((m=re.exec(s))&&n<40){console.log(m.index,JSON.stringify(s.slice(m.index-50,m.index+80)));n++}'
# read a region once you have an offset
node -e 'const s=require("fs").readFileSync(process.env.BUNDLE,"utf8");process.stdout.write(s.slice(START,END))'
```

## 3. Update the pattern

Edit the matching `patches/find-*.mjs` (e.g. `find-platform-gate.mjs`,
`find-ccd-platform.mjs`, `find-vm-download.mjs`) so its acorn predicate matches
the new shape. Keep it shape-based (structure of the AST), not name-based.

## 4. Re-validate

```sh
rm -f /tmp/claude-build/.patch-cowork-done
./scripts/patch-cowork.sh        # must exit 0
./scripts/validate-bundle.sh     # acorn-checks every .vite/build/*.js
```

Then a full rebuild (`build-packages` skill) and a headless launch check.

## Reference

- `CLAUDE.MD` → "Updating After a Claude Desktop Release" and "Cowork Platform Gate".
- Default-on patches must keep `main` green — fix them in place; do not feature-flag
  them off.
- Bump the pinned version in `nix/stable.json` / `nix/dev.json` only via the CI
  release flow; `check-update.yml` polls the CDN every 6 h and dispatches `build.yml`.
- If a stub method newly logs `MISSING METHOD` / `unknown property`, the
  orchestrator started calling a method the stub doesn't implement — add it to
  `stubs/claude-swift.js` (vm interface) or `stubs/claude-native.js`, matching the
  contract before guessing (see `bundle-recon`).
