---
name: build-packages
description: Run the claude-desktop-linux build pipeline — fetch-and-extract, inject-stubs, patch-cowork, build-packages — to produce RPM/DEB/Pacman/Nix/AppImage from the macOS DMG. Use when asked to build the app, produce packages, do a full/clean build, rebuild after changing a stub or patch, or test that the pipeline still completes. Covers the idempotency guards, env vars (BUILD_DIR, SKIP_DOWNLOAD, COWORK_BACKEND, ENABLE_EXPERIMENTAL_PATCHES), and how to force a re-run of a single stage.
---

# Build the Linux packages

Four scripts run in order; each is idempotent and writes a guard file under
`$BUILD_DIR` (default `/tmp/claude-build`), so re-running resumes where the last
run stopped. To force a stage to re-run, delete its guard.

```sh
./scripts/fetch-and-extract.sh   # download DMG, SHA256-verify, dmg2img + 7z, unpack app.asar,
                                 # emit $BUILD_DIR/VERSION + ELECTRON_VERSION, extract icons
./scripts/inject-stubs.sh        # replace @ant/claude-native + @ant/claude-swift with stubs/
./scripts/patch-cowork.sh        # default-on AST patches + prepend CJS shims; unlocks Cowork UI
./scripts/build-packages.sh      # re-pack app.asar once, then RPM + DEB + Pacman + Nix + AppImage → $OUTPUT_DIR
```

## Guards (delete to re-run a stage)

| Stage | Guard file |
|---|---|
| fetch-and-extract | `$BUILD_DIR/.fetch-and-extract-done` |
| inject-stubs | `$BUILD_DIR/.inject-stubs-done` (also re-runs automatically if `stubs/claude-native.js` or `stubs/claude-swift.js` changed — it hashes them) |
| patch-cowork | `$BUILD_DIR/.patch-cowork-done` |

`inject-stubs` only re-hashes `claude-native.js` and `claude-swift.js`. If you
changed another staged file (e.g. `stubs/computer-use-linux.js`,
`stubs/dispatch-polyfill.js`, `patches/*.js`), delete `.patch-cowork-done` and
re-run `patch-cowork.sh`.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `BUILD_DIR` | `/tmp/claude-build` | Scratch dir + guard files |
| `OUTPUT_DIR` | `./output` | Where packages land |
| `SKIP_DOWNLOAD` | unset | `1` reuses the existing `$BUILD_DIR/claude.dmg` (skip the slow download) |
| `COWORK_BACKEND` | `bubblewrap` | `bubblewrap` (sandbox) or `host` (no isolation) — runtime, not build |
| `ELECTRON_OVERRIDE` | unset | Force a specific Electron version |
| `ENABLE_EXPERIMENTAL_PATCHES` | unset | `1` additionally runs the experimental AST patches AND stages `stubs/computer-use-linux.js` (off by default — those AST patches can corrupt the bundle) |
| `SKIP_COWORK_PATCH` | unset | `1` skips `patch-cowork.sh` entirely |

## Verify without a full build

- Syntax-gate every stub/patch: `node --check stubs/*.js` and `bash -n scripts/*.sh`.
- After `patch-cowork.sh`, the bundle is acorn-validated inline and by
  `./scripts/validate-bundle.sh` (runs acorn on every `.vite/build/*.js`). Run it
  standalone to confirm no patch produced invalid JS.
- A typical local loop: `SKIP_DOWNLOAD=1 ./scripts/fetch-and-extract.sh` then the
  remaining three scripts.

## Notes

- Build dependencies (`dmg2img`, `7z`, `npx asar`, `rpmbuild`, `appimagetool`,
  `icns2png`/`magick`) are resolved at runtime; scripts print install hints if missing.
- The DMG is never cached — always fetched fresh and SHA256-verified.
- CI runs the same four scripts on `ubuntu-latest` (`.github/workflows/build.yml`).
- See `CLAUDE.MD` → "Build Phases" for the authoritative per-script breakdown.
