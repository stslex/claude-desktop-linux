# Claude Desktop Linux State Audit: Gemini-1.5-Pro

**Date:** Saturday, May 16, 2026  
**Auditor:** Gemini-1.5-Pro (Interactive CLI Agent)  
**Repository:** `stslex/claude-desktop-linux`  
**Status:** READ-ONLY State Audit

---

## SECTION 1: FULL FILE INVENTORY

| path | language | one-line ACTUAL purpose [CODE] | referenced in CLAUDE.MD? (Y/N) |
|---|---|---|---|
| `.gitignore` | Ignore | Git ignore patterns | N (DRIFT) |
| `ARCHITECTURE.MD` | Markdown | Design decisions and trade-offs documentation | Y |
| `CLAUDE.MD` | Markdown | Authoritative spec: repository layout, invariants, and build phases | Y |
| `flake.lock` | JSON | Nix flake lock file | Y |
| `flake.nix` | Nix | Nix flake for stable and dev channels | Y |
| `LICENSE` | Text | MIT License for the project scripts | N (DRIFT) |
| `package-lock.json` | JSON | Node.js lock file for build-time dependencies | Y |
| `package.json` | JSON | Build-time dependencies (acorn, asar) and scripts | Y |
| `README.md` | Markdown | User-facing documentation and installation guide | Y |
| `scripts/build-appimage.sh` | Bash | Orchestrates AppImage assembly and bundling | Y |
| `scripts/build-deb.sh` | Bash | Orchestrates DEB package assembly | Y |
| `scripts/build-nix.sh` | Bash | Orchestrates Nix-compatible tarball assembly | Y |
| `scripts/build-packages.sh` | Bash | Master orchestrator: packs ASAR and calls all package builders | Y |
| `scripts/build-pacman.sh` | Bash | Orchestrates Pacman (.pkg.tar.zst) assembly | Y |
| `scripts/build-rpm.sh` | Bash | Orchestrates RPM assembly and optional signing | Y |
| `scripts/fetch-and-extract.sh` | Bash | Downloads ZIP/DMG, extracts app.asar, detect versions, and icons | Y |
| `scripts/inject-stubs.sh` | Bash | Replaces native modules with JS stubs in the extracted app tree | Y |
| `scripts/install-cowork-service.sh` | Bash | Runtime helper to install the optional Cowork socket daemon | Y |
| `scripts/patch-cowork.sh` | Bash | Applies AST patches to the bundle and prepends CJS shims | Y |
| `scripts/update-appimage.sh` | Bash | Wrapper around AppImageUpdate for in-place replacement | Y |
| `scripts/validate-bundle.sh` | Bash | Standalone syntax gate for patched JS bundles | Y |
| `patches/apply-ccd-platform.mjs` | JS | Replaces getHostPlatform/getBinaryPathIfReady with Linux support | Y |
| `patches/apply-platform-gate.mjs` | JS | Replaces the Cowork gate body with `return {status:"supported"}` | Y |
| `patches/apply-vm-download.mjs` | JS | Patches download_and_sdk_prepare to return early on Linux | Y |
| `patches/find-ccd-platform.mjs` | JS | AST search for CCD-specific platform check functions | Y |
| `patches/find-platform-gate.mjs` | JS | AST search for the minified Cowork availability gate | Y |
| `patches/find-vm-download.mjs` | JS | AST search for the VM/SDK download step | Y |
| `patches/fix-bundle-download.mjs` | JS | Bypasses the platform check for binary bundle downloads | Y |
| `patches/fix-dispatch-gate.mjs` | JS | Patches the Dispatch-specific availability gate | Y |
| `patches/fix-tray-config.sh` | Bash | Runtime helper to force menuBarEnabled:true in config.json | Y |
| `patches/fix-tray-icon.mjs` | JS | Patches minifier bug where 'nativeTheme' is accessed on undefined | Y |
| `patches/module-load-patch.js` | JS | Shared Module._load interceptor registry (prepended shim) | Y |
| `patches/native-frame.js` | JS | BrowserWindow icon injection and Tray click/icon patching | Y |
| `patches/open-url-bridge.js` | JS | Second-instance event → open-url event bridge for OAuth | Y |
| `patches/patch-computer-use-tcc.mjs` | JS | AST injection of ComputerUseTcc IPC handler stubs (EXPERIMENTAL) | Y |
| `patches/patch-cowork-socket.mjs` | JS | Named pipe → Unix socket transport rewrite (EXPERIMENTAL) | Y |
| `patches/patch-dispatch.mjs` | JS | GrowthBook feature flag overrides for Dispatch (EXPERIMENTAL) | Y |
| `patches/patch-utils.mjs` | JS | Shared AST-patching utilities and Score helpers | Y |
| `patches/path-translator.mjs` | JS | Intercepts fs/path/cp to remap /sessions/ to host paths | Y |
| `patches/platform-override.js` | JS | Runtime fallback for the Cowork platform gate (prepended) | Y |
| `patches/shell-env-patch.js` | JS | Fixes shell path worker not found on Linux (prepended) | Y |
| `stubs/claude-native-pkg.json` | JSON | package.json for the @ant/claude-native stub | Y |
| `stubs/claude-native.js` | JS | Stub for @ant/claude-native (platform/auth spoofs) | Y |
| `stubs/claude-swift-pkg.json` | JSON | package.json for the @ant/claude-swift stub | Y |
| `stubs/claude-swift.js` | JS | Stub for @ant/claude-swift (VM API → child_process.spawn) | Y |
| `stubs/dispatch-polyfill.js` | JS | Dispatch IPC stubs and foreground polling skeleton | Y |
| `stubs/ipc-stubs.js` | JS | ComputerUseTcc IPC handler stubs | Y |
| `stubs/package.json` | JSON | Parent package.json for the stub directory | Y |
| `stubs/platform-headers.js` | JS | Injects Anthropic-Client-OS-* headers into HTTP requests | Y |
| `packaging/claude-desktop.spec` | Spec | RPM package specification | Y |
| `packaging/claude-desktop.svg` | SVG | Fallback scalable app icon | Y |
| `packaging/PKGBUILD` | Text | Pacman package build file | Y |
| `packaging/AppDir/AppRun` | Bash | AppImage entry point script | Y |
| `packaging/AppDir/claude-desktop.desktop` | Desktop | Desktop entry file (Freedesktop spec) | Y |
| `packaging/AppDir/usr/bin/claude-desktop` | Bash | Launcher script (copied to /usr/bin in RPM) | Y |
| `.github/workflows/build.yml` | YAML | Main build and release pipeline | Y |
| `.github/workflows/check-update.yml` | YAML | Polling workflow for upstream DMG updates | Y |
| `.github/workflows/smoke-test.yml` | YAML | Quality gate: bundle validation and install tests | Y |

---

## SECTION 2: PATCH & STUB STATE

| file | what it patches/stubs [CODE] | enabled by default? | gated behind which env var? | evidence (line range) |
|---|---|---|---|---|
| `scripts/patch-cowork.sh` | Main patch orchestrator | Y | `SKIP_COWORK_PATCH=1` (to skip) | 1-450 |
| `patches/patch-cowork-socket.mjs` | Named pipe → Unix socket | N | `ENABLE_EXPERIMENTAL_PATCHES=1` | 344-361 |
| `patches/patch-dispatch.mjs` | GrowthBook feature flags | N | `ENABLE_EXPERIMENTAL_PATCHES=1` | 363-382 |
| `patches/patch-computer-use-tcc.mjs` | ComputerUseTcc stubs | N | `ENABLE_EXPERIMENTAL_PATCHES=1` | 384-403 |
| `stubs/claude-native.js` | @ant/claude-native | Y | N/A | 1-182 |
| `stubs/claude-swift.js` | @ant/claude-swift | Y | N/A | 1-375 |

**Specific Questions:**
- **Which patches are behind `ENABLE_EXPERIMENTAL_PATCHES`?**
  [CODE] `patch-cowork-socket.mjs`, `patch-dispatch.mjs`, and `patch-computer-use-tcc.mjs` are gated in `scripts/patch-cowork.sh` (lines 342-414).
- **Does `stubs/claude-swift.js` use a Proxy catch-all?**
  [CODE] YES (lines 352-368).
  [CODE] Catch-all return value for unknown method access:
  ```js
  return function noop(...args) {
    process.stderr.write(
      `[claude-swift stub] noop call: ${String(prop)}(${args.length} args)\n`
    );
    return undefined;
  };
  ```
- **Methods explicitly implemented on the `vm` object in `stubs/claude-swift.js`:**
  - `setEventCallbacks`: `undefined` (sync value) (lines 142-144)
  - `startVM`: `Promise<void>` (lines 152-160)
  - `spawn`: `Promise<void>` (lines 175-234)
  - `kill`: `Promise<void>` (lines 241-247)
  - `writeStdin`: `undefined` (sync value) (lines 253-258)
  - `isGuestConnected`: `Promise<boolean>` (lines 264-266)
  - `setGuestRequestCallback`: `undefined` (sync value) (lines 272-274)
  - `sendGuestResponse`: `undefined` (sync value) (line 280)
  - `getBalloonState`: `{ currentMemoryMB: number, targetMemoryMB: number }` (lines 286-289)
  - `getHostMemoryInfo`: `{ totalMemoryMB: number, freeMemoryMB: number }` (lines 295-299)
  - `isProcessRunning`: `Promise<{running: boolean, exitCode?: number}>` (lines 306-308)
  - `installSdk`: `Promise<void>` (lines 314-316)
  - `addApprovedOauthToken`: `undefined` (sync value) (line 322)
  - `getSessionsDiskInfo`: `{ totalBytes: number, freeBytes: number, sessions: Array }` (lines 328-331)
  - `deleteSessionDirs`: `Promise<{ deleted: string[], errors: object }>` (lines 337-339)
  - `stopVM`: `undefined` (sync value) (lines 344-353)
  - `isRunning`: `boolean` (line 359)
  - `isReady`: `boolean` (line 366)
  - `getMemoryInfo`: `{ totalMemoryMB: number, freeMemoryMB: number }` (lines 372-376)
  - `then`: `undefined` (to prevent thenable behavior) (line 383)
  - `vmStarted` (getter): `boolean` (true) (lines 390-393)
  - `apiReachable` (getter): `boolean` (true) (lines 394-397)

- **Bundle calls on the `swift` module:**
  [UNVERIFIABLE FROM SOURCE] — NO BUILD OUTPUT (no `app-extracted` or `dist` directory exists in the workspace; bundle call sites cannot be verified without performing a build or having the extracted ASAR present).

---

## SECTION 3: TRAY / ICON / WINDOW CODE

| file | ACTUAL behaviour [CODE] |
|---|---|
| `patches/fix-tray-icon.mjs` | Fixes minifier bug where `nativeTheme` was accessed on an undefined variable on the non-Windows path (lines 12-25). This ensures theme-awareness (`shouldUseDarkColors`) works for icon selection. |
| `patches/native-frame.js` | Intercepts `BrowserWindow` and `Tray` via Proxy to inject Linux-compatible icons and click handlers. |
| `patches/fix-tray-config.sh` | Forces `menuBarEnabled: true` in `~/.config/Claude/config.json` to ensure the tray icon is even created by the app (lines 1-61). |

- **How is the tray icon chosen?**
  [CODE] `native-frame.js` searches a fallback chain: system paths `/usr/share/icons/hicolor/{32x32,48x48,16x16}/apps/claude-desktop.png`, then resizes the `appIcon` to 32x32 (lines 135-155). Theme-awareness is implemented by the app's internal logic, which is unblocked by `fix-tray-icon.mjs` (correcting the `nativeTheme` reference) (lines 142-167).
- **Is there any mutex/lock around tray rebuild?**
  [CODE] Absent in `native-frame.js` and `fix-tray-icon.mjs`.
- **Is there destroy+recreate or in-place `setImage` on theme change?**
  [CODE] In-place `setImage` is used. `native-frame.js` intercepts `setImage` to return the Linux-compatible `trayIcon` (lines 207-211).
- **How is the window/app icon resolved at runtime?**
  [CODE] Fallback chain in `native-frame.js` (lines 115-132):
  1. System paths: `/usr/share/icons/hicolor/{512x512,256x256,128x128}/apps/claude-desktop.png` or scalable SVG.
  2. Bundled icon inside ASAR: `claude-desktop.png` or `claude-desktop.svg` in the same directory as the main entry.
  3. Programmatic fallback: Base64-encoded 32x32 orange circle PNG.
- **Is Wayland `app_id` set anywhere?**
  [CODE] `StartupWMClass=Claude` is set in `packaging/AppDir/claude-desktop.desktop` (line 11). No evidence of binary renaming or `--class` flag usage in scripts or Nix flake.

---

## SECTION 4: DOC vs CODE CONTRADICTIONS

| doc file:line | doc claim [DOC-CLAIM] | actual code behaviour [CODE] | severity |
|---|---|---|---|
| `ARCHITECTURE.MD:420` | RPM: system Electron, no bundle | `packaging/claude-desktop.spec` and `scripts/build-rpm.sh` bundle Electron inside the RPM (lines 104-105 of spec). | P1 breaks-user-trust |
| `CLAUDE.MD` repo layout | `fetch-and-extract.sh` downloads DMG | `scripts/fetch-and-extract.sh` primarily queries `RELEASES.json` for a **ZIP** and only falls back to DMG (lines 78-100). | P2 cosmetic |
| `ARCHITECTURE.MD:435` | `--no-sandbox` only for AppImage | `packaging/claude-desktop.spec` (via launcher) and `flake.nix` (NixOS launcher) also use `--no-sandbox` (lines 315 of flake.nix, 161 of launcher). | P2 cosmetic |
| `ARCHITECTURE.MD:535` | Dispatch ... GrowthBook feature flags are force-enabled | Flags are only force-enabled if `ENABLE_EXPERIMENTAL_PATCHES=1` is set; they are NOT enabled by default (lines 342-414 of `patch-cowork.sh`). | P1 misleading |

---

## SECTION 5: NIXOS-SPECIFIC STATE

- **What does the flake actually build?**
  [CODE] Multiple packages: `default` (stable), `dev`, `nixos` (stable-nixos), and `nixos-dev` (lines 351-360).
- **Is chrome-sandbox handled?**
  [CODE] YES via `--no-sandbox` in the NixOS launcher wrapper (line 315). No `security.wrappers` used.
- **Is the Electron binary renamed for Wayland app_id?**
  [CODE] NO. The launcher script execs `electron` with `--no-sandbox` and the app path (line 327).
- **Is there an FHS-env variant for MCP servers?**
  [CODE] NO. Not present in `flake.nix`.
- **Is `claude://` scheme registration present for NixOS?**
  [CODE] NO. Not present in `flake.nix` or any Nix derivation.
- **Is there any NixOS module or Home Manager module?**
  [CODE] NO. Not present in `flake.nix`.

---

## SECTION 6: AUDIT CONFIDENCE

- **UNVERIFIABLE FROM SOURCE:**
  - **Bundle calls on the `swift` module:** Requires an extracted `app.asar` from an actual Claude Desktop release to analyze call sites via grep/AST.
  - **GrowthBook hash constants:** Verification of whether the hashes in `patches/patch-dispatch.mjs` match a specific version requires access to that version's bundle.
- **AUDIT RELIABILITY STATEMENT:**
  This audit is an empirical assessment of the `stslex/claude-desktop-linux` repository at a specific point in time. It can be relied upon for verifying implemented interfaces, patch logic, and documented vs. actual build behaviors. It cannot be relied upon for runtime stability, security of the proprietary Claude Desktop binary, or future compatibility with Anthropic updates.
