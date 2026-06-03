/**
 * Phase 4 track packing (Step 6).
 *
 * Inputs: a bound `Model`, the `Placement` from Step 4, and the
 * `Reservation` from Step 5 (per-edge corridor sequence, source/target
 * side+slot, demand counts, gutter widths).
 *
 * Output: a `Packing` carrying — per (trace, corridor) pair — the
 * trace's track index within that corridor; and per corridor, a list
 * of `Crossing`s where two traces have non-monotone endpoint orderings
 * and have to materialise an X-junction.
 *
 * Algorithm at a glance (see DESIGN-PHASE4.md §4):
 *
 *   1. For each corridor, gather the routes that include it.
 *   2. For each trace × corridor, compute entry and exit long-axis
 *      coords. Same-corridor source/target slots map directly to
 *      long-axis positions; transitions to/from adjacent corridors
 *      map to the col / row boundary that hosts the intersection.
 *   3. Sort traces in each corridor by entry long-axis coord
 *      (tiebreak: edgeIndex). Assign track = position in sort.
 *   4. Count inversions in the exit-long-axis-coord sequence. Each
 *      inversion = one X-junction at the corridor midpoint.
 *
 *   5. Tally total crossings. If > `model.crossingsBudget`, raise
 *      `E_CROSSINGS_OVER_BUDGET`.
 *
 * Track indices are ORDINAL (1, 2, 3, ...). Step 7/8 multiplies by
 * COMB_PITCH at pixel emission time. This keeps Step 6 pixel-free.
 *
 * The (entry, exit) long-axis coord pairs use a lexicographic key
 * `(boundaryIndex, slotIndex)` so that we can compare and sort without
 * leaking pixel pitch into Step 6. `boundaryIndex` is the grid index
 * of the col / row boundary where the trace enters/exits; `slotIndex`
 * is the slot on a box face when the entry/exit is on a box face (it
 * fine-tunes ordering when two traces share the same boundary).
 */
import type { Model } from "../bind/model.js";
import type { Placement } from "./placement.js";
import type { Corridor, Reservation, Route, Side } from "./corridors.js";
import { corridorKey } from "./corridors.js";
import { computePixelLayout, slotPixel, vCorridorWestEdgeX, hCorridorNorthEdgeY } from "./pixels.js";
import type { PixelLayout } from "./pixels.js";

// --- public types ---------------------------------------------------------

/**
 * Long-axis position within a corridor, expressed as
 *   (boundaryIndex, slotIndex)
 * so it can be compared lexicographically without any pixel math.
 *
 *   boundaryIndex — the grid-coord of the col or row the entry/exit
 *                   sits on. For an H corridor, this is a col index;
 *                   for V, a row index.
 *   slotIndex     — fine-tune. 0 when the entry/exit is at an intra-
 *                   cell coord (e.g., a slot on a box face).
 *                   Defaults to a sentinel that sorts "interior" of
 *                   the boundary's cell range when set.
 */
export interface LongAxisCoord {
  boundaryIndex: number;
  slotIndex: number;
}

export interface TrackAssignment {
  /** Index into `Model.edges`. */
  edgeIndex: number;
  /** Corridor identity (see corridorKey). */
  corridor: string;
  /**
   * Track ordinal within the corridor: 1, 2, 3, ...
   * Step 7 multiplies by COMB_PITCH and adds the gutter offset.
   */
  track: number;
  /** Entry and exit long-axis coords (abstract, for polyline.ts). */
  entryLongAxis: LongAxisCoord;
  exitLongAxis: LongAxisCoord;
  /**
   * Pixel position of entry / exit on the corridor's long axis (y for V,
   * x for H). Used by the same-source coherence pass to compute the
   * physical bend direction — needed when source and target are in the
   * same cell row but their slot positions sit at different pixel y's.
   */
  entryPx: number;
  exitPx: number;
}

/**
 * One crossing point. Materialised at the corridor's long-axis
 * midpoint, perp midpoint between the two traces' tracks.
 *
 * `edgeIndexA` / `edgeIndexB` are sorted (A < B by declaration index)
 * so two passes that emit the same crossing produce identical
 * records.
 */
export interface Crossing {
  corridor: string;
  edgeIndexA: number;
  edgeIndexB: number;
}

export interface Packing {
  /** All track assignments, in (corridor, declaration order) order. */
  tracks: TrackAssignment[];
  /** All crossings, in (corridor, edgeIndexA, edgeIndexB) order. */
  crossings: Crossing[];
}

export class PackingError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// --- entry point ----------------------------------------------------------

/**
 * Pure function from (`Model`, `Placement`, `Reservation`) to `Packing`.
 * Deterministic: same inputs → same output, byte-for-byte.
 */
export function packTracks(
  model: Model,
  placement: Placement,
  reservation: Reservation,
): Packing {
  // For each corridor, find every route that traverses it (in
  // declaration order, since reservation.routes is already in
  // declaration order).
  const byCorridor = new Map<string, Route[]>();
  for (const r of reservation.routes) {
    for (const c of r.corridorSequence) {
      const k = corridorKey(c);
      if (!byCorridor.has(k)) byCorridor.set(k, []);
      byCorridor.get(k)!.push(r);
    }
  }

  const tracks: TrackAssignment[] = [];
  const crossings: Crossing[] = [];

  // Pixel-aware interval encoding: compute the pixel layout once and
  // pass it through so the conflict check operates on actual y/x pixel
  // ranges, not the abstract (boundaryIndex, slotIndex) coords that
  // mis-conflate same-cell-row endpoints on differently-sized boxes.
  const layout = computePixelLayout(placement, reservation);

  // Iterate corridor keys in deterministic order: sort lexicographically.
  const corridorKeys = [...byCorridor.keys()].sort();
  for (const k of corridorKeys) {
    const corridorRoutes = byCorridor.get(k)!;
    const corridor = decodeCorridor(k);
    const perCorridor = assignTracksInCorridor(
      corridor,
      k,
      corridorRoutes,
      model,
      placement,
      reservation,
      layout,
    );
    tracks.push(...perCorridor.tracks);
    crossings.push(...perCorridor.crossings);
  }

  // Sanity check: total crossings against budget.
  if (crossings.length > model.crossingsBudget) {
    // Find the corridor with the most crossings to make the error
    // message actionable.
    const byCorridorCount = new Map<string, number>();
    for (const x of crossings) {
      byCorridorCount.set(
        x.corridor,
        (byCorridorCount.get(x.corridor) ?? 0) + 1,
      );
    }
    let worstCorridor = "";
    let worstCount = 0;
    for (const [c, n] of byCorridorCount) {
      if (n > worstCount) {
        worstCount = n;
        worstCorridor = c;
      }
    }
    throw new PackingError(
      `E_CROSSINGS_OVER_BUDGET: routing requires ${crossings.length} ` +
        `crossings but budget is ${model.crossingsBudget}. ` +
        `Worst offender: corridor ${worstCorridor} with ${worstCount} crossings. ` +
        `Restructure topology to reduce crossings, or raise the budget with a ` +
        `top-level 'crossings: N' directive.`,
    );
  }

  return { tracks, crossings };
}

// --- corridor key parsing -------------------------------------------------

function decodeCorridor(key: string): Corridor {
  if (key.startsWith("H")) {
    return { kind: "H", index: Number(key.slice(1)) };
  }
  if (key.startsWith("V")) {
    return { kind: "V", index: Number(key.slice(1)) };
  }
  // D{row},{col},{dir} — not used at Step 6 but the decoder is symmetric.
  const body = key.slice(1);
  const parts = body.split(",");
  return {
    kind: "D",
    row: Number(parts[0]),
    col: Number(parts[1]),
    dir: parts[2] as "NE" | "SE" | "SW" | "NW",
  };
}

// --- per-corridor track assignment ----------------------------------------

interface CorridorWork {
  tracks: TrackAssignment[];
  crossings: Crossing[];
}

function assignTracksInCorridor(
  corridor: Corridor,
  corridorKeyStr: string,
  routes: Route[],
  model: Model,
  placement: Placement,
  _reservation: Reservation,
  layout: PixelLayout,
): CorridorWork {
  // Compute (entry, exit) coords for each route's sojourn in this
  // corridor — BOTH in pixel space (used by the interval-reuse conflict
  // check + sort comparators) AND in the legacy (boundaryIndex,
  // slotIndex) form (used by `TrackAssignment.entryLongAxis`/`exitLong-
  // Axis` for downstream polyline emission).
  //
  // The pixel form is the source of truth for conflict semantics: two
  // traces conflict iff their physical y-ranges (V corridor) or
  // x-ranges (H corridor) overlap. The boundary/slot form is kept on
  // `TrackAssignment` for compatibility with polyline.ts which already
  // converts it back to pixels via `boundaryToPixelY/X` (effectively
  // round-tripping; in a future cleanup polyline.ts could read the
  // pixel form directly).
  type Item = {
    route: Route;
    entry: LongAxisCoord;
    exit: LongAxisCoord;
    entryPx: number;
    exitPx: number;
  };
  const items: Item[] = [];
  for (const r of routes) {
    const idxInSeq = r.corridorSequence.findIndex(
      (c) => corridorKey(c) === corridorKeyStr,
    );
    if (idxInSeq < 0) {
      throw new PackingError(
        `internal: corridor ${corridorKeyStr} not found in route's sequence`,
      );
    }
    const entry = entryLongAxis(corridor, r, idxInSeq, model, placement);
    const exit = exitLongAxis(corridor, r, idxInSeq, model, placement);
    const entryPx = entryPixel(corridor, r, idxInSeq, model, placement, layout);
    const exitPx = exitPixel(corridor, r, idxInSeq, model, placement, layout);
    items.push({ route: r, entry, exit, entryPx, exitPx });
  }

  // Sort traces into a track ordering that minimises visual crossings.
  //
  // The rule (DESIGN-PHASE4.md §4.1 update): within a corridor, group
  // traces by direction along the long axis (forward vs backward),
  // and within each group, place the trace with the **longest reach**
  // closest to the "exit side" (= highest track index within the
  // group). This keeps a long-reaching trace's perpendicular run short
  // on the exit side, so it doesn't cross shorter siblings' exits.
  //
  // Trace direction = sign of (exit_long - entry_long).
  // Trace reach     = abs(exit_long - entry_long).
  //
  // For straight traces (entry == exit): direction is "neither"; they
  // share tracks with forward-direction traces (they're treated as
  // length-zero forwards). Their relative order ties to declaration.
  //
  // The two directional groups are interleaved into the overall track
  // numbering: forward (positive-going) tracks fill from the bottom
  // of the assignment range, backward (negative-going) tracks fill
  // from the top. Within each group, longest reach goes to the highest
  // track within the group.
  //
  // For corridors with traces of only one direction, the rule reduces
  // to "longest reach at highest track" (= rightmost x for V, southmost
  // y for H).
  // Direction, sort key, and interval are all computed in PIXEL space
  // (entryPx/exitPx). Two intervals conflict iff their pixel y/x ranges
  // overlap with strict-open semantics — boundary-touching intervals
  // still share a track. This pixel-aware check fixes the cell-row
  // mis-conflation bug where same-row source/target boxes of different
  // heights were treated as occupying the same long-axis range even
  // though their slot positions sit at different pixel y's.
  const forwards: typeof items = [];
  const backwards: typeof items = [];
  for (const it of items) {
    const delta = it.exitPx - it.entryPx;
    if (delta >= 0) forwards.push(it);
    else backwards.push(it);
  }
  forwards.sort((a, b) => {
    if (a.exitPx !== b.exitPx) return b.exitPx - a.exitPx;
    return a.route.edgeIndex - b.route.edgeIndex;
  });
  backwards.sort((a, b) => {
    if (a.exitPx !== b.exitPx) return a.exitPx - b.exitPx;
    return a.route.edgeIndex - b.route.edgeIndex;
  });
  const allOrdered = [...forwards, ...backwards];
  const trackIntervals: { lo: number; hi: number }[][] = [];
  const tracks: TrackAssignment[] = [];
  for (const it of allOrdered) {
    const lo = Math.min(it.entryPx, it.exitPx);
    const hi = Math.max(it.entryPx, it.exitPx);
    let placed = -1;
    for (let t = 0; t < trackIntervals.length; t++) {
      const intervals = trackIntervals[t]!;
      const conflict = intervals.some((iv) => !(hi <= iv.lo || lo >= iv.hi));
      if (!conflict) {
        intervals.push({ lo, hi });
        placed = t;
        break;
      }
    }
    if (placed === -1) {
      trackIntervals.push([{ lo, hi }]);
      placed = trackIntervals.length - 1;
    }
    tracks.push({
      edgeIndex: it.route.edgeIndex,
      corridor: corridorKeyStr,
      track: placed + 1,
      entryLongAxis: it.entry,
      exitLongAxis: it.exit,
      entryPx: it.entryPx,
      exitPx: it.exitPx,
    });
  }

  // Same-source coherence pass.
  //
  // The interval-reuse loop above assigns tracks correctly for most
  // cases, but it doesn't know about same-source sibling relationships:
  // two traces leaving the same source cell into the same corridor form
  // a comb tooth, and the visual quality of that comb depends on whether
  // the trace with the longer perpendicular leg sits on the OUTER track
  // (further from the source) so its long V-leg doesn't run through
  // sibling traces' H stubs.
  //
  // The interval-reuse can put a short sibling on an INNER track that
  // reuses an unrelated trace's interval, inverting the sibling order.
  // Concretely: example 20's svc_a outputs both bend south to egress.
  // svc_b's V-corridor interval ends exactly where svc_a-top's interval
  // begins, so svc_a-top reuses svc_b's inner track, leaving svc_a-bottom
  // on an outer track. svc_a-top's long V-leg then crosses svc_a-bottom's
  // H stub — the "bent ribbon" inversion.
  //
  // Fix: for each same-source-cell group with ≥2 traces in this corridor,
  // permute their track ordinals so the trace whose source slot is
  // FURTHEST from the corridor's exit-perp lands on the OUTER track. The
  // exit-perp direction is determined by the typical exit's longOf
  // relative to the source's longOf: if traces exit at a longOf greater
  // than the source slot, the bend is "positive direction" (south for V,
  // east for H) and the trace with the SMALLEST source slot is furthest
  // from the bend → outer track. Otherwise reversed.
  //
  // This is a permutation within the existing track set, so it does NOT
  // change the total track count or the demand budget. It only swaps
  // which sibling occupies which already-allocated track.
  applySameSourceCoherence(tracks, model, placement, _reservation, corridorKeyStr);

  // Cross-bundle stub-avoidance pass.
  //
  // After same-source coherence, two same-source-cell BUNDLES with
  // overlapping pixel intervals can still sit on track-ordinal ranges
  // that maximise their mutual stub crossings. The classic instance is
  // example 29 in V1: backward bundle src_h3 -> hwy_h (entry NEAR-WEST,
  // exit NEAR-EAST) sits on outer tracks {4,5,6}, while forward axial
  // bundle hwy_v -> dst_v3 (top -> bottom) sits on inner {1,2,3}. The
  // src_h3 entry stubs at y=424/432/440 cross the axial V-descents at
  // x=40/48/56 — nine crossings.
  //
  // Swapping the two ranges (src_h3 to {1,2,3}, axial to {4,5,6}) puts
  // src_h3's short entry stubs at small x where no axial trace exists,
  // and its exit stubs at y=288/296/304 are above the axial y-range, so
  // they don't gain new crossings. Net: -9.
  //
  // The pass detects exactly this pattern: two bundles whose pixel
  // intervals overlap, where bundle A has all "side-aligned" endpoints
  // (NEAR-WEST/NEAR-EAST for V, NEAR-NORTH/NEAR-SOUTH for H) and bundle
  // B has all axial endpoints. If A's side preference (the side it
  // enters from) is opposite to its current ordinal placement, swap
  // their ordinal ranges.
  applyCrossBundleStubAvoidance(
    tracks,
    model,
    placement,
    _reservation,
    corridor,
    corridorKeyStr,
  );

  // For crossing detection, sort independently by entry long-axis.
  // The inversion check measures non-monotone endpoint orderings,
  // which is a topological property of the (entry, exit) pairs — it
  // doesn't depend on the track assignment order.
  items.sort((a, b) => {
    if (a.entryPx !== b.entryPx) return a.entryPx - b.entryPx;
    return a.route.edgeIndex - b.route.edgeIndex;
  });

  // Crossings: count inversions in the exit-sequence after entry-sort,
  // but ONLY for trace pairs going the same direction along the
  // corridor's long axis. Forward + backward traces live on disjoint
  // track ranges (see direction-aware ordering above), so they never
  // visually cross. Forward+forward or backward+backward pairs with
  // non-monotone entry/exit are the genuine X-junctions. Comparisons
  // are pixel-aware.
  const crossings: Crossing[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const aDir = a.exitPx >= a.entryPx ? "fwd" : "bwd";
      const bDir = b.exitPx >= b.entryPx ? "fwd" : "bwd";
      if (aDir !== bDir) continue; // disjoint track ranges, no crossing.
      if (a.exitPx > b.exitPx) {
        const ea = a.route.edgeIndex;
        const eb = b.route.edgeIndex;
        crossings.push({
          corridor: corridorKeyStr,
          edgeIndexA: Math.min(ea, eb),
          edgeIndexB: Math.max(ea, eb),
        });
      }
    }
  }
  // Stable order: edgeIndexA, then edgeIndexB.
  crossings.sort((a, b) => {
    if (a.edgeIndexA !== b.edgeIndexA) return a.edgeIndexA - b.edgeIndexA;
    return a.edgeIndexB - b.edgeIndexB;
  });

  return { tracks, crossings };
}

/**
 * Same-source coherence: within a single corridor, two traces leaving
 * the same source cell should sit on adjacent tracks in the order that
 * keeps the longer perpendicular leg on the OUTER track. This prevents
 * the "bent ribbon" inversion where interval-reuse hands a short trace
 * an inner track that its longer sibling should have occupied.
 *
 * The function operates as a pure permutation of already-assigned
 * track ordinals: for each same-source group, it collects the tracks
 * those siblings occupy, sorts the siblings by the desired outer-to-
 * inner order, and rewrites their `track` fields back onto the same
 * set of ordinals.
 *
 * "Outer track" = larger ordinal in the assigned set (corridors pack
 * track 1 = innermost, ascending outward).
 *
 * The desired order is direction-aware:
 *   - For traces whose exit-perp is GREATER than entry-perp (positive
 *     bend along the corridor's long axis), the sibling with the
 *     SMALLEST source slot is furthest from the bend destination, so
 *     it gets the OUTER track.
 *   - For traces whose exit-perp is LESS than entry-perp (negative
 *     bend), the sibling with the LARGEST source slot is furthest from
 *     the destination, so IT gets the outer track.
 *
 * Mixed-direction sibling groups (one going up, one down) are left
 * alone — they don't share a comb-tooth shape.
 */
function applySameSourceCoherence(
  tracks: TrackAssignment[],
  model: Model,
  placement: Placement,
  reservation: Reservation,
  corridorKeyStr: string,
): void {
  // Group by source NODE id (not just source cell). Two nodes can share
  // the same cell when one is `render: underground` (Z-stacked highways
  // from `intersect a, b`) — grouping by cell alone lumps them together,
  // mixing routes with different corridor-position parities and
  // disabling the staircase flip rule for both. Node-id keys keep them
  // separate.
  type GroupKey = string; // `${corridor}|${sourceNodeId}`
  const groups = new Map<GroupKey, TrackAssignment[]>();
  for (const t of tracks) {
    const edge = model.edges[t.edgeIndex]!;
    const srcCell = placement.cells.get(edge.from);
    if (!srcCell) continue;
    const key = `${t.corridor}|${edge.from}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  // Build a lookup from edgeIndex → its route (for multi-corridor flip
  // detection below).
  const routeByEdge = new Map<number, Route>();
  for (const r of reservation.routes) routeByEdge.set(r.edgeIndex, r);

  // Bend direction is computed from TARGET cell perp vs SOURCE cell perp
  // (for V corridors that's row; for H, col). Slot deltas within the same
  // cell are NOT a direction signal — two traces from the same source to
  // targets in the same row but at different intra-cell slot positions
  // are still going the same physical direction.
  //
  // Sibling routes through DIFFERENT corridors are not in the same group
  // (the corridor is part of GroupKey), so the corridor's kind is uniform
  // within each group; we look it up from any member.
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sampleCorridor = group[0]!.corridor;
    const corridorIsV = sampleCorridor.startsWith("V");
    // Multi-corridor staircase flip. For a route that traverses multiple
    // corridors (H1 → V1 → H2 staircase from src_v3 to hwy_v in ex 29),
    // the trace's track rank should FLIP at each chamfer between adjacent
    // corridors. If all siblings have the SAME corridor-position parity
    // at the current corridor, we flip the sort key when that parity is
    // odd. The mechanism: at every chamfer, the trace at "inner" of the
    // previous corridor must continue to the OUTER of the next (else its
    // perpendicular leg crosses sibling east-going / south-going stubs).
    //
    // For single-corridor routes (the example 19/20 cases), position is
    // always 0 → no flip → existing "deepest target → inner" rule holds.
    let allPositions = 0;
    let mixedParity = false;
    for (const t of group) {
      const r = routeByEdge.get(t.edgeIndex);
      if (!r) { mixedParity = true; break; }
      const pos = r.corridorSequence.findIndex(
        (c) => corridorKey(c) === corridorKeyStr,
      );
      if (pos < 0) { mixedParity = true; break; }
      if (t === group[0]) allPositions = pos;
      else if ((pos % 2) !== (allPositions % 2)) {
        mixedParity = true;
        break;
      }
    }
    const shouldFlip = !mixedParity && (allPositions % 2) === 1;

    // Split by PIXEL bend direction: sign of (exitPx - entryPx). This
    // catches the case where source and target are in the same cell row
    // (= same `srcPerp`/`tgtPerp` under the cell-row formulation) but
    // their slot pixel-y's differ — e.g. inlet at row 1 with slot 1
    // (y=44) routing to svc_a at row 1 with slot 0.5 (y=56) is
    // physically going south by 12px and should join the positive bend
    // group, not the "flat" subgroup that misses cross-target sibling
    // coherence.
    const positiveSibs: TrackAssignment[] = [];
    const negativeSibs: TrackAssignment[] = [];
    const flatSibs: TrackAssignment[] = [];
    for (const t of group) {
      const d = Math.sign(t.exitPx - t.entryPx);
      if (d > 0) positiveSibs.push(t);
      else if (d < 0) negativeSibs.push(t);
      else flatSibs.push(t);
    }
    void corridorIsV; // direction is now derived from pixel deltas
    // Flat siblings (same perp cell on both ends) split by slot-direction
    // — they're tiny up/down jogs and behave like ±positive without a
    // crossing-direction conflict. Sort them by slot delta for stability.
    for (const [subgroup, positiveBend] of [
      [positiveSibs, true] as const,
      [negativeSibs, false] as const,
      [flatSibs, true] as const,
    ]) {
      if (subgroup.length < 2) continue;
      // Collect occupied track ordinals as a MULTISET — preserves the
      // total count of slots available across all ordinals so a
      // subgroup that originally had 3 traces sharing track 1 (because
      // their intervals were disjoint) keeps 3 "slots" available at
      // track 1 during reassignment.
      const occupiedMultiset = subgroup.map((t) => t.track).sort((a, b) => a - b);
      // Sort siblings so the trace whose target is FURTHEST in the bend
      // direction is FIRST in the preference list. Inner (smallest
      // ordinal) is taken first by the trace that wants it most.
      //
      // The "deepest goes inner" rule fixes the cross-direction case
      // (example 19, ext_1 → svc_a + ext_1 → svc_b through inlet):
      // svc_b (deeper south) takes the INNER track so its long V-leg
      // doesn't cross svc_a's shallower H stub, and svc_a takes outer
      // so its short hop happens after svc_b's already cleared the H
      // corridor.
      //
      // When `shouldFlip` is true (intermediate corridor of a staircase
      // route), the ordering is inverted so that inner-here = outer-next.
      const flipMul = shouldFlip ? -1 : 1;
      const desiredOrder = [...subgroup].sort((a, b) => {
        // Primary: target depth (pixel). For positive bend, larger exit
        // pixel = deeper into the bend → inner (first). For negative
        // bend, smaller exit pixel = deeper → inner.
        if (a.exitPx !== b.exitPx) {
          return flipMul * (positiveBend ? b.exitPx - a.exitPx : a.exitPx - b.exitPx);
        }
        // Same target pixel position: tiebreak on source-FACE slot.
        // The slot closer to the bend destination has a shorter perp
        // leg, takes inner; the slot farther has a longer leg, takes
        // outer.
        const ra = routeByEdge.get(a.edgeIndex)!;
        const rb = routeByEdge.get(b.edgeIndex)!;
        const sa = ra.sourceSlot;
        const sb = rb.sourceSlot;
        if (sa !== sb) return flipMul * (positiveBend ? sb - sa : sa - sb);
        return a.edgeIndex - b.edgeIndex;
      });
      // Reassign with INTERVAL SAFETY. For each trace in preference
      // order, pick the smallest ordinal from the multiset where (a)
      // there's still a count available AND (b) no already-reassigned
      // trace on that ordinal has an overlapping pixel interval.
      // Otherwise fall back to the trace's original ordinal.
      //
      // Without this safety check the coherence merges traces with
      // overlapping intervals onto the same ordinal — the cause of the
      // example 19 svc_b column-stacking regression where 3 svc_b
      // V-legs with overlapping y-ranges all landed on track 1.
      const ordinalCounts = new Map<number, number>();
      for (const o of occupiedMultiset) {
        ordinalCounts.set(o, (ordinalCounts.get(o) ?? 0) + 1);
      }
      const assignedByOrdinal = new Map<number, { lo: number; hi: number }[]>();
      const distinctOrdinals = [...new Set(occupiedMultiset)].sort((a, b) => a - b);
      const newAssignments = new Map<TrackAssignment, number>();
      for (const t of desiredOrder) {
        const lo = Math.min(t.entryPx, t.exitPx);
        const hi = Math.max(t.entryPx, t.exitPx);
        let chosen = -1;
        for (const ord of distinctOrdinals) {
          const remaining = ordinalCounts.get(ord) ?? 0;
          if (remaining <= 0) continue;
          const existing = assignedByOrdinal.get(ord) ?? [];
          const conflict = existing.some((iv) => !(hi <= iv.lo || lo >= iv.hi));
          if (conflict) continue;
          chosen = ord;
          break;
        }
        if (chosen === -1) chosen = t.track; // fall back; shouldn't happen
        newAssignments.set(t, chosen);
        ordinalCounts.set(chosen, (ordinalCounts.get(chosen) ?? 0) - 1);
        const existing = assignedByOrdinal.get(chosen) ?? [];
        existing.push({ lo, hi });
        assignedByOrdinal.set(chosen, existing);
      }
      for (const [t, ord] of newAssignments) t.track = ord;
    }
  }
}

/**
 * Cross-bundle stub-avoidance pass.
 *
 * Operates AFTER `applySameSourceCoherence` has settled within-bundle
 * track order. Looks for pairs of same-source-cell bundles in the same
 * corridor where:
 *
 *   1. Their pixel intervals (union of member [entryPx, exitPx]) overlap.
 *   2. Bundle A consists entirely of "side-aligned" traces — every
 *      member has a non-axial endpoint on the same near side of the
 *      corridor (NEAR-WEST for V, NEAR-NORTH for H).
 *   3. Bundle B consists entirely of "fully axial" traces — both entry
 *      and exit are corridor-corridor transitions.
 *   4. The current ordinal layout has A on the FAR side of B (i.e., A's
 *      median ordinal > B's median ordinal for NEAR-WEST/NEAR-NORTH
 *      bundles, the side the bundle wants to be NEAR).
 *
 * Under those conditions, swapping A's and B's ordinal RANGES (preserving
 * relative order within each bundle) eliminates A's entry-stub crossings
 * with B's perpendicular descent. Symmetric for NEAR-EAST/NEAR-SOUTH
 * (those want LARGE ordinals; swap if currently on the near side of B).
 *
 * The pass is a pure permutation of already-assigned track ordinals — no
 * new tracks, no change to demand. Interval safety: since the two bundles'
 * intervals OVERLAP, neither can share a track ordinal with the other,
 * so after the swap each bundle still occupies a disjoint set of ordinals
 * from the other.
 *
 * Limitations / scope at v1:
 *
 *   - Only handles pairs where A is uniformly side-aligned (all entries
 *     on the same side AND all exits on the same side or all axial) and
 *     B is uniformly fully-axial. Mixed bundles are skipped.
 *   - Only one swap per corridor per pass — multi-bundle swaps would
 *     need iteration to converge. Most diagrams are dominated by one
 *     such pair (the ex 29 case).
 *   - Doesn't track non-bundle tracks (e.g., the src_v3 axial forward
 *     bundle in ex 29 shares ordinals 4-6 with src_h3 via interval reuse);
 *     after the swap the multiset of ordinals each bundle occupies is the
 *     same as before but redistributed, so the non-bundle co-tenants
 *     don't move.
 */
function applyCrossBundleStubAvoidance(
  tracks: TrackAssignment[],
  model: Model,
  placement: Placement,
  reservation: Reservation,
  corridor: Corridor,
  corridorKeyStr: string,
): void {
  if (corridor.kind === "D") return; // not used at Step 6
  const routeByEdge = new Map<number, Route>();
  for (const r of reservation.routes) routeByEdge.set(r.edgeIndex, r);

  // Classify each track's entry/exit side into the corridor.
  type SidePref = "near-near" | "near-far" | "axial";
  // For a V corridor: "near" = WEST (small x). "far" = EAST (large x).
  // For an H corridor: "near" = NORTH (small y). "far" = SOUTH (large y).
  const classify = (t: TrackAssignment): {
    entryCls: SidePref;
    exitCls: SidePref;
  } => {
    const edge = model.edges[t.edgeIndex]!;
    const route = routeByEdge.get(t.edgeIndex)!;
    const idxInSeq = route.corridorSequence.findIndex(
      (c) => corridorKey(c) === corridorKeyStr,
    );
    const isFirst = idxInSeq === 0;
    const isLast = idxInSeq === route.corridorSequence.length - 1;
    const srcCell = placement.cells.get(edge.from)!;
    const tgtCell = placement.cells.get(edge.to)!;
    let entryCls: SidePref;
    let exitCls: SidePref;
    if (!isFirst) {
      entryCls = "axial";
    } else if (corridor.kind === "V") {
      // Source's box is on a column adjacent to V(corridor.index).
      // V(c) sits between col c-1 (west) and col c (east).
      if (route.sourceSide === "E" && srcCell.col === corridor.index - 1) {
        entryCls = "near-near"; // box at col c-1, east face -> west boundary of V
      } else if (route.sourceSide === "W" && srcCell.col === corridor.index) {
        entryCls = "near-far"; // box at col c, west face -> east boundary of V
      } else {
        entryCls = "axial"; // N/S face on a box that spans V — unusual
      }
    } else {
      // H corridor; H(r) sits between row r-1 (north) and row r (south).
      if (route.sourceSide === "S" && srcCell.row === corridor.index - 1) {
        entryCls = "near-near"; // box north of H, south face -> north boundary
      } else if (route.sourceSide === "N" && srcCell.row === corridor.index) {
        entryCls = "near-far"; // box south of H, north face -> south boundary
      } else {
        entryCls = "axial";
      }
    }
    if (!isLast) {
      exitCls = "axial";
    } else if (corridor.kind === "V") {
      if (route.targetSide === "E" && tgtCell.col === corridor.index - 1) {
        exitCls = "near-near";
      } else if (route.targetSide === "W" && tgtCell.col === corridor.index) {
        exitCls = "near-far";
      } else {
        exitCls = "axial";
      }
    } else {
      if (route.targetSide === "S" && tgtCell.row === corridor.index - 1) {
        exitCls = "near-near";
      } else if (route.targetSide === "N" && tgtCell.row === corridor.index) {
        exitCls = "near-far";
      } else {
        exitCls = "axial";
      }
    }
    return { entryCls, exitCls };
  };

  // Group tracks by source NODE id (same key as applySameSourceCoherence).
  const bundles = new Map<string, TrackAssignment[]>();
  for (const t of tracks) {
    const edge = model.edges[t.edgeIndex]!;
    if (!bundles.has(edge.from)) bundles.set(edge.from, []);
    bundles.get(edge.from)!.push(t);
  }

  // Per bundle, compute:
  //   - aggregated entry/exit class (uniform across members, else "mixed")
  //   - ordinal set
  //   - pixel interval (lo, hi)
  type BundleInfo = {
    nodeId: string;
    tracks: TrackAssignment[];
    entryCls: SidePref | "mixed";
    exitCls: SidePref | "mixed";
    ordinals: number[];
    lo: number;
    hi: number;
  };
  const bundleInfos: BundleInfo[] = [];
  for (const [nodeId, ts] of bundles) {
    if (ts.length < 1) continue;
    const classes = ts.map(classify);
    const allEntrySame = classes.every((c) => c.entryCls === classes[0]!.entryCls);
    const allExitSame = classes.every((c) => c.exitCls === classes[0]!.exitCls);
    bundleInfos.push({
      nodeId,
      tracks: ts,
      entryCls: allEntrySame ? classes[0]!.entryCls : "mixed",
      exitCls: allExitSame ? classes[0]!.exitCls : "mixed",
      ordinals: ts.map((t) => t.track).sort((a, b) => a - b),
      lo: Math.min(...ts.map((t) => Math.min(t.entryPx, t.exitPx))),
      hi: Math.max(...ts.map((t) => Math.max(t.entryPx, t.exitPx))),
    });
  }

  // A bundle is "side-aligned" if its entry is near-near OR near-far,
  // exit is the same OR axial. Its `side` is "near" or "far" accordingly.
  // A bundle is "fully axial" if both entry and exit are axial.
  type SideClass = "near" | "far" | null;
  const classifyBundle = (b: BundleInfo): SideClass => {
    const sides = [b.entryCls, b.exitCls].filter((c) => c !== "axial");
    if (sides.length === 0) return null; // fully axial
    if (sides.some((c) => c === "mixed")) return null;
    const nearCount = sides.filter((c) => c === "near-near").length;
    const farCount = sides.filter((c) => c === "near-far").length;
    if (nearCount > 0 && farCount === 0) return "near";
    if (farCount > 0 && nearCount === 0) return "far";
    // Mixed near + far: e.g. src_h3 (entry near-near, exit near-far in V1).
    // Treat as side-aligned to whichever endpoint sits at the y the bundle
    // would conflict on. For the ex 29 case, src_h3 has entry y in
    // [424,440] which overlaps with the axial bundle [320,448]; exit y in
    // [288,304] does NOT overlap. So entry side dominates. Heuristic: pick
    // the endpoint whose pixel position falls INSIDE the bundle's own
    // [lo,hi] range and is INSIDE the conflicting bundle's interval as
    // well — but the conflicting bundle isn't known at classify time. So
    // we approximate by picking the side that contributes the wider
    // overlap with [lo, hi].
    //
    // Simpler heuristic: if entry side and exit side disagree AND the
    // bundle's exitPx range sits OUTSIDE the entry side's bend zone (i.e.,
    // the exit doesn't actually cross anything at large ordinals because
    // there's nothing there at that y), defer to entry.
    //
    // Most robust: try both and pick the swap that reduces total stub
    // crossings. That's expensive though; for v1 we just defer to entry.
    return b.entryCls === "near-near" ? "near" : "far";
  };
  const isFullyAxial = (b: BundleInfo): boolean =>
    b.entryCls === "axial" && b.exitCls === "axial";

  // Build the "side-aligned" and "fully-axial" lists.
  const sideAligned = bundleInfos
    .map((b) => ({ b, side: classifyBundle(b) }))
    .filter((x): x is { b: BundleInfo; side: "near" | "far" } => x.side !== null);
  const axialOnly = bundleInfos.filter(isFullyAxial);
  if (sideAligned.length === 0 || axialOnly.length === 0) return;

  // For each side-aligned bundle, check if any axial bundle has overlapping
  // pixel interval AND is on the wrong side of the side-aligned bundle's
  // preference. If yes, swap their ordinal ranges.
  //
  // Apply at most one swap per side-aligned bundle (the dominant pair),
  // and never swap the same axial bundle twice.
  const swappedAxials = new Set<string>();
  for (const { b: aBundle, side } of sideAligned) {
    if (aBundle.ordinals.length === 0) continue;
    const aMedian = aBundle.ordinals[Math.floor(aBundle.ordinals.length / 2)]!;
    for (const xBundle of axialOnly) {
      if (swappedAxials.has(xBundle.nodeId)) continue;
      if (xBundle.ordinals.length === 0) continue;
      // Pixel-interval overlap (strict-open).
      if (aBundle.hi <= xBundle.lo || aBundle.lo >= xBundle.hi) continue;
      const xMedian = xBundle.ordinals[Math.floor(xBundle.ordinals.length / 2)]!;
      // "Near" side-aligned wants SMALL ordinals; "far" wants LARGE.
      const wrongSide = side === "near"
        ? aMedian > xMedian
        : aMedian < xMedian;
      if (!wrongSide) continue;
      // Swap the two ordinal ranges. Preserve relative order within
      // each bundle (so e.g. ordinal 4 in aBundle -> ordinal 1 in
      // xBundle's position, etc.).
      //
      // Get the ordinals each bundle occupies, sorted ascending. Note
      // that interval-reuse may have a bundle's members sharing ordinals
      // with other bundles' members; we only redistribute the ordinals
      // BETWEEN this pair. Co-tenants stay on their original ordinals.
      const aOrdinals = aBundle.tracks
        .map((t) => t.track)
        .sort((p, q) => p - q);
      const xOrdinals = xBundle.tracks
        .map((t) => t.track)
        .sort((p, q) => p - q);
      // Take the multiset UNION of ordinals; the side-aligned bundle
      // should claim the side's end of the combined multiset, the axial
      // gets the other end.
      const combined = [...aOrdinals, ...xOrdinals].sort((p, q) => p - q);
      const aCount = aOrdinals.length;
      const xCount = xOrdinals.length;
      const newAOrdinals = side === "near"
        ? combined.slice(0, aCount)
        : combined.slice(combined.length - aCount);
      const newXOrdinals = side === "near"
        ? combined.slice(combined.length - xCount)
        : combined.slice(0, xCount);
      // Sort each bundle's members by their CURRENT ordinal to assign
      // new ordinals in the same relative order. For the side-aligned
      // bundle: ascending CURRENT -> ascending NEW (so the trace that
      // was innermost stays innermost relative to the bundle).
      const aSorted = [...aBundle.tracks].sort((p, q) => p.track - q.track);
      const xSorted = [...xBundle.tracks].sort((p, q) => p.track - q.track);
      for (let i = 0; i < aSorted.length; i++) {
        aSorted[i]!.track = newAOrdinals[i]!;
      }
      for (let i = 0; i < xSorted.length; i++) {
        xSorted[i]!.track = newXOrdinals[i]!;
      }
      // Update aBundle's ordinals so further iterations see the new state.
      aBundle.ordinals = aBundle.tracks
        .map((t) => t.track)
        .sort((p, q) => p - q);
      xBundle.ordinals = xBundle.tracks
        .map((t) => t.track)
        .sort((p, q) => p - q);
      swappedAxials.add(xBundle.nodeId);
      break; // one swap per side-aligned bundle
    }
  }
}

// --- entry / exit long-axis computation -----------------------------------

function entryLongAxis(
  corridor: Corridor,
  route: Route,
  idxInSeq: number,
  model: Model,
  placement: Placement,
): LongAxisCoord {
  if (idxInSeq === 0) {
    // First corridor: trace enters from the source box's chosen face.
    return faceToLongAxis(
      corridor,
      route.sourceSide,
      route.sourceSlot,
      placement.cells.get(model.edges[route.edgeIndex]!.from)!,
    );
  }
  // Intermediate / last: trace enters from the previous corridor in
  // the sequence. Compute the intersection of the previous corridor
  // and this one.
  const prev = route.corridorSequence[idxInSeq - 1]!;
  return corridorIntersection(corridor, prev);
}

function exitLongAxis(
  corridor: Corridor,
  route: Route,
  idxInSeq: number,
  model: Model,
  placement: Placement,
): LongAxisCoord {
  if (idxInSeq === route.corridorSequence.length - 1) {
    // Last corridor: trace exits into the target box's face.
    return faceToLongAxis(
      corridor,
      route.targetSide,
      route.targetSlot,
      placement.cells.get(model.edges[route.edgeIndex]!.to)!,
    );
  }
  const next = route.corridorSequence[idxInSeq + 1]!;
  return corridorIntersection(corridor, next);
}

/**
 * Map a (corridor, box face, slot, cell) to a long-axis coord. The
 * cell tells us which box the face is on; the side+slot determines the
 * specific port; the corridor's orientation determines whether we
 * care about the port's row or col coord on the corridor's long axis.
 *
 * For an H corridor (long axis = x), entries/exits on N/S box faces
 * contribute their col + slot.
 * For a V corridor (long axis = y), entries/exits on E/W box faces
 * contribute their row + slot.
 */
function faceToLongAxis(
  corridor: Corridor,
  side: Side,
  slot: number,
  cell: { row: number; col: number },
): LongAxisCoord {
  if (corridor.kind === "H") {
    // Long axis = x = col. For E/W faces, the trace enters/exits at
    // the col boundary of the box.
    if (side === "W") return { boundaryIndex: cell.col, slotIndex: slot };
    if (side === "E") return { boundaryIndex: cell.col + 1, slotIndex: slot };
    // N/S faces: trace enters/exits along the box's col span at a
    // slot offset (slot ∈ [0, cell-width * 3)). The boundary index
    // is the box's left col; slot tracks the within-col x offset.
    return { boundaryIndex: cell.col, slotIndex: slot };
  }
  if (corridor.kind === "V") {
    // Long axis = y = row. For N/S faces, the trace enters/exits at
    // the row boundary of the box.
    if (side === "N") return { boundaryIndex: cell.row, slotIndex: slot };
    if (side === "S") return { boundaryIndex: cell.row + 1, slotIndex: slot };
    // E/W faces: trace enters/exits along the box's row span at a
    // slot offset.
    return { boundaryIndex: cell.row, slotIndex: slot };
  }
  // Diagonal: unused at Step 6.
  return { boundaryIndex: 0, slotIndex: slot };
}

/**
 * Compute the long-axis coord of the intersection between `corridor`
 * and `other`. An H-corridor's long axis is x (col); when it
 * intersects V(c), the intersection x = col c. A V-corridor's long
 * axis is y (row); intersecting H(r) gives y = row r.
 *
 * Intersection slot is 0 — the intersection sits exactly at the
 * boundary, no intra-cell offset. This sorts before any face-slot
 * coord at the same boundary index, which is the natural physical
 * ordering (corridor transitions happen at cell corners, which are
 * outside the slot range on adjacent box faces).
 */
function corridorIntersection(
  corridor: Corridor,
  other: Corridor,
): LongAxisCoord {
  if (corridor.kind === "H") {
    if (other.kind === "V") {
      return { boundaryIndex: other.index, slotIndex: 0 };
    }
    // H ∩ H is undefined (parallel corridors don't intersect).
    // Should not arise in well-formed corridor sequences.
    return { boundaryIndex: 0, slotIndex: 0 };
  }
  if (corridor.kind === "V") {
    if (other.kind === "H") {
      return { boundaryIndex: other.index, slotIndex: 0 };
    }
    return { boundaryIndex: 0, slotIndex: 0 };
  }
  return { boundaryIndex: 0, slotIndex: 0 };
}

function compareLongAxis(a: LongAxisCoord, b: LongAxisCoord): number {
  if (a.boundaryIndex !== b.boundaryIndex) {
    return a.boundaryIndex - b.boundaryIndex;
  }
  return a.slotIndex - b.slotIndex;
}

// --- pixel-aware entry/exit ----------------------------------------------

/**
 * The trace's entry pixel on the corridor's long axis. For a V
 * corridor (long axis = y), returns pixel y; for H (long axis = x),
 * returns pixel x.
 *
 * For the FIRST corridor of a route, entry is on the source box's
 * chosen face — use `slotPixel` to resolve the slot port to a pixel.
 * For intermediate / last corridors, entry is the intersection with
 * the previous corridor in the sequence — use the corridor's edge
 * coordinate.
 */
function entryPixel(
  corridor: Corridor,
  route: Route,
  idxInSeq: number,
  model: Model,
  placement: Placement,
  layout: PixelLayout,
): number {
  if (idxInSeq === 0) {
    const srcCell = placement.cells.get(model.edges[route.edgeIndex]!.from)!;
    const srcSize = model.nodes.find((n) => n.id === model.edges[route.edgeIndex]!.from)?.size
      ?? { width: 1, height: 1 };
    const p = slotPixel(
      route.sourceSide,
      route.sourceSlot,
      srcCell,
      srcSize.width,
      srcSize.height,
      layout,
    );
    return corridor.kind === "V" ? p.y : p.x;
  }
  const prev = route.corridorSequence[idxInSeq - 1]!;
  return corridorIntersectionPixel(corridor, prev, layout);
}

function exitPixel(
  corridor: Corridor,
  route: Route,
  idxInSeq: number,
  model: Model,
  placement: Placement,
  layout: PixelLayout,
): number {
  if (idxInSeq === route.corridorSequence.length - 1) {
    const tgtCell = placement.cells.get(model.edges[route.edgeIndex]!.to)!;
    const tgtSize = model.nodes.find((n) => n.id === model.edges[route.edgeIndex]!.to)?.size
      ?? { width: 1, height: 1 };
    const p = slotPixel(
      route.targetSide,
      route.targetSlot,
      tgtCell,
      tgtSize.width,
      tgtSize.height,
      layout,
    );
    return corridor.kind === "V" ? p.y : p.x;
  }
  const next = route.corridorSequence[idxInSeq + 1]!;
  return corridorIntersectionPixel(corridor, next, layout);
}

/**
 * Pixel position of the intersection between `corridor` and `other`.
 * H ∩ V at column c → pixel x of col c's west edge (= V corridor's
 * vertical track line). V ∩ H at row r → pixel y of row r's north
 * edge.
 *
 * The intersection sits at the gutter's *near* boundary (north for H,
 * west for V). Any track-pitch offset within the gutter is irrelevant
 * here — the conflict check cares about which y/x range the trace
 * occupies in the perpendicular corridor, not where it specifically
 * lives within the gutter's width.
 */
function corridorIntersectionPixel(
  corridor: Corridor,
  other: Corridor,
  layout: PixelLayout,
): number {
  if (corridor.kind === "H" && other.kind === "V") {
    return vCorridorWestEdgeX(other.index, layout);
  }
  if (corridor.kind === "V" && other.kind === "H") {
    return hCorridorNorthEdgeY(other.index, layout);
  }
  return 0;
}
