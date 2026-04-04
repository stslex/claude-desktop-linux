# Phase 0 — Cowork/Dispatch Architecture Reconnaissance

**Date:** 2026-04-04
**Status:** Complete (static analysis from repo code; live bundle not available)

> **Note:** The Anthropic RELEASES.json endpoint was unreachable from the CI
> environment, so `fetch-and-extract.sh` could not download the macOS DMG.
> This report is based on **static analysis of the existing patch scripts,
> stubs, AST walkers, and documentation**, all of which encode detailed
> knowledge of the bundle's structure.  Findings are high-confidence for
> architecture questions but cannot include raw grep output from the live
> minified bundle.

---

## Findings

### 1. How @ant/claude-swift is used

**Single-line summary:** The bundle does `require('@ant/claude-swift').default.vm` and calls methods on the resulting `vm` object — it is a pure in-process module call, not an external daemon invocation.

**Detail:**

The stub (`stubs/claude-swift.js:340`) exports:

```js
module.exports = { default: { vm } };
```

The CLAUDE.MD explicitly states (line 137-149):

> Export shape (important — the app does `require(…).default.vm`):
> ```js
> module.exports = {
>   default: {
>     vm: { setEventCallbacks, startVM, spawn, kill, writeStdin, isRunning }
>   }
> }
> ```

The `vm` object is a single module-scope singleton.  All method calls go through this one object.  There is no factory, no constructor, no class instantiation — just a flat method bag.

### 2. File locations

Based on the patch scripts' scan targets:

| File | Role |
|------|------|
| `.vite/build/index.js` | **Main process bundle** — contains the Cowork orchestrator, platform gate, binary download logic, Dispatch feature flags, and `@ant/claude-swift` call sites.  This is the single file that `patch-cowork.sh` patches (via `package.json` `main` field). |
| `.vite/build/preload.js` | Preload script — renderer-side IPC, may contain `ComputerUseTcc` channel strings. |
| `node_modules/@ant/claude-swift/` | Replaced wholesale by `stubs/claude-swift.js` via `inject-stubs.sh`. |
| `node_modules/@ant/claude-native/` | Replaced wholesale by `stubs/claude-native.js`. |

The orchestrator logic (spawn, lifecycle, callbacks) all lives in `.vite/build/index.js`.  The platform-gate finder (`find-platform-gate.mjs`) scores functions in that file and the AST walker confirms `"supported"/"unsupported"` status objects, `"darwin"/"win32"` platform literals, and `process.platform` references all appear in this single bundle.

### 3. Socket/pipe transport presence

**Yes — the macOS bundle DOES contain socket/pipe transport code, specifically for the Windows path.**

Evidence from `patch-cowork-socket.mjs` (lines 28-33):

```js
const PIPE_PATTERNS = [
  'cowork-vm-service',
  '\\\\.\\pipe\\',
  '\\\\\\\\.\\\\pipe\\\\',
  'pipe\\cowork',
];
```

The patch script searches for these Windows named pipe literals in `.vite/build/` and expects to find them.  It replaces them with a platform-conditional expression that selects a Unix socket path on Linux or the named pipe on Windows.

The same patch also searches for `process.platform === 'win32'` / `process.platform === 'darwin'` guards near functions containing cowork-related strings (`'cowork'`, `'vm-service'`, `'vmStarted'`, `'apiReachable'`, `'subscribeEvents'`, `'writeStdin'`, `'isGuestConnected'`).

**Architecture implications:**

| Platform | Transport |
|----------|-----------|
| macOS | `@ant/claude-swift` → in-process Swift → `VZVirtualMachine` → vsock to guest |
| Windows | `net.createConnection('\\.\pipe\cowork-vm-service')` → named pipe → Hyper-V VM → vsock |
| Linux (this project) | Two layers: (a) `@ant/claude-swift` stub → direct `child_process.spawn`, (b) optional `cowork-vm-service.sock` Unix socket → `claude-cowork-service` daemon |

The bundle contains **both** code paths:
- The `@ant/claude-swift` module import (for macOS in-process VM control)
- The named pipe connection string `cowork-vm-service` (for Windows external daemon)

The `patch-cowork-socket.mjs` AST patch also searches for `net.createConnection` / `net.connect` patterns, confirming the bundle uses Node.js `net` module to speak to the daemon.

Additionally, `path-translator.mjs` (lines 285-302) monkey-patches `net.connect` and `net.createConnection` to translate `/sessions/…` socket paths, further confirming the bundle uses socket-based IPC for at least some code paths.

The protocol is length-prefixed JSON: 4-byte big-endian length header + UTF-8 JSON payload (CLAUDE.MD lines 274-289).

### 4. Event/callback shape

The bundle expects these callback names on the `vm` object, registered via `setEventCallbacks()`:

| Callback | Evidence |
|----------|----------|
| `onReady` | Stub implements it (`claude-swift.js:213`); `patch-cowork-socket.mjs` searches for it in diagnostic strings |
| `onExit` | Stub implements it (`claude-swift.js:268`) |
| `onStdout` | Stub implements it (`claude-swift.js:261`) |
| `onStderr` | Stub implements it (`claude-swift.js:264`) |

These are set as a single callback object passed to `setEventCallbacks()`:

```js
{ onReady, onExit, onStdout, onStderr }
```

Additionally, the `patch-cowork-socket.mjs` script searches for these protocol-level event/method strings in cowork-related functions:

| String | Context |
|--------|---------|
| `vmStarted` | Protocol method — check if VM environment is ready |
| `apiReachable` | Protocol method — check API connectivity |
| `isGuestConnected` | Protocol method — check guest agent connection |
| `subscribeEvents` | Protocol method — subscribe to lifecycle events |
| `writeStdin` | Both: vm object method AND protocol method |

The Windows/daemon path uses JSON-RPC style method calls over the socket.  The macOS path uses the same method names but calls them as in-process methods on the Swift vm object.

### 5. GrowthBook feature flags present

Based on `patch-dispatch.mjs` which searches for these exact numeric literals:

| Hash | Name | Expected in bundle |
|------|------|--------------------|
| `3572572142` | sessionsBridge (sessions-bridge init gate) | **Yes** — the patch script actively searches and patches this |
| `2216414644` | remoteSessionControl (remote session control check) | **Yes** — searched and patched |
| `1143815894` | hostLoopMode | **Yes** — searched and patched |

All three are confirmed present in the macOS bundle because:
1. The patch script (`patch-dispatch.mjs`) exists specifically to find and flip these flags
2. It searches for them as numeric `Literal` nodes in the AST
3. The `patch-cowork.sh` orchestrator runs this patch (behind `ENABLE_EXPERIMENTAL_PATCHES=1`)

Additionally, `patch-dispatch.mjs` searches for a **platform label function** (Sub-patch C) that returns `"Darwin"` / `"Windows"` based on `process.platform`, and patches it to also return `"Linux"`.

### 6. Stub gap analysis — methods called by bundle but MISSING from stub

| Method/Property | Evidence | Status |
|-----------------|----------|--------|
| `stopVM()` | CLAUDE.MD mentions `stopVM` is NOT in the stub export list but could be called by teardown code | **Potentially missing** — covered by Proxy catch-all |
| `isGuestConnected()` | Searched for in `patch-cowork-socket.mjs:237` as a cowork-related string | **Missing from stub** — covered by Proxy catch-all |

The stub uses a `Proxy` (lines 323-329) that catches unknown method calls and returns a no-op function:

```js
const vm = new Proxy(_vmBase, {
  get(target, prop) {
    if (prop in target) return target[prop];
    process.stderr.write(`[claude-swift stub] unknown vm method called: ${String(prop)}\n`);
    return function noop() {};
  },
});
```

This means missing methods won't crash — they'll log a warning and return `undefined`.  But if the orchestrator depends on a return value (e.g. `isGuestConnected()` returning `true`), the no-op returning `undefined` (falsy) could cause the orchestrator to think the guest isn't connected.

### 7. Stub excess — methods in stub that are NEVER called

| Method | In Stub | Evidence of being called |
|--------|---------|------------------------|
| `setEventCallbacks` | Yes | Called — documented in CLAUDE.MD |
| `startVM` | Yes | Called — documented in CLAUDE.MD |
| `spawn` | Yes | Called — documented in CLAUDE.MD, `patch-cowork-socket.mjs` lists `writeStdin` as nearby string |
| `kill` | Yes | Called — documented in CLAUDE.MD |
| `writeStdin` | Yes | Called — `patch-cowork-socket.mjs:237` searches for it |
| `isRunning` | Yes | Called — documented in CLAUDE.MD |
| **`isReady`** | Yes (`claude-swift.js:318`) | **Not in CLAUDE.MD export list** — may be dead code or an undocumented call |

`isReady()` is the only method in the stub that isn't listed in the documented export shape.  It may be called by the orchestrator but undocumented, or it may be stub-side insurance.

---

## Recommendation

**(A) In-process stub path is viable** — the bundle calls `@ant/claude-swift` methods as an in-process object.

The architecture works as follows:

1. The bundle does `require('@ant/claude-swift').default.vm` and gets a plain JS object
2. It calls `setEventCallbacks()`, `startVM()`, `spawn()`, `writeStdin()`, `kill()`, `isRunning()` on this object
3. The existing stub already implements this full API surface
4. The stub delegates to `child_process.spawn` on the host (with optional bubblewrap sandboxing)

To bridge to the `claude-cowork-service` Unix socket daemon, the stub should be expanded to:

- **Option 1 (current approach, working):** Keep the direct `child_process.spawn` implementation.  The stub IS the daemon — it runs processes directly.  This is simpler and already functional.

- **Option 2 (daemon delegation):** Add a thin Unix socket client layer inside the stub that speaks the length-prefixed JSON protocol to `cowork-vm-service.sock`.  The `spawn()` method would send `{"method":"spawn","params":{...}}` over the socket instead of calling `child_process.spawn` directly.  This would enable the daemon to manage process lifecycle, provide `isGuestConnected` / `vmStarted` / `apiReachable` responses, and support the full protocol.

**Recommended path:** Option 1 is already working for basic Cowork.  Option 2 should be pursued as an enhancement for Dispatch and full protocol compatibility, but it's additive — the in-process stub approach is architecturally sound.

The separate named-pipe→Unix-socket patch (`patch-cowork-socket.mjs`) handles the **other** code path in the bundle where the app connects to the daemon directly via `net.createConnection`.  Both code paths coexist: the `@ant/claude-swift` module for VM lifecycle, and the socket for supplementary protocol operations.

---

## Uncertainties

### U1: Dual transport coexistence
The bundle appears to have **two parallel transport mechanisms**:
1. `require('@ant/claude-swift').default.vm.spawn()` — for process lifecycle
2. `net.createConnection('\\.\pipe\cowork-vm-service')` — for supplementary protocol operations

It's unclear whether the socket transport is used **only on Windows** (where `@ant/claude-swift` doesn't exist) or **also on macOS alongside** the Swift module.  The `patch-cowork-socket.mjs` searches for platform guards (`process.platform === 'win32'` / `=== 'darwin'`) near the socket code, which suggests the socket path may be used on both platforms.

If the bundle uses the socket for operations like `isGuestConnected` / `apiReachable` / `vmStarted` even when the Swift module is loaded, then our stub's no-op Proxy catch-all won't be sufficient — we'd need the `claude-cowork-service` daemon to respond to these queries.

### U2: Exact methods called beyond documented set
Without the live minified bundle, I can't confirm the exact set of methods called on the `vm` object beyond what's documented in CLAUDE.MD.  The Proxy catch-all handles unknown methods gracefully (returns `undefined`), but methods that need specific return values (like `isGuestConnected() → true`) would fail silently.

### U3: `isReady` origin
The `isReady()` method is in the stub but not in the documented export shape.  It's unclear whether it's called by the orchestrator or was added speculatively.

### U4: GrowthBook flag flip reliability
The `patch-dispatch.mjs` strategy of finding `!1` (false) literals near flag hash constants and flipping them to `!0` (true) is fragile.  Minifier changes could move the boolean away from the hash constant, or the flag evaluation pattern could change.  Without running the patch against a live bundle, I can't confirm the current success rate.

### U5: `readUInt32BE` / `writeUInt32BE` protocol usage
The length-prefixed protocol is documented in CLAUDE.MD, and `patch-cowork-socket.mjs` searches for `cowork-vm-service` strings.  However, I couldn't grep the live bundle for `readUInt32BE`/`writeUInt32BE` to confirm the exact protocol framing code location.  The `claude-cowork-service` daemon (Go binary) implements this protocol, so the framing is confirmed on the daemon side — but the JS client-side framing code location in the bundle is unverified.
