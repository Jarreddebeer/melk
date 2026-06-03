# melk — next session handoff

## ⚠️ READ THIS FIRST — current in-progress work

The **bend-intersection value-variation** feature has been a long iterative struggle this session. State as of the last message:

**What it does:** When two trace bends visually intersect (i.e. their chamfer regions share an exact `(x, y)` point — example: ex 24 `hwy->sink_b` chamfer ends at `(236, 28)` and `hwy->sink_c` chamfer starts at `(236, 28)`), the lower trace's stroke gets split into three sub-paths. The middle sub-path is a 24px axial slice starting AT the intersection, with an inline `<linearGradient gradientUnits="userSpaceOnUse">` stroke that fades from `ink-primary` (dark, at the intersection) to `trace-default` (default, 24px past). The trace itself carries the variation — no overlay paths.

**Detection rule (LOCKED — do not change without explicit user request):** Two bends intersect when their chamfer points (`lumpPoints[1..length-2]` of each bend, computed by `findBendCenters`) share an exact `(x, y)` value. Fan-outs don't intersect (each fan bend is at a different point). Pure '+' axial crossings have no chamfers so they don't qualify. Parallel stairsteps in adjacent rows don't share points so they're excluded too.

**User's view of where variation should appear:**
- ✅ Highway-exit bends in ex 24 (`hwy->sink_b` and `hwy->sink_c` interlocking at `(236, 28)`) → variation here is CORRECT
- ❌ ext_2 LEFT-side parallel-offset bends → variation here was WRONG (user explicitly excluded these). Detection now skips them.

**Files involved:**
- [src/render/svg.ts](src/render/svg.ts) — `detectBendIntersections()` (line ~696), `renderEdge()` (line ~760 with intersection-splitting branch), `findBendCenters()`, `pointsUpTo`/`pointsFrom`/`directionFromIntersection` helpers
- [test/bend-intersection.test.ts](test/bend-intersection.test.ts) — 7 tests covering the ex 24 fixture + fan-out negative cases. **All passing.** The CRITICAL test locks `hwy->sink_b` and `hwy->sink_c` having variation at the intersection. The negative tests confirm fan-outs DON'T trigger.

**Final user feedback before context clear:** "yeah so now i see a gradient, but i don't know what to make of it". The user CAN see the gradient now. Whether the visual works for them aesthetically is still open — they didn't say it was wrong, just unclear. **Do not make further changes to this feature without explicit user direction.**

**Hard-won lessons (see [feedback-intersection-means-crossing](C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\feedback-intersection-means-crossing.md)):**
- "Intersection" means literal screen-space crossing, NOT bbox proximity, NOT stairstep adjacency
- Never assume what the user means — confirm with concrete coords from the actual SVG output before implementing
- Write a unit test against the canonical ex 24 fixture FIRST, then make it pass

**Tests:** **296 passing + 3 skipped** (was 216 + 3 at Phase 4 close). +43 theme tests, +14 text-fit tests, +7 bend-intersection tests, +12 misc. The bend-intersection tests are in a dedicated file so they run on every change.

---

## Phase 5 elegance pass — landed earlier this session

Visual refresh across the whole renderer:

- **Theming system** ([DESIGN-PHASE5-THEMING.md](DESIGN-PHASE5-THEMING.md)) — semantic-token Theme with four built-in themes (`document-light` default, `document-dark`, `schematic-light`, `schematic-dark`), `theme:` directive in .melk, `--theme=` CLI flag, `{ tags: [...] }` brace-attr for per-node/per-edge style overrides via tag rules in the theme.
- **Softer-corporate palette** as new default: lighter slate traces (`#94a3b8`), charcoal ink (`#334155`), Tailwind 600 accents.
- **10pt body / 9pt edge** typography (was 13/11).
- **1.0px traces** (was 1.5px).
- **Measured text-fit** ([src/layout/text-fit.ts](src/layout/text-fit.ts)) — bumps cell width/height to contain labels; diamond stays square, cylinder enforces 2:3 min aspect, circle stays 1×1 with label below.
- **32px page margin** around the canvas.
- **2px rounded corners on rect** shapes; roundrect stays at 8px.
- **Highway nodes** render nothing (no enclosure); manhole circles only for `render: underground` highways, hollow, 2px radius.
- **Trace bends as rounded corners** via Q/C Bezier emitter in `polylineD()` — straight lines with smooth corner arcs.
- **Diamond trace endpoints clipped** to the diamond perimeter (was floating in the bounding-rect gap).
- **Rounded linecap/linejoin** on all traces.

## TL;DR (carried from previous session)

**Phase 4 + 4.1–4.6 are all landed and signed off.** **216 tests pass + 3 skipped at Phase 4 close, 296 now (Phase 5 + bend-intersection variation added).** 29 examples render. The grammar, placer, router, and renderer have been rewritten from the grammar up around grid-as-IR, tag-only annotations, strict-from-day-one errors, **local forward direction** (isometric primitives), **Z-depth** (underground highways), and now a **pixel-aware track packer** with multi-layered coherence passes.

**Git repository initialised** (2026-06-03). Initial commit `7fb9bb2`: src/, test/, scripts/, examples/*.melk sources, design docs. `.gitignore` excludes `node_modules/`, `dist/`, `examples/*.svg` (regenerate via `npx tsx src/cli.ts render`), `.claude/`, `tmp/`. No remote yet.

Brace-attr routing knobs and node attributes:
- `pivot: source | target` on edges (§11.7) — landed.
- `avoid: <ref>` on edges + `edgeset` annotation + path-search router (§11.8) — landed.
- `via: hwy` on edges + `shape: highway` (§11.9) — landed.
- `exit: N|E|S|W` / `entry: N|E|S|W` on edges (§11.10) — landed.
- `orient: horizontal|vertical`, `render: surface|underground` on highway nodes + `intersect a, b` top-level decl (§11.11) — landed.
- `slot-order: declaration` on any node (§11.12) — landed.
- **Cell.z** — highway nodes carry a Z-depth (0 = surface, -1 = underground from `render: underground`). Member nodes inherit Z for collision-avoidance purposes but render as surface boxes. `applyIntersections` dodges member overlap by bumping outward along the second highway's flow axis. `autoSizeHighways` expands intersecting highways' flow-direction lengths to fit the partner's breadth, producing an N×M intersection where every trace from one bundle can cross every trace from the other (§11.13) — landed.

**Examples 28 (3×3 + 3×3 perpendicular highways)** and **29 (9 surface + 9 underground, full N×M crossings)** are the canonical demonstrations of §11.11 + §11.13 working together. **Example 27** demonstrates `render: underground` on a single highway with manholes.

**Track packer refinements this session** ([src/layout/tracks.ts](src/layout/tracks.ts)):

1. **Same-source intra-bundle coherence pass** (`applySameSourceCoherence`). After interval-reuse, traces from the same source NODE (not just cell — Z-stacked highways at `intersect`-shared cells need per-node grouping) are permuted within their bundle's occupied ordinals so the trace with the deepest bend lands on the INNER track. Fixes the "bent ribbon" (ex 20 svc_a→egress), the "cross-target tangle" (ex 19 ext_1 svc_a/svc_b), and ex 24 chamfer overlap. All three were the previously-skipped polyline tangle tests; all now un-skipped and passing.
2. **Staircase flip rule.** For multi-corridor routes (e.g. `H1 → V1 → H2`), the trace's rank should FLIP at each chamfer. Position-parity is computed per-trace; when all siblings share the parity, the desired-order sort is inverted for odd positions. Fixes ex 29's `src_v3 → hwy_v` parallel ribbon.
3. **Pixel-aware interval encoding.** The conflict check now operates on actual y/x pixel ranges via `PixelLayout` (extracted to new module [src/layout/pixels.ts](src/layout/pixels.ts), shared with `polyline.ts`). Replaces the abstract `boundaryIndex * 100 + slotIndex` encoding, which was pixel-unaware and treated same-cell-row endpoints on differently-sized boxes as occupying the same long-axis range. Concretely: same-row through-traces with no real V-leg (`src_h2 → hwy_h`) no longer block real V-leg bundles (src_h1, src_v3) from sharing inner tracks. The leftmost src_v3 trace in ex 29 now bends at x=64 (instead of x=56), clear of src_h1's topmost H stub.
4. **Coherence direction signal switched to pixel-aware.** `applySameSourceCoherence` now uses `sign(exitPx - entryPx)` for bend direction (instead of `tgtCell.row - srcCell.row`). This catches the case where source and target are in the same cell row but their slot pixel-y's differ — needed for inlet→svc_a vs inlet→svc_b co-grouping in ex 19.
5. **Interval-safe re-allocation in coherence.** The permutation now tracks per-ordinal interval lists and falls back gracefully when the desired-order sort would put two overlapping-interval traces on the same ordinal. Fixes the ex 19 svc_b column-stacking regression that appeared mid-pixel-aware refactor.
6. **Cross-bundle stub avoidance** (`applyCrossBundleStubAvoidance`). NEW 4th pass operating ACROSS source-node bundles. Detects pairs of bundles in the same corridor with overlapping pixel intervals where one is "side-aligned" (all non-axial endpoints on the same near-side of the corridor) and the other is "fully-axial" (both endpoints are corridor-corridor transitions). If the side-aligned bundle currently sits on the FAR side of the corridor relative to the axial bundle, the pass swaps their ordinal RANGES so the side-aligned bundle moves to the side it enters from. Pure permutation — no new tracks, no demand change. Fixes ex 29's `src_h3 → hwy_h` vs `hwy_v → dst_v3` "S-overlap" in V1: src_h3 now bends up at x=40/48/56 (inner) instead of x=60/68/76; hwy_v→dst_v3 descends at x=64/72/80 (outer) instead of x=40/48/56. Eliminates 9 crossings.

**What's open right now:**
- **3 still-skipped track tests** in [test/tracks.test.ts](test/tracks.test.ts): legacy forced-crossing tests that routed planarly after the slot-allocator improvements. New forced-crossing topologies (against genuinely non-planar graphs) are needed to restore coverage.
- **Ex 19 ext_1 T-junction** (cosmetic): svc_a's V-leg endpoint touches svc_b's H stub at (136, 52). Segment-cross check says no actual crossing; user called the current state "perfect" but suggested a "silver bullet" where svc_a runs east further and turns down at the outer chamfer (x=152), sharing svc_b's column. The pair's pixel intervals overlap at [52, 56] (svc_a's chamfer zone), so they can't share an ordinal under the current strict-open conflict rule. Geometrically the chamfers would coexist (4px-offset parallels) but the rule is too conservative. User accepted "not worth the complexity" for one cosmetic touch-point.

If you only read one thing, read [DESIGN-PHASE4.md](DESIGN-PHASE4.md) — especially §11.7–§11.13. Then [feedback memories](#memory). Then this file.

## What's in the tree

```
src/
├── parser/
│   ├── lexer.ts        Phase 4 — tokens incl. cells, back-arrow, lbracket/rbracket
│   ├── parser.ts       Phase 4 — recursive descent over Phase 4 grammar including
│   │                   `branch <name>[:left|:right]: spine -> member` (single member)
│   └── ast.ts          Phase 4 — final statement types (nodeset/path, not tag);
│                       BranchDecl with side ∈ {left, right} (local-relative)
├── bind/
│   ├── bind.ts         Phase 4 — full projection: pipeline/bus/fan-out/branch/
│   │                   back-block; nodesets/paths attach with reference validation;
│   │                   deprecated lane/group/tag raise errors; populates
│   │                   `Model.anchors[]` in declaration order
│   └── model.ts        Phase 4 — Model { layoutMode, crossingsBudget, nodes[],
│                       edges[] (with EdgeSource incl. "branch"), pipelines[],
│                       buses[], fanOuts[], branches[], anchors[], nodesets[],
│                       paths[] }
├── layout/
│   ├── placement.ts    Phase 4 — Placement / Cell / FlowAxis / Direction /
│   │                   PlacementError. Adds `forwardAt: Map<NodeId, Direction>`
│   │                   — every node's local forward, populated by the anchor pass
│   ├── place.ts        Phase 4 — grid placer; anchors applied in declaration
│   │                   order via `model.anchors[]` (not kind precedence) so a
│   │                   branch declared between two pipelines is anchored after
│   │                   its parent and before any pipeline rooted on its member.
│   │                   Direction helpers (step / left / right). `anchorBranch`
│   │                   inherits parent's forward then rotates 90°
│   ├── corridors.ts    Phase 4 — `reserveCorridors(model, placement) → Reservation`.
│   │                   Side assignment is `(edgeFwd) → {source = fwd, target =
│   │                   opposite(fwd)}`. Edge forward derived per-source-kind:
│   │                   structured edges (pipeline/bus/fan-out/branch) use
│   │                   `forwardAt[edge.to]`; explicit edges use cell delta; back-
│   │                   edges use `opposite(forwardAt[edge.from])`. Corridor
│   │                   sequence uses gutterIndex(cell, side) for both same-row
│   │                   and same-col cases, eliminating the south-bias bug
│   ├── tracks.ts       Phase 4 — packTracks with pixel-aware interval
│   │                   encoding (entryPx/exitPx) + same-source intra-
│   │                   bundle coherence (deepest-target inner) + multi-
│   │                   corridor staircase flip + interval-safe re-
│   │                   allocation
│   ├── pixels.ts       Phase 4 — shared PixelLayout, slotPixel,
│   │                   computePixelLayout, vCorridorWestEdgeX,
│   │                   hCorridorNorthEdgeY. Single source of truth for
│   │                   pixel positions; consumed by both tracks.ts
│   │                   (interval encoding) and polyline.ts (emission)
│   └── polyline.ts     Phase 4 — buildPolylines; PixelLayout now from
│                       ./pixels.js (was locally defined)
├── render/
│   └── svg.ts          Phase 4 — Step 8 renderer. Inputs Model + Placement +
│                       Reservation + Polylines. Layer order: bg → nodesets →
│                       polylines → path highlights → boxes → labels → edge labels
│                       with halo. Canvas auto-expands to fit nodeset rects
├── cli.ts              Phase 4 — `parse`, `bind`, `render [-o OUT.svg]`
└── index.ts            Phase 4 — exports tokenize/parse/bind/place/
                        reserveCorridors/packTracks/buildPolylines/renderSVG +
                        Model/Program types

scripts/
└── polyline-preview.ts Step 7+8 eyeball-checkpoint helper. Now renders via the
                        real renderSVG. 10 examples to tmp/preview/

test/
├── parser.test.ts      66 tests — lexer, parser, bind projections (incl. branch
│                       single-member parse + bracketed-form rejection),
│                       deprecations
├── place.test.ts       28 tests — anchor pass per primitive (incl. branch
│                       left/right under LR + TB), conflicts, flow pass, units,
│                       orphan parking, forwardAt isometry tests
├── corridors.test.ts   83 tests — side assignment, corridor sequences, slot
│                       indices, capacity errors, demand, gutter widening
├── tracks.test.ts      22 tests (3 skipped — see "still-skipped track tests"
│                       below) — track packing + crossings budget + same-
│                       source coherence (bent ribbon, cross-target, staircase
│                       flip, Z-stacked highway groups)
└── polyline.test.ts    20 tests — pixel layout, chamfers, X-junctions, plus
                        un-skipped tangle regressions (ex 19 ext_1, ex 20
                        svc_a, ex 24 ext_2, ex 29 src_v3/hwy_v staircase)

examples/
├── 01-simple.melk            Phase 4 — pipeline + back-edge + labels
├── 02-back-edge.melk         Phase 4 — fan-out + bus hub with back-edge
├── 03-mixed-shapes.melk      Phase 4 (TB) — fan-out + mixed shapes + back-edges
├── 04-spine.melk             Phase 4 — pipeline + 2 branches
├── 05-lanes.melk             Phase 4 — 3 pipelines + cross-edges + nodesets
├── 06-groups.melk            Phase 4 — bus + fan-out + nodeset (was Phase 3 group)
├── 07-nested-groups.melk     Phase 4 — long pipeline + 2 overlapping nodesets
├── 08-spine-and-lanes.melk   Phase 4 — like 04 plus lane nodesets
├── 09-fan-hub.melk           Phase 4 — bus + fan-out stress test
├── 10-multi-port-group.melk  Phase 4 — fan-out into many channels + consumers
├── 11-backplane.melk         Phase 4 — 3 pipelines + cross-pipeline edges
├── 12-multi-bus.melk         NEW: bus + fan-out composition
├── 13-annotations.melk       NEW: nodeset + path on a pipeline
├── 14-crossings.melk         NEW: documents E_CROSSINGS_OVER_BUDGET + the fix
├── 15a-isometric-lr.melk     NEW: LR variant of an isometric pair
├── 15b-isometric-tb.melk     NEW: TB variant — same body, rotated geometry
├── 16-highway-bundle.melk    §11.9: horizontal highway, 3 src × 3 dst bundle
├── 17-highway-inlet.melk     §11.9: inlet highway with cluster nodeset
├── 18-highway-tb.melk        §11.9: TB-rotated 16; src_b uses slot-order: declaration to untangle
├── 19-highway-with-pipeline.melk §11.9 + downstream pipeline tail
├── 20-two-highways.melk      §11.9: ingress + egress flanking a cluster
├── 21-highway-mixed.melk     §11.9: bundle + direct side-edges to audit log
├── 22-highway-with-bypass.melk §11.9: orphan bypass producer alongside bundle
├── 23-highway-with-backedge.melk §11.9 + feedback back-edge outside the bundle
├── 24-mixed-bundle-bypass.melk  §11.9: two disjoint highways in one diagram
├── 25-exit-override.melk     §11.10: exit: brace-attr demo on 21's svc_c→log
├── 27-highway-underground.melk §11.11: render: underground with manholes
├── 28-highway-intersect.melk §11.11+§11.13: 3×3 + 3×3 perpendicular intersection
└── 29-highway-intersect-large.melk §11.11+§11.13: 9-surface × 9-underground full N×M crossings

DESIGN.md                  Phase 1 — HISTORY
DESIGN-PHASE2.md           Phase 2 — HISTORY
DESIGN-PHASE3-FLUX.md      Phase 3  — HISTORY
DESIGN-PHASE3B-CHANNEL.md  Phase 3b — HISTORY
DESIGN-PHASE4.md           **CURRENT spec — read first**
```

## What's done in Phase 4

All 10 steps from DESIGN §10 complete, plus two follow-on additions:

| # | Step | Status |
|---|------|--------|
| 1 | Delete Phase 3 routing/layout | ✅ done |
| 2 | Grammar additions + WxH sizing + deprecations | ✅ done |
| 3 | Bind to full Phase 4 Model | ✅ done |
| 4 | Grid placer | ✅ done |
| 5 | Corridor reservation | ✅ done |
| 6 | Track packing + crossings | ✅ done |
| 7 | Polyline emission + chamfers + X-junctions | ✅ done |
| 8 | Render integration (SVG renderer + CLI) | ✅ done |
| 9 | Migrate examples 01–11 | ✅ done |
| 10 | New Phase 4 examples 12–15b | ✅ done |
| + | `branch` primitive (single-member direction change) | ✅ added during Step 9 |
| + | Isometric refactor (local forward direction) | ✅ added during Step 9 |
| 11.7 | `pivot:` brace-attr + demand-aware picker | ✅ landed |
| 11.8 | `avoid:` + `edgeset` + path-search router | ✅ landed |
| 11.9 | `via: hwy` + `shape: highway` + via-anchor placer | ✅ landed |
| 11.10 | `exit:` / `entry:` per-edge face overrides | ✅ landed |
| 11.11 | `orient:` / `render: underground` on highways + `intersect` | ✅ landed |
| 11.12 | `slot-order: declaration` per-node | ✅ landed |
| 11.13 | Cell.z (Z-depth) — highways carry z, members inherit, perpendicular dodge, intersect-partner sizing | ✅ landed |

### Step 8 — render integration

Pipeline: `Model + Placement + Reservation + Polylines → SVG string`. Layer order: background → nodeset rects (dashed grey, behind everything) → polylines (forward + back; back-edges dashed) → path highlights (translucent colour overlay) → boxes (per-shape SVG generators: rect, roundrect, circle, diamond, cylinder) → node labels (centered) → edge labels (halo'd, on the longest straight segment). Canvas auto-expands to fit nodeset rects (otherwise tight diagrams clip the dashed frame at negative coords). Crossing markers are NOT drawn — Step 7's X-junction materialisation already handles the visible cases. CLI: `melk render path/to/file.melk [-o out.svg]`. Step 1 left `cli.ts` as a stub; Step 8 wired it up.

### Branch primitive (added during Step 9)

A `branch` is a **single-member direction change** that anchors one node one cell off a spine on a 90°-rotated axis and gives that member a rotated local forward. It's not a spine, not a fan, not a pipeline — it does exactly one thing. The `:side` suffix is `:left` (default, CCW from parent's forward) or `:right` (CW). Bracketed multi-member syntax was deliberately rejected; for a chain off the branched node, the user composes with `pipeline tail: member -> ...` (see DESIGN §6.4 and §11.6 for the rationale — the original `[m1, m2, m3]` form fanned the edges in a way that didn't match the chain geometry the placer produced, surfacing a visible routing bug at the first eyeball checkpoint).

The branch's most important property: **the branched member's forward is the rotated direction**, so any primitive rooted on it (pipeline, bus, fan-out, another branch) runs along the branched axis. That's what makes `pipeline tail: x -> z` chain *along* the branch direction without any extra ceremony.

### Isometric refactor (also during Step 9)

Before the refactor, downstream stages (corridors, slots, tracks) read `placement.flowAxis` — the global LR/TB toggle. After: each node carries a local forward (`Placement.forwardAt: Map<NodeId, Direction>`) populated by the anchor pass; downstream queries are per-edge or per-node, never global. Primitives now compose isometrically — a `bus` rooted on a south-pointing branch fans east-west (perpendicular to local forward), not north-south (perpendicular to page).

User-visible consequence: **`layout: lr` ↔ `layout: tb` rotates the entire diagram 90° without any other edits** (apart from box `size: WxH` if it needs to flip cell dimensions). See examples 15a / 15b for the canonical demonstration.

Mechanism details:
- `Placement.forwardAt: Map<NodeId, Direction>` cached by the placer
- `Model.anchors: AnchorRef[]` keeps declaration order across all primitive kinds so a branch declared between two pipelines is anchored in the right order
- `corridors.ts.assignSides(edgeFwd)` is direction-only — no `flowAxis` argument
- Per-edge forward: structured edges (`pipeline`/`bus`/`fan-out`/`branch`) take `forwardAt[edge.to]`; explicit edges take long-axis cell delta; back-edges take `opposite(forwardAt[edge.from])`
- The original south-biased corridor-sequence bug that triggered the refactor (visible as wild routing for `transform → enrich` in a branched diagram) is fixed by deriving corridor gutter indices from `gutterIndex(cell, side)` instead of hardcoded `src.row + 1`

### Slot-allocator + box-centering fixes (post-Step 10)

Two visible bugs surfaced in `15a-isometric-lr` and `15b-isometric-tb` during the eyeball check, both fixed before signing off:

1. **Sidecar kink** — `hub → sidecar` had a small diagonal jog because hub (size `2x3`) and sidecar (size `1x1`) sat at different x's even though both were in the same column. DESIGN §2.4 already specified "smaller boxes in a tall row are aligned to the row's centre line" but the implementation didn't do it. Fix: both [src/render/svg.ts](src/render/svg.ts) `boxBounds` and [src/layout/polyline.ts](src/layout/polyline.ts) `slotPixel` now offset boxes by `(colWidthPx - boxWidth) / 2` (and same for rows). Sidecar edge is now a clean two-point straight line in both LR and TB.

2. **15b crossings** — the TB variant routed fan-in and fan-out producers/consumers with inverted slot order vs spatial order, creating crossings that the LR variant didn't have. Root cause: the slot allocator tiebroke by *declaration order*, which under isometric rotation flipped relative to spatial order. Fix: the allocator now sorts primarily by **opposite-endpoint perpendicular position** (added `oppositePerp` to the `Pending` struct + `perpOf(side, otherCell)` helper in [src/layout/corridors.ts](src/layout/corridors.ts)). For a fan-out, hub's S face slot order now matches consumer column order; for a bus, hub's N face slot order matches producer column order. Works isometrically in both LR and TB.

The slot-allocator fix is a real topological improvement, not just an isometry fix. Five examples that previously needed `crossings: N` budgets are now genuinely planar at the default `crossings: 0`:
- `examples/05-lanes.melk` (was budget 10, now 0)
- `examples/11-backplane.melk` (was 30, now 0)
- `examples/14-crossings.melk` (was 5, now 0 — but kept at 5 so the example still demonstrates the budget mechanism)
- `examples/15a-isometric-lr.melk` (was 5, now 0)
- `examples/15b-isometric-tb.melk` (was 5, now 0)

These were left with their explicit budgets in place — the budgets don't hurt and the examples still serve their pedagogical purpose. `examples/03-mixed-shapes.melk` gained a `crossings: 5` budget (it was at default 0 before) because back-edge interaction with the new slot order now produces 3 crossings; pre-fix, it had 0 because back-edges were sorted differently.

**Test fallout:** three tests in `test/tracks.test.ts` exercised the old "two pipelines with cross-edges force a crossing" topology. Under the new allocator, that topology routes planarly. The tests are now `it.skip` with a comment explaining the obsolescence. **Phase 5 task: author a new forced-crossing test against a genuinely non-planar topology** so the crossings-budget error path stays covered. The straightforward attempts (K(2,2) bipartite, two buses with inverted cross-edges) all route planarly — the bidirectional V-corridor trick (forward and backward traces on disjoint track ranges) handles them. A genuine forced crossing needs same-direction inversions in a single corridor that no slot ordering can resolve.

### Examples — 16 total

- `examples/01.svg` – `11.svg`: migrated from Phase 1–3 sources. Used grammar primitives in this order: pipeline, bus, fan-out, branch, back, nodeset, path. Where Phase 3 examples had T-shirt sizes (S/M/L), I dropped `size:` (defaulting to 1x1) for small boxes and used `size: 2x1` / `1x2` etc. for explicitly-larger ones.
- `examples/12-multi-bus.svg`: bus + fan-out composition (DESIGN §8.2).
- `examples/13-annotations.svg`: pipeline + nodeset + path overlay (DESIGN §8.2).
- `examples/14-crossings.svg`: documents `E_CROSSINGS_OVER_BUDGET` failure mode plus the working fix (raise the budget) (DESIGN §8.2).
- `examples/15a-isometric-lr.svg` + `15b-isometric-tb.svg`: same diagram body under each orientation, showing the isometric rotation property end-to-end (DESIGN §11.6).

The original §8.2 also called for a "diagonal-routing diagram showing where 45° helps", which I substituted with the isometric pair. Reason: diagonals are still disabled (§11.4 locked "diagonals stay off in Step 7" and they remain off; a diagonal-specific example would render the same as Manhattan).

## What's next

Phase 4 is feature-complete from the original §10 plan. Phase 4.1 (in flight) is adding author-controlled routing knobs as eyeball-iteration surfaces. Possible next directions, depending on what you want to prioritise:

### Phase 4.1 + 4.2 + 4.3 — author-controlled routing

Triggered by the user's `examples/10-multi-port-group.melk` complaint (`ingest -> router` crosses the fan-out edges). Speced in [DESIGN-PHASE4.md §11.7](DESIGN-PHASE4.md#117-author-controlled-edge-routing-phase-41) (pivot), [§11.8](DESIGN-PHASE4.md#118-author-directed-obstacle-avoidance-phase-42) (avoid + path search), [§11.9](DESIGN-PHASE4.md#119-highways-phase-43) (highways), [§11.10](DESIGN-PHASE4.md#1110-author-controlled-exitentry-face-phase-44) (`exit:` / `entry:` — landed), and [§11.11](DESIGN-PHASE4.md#1111-underground-highways-and-intersections-phase-45) (underground + `+` intersections — spec only, not yet implemented).

**Phase 4.1 — `pivot:` + demand-aware picker (landed):**
- `{ pivot: source | target }` brace-attr on edges. Optional. See §11.7.
- Two-pass corridor reservation. Pass A counts demand assuming all diagonal forward edges use source-pivot; the picker flips any edge whose target-pivot would route through less-loaded corridors; Pass B finalizes. Deterministic, ties resolve to `source`.

**Phase 4.2 — `avoid:` + `edgeset` + path-search router (landed):**
- `{ avoid: <value> }` brace-attr on edges. Value is a name (primitive / edgeset / node) or an explicit edge ref (`a -> b`), or a bracketed list mixing both.
- `edgeset NAME: a -> b, c -> d, ...` as a new top-level annotation, parallel to `nodeset`. Lets authors name an arbitrary bundle of edges once and reference it from `avoid:` sites.
- `Model.edgesets` and `ModelEdge.avoidEdges?: number[]` in [src/bind/model.ts](src/bind/model.ts). Resolution is a deferred pass after all edges/primitives exist.
- New errors: `E_AVOID_UNKNOWN_REF`, `E_AVOID_UNKNOWN_NODE`, `E_EDGESET_UNKNOWN_EDGE`, `E_DUPLICATE_EDGESET`, `E_NAME_CONFLICT`, `E_AVOID_UNROUTABLE`. Self-reference silently dropped.
- **Path search router** (Dijkstra over corridor graph) replaces the canned Z generator for edges with `avoidEdges` set. Touching-vs-traversing handled by per-axis half-nodes at each grid intersection: arriving at an intersection via H corridor is distinct from arriving via V, so a blocked corridor can be crossed at an intersection without being traversed. Source-exit and target-entry corridors are self-exempt from blocks.
- Edges without `avoidEdges` still use the canned Z generator — no regression. 163 tests passing + 3 skipped (was 150 + 3); 13 new tests cover primitive/edgeset/node/edge-ref values, mixed lists, self-exemption, all error paths.
- Example 10 now uses `ingest -> router { avoid: channels }`. Route is `H6, V0, H3` — exit ingest N, west along H6, north up V0 (page-west margin, empty), east along H3, into router S. Matches the user's sketched red line.

**Known caveat: V0-overshoot (accepted by user as out of scope).** Because the path-search graph contains only **gutter** corridors (V0, V1, V2, …) — not interior-column corridors — the trace in V0 sits 24px west of router's vertical center, requiring a small east cut-back at H3 to enter router's S face. The cleaner geometry would route up the centerline of col 0 itself (which is empty between source and router) but the corridor graph doesn't include that path. User reviewed and accepted: "I am happy with the existing behaviour." Documented in §11.8 *Deferred* as the future "interior-column corridors" extension. Same Dijkstra search, richer graph.

**Phase 4.3 — `via:` + `highway` shape + via-anchor placer (landed in 2 cuts):**

- `{ via: hwy }` (or `{ via: [h1, h2] }`) brace-attr on edges. Single-highway only at 4.3; multi-via raises `E_VIA_MULTI_NOT_SUPPORTED` at bind time.
- New shape: `hwy { shape: highway }` — invisible (renders as dashed outline; no fill, no label).
- New anchor kind: `"highway-via"` in `Model.anchors`. The placer positions the highway's source-side members two cells back (W for horizontal, N for vertical) and target-side members two cells forward, stacked at consecutive perpendicular ranks centered on the highway. Two-cell gap leaves a gutter column for the bundle's approach/exit channels. `Model.highwayMemberships` records the per-highway source/target node lists.
- **Cut 1 (rejected by user)** used a custom `buildViaPolyline` that bypassed the corridor pipeline. Result was visible-only highway (dashed box) with handwritten 3-leg polylines that crossed each other inside the highway and didn't use the gutter cells as corridors. User: "WHY IS THE CORRIDOR PACK TRACKING NOT BEING USED BETWEEN THE NODE AND THE HIGHWAY?!?!" — fair, the parallel logic was wrong.
- **Cut 2 (landed)** — `expandViaEdges` in [src/bind/bind.ts](src/bind/bind.ts) replaces each `a -> b { via: hwy }` with two synthetic sub-edges (`a -> hwy`, `hwy -> b`), both with `source: "via-half"` and a shared `viaOriginal` index. The first half is marked `viaFirstHalf: true`. Downstream stages see them as regular edges with highway endpoints — slot allocation runs on the highway's W/E faces, track packing runs in the gutter corridors, polyline emission is the standard `buildOrthogonalPolyline`. The fan-in / fan-out comb-tooth shape emerges from the existing slot allocator's `oppositePerp` ordering. Renderer suppresses the arrowhead on `viaFirstHalf` edges so a via-edge looks like one continuous trace.
- Renderer expansion: highway nodes render as a dashed rect ([src/render/svg.ts](src/render/svg.ts) `renderNode` + `boxBounds`). Visible bounds are expanded at render time to span the source/target row range (for horizontal hwy) so the bundle has a visible enclosing region without claiming those rows as the highway's own cells.
- Auto-sizing ([src/bind/bind.ts](src/bind/bind.ts) `autoSizeHighways`): perpendicular axis = `ceil(N_via_edges / 3)` cells for face capacity; long axis = 2 cells minimum (visible length). The `width >= height` rule no longer determines orientation — it's driven by `layoutMode` (lr→horizontal, tb→vertical). Square highways are allowed.
- New errors: `E_VIA_UNKNOWN_HIGHWAY`, `E_VIA_NOT_HIGHWAY`, `E_HIGHWAY_AS_ENDPOINT` (user-written `a -> hwy` is rejected; via-half edges bypass this check because they're synthesized after the check runs), `E_VIA_MULTI_NOT_SUPPORTED`. Square `E_HIGHWAY_AMBIGUOUS_ORIENTATION` was removed in Cut 2.
- 174 tests passing + 3 skipped (was 163+3 after §11.8). +11 new tests cover auto-sizing, anchor registration, placer member positioning, error paths, expansion semantics (find sub-edges by `source: "via-half"` and `viaOriginal`), `via: composes with avoid:` (avoid preserved on second half).
- Examples 16 (`16-highway-bundle.melk`) and 17 (`17-highway-inlet.melk`) exercise the highway primitive. Both required `crossings: 10` because the bundle naturally has crossings when target order doesn't match source order. As of last session, examples regenerate cleanly with the Cut 2 architecture but **user has NOT yet eyeballed the final result.** First action this session: have user open both examples and confirm the comb-tooth fan-in/fan-out looks right.

**Decisions locked during §11.9:**

- Via-edges are an **author-facing abstraction**, NOT a routing primitive. They expand at bind time into pairs of via-half sub-edges. Author still can't write `a -> hwy` explicitly (E_HIGHWAY_AS_ENDPOINT); the synthesis is internal.
- Highway orientation comes from `layoutMode`, not the width/height ratio. Square highways are fine. (Reversed mid-implementation when the `width > height` rule conflicted with sizing for many-stacked-members highways.)
- The renderer expands highway visible bounds to span member rows; the grid cell for the highway stays 1 cell tall (otherwise the placer would push member rows apart unnecessarily).
- Highway as endpoint (`a -> hwy`, `hwy -> b`) is reserved for INTERNAL use (via-half edges). The grammar rule against it remains for user-written edges.
- Via-half edges that the second half of a via-pair (hwy -> tgt) carries the original edge's `avoidEdges` and `label`, so `via: + avoid:` composition works without special-casing in the router. First halves carry no avoid/label/arrow.
- The user-discovered "WHY ARE THE CORRIDOR PACK TRACKINGS NOT BEING USED" complaint is the binding constraint. Any future via/highway logic MUST go through the existing slot allocator + track packing + polyline emitter. No parallel routing pipelines. Saved as [feedback-comb-tooth-stagger](C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\feedback-comb-tooth-stagger.md) — note that file references the OLD failed implementation; the actual rule is now "use the existing pipeline".

### A) Address the remaining "10% issues"

The user has eyeballed all 29 examples through the §11.13 work plus the pixel-aware track packer refinements and signed off on the current state. Open issues remaining:

- **3 still-skipped track tests** in [test/tracks.test.ts](test/tracks.test.ts): legacy forced-crossing topologies that routed planarly after slot-allocator improvements. Need new genuinely-non-planar topologies to restore coverage.
- **Ex 19 ext_1 T-junction** (cosmetic, accepted): svc_a's V-leg endpoint touches svc_b's H stub at (136, 52). Segment-cross check returns false. Could be fixed by relaxing the strict-open conflict rule to allow chamfer-zone overlap (≤ COMB_PITCH/2 = 4px), but that risks introducing real crossings elsewhere. User accepted "not worth the complexity".
- **Highway composability limits** still partly in place:
  - Two highways sharing any member (source or target) raise `E_AMBIGUOUS_PLACEMENT` — the via-anchor offset math pins both highways to the same cell. Means no "shared sinks" or "shared sources" highway topologies.
  - Highway target nodes can't be `pipeline` roots — highway-via anchor runs after pipeline anchors in `Model.anchors[]`, so pipeline's (0,0) placement wins.
  - Non-via free edges from a via-anchored node trigger flow-pass collisions.
- **General polish** (lower priority):
  - Long labels overflow 1-cell boxes; need auto-sizing or wrapping.
  - Edge labels can collide with each other or with boxes on dense diagrams.
  - Nodeset frame placement / label rendering on tight diagrams.
  - Per-shape style polish (cylinder caps, diamond proportions, etc.).
  - **FIXME (Phase 5): Non-member node visually overflows a nodeset frame when text-fit grows it.** Reproduced in [examples/06-groups.svg](examples/06-groups.svg): `dashboard` (not in the `AuthService` nodeset) sits in the same col as `error` (which IS a member). Text-fit grew dashboard's box to 3 units (96px) while error stays at 2 units (64px, centered in the 3-unit col). Result: dashboard's right edge extends 16px past the nodeset frame, visually appearing to "leak out" of the group. Fixing properly needs either (a) snap nodeset bounds to col/row edges of cells that contain members — but that incorrectly *encloses* dashboard inside the frame; or (b) placement-pass change that puts non-member nodes in their own cols if they share a col with a nodeset member. (b) is correct, intrusive. Accepted as TODO post Phase 5 elegance pass.

### B) Author DESIGN-PHASE5.md

Phase 4 had a §9 "out of scope, deferred to Phase 5". Phase 5 would cover the items deferred — likely including: style configurability (font, colour palette, stroke weights), diagonal routing (the `:diag` opt-in or auto-upgrade), multi-line labels, label collision avoidance, and the unresolved "branch-rooted bus/fan-out direction" subtleties that surfaced during isometry work.

This is the most strategic next step. Decide the Phase 5 scope before adding new features that aren't designed.

### C) Tighten the test surface

Phase 4 has 145 tests, but the new isometric machinery and the `branch` primitive are lightly tested relative to the older code paths. Worth adding:
- More branch composition tests (branch off branch off branch; pipeline rooted on a branch member; back-edge inside a branched primitive)
- Determinism tests on the new isometric-pair examples — assert that 15a-LR rendered byte-for-byte matches a known golden, and same for 15b-TB
- A test that 15a and 15b have isomorphic geometry under rotation (would catch any future regression that breaks isometry)

### D) Step 8 visual polish

The §8 renderer is the first user-facing surface in Phase 4. Possible follow-ons:
- Settings: configurable font / palette / stroke weights via a `theme:` directive
- Crossing markers (currently invisible — Step 7's X-junctions handle the visible case but other crossings have only line intersections; might benefit from a small hop indicator)
- Path highlight colour assignment is round-robin — explicit colour declaration via `path X color: "#xxx": ...` would help when multiple paths overlap

## Decisions locked (don't re-litigate)

From DESIGN-PHASE4.md §11.1 (original) through §11.6 (isometric refactor). Key locks:

- **Cartesian grid, not hex.** 8 neighbours per cell; diagonals charged √2 length.
- **Diagonals are router's choice, not user's.** No per-edge opt-in.
- **Strict errors from day one.** No warnings. No opt-in strict mode.
- **Crossing budget defaults to 0.** User opts in with `crossings: N` directive.
- **Box size in cells, not pixels.** `size: 2x1`. T-shirts removed.
- **Annotations are two keywords.** `nodeset` (dashed bounding rect) + `path` (highlighted route). `tag` is a deprecation hatch.
- **Back-edges may use diagonals.** Router decides.
- **`lane`, `group`, `tag` are deprecated.** Migrate per §6.8.
- **No fallback to Phase 3 code.** Forward only.

From Step 4–7 locks (§11.2–§11.4): anchor conflicts are hard errors; slot-index assignment lives in Step 5; strict cardinal side rule; pixel coords throughout Step 7; 45° chamfered bends; X-junction = 4-corner swap.

From Step 9 additions (§11.5, §11.6):

- **`branch` is its own primitive, not a single-consumer `fan-out`.** Perpendicular semantics, doesn't consume forward cells, composes with `pipeline` without conflict.
- **Branch sides are `:left`/`:right` (local-relative), not the four cardinal names.** Cardinal names break isometry under inheritance.
- **`branch` is a single-member direction change, not a spine.** Bracketed multi-member form rejected; user composes with `pipeline` for chains.
- **Local forward, not global flow axis.** Every primitive's geometry is local-forward-relative. The placer caches forward per node in `Placement.forwardAt`; downstream stages query it.
- **Forward propagates along the anchor DAG.** Top-level primitives inherit from `layout:`; branches rotate 90°.
- **Branch defaults to `:left` = CCW rotation.** Under LR, `:left` = north (above spine); under TB, `:left` = east (right of spine — same CCW rotation in a rotated frame). The user's "swap LR/TB and it works" mental model requires this isometric reading rather than reader-relative naming.
- **Back-edge forward = opposite of source's local forward.**

## Memory

User-level feedback memories at `C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\` — load them at the start of every session:

- `feedback-circuit-board-metaphor.md` — the core metaphor
- `feedback-uniform-flux-rule.md` — flow is direction-symmetric
- `feedback-global-grid.md` — every coord on the 8-px grid
- `feedback-declaration-order-respected.md` — source order wins tiebreaks
- `feedback-design-doc-first.md` — write the doc before code
- `feedback-eyeball-cadence.md` — user previews SVGs at checkpoints
- `feedback-regen-goldens.md` — regenerate after rendered-output changes
- `feedback-phase4-philosophy.md` — Phase 4 rewrite rationale
- `feedback-generous-gutters.md` — union-count demand is by design
- `feedback-x-junction-geometry.md` — 4-corner swap, not full diagonals

## How to start the next session

1. Read this file (you're doing it).
2. Read [DESIGN-PHASE4.md](DESIGN-PHASE4.md) — focus on §2.5 (local forward direction), §6.4 (branch), §11.5–§11.6 (isometric refactor) and §11.7–§11.13 if you weren't around when they landed.
3. `npx vitest run` — should show 216 passing + 3 skipped (66 parser + 28 place + 83 corridors + 22 tracks of which 3 skipped + 20 polyline).
4. `git log --oneline` — initial commit `7fb9bb2` lands all of Phase 4. No subsequent commits yet.
5. Regenerate the 29 example SVGs (gitignored): `for f in examples/*.melk; do npx tsx src/cli.ts render "$f" -o "${f%.melk}.svg"; done` (bash) or the PowerShell equivalent. Then open `examples/*.svg` to eyeball.
6. If picking up direction A (fix the 10%), the highest-leverage remaining issues are the highway composability limits (shared members, pipeline-rooted targets) — the track packer is in a good place after this session's pixel-aware refactor.

## Quick gotchas

- **The renderer exits non-zero on placement / corridor / packing errors.** No partial SVG output. CLI consumers should check exit code.
- **`branch` is single-member only.** Bracketed `branch x: spine -> [a, b]` is a parse error; use composition.
- **`branch` sides are local-relative.** `:left` under LR points north (above the spine), under TB points east (right of the spine). Don't think in page directions; think in CCW/CW rotations from the parent's forward.
- **Isometry isn't free for box sizes.** A `size: 2x3` box rotates to need `size: 3x2` under the orthogonal layout. The grammar doesn't auto-flip; user has to swap WxH explicitly. (Examples 15a/15b demonstrate.)
- **`Model.anchors[]` is the source of truth for placement order.** The four typed arrays (`pipelines`, `buses`, `fanOuts`, `branches`) are unordered relative to each other; `anchors[]` records declaration order. If you ever add a new anchor kind, push it into `Model.anchors` from `bind.ts` and add a case in the placer's anchor loop.
- **No fallback when `crossings:` is too low.** The router fails with `E_CROSSINGS_OVER_BUDGET` and points at the worst-offender corridor. Five examples (05, 06, 10, 11, 14, 15a, 15b) ship with explicit budgets > 0.
- **Pixel-aware interval encoding is the new contract.** `tracks.ts` `assignTracksInCorridor` operates on `entryPx`/`exitPx` (real pixels via `PixelLayout`). Two traces conflict iff their actual y/x pixel ranges overlap (strict-open). If you ever modify the conflict semantics, remember: same-row through-traces (no V-leg) have degenerate intervals and SHOULD NOT block real V-leg traces — that's the whole point of the pixel-aware refactor.
- **Cross-bundle stub avoidance** is the 4th coherence pass. Runs AFTER `applySameSourceCoherence`. Limits at v1: only one swap per side-aligned bundle, no multi-iteration convergence, axial bundles must be UNIFORMLY axial (both endpoints corridor transitions) and side-aligned bundles must have all non-axial endpoints on the same near side. Mixed-side bundles (e.g. NEAR-WEST entry + NEAR-EAST exit, like src_h3 → hwy_h via V1) defer to the ENTRY side for the swap decision — works for ex 29 because src_h3's exit at y=288 doesn't actually conflict with any axial bundle (forwards span y=[320,448]). If a future diagram has BOTH entry and exit conflicting, the heuristic may not pick the optimal side; the comment in `applyCrossBundleStubAvoidance` notes the deferred "try-both" extension.
- **`pixels.ts` is shared by tracks and polyline.** `slotPixel`, `computePixelLayout`, corridor-edge helpers. Both stages must agree on pixel positions; don't duplicate the math in either.
- **Same-source coherence groups by source NODE id, not cell.** `intersect a, b` lets two highways share a cell; node-id keys keep their outbound bundles separate for coherence purposes.
- **Coherence direction is pixel-delta, not cell-delta.** `sign(exitPx - entryPx)` so inlet→svc_a (same row, slot 1 → slot 0.5) correctly groups with the southbound svc_b siblings rather than landing in a separate "flat" bucket.
- **The user's "90% correct" qualifier.** Capture defects before declaring anything done in a follow-up session.
