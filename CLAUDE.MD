# Claude Desktop Linux Rebuild

Unofficial repackage of the macOS Claude Desktop application for Linux.
Produces RPM and AppImage packages from the official macOS DMG.

## What This Project Does

Anthropic ships Claude Desktop for macOS and Windows only. On macOS, the Cowork
feature runs Claude Code inside a lightweight Linux VM using Apple's Virtualization
Framework. This project extracts the application from the macOS DMG, stubs out the
two macOS-native Node modules, patches the platform gate that hides Cowork on
non-macOS systems, and repackages the result for Linux.

The core insight: the VM inside Cowork already runs Linux. On Linux we skip the VM
entirely and run the Claude Code binary directly on the host.

## Repository Layout

```
.
├── CLAUDE.md                    ← you are here
├── ARCHITECTURE.md              ← detailed design decisions
├── scripts/
│   ├── fetch-dmg.sh             ← download + SHA256-verify the DMG
│   ├── extract-asar.sh          ← DMG → app.asar + detect versions
│   ├── inject-stubs.sh          ← replace native modules with JS stubs
│   ├── patch-cowork.sh          ← unlock Cowork on Linux
│   └── build-packages.sh        ← RPM + AppImage assembly
├── stubs/
│   ├── claude-native.js         ← @ant/claude-native replacement
│   └── claude-swift.js          ← @ant/claude-swift replacement (Cowork VM API)
├── patches/
│   ├── find-platform-gate.mjs   ← AST search for the Cowork gate function
│   └── path-translator.js       ← /sessions/… → ~/.local/share/… remapping
├── packaging/
│   ├── claude-desktop.spec      ← RPM spec file
│   ├── AppDir/                  ← AppImage skeleton
│   │   ├── AppRun
│   │   ├── claude-desktop.desktop
│   │   └── usr/
│   └── icons/                   ← extracted PNG sizes 16…512
└── .github/
    └── workflows/
        ├── check-update.yml     ← polls for new DMG every 6 h
        └── build.yml            ← full build + release
```

## Invariants — Never Break These

- **All scripts must be idempotent.** Running a script twice must produce the same
  result as running it once. Use guard files (`$BUILD_DIR/.step-done`) to skip
  completed steps.
- **Every downloaded file must be SHA256-verified** before use. Store the checksum
  next to the file as `<file>.sha256`.
- **Patches must self-validate.** If a patch cannot find the pattern it is looking
  for, it must exit 1 with a clear diagnostic message. A silently no-op patch is
  worse than a build failure.
- **No hardcoded versions anywhere.** Claude Desktop version, Electron version, and
  DMG URL are all discovered at runtime from the DMG itself.
- **`set -euo pipefail`** at the top of every shell script.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `BUILD_DIR` | `/tmp/claude-build` | Scratch space for extracted files |
| `OUTPUT_DIR` | `./output` | Final packages land here |
| `COWORK_BACKEND` | `bubblewrap` | Cowork isolation: `bubblewrap` or `host` |
| `SKIP_DOWNLOAD` | `` | Set to `1` to reuse existing `$BUILD_DIR/claude.dmg` |
| `ELECTRON_OVERRIDE` | `` | Force a specific Electron version (e.g. `37.0.0`) |

## Build Dependencies

Resolved at runtime if missing; the scripts will print install instructions.

| Tool | Used for |
|---|---|
| `dmg2img` | Convert DMG to raw image |
| `7z` (p7zip) | Extract raw image contents |
| `npx asar` / `@electron/asar` | Pack and unpack app.asar |
| `node` ≥ 20 | Patch scripts (ESM) |
| `rpmbuild` | Build RPM |
| `appimagetool` | Build AppImage |
| `icns2png` or `magick` | Convert macOS icon to PNG |
| `bubblewrap` (`bwrap`) | Cowork sandbox (runtime, not build) |
| `electron` | Runtime; bundled inside AppImage |

## Key Files Inside the Extracted ASAR

These paths are relative to `$BUILD_DIR/app-extracted/` and are the ones our
patches touch. They may shift between Claude Desktop versions.

```
package.json                          ← app version, electron engine field
.vite/build/index.js                  ← main process bundle (minified)
.vite/build/preload.js                ← preload script
node_modules/@ant/claude-native/      ← replaced by stubs/claude-native.js
node_modules/@ant/claude-swift/       ← replaced by stubs/claude-swift.js
```

## Native Module Stubs

### @ant/claude-native

macOS-only native addon. Provides:
- `KeyboardKey` enum — keyboard constant map used by the hotkey system
- `getOSVersion()` — returns macOS version string
- `getPlatform()` — returns `"darwin"`
- `AuthRequest` class — handles OAuth deep-link (`claude://…`)

Our stub spoofs `getOSVersion()` → `"14.0.0"` (macOS Sonoma) and
`getPlatform()` → `"darwin"`. This is the minimum required to pass the Cowork
availability check. `AuthRequest` opens the URL via `xdg-open`. All other methods
are silent no-ops.

### @ant/claude-swift

Thin JS wrapper around Apple's `VZVirtualMachine` (via Swift). Exposes a `vm`
object that the Cowork orchestrator uses to control the Linux VM.

Our stub implements the same interface but delegates directly to
`child_process.spawn`. The VM path namespace (`/sessions/<id>/mnt/<folder>`) is
translated to real host paths via the path translator.

Export shape (important — the app does `require(…).default.vm`):

```js
module.exports = {
  default: {
    vm: { setEventCallbacks, startVM, spawn, kill, writeStdin, isRunning }
  }
}
```

## Cowork Platform Gate

Every Claude Desktop release contains a minified function that checks whether
Cowork is supported on the current platform. The function body has a stable
*shape* even though the minifier renames it each release.

Signature pattern: a function that reads `process.platform`, checks it against
`"darwin"` (and since Windows support, also `"win32"`), and returns
`{ status: "supported" }` or `{ status: "unsupported" }`.

`patches/find-platform-gate.mjs` uses the `acorn` AST parser to find this
function without relying on its name. It then replaces the body with an
unconditional `return { status: "supported" }`.

If the pattern is not found the script exits 1 — do not suppress this error.
It means a Claude Desktop update changed the shape and the pattern needs updating.

## Path Translation

The Cowork orchestrator addresses the VM filesystem as:

```
/sessions/<session-id>/mnt/<mount-name>/…
```

On Linux there is no VM, so we redirect these paths to:

```
~/.local/share/claude-linux/sessions/<session-id>/<mount-name>/…
```

A symlink `sudo ln -sf ~/.local/share/claude-linux/sessions /sessions` is needed
to handle absolute paths the app constructs before our translation layer sees
them.  The symlink is created by the **launcher script** at runtime (as the
invoking user), not by the RPM/pacman post-install scriptlet.  Package scriptlets
run as root and do not know the end user's `$HOME`, so they cannot set the correct
symlink target.  Both `packaging/AppDir/usr/bin/claude-desktop` (RPM/system
launcher) and `packaging/AppDir/AppRun` (AppImage) handle this identically.

`patches/path-translator.js` is injected as the first `require` in the main
process bundle via a one-line prepend. It monkey-patches `path.join` and
`path.resolve` for the specific prefix, and wraps `fs.promises` methods for
the same prefix. Keep the patch as small as possible.

## Cowork Isolation Backends

| Backend | Isolation | Requirements |
|---|---|---|
| `bubblewrap` | Namespace sandbox. Home dir read-only; only the session working directory is writable. | `bwrap` installed |
| `host` | None. Claude Code runs as the current user with full filesystem access. | Nothing extra |

Default is `bubblewrap`. The `COWORK_BACKEND=host` env var switches to host mode.
The launcher script reads this variable before execing Electron.

KVM/QEMU is intentionally not implemented. Anthropic blocks VM image downloads
for Linux; the infrastructure would be complex; and bubblewrap provides adequate
isolation for personal use.

## Packaging Notes

### RPM

- The spec file reads `Version:` from the `$BUILD_DIR/VERSION` file written by
  `extract-asar.sh`.
- Electron is declared as a `Requires:` dependency and resolved from the system.
  The AppImage bundles its own Electron; the RPM does not.
- `%post` runs `update-desktop-database` and registers the `claude://` URI scheme
  via `xdg-mime`.

### AppImage

- Bundles the exact Electron version detected from the ASAR (`$BUILD_DIR/ELECTRON_VERSION`).
- `AppRun` prefers the bundled Electron but falls back to the system `electron`
  binary if the bundled one is absent.
- Run with `--no-sandbox` because the AppImage FUSE mount prevents the
  `chrome-sandbox` setuid bit from taking effect.
- Output filename: `claude-desktop-<version>-x86_64.AppImage`

## GitHub Actions

### check-update.yml

Runs every 6 hours. Resolves the current DMG URL via a HEAD request following
redirects, extracts the version from the filename, compares against the latest
GitHub release tag, and triggers `build.yml` via `workflow_dispatch` if a new
version is found.

### build.yml

Triggered by `check-update.yml` or manual dispatch (with optional `version`
input). Runs on `ubuntu-latest`. Steps:

1. Install build dependencies via `apt-get` + `npm`
2. `fetch-dmg.sh` → download and verify DMG
3. `extract-asar.sh` → unpack, detect versions
4. `inject-stubs.sh` → replace native modules
5. `patch-cowork.sh` → platform gate + path translator
6. `build-packages.sh` → RPM + AppImage
7. Upload artifacts
8. Create GitHub Release with RPM, AppImage, and `.sha256` files as assets

Cache keys: `node_modules` by `package-lock.json` hash; Electron binary by
version string. The DMG is never cached — always fetch fresh.

## What This Project Intentionally Does Not Do

- **Partial Dispatch support.** UI platform gates are bypassed via IPC
  interception and `claude-native.js` stubs (`isDispatchSupported`,
  `getDispatchAvailability`). Electron's Notification API is polyfilled.
  Background delivery via APNs/FCM push notifications is not available —
  the app must be running to process Dispatch tasks.
- **No Computer Use.** Requires `xdotool`/`scrot` hacks that are fragile and
  version-sensitive. Out of scope for the initial release.
- **No KVM isolation.** See Cowork Isolation Backends above.
- **No platform header spoofing beyond getOSVersion/getPlatform stubs.** We do
  not modify HTTP headers or User-Agent strings sent to Anthropic servers.
- **No ARM64 support yet.** The Electron binary selection and AppImage build are
  x86_64 only. ARM64 is a future milestone.

## Updating After a Claude Desktop Release

When `find-platform-gate.mjs` exits 1 on a new version:

1. Run `node patches/find-platform-gate.mjs --dump-candidates` to print all
   functions that partially match.
2. Inspect the candidates and identify the new gate function shape.
3. Update the AST pattern in `find-platform-gate.mjs`.
4. Commit and push — the next `check-update.yml` run will use the updated pattern.

## License

Build scripts: MIT.  
Claude Desktop application: Anthropic's proprietary license. This project
downloads it directly from Anthropic's CDN and does not redistribute it.
