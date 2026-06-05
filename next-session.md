# melk — next session handoff

**Test count: 534 passing + 3 skipped. 39 examples. master is clean
(committed up to v0.1.2). Uncommitted: this session's work — see below.**

## Last session summary

Three threads landed:

1. **Four real-world example diagrams added** (examples 36–39).
2. **Docs overhauled** so the placement model is explicit and the
   common placer errors have copy-pasteable fixes.
3. **`back:` block syntax removed** — only `>-` remains for back-edges.

Everything renders, all tests pass.

### 1. New examples (36–39)

Drafted four canonical "blueprint" diagrams to broaden the example
set beyond the existing language-feature demos:

- [examples/36-fix-order-lifecycle.melk](examples/36-fix-order-lifecycle.melk)
  — FIX 4.x order flow with reject branch + amend/cancel back-edges.
  Showcases multiple back-edges sharing one source/target and
  declaration-order slot pinning.
- [examples/37-otc-swap-lifecycle.melk](examples/37-otc-swap-lifecycle.melk)
  — FpML-shaped OTC IRS lifecycle (execution → confirm → clearing →
  CCP → settlement) with bidirectional branches off a diamond.
- [examples/38-twelve-factor-web.melk](examples/38-twelve-factor-web.melk)
  — Heroku-style topology: LB → web → queue → workers → DB + cache.
  Demonstrates the "shared backing service" pattern (one anchoring
  bus, others reach via plain edges).
- [examples/39-kubernetes-request-path.melk](examples/39-kubernetes-request-path.melk)
  — `kubectl apply` → API server → kubelet → pod, with etcd up and
  scheduler down.

**Drafting cost** (the smoothness-of-experience signal): 36 took 1
placer-rejection round; 37 took 0; 38 took 4; 39 took 3. The pattern
in 38/39 was the same — two competing anchoring constructs both
trying to position downstream nodes one column past the same row.
That's what motivated the doc and grammar cleanup.

### 2. Doc overhaul

Five files changed, all doc-only:

- **[SYNTAX.md](SYNTAX.md)** — new §3.10 "Placement model" gives the
  grid mental model: nodes occupy cells, primitives anchor cells,
  bare edges extend the source row, collisions are the price of
  determinism. Six fix recipes keyed by collision shape.
- **[EXAMPLES.md](EXAMPLES.md)** — example count bumped to 39; new
  "Real-world architectures" subsection in §1; two new §3 recipes
  ("Shared backing service" and "Side-channel off a spine"); brand-
  new §5 "Placement errors and what they mean" catalogues
  `E_AMBIGUOUS_PLACEMENT` (with the five common source shapes that
  trigger it), `E_ANCHOR_CONFLICT`, `E_CROSSINGS_OVER_BUDGET`,
  `E_HIGHWAY_AS_ENDPOINT`, plus the rationale for strictness.
- **[README.md](README.md)** — example count updated; "How it works"
  bullet points at the new placement-model section; back-edges
  feature simplified to just `>-`.
- **[prompts/melk-author.md](prompts/melk-author.md)** — LLM authors
  now explicitly warned about shared-backing-service patterns and
  steered to `>-`.
- **[IDEAS.md](IDEAS.md)** — new sketch entry proposing future
  removal of the `back:` block (which then happened, see §3).

### 3. `back:` block removed (grammar trim)

Two back-edge forms had existed since Phase 4 — inline `>-` and
`back: { ... }` block. They produced identical edges. Zero examples
used the block; every back-edge in the example set used `>-`. The
block form was pure grammar surface with no expressive power, so it
was removed.

Surgery touched these source files:

- [src/parser/parser.ts](src/parser/parser.ts) — deleted the
  `back:` dispatcher branch in `decl()` and the `backBlockDecl()`
  method.
- [src/parser/ast.ts](src/parser/ast.ts) — deleted the
  `BackBlockDecl` interface; removed from the `Statement` union.
- [src/bind/bind.ts](src/bind/bind.ts) — deleted the `bindBackBlock`
  function and the `"back-block"` AST dispatcher case.
- [src/bind/model.ts](src/bind/model.ts) — renamed the
  `EdgeSource` enum value `"back-block"` → `"back-edge"` (the
  string was load-bearing in tests only; no layout/render code
  branches on it).
- [src/parser/format.ts](src/parser/format.ts) — deleted
  `formatBackBlock` and its category-order slot.

Docs / tests:

- [SYNTAX.md §1.6](SYNTAX.md) — removed `back` from the reserved-
  words list (it's now usable as a node id).
- [SYNTAX.md §4.2](SYNTAX.md) — simplified to show only `>-`.
- [SYNTAX.md §5.6](SYNTAX.md) — deleted the "`back:` block"
  cross-reference subsection.
- [DESIGN-PHASE4.md](DESIGN-PHASE4.md) — updated the edge-provenance
  list from `back-block` to `back-edge`.
- [test/parser.test.ts](test/parser.test.ts) — deleted the two
  block-form parse tests; replaced the three "bind — back-block
  projection" tests with two that exercise `>-` directly. Added one
  test confirming `back` is now a regular node id.
- [test/corridors.test.ts](test/corridors.test.ts) and
  [test/polyline.test.ts](test/polyline.test.ts) — updated source
  strings that used `back:` to `>-` instead.

### Verification

- `npx vitest run` — **534 passing, 3 skipped**. (Net delta from
  pre-session 536: removed 5 back-block-specific tests, added 3
  `>-`-specific tests = −2.)
- All 39 examples re-render. **None of the `examples/*.svg` files
  show as modified in `git status`** — the rename was a pure
  internal cleanup with zero impact on rendered output.
- `npx tsx src/cli.ts format examples/36-fix-order-lifecycle.melk`
  produces valid output; the formatter no longer emits a `back:`
  category but still handles inline `>-` correctly.

## What's in the tree

Examples now at **39**. Module library at
[examples/modules/](examples/modules/) unchanged. Demo theme at
[examples/themes/document-light-with-frames.json](examples/themes/document-light-with-frames.json).

**Untracked** (this session, not yet committed):

- `examples/36-fix-order-lifecycle.melk` + `.svg`
- `examples/37-otc-swap-lifecycle.melk` + `.svg`
- `examples/38-twelve-factor-web.melk` + `.svg`
- `examples/39-kubernetes-request-path.melk` + `.svg`
- `IDEAS.md` (the original file was untracked already; the
  back-block entry has since been deleted from it since the work
  landed — see "What's open" below)

**Modified** (this session, not yet committed):

- `DESIGN-PHASE4.md`
- `EXAMPLES.md`
- `README.md`
- `SYNTAX.md`
- `prompts/melk-author.md`
- `src/bind/bind.ts`
- `src/bind/model.ts`
- `src/parser/ast.ts`
- `src/parser/format.ts`
- `src/parser/parser.ts`
- `test/corridors.test.ts`
- `test/parser.test.ts`
- `test/polyline.test.ts`

The user has not asked for a commit yet.

## What's open right now

The user wanted to start a second batch of real-world examples
after the doc cleanup. From the recommendation list in the previous
turn, candidates still unbuilt:

- **CQRS + Event Sourcing** — command side → event store → projections
  → read models. Branch + back-edge.
- **Saga choreography** — order → payment → inventory → shipping
  with compensation back-edges. Great `>-` showcase.
- **Hexagonal / Ports-and-Adapters** — core domain in the middle,
  adapters fanning in/out.
- **Netflix microservices** — Zuul → Eureka/Ribbon → services → Hystrix.
  Highway bundle candidate.
- **ISDA collateral lifecycle** — margin call → dispute (back-edge) →
  agreement → transfer.
- **Repo / securities lending flow** — lender → agent → borrower →
  tri-party custodian. Bus + fan.
- **ISO 20022 / SWIFT gpi** — debtor bank → correspondent(s) →
  creditor bank, with tracker observability taps. Module candidate.
- **Card auth** — merchant → acquirer → network → issuer → back.
  Pipeline with the return path as `>-` lines.
- **Exchange matching engine** — gateways → order book → matching →
  drop copy + market data fanout. Fan-out + highway.

The smoothness-of-experience question is **the point** of doing the
next batch — the user wants to see whether the new docs + the
grammar trim make the second-batch authoring cleaner than the
first batch was.

Also still on the table (separate session) — the placer-error
improvement: when `E_AMBIGUOUS_PLACEMENT` fires, name the
*construct* that anchored each colliding cell, not just the cell.
That's a code change in
[src/layout/place.ts](src/layout/place.ts) around line 636.

## How to start the next session

1. Read this file (you're doing it).
2. Read [DESIGN-PHASE4.md](DESIGN-PHASE4.md), [SYNTAX.md](SYNTAX.md)
   §3.10 (placement model), and [EXAMPLES.md](EXAMPLES.md) §5
   (placement errors). These are the most recent and most relevant.
3. Check feedback memories in
   `C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\`.
4. `npx vitest run` — should show 534 passing + 3 skipped. If it
   doesn't, something has regressed since handoff.
5. `git status` — should show the long list above. If the user has
   committed in the interim, the picture is cleaner; otherwise
   expect to either commit early or keep working on top of the
   uncommitted state.
6. Pick a diagram from the open list above and draft. Track your
   placer-rejection-rounds count — that's the direct measure of
   whether the doc overhaul worked.

## Quick gotchas

- **Back-edges are `>-` only now.** `back:` is no longer a keyword;
  a file like `back -> next` parses fine as a regular edge.
- **`EdgeSource` enum string changed.** `"back-block"` is gone;
  back-edges now carry `source: "back-edge"`. No layout/render
  code branches on this string, but any new code that matches on
  `source` needs to use `"back-edge"`.
- **The placer is still strict.** The doc overhaul didn't change
  placer behaviour; it just makes the existing strictness easier
  to predict and recover from. `E_AMBIGUOUS_PLACEMENT` still fires
  for the same source shapes.
- **The four new examples each rendered after some iteration.**
  Diagram 38 (twelve-factor) took 4 rounds; if a similar topology
  comes up in the next batch, the §3 "Shared backing service"
  recipe in EXAMPLES.md should be the first place to look.
