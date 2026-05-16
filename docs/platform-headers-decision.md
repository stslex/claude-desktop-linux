# Decision memo: `stubs/platform-headers.js`

Audit trigger: `docs/audit-gemini.md:62` flags
`stubs/platform-headers.js` as
"Injects Anthropic-Client-OS-* headers into HTTP requests".

This memo answers, in order:

1. What the file actually does.
2. Whether it runs in the default build.
3. Whether it violates a documented invariant.
4. Whether it is load-bearing for Cowork independent of the in-asar
   platform-gate patch.
5. Three concrete options for the maintainer.

No code or wiring is changed by this run.

---

## Phase 1 — What the file does

`stubs/platform-headers.js` (267 lines) installs **three independent
header-injection layers** that fire only against Anthropic-owned hosts:

- **Host filter** (`stubs/platform-headers.js:35-42`):
  hostname must equal or end in `anthropic.com` or `claude.ai`.
- **Headers set** (`stubs/platform-headers.js:23-24`,
  `:50-51`):
  - `Anthropic-Client-OS-Platform: darwin`
  - `Anthropic-Client-OS-Version: 14.0`
- **Interception strategies**:
  1. `electron.net.request` is monkey-patched
     (`stubs/platform-headers.js:74-132`). For matching hosts it wraps
     `req.end` / `req.write` to call `req.setHeader(...)` before the
     request is flushed.
  2. Node `http.request`, `http.get`, `https.request`, `https.get` are
     monkey-patched (`stubs/platform-headers.js:137-231`). For matching
     hosts it mutates `options.headers` or falls back to `setHeader` on
     the returned `ClientRequest`.
  3. Electron `session.defaultSession.webRequest.onBeforeSendHeaders`
     is registered with URL filters
     `*://*.anthropic.com/*`, `*://*.claude.ai/*`, `*://claude.ai/*`,
     `*://api.anthropic.com/*`
     (`stubs/platform-headers.js:236-263`). This catches `fetch()` from
     the renderer.

Non-Anthropic hosts are not touched. `User-Agent` is not touched.
A `Symbol.for('__claudePlatformHeadersInitialised')` guard makes the
module idempotent across multiple `require()`s.

---

## Phase 2 — Wiring verdict: **ON_BY_DEFAULT**

Evidence chain (every reference to `platform-headers`, filtered for
build wiring):

| Step | File:line | Effect |
|---|---|---|
| 1. Copy into extracted app tree | `scripts/patch-cowork.sh:560-564` | Unconditionally copies `stubs/platform-headers.js` to `<MAIN_ENTRY_DIR>/platform-headers.js`. No `if` guard. |
| 2. Prepend `require(...)` into main entry | `scripts/patch-cowork.sh:586` | `echo "require('./platform-headers.js');"` inside the unconditional prepend block (lines 578-597). Idempotency check at line 579 keys on `module-load-patch`, not on this file. |
| 3. Post-patch syntax validation | `scripts/patch-cowork.sh:631` | Listed in the unconditional `for helper_file in …` validation loop. |
| 4. Summary log | `scripts/patch-cowork.sh:698` | Logged as one of the "Patches injected" — printed in the default summary block, not inside an `ENABLE_EXPERIMENTAL_PATCHES` conditional. Compare lines 692-694 which DO gate other items on `${ENABLE_EXPERIMENTAL_PATCHES:-}`. |
| 5. `scripts/inject-stubs.sh` | (no reference) | The file is **not** copied by inject-stubs.sh — only by patch-cowork.sh. |

There is no `ENABLE_EXPERIMENTAL_PATCHES` gate, no `COWORK_…` gate, and
no skip flag anywhere in the chain. The only env var that
`platform-headers.js` reads at runtime is `COWORK_DEBUG`, and that only
controls log verbosity (`stubs/platform-headers.js:25-29`); the
injection runs regardless of its value.

**Verdict: ON_BY_DEFAULT.**

---

## Phase 3 — Invariant cross-reference

The audit brief described CLAUDE.MD as containing a
"No platform spoofing in network headers" invariant and ARCHITECTURE.MD
as containing a "No HTTP header / User-Agent spoofing" non-goal. **Those
phrasings do not appear in either document.** The verbatim content
follows.

### CLAUDE.MD — Invariants section (`CLAUDE.MD:83-101`)

> ## Invariants — Never Break These
>
> - **All scripts must be idempotent.** …
> - **Every downloaded file must be SHA256-verified** …
> - **Patches must self-validate.** …
> - **No hardcoded versions anywhere.** …
> - **`set -euo pipefail`** at the top of every shell script.
> - **`main` must always produce a working build with default env vars.**
>   Any patch that breaks this MUST be feature-flagged off by default
>   (gated behind `ENABLE_EXPERIMENTAL_PATCHES=1` or an equivalent env
>   var) and documented in [README.md → Build Flags](README.md#build-flags).
>   Adding a new bundle-mutating patch and letting it run by default
>   before its failure modes are understood violates this invariant.

There is **no** "no header spoofing" invariant. The invariants section
is silent on header injection.

### CLAUDE.MD — Cowork section, "spoofed only" clause (`CLAUDE.MD:517-522`)

> - **Platform headers are spoofed only on Anthropic API requests for
>   Cowork activation.** `stubs/platform-headers.js` injects
>   `Anthropic-Client-OS-Platform: darwin` and
>   `Anthropic-Client-OS-Version: 14.0` on requests to `*.anthropic.com`
>   and `*.claude.ai` only. Without these headers, the server never
>   enables Cowork or serves the claude-code binary bundle. No other
>   domains are affected. We do not modify User-Agent strings or general
>   browsing headers.

This is the opposite of a "no header spoofing" rule — it is an explicit
disclosure that platform headers ARE spoofed, with stated scope.

### ARCHITECTURE.MD — Explicit Non-Goals (`ARCHITECTURE.MD:446-455`)

> ## Explicit Non-Goals
>
> **Targeted platform header injection (not general spoofing).**
> `stubs/platform-headers.js` injects `Anthropic-Client-OS-Platform:
> darwin` and `Anthropic-Client-OS-Version: 14.0` on HTTP requests to
> `*.anthropic.com` and `*.claude.ai` only. Anthropic's server checks
> these headers to decide whether to enable Cowork and serve the
> claude-code binary bundle — without them, Cowork never activates
> regardless of local patches. Every working Linux Cowork
> implementation sends these headers. We do NOT modify User-Agent
> strings, general browsing headers, or requests to any non-Anthropic
> domain.

This is filed under "Explicit Non-Goals" but is in fact a **disclosure of
what we DO do, framed as bounding the spoof** ("targeted … not general").
It is not a non-goal in the literal sense (something we refuse to do); it
is a scope statement.

### Plain-language verdict

Given Phase 2 (`ON_BY_DEFAULT`):

- The **claimed invariant** ("No platform spoofing in network headers")
  **does not exist in the repo.** No verbatim line forbids what the
  file does.
- The **documented behavior matches the code.** Both CLAUDE.MD (line
  517) and ARCHITECTURE.MD (line 448) honestly describe scope, target
  hosts, header names, and values. They also state the motivation
  (server-side Cowork activation) and the limit (Anthropic domains
  only, no UA changes).
- The audit entry `docs/audit-gemini.md:62` is **accurate but neutral**:
  it states what the file does. It does not assert a violation.

**The default build does not violate any verbatim invariant in
CLAUDE.MD or ARCHITECTURE.MD.** It does perform behavior — outgoing HTTP
header injection on third-party-controlled requests to third-party
hosts — that a reader who skimmed only the "Invariants" header might
not expect. Whether that documentary placement is sufficient is a
judgment call for the maintainer; see Option B.

---

## Phase 4 — Is it load-bearing for Cowork?

Two independent mechanisms in this repo address Cowork activation:

1. **In-asar JS platform-gate patch.**
   - `patches/find-platform-gate.mjs` locates a function in the minified
     main bundle that returns the Cowork availability verdict.
   - `patches/apply-platform-gate.mjs` (line 95) overwrites that
     function body with
     `{return{status:"supported",config:{}}}`.
   - `patches/platform-override.js` provides a runtime IPC-level
     fallback (`patches/platform-override.js:60-127`) that rewrites any
     `status: "unsupported" | "unavailable" | "disabled"` it sees on
     `ipcMain.handle` / `handleOnce` / `on` responses to `supported`,
     plus a renderer-side rewriter injected via `executeJavaScript`.

2. **HTTP header injection.** `stubs/platform-headers.js` —
   server-directed.

The platform-gate patch and override operate **entirely client-side**:
they rewrite what the local JS bundle returns when the client asks
"is Cowork available on this platform?". They cannot influence what
Anthropic's server returns when the client subsequently issues HTTP
requests for Cowork resources (feature flags, binary-bundle URLs,
config endpoints, session bootstrap).

The header injection targets the **server side**: it changes the
`Anthropic-Client-OS-Platform` and `…-OS-Version` values that the
server sees, which (per CLAUDE.MD:517-522 and ARCHITECTURE.MD:448-455)
is what causes the server to enable Cowork and serve the binary bundle
to this client.

These are addressing different gates. The in-asar patch is necessary
but, per the documented architecture, not sufficient; the headers are
claimed to gate server-side responses that the local patches cannot
forge.

**However, all of that is internal-documentation evidence, not direct
proof.** From source alone we cannot confirm what Anthropic's server
actually does when these headers are missing or set to non-`darwin`
values. The documentation cites prior Linux implementations
(johnzfitch, heytcass, patrickjaja, aaddrick) that ship the headers
(`stubs/platform-headers.js:8-10`), and the comment block at
`ARCHITECTURE.MD:451-454` asserts the server-side dependency, but no
in-repo source proves it.

**Verdict: UNVERIFIABLE FROM SOURCE — requires runtime test with
headers disabled.**

### Minimal runtime test that would settle the question

1. Build with the default flow (`scripts/patch-cowork.sh`).
2. Edit only the deployed `<MAIN_ENTRY_DIR>/platform-headers.js` to
   replace its body with `'use strict';` (no-op). Repack and reinstall.
3. With `COWORK_DEBUG=1`, sign in and observe:
   - HTTP responses to the Cowork availability / feature-flag endpoint
     under `api.anthropic.com` — verify whether Cowork is reported as
     available/enabled.
   - Whether the claude-code binary bundle download URL is served
     when requested.
   - Whether Cowork sessions can actually start a workload.
4. Compare to a build with headers enabled.

If Cowork remains fully functional with headers disabled, the file is
not load-bearing and Option A becomes cost-free. If any of the three
checks fails, the file is load-bearing.

---

## Phase 5 — Options

### Option A — Remove the file and all wiring

**Wiring changes required:**

- Delete `stubs/platform-headers.js`.
- Remove `scripts/patch-cowork.sh:560-564` (copy step).
- Remove `scripts/patch-cowork.sh:586` (the `require` line in the
  prepend block).
- Remove `scripts/patch-cowork.sh:631` (validation loop entry).
- Remove `scripts/patch-cowork.sh:596,698` (log lines).
- Remove `CLAUDE.MD:46`, `CLAUDE.MD:181`, the entire
  `CLAUDE.MD:264-275` "Platform Headers" section, and
  `CLAUDE.MD:517-522` bullet.
- Remove `ARCHITECTURE.MD:446-455` non-goal entry, or rewrite as
  "We do NOT inject platform headers" if the maintainer wants the
  affirmative statement.
- Remove `COWORK_DEBUG` from the env-var table if no other component
  uses it (it appears to be exclusive to platform-headers.js per
  `stubs/platform-headers.js:25`).
- Update `docs/audit-gemini.md:62`.

**Consequences:**

- Restores a clean "we do not touch network headers" posture.
- **If Phase 4's runtime test confirms server-side dependency, Cowork
  will silently fail to activate on default builds** — the server will
  decline to enable it for non-`darwin` clients regardless of the
  client-side platform-gate patch. Users would see the Cowork
  availability UI report success (because of the in-asar patch) but
  attempted sessions would fail when the server returns no binary
  bundle URL or no feature-flag enablement. This is exactly the
  failure mode the file's banner comment warns about.
- The CLAUDE.MD invariant
  "`main` must always produce a working build with default env vars"
  (`CLAUDE.MD:96-101`) would be at risk if Cowork is considered part
  of "working".

### Option B — Keep the file, amend docs to make the disclosure unmistakable

**Wiring changes required: none.**

**Doc changes required:**

- In `CLAUDE.MD`, add a bullet to the **Invariants** section (insert
  between current lines 100 and 101):

  > - **Network-header injection is restricted to a narrow allowlist.**
  >   `stubs/platform-headers.js` is the only mechanism in this repo
  >   that mutates outgoing HTTP request headers. It injects
  >   `Anthropic-Client-OS-Platform: darwin` and
  >   `Anthropic-Client-OS-Version: 14.0` and ONLY on requests whose
  >   hostname is `api.anthropic.com`, `*.anthropic.com`, `claude.ai`,
  >   or `*.claude.ai`. No `User-Agent` is modified. No other domain
  >   is touched. Any new code that mutates outgoing HTTP headers
  >   must either extend this file (with the same allowlist
  >   discipline) or be feature-flagged off by default.

  Rationale: the current disclosure exists but lives at
  `CLAUDE.MD:517-522`, well below the Invariants block. A reader who
  trusts the Invariants section as exhaustive will not see it.

- In `ARCHITECTURE.MD`, retitle the non-goal entry at line 448 so
  the heading itself states the affirmative behaviour. Replace
  `**Targeted platform header injection (not general spoofing).**`
  with one of:
  - `**We inject two Anthropic-specific HTTP request headers; that
    is the full scope of network spoofing in this project.**`
  - or move the entry out of "Explicit Non-Goals" into a new
    "Disclosed Spoofing" subsection above it. ("Non-Goal" + "we
    do this" is confusing wording.)

**Consequences:**

- No code or build changes; default Cowork behaviour preserved.
- Readers auditing the Invariants section see the disclosure inline.
- Slightly increases doc surface area; future contributors adding
  network-modifying code now have a clearer rule to point to.

### Option C — Gate behind `ENABLE_EXPERIMENTAL_PATCHES`

**Wiring changes required:**

- Wrap `scripts/patch-cowork.sh:560-564` (copy) and `:586` (require) in
  `if [[ "${ENABLE_EXPERIMENTAL_PATCHES:-}" == "1" ]]; then … fi`.
- Wrap `:631` validation entry behind the same guard, or add a
  pre-check that the file exists before validating it.
- Update the summary block at `:698` to read like the existing
  experimental entries (`:692-694`):
  ```
  log "  Platform headers    : $(if [[ "${ENABLE_EXPERIMENTAL_PATCHES:-}" == "1" ]]; then echo "Anthropic-Client-OS-* injected on anthropic.com/claude.ai"; else echo "SKIPPED (experimental)"; fi)"
  ```
- Update `CLAUDE.MD:181` and the Build Phases section at
  `CLAUDE.MD:153-200` to list `stubs/platform-headers.js` under the
  **Default-off (experimental)** subsection instead of the default-on
  list.
- Update `ARCHITECTURE.MD:448-455` to note the file is now opt-in.
- Update the env-var table at `CLAUDE.MD:103-117` so the
  `ENABLE_EXPERIMENTAL_PATCHES` description mentions platform-header
  injection.
- Update `README.md` build-flags section accordingly.

**Consequences:**

- Default `main` build no longer performs any HTTP header injection
  — the strongest restoration of the "no surprises in network
  traffic" posture without losing the file entirely.
- **If Phase 4's runtime test confirms server-side dependency,
  default builds lose Cowork** — same failure mode as Option A, but
  recoverable by setting `ENABLE_EXPERIMENTAL_PATCHES=1`.
- The flag's existing description ("AST patches that corrupt the JS
  bundle") becomes a mismatch: header injection is not bundle-AST
  corruption. Either rename the flag, split it (e.g.
  `ENABLE_PLATFORM_HEADERS=1` as its own gate), or accept the
  semantic drift. A dedicated flag is cleaner.
- This conflicts with the documented "Default-on patches" comment at
  `scripts/patch-cowork.sh` / `CLAUDE.MD:155-157`:
  "always run, must keep `main` green; if any of these starts breaking
  the build, fix it in place rather than feature-flagging it off".
  That guidance presumes "working build" excludes Cowork — the
  maintainer would need to confirm that's intended.

---

## Recommendation (deferred to maintainer)

If the Phase 4 runtime test were already run and showed the headers are
load-bearing, **Option B** is the lowest-risk path: code already
matches documented behaviour, and the only gap is that the disclosure
isn't quoted in the Invariants block where auditors check first. A
one-paragraph Invariants edit closes that gap without putting Cowork
back at risk.

If, instead, the maintainer values "main produces a build that touches
zero outgoing HTTP headers" more than "main produces a Cowork-functional
build", **Option C with a dedicated flag** (e.g.
`ENABLE_PLATFORM_HEADERS=1`, distinct from the existing
`ENABLE_EXPERIMENTAL_PATCHES`) is the cleaner expression of that.
Bundling header injection into the existing experimental flag muddies
its meaning.

**Option A is only justified if Phase 4's runtime test shows the file
is dead** — i.e. Cowork works server-side without the headers. The
existing in-code documentary evidence argues against that outcome, but
it has not been verified in this audit. Removing the file without
running the test means accepting the risk of silent Cowork breakage on
default builds.

The choice is yours. This memo records the state at HEAD `05b5e3f`
(branch `dev`).
