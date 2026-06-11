# melk — code review findings

**Date:** 2026-06-11 · **Scope:** material weaknesses with a primary lens on
LLM-authoring ergonomics (the package's `llm-friendly` keyword).

**Method.** Five agents simulated external LLM authors working *only* from the
shipped docs (`prompts/melk-author.md`, README, SYNTAX, EXAMPLES) on realistic
briefs — 3-tier web app, Kafka event-driven, CQRS, hub-and-spoke, and a
cold-start from README alone. Seven static reviewers covered the LLM surface,
diagnostics, API/CLI, docs accuracy, architecture, robustness, and tests. Every
material finding was then re-run by an independent adversarial verifier.

**Result.** 29 confirmed material findings, 10 plausible-but-unverified (their
verifiers hit a session limit; evidence quotes real `file:line` repros), 1
refuted. All five probes eventually produced faithful diagrams, in 1–7
iterations each.

**Status legend.** ✅ verified by re-running the repro · ⚠️ evidence cites
concrete repros but the adversarial verify pass did not complete · ❌ refuted.

---

## Resolution status (branch `review-fixes`, 2026-06-11)

Nearly all findings were fixed in one pass. Test suite went **411 → 500
passing** (13 → 6 skipped); all 42 non-ex-29 example goldens are byte-identical
after the refactors (behavior-preserving), verified by re-render.

**Fixed:**
- **P1 docs** — corrected the three wrong defaults (layout `lr`, crossings `0`,
  auto-size `5x5`) in SYNTAX.md; rewrote the `E_ANCHOR_CONFLICT` / two-bus and
  `E_SIDE_OVERSUBSCRIBED` catalogue entries; documented the routing-error family
  (§10.6) with author-level fixes; fixed the Composed-modules recipe (`entry: N`).
  Added `test/defaults.test.ts` (pins defaults) and `test/doc-recipes.test.ts`
  (validates every §3 recipe + §5 error example).
- **P2 diagnostics** — unified all CLI commands through one clean
  `[stage] E_CODE: message. Hint:` handler with `--debug` for stacks;
  `E_FILE_NOT_FOUND`; `validate` now renders so it catches `E_UNKNOWN_TAG`/
  `E_LEGEND_*`/theme errors; `E_THEME_UNKNOWN` lists built-ins; `E_UNKNOWN_DIRECTIVE`,
  `E_CHAINED_EDGE`, `E_UNKNOWN_PROPERTY` (with nearest-match) replace confusing
  parse errors; `E_UNROUTABLE` gains a back-edge hint.
- **P3 silent output** — `E_SELF_EDGE`; `W_LABEL_OVERFLOW` (with suggested size);
  `W_SUSPECTED_TYPO` (edit-distance endpoint check); `W_HIGHWAY_LABEL_IGNORED`;
  `E_TRACE_THROUGH_NODE` defensive guard. `test/guards.test.ts`.
- **P4 topology** — shape-aware `E_AMBIGUOUS_PLACEMENT` hint (converge / shared-tail
  / tree / side-channel); new EXAMPLES §3 recipes (fan-in-to-mid-pipeline, trees)
  + prompt entries, verified against the CLI.
- **P5 packaging/API** — new `src/compile.ts` with `compileToSVG` /
  `validateSource` / `tryCompileToSVG` (one canonical pipeline; fixes the
  module-bodies-dropped bug — `test/compile-api.test.ts`); `examples/**/*.melk`
  now ship in the tarball; condensed `prompts/melk-card.md`; README import fixed.
- **P6 architecture** — `Claims` struct replaces the 4 positionally-threaded maps
  across 10 routing helpers (kills the silent-transposition hazard);
  de-duplicated `pixelLayout`/`estimateLabelWidth` (deleted the false-cycle copies);
  `CELL_PX` replaces the `* 8` literals; removed dead `LANE_CLEARANCE` and a stale
  think-aloud comment. All behavior-preserving (goldens unchanged).
- **P7 tests** — `test/examples.test.ts` renders all 43 examples end-to-end with a
  node-overlap invariant; re-enabled & rewrote the 8 skipped bend-intersection
  tests against current geometry (no more vacuous `>= 0`); `test/cli.test.ts`;
  positive `E_AXIAL_OVERLAP` fixture.

**Deferred (with reason):**
- **ex-29 4-bend stair routing** — attempted; a contained version broke ex-27
  (over-broad swap detection) and OOM'd on 4×4 (unbounded mid-row search). It
  genuinely needs a precise dense-intersect gate + placer row-reservation, as
  next-session.md scopes. The `Claims` refactor landed here unblocks it. A
  positive `E_AXIAL_OVERLAP` test now pins the failure so the fix can flip it.

---

## What works well (do not regress)

The deliberately-designed surface is best-in-class and was praised repeatedly:

- `prompts/melk-author.md` "Rules that LLM authors reliably violate" pre-empted
  every classic trap — no probe hit `E_AMBIGUOUS_PLACEMENT` from a bare-edge or
  `E_HIGHWAY_AS_ENDPOINT`.
- The size-from-label table (`SYNTAX.md §3.3`) is mechanical and correct — zero
  size iterations across all probes.
- `EXAMPLES.md §3` recipes map 1:1 onto real briefs; 9/10 complete recipes
  validate **and** render clean.
- `E_AMBIGUOUS_PLACEMENT`, `E_SIDE_OVERSUBSCRIBED`, `E_HIGHWAY_AS_ENDPOINT`,
  `E_CROSSINGS_OVER_BUDGET` carry coordinates, name the construct, and ship
  copy-pasteable fix templates that work verbatim.
- Deterministic layout + `data-id`/`data-edge` SVG attributes make text-only
  verification by an LLM trivial.

The weaknesses below cluster precisely where design attention hasn't reached:
doc drift, the error layers *outside* placement, silent-wrong-output paths, and
converge/merge topology shapes.

---

## P1 — Docs contradict the compiler on load-bearing defaults

`SYNTAX.md` is the file LLMs are told to read "end-to-end", so every wrong fact
is taken at face value.

### ✅ Three core defaults are documented wrong *(major)*
Verified against `src/bind/bind.ts:218-219`:

| Claim | SYNTAX.md says | Compiler does | Consequence |
|---|---|---|---|
| `layout` default (§2.1, L97) | `tb` | `lr` | silently rotated diagram |
| `crossings` default (§2.2, L108) | "unlimited" | **0** | any crossing topology fails first-try |
| auto-declare size (§3.1, L233) | `2x2` | `5x5` | wrong size math |

The crossings default is the worst: most 20+ node briefs are non-planar, so an
author trusting §2.2 never writes `crossings: N` and always eats an iteration.
Three probes independently hit this. `EXAMPLES.md` and `examples/14-crossings.melk`
state `0` correctly, so the docs also contradict each other (and §2.2 vs
EXAMPLES §5's "conservative").
**Fix:** correct the three statements; add a doc-vs-code test that greps stated
defaults against `bind.ts` constants so they cannot drift again.

### ✅ EXAMPLES.md §5 error catalogue is wrong in two places *(major)*
- The `E_ANCHOR_CONFLICT` example (`bus a: [w1,w2] -> db` / `bus b: [w3,w4] -> db`,
  EXAMPLES.md:585-596, repeated in `melk-author.md:66`) actually raises
  `E_AMBIGUOUS_PLACEMENT` with a *branch*-fix hint that does not apply to the
  shared-sink shape — "the pattern that catches almost everyone". No documented
  source shape reaches `E_ANCHOR_CONFLICT` (`src/layout/place.ts:235`).
- The `E_SIDE_OVERSUBSCRIBED` threshold ("6th edge overflows", SYNTAX §3.11)
  is off by one: a default `5x5` hub holds 6 via the auto parity-bump; 7+ needs
  explicit `size:`.
**Fix:** replace the `E_ANCHOR_CONFLICT` example with a shape that triggers it
(or document that producer collisions surface first as `E_AMBIGUOUS_PLACEMENT`);
correct the capacity rule everywhere to "5 per face, 6 via parity bump, 7+ needs size".

### ✅ EXAMPLES.md §3 "Composed modules" recipe fails *(major)*
The recipe (EXAMPLES.md:474-487), copied verbatim with the real
`examples/modules/{edge,ingest,observability}.melk`, fails `validate` with
`[routeChannels] E_LANE_FULL: edge 'ingest -> observability' has no free
H-channel row…`. It is the only complete §3 recipe that fails, and `E_LANE_FULL`
is documented nowhere.
**Fix:** restructure the cross-module tap or pad the module gap (per the
`feedback-module-outer-gutters` note), re-verify against the CLI, document
`E_LANE_FULL`.

### ⚠️ Routing error family is undocumented *(major)*
`E_NO_CHANNEL`, `E_UNROUTABLE`, `E_LANE_FULL`, `E_AXIAL_OVERLAP`, `E_CLEARANCE`,
`E_DUPLICATE_*`, `E_INTERSECT_NOT_HIGHWAY`, `E_VIA_NOT_HIGHWAY` (≈20 thrown codes)
are absent from SYNTAX §10 — which claims to catalogue *every* error — yet are
reachable. `E_NO_CHANNEL`/`E_LANE_FULL` hints name levers with no grammar
("insert an empty column", "widen the corridor"). Duplicate node declaration has
no `E_` code at all.
**Fix:** add the routing-error family to §10 with `.melk`-level fixes; rewrite
hints in terms of author-controllable levers only.

---

## P2 — Diagnostics are two-tier; LLMs hit the wrong tier first

The clean `[stage] E_CODE: message. Hint: …` contract that `melk-author.md:144`
promises exists only inside `validate`/`format`.

### ✅ `render` dumps raw Node stack traces; `validate` passes files that then crash render *(major)*
`render` (the command agents actually run) prints ~15–20 line stack traces for
parse, routing, theme, tag, and legend errors. Worse, `validate` returns `OK`
for files that crash `render`:
- `a { tags: [hot] }` → validate OK, render dies with `ThemeError: E_UNKNOWN_TAG`
  stack (`src/theme/theme.ts:1091`).
- `legend: on` with no tags → validate OK, render dies with `LegendError`
  (`src/render/legend.ts:151`).
The documented loop ("iterate validate until OK, then render") therefore *ends*
in a crash dump. `src/cli.ts:158-160` even acknowledges stacks are "noisy when
an LLM is reading the output".
**Fix:** wrap the whole CLI dispatch in `runValidate`'s catch — print
`[stage] message`, exit 1, gate stack traces behind `--debug`; make `validate`
run tag/legend/theme resolution so render-time `E_` codes surface at the
documented checkpoint.

### ✅ Missing input file throws raw ENOENT on *every* command *(minor)*
`src/cli.ts:153` `readFileSync` runs before any try/catch, so a typo'd path
yields a raw `Error: ENOENT … at readFileSync (node:fs:440)` stack even under
`validate`.
**Fix:** catch ENOENT → `E_FILE_NOT_FOUND: <path>`.

### ✅ Parse / unknown-property / unknown-directive errors carry no code and no hint *(major)*
- `a -> b -> c` (the #1 construct ported from mermaid/graphviz) →
  `[parse] expected ident, got arrow` with no "wrap in `pipeline name:`" hint.
- Unknown attribute → `[bind] unknown node property: 'colour'` with no valid-set
  list and no nearest-match (`src/bind/bind.ts:1670`).
- Truncated block reports at the *next* statement, not the unterminated `{`.
**Fix:** assign stable codes to ParseError/BindError families; on unknown
property list valid names or nearest match; special-case `ident -> ident -> ident`
with a `pipeline` hint; report unterminated blocks at the opening brace.

### ✅ Unknown top-level directive → misleading "node declaration cannot have a port" *(major)*
`direction: lr` (a graphviz habit) or any unknown `word:` →
`[parse] node declaration cannot have a port` (`src/parser/parser.ts:736`) —
names a construct (ports) the author never wrote.
**Fix:** emit `E_UNKNOWN_DIRECTIVE: 'direction' is not a directive; known: layout,
theme, title, …` with nearest-match.

### ✅ Unknown theme name → filesystem ENOENT, no list of built-ins *(major)*
`theme: nonexistent-theme` → `[place] E_THEME_LOAD_FAILED: could not read theme
'…/tmp/nonexistent-theme': ENOENT…` (`src/theme/theme.ts:615`). An unknown
built-in name is silently reinterpreted as a path, misdirecting the agent toward
creating a file. Wrong stage tag (`[place]`), no source span, no catalogue.
**Fix:** when the value has no path separator and isn't a file, emit
`E_THEME_UNKNOWN: '…' is not a built-in (built-ins: document-light, …)`, carry
the directive's span, tag stage `theme`.

### ⚠️ `E_UNROUTABLE` is hint-less; forward-written cycles dead-end *(major)*
`a -> b`, `b -> c`, `c -> a` → `[routeChannels] E_UNROUTABLE: edge 2 'c -> a'
straight-line corridor … blocked by node 'b'` — no hint, unlike every placement
error. All three throw sites (`channels.ts:1145,1165,1364`) are hint-less. The
fix `c >- a` is one token.
**Fix:** when the unroutable edge points against the flow axis (target upstream
of source), append `Hint: 'c -> a' flows backwards; write it as a back-edge: 'c >- a'`.

### ✅ Strict fail-fast, no `--json`, undifferentiated exit codes *(minor)*
Independent bind errors are reported one-per-run; exit codes are uniformly 1 for
usage/missing-file/parse/place errors. No machine-readable diagnostics.
**Fix:** batch independent bind-stage errors; add `melk validate --json` emitting
`[{code,stage,message,file,line,col,hint}]`; document exit-code classes.

---

## P3 — Silent wrong output (worst category for a text-only agent)

An LLM cannot eyeball the SVG, so anything that validates OK but renders wrong is
invisible.

### ✅ Plain edges between two primitives' constructs route backwards through node interiors *(critical)*
`fan-out dispatch: publisher -> [topic_a..c]`, `bus sinks: [consumer_a..c] -> lake`,
plain `topic_b -> consumer_b`: validate OK, render "succeeds", but the trace
slices horizontally through the interiors of `publisher`, `enricher`, then
`coldstore`/`archiver`/`lake`. Root cause: the bus parks its all-unplaced
producers at col 0 on a fresh band, ignoring the plain edges from already-placed
topics, so a forward edge points ~560px backwards.
**Fix (a):** make the parking pass consider plain edges between parked constructs
when choosing band/column; or **(b):** extend the corridor block-check
(`channels.ts:1145`) to every leg of L/Z routes so it fails loudly with a hint.

### ✅ Typo'd edge endpoints silently auto-declare a new node *(major)*
`database {…}` then `api -> databse` (one-char typo): validate OK; render emits
both `data-id="database"` (orphaned, parked) and `data-id="databse"` (phantom
rect wired to `api`). The single most common LLM mistake — name drift — produces
a structurally valid but wrong diagram with zero diagnostics. Orphan parking is
explicitly deferred to "a future strict-mode pass" (`place.ts:815-824`).
**Fix:** `validate` reports auto-declared IDs; flag auto-declared names within
edit-distance 1–2 of a declared node (`did you mean 'database'?`), or ship the
documented strict mode.

### ✅ Label overflow is silent; the whole sizing burden is a manual table *(major)*
`SYNTAX.md:293` ("declared size is authoritative; nothing grows a box to fit its
label") + `melk-author.md:90` push a 6-row size table plus shape/caps/multiline
arithmetic onto every author, and getting it wrong overlaps text with `OK`. The
renderer already has `estimateLabelWidthPx` (`svg.ts:669`).
**Fix:** emit a non-fatal `W_LABEL_OVERFLOW` from validate/render using the
existing heuristic, with the exact recommended `size:` in the hint. This converts
the manual table into machine-checked feedback and removes the most
arithmetic-heavy rule from the prompt.

### ✅ Self-edges render garbage *(major)*
`worker -> worker { label: "retry" }`: validate OK; path `M 80 24 L 120 24` runs
through the `worker` rect interior (hidden under the fill, arrowhead poking the
face), label "retry" overprints the node label. No self-edge handling anywhere
in `src/`. Retry/feedback loops are routine in LLM briefs.
**Fix:** reject `a -> a` with `E_SELF_EDGE` + hint ("model retries as a back-edge
to an upstream stage"), or implement a real self-loop arc.

*(Also: `label:` on a highway node is silently dropped — validate and render both
succeed, nothing appears.)*

---

## P4 — Topology coverage gaps (the robustness map)

Canonical shapes are solid: 9/15 distinct topologies passed first-try with clean
geometry, 3 more recovered in one iteration off a good hint. Failures cluster on
**converge/merge** and **scale**.

### ✅ `E_AMBIGUOUS_PLACEMENT` emits one static hint, wrong for merge/converge shapes *(major)*
All seven probe occurrences got the identical branch/fan-out hint
(`place.ts:1215-1223`). It is correct for the bare diamond but inapplicable in
5/7 cases: chained fan-outs, branch-vs-pipeline-row collisions, bus-into-pipeline-
middle, plain-edges-into-middle, shared-tail pipelines (`web` and `api` both at
(0,0)).
**Fix:** make the hint shape-aware — the placer already knows whether the
colliding node is upstream (a producer/merge case) vs a fan-out leaf. Suggest
"fold `<node>` into the bus feeding `<target>`" / "split the pipeline at
`<target>`" accordingly.

### ⚠️ Fan-in to a pipeline's middle stage has no working natural encoding *(major)*
`pipeline main: ingest -> merge -> publish` + two external feeds into `merge`:
all three natural encodings (`bus feeds: [ext_a,ext_b] -> merge`, plain
`ext_a -> merge`, …) fail with `E_AMBIGUOUS_PLACEMENT`. The working fix
(split the spine; `merge` heads the tail pipeline) is documented nowhere.
**Fix:** add a "fan-in to a mid-pipeline stage" recipe to EXAMPLES §3/§5 and to
the prompt's violations list.

### ⚠️ Chained fan-outs (depth-3 trees) fail; fix is undocumented sizing arithmetic *(major)*
`fan-out root -> [mid_a, mid_b]` + a fan-out per mid → 2 leaves: leaves collide
(`E_AMBIGUOUS_PLACEMENT`). The only fix is sizing mids to subtree breadth
(`mid_a { size: 5x11 }`), documented nowhere; `offset:` cannot rescue it. Trees
are a top-5 LLM topology (org charts, routing tiers, decision trees).
**Fix:** make fan-out placement reserve the transitive subtree breadth of each
target, or document the breadth-sizing arithmetic.

### Bidirectional / request-reply has no story *(from probes)*
"Every spoke both sends to and receives from the hub" is among the most common
real topologies. The docs steer toward `>-`, which then fails with `E_LANE_FULL`;
the working form is plain edges. Back-edges also consume face slots
(`E_SIDE_OVERSUBSCRIBED` counted 8 for 4 bus + 4 back-edges) — undocumented.
`entry:`/`exit:` U-routing is unreliable: `entry: N` hard-failed where the
mirror-image documented case (`entry: S`, ex 41) works; `entry: E` validated but
rendered a degenerate flush-on-border trace.

---

## P5 — Packaging & API undermine the embedding story

### ✅ The npm tarball ships the docs but not `examples/` *(major)*
`package.json` `files` = `[dist, README, LICENSE, SYNTAX, EXAMPLES, prompts]`.
`npm pack` → 72 files, no `examples/`. Yet `EXAMPLES.md` has 103 `examples/*`
references (its §1/§2 indexes — ~35% of the file — are dead links in the
package), `melk-author.md:69` links `../examples/38-twelve-factor-web.melk`, and
`:28` says "Both files live in the project root" (false under `node_modules`).
**Fix:** add `examples` (at least `*.melk`) to `files`, or inline the referenced
sources into EXAMPLES and fix the "project root" wording for the installed case.

### ✅ Public API cannot reproduce the render pipeline; library import silently drops module bodies *(major)*
`src/index.ts` exports 9 pipeline functions; `cli.ts render` additionally needs
`placeModules`, `applyModuleAlignment`, `applyModulePortEndpoints`,
`applyTextFitToSizes`, `formatProgram` — none exported. Reproduced: the README's
documented library import renders `examples/33-modules-basic.melk` as 1807 bytes
/ 3 `<rect>` vs the CLI's 4560 bytes / 10 `<rect>` — module bodies silently
missing, exit 0, no error.
**Fix:** export one `compileToSVG(source, opts): string` that runs the exact CLI
pipeline (extract the `cli.ts render` body into `src/compile.ts`; CLI, library,
and tests all consume it). Replace the README "Library import" snippet.

### ✅ No machine-readable grammar; mandatory reading ≈ 23K tokens per stateless session *(major)*
`melk-author.md:18` requires reading SYNTAX.md (~13.4K tok) + EXAMPLES.md
(~7.9K tok) "end-to-end" before any output. No EBNF/JSON-schema/cheat-sheet
exists. README's "subsequent sessions remember the rules" is false for stateless
API sessions, which re-pay the full cost every time.
**Fix:** ship a self-contained ~2–3K-token authoring card in `prompts/`
(grammar cheat-sheet, the five §3 recipes, the placement-error table, the size
rule); make `melk-author.md` usable standalone with the big files as optional
deep references. Optionally add a formal EBNF appendix.

---

## P6 — Code health (do this *before* the ex-29 stair feature)

### ✅ Routing dispatcher takes 24 positional params; 4 same-typed maps threaded through 36 call sites *(major)*
`computeCellPath` (`channels.ts:1069-1301`, 233 lines) takes 24 positional
parameters. The four shared mutable maps (`cellOwner`, `bendOwner`, `vLegClaim`,
`hLegClaim`) are threaded positionally through ~12 helpers and 36 call sites;
three share the identical type `Map<string, number>`, so transposing them
compiles silently.
**Fix:** introduce a single `RouteContext` struct and pass it as one argument.
Rename-level change, covered by the existing 17 channel tests, eliminates the
silent-transposition hazard — and is the precondition for safely adding 4-bend
stair routing.

### ⚠️ ~550 lines of V/H mirror helpers have already diverged *(major)*
Six mirror pairs duplicate the same algorithm per axis (`tryUPathVtoH`/`HtoV`,
`tryPerimeterRouteVV`/`HH`, `pickMidCol`/`pickMidRow`, `isVLaneFree`/`isHLaneFree`,
`midColFits`/`midRowFits`). The sibling stair ratchet exists **only on the V
axis**, violating the project's own isometry rule. The stair feature doubles this
surface unless an axis adapter is extracted first.
**Fix:** extract an axis adapter for the lane-picking family (`pickMid*`,
`is*LaneFree`, `mid*Fits`) — a `{long, perp}` coordinate view over `Cell`, like
`extentOf` already does in `placement.ts`.

### ✅ Three hand-assembled pipelines have diverged *(major)*
`cli.ts render` (L208-231), `cli.ts runValidate` (L296-307), and
`module-place.ts` (L113-115) each assemble the stage order by hand;
`src/index.ts` implies a fourth, stale one. Same root cause as the library-API
finding.
**Fix:** one canonical `compile()` owning the stage order, consumed everywhere.

### ✅ Grid constants re-hardcoded; cross-stage invariants only in comments *(minor)*
`place.ts:1258` and `via-shim.ts:130` hardcode the 8px pitch as `* 8` (neither
imports `CELL_PX`). `LANE_CLEARANCE = 2` (`channels.ts:1779`) is dead — the real
ladder is the literal `[2,1,0]`; lane-search radius `32` is hardcoded 6×.
Contracts like `MEMBER_GAP ≥ router clearance` and `BACK_EDGE_PAD ≥ perimeter
pad` are unasserted.
**Fix:** `src/layout/grid-constants.ts` exporting the shared constants; replace
the two `* 8` sites first; delete dead `LANE_CLEARANCE`; add one cheap assertion
that the computed slot pixel falls inside the exit cell.

### ✅ Geometry helpers duplicated across layout/render *(minor)*
`svg.ts pixelLayout` (L469) re-implements `pixels.ts computePixelLayout` (L36),
citing a deleted `polyline.ts`. `svg.ts estimateLabelWidthPx` (L669) duplicates
`text-fit.ts estimateLabelWidth` (L31) "to avoid a cycle" that does not exist (no
`layout`/`bind` file imports from `render`).
**Fix:** import the originals and delete both copies; route inline footprint
`Math.max(1, Math.ceil(size))` loops through `footprintCells`.

### ✅ God functions sit exactly where the next feature lands *(minor)*
`assignSlots` 385 lines (`slots.ts:89-473`), `applyIntersections` 299
(`place.ts:868-1166`, with a `step < 40` bump loop and four separately-built
obstacle sets), `routeChannels` 259, `computeCellPath` 233. `pixelizeCellPath`
(`channels.ts:1942`) still contains a leftover think-aloud comment
"Wait, that's wrong for an L:".
**Fix:** split only along the seams the stair work touches — extract
`computeCellPath`'s four axis-pair branches into named functions taking the new
`RouteContext`, and extract `applyIntersections`' obstacle-set construction into
one `buildObstacleSet(excludeIds)` helper.

---

## P7 — Tests

### ⚠️ No end-to-end coverage of the 43 examples *(critical)*
No test loads any `examples/*.melk`; `examples/*.svg` are gitignored, never
compared; no CI. Rendering can silently regress wholesale.
**Fix:** an examples smoke test that runs the full CLI pipeline over every
`examples/*.melk` and asserts a tracked golden (or at minimum structural
invariants: node count, no overlapping rects, no box-cutting segments).

### ✅ Bend-intersection suite entirely skipped; two tests pre-neutered *(major)*
`test/bend-intersection.test.ts:72,120,149` — all three `describe`s `.skip` since
the Phase-4 rewrite. Lines 110 and 179 were rewritten to
`expect(x).toBeGreaterThanOrEqual(0)` — vacuous, so re-enabling restores nothing.
`E_AXIAL_OVERLAP` has no positive test.
**Fix:** rewrite against current geometry with real assertions; add a positive
`E_AXIAL_OVERLAP` fixture (ex-29's reduced topology) asserting it throws today
and routes cleanly after the stair fix.

### ⚠️ v0.1.3/0.1.4 shipped zero tests *(major)*
`git diff --stat 9d8b92f..HEAD -- test/` is empty across both releases, which
added ~900 lines to `channels.ts`/`place.ts` (U-routing, highway fan-out stair,
fan-out perp fix, multi-line labels).
**Fix:** backfill polyline-level tests for `entry:`/`exit:` U-routing, stair
monotonicity, the ex-41 perp anchoring fix, and multi-line labels.

### ⚠️ CLI and formatter have zero tests *(major)*
No test imports `src/cli.ts` or `src/parser/format.ts`. Untested: render's
default `-o` derivation + the v0.1.3 overwrite-safety guard (a regression
overwrites the user's source), validate exit codes / `[stage] E_CODE` shape,
format idempotence + comment-dropping.
**Fix:** CLI integration tests (extract `main()` handlers or spawn the CLI).

### ⚠️ Every test hand-rolls a different pipeline, none matching the CLI *(major)*
`test/channels.test.ts` and `test/bend-intersection.test.ts` omit the
text-fit/module passes the CLI runs. Same root cause as the `compile()` finding —
fixing P5/P6 collapses ~6 divergent pipelines into one.

---

## Refuted (kept for the record)

### ❌ "Hub-sizing rule is stale because hubs auto-size"
A reviewer argued `E_SIDE_OVERSUBSCRIBED` can never fire. The verifier confirmed
it *does* fire (probe-star hit it legitimately at 8 traces on a face); only the
documented *threshold* is off by one (captured under P1).

---

## Suggested sequencing (best safety-per-effort)

1. **Doc-truth pass** — P1 defaults + error catalogue + §5 corrections, plus a
   default-pinning test and a snippet-validation test. Hours; removes the most
   wasted iterations.
2. **CLI error unification** — one catch around all commands, `E_FILE_NOT_FOUND`,
   stacks behind `--debug`; make `validate` cover tag/legend/theme resolution. (P2)
3. **Warning channel** — `W_LABEL_OVERFLOW` with suggested `size:`,
   auto-declared-node report with did-you-mean, `E_SELF_EDGE`. (P3)
4. **`compileToSVG()` extraction** — fixes the library API, the divergent
   pipelines, and unblocks a 43-example golden smoke test in one move. (P5/P6/P7)
5. **Converge-shape recipes + shape-aware `E_AMBIGUOUS_PLACEMENT` hint**; document
   routing errors with author-level levers. (P4)
6. **`RouteContext` + axis-adapter refactor**, then the ex-29 4-bend stair feature
   on clean ground. (P6)
7. **Condensed authoring card** in `prompts/`; ship `examples/*.melk` in the
   tarball. (P5)

---

*Per-finding raw evidence (exact repros, file:line, verifier verdicts) was
captured in the audit workflow output and condensed here; the `tmp/` scratch
files the agents produced are disposable.*
