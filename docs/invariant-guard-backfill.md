# Invariant Guard Backfill

This report applies the new invariant-guard rule retroactively over the full
local git history reachable from `git rev-list --all`, all authors included.

Method:

- Compared each commit against its first parent.
- Treated these historical sections as the protected invariant source before
  `INVARIANTS.md` existed:
  - `CLAUDE.MD` `## Invariants — Never Break These`
  - `CLAUDE.MD` `## What This Project Intentionally Does Not Do`
  - `ARCHITECTURE.MD` `## Explicit Non-Goals`
- Marked a commit as a guard failure when one of those protected sections changed
  in the same commit as a file under `scripts/`, `patches/`, `stubs/`, or
  `packaging/`.

## Historical Failures

### `d9debb8027e1070131e970f646e571e147dd856a`

- Date: 2026-03-28T11:07:10+03:00
- Author: stslex
- Subject: `Repository scaffolding`
- Protected changes:
  - `CLAUDE.MD` `## Invariants — Never Break These`: section added with `All scripts must be idempotent.`, `Every downloaded file must be SHA256-verified`, `Patches must self-validate.`, `No hardcoded versions anywhere.`, and `` `set -euo pipefail` ``.
  - `CLAUDE.MD` `## What This Project Intentionally Does Not Do`: section added with `No Dispatch support.`, `No Computer Use.`, `No KVM isolation.`, `No platform header spoofing beyond getOSVersion/getPlatform stubs.`, and `No ARM64 support yet.`
  - `ARCHITECTURE.MD` `## Explicit Non-Goals`: section added with `No HTTP header / User-Agent spoofing.`, `No Dispatch.`, `No Computer Use.`, and `No ARM64.`
- Co-changed code files:
  - `packaging/AppDir/AppRun`
  - `packaging/AppDir/claude-desktop.desktop`
  - `packaging/AppDir/usr/bin/claude-desktop`
  - `packaging/claude-desktop.spec`
  - `patches/apply-platform-gate.mjs`
  - `patches/find-platform-gate.mjs`
  - `patches/path-translator.mjs`
  - `scripts/build-packages.sh`
  - `scripts/fetch-and-extract.sh`
  - `scripts/inject-stubs.sh`
  - `scripts/patch-cowork.sh`
  - `stubs/claude-native-pkg.json`
  - `stubs/claude-native.js`
  - `stubs/claude-swift-pkg.json`
  - `stubs/claude-swift.js`

### `0debd31c02bc088171ef1665a16c8083196f96a2`

- Date: 2026-03-29T17:15:33Z
- Author: Claude
- Subject: `fix: comprehensive IPC interception for Cowork/Dispatch platform gates`
- Protected changes:
  - `CLAUDE.MD` `## What This Project Intentionally Does Not Do`: removed `No Dispatch support.` and added `Partial Dispatch support.`
  - `ARCHITECTURE.MD` `## Explicit Non-Goals`: removed `No Dispatch.` and added `Partial Dispatch.`
- Co-changed code files:
  - `patches/platform-override.js`
  - `stubs/claude-native.js`

### `ba7dae50ead47f5ba31346ff62ad26f19112c12c`

- Date: 2026-03-31T04:18:17Z
- Author: Claude
- Subject: `feat: enable Cowork on Linux with header injection and path translation`
- Protected changes:
  - `CLAUDE.MD` `## What This Project Intentionally Does Not Do`: removed `No platform header spoofing beyond getOSVersion/getPlatform stubs.`
  - `ARCHITECTURE.MD` `## Explicit Non-Goals`: removed `No HTTP header / User-Agent spoofing.` and added `Targeted platform header injection (not general spoofing).`
- Co-changed code files:
  - `patches/fix-bundle-download.mjs`
  - `scripts/patch-cowork.sh`
  - `stubs/claude-swift.js`
  - `stubs/ipc-stubs.js`
  - `stubs/platform-headers.js`

### `83d735a16fd3863dbf6208171bc77480a637279a`

- Date: 2026-03-31T04:27:53Z
- Author: Claude
- Subject: `feat: add Dispatch foreground support with IPC stubs and polling skeleton`
- Protected changes:
  - `CLAUDE.MD` `## What This Project Intentionally Does Not Do`: edited `Partial Dispatch support.`
- Co-changed code files:
  - `patches/fix-dispatch-gate.mjs`
  - `scripts/patch-cowork.sh`
  - `stubs/dispatch-polyfill.js`

### `b4ced5917e9e8b0f40a9b88bf58199ecbfb10604`

- Date: 2026-04-04T12:07:09Z
- Author: Claude
- Subject: `feat: enable Cowork and Dispatch on Linux via socket IPC`
- Protected changes:
  - `CLAUDE.MD` `## What This Project Intentionally Does Not Do`: removed `Partial Dispatch support.` and added `Dispatch — partially supported.`
  - `ARCHITECTURE.MD` `## Explicit Non-Goals`: removed `Partial Dispatch.`
- Co-changed code files:
  - `packaging/AppDir/AppRun`
  - `packaging/AppDir/usr/bin/claude-desktop`
  - `packaging/claude-desktop.spec`
  - `patches/patch-computer-use-tcc.mjs`
  - `patches/patch-cowork-socket.mjs`
  - `patches/patch-dispatch.mjs`
  - `scripts/build-deb.sh`
  - `scripts/build-pacman.sh`
  - `scripts/install-cowork-service.sh`
  - `scripts/patch-cowork.sh`
