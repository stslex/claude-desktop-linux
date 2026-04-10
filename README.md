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
- **Cowork (Claude Code)** — unlocked and functional via `bubblewrap` sandbox
  or direct host execution
- **Auto-update pipeline** — GitHub Actions polls for new releases every 6 hours
  and publishes automatically; AppImage supports delta updates via `AppImageUpdate`

---

## What Is NOT Supported

| Feature | Reason |
|---|---|
| **Dispatch** | Partially supported — UI gates are bypassed and notifications polyfilled, but background delivery via APNs/FCM is not available; Dispatch tasks that rely on push notifications to wake the desktop app will not arrive when the app is closed |
| **Computer Use** | macOS implementation uses `AXUIElement`; an `xdotool`/`scrot` replacement would be fragile across desktop environments |
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

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url     = "github:NixOS/nixpkgs/nixos-unstable";
    claude-desktop.url = "github:stslex/claude-desktop-linux";
    # Or pin to the dev branch to track prereleases:
    # claude-desktop.url = "github:stslex/claude-desktop-linux/dev";
  };
  # ...
}
```

#### NixOS — `environment.systemPackages`

Stable channel (recommended):

```nix
# configuration.nix
{ inputs, pkgs, ... }: {
  environment.systemPackages = [
    inputs.claude-desktop.packages.${pkgs.system}.default
  ];
}
```

Dev channel (opt-in — see warning below):

```nix
# configuration.nix
{ inputs, pkgs, ... }: {
  environment.systemPackages = [
    inputs.claude-desktop.packages.${pkgs.system}.dev
  ];
}
```

#### Home Manager

```nix
# home.nix
{ inputs, pkgs, ... }: {
  home.packages = [
    # Stable:
    inputs.claude-desktop.packages.${pkgs.system}.default
    # ...or dev (don't install both at once — they conflict on
    # /bin/claude-desktop):
    # inputs.claude-desktop.packages.${pkgs.system}.dev
  ];
}
```

#### Overlay usage

```nix
# flake.nix — expose both channels on pkgs
{
  outputs = { self, nixpkgs, claude-desktop, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ({ pkgs, ... }: {
          nixpkgs.overlays = [(final: prev: {
            claude-desktop     = claude-desktop.packages.${prev.system}.default;
            claude-desktop-dev = claude-desktop.packages.${prev.system}.dev;
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
- inputs.claude-desktop.packages.${pkgs.system}.dev
+ inputs.claude-desktop.packages.${pkgs.system}.default
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
(inputs.claude-desktop.packages.${pkgs.system}.default.overrideAttrs (_: {
  version = "<version>";
  src = pkgs.fetchurl {
    url = "https://github.com/stslex/claude-desktop-linux/releases/download/v<version>-repack-<N>/claude-desktop-<version>-repack-<N>-x86_64-nix.tar.gz";
    sha256 = "<sha256>";  # from release notes or nix-prefetch-url
  };
}))
```

### First Run

1. On first launch the app prompts to create the `/sessions` symlink
   (`sudo ln -sf ~/.local/share/claude-linux/sessions /sessions`).
   The RPM `%post` scriptlet creates this automatically.
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
