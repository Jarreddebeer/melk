# melk in the browser

Runs melk's **published `dist/` unmodified** in a browser tab — no build step,
no fork. A live `.melk` → SVG editor, and the foundation for wiring a
grammar-constrained in-browser model on top (so a small local model authors
`.melk` and gets it rendered + verified live).

## How it works

melk's core compile path — inline source + a **built-in theme** + no icons — is
pure computation over strings. The only browser obstacles are incidental:

1. Three core modules (`bind.js`, `theme.js`, `render/icons.js`) `import` Node
   built-ins (`node:fs`, `node:path`, `node:child_process`) at module top level —
   even though the core path never *calls* the fs/child_process ones.
2. The render path calls `process.stderr.write` (for `W_*` warnings) and
   `process.cwd()`; browsers have no `process`.

Both are solved without touching melk:

- **`node-shim.js`** — browser stand-ins for the Node built-ins. `path` functions
  are real (pure string ops); `fs`/`child_process` throw a clear
  "unavailable in browser" error (only reachable via the optional file/icon
  features). An **import map** in `index.html` maps the `node:*` specifiers onto it.
- A tiny **`process` polyfill** (inline in `index.html`, before any module loads)
  routes `stderr` warnings to `console.warn`.

`melk-browser.js` then just re-exports `tryCompileToSVG` / `validateSource` /
`compileToSVG` from `../dist/compile.js`. **That's the whole adapter.**

## Run

```sh
# from the melk repo root — any static server works
npx serve            # or: python -m http.server 8000
# open the served browser/ directory, e.g. http://localhost:3000/browser/
```

Module scripts + import maps need `http://`, not `file://`. The page loads
`../dist/`, so serve from the repo root (not from inside `browser/`).

> Run `npm run build` first if `dist/` is stale — the page loads the built `dist/`,
> not `src/`.

## What it demonstrates

- **A published library runs in the browser via import-map + shim, no bundler** —
  the "ship the schema/source, let the consumer adapt" principle from the
  grammar-vs-MCP discussion, applied to packaging.
- **melk's agent-loop API is browser-native:** `tryCompileToSVG` returns
  `{ok, svg} | {ok:false, diagnostic}`, and `validateSource` returns
  `null | Diagnostic` — a **deterministic verifier** with structured `E_*` codes
  and `Hint:` fixes. The demo's "structured error" example shows
  `E_THEME_UNKNOWN` exactly as an agent loop would consume it.

Verified: the real `dist/` pipeline produces valid SVG through the shimmed module
graph (a 3215-byte SVG for the payment-platform example), `validateSource`
returns `null` on clean input, and bad input yields the structured diagnostic.

## Limitations (the optional features that need files/network)

These surface a clean error rather than working, because they need `fs`/network:

- `import` of other `.melk` files (multi-file modules)
- custom themes from a `.json` **file** (built-in themes work fine)
- icon packs (local files or HTTPS)

For the browser experiment, use **inline source + a built-in theme + no icons** —
which covers the full language surface for single-file diagrams.

## Next: the model experiment

This page is the tool half. The planned experiment wires a small WebGPU model
(à la `webllm-agent`) that:

1. takes a natural-language architecture description,
2. emits `.melk` — **grammar-constrained** to valid melk syntax (melk's DSL → GBNF),
3. renders live via `tryCompileToSVG`,
4. on error, feeds the **structured `Diagnostic` (+ `Hint:`)** back for a retry.

melk is a near-ideal browser-model tool: a constrainable text DSL, a *deterministic*
verifier (`validateSource` — not a gameable proxy), and a visible artifact.
