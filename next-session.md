# melk — next session handoff

**Test count: 401 passing + 13 skipped. 43 examples, 40 rendering.
Working tree clean — `master` at `11b2f1e` (Phase 4 channel routing
+ this session's fixes amended into the original Phase 4 commit).
Untracked: `scripts/probe-*.ts` — debug-only, kept out of the commit.**

## What landed this session (amended into `11b2f1e`)

The whole Phase 4 channel-routing commit has been amended with the
fixes below. Original Phase 4 work is documented in the commit message;
this file covers what was added on top.

### Sizing pass across 49 examples

- **`scripts/probe-autofix.ts`** — AST-based audit + rewrite. For each
  `.melk` it computes `neededBoxWidthPx` for every node's label and
  adds an explicit `size: WxH` to fit. Grow-only by default. Excludes
  `shape: circle` and `shape: icon` body-form (labels render below the
  glyph, so growing the bounding box just detaches edges from the
  circle perimeter). Idempotent — running twice on the same tree is a
  no-op.
- **Selective shrink of over-tall hub boxes** done by hand on top of
  the grow pass: 09-fan-hub `switch` 9x17→9x11; 12-multi-bus `hub`
  11x13→11x9; 15a `hub` 9x13→5x7; 15b `hub` 13x9→7x5; 10
  `router` 9x13→9x9; 03 `db` 7x9→7x5; 02 `fanout` 5x13→7x5 and
  `join` 5x13→5x5; `modules/compute` scheduler/aggregator 9x9→9x5.
- **Example 05 cleaned up.** Updated comment to drop the obsolete
  "Phase 3 `lane` keyword" reference; dropped the topologically odd
  `ods → api` edge; resized `api` from 5x7 → 9x5 so it sits naturally
  on one lane row.

### Placer fixes (`src/layout/place.ts`)

- **`anchorPerpOf` — TB bus/fan-out median centring.** `(first + last) / 2`
  in perpOffset space only matches the cell-frame block centre when
  `-pStep` points cell-positive. Under TB (-pStep = -col), members
  extend cell-positive from a *negative* leading-col, so the perpOffset
  midpoint maps to the wrong cell and the bus's `shared` lands off-axis
  from the median producer. Fix: compute block centre directly in cell
  coordinates using a `pStepSign` parameter (+1 LR, −1 TB). Result:
  under TB the median bus producer / fan-out consumer column-aligns
  with the hub, so the median trace is a straight vertical.
- **`anchorBranch` centring shim.** Same bug, different primitive.
  Spine and member with different widths used to share a leading edge
  (so `branch sidecar` off a 5-wide `hub` had a 7-wide sidecar offset
  by 1 col). Added `floor((spineFwdExt − memberExtOnParentFwd) / 2)`
  along the `parentFwd` axis. Test in ex 15a: `hub->sidecar` is now
  a single straight vertical.
- **`flowPass` centring shim.** Bare forward / reverse-flow edges had
  the same problem (e.g. small `client` placed above wide `api` was
  left-aligned to api). Added the analogous shim — perp axis offset of
  `floor((fromPerp − toPerp) / 2)` for forward, `floor((toPerp − fromPerp) / 2)`
  for reverse. Helper `perpShimAlong` lives next to `stepForward` /
  `stepBack`.
- **`applyAnchor` parking pad.** When a construct with no already-placed
  members is parked at `ctx.nextFreeRow`, pad by `MEMBER_GAP` rows if
  the diagram already has other nodes. Mirrors `nextOrigin`'s padding.
  Without it, disconnected pipelines stacked at flush row boundaries
  (ex 05 lanes touched, nodeset rectangles visually overlapped).
- **Back-edge grid padding (in `normalise`).** When the model contains
  any back-edge, reserve a 2-cell buffer around the diagram. This is
  what gives `tryPerimeterRouteVV/HH`'s "search from grid edges
  inward" room to route truly *outside* the outermost nodes rather
  than threading through whatever interior gap happens to be free.
  Without it, ex 03 `db → api` had no usable col outside `auth` and
  fell back to an interior gap.

### Channel router fixes (`src/layout/channels.ts`)

- **`tryPerimeterRouteVV` and `tryPerimeterRouteHH`.** Back-edges land
  in outer slots whose pixel y/x is *inside* the source's vertical/
  horizontal span, so the standard Z's transverse leg runs at
  `srcExit.row` or `tgtExit.row` — inside any neighbouring box on the
  same row/col. New helpers pick a row strictly outside src AND tgt
  spans AND every footprint between them; the back-edge does V up,
  H across the perimeter, V down. Falls back to standard Z if no
  usable perimeter exists.

  Candidate iteration order is **grid-edge inward** (row 0 first, then
  row 1, ... up to `minTop`; then last row down to `maxBot + 1`). With
  the placer padding above, this routes around the outside of the
  diagram rather than through interior gaps.

- **`detectAxialOverlaps` post-pass.** Two distinct edges' orthogonal
  polylines sharing a non-trivial pixel range on the same axis now
  raise `E_AXIAL_OVERLAP`. Detection runs on the pre-chamfer ortho
  with each segment shrunk by `CELL_PX` on each end — legitimate
  corner-touch at bends doesn't fire, but long collinear co-runs do.
  Defence-in-depth: the perimeter routing fix removed the obvious
  cases (e.g. ex 03 `db → api` / `api → worker`), this would catch a
  regression that re-introduced one.

## Examples now passing that weren't before

| Example | Was | Why |
|---|---|---|
| `02-back-edge` | E_CROSSINGS_OVER_BUDGET | sizing shrink + `crossings: 2` + perimeter routing |
| `23-highway-with-backedge` | E_UNROUTABLE | perimeter routing |
| `40-saga-choreography` | E_UNROUTABLE | perimeter routing |

## Still failing (3)

```
examples/28-highway-intersect.melk          (E_NO_CHANNEL inside intersect group)
examples/29-highway-intersect-large.melk    (same family — highway via cells colliding with sibling nodes)
examples/35-modules-platform.melk           (E_LANE_FULL between module boxes)
```

All highway-intersect / inter-module router gaps. None are sizing or
back-edge related. These are the next likely candidates to investigate.

## Test additions (`test/channels.test.ts` — now 7 tests, was 3)

1. No NaN coordinates.
2. V leg clearance from non-endpoint nodes.
3. `avoid: channels` honored.
4. **Back-edge perimeter routing** — H legs don't cut through non-
   endpoint boxes.
5. **Axial-overlap detector doesn't misfire** on plain bus/fan-out
   layouts.
6. **TB bus median producer column-aligns with hub.**
7. **TB fan-out median consumer column-aligns with hub.**

## How to start

1. Read this file.
2. `git status` → clean tree at `11b2f1e`.
3. `npx vitest run` → 401 passing, 13 skipped.
4. `for f in examples/*.melk; do svg="${f%.melk}.svg"; npx tsx src/cli.ts render "$f" -o "$svg" 2>&1 | head -1; done`
   → 40 silent, 3 fail (`28`, `29`, `35`).
5. To work on a failing example:
   `npx tsx src/cli.ts render examples/28-highway-intersect.melk -o examples/28-highway-intersect.svg`
   — error message names the channel/slot rule that fails.

## Files most relevant to the work

```
src/layout/channels.ts              — router (now ~1200 lines; perimeter routing + overlap detector)
src/layout/slots.ts                 — slot allocator + alignment post-pass
src/layout/place.ts                 — placer (anchorPerpOf, anchorBranch, flowPass shims, parking pad, grid padding)
src/render/svg.ts                   — bend-tuck gradient pass (intentional visual marker for small overlaps)
test/channels.test.ts               — 7 regression tests
```

Untracked debugging helpers (don't commit):
```
scripts/probe-sizes.ts              — audit example label-vs-box sizing
scripts/probe-autofix.ts            — auto-rewrite .melk size declarations (idempotent)
scripts/probe-oversized.ts          — flag boxes ≥4 cells past needed
scripts/probe-{02,03,05,09,11,15a,15b,modules}.ts  — per-example placement / slot probes
scripts/probe-{ex10,ex12,ex38,test}.ts             — older scratch probes
```

## Open issues carried forward

### `snapshots → s3` in ex10 gets 1-cell clearance, not 2

With the progressive 2→1→0 clearance relaxation in `pickMidCol`,
`snapshots → s3`'s V leg lands at col 24 (1 cell from `s3/pager/jaeger`
at col 26). Corridor is genuinely too narrow because `traces → prometheus`
claimed the only 2-cell-clear column first. Proper fix is in the placer
— give the strip more horizontal gap when many V channels share it. The
channel router can't fabricate columns that don't exist.

### `avoid:` is still partial

Honored:
- `avoidEdges` (list) treats those edges' cells as obstacles.
- Deferred-edge ordering routes avoiders LAST so the avoided claims
  are already populated.

Not honored:
- `avoid: <ident>` referencing a primitive/edgeset by name (works
  because the binder resolves the name to edge indices, but cascading
  avoidance — avoider A avoids edgeset X; edge in X also avoids
  something — hasn't been stress-tested).

## Gotchas to keep in mind

- **Declared size is authoritative.** Labels overflow rather than
  growing boxes. `applyTextFitToSizes` is intentionally a no-op.
  ([feedback-declared-size-authoritative](memory/feedback-declared-size-authoritative.md))
- **CELL_PX = COMB_PITCH = 8.** No factor-of-2 ratios.
- **MEMBER_GAP = 5 cells.** Uniform spacing between consecutive bus /
  fan-out / fan-in members. Now also between disconnected
  pipelines parked at `ctx.nextFreeRow`.
- **No more gutters.** The channel router walks empty cells.
- **Slot allocator preserves monotonic order.** Don't add a slot
  shift that would reorder the cluster — `preservesOrder` in
  slots.ts checks this.
- **avoidEdges = virtual obstacles, not just lane claims.** When
  adding more avoid-aware routing, follow the `effCellOwner` pattern
  in `routeChannels` rather than threading new params.
- **Back-edges get a 2-cell grid pad on all sides.** Set in
  `normalise` when `model.edges.some(e => e.isBackEdge)`. Anything
  reasoning about grid coordinates after `place()` should treat
  `cells.get(...)` as already-shifted into the padded frame.
- **Perimeter routing searches grid-edge inward.** Conscious choice
  to prefer "around the diagram" over "closest free gap". Combined
  with the back-edge grid pad above, back-edges visually wrap around
  the outermost nodes.
- **Circles and body-form icons don't grow with their label.** Label
  renders below the glyph; growing the bounding box just creates
  dead space between the visible shape and the edge endpoint.
- **Centring shims live in 4 places now.** `anchorBus`/`anchorFanOut`
  (`anchorPerpOf` with `pStepSign`), `anchorBranch`, `flowPass`
  (forward + reverse). Mirror logic if you add a new placement path.
- **Always render fresh into `examples/`, not `c:/tmp/`** — user
  views previews in the editor; tmp is invisible to them.
- **Eyeball the SVG after rendering**, don't infer from path data.
  Bezier control points lie about visual shape, and the renderer's
  bend-tuck gradient pass adds gradient strokes where polylines
  share a bend corner (it's a feature, not a bug).
