---
name: computer-use-test
description: Exercise and diagnose the EXPERIMENTAL Linux computer-use backend (stubs/computer-use-linux.js) on a Wayland/wlroots compositor. Use when asked to test computer use, run the screenshot/grim path, check ydotool/wtype input, run the contract recon, verify the default-off gating, or debug why computerUse is null. Covers the two activation flags, the COMPUTER_USE_RECON diagnostic, the required packages (grim/ydotool+ydotoold/wtype), the --selftest, and the single-output / no-fractional-scaling v1 caveat.
---

# Test the Linux computer-use backend

EXPERIMENTAL and **default off**. `computerUse` is `null` unless flags are set —
that null is by design and means the feature is inert, not broken.

## Flags

- **Build:** `ENABLE_EXPERIMENTAL_PATCHES=1 ./scripts/patch-cowork.sh` stages
  `stubs/computer-use-linux.js` next to the injected `@ant/claude-swift` stub.
- **Runtime:** `ENABLE_COMPUTER_USE=1` activates the grim/ydotool backend.
- **Diagnostic:** `COMPUTER_USE_RECON=1` replaces `computerUse` with a logging
  Proxy that appends every live call (`seq | method | argc | args`) to
  `/tmp/cd-computeruse-recon.md` and returns permissive stand-ins. Takes
  precedence over `ENABLE_COMPUTER_USE` when both are set. Never touches the bundle.

Both flags required for the real backend: the build presence (experimental
patches) AND the runtime flag.

## Required packages (Wayland/wlroots, e.g. niri, Sway, Hyprland)

| Tool | Role | Missing → |
|---|---|---|
| `grim` | screenshots (wlr-screencopy) | screenshots become no-ops; **required** |
| `ydotool` + running `ydotoold` (needs `/dev/uinput` access) | absolute pointer / click / scroll / type | input no-ops |
| `wtype` | keyboard fallback (named keys/chords) | keyboard no-ops |

Missing tools log once at load and degrade to no-ops — they never crash the app.

## Fast checks (no full build)

```sh
node --check stubs/computer-use-linux.js
node stubs/computer-use-linux.js --selftest   # namespace shape, coord transform,
                                              # failure path, + a live grim capture if grim is present
```

Verify the three gating modes from the stub directly:

```sh
node -e 'console.log(require("./stubs/claude-swift.js").computerUse)'                 # → null (default)
ENABLE_COMPUTER_USE=1 node -e 'console.log(typeof require("./stubs/claude-swift.js").computerUse.screenshot.captureExcluding)'  # → function
COMPUTER_USE_RECON=1  node -e 'require("./stubs/claude-swift.js").computerUse.display.getSize(0)'  # appends a log line
```

## Live recon (reveal the real call sequence)

Run the app (or a Cowork computer-use task) with `COMPUTER_USE_RECON=1` and read
`/tmp/cd-computeruse-recon.md` (Section 7.live). Regenerate the static contract
report any time with `node patches/recon-computer-use.mjs`.

## Known limits (v1)

- Targets a **single output, scaleFactor 1, no fractional scaling**. Multi-output
  `-o` targeting and DIP↔px conversion are TODO; on a fractional-scaled display
  the backend forces scaleFactor 1 and warns loudly — clicks will be miscalibrated.
- Screenshots are JPEG (the consumer hardcodes `image/jpeg` and validates decoded
  length ≥ 1024 bytes), not PNG.
- **Not reachable end-to-end** in the stock bundle: Linux is hard-gated in three
  places (`hBA` platform set; executor dispatch with no linux branch; capability
  profiles). Lifting those is a maintainer decision tied to the `INVARIANTS.md`
  "No Computer Use" non-goal. Full contract + rationale: `docs/computer-use-decision.md`.
