# Claude Desktop Linux

> Unofficial Linux repackager for the macOS Claude Desktop application.
> Produces self-contained RPM, DEB, Pacman, Nix, and AppImage packages from Anthropic's official release.

[![Build](https://github.com/stslex/claude-desktop-linux/actions/workflows/build.yml/badge.svg)](https://github.com/stslex/claude-desktop-linux/actions/workflows/build.yml)
[![Latest Release](https://img.shields.io/github/v/release/stslex/claude-desktop-linux)](https://github.com/stslex/claude-desktop-linux/releases/latest)
[![License](https://img.shields.io/badge/scripts-MIT-blue)](LICENSE)

---

## What It Does

Anthropic ships Claude Desktop for macOS and Windows only. This project
downloads the official macOS release from Anthropic's CDN via `RELEASES.json`,
extracts the cross-platform Electron app bundle (`app.asar`), replaces the two
macOS-native Node addons with pure-JS stubs, and patches the platform gate
that hides the Cowork (Claude Code) feature on non-macOS systems. The result
is repackaged as a self-contained **RPM**, **DEB**, **Pacman**, **Nix**, and
**AppImage** — Electron is bundled in all packages, no system-level Electron
installation required.

The key insight: the VM that Cowork boots on macOS already runs a Linux
x86_64 rootfs. On Linux we skip the VM entirely and run `claude-code`
directly — the macOS app is already 90% a Linux app.

See [ARCHITECTURE.MD](ARCHITECTURE.MD) for design decisions and trade-offs.

---

## Features

- **Chat** — full Claude Desktop chat interface on Linux
- **MCP** — Model Context Protocol support works as-is (it is pure JS)
- **Cowork (Claude Code)** — experimental, disabled by default. Enable with
  `ENABLE_EXPERIMENTAL_PATCHES=1` when running `scripts/patch-cowork.sh`;
  known to cause SIGSEGV on some bundles pending a lifecycle method fix
  (see the `fix_cowork` branch). Default builds only patch the platform
  gate so the Cowork UI renders; the socket transport and ComputerUseTcc
  AST injections that wire it end-to-end stay off.
- **Computer Use** — experimental, disabled by default. A Wayland backend
  (`stubs/computer-use-linux.js`: `grim` screenshots + `ydotool`/`wtype`
  input) is staged under `ENABLE_EXPERIMENTAL_PATCHES=1` and activated at
  runtime by `ENABLE_COMPUTER_USE=1`; with neither, `computerUse` stays
  `null` and nothing changes. It is **not** wired end-to-end — the stock
  bundle still hard-gates Linux computer use, which is a maintainer
  decision tied to the `INVARIANTS.md` "No Computer Use" non-goal. See
  [Build Flags](#build-flags) and [docs/computer-use-decision.md](docs/computer-use-decision.md).
- **Dispatch (default builds)** — the Dispatch availability gate is
  patched (`patches/fix-dispatch-gate.mjs`) and renderer IPC handlers are
  stubbed (`stubs/dispatch-polyfill.js`), but GrowthBook feature flags
  are NOT overridden — `patches/patch-dispatch.mjs` is experimental and
  only runs under `ENABLE_EXPERIMENTAL_PATCHES=1`. Background delivery
  (APNs/FCM push) is unavailable regardless of build flags.
- **Auto-update pipeline** — GitHub Actions polls for new releases every 6 hours
  and publishes automatically; AppImage supports delta updates via `AppImageUpdate`

---

## What Is NOT Supported

| Feature | Reason |
|---|---|
| **Dispatch (default builds)** | Availability gate is patched (`patches/fix-dispatch-gate.mjs`) and renderer IPC handlers are stubbed (`stubs/dispatch-polyfill.js`), so the UI renders, but GrowthBook feature flags are not overridden in default builds — `patches/patch-dispatch.mjs` is experimental (see [Build Flags](#build-flags)). |
| **Dispatch (experimental, `ENABLE_EXPERIMENTAL_PATCHES=1`)** | Adds the GrowthBook override (`patches/patch-dispatch.mjs`). Even with the flag set, background delivery (APNs/FCM push) is unavailable, so tasks sent from mobile while the app is closed never arrive — this depends on platform features Linux does not provide and is not gated by an env var. |
| **Computer Use (default builds)** | `computerUse` is `null`; not enabled. The macOS implementation uses `AXUIElement`. |
| **Computer Use (experimental, `ENABLE_EXPERIMENTAL_PATCHES=1` + `ENABLE_COMPUTER_USE=1`)** | A Wayland backend exists (`stubs/computer-use-linux.js`: `grim` + `ydotool`/`wtype`) but is **not** reachable end-to-end — the stock bundle hard-gates Linux in three places (platform allow-list, executor dispatch, capability profiles), and lifting them touches the ratified "No Computer Use" non-goal (`INVARIANTS.md`), so it is a maintainer decision. v1 also assumes a single output with no fractional scaling. See [docs/computer-use-decision.md](docs/computer-use-decision.md). |
| **ARM64** | Electron binary selection and AppImage build are x86_64 only; ARM64 is a future milestone |

---

## Installation

### AppImage (any distro)

```sh
# Download from the latest release
chmod +x claude-desktop-<version>-x86_64.AppImage
./claude-desktop-<version>-x86_64.AppImage
```

> `--no-sandbox` may be required on some systems: if the app fails to start,
> re-run with `--no-sandbox`. The AppImage FUSE mount sets `nosuid`, which can
> prevent the `chrome-sandbox` setuid bit from taking effect.

To update without re-downloading the full AppImage, use
[AppImageUpdate](https://github.com/AppImageCommunity/AppImageUpdate):

```sh
AppImageUpdate claude-desktop-<version>-x86_64.AppImage
```

### RPM (Fedora / Silverblue / RHEL)

Electron is bundled — no additional dependencies required.

#### Via DNF repository (recommended — enables `dnf update`)

```sh
sudo curl -o /etc/yum.repos.d/claude-desktop.repo \
  https://stslex.github.io/claude-desktop-linux/claude-desktop.repo
sudo dnf install claude-desktop
```

Future updates: `sudo dnf update claude-desktop`

#### Direct RPM download

```sh
sudo dnf install claude-desktop-<version>-repack-<N>-x86_64.rpm
```

#### Silverblue / Kinoite (atomic desktops)

```sh
sudo curl -o /etc/yum.repos.d/claude-desktop.repo \
  https://stslex.github.io/claude-desktop-linux/claude-desktop.repo
rpm-ostree install claude-desktop
# then reboot
```

### DEB (Debian / Ubuntu / Linux Mint)

Electron is bundled — no additional dependencies required.

#### Via APT repository (recommended — enables `apt update`)

```sh
sudo curl -o /etc/apt/sources.list.d/claude-desktop.list \
  https://stslex.github.io/claude-desktop-linux/claude-desktop.list
sudo apt update
sudo apt install claude-desktop
```

Future updates: `sudo apt update && sudo apt upgrade claude-desktop`

#### Direct DEB download

```sh
sudo apt install ./claude-desktop-<version>-repack-<N>-x86_64.deb
```

### Pacman (Arch Linux / Manjaro / EndeavourOS)

Electron is bundled — no additional dependencies required.

#### Via custom repository (recommended — enables `pacman -Syu`)

Add to `/etc/pacman.conf`:

```ini
[claude-desktop]
SigLevel = Optional TrustAll
Server = https://github.com/stslex/claude-desktop-linux/releases/latest/download
```

Then install:

```sh
sudo pacman -Sy claude-desktop
```

Future updates: `sudo pacman -Syu`

#### Direct package download

Download the `.pkg.tar.zst` from the [latest release](https://github.com/stslex/claude-desktop-linux/releases/latest), then:

```sh
curl -fLO https://github.com/stslex/claude-desktop-linux/releases/latest/download/claude-desktop-<version>-<repack>-x86_64.pkg.tar.zst
sudo pacman -U claude-desktop-*-x86_64.pkg.tar.zst
```

### NixOS / Nix

The repository ships a `flake.nix` with two channels that mirror the RPM /
DEB / Pacman split:

| Flake attribute | Channel | Source | Who should use it |
|---|---|---|---|
| `packages.x86_64-linux.default` | **stable** | Latest non-prerelease GitHub Release | Everyone by default |
| `packages.x86_64-linux.dev`     | **dev**    | Latest prerelease (`prerelease: true`) GitHub Release | Early adopters who want fixes before they ship to main |

Channel metadata (tarball URL + `sha256` + version) is pinned in
`nix/stable.json` and `nix/dev.json`. CI updates those files on every
publish, so `nix flake update` picks up new builds without you having to
paste hashes by hand.

> Dev version strings carry a `-pre` suffix (e.g. `0.13.45-pre`) so that
> `builtins.compareVersions` places them strictly *below* the matching
> stable version. A `nix flake check` in this repo verifies the invariant
> (`checks.x86_64-linux.channel-version-order`). Practical consequence:
> if you have both overlays in scope, resolution always prefers the
> higher version, and stable always wins against a matching dev build.

#### Flake input

> The input is named `claude-desktop-linux` here so the LHS attribute
> matches the repository name. You can pick any name you like, but
> whatever you use must match how downstream modules (NixOS, home-manager,
> overlays) reference it — see the [Troubleshooting](#troubleshooting)
> section below if `nix flake update` complains about a missing attribute.

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url     = "github:NixOS/nixpkgs/nixos-unstable";
    claude-desktop-linux.url = "github:stslex/claude-desktop-linux";
    # Or pin to the dev branch — required if you want
    # `packages.x86_64-linux.dev` (the prerelease channel):
    # claude-desktop-linux.url = "github:stslex/claude-desktop-linux/dev";
  };
  # ...
}
```

> **Heads-up about the `dev` attribute.** `packages.x86_64-linux.dev`
> and `claude-desktop-dev` currently live only on the `dev` branch of
> this repo — pinning the input to the default `main` branch
> (`github:stslex/claude-desktop-linux`) only exposes
> `packages.x86_64-linux.default` (stable). If you reference
> `inputs.claude-desktop-linux.packages.<system>.dev` against the `main`
> URL you'll get an `attribute 'dev' missing` error. Switch the URL to
> the `/dev` form above, or use `.default` instead. This caveat goes
> away once the dev-channel changes land on `main`.

#### NixOS — `environment.systemPackages`

Stable channel (recommended):

```nix
# configuration.nix
{ inputs, pkgs, ... }: {
  environment.systemPackages = [
    inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
}
```

Dev channel (opt-in — see warning below):

```nix
# configuration.nix
{ inputs, pkgs, ... }: {
  environment.systemPackages = [
    inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.dev
  ];
}
```

#### Home Manager

```nix
# home.nix
{ inputs, pkgs, ... }: {
  home.packages = [
    # Stable:
    inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.default
    # ...or dev (don't install both at once — they conflict on
    # /bin/claude-desktop):
    # inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.dev
  ];
}
```

#### Overlay usage

```nix
# flake.nix — expose both channels on pkgs
{
  outputs = { self, nixpkgs, claude-desktop-linux, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ({ pkgs, ... }: {
          nixpkgs.overlays = [(final: prev: {
            claude-desktop     = claude-desktop-linux.packages.${prev.stdenv.hostPlatform.system}.default;
            claude-desktop-dev = claude-desktop-linux.packages.${prev.stdenv.hostPlatform.system}.dev;
          })];
          environment.systemPackages = [ pkgs.claude-desktop ];
        })
      ];
    };
  };
}
```

#### Rolling back from dev to stable

Switch the attribute you pull from the flake back to `default`, then
`nixos-rebuild switch` (or `home-manager switch`):

```diff
- inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.dev
+ inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.default
```

```sh
sudo nixos-rebuild switch --flake .#myhost
# or: home-manager switch --flake .#me
```

NixOS keeps the previous generation around — if the rebuild itself
fails, roll the system back with `sudo nixos-rebuild switch --rollback`
(or boot into the previous generation from the bootloader).

> **⚠️ Dev channel warning — same tone as the RPM dev repo.**
> The dev channel tracks the `dev` branch of this repository and
> publishes **prereleases**. It may break at any time, break your
> Claude Desktop session, or ship a partially-working patch while a
> Claude Desktop upstream change is being investigated. Only opt in if
> you are comfortable rolling back a NixOS generation. There is no
> support SLA — if it breaks, file an issue and switch back to stable.

#### Direct tarball download

Pre-built Nix-compatible tarballs are available in each GitHub Release:

```sh
# Stable (latest non-prerelease):
curl -fLO https://github.com/stslex/claude-desktop-linux/releases/latest/download/claude-desktop-<version>-repack-<N>-x86_64-nix.tar.gz
```

#### Manual override

If you want to build against a specific release without waiting for CI
to update `nix/stable.json`, `overrideAttrs` works against either
channel:

```nix
(inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.default.overrideAttrs (_: {
  version = "<version>";
  src = pkgs.fetchurl {
    url = "https://github.com/stslex/claude-desktop-linux/releases/download/v<version>-repack-<N>/claude-desktop-<version>-repack-<N>-x86_64-nix.tar.gz";
    sha256 = "<sha256>";  # from release notes or nix-prefetch-url
  };
}))
```

#### Troubleshooting

The two errors below both come from a naming mismatch between the input
URL, the input name in your `flake.nix`, and references in downstream
modules (NixOS, home-manager, overlays). The fix in every case is to
make all three agree on the same identifier.

**Symptom 1 — HTTP 404 from the GitHub API**

```
error: … while updating the flake input 'claude-desktop-linux'
       … while fetching the input 'github:stslex/claude-desktop'
       error: unable to download
       'https://api.github.com/repos/stslex/claude-desktop/commits/HEAD':
       HTTP error 404
```

The input URL is missing the `-linux` suffix. The repository is
`stslex/claude-desktop-linux`, not `stslex/claude-desktop` (the latter
does not exist and returns 404 from the GitHub API). Two ways this
sneaks in:

1. **A typo in your `flake.nix`**. Open it and confirm the URL matches
   the snippet in [Flake input](#flake-input) above:

   ```nix
   inputs.claude-desktop-linux.url = "github:stslex/claude-desktop-linux";
   #                                                  ^^^^^^ required
   ```

2. **A stale entry in your `flake.lock`** from before the URL was
   corrected. `nix flake update` only re-resolves an input when its URL
   in `flake.nix` changes — if the lock file still pins the old name,
   force a re-resolve of just the one input:

   ```sh
   nix flake lock --update-input claude-desktop-linux
   ```

   If the bad URL keeps resurfacing, delete the `claude-desktop-linux`
   block from `flake.lock` by hand (or delete `flake.lock` entirely if
   you're comfortable re-resolving every input) and rerun
   `nix flake update`.

**Symptom 2 — `attribute 'claude-desktop-linux' missing`**

```
error: attribute 'claude-desktop-linux' missing
   17|     inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.dev
     |     ^
```

A downstream module (here, a home-manager `packages.nix`) references the
input as `claude-desktop-linux`, but your `flake.nix` declares it under
a *different* name — most commonly `inputs.claude-desktop` (without the
`-linux` suffix). The input *name* (the LHS attribute in `flake.nix`)
and the input *URL* are independent in Nix flakes; references in other
modules must match the *name*, not the URL.

Pick one of these two fixes — both work, the first is recommended
because it matches the convention in the snippets above and most users'
expectation that the input name should match the repository name:

1. **Rename the LHS in your `flake.nix`** so the input name matches
   what downstream modules reference:

   ```nix
   inputs.claude-desktop-linux.url = "github:stslex/claude-desktop-linux";
   ```

2. **Or rename the reference in the downstream module** to match
   whatever name your `flake.nix` already uses:

   ```nix
   # if flake.nix has `inputs.claude-desktop.url = ...`
   inputs.claude-desktop.packages.${pkgs.stdenv.hostPlatform.system}.dev
   ```

After fixing the name in `flake.nix`, refresh the lock and rebuild:

```sh
rm flake.lock         # easiest — drops any stale block from the old name
nix flake lock
sudo nixos-rebuild switch --flake .#myhost
```

**Symptom 3 — `attribute 'dev' missing`**

```
error: attribute 'dev' missing
   17|     inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.dev
     |     ^
```

The input now resolves correctly, but you're pinning the **`main`**
branch of this repo and asking for the `.dev` package. As called out in
the heads-up box on [Flake input](#flake-input) above,
`packages.x86_64-linux.dev` and `claude-desktop-dev` currently live only
on the `dev` branch — `main` only exposes
`packages.x86_64-linux.default`. Two ways out:

1. **Switch the input URL to the `dev` branch** if you actually want
   the prerelease channel:

   ```nix
   inputs.claude-desktop-linux.url = "github:stslex/claude-desktop-linux/dev";
   ```

2. **Or change the downstream reference from `.dev` to `.default`** if
   you just want stable on the `main` URL:

   ```nix
   inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.default
   ```

This caveat disappears once the dev-channel changes land on `main`.

After any of the three fixes, refresh the lock and rebuild:

```sh
nix flake lock --update-input claude-desktop-linux
sudo nixos-rebuild switch --flake .#myhost
```

`nixos-rebuild switch` should then resolve the input against this
repository and pick up `nix/stable.json` (or `nix/dev.json` if you
pinned the `dev` branch) without further intervention.

### Cowork Service (optional — enables Cowork and Dispatch)

The `claude-cowork-service` daemon provides the socket backend that Cowork and
Dispatch use for session management.  Install it for full Cowork/Dispatch support:

```sh
./scripts/install-cowork-service.sh
```

This downloads the pre-built binary from
[patrickjaja/claude-cowork-service](https://github.com/patrickjaja/claude-cowork-service),
installs it to `~/.local/bin/`, and creates a systemd user service.  The app
will warn on launch if the service is not running, but Chat and MCP still work
without it.

---

### Beta / Development Channel (Testers Only)

> **Not recommended for normal use.** The beta channel contains untested
> development builds. They may be broken, crash on launch, or have incomplete
> features. Use the [stable release](#installation) unless you are actively
> testing changes.

If you want to help test new features before they reach the stable channel:

#### RPM / Fedora / Silverblue

```sh
sudo curl -o /etc/yum.repos.d/claude-desktop-dev.repo \
  https://stslex.github.io/claude-desktop-linux/claude-desktop-dev.repo
sudo dnf install claude-desktop
```

#### DEB / Debian / Ubuntu

```sh
sudo curl -o /etc/apt/sources.list.d/claude-desktop-dev.list \
  https://stslex.github.io/claude-desktop-linux/claude-desktop-dev.list
sudo apt update
sudo apt install claude-desktop
```

#### Pacman / Arch Linux

Add to `/etc/pacman.conf`:

```ini
[claude-desktop-dev]
SigLevel = Optional TrustAll
Server = https://github.com/stslex/claude-desktop-linux/releases/download/<dev-tag>
```

#### Nix / NixOS

Switch the flake attribute you pull from `default` to `dev`:

```nix
# configuration.nix / home.nix
environment.systemPackages = [
  inputs.claude-desktop-linux.packages.${pkgs.stdenv.hostPlatform.system}.dev
];
```

Or consume the `dev` branch of this repository directly as a flake
input to always track the latest dev-channel metadata:

```nix
inputs.claude-desktop-linux.url = "github:stslex/claude-desktop-linux/dev";
```

See the "NixOS / Nix" section above for `builtins.compareVersions`
invariants and the `checks.x86_64-linux.channel-version-order` flake
check that guards them.

#### Rollback to stable

If a beta build breaks your install:

```sh
# Fedora
sudo dnf downgrade claude-desktop
# or remove the dev repo and reinstall:
sudo rm /etc/yum.repos.d/claude-desktop-dev.repo
sudo dnf reinstall claude-desktop

# Debian / Ubuntu
sudo rm /etc/apt/sources.list.d/claude-desktop-dev.list
sudo apt update
sudo apt install claude-desktop --reinstall

# NixOS — switch the flake attribute back to .default and rebuild:
#   sudo nixos-rebuild switch --flake .#myhost
# or roll the previous generation back if the rebuild itself broke:
#   sudo nixos-rebuild switch --rollback
```

#### Reporting beta issues

Beta issues should be filed with the `beta` label on GitHub Issues.
Include the exact version string from `rpm -q claude-desktop` or
`claude-desktop --version`.

---

### First Run

1. No special setup needed — the app creates `~/.local/share/claude-linux/sessions/`
   automatically. No sudo or root symlinks required.
2. Complete the OAuth flow in your browser — the `claude://` URI scheme is
   registered by the `.desktop` file and `xdg-mime`.

---

## Building from Source

### Prerequisites

```sh
# Fedora
sudo dnf install rpm-build ImageMagick nodejs unzip curl
node --version  # must be ≥ 20
```

Also required at build time (fetched automatically if missing):
`appimagetool`, `@electron/asar` (via npx), Electron binary (downloaded by the build scripts).

### Build

```sh
git clone https://github.com/stslex/claude-desktop-linux
cd claude-desktop-linux
npm ci --ignore-scripts

./scripts/fetch-and-extract.sh  # download release ZIP, extract app.asar, detect versions
./scripts/inject-stubs.sh       # replace native modules with JS stubs
./scripts/patch-cowork.sh       # unlock Cowork on Linux
./scripts/build-packages.sh     # produce RPM + DEB + Pacman + Nix + AppImage in ./output/
```

Or trigger the **build.yml** GitHub Action manually — it runs the same
steps on `ubuntu-latest` and publishes a GitHub Release with both packages
and their `.sha256` files.

**Useful env vars:**

| Variable | Default | Purpose |
|---|---|---|
| `SKIP_DOWNLOAD` | *(unset)* | Set to `1` to reuse the existing downloaded archive |
| `COWORK_BACKEND` | `bubblewrap` | `bubblewrap` or `host` |
| `ELECTRON_OVERRIDE` | *(unset)* | Force a specific Electron version |

### Build Flags

Some bundle-level patches are gated behind feature flags because they
currently corrupt the JS bundle on some Claude Desktop releases. Default
builds run only the patches listed under "Default-on patches" in
[CLAUDE.MD](CLAUDE.MD#build-phases); every patch listed under
"Default-off (experimental) patches" stays off unless the matching flag
below is set.

| Flag | Default | What it gates |
|---|---|---|
| `ENABLE_EXPERIMENTAL_PATCHES` | unset (off) | When set to `1`, `scripts/patch-cowork.sh` additionally runs `patches/patch-cowork-socket.mjs` (named pipe → Unix socket transport), `patches/patch-dispatch.mjs` (GrowthBook feature flag overrides for Dispatch), and `patches/patch-computer-use-tcc.mjs` (ComputerUseTcc IPC stub AST injection), and stages `stubs/computer-use-linux.js` next to the `@ant/claude-swift` stub (see `ENABLE_COMPUTER_USE` below). The three AST patches currently corrupt the JS bundle on some Claude Desktop versions and can cause SIGSEGV on launch — see `scripts/patch-cowork.sh` lines 342–414 and the `fix_cowork` branch. |
| `ENABLE_COMPUTER_USE` | unset (off) | **Runtime** flag (read by `stubs/claude-swift.js`, not the build). When set to `1` **and** the build ran with `ENABLE_EXPERIMENTAL_PATCHES=1` (which stages the backend module), the `@ant/claude-swift` `computerUse` namespace is backed by `stubs/computer-use-linux.js`: screenshots via **`grim`** (resized/JPEG-encoded via Electron `nativeImage`), input primitives via **`ydotool`** (absolute pointer + click + scroll, needs a running `ydotoold` with `/dev/uinput` access) with **`wtype`** as the keyboard fallback. With neither flag, `computerUse` stays `null` and the app is byte-for-byte unchanged. **Caveats:** this is v1 — it targets a **single output with no fractional scaling** (multi-output `-o` targeting and DIP↔px conversion are TODO); and the stock bundle still hard-gates Linux computer use in three places (`hBA` platform set, the executor-factory dispatch, capability profiles), so enabling it end-to-end additionally requires bundle changes that are a **maintainer decision** (they touch the `INVARIANTS.md` "No Computer Use" non-goal). The contract this backend implements is documented in `/tmp/cd-computeruse-recon.md`. |
| `COMPUTER_USE_RECON` | unset (off) | **Runtime** diagnostic flag. When set to `1`, `stubs/claude-swift.js` replaces `computerUse` with a logging Proxy that appends every live call (`seq | method | argc | args`) to `/tmp/cd-computeruse-recon.md` and returns permissive stand-ins (a ≥1024-byte image so the orchestrator proceeds; `tcc.*` → true). Used to reverse-engineer the live call sequence; never modifies the bundle. Takes precedence over `ENABLE_COMPUTER_USE` when both are set. |

Required packages for `ENABLE_COMPUTER_USE` (resolved at runtime; missing tools
log once and degrade to a no-op rather than crashing): **`grim`** (screenshots,
required), **`ydotool`** + a running **`ydotoold`** daemon with `/dev/uinput`
access (pointer/keyboard input), and optionally **`wtype`** (keyboard fallback).
Wayland compositor must support `wlr-screencopy` (for `grim`) and
`wlr-virtual-pointer` / `virtual-keyboard` (for `ydotool`/`wtype`) — e.g. niri,
Sway, Hyprland.

`ENABLE_EXPERIMENTAL_PATCHES` is the canonical pattern for any new patch
that is not yet safe to enable by default: gate the new step behind a
check on this env var in `scripts/patch-cowork.sh`, leave the default
unset, and add a row here documenting the failure mode so users opting
in know what they are taking on.

---

## How Cowork Works on Linux

On macOS, Cowork runs `claude-code` inside an Apple Virtualization Framework
VM. Our approach collapses the VM layer entirely:

```
macOS:  Electron → @ant/claude-swift (native) → VZVirtualMachine → Linux VM → claude-code
Linux:  Electron → @ant/claude-swift (JS stub) → child_process.spawn()      → claude-code
```

Two JS stubs do the work:

- **`@ant/claude-native`** — spoofs `getPlatform()` → `"darwin"` and
  `getOSVersion()` → `"14.0.0"` to pass the Cowork availability check.
  `AuthRequest` calls `xdg-open` for the OAuth deep-link.
- **`@ant/claude-swift`** — implements the `vm.spawn()` / `vm.kill()` /
  `vm.writeStdin()` interface via `child_process.spawn`. VM filesystem paths
  (`/sessions/<id>/mnt/<name>/…`) are translated to real host paths
  (`~/.local/share/claude-linux/sessions/…`).

The platform gate in `app.asar` (a minified function that checks
`process.platform`) is patched at build time using an AST rewrite (acorn)
to unconditionally return `{ status: "supported" }`.

With `COWORK_BACKEND=bubblewrap` (default), `claude-code` runs inside a
bubblewrap namespace sandbox: home directory read-only, only the session
working directory writable, network access preserved.

---

## Security

This project downloads a proprietary application from Anthropic's CDN and
modifies it locally. Key points from [ARCHITECTURE.MD](ARCHITECTURE.MD):

- The downloaded archive SHA256 is verified on every run (transport integrity
  via HTTPS; no trusted out-of-band checksum source).
- The injected stubs are ~100 lines of plain JS each — auditable in minutes.
  They make no outbound network requests and do not read your files.
- The Cowork patch is a single function-body replacement. The diff ships in
  each release.
- RPM packages are not GPG-signed in the initial release (planned follow-up).
- AppImage has no signature (standard AppImage limitation).
- `claude-code` runs as your user. With `bubblewrap` it cannot write outside
  the session directory. With `COWORK_BACKEND=host` it has full filesystem
  access.

**Threat model:** we trust Anthropic's CDN. If you do not, do not use this
project.

---

## Contributing

[CLAUDE.MD](CLAUDE.MD) is the authoritative spec: invariants, script
contracts, stub interfaces, patch strategy, and update procedure.

When `patch-cowork.sh` breaks after a Claude Desktop update, run:

```sh
node patches/find-platform-gate.mjs --dump-candidates
```

Update the AST pattern, commit, and push — the next `check-update.yml` run
picks it up automatically.

---

## License / Disclaimer

Build scripts: **MIT**.

Claude Desktop application: **Anthropic proprietary**. This project downloads
it directly from Anthropic's CDN at build time and does not redistribute it.

This project is **unofficial** and is not affiliated with, endorsed by, or
supported by Anthropic.
