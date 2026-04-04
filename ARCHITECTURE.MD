# Architecture

Design decisions, trade-offs, and failure modes for the Claude Desktop Linux rebuild.

---

## Source Selection: macOS DMG vs Windows EXE

Most existing Linux ports use the Windows installer. We use the macOS DMG.

**Why the DMG wins for Cowork:**

The Windows installer contains a `cowork-svc.exe` binary that communicates with
a Hyper-V VM over a named pipe. That named pipe path is hardcoded. To make Cowork
work from the Windows build you have to reverse-engineer `cowork-svc.exe` and
reimplement the pipe protocol — or write a Go daemon that speaks the same protocol
(which is what `patrickjaja/claude-cowork-service` does). Complex, fragile.

The macOS build has a different architecture. The `@ant/claude-swift` module is a
thin JS wrapper around `VZVirtualMachine` (Apple's Swift VM API). The Cowork
orchestrator in `app.asar` communicates with this module via a straightforward
object interface: `vm.spawn()`, `vm.kill()`, `vm.writeStdin()`. That interface is
easy to stub in pure JavaScript.

More importantly: the VM that Cowork boots on macOS runs a **Linux x86_64** root
filesystem. The `claude-code` binary inside it is a Linux ELF binary. So the macOS
app is already 90% a Linux app — it just needs macOS to host the VM.

```
macOS path:
  Claude Desktop (Electron/macOS)
    → @ant/claude-swift (macOS native)
      → Apple VZVirtualMachine
        → Linux rootfs VM
          → claude-code (Linux ELF) ← the actual work happens here

Our path:
  Claude Desktop (Electron/Linux)
    → @ant/claude-swift (our JS stub)
      → child_process.spawn()
        → claude-code (Linux ELF) ← same binary, no VM
```

The stub collapses four layers into one. No VM download, no VSOCK, no VHDX
conversion.

**DMG extraction complexity is manageable:**

```
Claude-1.1.XXXX.dmg
  ↓ dmg2img
claude.img (HFS+)
  ↓ 7z x
Claude/Claude.app/Contents/Resources/
  ├── app.asar
  └── app.asar.unpacked/
```

Two commands. The result is identical to what you get from the Windows path minus
the Windows-specific native module.

---

## Native Module Strategy

Claude Desktop uses two macOS-native Node.js addons. Both must be replaced.

### @ant/claude-native

This is a standard NAPI addon. It provides:

- `KeyboardKey` — an enum of key codes used by the global hotkey system. These
  are plain integer constants. We copy them verbatim from any existing port.
- `getOSVersion()` / `getPlatform()` — used by the Cowork availability check.
  We return `"14.0.0"` and `"darwin"` respectively. This is a deliberate spoof:
  the platform gate in the app checks `getPlatform() === "darwin"` before showing
  the Cowork tab.
- `AuthRequest` — manages the `claude://` OAuth callback. On macOS this talks to
  the system URL handler. On Linux we call `xdg-open` with the URL. The callback
  fires when the user completes the browser OAuth flow and the Claude app receives
  the deep link. For this to work the Linux system must have `claude://` registered
  as a URI scheme — the `.desktop` file and `%post` scriptlet in the RPM handle
  this via `xdg-mime`.
- Everything else — clipboard helpers, notification bridges, hardware identifiers.
  All no-ops. If the app calls one and it returns `undefined`, nothing breaks.

Why not Rust/NAPI like k3d3's `patchy-cnb`? Because a JS stub is auditable in
30 seconds and has zero compilation dependencies. The only downside is that some
type-checking the app might do internally could break if it checks
`instanceof NativeModule` — in practice none of the call sites do this.

### @ant/claude-swift

The export shape matters more than the implementation. The app does:

```js
const swift = require('@ant/claude-swift')
const vm = swift.default.vm
vm.setEventCallbacks({ onReady, onExit, onStdout, onStderr })
await vm.startVM(config)
const pid = await vm.spawn(binary, args, opts)
```

Our stub must match this exactly. `startVM()` immediately calls `onReady()` via
`setImmediate` — this signals to the orchestrator that the "VM" is up and
`spawn()` can be called. `spawn()` delegates to `child_process.spawn()` and wires
stdout/stderr to the registered callbacks.

The critical correctness requirement: `spawn()` must return a stable identifier
that `kill()` and `writeStdin()` can use. We use the child process PID. We keep
a `Map<pid, ChildProcess>` in module scope.

---

## Platform Gate Patching

The app contains a function like this (pre-minification):

```js
function isCoworkSupported() {
  const platform = getPlatform()   // calls our stub → "darwin"
  if (platform === 'darwin') return { status: 'supported' }
  if (platform === 'win32')  return { status: 'supported' }
  return { status: 'unsupported' }
}
```

After minification this becomes something like:

```js
function xPt(){const e=Nt();return e==="darwin"?{status:"supported"}:e==="win32"?{status:"supported"}:{status:"unsupported"}}
```

The function name changes every release. The string literals `"darwin"`,
`"win32"`, `"supported"`, `"unsupported"` are stable.

We patch it to:

```js
function xPt(){return{status:"supported"}}
```

**Why AST instead of regex?**

Regex is fragile against whitespace and minifier output variation. An AST approach
lets us match on structure:

- Function declaration or arrow function expression
- Body contains a conditional chain
- All branches return an object with a `status` property
- The string values are exactly `"supported"` and `"unsupported"`
- The condition references `"darwin"` or `"win32"`

`acorn` parses the minified JS in ~200ms for typical bundle sizes. We walk the
AST with `acorn-walk`, collect candidate functions, score them by how many of
the above criteria they meet, and take the highest-scoring match.

If the top score is below our threshold (all criteria must match), we exit 1 and
print the candidates with their scores. This is the primary failure mode when
Anthropic releases a new version.

**Patch application:**

We don't re-parse and re-emit the whole bundle — that would destroy source maps
and potentially change semantics. Instead we record the character offsets of the
matched function body from the AST, then do a string splice:

```js
const patched = src.slice(0, bodyStart) +
  '{return{status:"supported"}}' +
  src.slice(bodyEnd)
```

Simple, fast, and auditable in the diff.

---

## Path Translation

The Cowork session model addresses the VM filesystem as:

```
/sessions/<uuid>/mnt/<mount-name>/relative/path/to/file
```

These paths appear in RPC messages sent from the Electron process to the
`claude-code` subprocess. We need to redirect them to real host paths.

The translation table is built when the orchestrator calls `vm.spawn()` with
an `additionalMounts` option:

```js
{
  additionalMounts: [
    { name: 'workspace', hostPath: '/home/user/projects/myapp' },
    { name: '.claude',   hostPath: '/home/user/.config/Claude/sessions/…' }
  ]
}
```

We store this as a `Map<mountName, hostPath>` keyed by session UUID.

The translator intercepts `path.join` and `path.resolve` calls where the first
segment matches `/sessions/<uuid>/mnt/<name>` and substitutes the host path.
We also wrap `fs.promises.open`, `fs.promises.readFile`, etc. for the same
prefix — because some code builds paths manually with string concatenation rather
than `path.join`.

**The `/sessions` symlink:**

Some paths are constructed before they pass through our translator. The simplest
fix is a symlink:

```
/sessions → ~/.local/share/claude-linux/sessions
```

This requires `sudo` once at install time. The RPM `%post` scriptlet creates it.
For AppImage, the launcher script creates it if missing, prompting for sudo.

An alternative is to run the Electron process with a user namespace that remounts
`/sessions` — but this adds complexity for minimal benefit.

---

## Bubblewrap Isolation

When `COWORK_BACKEND=bubblewrap`, the `claude-code` subprocess is launched inside
a bubblewrap sandbox instead of directly via `child_process.spawn`.

The sandbox configuration:

```sh
bwrap \
  --unshare-all \
  --share-net \
  --die-with-parent \
  --new-session \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /etc /etc \
  --ro-bind /home /home \
  --bind "$SESSION_DIR" "$SESSION_DIR" \
  --tmpfs /tmp \
  --proc /proc \
  --dev /dev \
  -- claude-code …
```

Key properties:
- Home directory is read-only. `claude-code` can read your files but not write them
  outside the session directory.
- The session working directory (`$SESSION_DIR`) is bind-mounted read-write. This
  is where Cowork writes its output.
- Network access is preserved (`--share-net`). Cowork needs to reach the
  Anthropic API.
- The sandbox dies when the Electron process dies (`--die-with-parent`).

**Limitation:** bubblewrap requires `CAP_SYS_ADMIN` on older kernels for user
namespace creation. Modern kernels (≥5.10) allow unprivileged user namespaces by
default. On Fedora Silverblue this works out of the box.

**Not a VM:** bubblewrap does not provide kernel-level isolation. A sufficiently
motivated exploit in `claude-code` could escape via kernel vulnerabilities. For
personal development use this is an acceptable trade-off. Do not use this for
processing untrusted third-party content in production.

---

## Socket IPC Protocol

Claude Desktop's Cowork and Dispatch features communicate with a backend daemon
over a socket-based IPC protocol.  The protocol uses length-prefixed JSON
messages: a 4-byte big-endian unsigned integer specifying the payload length,
followed by the UTF-8 JSON payload.

```
macOS:   Desktop → @ant/claude-swift → VZVirtualMachine → vsock → sdk-daemon
Windows: Desktop → cowork-svc.exe    → Named Pipe (\\.\\pipe\\cowork-vm-service) → Hyper-V VM → vsock → sdk-daemon
Linux:   Desktop → Unix socket ($XDG_RUNTIME_DIR/cowork-vm-service.sock) → cowork-svc-linux → os/exec
```

On macOS and Windows the daemon runs inside a VM.  On Linux we skip the VM
entirely: the `claude-cowork-service` daemon (MIT licensed, from
`patrickjaja/claude-cowork-service`) listens on a Unix domain socket and
delegates process management to `os/exec`.

`patches/patch-cowork-socket.mjs` rewrites the app's named pipe path
(`\\.\pipe\cowork-vm-service`) to a platform-aware expression that uses the
Unix socket on Linux and preserves the named pipe on Windows.

**Why we use the external daemon instead of reimplementing the protocol:**

The socket protocol has 17+ methods and non-trivial lifecycle management
(process tracking, stdin forwarding, event subscriptions).  The Go daemon
already implements all of this correctly and is MIT-licensed.  Reimplementing
in JS would duplicate effort and introduce bugs.  Our job is to make the
Electron app connect to it — not to rewrite it.

---

## Dispatch on Linux

Dispatch is Anthropic's mobile-to-desktop task delegation feature.  It uses
server-sent events (SSE) for real-time delivery when the app is open, and
push notifications (APNs/FCM) for background delivery when the app is closed.

On Linux:

1. **SSE delivery works** — when the app is open, Dispatch tasks arrive via
   the same SSE connection used for other real-time features.
2. **Push delivery does not work** — APNs is Apple-only, FCM requires a
   registered application identity.  We do not attempt to register with either
   service.

To make Dispatch functional, several GrowthBook feature flags must be
force-enabled.  `patches/patch-dispatch.mjs` finds these by their stable
hash constants (which survive minification) and flips the associated boolean
initializers:

| Sub-patch | Hash constant | Purpose |
|---|---|---|
| A | `3572572142` | Sessions-bridge init gate |
| B | `2216414644` | Remote session control check |
| C | *(structural)* | Platform label ("Darwin"/"Windows" → add "Linux") |
| D | `1143815894` | hostLoopMode — use native host paths instead of VM paths |

Additionally, `stubs/dispatch-polyfill.js` registers IPC handlers for the
Dispatch UI channels so the renderer can render the Dispatch panel without
errors, and `patches/fix-dispatch-gate.mjs` patches any Dispatch-specific
platform gate (separate from the Cowork gate).

---

## Package Format Decisions

### RPM: system Electron, no bundle

The RPM declares `Requires: electron`. The user installs Electron from their
distro or from the official Electron RPM repository. This keeps the RPM small
(~15 MB vs ~200 MB) and ensures security updates to Electron are picked up
automatically via `dnf upgrade`.

Trade-off: if the system Electron version is incompatible with the app.asar,
the app may crash on launch. We write the required Electron version to
`/usr/lib/claude-desktop/ELECTRON_VERSION` so users can debug this.

For Fedora Silverblue specifically: `rpm-ostree install electron claude-desktop`
layers both. A single reboot applies both. Subsequent `dnf upgrade` runs
(via `rpm-ostree upgrade`) update both.

### AppImage: bundled Electron, self-contained

The AppImage bundles the exact Electron version the app was built against. This
eliminates the version mismatch problem at the cost of size and not inheriting
system Electron security updates.

`AppRun` tries the bundled Electron first, then falls back to `$(which electron)`.
This means users who want to use their system Electron can delete
`usr/lib/electron/` from inside the AppImage (after extraction) and the
fallback kicks in.

`--no-sandbox` is required. The FUSE mount used by AppImage sets `nosuid`, which
prevents the `chrome-sandbox` setuid bit from being honoured. Without the sandbox
flag Electron refuses to start. This is a known limitation of AppImage + Electron.

For Silverblue: the AppImage runs directly from the home directory. No
`rpm-ostree` layer, no reboot needed. Requires `fuse-libs` on the host (usually
present) or the `--appimage-extract-and-run` flag as a fallback.

---

## CI/CD Design

### Version detection

The DMG URL pattern is:

```
https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest-apple/Claude-latest.dmg
```

A HEAD request to this URL redirects to the versioned URL:

```
https://…/Claude-1.1.8629.dmg
```

We extract `1.1.8629` from the redirect target filename. This version string
becomes the package version.

We compare it against the latest GitHub release tag (`v1.1.8629`). If the
DMG version is newer, we trigger a build.

### Build caching

| Cached | Key | Reason |
|---|---|---|
| `node_modules` | `package-lock.json` SHA | Patch scripts + asar tool |
| Electron binary | `$ELECTRON_VERSION` | ~100 MB, rarely changes |
| DMG | **Never** | Always fetch fresh to get the real SHA |
| Patched ASAR | **Never** | Must be rebuilt from clean DMG each time |

### Release naming

Tags follow the upstream version: `v1.1.8629`.
Asset names: `claude-desktop-1.1.8629-x86_64.rpm`, `claude-desktop-1.1.8629-x86_64.AppImage`.

Release body is auto-generated and includes:
- Upstream Claude Desktop version
- DMG SHA256
- RPM SHA256
- AppImage SHA256
- Which Electron version is bundled (AppImage) / required (RPM)

---

## Failure Modes and Mitigations

| Failure | Symptom | Detection | Mitigation |
|---|---|---|---|
| Platform gate pattern changed | `patch-cowork.sh` exits 1 | CI fails | `--dump-candidates` flag shows partial matches |
| Electron version incompatible | App crashes immediately | RPM: runtime. AppImage: build | `ELECTRON_VERSION` file; easy to override |
| `@ant/claude-swift` API changed | Cowork tab appears but sessions fail | Runtime | Stub logs unknown method calls to stderr |
| Path translator misses a path | File not found errors in Cowork | Runtime | `COWORK_DEBUG=1` logs all intercepted paths |
| `/sessions` symlink missing | Cowork fails on first run | Runtime | Launcher script checks and prompts to create |
| `xdg-open` not available | OAuth flow broken | Runtime | Stub checks and falls back to printing the URL |
| bubblewrap not installed | Cowork silently uses host backend | `--doctor` flag | Launcher warns; falls back to `host` |
| DMG URL changed | `fetch-dmg.sh` exits 1 | CI fails | Update URL in `fetch-dmg.sh` |
| `cowork-svc-linux` not running | Cowork/Dispatch socket features fail | Runtime | Launcher warns; `scripts/install-cowork-service.sh` |
| GrowthBook flag hash changed | `patch-dispatch.mjs` finds 0 matches | CI warning | Update hash constants in `patch-dispatch.mjs` |

---

## Partial Support

**Dispatch — partially supported.** Dispatch works via SSE when the app is open.
GrowthBook feature flags are force-enabled (`patches/patch-dispatch.mjs`), UI
platform gates are bypassed, and IPC handlers are stubbed.  The
`claude-cowork-service` daemon provides the socket backend that Dispatch's session
management requires.  Background delivery (APNs/FCM push wake-up) is not
available — tasks sent from mobile when the app is closed won't arrive until the
next launch.  See "Dispatch on Linux" section above for details.

## Explicit Non-Goals

**Targeted platform header injection (not general spoofing).**
`stubs/platform-headers.js` injects `Anthropic-Client-OS-Platform: darwin` and
`Anthropic-Client-OS-Version: 14.0` on HTTP requests to `*.anthropic.com` and
`*.claude.ai` only.  Anthropic's server checks these headers to decide whether to
enable Cowork and serve the claude-code binary bundle — without them, Cowork never
activates regardless of local patches.  Every working Linux Cowork implementation
sends these headers.  We do NOT modify User-Agent strings, general browsing
headers, or requests to any non-Anthropic domain.

**No Computer Use.** Requires capturing the screen and injecting mouse/keyboard
events. The current Cowork architecture on macOS uses `AXUIElement` (macOS
Accessibility API) for this. Replacing it with `xdotool`/`scrot` is possible but
produces a fragile implementation that breaks across desktop environments.

**No ARM64.** The macOS DMG contains a universal binary, so the app.asar itself
is architecture-independent. The blocker is Electron: we need to download the
correct Electron build for the target arch, and the CI runner would need to be
ARM64. This is a future milestone.

---

## Security Considerations

This project downloads a proprietary application from Anthropic's CDN and runs
it on your machine. The security model is:

1. We verify the DMG SHA256 against the value we compute on download. We do not
   have a trusted out-of-band source for the expected SHA — we are just ensuring
   the file was not corrupted or tampered with in transit (HTTPS provides the
   transport security).
2. The stubs we inject are small and auditable. They do not make outbound network
   requests. They do not read your files. You can read them in under 5 minutes.
3. The patching modifies a single function in a minified JS bundle. The change is
   a one-liner replacement. The diff is included in each release.
4. The RPM is not GPG-signed in the initial release. Adding signing requires
   a stable GPG key stored as a GitHub Actions secret. This is a planned
   follow-up.
5. The AppImage has no signature. Standard AppImage limitation.
6. `claude-code` itself runs as your user. With `bubblewrap` it cannot write
   outside the session directory. With `host` backend it has full access.
   Default is `bubblewrap`.

The threat model this does **not** protect against: a malicious `app.asar` from
Anthropic's CDN. We trust Anthropic's servers. If you do not, do not use this
project.
