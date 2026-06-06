# melk — next session handoff

**Test count: 524 passing + 8 skipped. 43 examples. master at
`2157066` (channel design doc landed). Working tree clean.**

## What landed this session

Two commits on top of `7280aa0` from the prior session:

- `8ed65e4` — Multi-cell layout polish: text-fit no-op, MEMBER_GAP
  uniform spacing in bus/fan-out, per-column gutter-boundary rule, and
  the sizing table in SYNTAX.md / prompts/melk-author.md.
- `2157066` — DESIGN-PHASE4.md §3 rewrite. Replaces the corridors +
  track-packing + polyline model with a **channel routing** model. §4
  deleted. §7 pipeline summary updated.

The four ambiguous-placement examples (10, 37, 38, 41) now render.
Example 38 (twelve-factor web) renders with worker.1/worker.2 each
positioned correctly off queue (not perfectly symmetric — see Open
threads).

## The channel routing model (locked in DESIGN-PHASE4.md §3)

Cells are occupied by a node footprint or empty. V-channels are runs
of empty cells in a column; H-channels in a row. A trace exits a face
slot, walks the entry channel forward, turns at the nearest available
**bend cell** (intersection of V and H channel), and walks the
perpendicular channel into the target slot.

- One trace per bend cell — second-comer reroutes to next available.
- Lazy channel growth: when two traces overlap in the same channel,
  the second spills into the adjacent perpendicular cell column/row
  (if empty).
- Deterministic by edge declaration order.
- L-shape default, Z when forced; straight when same row/col.

## Implementation plan (this is the next session's main task)

1. **Lift slot allocator + side assignment + back-edge handling into
   `src/layout/slots.ts`.** These primitives stay across the rewrite.
   Source: `src/layout/corridors.ts` lines 587-594 (`assignSides`),
   525-539 (`forwardOfEdge`), 1087+ (`assignSlots`). The slot
   allocator is the biggest piece (~300 lines incl. via-half and
   highway handling). Preserve the public contract:
   `slotsFor(model, placement) → Map<edgeIndex, {sourceSide, sourceSlot, targetSide, targetSlot}>`.

2. **Build `src/layout/channels.ts`.** Public surface:
   ```ts
   export interface ChannelRouting {
     polylines: Polyline[];          // per edge
     crossings: CrossingMarker[];    // X-marks where traces cross
     width: number;                  // total pixel width
     height: number;                 // total pixel height
   }
   export function routeChannels(
     model: Model,
     placement: Placement,
     slots: Map<number, SlotAssignment>,  // from slots.ts
   ): ChannelRouting
   ```
   Internals:
   - Build occupancy grid: `Grid` of cells, each marked as occupied (by
     which node id) or empty.
   - For each edge in declaration order:
     1. Read sourceSide, sourceSlot, targetSide, targetSlot from `slots`.
     2. Compute entry cell (the empty cell immediately outside the
        slot's pixel position).
     3. Walk forward in that channel until reaching the row/col of the
        target.
     4. Turn at nearest available bend cell. If all are claimed, pick
        the next-best bend cell along an alternate channel; if that
        fails, raise `E_UNROUTABLE` or `E_BEND_DEADLOCK`.
     5. Walk perpendicular channel to target's entry cell.
     6. Mark used cells as claimed for this trace.
   - Lazy growth: when a trace's segment overlaps another's in the same
     channel along the long axis, grow the channel into the adjacent
     parallel column/row of empty cells.
   - Emit polyline: convert cell-path into pixel polyline, chamfer
     90° bends at radius `COMB_PITCH / 2` (= 4 px).

3. **Update `src/layout/pixels.ts`.** Drop `Reservation` import.
   Drop `rowGutterPx` / `colGutterPx`. `computePixelLayout(placement)`
   returns just `colX`, `rowY`, `colWidthPx`, `rowHeightPx`, plus
   totals. No more gutter widening — the grid is `cells × CELL_PX`.

4. **Wire CLI and SVG renderer.**
   ```
   // src/cli.ts
   place → applyTextFitToSizes → place (already) →
   slots = assignSlots(model, placement) →
   routing = routeChannels(model, placement, slots) →
   renderSVG(model, placement, routing, theme)
   ```
   `svg.ts` consumes `ChannelRouting` instead of `Reservation +
   Polylines`.

5. **Update `src/layout/module-place.ts` / `module-route.ts`.** The
   module orchestration calls `reserveCorridors`/`packTracks`/
   `buildPolylines` on a submodel; swap each for `routeChannels` on
   the submodel.

6. **Update `src/bind/bind.ts`.** Drop the import of
   `TRACES_PER_CELL_UNIT`. The hub-parity bump may still apply (slot
   alignment), but the formula simplifies since cells equal slots.

7. **Delete legacy files:**
   - `src/layout/corridors.ts` (1523 lines)
   - `src/layout/tracks.ts` (1141 lines)
   - `src/layout/polyline.ts` (1420 lines)
   ≈ 4084 lines gone.

8. **Tests.** Heaviest fallout:
   - `test/corridors.test.ts` (~266 lines): delete entirely. The new
     equivalent tests live in a new `test/channels.test.ts`.
   - `test/tracks.test.ts` (~90 lines): delete.
   - `test/polyline.test.ts` (~106 lines): mostly delete; some
     bend-shape assertions become channel-router assertions.
   - `test/bend-intersection.test.ts` (~24 lines): may survive in
     spirit (assertions about pixel positions of bends), but specific
     coords will change.
   - `test/place.test.ts`, `test/modules.test.ts`, `test/text-fit.test.ts`,
     `test/icons.test.ts`, `test/legend.test.ts`, `test/theme.test.ts`,
     `test/titles.test.ts`, `test/parser.test.ts` should all still
     pass — they don't touch routing internals.

9. **Render the 4 currently-working examples (10, 37, 38, 41) plus
   #43 (mesh→user) and eyeball.** The straight-line constraint on
   #43's mesh→user trace must be preserved (it's the validation of the
   multi-cell rewrite from the prior session).

## What's open from prior threads

### Worker symmetry in example 38 (not fully resolved)

Workers around queue render asymmetric: when both `fan-out workers:
queue -> [worker1, worker2]` AND `bus db-writes: [worker1, worker2] ->
db` place the same workers, the second construct can't insert a gap
that respects both queue's and db's geometric centres simultaneously.
Worked through this in detail — the right resolution is per-column
rowY arrays (each column has its own row-y positions), which is a
bigger layout-IR change than this session bit off.

This is a v2 cleanup; the visual now is OK to ship.

### 5 deferred skipped tests (carried from prior session)

```
test/tracks.test.ts          2 same-source coherence tests
test/polyline.test.ts        2 tangle tests on ex 19/29 real geometry
test/modules.test.ts         1 face-to-face spread test
```

Some of these will simply be deleted by the channel rewrite (tracks
and polyline as separate concepts are going away). The modules one
needs to be re-asserted against the new channel geometry.

## Gotchas to keep in mind

- **Declared size is authoritative.** Labels overflow rather than
  growing boxes. `applyTextFitToSizes` is intentionally a no-op.
  Don't reintroduce label-driven size growth.
  ([feedback-declared-size-authoritative](memory/feedback-declared-size-authoritative.md))
- **CELL_PX = COMB_PITCH = 8.** No factor-of-2 ratios.
  ([feedback-cell-equals-slot](memory/feedback-cell-equals-slot.md))
- **MEMBER_GAP = 1 cell.** Uniform spacing between consecutive bus /
  fan-out / fan-in members; same formula across constructs. Shared
  centres on the geometric block midpoint.
- **No more gutters.** The channel router routes through empty cells,
  not through gutters-between-rows. The corridor reserver in the
  legacy code's purpose was demand-driven gutter widening; that's no
  longer needed.
- **Slot allocator stays.** Side assignment, slot index per face,
  declaration order tiebreak — all preserved. Only the corridor
  sequence + track packing + polyline emission concept go away.

## Files most relevant to the work

Edit-targets:
```
src/layout/slots.ts                 — NEW; extract from corridors.ts
src/layout/channels.ts              — NEW; replaces corridors+tracks+polyline
src/layout/pixels.ts                — drop gutter math; cell × CELL_PX layout only
src/layout/module-place.ts          — switch to channels API
src/layout/module-route.ts          — switch to channels API
src/render/svg.ts                   — consume ChannelRouting
src/cli.ts                          — drop reserve/pack/buildPolylines steps
src/bind/bind.ts                    — drop TRACES_PER_CELL_UNIT import
```

Delete:
```
src/layout/corridors.ts             (1523 lines)
src/layout/tracks.ts                (1141 lines)
src/layout/polyline.ts              (1420 lines)
test/corridors.test.ts              (deleted)
test/tracks.test.ts                 (deleted)
test/polyline.test.ts               (mostly deleted)
```

## How to start

1. Read this file.
2. Read DESIGN-PHASE4.md §3 (the channel routing spec).
3. `git status` → clean tree at `2157066`.
4. `npx vitest run` → 524 passing, 8 skipped.
5. Begin with `src/layout/slots.ts` (lift slot allocator) — this is
   the cleanest first step because it doesn't depend on any new
   channel code.
6. Then `src/layout/channels.ts` — implement same-row routing first,
   then L-shape, then bends, then lazy growth, then back-edges.
7. Run examples after each major addition; eyeball ex 38 and ex 43
   as the two canonical visual checks.
