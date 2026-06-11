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
├── CLAUDE.MD                           ← you are here
├── ARCHITECTURE.MD                     ← detailed design decisions
├── README.md                           ← user-facing install + feature docs
├── flake.nix / flake.lock              ← Nix flake (stable + dev channels)
├── nix/                                ← channel metadata (stable.json / dev.json)
├── package.json / package-lock.json    ← acorn + @electron/asar for AST patches
├── scripts/
│   ├── fetch-and-extract.sh            ← download DMG, SHA256-verify, dmg2img + 7z extract, unpack app.asar, emit VERSION + ELECTRON_VERSION, extract icons
│   ├── inject-stubs.sh                 ← replace @ant/claude-native and @ant/claude-swift with JS stubs
│   ├── patch-cowork.sh                 ← apply Cowork AST patches and prepend CJS shims; gates the three experimental AST patches behind ENABLE_EXPERIMENTAL_PATCHES=1
│   ├── validate-bundle.sh              ← standalone acorn syntax gate (also run inline at the end of patch-cowork.sh)
│   ├── install-cowork-service.sh       ← install claude-cowork-service systemd user daemon (runtime, optional)
│   ├── build-packages.sh               ← orchestrator: re-pack ASAR, then RPM + DEB + Pacman + Nix + AppImage
│   ├── build-rpm.sh                    ← RPM build step
│   ├── build-deb.sh                    ← DEB build step
│   ├── build-pacman.sh                 ← Pacman .pkg.tar.zst build step
│   ├── build-nix.sh                    ← Nix-compatible tarball build step
│   ├── build-appimage.sh               ← AppImage assembly step
│   └── update-appimage.sh              ← wrapper around AppImageUpdate for in-place AppImage replacement
├── stubs/
│   ├── package.json                    ← `{ "type": "commonjs" }` parent for the two replacement modules
│   ├── claude-native.js                ← @ant/claude-native replacement
│   ├── claude-native-pkg.json          ← package.json that ships inside the @ant/claude-native stub
│   ├── claude-swift.js                 ← @ant/claude-swift replacement (Cowork VM API → child_process.spawn)
│   ├── claude-swift-pkg.json           ← package.json that ships inside the @ant/claude-swift stub
│   ├── platform-headers.js             ← Anthropic API header injection (copied next to main entry by patch-cowork.sh)
│   ├── ipc-stubs.js                    ← ComputerUseTcc IPC handler stubs (copied next to main entry)
│   ├── dispatch-polyfill.js            ← Dispatch IPC stubs + foreground polling (copied next to main entry)
│   └── computer-use-linux.js           ← EXPERIMENTAL Linux computer-use backend (grim screenshots + ydotool/wtype input); staged next to @ant/claude-swift only under ENABLE_EXPERIMENTAL_PATCHES=1, activated at runtime by ENABLE_COMPUTER_USE=1 (default off)
├── patches/
│   ├── patch-utils.mjs                 ← shared helpers used by the three experimental AST patches
│   ├── recon-computer-use.mjs          ← READ-ONLY acorn recon of the @ant/claude-swift computerUse contract (writes /tmp/cd-computeruse-recon.md); pairs with the COMPUTER_USE_RECON=1 runtime proxy in stubs/claude-swift.js
│   ├── find-platform-gate.mjs          ← AST search for the Cowork availability gate
│   ├── apply-platform-gate.mjs         ← replace platform-gate body with `return { status: "supported" }`
│   ├── find-ccd-platform.mjs           ← locate CCD getHostPlatform / getBinaryPathIfReady
│   ├── apply-ccd-platform.mjs          ← add linux-x64 / linux-arm64 support to CCD
│   ├── find-vm-download.mjs            ← locate the download_and_sdk_prepare step
│   ├── apply-vm-download.mjs           ← make the VM download step return early on Linux
│   ├── fix-bundle-download.mjs         ← bypass platform check around the binary bundle download
│   ├── fix-dispatch-gate.mjs           ← patch the Dispatch availability gate
│   ├── fix-tray-icon.mjs               ← AST fix for the minifier tray icon variable reference
│   ├── fix-tray-config.sh              ← ensures menuBarEnabled in user config (runtime helper, not run during build)
│   ├── module-load-patch.js            ← shared Module._load interceptor registry (prepended into main bundle)
│   ├── shell-env-patch.js              ← fix shell path worker not found on Linux (prepended)
│   ├── platform-override.js            ← runtime fallback for the platform gate (prepended)
│   ├── native-frame.js                 ← icon injection + tray click handler for Linux (prepended)
│   ├── open-url-bridge.js              ← second-instance → open-url bridge for Linux OAuth (prepended)
│   ├── path-translator.mjs             ← /sessions/<id>/mnt/<name>/… → ~/.local/share/claude-linux/sessions/… (converted ESM→CJS at patch time and prepended)
│   ├── patch-cowork-socket.mjs         ← EXPERIMENTAL — named pipe → Unix socket transport (only runs under ENABLE_EXPERIMENTAL_PATCHES=1)
│   ├── patch-dispatch.mjs              ← EXPERIMENTAL — GrowthBook feature flag overrides (only runs under ENABLE_EXPERIMENTAL_PATCHES=1)
│   └── patch-computer-use-tcc.mjs      ← EXPERIMENTAL — AST injection of ComputerUseTcc stubs (only runs under ENABLE_EXPERIMENTAL_PATCHES=1)
├── packaging/
│   ├── claude-desktop.spec             ← RPM spec file
│   ├── PKGBUILD                        ← Pacman build file
│   ├── claude-desktop.svg              ← fallback SVG icon (PNG icons are extracted at build time by fetch-and-extract.sh into packaging/icons/)
│   └── AppDir/                         ← AppImage skeleton (AppRun, claude-desktop.desktop, usr/)
├── output/                             ← built packages land here
└── .github/
    └── workflows/
        ├── check-update.yml            ← polls for new DMG every 6 h
        ├── build.yml                   ← full build + release
        └── smoke-test.yml              ← smoke tests (syntax, RPM install, headless launch)
```

## Claude Code Skills

Repeatable workflows for this repo live in `.claude/skills/<name>/SKILL.md` and
are auto-discovered by Claude Code:

- `build-packages` — the fetch → inject → patch → build pipeline, guards, env vars.
- `release-update` — adapt to a new Claude Desktop release when an AST pattern stops matching.
- `bundle-recon` — reverse-engineer a symbol/contract in the minified bundle without guessing.
- `computer-use-test` — exercise/diagnose the experimental Linux computer-use backend.

## Invariants — Never Break These

Invariants and non-goals are defined in INVARIANTS.md (change-protected, see .github/workflows/invariant-guard.yml).

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `BUILD_DIR` | `/tmp/claude-build` | Scratch space for extracted files |
| `OUTPUT_DIR` | `./output` | Final packages land here |
| `COWORK_BACKEND` | `bubblewrap` | Cowork isolation: `bubblewrap` or `host` |
| `SKIP_DOWNLOAD` | `` | Set to `1` to reuse existing `$BUILD_DIR/claude.dmg` |
| `ELECTRON_OVERRIDE` | `` | Force a specific Electron version (e.g. `37.0.0`) |
| `COWORK_DEBUG` | `` | Set to `1` for verbose Cowork/header-injection logging |
| `DISPATCH_DEBUG` | `` | Set to `1` for Dispatch IPC traffic logging |
| `DISPATCH_POLL_INTERVAL_MS` | `30000` | Dispatch foreground polling interval (ms) |
| `SKIP_DISPATCH_POLL` | `` | Set to `1` to disable Dispatch polling |
| `ENABLE_EXPERIMENTAL_PATCHES` | `` | Set to `1` to run cowork-socket, dispatch, and computer-use-tcc AST patches (off by default — they corrupt the JS bundle), and to stage `stubs/computer-use-linux.js` next to the `@ant/claude-swift` stub |
| `ENABLE_COMPUTER_USE` | `` | Runtime (read by `stubs/claude-swift.js`). With this AND `ENABLE_EXPERIMENTAL_PATCHES=1` (build), the `computerUse` namespace is backed by `stubs/computer-use-linux.js` (grim/ydotool). Default off → `computerUse` stays `null`. Single-output / no-fractional-scaling v1; full end-to-end also needs bundle changes that are a maintainer decision (INVARIANTS non-goal). |
| `COMPUTER_USE_RECON` | `` | Runtime diagnostic. Replaces `computerUse` with a logging Proxy that appends live calls to `/tmp/cd-computeruse-recon.md` and returns permissive stand-ins. Never modifies the bundle; precedes `ENABLE_COMPUTER_USE`. |
| `VERSION_SUFFIX` | `` | Appended to version in filenames and package metadata (e.g. `~dev.20260404.abc1234`); set automatically by CI |

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
| `cowork-svc-linux` | Optional: Cowork/Dispatch socket daemon (runtime) |

## Build Phases

A full build runs these scripts in order; each is idempotent and writes a
guard file under `$BUILD_DIR` so re-running picks up where the previous
run left off.

1. `scripts/fetch-and-extract.sh` — download DMG, SHA256-verify, convert
   via `dmg2img`, extract with `7z`, unpack `app.asar` via
   `@electron/asar`, emit `$BUILD_DIR/VERSION` and
   `$BUILD_DIR/ELECTRON_VERSION`, extract icons into `packaging/icons/`.
2. `scripts/inject-stubs.sh` — replace `node_modules/@ant/claude-native`
   and `node_modules/@ant/claude-swift` with the JS stubs from `stubs/`.
3. `scripts/patch-cowork.sh` — see breakdown below.
4. `scripts/build-packages.sh` — re-pack `app.asar` once, then build
   `build-rpm.sh`, `build-deb.sh`, `build-pacman.sh`, `build-nix.sh`, and
   `build-appimage.sh` into `$OUTPUT_DIR`.

### Patches applied by `scripts/patch-cowork.sh`

Default-on patches (always run, must keep `main` green; if any of these
starts breaking the build, fix it in place rather than feature-flagging
it off):

- `patches/find-platform-gate.mjs` + `patches/apply-platform-gate.mjs` —
  replace the Cowork availability-gate body with
  `return { status: "supported" }`.
- `patches/fix-tray-icon.mjs` — fix the minifier tray icon variable
  reference (warns on failure, does not exit non-zero).
- `patches/find-ccd-platform.mjs` + `patches/apply-ccd-platform.mjs` —
  add `linux-x64` / `linux-arm64` support to CCD `getHostPlatform` and
  `getBinaryPathIfReady` (warns on failure).
- `patches/find-vm-download.mjs` + `patches/apply-vm-download.mjs` —
  make `download_and_sdk_prepare` return early on Linux (warns on
  failure).
- Inline `sed` guard for `.files[X][Y]` access in the main bundle, so
  `files["linux"]` returning `undefined` does not crash callers.
- `patches/fix-bundle-download.mjs` — bypass the platform check around
  the binary bundle download (warns on failure).
- `patches/fix-dispatch-gate.mjs` — patch the Dispatch availability
  gate (warns on failure). Note this is the *availability* gate only;
  GrowthBook feature flags are not touched in default builds.
- File copies + idempotent prepend into the main entry of these CJS
  shims (every file is copied to the main entry's directory and
  `require()`-ed at the top of the bundle):
  `patches/module-load-patch.js`, `patches/shell-env-patch.js`,
  `stubs/platform-headers.js`, `patches/platform-override.js`,
  `stubs/ipc-stubs.js`, `stubs/dispatch-polyfill.js`,
  `patches/native-frame.js`, `patches/open-url-bridge.js`, and
  `patches/path-translator.mjs` (converted ESM→CJS on the fly).
- Post-patch acorn syntax validation + `scripts/validate-bundle.sh`.

Default-off (experimental) patches — gated behind
`ENABLE_EXPERIMENTAL_PATCHES=1` because they currently corrupt the JS
bundle on some Claude Desktop versions and can cause SIGSEGV on launch
(see `scripts/patch-cowork.sh` lines 342–414 and the `fix_cowork`
branch):

- `patches/patch-cowork-socket.mjs` — rewrites the Cowork socket
  transport from a Windows named pipe to a Linux Unix domain socket.
- `patches/patch-dispatch.mjs` — force-enables the GrowthBook feature
  flags that gate Dispatch (sessions-bridge init, remote session
  control, hostLoopMode).
- `patches/patch-computer-use-tcc.mjs` — AST-injects ComputerUseTcc IPC
  handler stubs into the main bundle.
- Staging of `stubs/computer-use-linux.js` (the EXPERIMENTAL Linux
  computer-use backend) next to the injected `@ant/claude-swift` stub.
  This copy does **not** touch the bundle — it only makes the module
  available for `stubs/claude-swift.js` to `require()` at runtime when
  `ENABLE_COMPUTER_USE=1` is also set. With neither flag, `computerUse`
  stays `null` and behaviour is unchanged. The backend uses `grim`
  (screenshots) and `ydotool`/`wtype` (input); it is v1 (single output,
  no fractional scaling). The interface it implements was reverse-engineered
  read-only by `patches/recon-computer-use.mjs` + the `COMPUTER_USE_RECON=1`
  proxy → `/tmp/cd-computeruse-recon.md`. NOTE: the stock bundle still
  hard-gates Linux computer use (platform set, executor dispatch, capability
  profiles); making it work end-to-end needs further bundle changes that
  touch the `INVARIANTS.md` "No Computer Use" non-goal — a maintainer decision.

Other env vars that affect `patch-cowork.sh` behaviour:

| Variable | Effect |
|---|---|
| `SKIP_COWORK_PATCH=1` | Skip the whole script (no platform-gate patch, no shim prepend). Top-level escape hatch — does not gate the experimental patches selectively. |
| `BUILD_DIR` | Scratch directory (default `/tmp/claude-build`); also where the `.patch-cowork-done` guard lives. |

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

`spawn()` performs three translations before launching:
- **Binary resolution:** `/usr/local/bin/claude` (the VM path) is resolved to
  `~/.config/Claude/claude-code-vm/<latest-version>/claude`, then `which claude`,
  then `which claude-code` as fallbacks.
- **Path translation:** `cwd` and `additionalMounts[].hostPath` containing
  `/sessions/<uuid>/mnt/<name>/…` are mapped to host paths.
- **env.PATH translation:** Each `:` -separated entry in `opts.env.PATH` is
  translated through the same `/sessions/…` mapping.

### Platform Headers (stubs/platform-headers.js)

Injects `Anthropic-Client-OS-Platform: darwin` and `Anthropic-Client-OS-Version:
14.0` into HTTP requests to Anthropic domains (`*.anthropic.com`, `*.claude.ai`).
Three interception layers:

1. `electron.net.request` — Electron's native HTTP client
2. `https.request` / `http.request` — Node.js standard library
3. `session.webRequest.onBeforeSendHeaders` — catches renderer fetch()

Without these headers the server never enables Cowork or serves the claude-code
binary bundle. Set `COWORK_DEBUG=1` to log every injection.

### IPC Stubs (stubs/ipc-stubs.js)

Registers stub `ipcMain.handle()` handlers for `ComputerUseTcc.*` channels.
On macOS these are backed by TCC (Transparency, Consent, and Control).  On Linux
there is no equivalent — the stubs return `{ status: 'not_applicable' }` to
prevent repeated IPC errors from destabilising the session.

### Dispatch Polyfill (stubs/dispatch-polyfill.js)

Makes the Dispatch feature work in the foreground on Linux.  Three components:

1. **IPC handler stubs** — registers handlers the renderer expects:
   `Dispatch.getNotificationPermission`, `Dispatch.requestNotificationPermission`,
   `Dispatch.registerPushToken`, `Dispatch.getState`, etc.  Prevents IPC errors
   and makes the Dispatch UI render correctly.

2. **Foreground polling skeleton** — polls for pending Dispatch tasks when a
   window is focused.  Currently disabled: the polling endpoint has not yet been
   discovered from the minified code.  Set `DISPATCH_DEBUG=1` to log all
   Dispatch-related IPC traffic to help with reverse-engineering.

3. **Native notifications** — when a task arrives (via polling or other means),
   shows a system notification via Electron's Notification API and navigates to
   the task on click.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `DISPATCH_POLL_INTERVAL_MS` | `30000` | Polling interval in milliseconds |
| `SKIP_DISPATCH_POLL` | `` | Set to `1` to disable polling entirely |
| `DISPATCH_DEBUG` | `` | Set to `1` for verbose IPC/polling logging |

**Limitations:** Background delivery (APNs/FCM push) is not available.  Tasks
sent from mobile when the app is closed won't arrive until the next launch.
This is best-effort and may break if Anthropic changes the task-fetch API.

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

No `/sessions` symlink is needed — all path translation happens in-process.
The launcher scripts just ensure `~/.local/share/claude-linux/sessions/` exists
(a regular `mkdir -p`, no sudo required).  This works on immutable distros
(Fedora Silverblue, Kinoite, Universal Blue) where the root filesystem is
read-only.

`patches/path-translator.mjs` is injected as the first `import` in the main
process bundle via a one-line prepend. It monkey-patches `path.join`,
`path.resolve`, and `path.normalize` for the `/sessions/` prefix, wraps all
`fs` methods (sync, async callbacks, and promises), intercepts
`child_process.spawn`/`execFile`/`exec` (translating `cwd` and args), and
wraps `net.connect`/`net.createConnection` for socket paths. Session
directories are auto-created on first encounter.

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

## Socket IPC Protocol (Cowork/Dispatch daemon)

Claude Desktop communicates with a backend daemon over a socket-based IPC
protocol using length-prefixed JSON messages (4-byte big-endian length header
followed by UTF-8 JSON payload).

**Transport per platform:**

```
macOS:   Desktop → @ant/claude-swift → VZVirtualMachine → vsock → sdk-daemon
Windows: Desktop → cowork-svc.exe    → Named Pipe       → Hyper-V VM → vsock → sdk-daemon
Linux:   Desktop → Unix socket       → cowork-svc-linux  → os/exec (no VM)
```

On Linux the `claude-cowork-service` daemon (MIT, from
`patrickjaja/claude-cowork-service`) listens on a Unix domain socket at
`$XDG_RUNTIME_DIR/cowork-vm-service.sock` and handles process lifecycle
directly via `os/exec` — no VM needed.

**Known protocol methods** (length-prefixed JSON-RPC style):

| Method | Description |
|---|---|
| `isRunning` | Check if the daemon is alive |
| `vmStarted` | Check if the (virtual) environment is ready |
| `apiReachable` | Check API connectivity |
| `isGuestConnected` | Check if the guest agent is connected |
| `subscribeEvents` | Subscribe to lifecycle events |
| `writeStdin` | Write to a process's stdin |
| `spawn` | Start a new process |
| `kill` | Kill a running process |
| `readFile` | Read a file from the session filesystem |
| `writeFile` | Write a file to the session filesystem |
| `listDir` | List directory contents |
| `getSystemInfo` | Get system information |
| `getNetworkInfo` | Get network configuration |
| `ping` | Health check |
| `shutdown` | Gracefully stop the daemon |
| `getVersion` | Get daemon version |
| `configure` | Update runtime configuration |

**Installation:**

```sh
./scripts/install-cowork-service.sh
```

This downloads the pre-built binary, installs it to `~/.local/bin/`, creates
a systemd user service, and verifies the socket appears.  The launcher scripts
warn if the service is not running but do not block app launch.

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

## Release Channels

This project has two release channels that share the same codebase:

| Channel | Branch | GitHub Release | gh-pages path | .repo file |
|---------|--------|----------------|---------------|------------|
| Stable  | `main` | Regular (Latest) | `/stable/` | `claude-desktop.repo` |
| Dev     | `dev`  | Pre-release | `/dev/` | `claude-desktop-dev.repo` |

Feature branches (`fix_cowork`, `feat/**`, `fix/**`) produce workflow artifacts
only, never published. Download them from the Actions tab for local testing.

The channel is determined automatically by `.github/workflows/build.yml` via
the `determine-channel` job. Manual dispatch can override with the `channel`
input (choices: `auto`, `stable`, `dev`, `none`).

Dev releases use version suffix `~dev.YYYYMMDD.shortsha` (tilde ensures
correct RPM/DEB version sorting so `dnf upgrade` / `apt upgrade` never moves
stable users to dev). The `prerelease: true` flag on GitHub Releases ensures:
- `/releases/latest` API skips dev releases
- "Latest Release" badge on the repo page stays on stable
- Yellow "Pre-release" badge appears on dev releases
- Package manager repos (`claude-desktop.repo` vs `claude-desktop-dev.repo`)
  point to separate gh-pages subdirectories (`/stable/` vs `/dev/`)

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
2. `fetch-and-extract.sh` → download DMG, SHA256-verify, extract
   `app.asar`, emit `VERSION` + `ELECTRON_VERSION`, extract icons
3. `inject-stubs.sh` → replace `@ant/claude-native` and `@ant/claude-swift`
   with the JS stubs in `stubs/`
4. `patch-cowork.sh` → run the default-on patches listed under
   [Build Phases](#build-phases); experimental AST patches stay off
   unless `ENABLE_EXPERIMENTAL_PATCHES=1` is set
5. `build-packages.sh` → re-pack ASAR, build RPM + DEB + Pacman + Nix +
   AppImage
6. Upload artifacts
7. Create GitHub Release with the packages and their `.sha256` files as
   assets

Cache keys: `node_modules` by `package-lock.json` hash; Electron binary by
version string. The DMG is never cached — always fetch fresh.

## What This Project Intentionally Does Not Do

Invariants and non-goals are defined in INVARIANTS.md (change-protected, see .github/workflows/invariant-guard.yml).

## Updating After a Claude Desktop Release

When `find-platform-gate.mjs` exits 1 on a new version:

1. Run `node patches/find-platform-gate.mjs "$BUILD_DIR/app-extracted" --dump-candidates`
   (the extracted-bundle dir is a required positional arg) to print all
   functions that partially match.
2. Inspect the candidates and identify the new gate function shape.
3. Update the AST pattern in `find-platform-gate.mjs`.
4. Commit and push — the next `check-update.yml` run will use the updated pattern.

## Automated Quality Gates

Every push to main, dev, and feature branches runs the smoke test workflow
(`.github/workflows/smoke-test.yml`):

1. **Bundle validation** — `scripts/validate-bundle.sh` runs acorn on every
   `.vite/build/*.js` file after patches are applied. Any syntax error fails
   the build before the asar is repacked. This is also wired into
   `scripts/patch-cowork.sh` as an inline gate.

2. **RPM install test** — builds the RPM in a Fedora 41 container, installs
   it, verifies all expected files land in the right locations.

3. **Headless launch test** — runs the installed `claude-desktop` under Xvfb
   for 10 seconds. Fails on SIGSEGV, process death within 5 seconds, or
   explicit fatal errors in the log.

These catch broken JS bundles, missing dependencies, and crash-on-launch
regressions. They do NOT catch:
- GUI interaction bugs (requires a real display and human)
- Cowork session failures (requires orchestrator interaction)
- Wayland/compositor-specific issues (container is X11-only)
- DBus/systemd-dependent features

Final validation before release is still manual on a real Silverblue install.

To run smoke tests locally:
```bash
./scripts/validate-bundle.sh          # standalone syntax check (after patches)
```

After merging the workflow, add `smoke-test-summary` as a required status check
on the `main` and `dev` branches via repo Settings → Branches → Branch
protection rules.

## License

Build scripts: MIT.  
Claude Desktop application: Anthropic's proprietary license. This project
downloads it directly from Anthropic's CDN and does not redistribute it.
