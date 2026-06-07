# melk — next session handoff

**Working tree:** clean at `9d8b92f` ("Per-node offset: + auto via-shim +
channel-routing polish; docs"). Tests: **411 passing + 13 skipped.**
43 examples, **40 rendering** (same 3 pre-existing failures: 28, 29, 35).

Untracked: `scripts/probe-*.ts` — debug-only, don't commit.

## What landed in 9d8b92f

Read the commit body for the full picture (`git show 9d8b92f`). One-line summary:

- **Per-node `offset:` attribute** (Option 1) — quoted-string `"WxH"`,
  integer part shifts grid cells, fractional part becomes a sub-cell
  pixel shift via `Placement.pixelShift`. Author override for slot-cluster
  alignment.
- **Auto via-shim** (Option 2) — `src/layout/via-shim.ts:autoAlignViaShims`
  runs after `assignSlots` and before `routeChannels`, picks each highway
  via member's sub-cell pixel shift from the median Δ between hwy and
  member slot pixels. Manual `offset:` wins. Uses `Math.trunc` for
  whole-cell rounding (sign-preserving — `Math.round` would flip direction
  at Δ = ±4).
- **Channel routing polish** — pixelizer slot-coord fix, lane-clearance
  tgt-bend exception, sibling-aware `pickMidCol` sweep.
- **Docs** — README.md, SYNTAX.md (new §3.10 `offset:`, auto-shim callout
  in placement model), EXAMPLES.md (offset recipe + ex 27 description).

## Still-failing examples (pre-existing, unrelated)

```
examples/28-highway-intersect.melk          (E_NO_CHANNEL inside intersect group)
examples/29-highway-intersect-large.melk    (same family — highway via cells colliding with sibling nodes)
examples/35-modules-platform.melk           (E_LANE_FULL between module boxes)
```

## How to start

1. Read this file.
2. `git status` → clean except untracked probe scripts.
3. `npx vitest run` → 411 passing, 13 skipped.
4. `for f in examples/*.melk; do svg="${f%.melk}.svg"; npx tsx src/cli.ts render "$f" -o "$svg" 2>&1 | head -1; done`
   → 40 silent, 3 fail (28, 29, 35).
5. Pick a topic. No in-flight work.

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
- **Manual `offset:` wins over auto shim.** `autoAlignViaShims` skips
  any node already in `placement.pixelShift`. Don't change this — the
  author needs the override to handle cases where the median heuristic
  picks wrong.
- **Auto shim uses `Math.trunc` for whole-cell rounding, NOT
  `Math.round`.** Both are mod-8 valid, but `Math.round(0.5) = 1` flips
  the residual sign and shifts the member to the ADJACENT hwy slot —
  the trace stays bent instead of going straight. `Math.trunc(0.5) = 0`
  keeps the residual sign aligned with `medianΔ`, so the shim shifts
  the member toward the matching slot.

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
  consumer of slot pixels somewhere, look at the pattern in
  `channels.ts` where `slotPixel()`'s return is wrapped with
  `placement.pixelShift.get(id)` before use.
- **Always render fresh into `examples/`, not `c:/tmp/`** — user views
  previews in the editor; tmp is invisible to them.
