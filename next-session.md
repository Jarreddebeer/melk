# melk — next session handoff

**Working tree:** `master` at `5343750` plus 8 modified files (uncommitted)
and the original Phase-4 amendments. Tests: **408 passing + 13 skipped.**
43 examples, **40 rendering** (same 3 pre-existing failures: 28, 29, 35).

Untracked: `scripts/probe-*.ts` — debug-only, don't commit.

This file documents what landed THIS session on top of the
Phase-4 fix-up amends described in commit `5343750`.

## What landed this session (uncommitted)

### 1. Pixelizer holds slot pixel coord on boundary legs (`src/layout/channels.ts`)

`pixelizeCellPath` now uses `srcSlotPx.x`/`tgtSlotPx.x` for the first/last
V leg's perp coord instead of `cellCx(cell)`. Symmetric with the H-leg case
which already held `srcSlotPx.y`/`tgtSlotPx.y`. Fixes:

- **Arrow direction at destinations** (ex 18 — last leg lands square on
  the face, marker-end orients along face normal, not a horizontal stub).
- **Slot-1 S-bend kink at the box face** (ex 18 src_a — no chamfer at the
  exit when a fractional slot lands on a cell boundary).

Memory: [[feedback-slot-pixel-is-channel-coord]].

### 2. Lane clearance skips tgt at tgt-bend row/col (`isVLaneFree` / `isHLaneFree`)

At the V/H leg's tgt-bend row (= row2 / col2), tgt's footprint is excluded
from the clearance check. This lets sibling traces fan into the col adjacent
to tgt without the clearance rule forcing slot 0 inward and creating a
crossing with slot 1's V-leg (ex 27 src_a's two via traces).

Src-side clearance at the src-bend row STAYS strict — relaxing it broke
ex 23 (4 hwy→sink_X edges share rows; if any claims col srcCol+1, the next
runs out of lanes).

Memory: [[feedback-lane-clearance-skips-tgt-at-bend]].

### 3. Sibling-aware sweep direction in `pickMidCol`

`routeChannels` now carries `siblingMidCols: Map<"srcId|tgtId", number>`
of midCols already picked. When `pickMidCol` is called with a sibling
already placed, it reverses the sweep direction based on goingUp/goingDown:

- goingUp + sibling: sweep from `hi-1`, step `-1` (slot 1 lands right of slot 0).
- goingDown + sibling: sweep from `lo+1`, step `+1` (slot 1 lands left of slot 0).

That's the topology rule for "slot 1's V-leg doesn't cut through slot 0's
H-out". Fixed the `hwy → dst_x` and `hwy → dst_z` sibling crossings in
ex 27.

Memory: [[feedback-sibling-aware-midcol]].

### 4. Per-node `offset:` attribute (option 1 of the alignment work)

Per-node author nudge in cell units, quoted-string syntax to support
fractions and negatives without inventing new tokens:

```
src_b { size: 7x5, offset: "0x0.5" }   # shift down half a cell (4 px)
dst_y { size: 7x5, offset: "0x-0.5" }  # shift up half a cell
m     { size: 5x5, offset: "1x1.5" }   # +1 col, +1.5 rows
```

Implementation:
- Bind parses the quoted string into `{dCol: number, dRow: number}`.
- Placer `normalise()` splits each offset into integer parts (added to
  the cell on the grid) and fractional parts (`frac * 8` pixels, stored
  in `Placement.pixelShift: Map<id, {dx, dy}>`).
- Channels router applies `pixelShift` to the slot pixel after
  `slotPixel()` returns it.
- Renderer `nodeBoxes()` applies the shift to the rendered box position.

Used in ex 27 to make `src_b ↔ hwy ↔ dst_y` traces dead-straight.
Memory: [[feedback-per-node-offset]].

**Caveats** documented in the memory: the cellPath body is still
grid-aligned (only endpoints + box shift); designed for ≤ 1-cell
sub-pixel nudges; the author owns collision risk because the placer
doesn't re-verify after offset applies.

## Regression tests added (now 14 in `test/channels.test.ts`)

1. (existing) No NaN coordinates.
2. (existing) V leg clearance from non-endpoint nodes.
3. (existing) `avoid: channels` honored.
4. (existing) Back-edge perimeter routing.
5. (existing) Axial-overlap detector doesn't misfire on plain bus/fan-out.
6. (existing) TB bus median producer column-aligns with hub.
7. (existing) TB fan-out median consumer column-aligns with hub.
8. (existing) Via-half slot on a cell boundary doesn't get an exit chamfer.
9. (existing) hwy → dst trace lands on target face dead-vertical.
10. (NEW) Sibling via traces (src→hwy and hwy→dst) don't cross each other (ex 27).
11. (NEW) Fractional offset splits into integer cell + sub-cell pixel shift.
12. (NEW) Integer-cell offset shifts the cell on the grid.
13. (NEW) Rejects unquoted offset and malformed strings.
14. (NEW) Ex 27 half-cell offset eliminates the slot-misalignment wiggle.

All 408 tests pass. The new ones assert at the polyline level
(segment-segment intersection or per-waypoint y-coord), not at SVG path
strings — robust to chamfer rendering changes.

## Option 2 — auto-aligning centring shim ✅ Shipped

`src/layout/via-shim.ts:autoAlignViaShims` runs after `assignSlots` and
before `routeChannels`. For each highway-via member it:

1. Walks every via-half edge touching that member.
2. Computes Δ = (hwy slot pixel) − (member slot pixel) on the highway's
   perp axis (y for LR, x for TB).
3. Takes the median Δ across those edges.
4. Sub-cell residual: `shim = medianΔ − trunc(medianΔ / 8) * 8`. This is
   the sign-preserving "round toward zero" version — `Math.round`
   half-up would give the WRONG direction at Δ = ±4, because both ±4
   are mod-8 valid but only one shifts the member toward the matching
   hwy slot (the other lands on the adjacent slot, leaving the trace
   bent).
5. If `|shim| ≥ 0.5`, stamps `placement.pixelShift.set(id, {dx, dy})`
   with the residual on the perp axis. A manual `offset:` already in
   `pixelShift` wins — we don't clobber it.

Wired into:
- `src/cli.ts` — both `render` and `validate` paths.
- `src/layout/module-place.ts` — sub-model placement inside imported
  modules.
- `test/channels.test.ts` `route()` helper — so test-time pipelines see
  the same shape as production.

Manual `offset:` on src_b and dst_y was removed from
`examples/27-highway-underground.melk`; the auto pass now produces the
same alignment, plus shims `src_a` and `src_c` (which only had L-bend
chamfer artifacts that the manual offset never bothered with).

### Highway-via examples that pick up shims

```
16-highway-bundle, 17-highway-inlet, 18-highway-tb (TB layout → dx),
19-highway-with-pipeline, 20-two-highways, 21-highway-mixed,
22-highway-with-bypass, 23-highway-with-backedge, 24-mixed-bundle-bypass,
25-exit-override, 27-highway-underground, 43-netflix-microservices
```

All 411 tests pass (was 408 + 3 new for the auto shim). 40 examples
render silently, same 3 fail (28, 29, 35 — pre-existing, unrelated).

## Other previously-known still-failing examples

```
examples/28-highway-intersect.melk          (E_NO_CHANNEL inside intersect group)
examples/29-highway-intersect-large.melk    (same family — highway via cells colliding with sibling nodes)
examples/35-modules-platform.melk           (E_LANE_FULL between module boxes)
```

Pre-existing, none related to this session's work.

## How to start

1. Read this file.
2. `git status` → 9 modified files + 1 new (`src/layout/via-shim.ts`).
3. `npx vitest run` → 411 passing, 13 skipped.
4. `for f in examples/*.melk; do svg="${f%.melk}.svg"; npx tsx src/cli.ts render "$f" -o "$svg" 2>&1 | head -1; done`
   → 40 silent, 3 fail (28, 29, 35).
5. Inspect `examples/27-highway-underground.svg` — `src_b ↔ hwy ↔ dst_y`
   traces are now dead straight courtesy of the auto shim. No manual
   `offset:` directives in the .melk source.

## Files most relevant to this session's work

```
src/layout/via-shim.ts              — NEW: autoAlignViaShims (Option 2)
src/layout/channels.ts              — pickMidCol sibling-aware, isVLaneFree tgt-bend exception, pixelizeCellPath slot-px coord, slotPixel callsite + pixelShift
src/layout/place.ts                 — normalise() splits offset into cell + pixelShift, threads through both Placement returns
src/layout/placement.ts             — Placement type now includes pixelShift: Map<id, {dx,dy}>
src/layout/module-place.ts          — wires autoAlignViaShims into the sub-model pipeline
src/bind/model.ts                   — ModelNode.offset?: {dCol, dRow}
src/bind/bind.ts                    — offset case parses quoted "WxH" string
src/render/svg.ts                   — nodeBoxes() adds pixelShift to box (x, y)
src/cli.ts                          — calls autoAlignViaShims in render + validate
src/index.ts                        — exports autoAlignViaShims
test/channels.test.ts               — 17 regression tests (3 new for Option 2)
examples/27-highway-underground.melk — manual offset: directives removed
```

## Decisions worth NOT relitigating

- **Slot-clearance asymmetry** (tgt relaxed at tgt-bend, src stays strict
  at src-bend). The symmetric version breaks ex 23. The sibling-aware
  sweep is what handles the dst side. Keep this asymmetric.
- **Offset uses quoted string** not bare cells syntax. Quoted lets us
  accept fractions and negatives without inventing new lexer tokens.
  `"WxH"` is the only accepted form.
- **Offset's fractional part is a render-time pixel shift, not a
  fractional cell on the grid.** The grid stays integer; `colX[col]` /
  `rowY[row]` lookups don't break. Only endpoints + rendered box pick up
  the shift.

## Gotchas to keep in mind

- **Don't symmetric-relax src clearance.** Tried it; ex 23 hits
  E_LANE_FULL because every edge greedily grabs the col adjacent to
  hwy and exhausts the corridor.
- **Don't change `offset:` to accept bare cells.** The quoted form is
  the only way to express `0x-0.5` without lexer surgery.
- **`pixelShift` is empty when no node has a fractional offset.** Don't
  add code that assumes a shift exists — check `.get(id)` and treat
  undefined as `{dx: 0, dy: 0}`.
- **Author owns collision risk on offsets.** The placer doesn't re-check
  footprints after applying. If two nodes get overlapping cells from
  offsets, the channel router will produce gibberish.
- **Slot pixels in `routeChannels` are post-shift.** If you add another
  consumer of slot pixels somewhere, look at the pattern at
  `channels.ts:188-198` — the raw `slotPixel()` return is wrapped with
  `placement.pixelShift.get(id)` before use.
- **Auto shim uses `Math.trunc` for whole-cell rounding, NOT
  `Math.round`.** Both are mod-8 valid, but `Math.round(0.5) = 1` flips
  the residual sign and shifts the member to the ADJACENT hwy slot —
  the trace stays bent instead of going straight. `Math.trunc(0.5) = 0`
  keeps the residual sign aligned with `medianΔ`, so the shim shifts
  the member toward the matching slot.
- **Manual `offset:` wins over auto shim.** `autoAlignViaShims` skips
  any node already in `placement.pixelShift`. Don't change this — the
  author needs the override to handle cases where the median heuristic
  picks wrong.
- **Always render fresh into `examples/`, not `c:/tmp/`** — user views
  previews in the editor; tmp is invisible to them.
