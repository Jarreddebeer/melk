# melk — next session handoff

**Branch `review-fixes` (post code-review, 2026-06-11).** A large
review-driven pass landed: docs corrected, diagnostics unified, a public
`compileToSVG` API, silent-output guards, a `Claims` routing refactor,
and a much bigger test suite. See [REVIEW-FINDINGS.md](REVIEW-FINDINGS.md)
"Resolution status" for the full list.

**Tests:** 500 passing + 6 skipped (was 411 + 13). **Examples: 42/43
rendering**, all goldens byte-identical after the refactors. Only ex 29
fails — the 5×5 PCB-mesh routing limit (below).

## The ex-29 stair feature — refined guidance after a failed attempt

The 4-bend stair was attempted in the review pass and **reverted**. Two
concrete lessons for the next attempt:

1. **The swap-detection gate must be tight.** A detector that fires
   whenever a V→V via-half edge's H-leg overlaps an existing claim is too
   broad — it caught ex-27's legitimate half-cell-offset trace and broke
   its test. Gate strictly on the dense-intersect case (an `intersect`
   group with ≥2 sources AND ≥2 sinks on the highway), not on H-leg
   overlap alone.
2. **The mid-row search must be bounded.** An outward row scan with
   per-row corridor checks went O(rows²) and OOM'd on the 4×4 reduction.
   Pre-compute the free rows once, or cap the search window.

The `Claims` struct (now in channels.ts) means the new stair helper takes
one `claims` arg, not four maps. A positive `E_AXIAL_OVERLAP` test
(`test/channels.test.ts` "a dense 3x3 highway intersect DOES raise…")
pins the current failure — flip it to assert a clean route when the stair
lands. The mirror problem also surfaces on the underground `hwy_v` exit
side, so the fix must work for both axes.

---

## (Historical) Version 0.1.3 handoff

**Version:** 0.1.3. Working tree may be dirty (CLI default-output,
U-routing for `entry:`/`exit:`, stair-fix for highway fan-outs, fan-out
perp computed under correct forward).

**Tests:** 411 passing + 13 skipped. **Examples: 42/43 rendering**.
Only ex 29 fails — the original 5×5 PCB-mesh routing limit.

## What landed in 0.1.3

### CLI
- `melk render <file>` now defaults `-o` to `<file-without-.melk>.svg`
  next to input. No more stdout fallback.
- Safety check: if `-o` resolves to the input path, melk appends
  `.svg` and warns rather than overwriting source.

### Routing
- **Stair-fix for highway fan-outs** ([src/layout/channels.ts](src/layout/channels.ts), [src/layout/place.ts](src/layout/place.ts)):
  multi-trace V→V Z paths leaving a highway now ratchet monotonically
  past the prior extremum, keyed by `srcId|direction` for via-half
  edges. Non-intersect highways widen `viaGap` to `max(PIPELINE_GAP,
  fanOutEdges + 2)` so the stair has one bend col per lane plus the
  two face exclusions.
- **U-routing for `entry:` / `exit:` overrides**
  ([src/layout/channels.ts](src/layout/channels.ts)): when the
  forced face is on the "wrong side" of the source, the router
  builds a perimeter U-shape (H-V-H-V for V→H, V-H-V-H for H→V,
  V-H-V for H→H same-side). Trace exits perpendicular to source
  face, wraps around target's outer edge, enters perpendicular to
  target face. The placer reserves a 2-cell perimeter pad
  whenever any edge sets `exit:` or `entry:`.
- **Fan-out perp bug fix** ([src/layout/place.ts](src/layout/place.ts)):
  `anchorFanOut` and `anchorBus` were computing consumer extents
  using `ctx.forward.get(consumer)` which defaulted to the layout
  default (E for lr) before the consumer was anchored — wrong perp
  when the fan-out direction is rotated by a branch (e.g. branch
  `:right` under lr → S). Added `extentForAs(id, ctx, fwd)` that
  computes extent under a specified forward. Affected ex 41 (CQRS
  read-models collided at the same row).

### Docs
- README, SYNTAX, EXAMPLES, prompts/melk-author.md updated for the
  new CLI default and `entry:`/`exit:` U-routing.

## The remaining failure: ex 29

29 is the canonical 5×5 PCB-mesh test: 5 sources × 5 sinks on each of
hwy_h and hwy_v, all-to-all = 25 surface traces + 25 underground = 50
traces through a single intersection.

The placer gets the geometry exactly right (tight-stack sources/sinks
aligned with highway face slots, viaGap=26 cells of corridor on each
side). The **channel router fails** with `E_AXIAL_OVERLAP` on crossing
L-bend traces between hwy_h.E and dst_h cluster.

### Why it fails (the geometric proof)

The "intra-highway must be straight" constraint means the mirror rule
(hwy.W slot row = hwy.E slot row) is non-negotiable. Combined with the
slot allocator's natural sort (by destination perp), this gives:

- src_h1's 5 traces enter at W@0..4 (rows 31..35) and exit at E@0..4 (same rows)
- src_h2's 5 traces enter at W@5..9 (rows 36..40) and exit at E@5..9 (same rows)
- ...

Then on the exit side, dst_h1 receives traces from E@0 (row 31), E@5 (row 36),
E@10 (row 41), E@15 (row 46), E@20 (row 51) — entering dst_h1.W@0..4
(rows 31..35).

That means:
- src_h1→dst_h2: V→V Z path from row 32 (E@1) to row 36 (dst_h2.W@0)
- src_h2→dst_h1: V→V Z path from row 36 (E@5) to row 32 (dst_h1.W@1)

These two traces **swap rows**. Each is a 2-bend Z, so each has H segments at
BOTH row 32 and row 36. No matter how you place their V-leg mid-cols, at one
of the two shared rows their H ranges will overlap. This is geometrically
unavoidable with 2-bend Z paths.

### The fix: 4-bend stair routing for crossing V→V Z traces

When two via-traces would swap rows, at least one needs a **4-bend stair**
route through an intermediate row that's not used by other traces:

```
srcExit → (srcRow, X1) → (midRow, X1) → (midRow, X2) → (tgtRow, X2) → tgtExit
```

The intermediate `midRow` must be **outside the highway's footprint** (so the
stair doesn't run through hwy_h's body) and **outside dst_h's row band** (so
it doesn't hit dst_h's footprint). For 5×5 that means a row above or below
the intersection — i.e. the placer needs to reserve extra rows IN ADDITION to
the viaGap columns.

## How to resume

1. `git status` → confirm clean.
2. `npx vitest run` → 411 pass + 13 skipped.
3. `npx tsx src/cli.ts render examples/29-highway-intersect-large.melk`
   → `E_AXIAL_OVERLAP: edges 'hwy_h -> dst_h2' and 'hwy_h -> dst_h1' share a 152-px horizontal segment at y=260`.
4. **Implement 4-bend stair routing in channels.ts** for V→V Z paths whose
   `srcRow` and `tgtRow` rows are both already claimed by other edges'
   L-bends. The midRow needs to be OUTSIDE the highway's row range and
   OUTSIDE the dst row band — so the placer must also reserve extra rows
   above/below the hwy_h cluster.

## Decisions worth NOT relitigating

- **Highway intra-traces MUST be straight** (mirror rule stays). The user
  explicitly stated this constraint. Don't try to skip the mirror or add
  diagonals inside the highway.
- **viaGap = N+1** for intersect highways is correct. Don't apply
  it to non-intersect highways at that magnitude — they use
  `max(PIPELINE_GAP, fanOutEdges + 2)` now.
- **claimLegCells must claim ALL cells**, not just endpoints.
- **Single-source/target centring shim only fires when nSrc=1 or nTgt=1**.
- **Tight-stack with first-elem anchor only for dense intersect**
  (`m.sources.length >= 2 && m.targets.length >= 2`).
- **28's structure is final** (1×3 hwy_h + 1×2 hwy_v, src_a 7x5).
- **U-routing falls back to L if no perim row/col is free.** The placer
  pad is 2 cells; that's enough for the common case but not arbitrarily
  many overlapping U-routes.

## Gotchas

- The `denseIntersectHwys` test in slots.ts is gone. The mirror is
  ON for all via-half edges. Don't re-add the mirror skip.
- When you re-render 29 you'll see `E_AXIAL_OVERLAP` (either between
  hwy_h→dst_h pair or hwy_v→dst_v pair). Both are the same root cause:
  crossing 2-bend Z paths.
- The placement for 5×5 (tight stack + first-element anchor) is the right
  geometry. Don't revert the place.ts changes for intersect — they're the
  reason entry-side traces are straight. The remaining problem is purely
  in the channel router (exit-side L-bend crossing).
