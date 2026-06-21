# melk authoring — small model + grammar + self-correct

The capstone experiment: a **small WebGPU model**, running entirely in the
browser, authors `.melk` diagrams from natural language — **grammar-constrained**
to valid syntax and **self-correcting** from melk's deterministic
`validateSource` diagnostics.

It combines every thread of the broader exploration:

| Thread | Here |
|---|---|
| Small in-browser model | WebLLM / WebGPU (`@mlc-ai/web-llm` via CDN) |
| Grammar-constrained generation | `melk-grammar.js` — GBNF for a safe melk subset |
| Deterministic verifier in the loop | melk's `validateSource` (not a gameable proxy) |
| Self-correct from structured errors | the `E_*` code + `Hint:` fed back on failure |
| Library running in-browser | melk's published `dist/` via import-map + shim |
| Visible, verifiable artifact | a rendered SVG diagram |

## The architecture

```
  NL description
       │
       ▼   (system prompt = MELK_PROMPT_CARD)
  ┌─────────────────────────────────────────────┐
  │ small model  ──grammar-constrained──▶ .melk  │   form guaranteed:
  │ (WebGPU)        (MELK_GRAMMAR / GBNF)         │   output always parses
  └─────────────────────────────────────────────┘
       │
       ▼
  validateSource(.melk)   ← DETERMINISTIC verifier (meaning)
       │
       ├─ null  ───────────────▶ tryCompileToSVG → render ✓
       │
       └─ { code, message, hint }   ← a precise, non-hallucinatable signal
                │  append hint to the conversation
                ▼
            regenerate (self-correct) ── loop, up to N attempts
```

**Why this division is the whole point.** The grammar guarantees *syntactic*
validity — every output parses. It deliberately does **not** try to guarantee
*semantic* validity (no spine collisions, crossings within budget, no ambiguous
placement) — those are placement-time properties a context-free grammar cannot
express. Those are caught by `validateSource` and fed back as an **exact**
diagnostic (it names the colliding nodes and gives the fix), which the model acts
on. Form from the grammar; meaning from the verifier. Neither alone suffices.

This contrasts sharply with the CV-worker experiment, where the verifier was a
*gameable proxy* (sharpness). Here the verifier is **exact** — valid/invalid with
a precise reason — so the self-correct loop has the strongest possible signal.

## Files

- `melk-grammar.js` — the GBNF grammar (23 rules: directives, nodes, edges,
  pipeline/fan-out/bus/branch) + the condensed `MELK_PROMPT_CARD` system prompt.
- `authoring-harness.js` — `authorMelk()`: the generate → validate → self-correct
  loop. Engine-agnostic (takes a WebLLM-shaped `engine` + `validateSource`).
- `index.html` — wires WebLLM + melk + the harness, with a 3-pane UI: NL input +
  per-attempt log (generate → validate → correct), final `.melk`, rendered SVG.

## Run

```sh
# from the melk repo root
npx serve        # serve.json redirects / → /browser/ ; this page is at /browser/authoring/
# open  http://localhost:3000/browser/authoring/
```

Needs `npm run build` first if `dist/` is stale. Chrome/Edge 113+ (WebGPU).
First model load downloads weights (cached in IndexedDB).

Pick a small model (Qwen2.5-3B / Llama-3.2-3B handle grammars + this task well;
1B works but self-corrects more), **Load model**, then **Author diagram**.

## What's verified (without a browser/model)

The model can't run headlessly, but everything around it is tested:

- **Grammar is well-formed GBNF** — 23 rules, `root` entry, all references resolve.
- **Grammar-valid output parses** — sample strings the grammar permits compile
  through melk (4/5; the 5th is a *semantic* collision the grammar correctly
  doesn't prevent — exactly what the verifier loop is for).
- **The self-correct loop works** — with a mock engine emitting a colliding
  diagram then a corrected one, against the *real* `validateSource`:
  `generating → invalid (E_AMBIGUOUS_PLACEMENT) → [hint fed back] → regenerate →
  valid` in 2 attempts, recovering with a `branch`. The only mocked part is the
  model's text; the grammar, loop, verifier, and feedback wiring are real.

## The melk advantage

melk is a near-ideal target for this because its error design is built for it:
diagnostics name the exact nodes and give a copy-pasteable fix
(`E_AMBIGUOUS_PLACEMENT` → "use `branch <name>:right: <spine> -> c`"). That makes
the self-correct signal precise enough for a *small* model to act on — the LLM-
friendly library design and the grammar+verifier architecture reinforce each other.
