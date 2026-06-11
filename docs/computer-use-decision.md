# Decision memo: experimental Linux computer-use backend

This memo documents `stubs/computer-use-linux.js` and its gated wiring, added
in PR #96 (`feat(cowork): EXPERIMENTAL Linux computer-use backend`). It answers,
in order:

1. What the backend does and how it is gated.
2. How its contract was established (no guessing).
3. The verified `computerUse` contract it implements.
4. The single correctness risk — coordinate space.
5. Why it is **not** reachable end-to-end on the stock bundle.
6. The `INVARIANTS.md` "No Computer Use" tension and three options for the maintainer.

The default build is unchanged by this work: with no flags, `computerUse` stays
`null` exactly as before.

---

## Phase 1 — What the backend does

`stubs/computer-use-linux.js` provides a Linux implementation of the
`@ant/claude-swift` `computerUse` namespace that the Cowork orchestrator consumes
for "computer use":

- **Screenshots** via `grim` (wlr-screencopy) → resized and JPEG-encoded with
  Electron `nativeImage`, mirroring the Windows executor's
  `nativeImage.resize().toJPEG()` path.
- **Display enumeration** via Electron's `screen` API (the same source the
  Windows path uses for display rects).
- **Input primitives** (`moveMouse`/`mouseButton`/`mouseScroll`/`keys`/`key`/
  `typeText`) via `ydotool` (absolute pointer + click + scroll + type) with
  `wtype` as the keyboard fallback. These are **exported separately**
  (`createInput()`), not placed on the `computerUse` object — see §3.

### Gating (two flags, default off)

| Flag | Time | Effect |
|---|---|---|
| `ENABLE_EXPERIMENTAL_PATCHES=1` | build | `scripts/patch-cowork.sh` stages `computer-use-linux.js` next to the injected `@ant/claude-swift` stub (a `node --check`'d copy; non-fatal). |
| `ENABLE_COMPUTER_USE=1` | runtime | `stubs/claude-swift.js` `require()`s the staged module and sets `computerUse` to the grim/ydotool backend. |
| `COMPUTER_USE_RECON=1` | runtime | `stubs/claude-swift.js` installs a logging Proxy instead (diagnostic; see §2). Precedence over `ENABLE_COMPUTER_USE`. |

Both real-backend flags are required: the build flag controls the module's
*presence*, the runtime flag controls *activation*. With neither, the runtime
`require()` is never attempted and `computerUse` is `null`.

## Phase 2 — How the contract was established (no guessing)

Guessing this contract previously caused a SIGSEGV regression, so the interface
was reverse-engineered read-only before any backend was written:

- **Static:** `patches/recon-computer-use.mjs` (acorn walk over `.vite/build`)
  → `/tmp/cd-computeruse-recon.md`, recording every `computerUse`-namespace
  access, argument shapes, and return-consumption per call site.
- **Runtime:** the `COMPUTER_USE_RECON=1` logging Proxy records the live call
  sequence and returns permissive stand-ins (including a ≥1024-byte image — a
  1×1 PNG would fail the consumer's decoded-length check and short-circuit the
  flow it is meant to observe).
- Findings were cross-referenced between the macOS executor (`createDarwinExecutor`)
  and the Windows executor (`createWin32Executor`, which uses Electron
  `desktopCapturer`/`nativeImage` — the closest analog to a Linux backend) and
  adversarially re-derived.

`/tmp/cd-computeruse-recon.md` (Section 8) is the authoritative synthesis. That
path is in `/tmp` and ephemeral; regenerate the static portion with
`node patches/recon-computer-use.mjs`.

## Phase 3 — The verified `computerUse` contract

The namespace the backend implements (quality literal `0.75` = JPEG quality;
target dims are pre-capped to ≤1568 px / ≤1568 image-tiles by the caller):

| Method | Returns (consumed fields) |
|---|---|
| `display.getSize(displayId)` | `{width, height, scaleFactor, originX, originY}` |
| `display.listAll()` | `[{displayId, width, height, scaleFactor, originX, originY, isPrimary, label}]` |
| `screenshot.captureExcluding(allowed, 0.75, w, h, displayId)` | `{base64, width, height, displayWidth, displayHeight, displayId, originX, originY}` — base64 is **JPEG**, decoded length must be ≥ 1024 |
| `screenshot.captureRegion(allowed, x, y, w, h, w2, h2, 0.75, displayId)` | `{base64}` (only `.base64` consumed; x/y/w/h in logical points) |
| `resolvePrepareCapture(allowed, host, 0.75, w, h, prefId, autoResolve, doHide)` | the screenshot shape **plus** `{hidden:[], activated}`; on failure `{captureError, …zeros}` |
| `tcc.checkAccessibility()` / `tcc.checkScreenRecording()` | `boolean` — both must be true for `ensureOsPermissions` to grant on non-Windows |
| `apps.*` | `prepareDisplay`→`{activated, hidden}`, list/preview→`[]`, `appUnderPoint`/`iconDataUrl`→`null`, `open`/`unhide`→void |

All capture methods return the graceful `captureError` shape on `grim`
missing/failure rather than rejecting (PR #97), consistent with "missing tools
degrade to a no-op." Unidentified namespace members resolve to logged no-ops via
a Proxy, so an upstream addition can't throw.

**Input lives on a different surface.** `moveMouse`/`mouseButton`/`keys`/
`typeText`/`mouseScroll` are members of `@ant/claude-native`, **not** of
`computerUse`. Putting them on `computerUse` would contradict the recon, so
`createInput()` is exported for a deliberate future wiring into
`stubs/claude-native.js` and is **not** wired by this change.

## Phase 4 — Coordinate space (the single correctness risk)

The orchestrator's converter maps model coordinates (in the downsampled
screenshot-image pixel space) to click coordinates as:

```
clickX = round(modelX * screenshot.displayWidth / screenshot.width) + screenshot.originX
```

and passes the result **untransformed** to the input backend. So the one
invariant a Linux backend must hold:

> `screenshot.{displayWidth, displayHeight, originX, originY}` (and
> `display.getSize().{width, height, scaleFactor, originX, originY}`) must be in
> the **same coordinate space** that `ydotool`'s absolute pointer consumes.

This mapping is centralized in **one** function (`coordSpace()` /
`assumedScaleFactor()`). v1 assumes a **single output, scaleFactor 1, origin
(0,0)** — then native px == logical px == ydotool absolute px and the transform
is the identity. If the compositor reports fractional scaling the backend forces
1 and warns loudly rather than silently miscalibrating. Multi-output offsets and
DIP↔px conversion are TODO.

## Phase 5 — Why it is not reachable end-to-end

Wiring `computerUse` is necessary but **not sufficient**. The stock bundle
hard-gates Linux computer use in three independent places:

1. `hBA = new Set(["darwin","win32"])` — the platform allow-list. `ib()` (the
   master enable) returns `false` unconditionally on Linux, so the tool handler
   reports "Computer control is disabled" before any executor call.
2. The executor factory builds eagerly via
   `process.platform === "win32" ? createWin32Executor : createDarwinExecutor` —
   no Linux branch, so Linux falls into `createDarwinExecutor`, which **throws**
   at construction.
3. No Linux capability profile (only `darwin`/`win32`).

Lifting these requires AST patches in the SIGSEGV-prone minified bundle (add
`"linux"` to the platform set; add a Linux executor branch that pairs the
grim-backed screenshot with the `ydotool` input).

## Phase 6 — INVARIANTS tension and maintainer options

`INVARIANTS.md` records **"No Computer Use"** as a non-goal ("Requires
`xdotool`/`scrot` hacks that are fragile and version-sensitive. Out of scope for
the initial release."). This backend uses `grim`/`ydotool` (the Wayland
equivalents) and intentionally does **not** edit `INVARIANTS.md` — that file is
change-protected and resolving the contradiction is a maintainer call.

Options:

1. **Keep as-is (recommended for now).** The backend ships as inert,
   default-off infrastructure + recon. `INVARIANTS.md` stays authoritative
   ("No Computer Use"); nothing activates without two explicit flags *and* the
   still-missing bundle patches. Lowest risk; documents the path for a later
   decision.
2. **Ratify computer use as an experimental goal.** Amend `INVARIANTS.md` to
   carve out an experimental, default-off exception, then add the three bundle
   patches (gated like the other experimental AST patches) to make it reachable
   end-to-end. Larger surface; revisits a ratified non-goal.
3. **Revert.** If "No Computer Use" is to remain absolute, drop the backend and
   keep only the recon (`patches/recon-computer-use.mjs` + the report) as
   reference. (PR #96 already has a `revert-96-…` branch on origin.)

No option is applied here; this memo exists so the maintainer can decide with the
full contract and risk in view.
