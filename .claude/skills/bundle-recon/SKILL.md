---
name: bundle-recon
description: Reverse-engineer a symbol, function, call site, or interface contract inside Claude Desktop's minified main-process bundle (.vite/build/index.js, ~13 MB single line) WITHOUT guessing. Use when you need to know how the app calls a stub method, what arguments/return shape a native namespace expects, where a feature is gated, or to resolve a minified identifier. Covers safe byte-range slicing, offset-printing, acorn AST walks (recon-*.mjs pattern), and the flag-gated runtime logging Proxy. Guessing a contract here has caused SIGSEGV regressions — establish ground truth.
---

# Recon a minified-bundle contract

The main bundle is one ~13 MB line. Reading it whole overflows context and tools.
Establish ground truth from definitions AND call sites — never guess (guessed
shapes have caused SIGSEGV here).

## 1. Locate before you read — print offsets

```sh
export BUNDLE=/tmp/claude-build/app-extracted/.vite/build/index.js   # export so child `node` sees it
node -e 'const s=require("fs").readFileSync(process.env.BUNDLE,"utf8");
const re=/PATTERN/g;let m,n=0;
while((m=re.exec(s))&&n<60){console.log(m.index, JSON.stringify(s.slice(m.index-60,m.index+120)));n++}'
```

## 2. Read a region by byte range (never the whole file)

```sh
node -e 'const s=require("fs").readFileSync(process.env.BUNDLE,"utf8");process.stdout.write(s.slice(START,END))' | fold -w 200
```

Resolve a minified identifier (`dft`, `OIr`, `vE`, …) by reading its definition,
then every call site. Follow aliases (`const x = A.namespace; x.method(...)`).

## 3. Static AST recon (the recon-*.mjs pattern)

For anything beyond a couple of sites, write a read-only acorn walker modeled on
`patches/recon-dispatch-flags.mjs` / `patches/recon-computer-use.mjs`. Use the
shared helpers in `patches/patch-utils.mjs` (`collectJsFiles`, `tryParse`,
`createLogger`). Record, per call site: the full member chain, argument source
text, await/destructuring (return-shape hints), and frequency. Emit a markdown
report; do not modify the bundle.

```sh
node patches/recon-computer-use.mjs        # example: writes /tmp/cd-computeruse-recon.md
```

## 4. Runtime recon — a flag-gated logging Proxy

When static reading can't reveal the live call sequence/payloads, install a
logging Proxy in the relevant stub behind a NEW env flag (mirror the `vm` Proxy
in `stubs/claude-swift.js`). It logs `method | argCount | args` and returns
maximally permissive stand-ins so the orchestrator PROCEEDS, revealing which
return shapes make it continue vs. error. Precedents:

- `COMPUTER_USE_RECON=1` → logs `computerUse.*` calls to `/tmp/cd-computeruse-recon.md`.
- `DISPATCH_DEBUG=1` → logs Dispatch IPC traffic.

The proxy must be inert without its flag (default behaviour byte-for-byte unchanged).

## Pitfalls

- Stand-in images must satisfy any size/format validation the consumer applies
  (e.g. the computer-use path rejects a screenshot whose decoded base64 is < 1024
  bytes) — a 1×1 PNG can short-circuit the very flow you're trying to observe.
- `index.js` may parse as ESM or script — `tryParse` tries both.
- Capability/platform gates often live far from the methods they gate; search the
  whole bundle, not just the local region.
- A finding is "high confidence" only when you've read BOTH the definition and a
  call site.
