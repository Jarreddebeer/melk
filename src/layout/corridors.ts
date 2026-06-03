/**
 * Phase 4 corridor reservation (Step 5).
 *
 * Inputs: a bound `Model` and the `Placement` from Step 4.
 * Output: a `Reservation` carrying — for each edge — the side+slot of its
 * source and target endpoints and the corridor sequence it traverses;
 * for each corridor — the trace demand; for the grid — widened
 * rowUnits/colUnits that absorb that demand at the global comb pitch.
 *
 * Step 5 does NOT materialise crossings or pack tracks within corridors.
 * Crossings are Step 6's job; this pass only counts demand so that the
 * row/col gutters are wide enough. See DESIGN-PHASE4.md §3 for the spec.
 *
 * Algorithm at a glance:
 *   1. Side assignment — for every edge, choose source side and target
 *      side using the strict cardinal rule (§3.3).
 *   2. Corridor sequence — for every edge, compute the ordered list of
 *      corridors it walks from source-side exit to target-side entry
 *      (§3.4). Manhattan only at Step 5; diagonals stay off.
 *   3. Slot-index assignment — for every box side, assign each incident
 *      trace a slot in [0, capacity). Uniform-flux ordering (§3.5).
 *   4. Demand + widening — count traces per corridor, widen the
 *      adjacent rowUnits / colUnits so the gutter fits demand at
 *      COMB_PITCH (§3.6).
 *
 * Errors:
 *   E_SIDE_OVERSUBSCRIBED — a box side has more traces than its
 *     capacity. Thrown during slot assignment.
 *   E_UNROUTABLE — kept reserved for cases the widening cannot
 *     resolve. Not thrown yet (Manhattan-only Step 5 always widens
 *     enough; diagonals + crossings may surface this in Step 6).
 */
import type { Model } from "../bind/model.js";
import type { Cell, Direction, FlowAxis, Placement } from "./placement.js";

// --- public types ---------------------------------------------------------

/**
 * The four cardinal sides of a box. Slot ports sit perpendicular to the
 * side they're on; traces enter/exit horizontally on E/W sides and
 * vertically on N/S sides (DESIGN §1.3).
 */
export type Side = "N" | "E" | "S" | "W";

/**
 * A corridor identity, used both as the graph node and as the lookup key
 * for demand counting. Horizontal corridors live in the gutter between
 * two rows; vertical corridors live in the gutter between two cols.
 *
 *   - H(r) := the gutter between row r-1 and row r. r ∈ [0, nRows].
 *            r=0 is the margin above the top row; r=nRows is the margin
 *            below the bottom row.
 *   - V(c) := the gutter between col c-1 and col c. c ∈ [0, nCols].
 *
 * Diagonal corridors (DESIGN §3.1) are introduced as a separate variant
 * but are unused at Step 5 — kept here so the type is stable for Step 6.
 */
export type Corridor =
  | { kind: "H"; index: number }
  | { kind: "V"; index: number }
  | { kind: "D"; row: number; col: number; dir: "NE" | "SE" | "SW" | "NW" };

/**
 * Per-edge routing decision produced by Step 5.
 *
 * `sourceSide` / `targetSide` are the box faces the trace uses (§3.3).
 * `sourceSlot` / `targetSlot` are indices into the comb teeth on those
 * faces (§3.5). `corridorSequence` is the ordered list of corridors the
 * trace traverses (§3.4); for same-row east-west routes it's a single
 * vertical corridor.
 *
 * The edge identity is referenced by its index into `Model.edges` so
 * that downstream passes can correlate back to provenance.
 */
export interface Route {
  edgeIndex: number;
  sourceSide: Side;
  sourceSlot: number;
  targetSide: Side;
  targetSlot: number;
  corridorSequence: Corridor[];
}

export interface Reservation {
  /** One entry per edge in `Model.edges`, in declaration order. */
  routes: Route[];
  /** Demand keyed by corridor identity (see `corridorKey`). */
  demand: Map<string, number>;
  /**
   * Cell-unit widths of each column. Unchanged from `Placement.colUnits`.
   * Step 5 doesn't change box-cell widths; it adds *gutter* width
   * between cols via `colGutterUnits` instead.
   */
  colUnits: number[];
  /** Cell-unit heights of each row. Unchanged from `Placement.rowUnits`. */
  rowUnits: number[];
  /**
   * Gutter widths between cols, expressed in cell-units. Length =
   * `colUnits.length + 1`. `colGutterUnits[c]` is the gutter west of
   * col `c` (so [0] is the left page margin and [last] is the right
   * page margin). 0 means "no extra space"; 1 means "one cell-unit of
   * extra space, room for TRACES_PER_CELL_UNIT traces in that gutter".
   *
   * Step 5 sets each gutter to `ceil(demand(V(c)) / TRACES_PER_CELL_UNIT)`.
   * The renderer (Step 8) translates to pixels.
   */
  colGutterUnits: number[];
  /** Gutter heights between rows. Mirror of `colGutterUnits`. */
  rowGutterUnits: number[];
  /** Flow axis carried from `Placement`. */
  flowAxis: FlowAxis;
}

export class CorridorError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// --- constants ------------------------------------------------------------

/**
 * Render-time pitch values. Step 5 only uses them as a *ratio*: how many
 * traces fit in one cell-unit gutter before we need to widen. Keeping
 * them here means the renderer (Step 8) can read the same numbers.
 *
 * COMB_PITCH = 8 px (the global grid pitch from feedback-global-grid).
 * CELL_PX    = 32 px (DESIGN §1.1 default).
 *
 * At defaults, the gutter between two cell-tall sides holds
 *   CELL_PX / COMB_PITCH - 1 = 3 traces
 * before pushing the rows apart (one tooth is reserved at each end as
 * margin so traces don't graze the boxes).
 */
export const COMB_PITCH = 8;
export const CELL_PX = 32;

/**
 * Traces per single cell-unit of gutter. With pitch 8 and cell 32, this
 * is 3 (the 4 slots fit but one is reserved as end margin). Changing
 * COMB_PITCH or CELL_PX rescales the whole router uniformly — no other
 * code needs editing.
 */
export const TRACES_PER_CELL_UNIT =
  Math.floor(CELL_PX / COMB_PITCH) - 1;

// --- entry point ----------------------------------------------------------

/**
 * Pure function from `Model` + `Placement` to `Reservation`. Same input
 * always produces the same output, byte-for-byte (DESIGN §7.2).
 *
 * Two-pass demand model (DESIGN §11.7):
 *   Pass A — compute corridor sequences with every pickable edge
 *            defaulting to `pivot: "source"` (legacy behavior). Count
 *            demand per corridor.
 *   Pick   — for each pickable edge (diagonal-cell forward), evaluate
 *            both pivot options scored by *other* edges' provisional
 *            demand on the resulting sequence. Author override beats
 *            the picker; ties resolve to `source`.
 *   Pass B — recompute corridor sequences using chosen pivots. From
 *            here on it's identical to the single-pass world: slot
 *            assignment, final demand count, gutter widening.
 */
export function reserveCorridors(
  model: Model,
  placement: Placement,
): Reservation {
  // Per-edge invariants reused by both passes: forward direction, sides,
  // src/tgt cells, whether the edge is pickable (diagonal-cell forward).
  type EdgeCtx = {
    src: Cell;
    tgt: Cell;
    edgeFwd: Direction;
    sides: { sourceSide: Side; targetSide: Side };
    /** Diagonal-cell forward edge → can choose pivot. */
    pickable: boolean;
  };
  const edgeCtxs: EdgeCtx[] = [];
  for (let i = 0; i < model.edges.length; i++) {
    const edge = model.edges[i]!;
    const src = placement.cells.get(edge.from);
    const tgt = placement.cells.get(edge.to);
    if (!src || !tgt) {
      // Bind guarantees every edge endpoint is a declared node, and
      // place() puts every declared node somewhere. If we ever land
      // here, something upstream is broken — surface as a hard error.
      throw new CorridorError(
        `internal: edge '${edge.from} -> ${edge.to}' has unplaced endpoint`,
      );
    }
    // Edge forward direction (DESIGN §2.5).
    //
    //   - back-edge: opposite of the source node's local forward — the
    //     trace leaves the rear face and wraps around.
    //   - structured edge (pipeline/bus/fan-out/branch): the *target*
    //     node's local forward. This captures the primitive's intent:
    //     a bus producer routes "into the bus" (forward = shared.forward),
    //     a branch member routes "along the branch" (forward = member.forward),
    //     a fan-out consumer routes "out the fan-out" (forward = consumer.forward
    //     = shared's forward propagated). Using cell delta here would
    //     pick wrong sides for off-median bus producers (e.g. a 4-producer
    //     bus has its top/bottom producers diagonal to shared, and the
    //     long-axis rule routes them around the shared box instead of
    //     converging on its W face).
    //   - explicit (or auto-declared free edge): cell delta. With no
    //     structural intent to honour, the edge picks its own forward
    //     from how the placer laid it out.
    const fallbackFwd = placement.flowAxis === "east" ? "E" : "S";
    const srcLocalFwd = placement.forwardAt.get(edge.from) ?? fallbackFwd;
    const tgtLocalFwd = placement.forwardAt.get(edge.to) ?? fallbackFwd;
    let edgeFwd: Direction;
    if (edge.isBackEdge) {
      edgeFwd = opposite(srcLocalFwd);
    } else if (edge.source === "explicit") {
      edgeFwd = forwardOfEdge(src, tgt, srcLocalFwd);
    } else {
      // pipeline / bus / fan-out / branch — primitive-implied edge.
      edgeFwd = tgtLocalFwd;
    }
    const sides = assignSides(edgeFwd);
    // §11.10: author can override either or both endpoint faces.
    if (edge.exitSide !== undefined) sides.sourceSide = edge.exitSide;
    if (edge.entrySide !== undefined) sides.targetSide = edge.entrySide;
    // Pickable = the corridor sequence has two valid Z orientations.
    // After §11.10 that means both endpoints sit on the same corridor
    // axis (both V or both H) AND the cells are diagonal. V→H or H→V
    // L-shapes have only one valid geometry — see corridorSequence().
    const srcKind: "V" | "H" =
      sides.sourceSide === "E" || sides.sourceSide === "W" ? "V" : "H";
    const tgtKind: "V" | "H" =
      sides.targetSide === "E" || sides.targetSide === "W" ? "V" : "H";
    const pickable =
      !edge.isBackEdge &&
      srcKind === tgtKind &&
      src.row !== tgt.row &&
      src.col !== tgt.col;
    edgeCtxs.push({ src, tgt, edgeFwd, sides, pickable });
  }

  // --- Pass A: provisional corridor sequences using pivot = "source".
  //
  // Even pickable edges with an author override use "source" here, so
  // the demand baseline is consistent. The Pick step below replaces the
  // picker's result with the override; same with the picker's preference.
  const provisionalSeqs: Corridor[][] = edgeCtxs.map((ctx, i) =>
    corridorSequence(
      ctx.src,
      ctx.tgt,
      ctx.sides.sourceSide,
      ctx.sides.targetSide,
      !!model.edges[i]!.isBackEdge,
      ctx.edgeFwd,
      "source",
    ),
  );
  const provisionalDemand = countDemandFromSeqs(provisionalSeqs);

  // --- Pick: choose pivot per pickable edge.
  //
  // For each pickable edge, compare both candidate sequences scored by
  // sum(provisionalDemand[c] for c in candidate) *minus* the edge's own
  // contribution to its current provisional sequence (so we compare on
  // demand from other edges only). Author override beats picker; picker
  // ties resolve to "source" (preserves pre-§11.7 behavior).
  const chosenPivots: ("source" | "target")[] = edgeCtxs.map((ctx, i) => {
    const edge = model.edges[i]!;
    if (!ctx.pickable) return "source";
    if (edge.pivot !== undefined) return edge.pivot;
    return choosePivotByDemand(
      ctx.src,
      ctx.tgt,
      ctx.sides.sourceSide,
      ctx.sides.targetSide,
      ctx.edgeFwd,
      provisionalSeqs[i]!,
      provisionalDemand,
    );
  });

  // --- Pass B: final corridor sequences using chosen pivots.
  //
  // Two routing paths, in priority order:
  //   1. `avoidEdges` (§11.8): single-segment path search with blocked
  //      corridors.
  //   2. No author overrides: canned Z generator with picker-chosen
  //      pivot (§11.7 default).
  //
  // Via-edges (§11.9) are decomposed into pairs of synthetic sub-edges
  // (`a -> hwy`, `hwy -> b`) at bind time, so by the time we reach
  // here they're just regular edges with highway endpoints — routed
  // through the normal corridor pipeline with slot allocation and
  // track packing on the highway's faces.
  type FinalRoute = {
    sourceSide: Side;
    targetSide: Side;
    sequence: Corridor[];
  };
  const finalRoutes: FinalRoute[] = edgeCtxs.map((ctx, i) => {
    const edge = model.edges[i]!;
    if (edge.avoidEdges !== undefined && edge.avoidEdges.length > 0) {
      const blocked = computeBlockedCorridors(edge.avoidEdges, provisionalSeqs);
      // §11.10: the path search starts from the (possibly overridden) source
      // exit face and ends at the (possibly overridden) target entry face.
      // `gutterCorridor(cell, side)` returns the gutter just outside the
      // cell on that face, so pass the resolved sides directly.
      const seq = searchCorridorPath(
        placement,
        ctx.src,
        ctx.tgt,
        ctx.sides.sourceSide as Direction,
        ctx.sides.targetSide as Direction,
        blocked,
      );
      if (seq === null) {
        throw new CorridorError(
          `E_AVOID_UNROUTABLE: edge '${edge.from} -> ${edge.to}' cannot be routed under its 'avoid:' constraint; ${edge.avoidEdges.length} edge(s) are avoided and the union of their corridors blocks every alternative path`,
        );
      }
      return {
        sourceSide: ctx.sides.sourceSide,
        targetSide: ctx.sides.targetSide,
        sequence: seq,
      };
    }
    return {
      sourceSide: ctx.sides.sourceSide,
      targetSide: ctx.sides.targetSide,
      sequence: corridorSequence(
        ctx.src,
        ctx.tgt,
        ctx.sides.sourceSide,
        ctx.sides.targetSide,
        !!edge.isBackEdge,
        ctx.edgeFwd,
        chosenPivots[i]!,
      ),
    };
  });
  const routes: Omit<Route, "sourceSlot" | "targetSlot">[] = finalRoutes.map(
    (fr, i) => ({
      edgeIndex: i,
      sourceSide: fr.sourceSide,
      targetSide: fr.targetSide,
      corridorSequence: fr.sequence,
    }),
  );

  // 2. Slot-index assignment per box side, with the uniform-flux rule.
  const slots = assignSlots(model, placement, routes);

  // 3. Stitch slots into routes.
  const completeRoutes: Route[] = routes.map((r) => ({
    ...r,
    sourceSlot: slots.get(slotKey(model.edges[r.edgeIndex]!.from, r.sourceSide, r.edgeIndex, "from"))!,
    targetSlot: slots.get(slotKey(model.edges[r.edgeIndex]!.to, r.targetSide, r.edgeIndex, "to"))!,
  }));

  // 4. Demand counting + widening.
  const demand = countDemand(completeRoutes);
  const gutters = widen(placement, demand);

  return {
    routes: completeRoutes,
    demand,
    rowUnits: [...placement.rowUnits],
    colUnits: [...placement.colUnits],
    rowGutterUnits: gutters.rowGutterUnits,
    colGutterUnits: gutters.colGutterUnits,
    flowAxis: placement.flowAxis,
  };
}

/**
 * Picker: compare both Z-pivot options for a diagonal-cell forward edge
 * by their score against provisional demand (DESIGN §11.7). The score
 * for each candidate is `sum(demand[c] for c in candidate_seq)`. The
 * edge's contribution to the *current* (source-pivot) provisional
 * sequence is subtracted from both candidates' demand readings so that
 * the comparison reflects demand from *other* edges only — otherwise an
 * edge would always vote against changing because its own contribution
 * inflates the demand of the corridors it currently sits in.
 *
 * Ties resolve to "source" (pre-§11.7 behavior). The function is a pure
 * function of (cells, edge forward, provisional sequences/demand); under
 * the same inputs it returns the same answer, satisfying §7.2.
 */
function choosePivotByDemand(
  src: Cell,
  tgt: Cell,
  sourceSide: Side,
  targetSide: Side,
  edgeFwd: Direction,
  currentSeq: Corridor[],
  provisionalDemand: Map<string, number>,
): "source" | "target" {
  const sourceSeq = corridorSequence(src, tgt, sourceSide, targetSide, false, edgeFwd, "source");
  const targetSeq = corridorSequence(src, tgt, sourceSide, targetSide, false, edgeFwd, "target");
  // currentSeq is always the source-pivot sequence (Pass A used "source"
  // for everyone). The edge's own +1 contribution lives on each corridor
  // in currentSeq. Subtract that when reading provisional demand.
  const ownContrib = new Set(currentSeq.map(corridorKey));
  const scoreOf = (seq: Corridor[]) => {
    let s = 0;
    for (const c of seq) {
      const k = corridorKey(c);
      const d = provisionalDemand.get(k) ?? 0;
      s += ownContrib.has(k) ? Math.max(0, d - 1) : d;
    }
    return s;
  };
  const sourceScore = scoreOf(sourceSeq);
  const targetScore = scoreOf(targetSeq);
  if (targetScore < sourceScore) return "target";
  return "source"; // tie or source-better
}

/**
 * Sum demand over a list of corridor sequences. Used for Pass A's
 * baseline; the final pass uses `countDemand(routes)`.
 */
function countDemandFromSeqs(seqs: Corridor[][]): Map<string, number> {
  const demand = new Map<string, number>();
  for (const seq of seqs) {
    const seen = new Set<string>();
    for (const c of seq) {
      const k = corridorKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      demand.set(k, (demand.get(k) ?? 0) + 1);
    }
  }
  return demand;
}

// --- direction helpers ----------------------------------------------------

function opposite(d: Direction): Direction {
  switch (d) {
    case "N": return "S";
    case "S": return "N";
    case "E": return "W";
    case "W": return "E";
  }
}

/** The Side enum and Direction enum share the same N/E/S/W letters by design. */
function sideOf(d: Direction): Side {
  return d;
}

/**
 * Compute the cardinal forward direction for a forward edge from its
 * placed cells (DESIGN §2.5). For axis-aligned src→tgt this is the
 * unambiguous cardinal. For diagonals the long-axis component wins; when
 * the deltas are equal in magnitude (e.g. (-1, +1) — one cell NE) we
 * fall back to the source's local forward axis to break the tie.
 *
 * This is the function that fixes the wild-routing bug surfaced by
 * `branch transform -> enrich`: enrich is at (transform.row - 1,
 * transform.col), so the cell delta is (-1, 0) — clearly N. Without
 * this function the edge inherited the source's local forward (E) and
 * the corridor sequence sent the trace east first, around the
 * bounding box.
 */
function forwardOfEdge(src: Cell, tgt: Cell, srcLocalFwd: Direction): Direction {
  const dRow = tgt.row - src.row;
  const dCol = tgt.col - src.col;
  const absRow = Math.abs(dRow);
  const absCol = Math.abs(dCol);
  if (absRow > absCol) return dRow > 0 ? "S" : "N";
  if (absCol > absRow) return dCol > 0 ? "E" : "W";
  // Equal magnitudes (including (0, 0) for a self-loop, which Phase 4
  // doesn't have yet). Fall back to whichever axis the source's local
  // forward sits on, choosing the sign that points toward the target.
  if (srcLocalFwd === "E" || srcLocalFwd === "W") {
    return dCol > 0 ? "E" : "W";
  }
  return dRow > 0 ? "S" : "N";
}

// --- 1. side assignment ---------------------------------------------------

/**
 * Edge-forward rule (DESIGN §3.3). The source exits in the edge's
 * forward direction; the target enters from the rear-of-forward face.
 * Diagonal vs. axis-aligned cell pairs no longer matter — the forward
 * direction encodes the geometry. For a back-edge, the caller passes
 * `opposite(forwardAt[source])`, which sends the trace out the source's
 * rear face and into the target's front face for the wrap.
 */
function assignSides(
  edgeFwd: Direction,
): { sourceSide: Side; targetSide: Side } {
  return {
    sourceSide: sideOf(edgeFwd),
    targetSide: sideOf(opposite(edgeFwd)),
  };
}

// --- 2. corridor sequences ------------------------------------------------

/**
 * Manhattan corridor sequence. Returns the list of corridors a trace
 * walks from its source-side exit to its target-side entry.
 *
 * Inputs are the resolved sides (post §11.10 overrides), not `edgeFwd`.
 * Decoupling sides from forward direction is what lets an author write
 * `{ exit: E }` on an edge whose §3.3-implied forward is N — the trace
 * then exits V instead of H, and `corridorSequence` builds the path
 * accordingly. Back-edges still consult `edgeFwd` for their wrap logic
 * (passed via `backEdgeFwd`).
 *
 * Cases by corridor kind (V means E/W face, H means N/S face):
 *   - V→V same index: single corridor (target is adjacent in the
 *     direction the source exits).
 *   - V→V different index, same row: strip of V corridors between them.
 *   - V→V different index, different row: V→H→V Z with `pivot` choosing
 *     which H corridor to use (§11.7).
 *   - H→H mirror of above.
 *   - V→H or H→V: single L with one bend at the V∩H intersection.
 *     `pivot` argument is inert (only one possible L per side combo).
 *   - Back-edges: legacy wrap logic on `backEdgeFwd` (the source's
 *     local rear direction).
 */
function corridorSequence(
  src: Cell,
  tgt: Cell,
  sourceSide: Side,
  targetSide: Side,
  isBackEdge: boolean,
  backEdgeFwd: Direction,
  pivot: "source" | "target" = "source",
): Corridor[] {
  if (isBackEdge) {
    return backEdgeCorridorSequence(src, tgt, backEdgeFwd);
  }
  const srcKind: "V" | "H" =
    sourceSide === "E" || sourceSide === "W" ? "V" : "H";
  const tgtKind: "V" | "H" =
    targetSide === "E" || targetSide === "W" ? "V" : "H";
  const srcExitGI = gutterIndex(src, sourceSide);
  const tgtEntryGI = gutterIndex(tgt, targetSide);

  if (srcKind === "V" && tgtKind === "V") {
    if (src.row === tgt.row) {
      // Strip of V corridors between source and target along their shared row.
      const lo = Math.min(srcExitGI, tgtEntryGI);
      const hi = Math.max(srcExitGI, tgtEntryGI);
      const seq: Corridor[] = [];
      for (let c = lo; c <= hi; c++) seq.push({ kind: "V", index: c });
      return seq;
    }
    if (srcExitGI === tgtEntryGI) {
      return [{ kind: "V", index: srcExitGI }];
    }
    // V→H→V Z. Pivot row choice (§11.7):
    //   - "source": gutter immediately on the target's side of the source.
    //   - "target": gutter immediately on the source's side of the target.
    const pivotRow = pivot === "target"
      ? (src.row > tgt.row ? tgt.row + 1 : tgt.row)
      : (tgt.row > src.row ? src.row + 1 : src.row);
    return [
      { kind: "V", index: srcExitGI },
      { kind: "H", index: pivotRow },
      { kind: "V", index: tgtEntryGI },
    ];
  }
  if (srcKind === "H" && tgtKind === "H") {
    if (src.col === tgt.col) {
      const lo = Math.min(srcExitGI, tgtEntryGI);
      const hi = Math.max(srcExitGI, tgtEntryGI);
      const seq: Corridor[] = [];
      for (let r = lo; r <= hi; r++) seq.push({ kind: "H", index: r });
      return seq;
    }
    if (srcExitGI === tgtEntryGI) {
      return [{ kind: "H", index: srcExitGI }];
    }
    const pivotCol = pivot === "target"
      ? (src.col > tgt.col ? tgt.col + 1 : tgt.col)
      : (tgt.col > src.col ? src.col + 1 : src.col);
    return [
      { kind: "H", index: srcExitGI },
      { kind: "V", index: pivotCol },
      { kind: "H", index: tgtEntryGI },
    ];
  }
  // V→H or H→V: single L. One V corridor (the source's exit gutter)
  // meets one H corridor (the target's entry gutter) at their
  // intersection. Sequence order is exit-corridor-first; the polyline
  // emitter walks from the source exit slot up/down V to the H
  // intersection, then along H to the target entry slot.
  //
  // §11.7's pivot: knob doesn't apply here cleanly: a true
  // "corner-at-far-end" L would require the trace to walk along the
  // source's own row/col gutter first, but the source exit slot sits
  // at the FACE CENTER (not aligned with the row/col gutter), forcing
  // a pre-bend before the trace can reach that gutter. The result is
  // visually a 2-bend "S" shape, not a single-bend L. Avoiding that
  // requires a slot-position override (a future Phase 4.5 knob).
  if (srcKind === "V") {
    return [
      { kind: "V", index: srcExitGI },
      { kind: "H", index: tgtEntryGI },
    ];
  }
  return [
    { kind: "H", index: srcExitGI },
    { kind: "V", index: tgtEntryGI },
  ];
}

/**
 * Back-edge wrap: the trace exits the source's rear face, pivots on
 * the perpendicular axis at a gutter outside the bounding box, then
 * re-enters the target's front face. `backEdgeFwd` is the source's
 * rear direction (= `opposite(forwardAt[source])`). Pre-§11.10 logic
 * preserved verbatim — back-edges don't accept side overrides at v1
 * (`E_EXIT_ON_BACK_EDGE`).
 */
function backEdgeCorridorSequence(
  src: Cell,
  tgt: Cell,
  backEdgeFwd: Direction,
): Corridor[] {
  const srcExitGI = gutterIndex(src, backEdgeFwd);
  const tgtEntryGI = gutterIndex(tgt, opposite(backEdgeFwd));
  const fwdIsHoriz = backEdgeFwd === "E" || backEdgeFwd === "W";
  if (fwdIsHoriz) {
    const pivotRow = Math.min(src.row, tgt.row);
    return [
      { kind: "V", index: srcExitGI },
      { kind: "H", index: pivotRow },
      { kind: "V", index: tgtEntryGI },
    ];
  }
  const pivotCol = Math.min(src.col, tgt.col);
  return [
    { kind: "H", index: srcExitGI },
    { kind: "V", index: pivotCol },
    { kind: "H", index: tgtEntryGI },
  ];
}

/**
 * Index of the gutter corridor immediately outside cell on the given
 * side. Returns V indices for E/W sides, H indices for N/S sides.
 *
 *   West face of (r, c) → V(c)        (the gutter just west of col c)
 *   East face of (r, c) → V(c + 1)    (just east of col c)
 *   North face         → H(r)
 *   South face         → H(r + 1)
 */
function gutterIndex(cell: Cell, side: Direction): number {
  switch (side) {
    case "W": return cell.col;
    case "E": return cell.col + 1;
    case "N": return cell.row;
    case "S": return cell.row + 1;
  }
}

/** A horizontal or vertical corridor (excludes diagonals). */
type AxisCorridor =
  | { kind: "H"; index: number }
  | { kind: "V"; index: number };

/** Find the node id placed at the given cell, or "" if none. */
function getNodeAt(model: Model, placement: Placement, cell: Cell): string {
  for (const [id, c] of placement.cells) {
    if (c.row === cell.row && c.col === cell.col) {
      // If the node matches AND is a highway, return its name; else
      // prefer a highway name if one is at the same cell. The caller
      // (via-routing) cares about highway membership, so prioritize that.
      const node = model.nodes.find((n) => n.id === id);
      if (node && node.shape === "highway") return id;
    }
  }
  // Fallback: any node at this cell.
  for (const [id, c] of placement.cells) {
    if (c.row === cell.row && c.col === cell.col) return id;
  }
  return "";
}

/**
 * True if the highway at this cell is horizontal. Highway orientation
 * is driven by `layoutMode` (lr=horizontal, tb=vertical), not by
 * width vs height (§11.9 v2). The node lookup is retained for
 * symmetry with other helpers; only highway nodes call this.
 */
function isHorizontalCell(model: Model, placement: Placement, cell: Cell): boolean {
  void model;
  void cell;
  return placement.flowAxis === "east";
}

/**
 * The corridor immediately outside `cell` on the given side. For E/W
 * sides the corridor is vertical; for N/S sides it's horizontal. The
 * return type is narrowed to exclude the diagonal `Corridor` variant —
 * the path search (§11.8) is Manhattan-only and never reaches D corridors.
 */
function gutterCorridor(cell: Cell, side: Direction): AxisCorridor {
  const index = gutterIndex(cell, side);
  if (side === "E" || side === "W") return { kind: "V", index };
  return { kind: "H", index };
}

// --- 2b. path-search router (§11.8) ---------------------------------------

/**
 * Compute the union of corridors traversed by the avoided edges'
 * provisional routes (DESIGN-PHASE4.md §11.8). The result is the
 * "blocked set" passed to `searchCorridorPath` for the new edge's
 * route. Self-exemption (don't block src-exit and tgt-entry) is applied
 * inside the search, not here, so the set returned is the literal
 * union of the avoided edges' corridors.
 */
function computeBlockedCorridors(
  avoidEdgeIndices: number[],
  provisionalSeqs: Corridor[][],
): Set<string> {
  const blocked = new Set<string>();
  for (const i of avoidEdgeIndices) {
    const seq = provisionalSeqs[i];
    if (seq === undefined) continue;
    for (const c of seq) blocked.add(corridorKey(c));
  }
  return blocked;
}

/**
 * Dijkstra over the corridor graph (DESIGN-PHASE4.md §11.8).
 *
 * Graph shape:
 *   Nodes: each grid intersection (r, c) appears twice — once as
 *     "arrived via H(r)" and once as "arrived via V(c)". This is the
 *     touching-vs-traversing trick: visiting an intersection via one
 *     corridor doesn't imply having traversed the other.
 *
 *   Edges:
 *     - Traversal: same corridor, different intersection on the
 *       perpendicular axis. Cost = bend penalty `BEND` for each cell
 *       of distance traversed. (Cells are uniform in the corridor
 *       graph; demand-weighting can be added later.) Removed if the
 *       corridor is in the `blocked` set AND not in the `exempt` set.
 *     - Turn: at one intersection, switch from H to V (or V to H).
 *       Cost = `BEND`. Crossing only — does not traverse either
 *       corridor along its length.
 *
 * The source-exit and target-entry corridors are self-exempt — even if
 * an avoided edge would block them, the new edge can still traverse
 * them so it can leave the source and enter the target.
 *
 * `srcIxn` / `tgtIxn` are the (rowIxn, colIxn) intersection coordinates
 * where the source and target connect to their exit/entry corridors:
 *   - srcExitCorridor is the gutter adjacent to the source's exit face.
 *   - srcIxn.colIxn is the column-side of that gutter's intersection
 *     with the source's row corridor; srcIxn.rowIxn is the source's row.
 *   For a source cell (r, c) exiting E (gutter V(c+1)):
 *     srcIxn = { rowIxn: r, colIxn: c + 1 }  // sits at H(r) ∩ V(c+1)
 *
 * Returns the corridor sequence (a list of distinct corridors visited
 * in order, with consecutive duplicates collapsed). Returns null if no
 * path exists under the blocks.
 */
function searchCorridorPath(
  placement: Placement,
  src: Cell,
  tgt: Cell,
  srcExitDir: Direction,
  tgtEntryDir: Direction,
  blocked: Set<string>,
): Corridor[] | null {
  const srcExitCorridor = gutterCorridor(src, srcExitDir);
  const tgtEntryCorridor = gutterCorridor(tgt, tgtEntryDir);

  // Self-exemption: src-exit and tgt-entry are never blocked.
  const exempt = new Set<string>([
    corridorKey(srcExitCorridor),
    corridorKey(tgtEntryCorridor),
  ]);
  const isBlocked = (c: AxisCorridor): boolean => {
    const k = corridorKey(c);
    return blocked.has(k) && !exempt.has(k);
  };

  // Intersection grid bounds. Intersections live at (rowIdx, colIdx)
  // for rowIdx ∈ [0, nRows], colIdx ∈ [0, nCols] — i.e., the grid
  // corners between cells.
  const nRows = placement.rowUnits.length;
  const nCols = placement.colUnits.length;

  // Per-intersection entry corridors. For each (rowIdx, colIdx), an
  // arrival "via H(rowIdx)" is distinct from "via V(colIdx)". Encode as
  // nodeId = "<H|V><cor.index>@<rowIdx>,<colIdx>".
  const nodeId = (corridor: AxisCorridor, rowIxn: number, colIxn: number) =>
    `${corridorKey(corridor)}@${rowIxn},${colIxn}`;

  // BEND dominates traversal cost — fewest-bends wins ties on length.
  const BEND = 100;

  const dist = new Map<string, number>();
  const prev = new Map<string, string | undefined>();
  const prevCorridorSeq = new Map<string, AxisCorridor[]>();
  const open: { id: string; d: number; corridor: AxisCorridor; rowIxn: number; colIxn: number }[] = [];

  // Lexicographic-tiebreak min-pop (linear scan; graph is small).
  const popMin = () => {
    if (open.length === 0) return undefined;
    let minIdx = 0;
    for (let i = 1; i < open.length; i++) {
      const oi = open[i]!;
      const om = open[minIdx]!;
      if (oi.d < om.d || (oi.d === om.d && oi.id < om.id)) minIdx = i;
    }
    return open.splice(minIdx, 1)[0];
  };

  const relax = (
    id: string,
    d: number,
    fromId: string | undefined,
    corridor: AxisCorridor,
    rowIxn: number,
    colIxn: number,
    parentSeq: AxisCorridor[],
  ) => {
    const existing = dist.get(id);
    if (existing !== undefined && existing <= d) return;
    dist.set(id, d);
    prev.set(id, fromId);
    // Maintain the corridor sequence by appending if we entered a
    // different corridor than the parent's last entry.
    const last = parentSeq[parentSeq.length - 1];
    const newSeq = (last && corridorKey(last) === corridorKey(corridor))
      ? parentSeq
      : [...parentSeq, corridor];
    prevCorridorSeq.set(id, newSeq);
    open.push({ id, d, corridor, rowIxn, colIxn });
  };

  // Source intersection: where srcExitCorridor meets the source cell's
  // perpendicular axis.
  // For E/W exit (V corridor): rowIxn = src.row, colIxn = gutterIndex
  //   (already the V's index).
  // For N/S exit (H corridor): colIxn = src.col, rowIxn = gutterIndex.
  let srcRowIxn: number;
  let srcColIxn: number;
  if (srcExitDir === "E" || srcExitDir === "W") {
    srcRowIxn = src.row;
    srcColIxn = srcExitCorridor.index;
  } else {
    srcRowIxn = srcExitCorridor.index;
    srcColIxn = src.col;
  }
  let tgtRowIxn: number;
  let tgtColIxn: number;
  if (tgtEntryDir === "E" || tgtEntryDir === "W") {
    tgtRowIxn = tgt.row;
    tgtColIxn = tgtEntryCorridor.index;
  } else {
    tgtRowIxn = tgtEntryCorridor.index;
    tgtColIxn = tgt.col;
  }

  const srcId = nodeId(srcExitCorridor, srcRowIxn, srcColIxn);
  relax(srcId, 0, undefined, srcExitCorridor, srcRowIxn, srcColIxn, [srcExitCorridor]);

  const tgtId = nodeId(tgtEntryCorridor, tgtRowIxn, tgtColIxn);

  while (open.length > 0) {
    const cur = popMin()!;
    if (cur.d > (dist.get(cur.id) ?? Infinity)) continue;
    if (cur.id === tgtId) {
      // Done.
      return prevCorridorSeq.get(cur.id) ?? [cur.corridor];
    }
    const parentSeq = prevCorridorSeq.get(cur.id) ?? [cur.corridor];
    const cur_corridor = cur.corridor;

    // 1) Traversal along the current corridor to other intersections.
    //    Cost = 1 per cell of traversal. BEND (much larger) is reserved
    //    for the turn edges below, so the search minimizes bends first
    //    and total length second.
    if (!isBlocked(cur_corridor)) {
      if (cur_corridor.kind === "H") {
        // H corridor traversal: vary colIxn from 0..nCols.
        for (let c2 = 0; c2 <= nCols; c2++) {
          if (c2 === cur.colIxn) continue;
          const cost = Math.abs(c2 - cur.colIxn);
          const id = nodeId(cur_corridor, cur.rowIxn, c2);
          relax(id, cur.d + cost, cur.id, cur_corridor, cur.rowIxn, c2, parentSeq);
        }
      } else {
        // V corridor traversal: vary rowIxn from 0..nRows.
        for (let r2 = 0; r2 <= nRows; r2++) {
          if (r2 === cur.rowIxn) continue;
          const cost = Math.abs(r2 - cur.rowIxn);
          const id = nodeId(cur_corridor, r2, cur.colIxn);
          relax(id, cur.d + cost, cur.id, cur_corridor, r2, cur.colIxn, parentSeq);
        }
      }
    }

    // 2) Turn: switch corridor at the same intersection.
    // If cur is H, we can switch to V at colIxn (the V corridor at this
    // intersection). Vice versa.
    if (cur_corridor.kind === "H") {
      const next: AxisCorridor = { kind: "V", index: cur.colIxn };
      const id = nodeId(next, cur.rowIxn, cur.colIxn);
      relax(id, cur.d + BEND, cur.id, next, cur.rowIxn, cur.colIxn, parentSeq);
    } else {
      const next: AxisCorridor = { kind: "H", index: cur.rowIxn };
      const id = nodeId(next, cur.rowIxn, cur.colIxn);
      relax(id, cur.d + BEND, cur.id, next, cur.rowIxn, cur.colIxn, parentSeq);
    }
  }

  return null;
}

/**
 * Slot-key identifies one trace endpoint on one box side. The endpoint
 * field disambiguates self-loops where the same edge index hits the
 * same node twice. (Phase 4 has no self-loops yet but the key shape
 * accommodates them without surprise.)
 */
function slotKey(
  nodeId: string,
  side: Side,
  edgeIndex: number,
  endpoint: "from" | "to",
): string {
  return `${nodeId}|${side}|${edgeIndex}|${endpoint}`;
}

/**
 * Assign every trace endpoint a slot index on its box side. The order
 * within a side follows §3.5:
 *
 *   1. Traces on the same side are grouped by destination corridor —
 *      i.e., the *adjacent* corridor on the trace's other end. For
 *      east-side exits in an LR diagram, group by the row gutter the
 *      trace will pivot through.
 *   2. Within a group, edges are ordered by their declaration index
 *      (the index into Model.edges).
 *   3. Across groups, sort by the group's perpendicular coord
 *      ascending — for E/W sides that's the pivot row index; for N/S
 *      sides that's the pivot column index. Same-corridor (no pivot
 *      needed) traces sort against the source's own row/col.
 *
 * The result is a stable, deterministic packing: a bus's eight
 * producers reach `shared`'s W face in declaration order on consecutive
 * slots.
 *
 * Raises E_SIDE_OVERSUBSCRIBED if any side's demand exceeds its
 * capacity (= `TRACES_PER_CELL_UNIT + 1` slots per cell-unit of the
 * side's length, with one tooth at each end as margin).
 */
function assignSlots(
  model: Model,
  placement: Placement,
  routes: Omit<Route, "sourceSlot" | "targetSlot">[],
): Map<string, number> {
  // Bucket: (nodeId, side) -> list of pending slot allocations.
  //
  // `oppositePerp` is the perpendicular cell coord of the *other* endpoint
  // — used as the primary sort key so that fan traces on a single face
  // line up in spatial order of where they're going, not in declaration
  // order (which would invert under isometric rotation). For an E/W face
  // the perpendicular axis is rows; for N/S it's cols.
  //
  // `pivotCoord` is retained as a secondary key for the (legacy, rarely
  // triggered) cases where two routes share the same opposite-endpoint
  // perp — typically a multi-corridor route that pivots through some
  // intermediate H/V corridor.
  type Pending = {
    edgeIndex: number;
    endpoint: "from" | "to";
    oppositePerp: number;
    /**
     * Via-half-only refinement: perp of the EVENTUAL endpoint (the
     * non-highway endpoint on the OTHER half). Used as a secondary
     * sort key so single-bundle traces order by spatial target instead
     * of declaration order. For non-via edges this equals
     * `oppositePerp` (no effect).
     */
    eventualPerp: number;
    pivotCoord: number;
    /** True if the edge is a back-edge (wraps through page margin). */
    isBack: boolean;
  };
  const bySide = new Map<string, Pending[]>();

  // §11.9: for via-half edges the local target/source is the highway
  // node, which is the same across all sibling via-halves. Sorting by
  // perpOf(side, hwyCell) collapses them and falls back to declaration
  // order, which loses spatial ordering of the eventual endpoints. Build
  // a lookup of paired via-halves so we can use the EVENTUAL endpoint's
  // cell for slot ordering on the source-side (first-half) and target-
  // side (second-half) faces.
  const viaPairs = new Map<number, { firstIdx: number; secondIdx: number }>();
  for (let i = 0; i < model.edges.length; i++) {
    const e = model.edges[i]!;
    if (e.source !== "via-half" || e.viaOriginal === undefined) continue;
    const existing = viaPairs.get(e.viaOriginal) ?? { firstIdx: -1, secondIdx: -1 };
    if (e.viaFirstHalf) existing.firstIdx = i;
    else existing.secondIdx = i;
    viaPairs.set(e.viaOriginal, existing);
  }

  for (const r of routes) {
    const edge = model.edges[r.edgeIndex]!;
    const srcCell = placement.cells.get(edge.from)!;
    const tgtCell = placement.cells.get(edge.to)!;
    const srcKey = `${edge.from}|${r.sourceSide}`;
    const tgtKey = `${edge.to}|${r.targetSide}`;
    const isBack = !!edge.isBackEdge;
    if (!bySide.has(srcKey)) bySide.set(srcKey, []);
    if (!bySide.has(tgtKey)) bySide.set(tgtKey, []);
    // On a vertical face (E/W) the slot order should follow rows
    // (perpendicular = north-south axis); on a horizontal face (N/S),
    // cols. Read the perpendicular coord of the *opposite* endpoint:
    // for the source's E face, that's the target's row; for the target's
    // W face, that's the source's row; etc.
    //
    const srcOppositePerp = perpOf(r.sourceSide, tgtCell);
    const tgtOppositePerp = perpOf(r.targetSide, srcCell);
    // §11.9 refinement: for via-half edges, compute a SECONDARY sort
    // key based on the EVENTUAL endpoint's perp. The primary key
    // (oppositePerp) already separates bundles by source/target cell,
    // preserving the §11.9 bundle-coherence rule. Within a bundle
    // (siblings sharing the same oppositePerp), the secondary key
    // breaks the tie spatially instead of by declaration order — so
    // a single source with traces to multiple targets has its exit
    // slots ordered by where those targets sit (e.g. example 28).
    let srcEventualPerp = srcOppositePerp;
    let tgtEventualPerp = tgtOppositePerp;
    if (edge.source === "via-half" && edge.viaOriginal !== undefined) {
      const pair = viaPairs.get(edge.viaOriginal);
      if (pair) {
        if (edge.viaFirstHalf && pair.secondIdx >= 0) {
          const second = model.edges[pair.secondIdx]!;
          const eventualTgt = placement.cells.get(second.to);
          if (eventualTgt) {
            srcEventualPerp = perpOf(r.sourceSide, eventualTgt);
            tgtEventualPerp = perpOf(r.targetSide, eventualTgt);
          }
        } else if (!edge.viaFirstHalf && pair.firstIdx >= 0) {
          const first = model.edges[pair.firstIdx]!;
          const eventualSrc = placement.cells.get(first.from);
          if (eventualSrc) {
            srcEventualPerp = perpOf(r.sourceSide, eventualSrc);
            tgtEventualPerp = perpOf(r.targetSide, eventualSrc);
          }
        }
      }
    }
    bySide.get(srcKey)!.push({
      edgeIndex: r.edgeIndex,
      endpoint: "from",
      oppositePerp: srcOppositePerp,
      eventualPerp: srcEventualPerp,
      pivotCoord: pivotCoordOf(r.sourceSide, r.corridorSequence, srcCell),
      isBack,
    });
    bySide.get(tgtKey)!.push({
      edgeIndex: r.edgeIndex,
      endpoint: "to",
      oppositePerp: tgtOppositePerp,
      eventualPerp: tgtEventualPerp,
      pivotCoord: pivotCoordOf(r.targetSide, r.corridorSequence, tgtCell),
      isBack,
    });
    // Via-routed edges don't claim slots on the highway's faces — the
    // polyline emitter computes the entry/exit positions directly from
    // the source/target slot pixels (§11.9 v2). The highway's faces
    // therefore see no demand; only the source/target nodes do.
  }

  // Compute each node's side capacity in slots.
  const sizeOf = new Map(model.nodes.map((n) => [n.id, n.size]));
  const slots = new Map<string, number>();

  // Slot positions per cell-unit of side length: floor(CELL_PX / COMB_PITCH).
  // At defaults that's 4 — but only TRACES_PER_CELL_UNIT = 3 of them are
  // usable as traces (one margin tooth per cell). Slot indices in this
  // pass range over the full 4-per-cell grid; the +1 reserve ensures
  // there's always a margin slot below the bottom-most trace.
  const SLOTS_PER_CELL = Math.floor(CELL_PX / COMB_PITCH);
  for (const [key, pending] of bySide) {
    const [nodeId, side] = key.split("|") as [string, Side];
    const sz = sizeOf.get(nodeId) ?? { width: 1, height: 1 };
    const sideLen = side === "E" || side === "W" ? sz.height : sz.width;
    // Capacity: `TRACES_PER_CELL_UNIT` traces per cell-unit. At
    // defaults that's 3 per cell. A 2-tall E-face holds 6.
    const capacity = sideLen * TRACES_PER_CELL_UNIT;
    if (pending.length > capacity) {
      throw new CorridorError(
        `E_SIDE_OVERSUBSCRIBED: node '${nodeId}' has ${pending.length} ` +
          `traces on its ${side} face but capacity is ${capacity} ` +
          `(side length ${sideLen} cell-units × ${TRACES_PER_CELL_UNIT} traces). ` +
          `Increase 'size' (e.g. ${sz.width}x${sz.height + 1} for E/W or ` +
          `${sz.width + 1}x${sz.height} for N/S), split the node, or rebalance edges.`,
      );
    }
    // Sort:
    //   1. oppositePerp ascending — spatial order of the other endpoint
    //      on the perpendicular axis. This is the primary key because
    //      it minimises crossings: a fan whose targets sit in increasing
    //      perp order should leave the source face in the same order.
    //      Under isometric rotation it auto-flips with the page.
    //   2. eventualPerp ascending — for via-half edges only (= oppositePerp
    //      for non-via). Breaks ties between siblings within the same
    //      bundle by their EVENTUAL endpoint's perp instead of declaration
    //      order. Preserves §11.9 bundle coherence (siblings share an
    //      oppositePerp from the highway node and stay grouped) while
    //      fixing per-bundle ordering in the single-source case.
    //   3. pivotCoord ascending — for multi-corridor routes that share
    //      an opposite-perp value (rare).
    //   4. edgeIndex — final declaration-order tiebreak.
    //
    // §11.12: a node tagged `slot-order: declaration` forces declaration
    // order on OUTGOING (endpoint = "from") entries. Incoming (endpoint
    // = "to") entries keep the default sort. Mixed buckets sort by
    // declaration order for from-entries and by default for to-entries
    // — implemented by checking `endpoint` inside the comparator.
    const node = model.nodes.find((n) => n.id === nodeId);
    const declarationOrderOutgoing = node?.slotOrder === "declaration";
    const sortKey = (a: Pending, b: Pending) => {
      if (declarationOrderOutgoing && a.endpoint === "from" && b.endpoint === "from") {
        return a.edgeIndex - b.edgeIndex;
      }
      if (a.oppositePerp !== b.oppositePerp) return a.oppositePerp - b.oppositePerp;
      if (a.eventualPerp !== b.eventualPerp) return a.eventualPerp - b.eventualPerp;
      if (a.pivotCoord !== b.pivotCoord) return a.pivotCoord - b.pivotCoord;
      return a.edgeIndex - b.edgeIndex;
    };

    // Segregate back-edges from forwards. Back-edges wrap through page
    // margins (under LR, currently always the page-top corridor H0)
    // so their face slot should be at the OUTERMOST end of the
    // centered cluster — at the TOP for north-wrap.
    const backs = pending.filter((p) => p.isBack).sort(sortKey);
    const forwards = pending.filter((p) => !p.isBack).sort(sortKey);

    // Slot allocation strategy: forwards take the centered cluster;
    // backs take the OUTER slots (above the cluster for north-wrap).
    //
    // The forward cluster is centered on the face midpoint
    // INDEPENDENTLY of how many backs are present. This is what lets
    // a same-row trace land at the same y on both endpoints even when
    // those endpoints have different counts of backs on their faces:
    //
    //   Example: face X has [1 forward, 1 back]; face Y has [1 forward].
    //   Forwards cluster on both: slot 1.5 (1-cell face midpoint).
    //   Back on face X: slot 0.5 (above the forward).
    //
    // For F forwards in slotPositions, the cluster sits at slots
    //   (slotPositions - F) / 2 .. (slotPositions + F) / 2 - 1
    // (fractional). Back-norths fill slots above the cluster.
    //
    // Slot positions per cell-unit of side length: floor(CELL_PX /
    // COMB_PITCH). At defaults that's 4 — but only TRACES_PER_CELL_UNIT
    // = 3 of them are usable. Slot indices in this pass are fractional
    // (slot 1.5 lands at y = 1.5 * COMB_PITCH + COMB_PITCH/2 = 16,
    // exact face midpoint for a 1-cell face).
    const slotPositions = sideLen * SLOTS_PER_CELL;
    const F = forwards.length;
    const forwardClusterStart = (slotPositions - F) / 2;
    forwards.forEach((p, k) => {
      slots.set(
        slotKey(nodeId, side, p.edgeIndex, p.endpoint),
        forwardClusterStart + k,
      );
    });
    // North-wrap backs fill slots ABOVE the forward cluster.
    // backs[0] (lowest pivot) gets the slot just above forwards;
    // earlier-pivot backs progress further up.
    backs.forEach((p, k) => {
      slots.set(
        slotKey(nodeId, side, p.edgeIndex, p.endpoint),
        forwardClusterStart - 1 - k,
      );
    });
  }
  // Highway through-traces must run straight: the second-half edge's
  // entry slot on the highway's exit face is forced to mirror its
  // sibling first-half edge's exit slot on the entry face. The
  // post-highway gutter then handles the y-shuffle to reach actual
  // targets. The bend never happens inside the highway box.
  const firstByOriginal = new Map<number, { edgeIndex: number; hwyId: string; entrySide: Side }>();
  for (const r of routes) {
    const edge = model.edges[r.edgeIndex]!;
    if (!edge.viaFirstHalf || edge.viaOriginal === undefined) continue;
    firstByOriginal.set(edge.viaOriginal, {
      edgeIndex: r.edgeIndex,
      hwyId: edge.to,
      entrySide: r.targetSide,
    });
  }
  for (const r of routes) {
    const edge = model.edges[r.edgeIndex]!;
    if (edge.viaFirstHalf || edge.viaOriginal === undefined) continue;
    if (edge.source !== "via-half") continue;
    const first = firstByOriginal.get(edge.viaOriginal);
    if (!first) continue;
    const firstHwySlot = slots.get(slotKey(first.hwyId, first.entrySide, first.edgeIndex, "to"));
    if (firstHwySlot === undefined) continue;
    slots.set(slotKey(edge.from, r.sourceSide, r.edgeIndex, "from"), firstHwySlot);
  }
  return slots;
}

/**
 * The perpendicular cell-coord of `cell` relative to a face on the
 * other endpoint. Used to order traces on a face by where they're
 * coming from (or going to) on the perpendicular axis:
 *
 *   - E/W face → perp axis = north-south → return cell.row
 *   - N/S face → perp axis = east-west → return cell.col
 *
 * This is the primary key in the slot-ordering sort so that fan/bus
 * traces line up in spatial order, not declaration order. The
 * resulting slot order is isometric — rotating the diagram 90° rotates
 * the slot order with it, keeping fans untangled in both orientations.
 */
function perpOf(side: Side, otherEndpoint: Cell): number {
  if (side === "E" || side === "W") return otherEndpoint.row;
  return otherEndpoint.col;
}

/**
 * The pivot coord for an endpoint's slot-ordering key. For an E/W side
 * it's the row of the horizontal corridor the trace pivots through
 * (or the endpoint's own row if there is no pivot, e.g. same-row
 * routes). For an N/S side it's the column index analogously.
 *
 * Same-corridor cousin traces all share the pivot coord, so the
 * tiebreak by edgeIndex preserves declaration order — exactly what the
 * uniform-flux rule asks for.
 */
function pivotCoordOf(
  side: Side,
  seq: Corridor[],
  cell: Cell,
): number {
  if (side === "E" || side === "W") {
    for (const c of seq) if (c.kind === "H") return c.index;
    return cell.row;
  }
  for (const c of seq) if (c.kind === "V") return c.index;
  return cell.col;
}

// --- 4. demand counting and widening --------------------------------------

/**
 * Stable string form for a corridor identity. Used as the demand map's
 * key; the type alone can't be a Map key (object identity wouldn't
 * coalesce across different `corridorSequence` calls).
 */
export function corridorKey(c: Corridor): string {
  if (c.kind === "H") return `H${c.index}`;
  if (c.kind === "V") return `V${c.index}`;
  return `D${c.row},${c.col},${c.dir}`;
}

function countDemand(routes: Route[]): Map<string, number> {
  const demand = new Map<string, number>();
  for (const r of routes) {
    // Per-edge: every corridor in the sequence gets one trace.
    // Dedupe within a single route in case the sequence loops (it
    // shouldn't, but defensive code costs nothing on a Map.add).
    const seen = new Set<string>();
    for (const c of r.corridorSequence) {
      const k = corridorKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      demand.set(k, (demand.get(k) ?? 0) + 1);
    }
  }
  return demand;
}

/**
 * Compute gutter widths in cell-units. There are `nRows + 1` row
 * gutters (the north margin, the gutters between rows, the south
 * margin) and `nCols + 1` column gutters.
 *
 * Each gutter `g` absorbs the demand of the corresponding corridor:
 *
 *   gutterUnits[g] = ceil(demand(corridor) / TRACES_PER_CELL_UNIT)
 *
 * Same-row/same-col routes still need *some* gutter — a single trace
 * needs a column gutter of at least 0 cell-units (the trace fits in
 * the comb-tooth slot space without explicit widening). A 1-trace
 * demand gives `ceil(1/3) = 1` cell-unit of gutter, which at the
 * default 32-px cell is 32 px — generous, but matches the design's
 * "(d + 1) * COMB_PITCH" convention loosely once box edges are factored
 * back in. Step 6 / 8 will refine if the visual feels too sparse.
 */
function widen(
  placement: Placement,
  demand: Map<string, number>,
): { rowGutterUnits: number[]; colGutterUnits: number[] } {
  const rowGutterUnits = new Array<number>(placement.rowUnits.length + 1).fill(0);
  const colGutterUnits = new Array<number>(placement.colUnits.length + 1).fill(0);

  for (const [key, d] of demand) {
    const extra = Math.ceil(d / TRACES_PER_CELL_UNIT);
    if (extra <= 0) continue;
    if (key.startsWith("H")) {
      const r = Number(key.slice(1));
      if (r >= 0 && r < rowGutterUnits.length) {
        rowGutterUnits[r] = Math.max(rowGutterUnits[r]!, extra);
      }
    } else if (key.startsWith("V")) {
      const c = Number(key.slice(1));
      if (c >= 0 && c < colGutterUnits.length) {
        colGutterUnits[c] = Math.max(colGutterUnits[c]!, extra);
      }
    }
    // Diagonal corridors are unused at Step 5; no widening yet.
  }
  return { rowGutterUnits, colGutterUnits };
}
