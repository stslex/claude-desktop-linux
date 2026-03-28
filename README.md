# Claude Desktop Linux

> Unofficial repackage of the macOS Claude Desktop application for Linux.
> Produces RPM and AppImage packages from the official macOS DMG.

![Build](https://github.com/YOUR_ORG/claude-desktop-linux/actions/workflows/build.yml/badge.svg)
![Latest Release](https://img.shields.io/github/v/release/YOUR_ORG/claude-desktop-linux)
![License](https://img.shields.io/badge/scripts-MIT-blue)

---

## What This Does

Anthropic ships Claude Desktop for macOS and Windows only. This project:

1. Downloads the official macOS DMG from Anthropic's CDN and verifies its SHA256.
2. Extracts `app.asar` — the cross-platform Electron app bundle.
3. Replaces the two macOS-native Node addons (`@ant/claude-native`, `@ant/claude-swift`) with pure-JS stubs.
4. Patches the Cowork platform gate so the Claude Code integration works on Linux.
5. Repackages the result as an **RPM** (system Electron) and an **AppImage** (bundled Electron).

See [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions and [CLAUDE.md](CLAUDE.md) for the full specification.

---

## Quick Start

### Download a pre-built release

```sh
# RPM (Fedora / RHEL / Silverblue)
sudo rpm-ostree install electron
sudo rpm -i https://github.com/YOUR_ORG/claude-desktop-linux/releases/latest/download/claude-desktop-<version>-x86_64.rpm

# AppImage (any distro)
chmod +x claude-desktop-<version>-x86_64.AppImage
./claude-desktop-<version>-x86_64.AppImage
```

### Build from source

```sh
# Install build dependencies (Fedora)
sudo dnf install dmg2img p7zip node rpmbuild

# Clone and build
git clone https://github.com/YOUR_ORG/claude-desktop-linux
cd claude-desktop-linux
npm install   # installs @electron/asar, acorn, acorn-walk

./scripts/fetch-and-extract.sh
./scripts/inject-stubs.sh
./scripts/patch-cowork.sh
./scripts/build-packages.sh

ls output/
```

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `BUILD_DIR` | `/tmp/claude-build` | Scratch space |
| `OUTPUT_DIR` | `./output` | Final packages |
| `COWORK_BACKEND` | `bubblewrap` | `bubblewrap` or `host` |
| `SKIP_DOWNLOAD` | *(unset)* | Set to `1` to reuse existing DMG |
| `ELECTRON_OVERRIDE` | *(unset)* | Force a specific Electron version |

---

## Build Dependencies

| Tool | Used for |
|---|---|
| `dmg2img` | Convert DMG to raw image |
| `7z` (p7zip) | Extract raw image |
| `npx asar` / `@electron/asar` | Pack/unpack app.asar |
| `node` ≥ 20 | Patch scripts (ESM) |
| `rpmbuild` | Build RPM |
| `appimagetool` | Build AppImage |
| `icns2png` or `magick` | Convert macOS icon |
| `bubblewrap` (`bwrap`) | Cowork sandbox (runtime) |
| `electron` | Runtime (RPM); bundled in AppImage |

---

## License

Build scripts: **MIT**.
Claude Desktop application: **Anthropic proprietary**. This project downloads it
directly from Anthropic's CDN and does not redistribute it.
