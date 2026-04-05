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
│   ├── install-cowork-service.sh ← install claude-cowork-service daemon
│   ├── validate-bundle.sh        ← standalone JS syntax validation gate
│   └── build-packages.sh        ← RPM + AppImage assembly
├── stubs/
│   ├── claude-native.js         ← @ant/claude-native replacement
│   ├── claude-swift.js          ← @ant/claude-swift replacement (Cowork VM API)
│   ├── platform-headers.js      ← Anthropic API header injection for Cowork
│   ├── ipc-stubs.js             ← ComputerUseTcc IPC handler stubs
│   └── dispatch-polyfill.js     ← Dispatch IPC stubs + foreground polling
├── patches/
│   ├── find-platform-gate.mjs   ← AST search for the Cowork gate function
│   ├── fix-tray-icon.mjs        ← AST fix for minifier tray icon variable bug
│   ├── fix-tray-config.sh       ← ensure menuBarEnabled in user config
│   ├── fix-bundle-download.mjs  ← AST patch for platform-gated binary download
│   ├── fix-dispatch-gate.mjs    ← AST patch for Dispatch availability gate
│   ├── patch-cowork-socket.mjs  ← AST patch: named pipe → Unix socket
│   ├── patch-dispatch.mjs       ← AST patch: GrowthBook feature flag overrides
│   ├── patch-computer-use-tcc.mjs ← AST injection of ComputerUseTcc stubs
│   └── path-translator.mjs      ← /sessions/… → ~/.local/share/… remapping
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
        ├── build.yml            ← full build + release
        └── smoke-test.yml       ← smoke tests (syntax, RPM install, headless launch)
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
| `COWORK_DEBUG` | `` | Set to `1` for verbose Cowork/header-injection logging |
| `DISPATCH_DEBUG` | `` | Set to `1` for Dispatch IPC traffic logging |
| `DISPATCH_POLL_INTERVAL_MS` | `30000` | Dispatch foreground polling interval (ms) |
| `SKIP_DISPATCH_POLL` | `` | Set to `1` to disable Dispatch polling |
| `ENABLE_EXPERIMENTAL_PATCHES` | `` | Set to `1` to run cowork-socket, dispatch, and computer-use-tcc AST patches (off by default — they corrupt the JS bundle) |
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

- **Dispatch — partially supported.** Dispatch works via SSE when the app is
  open.  GrowthBook feature flags are force-enabled by `patches/patch-dispatch.mjs`
  (sessions-bridge init, remote session control, hostLoopMode).  UI platform gates
  are bypassed, IPC handlers are stubbed (`stubs/dispatch-polyfill.js`), and
  Electron's Notification API is polyfilled.  The `claude-cowork-service` daemon
  provides the socket backend that Dispatch's session management requires.
  Background delivery (APNs/FCM push wake-up) is not available; tasks sent from
  mobile when the app is closed won't arrive until next launch.
- **No Computer Use.** Requires `xdotool`/`scrot` hacks that are fragile and
  version-sensitive. Out of scope for the initial release.
- **No KVM isolation.** See Cowork Isolation Backends above.
- **Platform headers are spoofed only on Anthropic API requests for Cowork
  activation.** `stubs/platform-headers.js` injects `Anthropic-Client-OS-Platform:
  darwin` and `Anthropic-Client-OS-Version: 14.0` on requests to `*.anthropic.com`
  and `*.claude.ai` only.  Without these headers, the server never enables Cowork
  or serves the claude-code binary bundle.  No other domains are affected.  We do
  not modify User-Agent strings or general browsing headers.
- **No ARM64 support yet.** The Electron binary selection and AppImage build are
  x86_64 only. ARM64 is a future milestone.

## Updating After a Claude Desktop Release

When `find-platform-gate.mjs` exits 1 on a new version:

1. Run `node patches/find-platform-gate.mjs --dump-candidates` to print all
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
