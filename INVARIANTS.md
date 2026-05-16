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
- **`main` must always produce a working build with default env vars.** Any
  patch that breaks this MUST be feature-flagged off by default (gated
  behind `ENABLE_EXPERIMENTAL_PATCHES=1` or an equivalent env var) and
  documented in [README.md → Build Flags](README.md#build-flags). Adding
  a new bundle-mutating patch and letting it run by default before its
  failure modes are understood violates this invariant.

## What This Project Intentionally Does Not Do

> ⚠ DISPUTED — introduced via scope-creep (see
> docs/platform-headers-decision.md). Pending maintainer ratify/revert
> decision. Wording below is NOT ratified.
- **Dispatch — partially supported in default builds, more in experimental.**
  Default builds patch the Dispatch availability gate
  (`patches/fix-dispatch-gate.mjs`), stub the renderer IPC handlers
  (`stubs/dispatch-polyfill.js`), and polyfill Electron's Notification API.
  The GrowthBook feature flag overrides (`patches/patch-dispatch.mjs` —
  sessions-bridge init, remote session control, hostLoopMode) only run
  under `ENABLE_EXPERIMENTAL_PATCHES=1` (see [Build Phases](#build-phases))
  because that patch can corrupt the bundle on some versions. The
  `claude-cowork-service` daemon provides the socket backend that
  Dispatch session management uses when it can run. Background delivery
  (APNs/FCM push wake-up) is unavailable regardless of build flags — tasks
  sent from mobile while the app is closed do not arrive until next launch.
- **No Computer Use.** Requires `xdotool`/`scrot` hacks that are fragile and
  version-sensitive. Out of scope for the initial release.
- **No KVM isolation.** See Cowork Isolation Backends above.

> ⚠ DISPUTED — introduced via scope-creep (see
> docs/platform-headers-decision.md). Pending maintainer ratify/revert
> decision. Wording below is NOT ratified.
- **Platform headers are spoofed only on Anthropic API requests for Cowork
  activation.** `stubs/platform-headers.js` injects `Anthropic-Client-OS-Platform:
  darwin` and `Anthropic-Client-OS-Version: 14.0` on requests to `*.anthropic.com`
  and `*.claude.ai` only.  Without these headers, the server never enables Cowork
  or serves the claude-code binary bundle.  No other domains are affected.  We do
  not modify User-Agent strings or general browsing headers.
- **No ARM64 support yet.** The Electron binary selection and AppImage build are
  x86_64 only. ARM64 is a future milestone.

## Explicit Non-Goals

> ⚠ DISPUTED — introduced via scope-creep (see
> docs/platform-headers-decision.md). Pending maintainer ratify/revert
> decision. Wording below is NOT ratified.
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
<!-- guard adversarial test marker, delete this branch -->
