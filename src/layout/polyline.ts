/**
 * Phase 4 polyline emission (Step 7).
 *
 * Inputs: a bound `Model`, the `Placement` from Step 4, the
 * `Reservation` from Step 5, and the `Packing` from Step 6.
 * Output: a `Polylines` collection — one `Polyline` per edge as a
 * sequence of pixel waypoints, plus `CrossingMarker[]` for X-junctions.
 *
 * This is the first stage that produces pixel coordinates. All
 * upstream passes work in cell-coord / ordinal-track / ordinal-slot
 * space; Step 7 multiplies through `CELL_PX` and `COMB_PITCH`.
 *
 * The translation happens in two layers:
 *
 *   1. `PixelLayout` — resolves the grid: per-col x positions,
 *      per-row y positions, box bounding rectangles, slot port
 *      positions, corridor centerlines and track offsets.
 *   2. Per-edge `buildPolyline()` — walks the corridor sequence and
 *      emits waypoints: source slot, corridor entry/exit corners,
 *      target slot. A chamfering pass replaces each 90° bend with
 *      a 45° cut of radius `COMB_PITCH / 2`.
 *
 * See DESIGN-PHASE4.md §4.4 for the full spec.
 */
import type { Model } from "../bind/model.js";
import type { Cell, Placement } from "./placement.js";
import type {
  Corridor,
  Reservation,
  Route,
  Side,
} from "./corridors.js";
import { COMB_PITCH, corridorKey } from "./corridors.js";
import type { Packing, TrackAssignment } from "./tracks.js";
import { buildModulePortIndex, type ModulePortInfo } from "./module-route.js";
import { computePixelLayout, slotPixel } from "./pixels.js";
import type { PixelLayout, Point } from "./pixels.js";

// --- public types ---------------------------------------------------------

export type { Point };

export interface Polyline {
  /** Index into `Model.edges`. */
  edgeIndex: number;
  /** Pixel waypoints in order from source slot to target slot. */
  points: Point[];
  /** Indices into the top-level `Polylines.crossings` list. */
  crossingIndices: number[];
}

export interface CrossingMarker {
  corridor: string;
  x: number;
  y: number;
  edgeIndexA: number;
  edgeIndexB: number;
}

export interface Polylines {
  polylines: Polyline[];
  crossings: CrossingMarker[];
  /** Diagram extent in pixels (max x and y across all box bounding boxes). */
  width: number;
  height: number;
}

export class PolylineError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// --- entry point ----------------------------------------------------------

/**
 * Pure function from (Model, Placement, Reservation, Packing) →
 * Polylines. Deterministic: same inputs produce identical pixel
 * waypoints byte-for-byte.
 */
export function buildPolylines(
  model: Model,
  placement: Placement,
  reservation: Reservation,
  packing: Packing,
): Polylines {
  const layout = computePixelLayout(placement, reservation);

  // DESIGN-PHASE5-MODULES.md §4.1, §4.2 — module-internal port pixel
  // positions are needed for any edge with `fromInternal` /
  // `toInternal` set, so the polyline lands on the actual internal node
  // instead of the synthetic module cell's face center. Empty map when
  // the model has no imports.
  const modulePortIndex = buildModulePortIndex(model, placement, reservation);

  // Map edge index → its track assignments by corridor for quick lookup.
  const trackByEdgeAndCorridor = new Map<string, TrackAssignment>();
  for (const t of packing.tracks) {
    trackByEdgeAndCorridor.set(`${t.edgeIndex}|${t.corridor}`, t);
  }

  // DESIGN-PHASE5-MODULES.md §4.6 (extended) — when multiple qualified-
  // ref edges enter (or leave) the same internal node on the same face,
  // they all want the same face midpoint and pile on a single point.
  // Pre-compute a fan-out map keyed by (parentId|internalName|side) →
  // ordered list of edge indices, so each edge knows its rank among its
  // siblings and the port resolver can offset slot positions along the
  // face by COMB_PITCH. Order is `model.edges` declaration order, per
  // the "declaration order is respected" rule.
  const internalFanoutBuckets = buildInternalFanoutBuckets(model, reservation);
  const internalFanoutRank = new Map<string, { rank: number; total: number }>();
  for (const bucket of internalFanoutBuckets.values()) {
    const total = bucket.length;
    for (let i = 0; i < bucket.length; i++) {
      internalFanoutRank.set(
        `${bucket[i]!.edgeIndex}|${bucket[i]!.endpoint}`,
        { rank: i, total },
      );
    }
  }

  // Face-to-face fan-in counts: how many module edges (no qualified
  // ref) share a (parentModuleId, side) target. With exactly one edge
  // on a face, the snap defaults to `facePorts[side][0]` (the closest
  // candidate to that face by construction). That's stable under body
  // shifts — the candidate ordering is based on the internal node's
  // local x/y position, which doesn't change when we shift the module
  // body inside its synthetic cell. With multiple edges, the existing
  // axis-snap spreads them across distinct candidates.
  const faceToFaceCount = new Map<string, number>();
  for (const r of reservation.routes) {
    const edge = model.edges[r.edgeIndex];
    if (edge === undefined) continue;
    const fromIsModule = modulePortIndex.has(edge.from);
    const toIsModule = modulePortIndex.has(edge.to);
    if (fromIsModule && edge.fromInternal === undefined) {
      const key = `${edge.from}|${r.sourceSide}`;
      faceToFaceCount.set(key, (faceToFaceCount.get(key) ?? 0) + 1);
    }
    if (toIsModule && edge.toInternal === undefined) {
      const key = `${edge.to}|${r.targetSide}`;
      faceToFaceCount.set(key, (faceToFaceCount.get(key) ?? 0) + 1);
    }
  }

  // Build orthogonal polylines first; X-junction materialisation
  // happens as a coordinated post-pass over pairs of routes.
  const orthogonalByEdge = new Map<number, Point[]>();
  for (const route of reservation.routes) {
    orthogonalByEdge.set(
      route.edgeIndex,
      buildOrthogonalPolyline(
        route,
        layout,
        placement,
        model,
        trackByEdgeAndCorridor,
        modulePortIndex,
        internalFanoutRank,
        faceToFaceCount,
      ),
    );
  }

  // X-junction materialisation. For each opposite-direction pair of
  // traces with swapped endpoints in the same corridor, rewrite both
  // polylines so they share two tracks (the lower and upper) in
  // SWAPPED roles: trace A uses lower-track on its entry side and
  // upper-track on its exit side; trace B does the opposite. At the
  // corridor midpoint, each trace has a single 45° diagonal segment
  // connecting its two tracks. The two diagonals cross at the
  // corridor centre, forming a clean X with no segment overlap on
  // verticals, horizontals, or the swap itself.
  //
  // This satisfies §4.2's "use diagonals when they yield strictly
  // fewer bends": the orthogonal alternative has 4 bends and produces
  // unavoidable segment overlap; the swap has 4 bends per trace too
  // but eliminates the overlap.
  const xPairs = findXPairs(
    reservation,
    trackByEdgeAndCorridor,
    orthogonalByEdge,
    layout,
  );
  for (const pair of xPairs) {
    const rewritten = applyXSwap(
      orthogonalByEdge.get(pair.edgeIndexA)!,
      orthogonalByEdge.get(pair.edgeIndexB)!,
      pair,
      layout,
    );
    orthogonalByEdge.set(pair.edgeIndexA, rewritten.a);
    orthogonalByEdge.set(pair.edgeIndexB, rewritten.b);
  }
  void packing;

  // Chamfer each polyline.
  const polylines: Polyline[] = [];
  for (const route of reservation.routes) {
    const ortho = orthogonalByEdge.get(route.edgeIndex)!;
    const chamfered = chamferBends(ortho);
    polylines.push({
      edgeIndex: route.edgeIndex,
      points: chamfered,
      crossingIndices: [],
    });
  }

  // Build crossing markers, then back-reference into polylines.
  const crossings: CrossingMarker[] = [];
  for (const c of packing.crossings) {
    const marker = buildCrossingMarker(c, packing, layout, trackByEdgeAndCorridor);
    crossings.push(marker);
  }
  // Back-reference: for each crossing index, push it into both
  // polylines' crossingIndices.
  for (let i = 0; i < crossings.length; i++) {
    const cm = crossings[i]!;
    for (const p of polylines) {
      if (p.edgeIndex === cm.edgeIndexA || p.edgeIndex === cm.edgeIndexB) {
        p.crossingIndices.push(i);
      }
    }
  }

  return {
    polylines,
    crossings,
    width: layout.totalWidth,
    height: layout.totalHeight,
  };
}

/**
 * Group qualified-ref endpoints by (parentModuleId, internalNodeName,
 * face) so multiple traces landing on the same internal node face can
 * be spread along the face instead of piling onto one point.
 *
 * Returns a map keyed by `parentId|internalName|side` whose value is
 * the ordered list of (edgeIndex, endpoint) pairs sharing that target,
 * in `model.edges` declaration order. The polyline builder uses each
 * edge's rank in its bucket to offset its slot position along the face.
 */
function buildInternalFanoutBuckets(
  model: Model,
  reservation: Reservation,
): Map<string, { edgeIndex: number; endpoint: "from" | "to" }[]> {
  const buckets = new Map<
    string,
    { edgeIndex: number; endpoint: "from" | "to" }[]
  >();
  const routeByEdge = new Map<number, Route>();
  for (const r of reservation.routes) routeByEdge.set(r.edgeIndex, r);
  for (let i = 0; i < model.edges.length; i++) {
    const edge = model.edges[i]!;
    const route = routeByEdge.get(i);
    if (route === undefined) continue;
    if (edge.fromInternal !== undefined) {
      const key = `${edge.from}|${edge.fromInternal}|${route.sourceSide}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push({ edgeIndex: i, endpoint: "from" });
    }
    if (edge.toInternal !== undefined) {
      const key = `${edge.to}|${edge.toInternal}|${route.targetSide}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push({ edgeIndex: i, endpoint: "to" });
    }
  }
  return buckets;
}

// --- 1. pixel layout (moved to ./pixels.ts) -------------------------------

/**
 * Pixel position of a track inside a corridor.
 *
 * Each track sits at one comb-pitch offset from the previous, packed
 * from the corridor's "near edge" inward. For an H corridor (long
 * axis = east-west) sitting in the row gutter between rows r-1 and r,
 * tracks pack downward from the top of the gutter:
 *
 *   trackY(H(r), t) = gutterTop + t * COMB_PITCH
 *
 * For a V corridor in the col gutter between cols c-1 and c, tracks
 * pack from the left:
 *
 *   trackX(V(c), t) = gutterLeft + t * COMB_PITCH
 *
 * Returns the *track's perp coord* (y for H, x for V); the long-axis
 * coord is determined separately by where in the corridor the trace
 * is being sampled.
 */
function trackPerpCoord(
  corridor: Corridor,
  track: number,
  layout: PixelLayout,
): number {
  if (corridor.kind === "H") {
    // Gutter is rowGutter[corridor.index]; sits between row index-1 and index.
    // Its top y is rowY[index-1] + rowHeightPx[index-1] for index >= 1.
    // For index = 0 (north margin), top y is 0.
    const gutterTop =
      corridor.index === 0
        ? 0
        : layout.rowY[corridor.index - 1]! +
          layout.rowHeightPx[corridor.index - 1]!;
    return gutterTop + track * COMB_PITCH;
  }
  if (corridor.kind === "V") {
    const gutterLeft =
      corridor.index === 0
        ? 0
        : layout.colX[corridor.index - 1]! +
          layout.colWidthPx[corridor.index - 1]!;
    return gutterLeft + track * COMB_PITCH;
  }
  throw new PolylineError("internal: diagonal corridors not yet supported");
}

// --- 2. orthogonal polyline emission --------------------------------------

/**
 * Emit the raw orthogonal polyline for a route. This produces a
 * sequence of `(x, y)` waypoints with right-angle bends at corridor
 * intersections. Chamfering happens as a separate pass.
 *
 * The algorithm:
 *
 *   1. Start at the source slot pixel.
 *   2. For each corridor in the sequence:
 *      - Compute the trace's track perp coord in that corridor.
 *      - The trace must cross from its current perp coord to the
 *        track's perp coord (or stay if already aligned). This
 *        produces 0–2 waypoints depending on whether the current
 *        and target perp coords differ.
 *      - The trace then proceeds along the corridor's long axis to
 *        the next corridor's intersection (or to the target slot).
 *   3. End at the target slot pixel.
 *
 * For same-row routes (single V corridor, perp=x, long=y, trace
 * crosses perpendicular to the corridor's long axis): the trace
 * enters at sourceSlot's y and exits at targetSlot's y, possibly with
 * a y-jog inside the corridor if the slot y's differ. Track index
 * matters only if the trace runs *along* the corridor's long axis;
 * for cross-corridor traces, the track is moot.
 *
 * This implementation handles the common Step 5 sequences:
 *   - Same-row LR: [V] (single corridor, horizontal cross)
 *   - Same-col TB: [H] (single corridor, vertical cross)
 *   - Adjacent-diagonal LR: [V] (single corridor, contains a y-jog
 *     to reach the target slot at the next row)
 *   - Multi-col diagonal: [V, H, V] (real corridor-following traffic)
 *   - Back-edges: [V, H, V] (with H = page margin, wraps around)
 */
/**
 * DESIGN-PHASE5-MODULES.md §4.1, §4.5, §4.7 — resolve a polyline's
 * source or target pixel.
 *
 *   - Qualified module ref (`alias.internal`): pixel is the internal
 *     node's translated centroid (so the trace lands on that specific
 *     node).
 *   - Face-to-face module ref (`alias`, no internal): the slot
 *     allocator assigns each edge a slot along the synthetic cell's
 *     face. We compute the slot's intended pixel via `fallback()`,
 *     then snap it to the closest face port candidate (each at a
 *     visible internal node's matching face midpoint). Multiple
 *     incoming edges with different slots naturally distribute across
 *     distinct candidates by proximity. A single edge centers and
 *     snaps to the closest candidate.
 *   - Non-module endpoint: pixel is the synthetic cell's slot pixel
 *     computed by `fallback()`.
 */
function portPointFor(
  parentId: string,
  internalName: string | undefined,
  side: "N" | "S" | "E" | "W",
  fallback: () => Point,
  modulePortIndex: Map<string, ModulePortInfo>,
  fanout?: { rank: number; total: number },
  faceShareCount: number = 0,
): Point {
  const info = modulePortIndex.get(parentId);
  if (info === undefined) return fallback();
  if (internalName !== undefined) {
    const port = info.ports.get(internalName);
    if (port === undefined) return fallback();
    // §4.6 (extended) — land on the internal node's face midpoint on the
    // side the route enters/leaves, not the centroid. That way a trace
    // entering from above clearly terminates at the top of the internal
    // node instead of disappearing into its body. When multiple traces
    // hit the same face, spread them along the face by COMB_PITCH steps
    // centered on the face midpoint.
    const halfW = port.localWidth / 2;
    const halfH = port.localHeight / 2;
    const rank = fanout?.rank ?? 0;
    const total = fanout?.total ?? 1;
    // Offset along the face axis: for N/S the axis is x; for E/W it's y.
    // Centered spread: rank k of n traces sits at (k - (n-1)/2) * pitch.
    const offset = (rank - (total - 1) / 2) * COMB_PITCH;
    // Clamp the offset so spread stays inside the node's face. Leave a
    // half-pitch margin so the entry doesn't land on the corner.
    const halfAxis = side === "N" || side === "S" ? halfW : halfH;
    const margin = COMB_PITCH / 2;
    const limit = Math.max(0, halfAxis - margin);
    const clamped = Math.max(-limit, Math.min(limit, offset));
    let x = info.originX + port.localX;
    let y = info.originY + port.localY;
    switch (side) {
      case "N":
        x += clamped;
        y -= halfH;
        break;
      case "S":
        x += clamped;
        y += halfH;
        break;
      case "W":
        x -= halfW;
        y += clamped;
        break;
      case "E":
        x += halfW;
        y += clamped;
        break;
    }
    return { x, y };
  }
  // Face-to-face: pick a face-port candidate at a visible internal
  // node's matching face midpoint. The candidates list is sorted such
  // that index 0 is the closest internal node to the face (sort key:
  // perpendicular distance to the face, tie-break by axis position).
  //
  // Single edge on this (parentId, side) → use [0]. The pick is then
  // stable under module body shifts (alignment), because the sort key
  // depends only on the internal node's local position inside the
  // module, not on where the module sits in the parent grid.
  //
  // Multiple edges on the same face → axis-snap by slot pixel so the
  // edges spread across distinct internal-node face midpoints in
  // spatial order matching the slot allocator. Snap by proximity along
  // the face axis: for E/W match by y; for N/S match by x.
  const candidates = info.facePorts[side];
  if (candidates.length === 0) return fallback();
  let pick: { localX: number; localY: number };
  if (faceShareCount <= 1) {
    pick = candidates[0]!;
  } else {
    const slotPx = fallback();
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const cx = info.originX + c.localX;
      const cy = info.originY + c.localY;
      const d = side === "E" || side === "W"
        ? Math.abs(slotPx.y - cy)
        : Math.abs(slotPx.x - cx);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    pick = candidates[bestIdx]!;
  }
  return { x: info.originX + pick.localX, y: info.originY + pick.localY };
}

function buildOrthogonalPolyline(
  route: Route,
  layout: PixelLayout,
  placement: Placement,
  model: Model,
  trackLookup: Map<string, TrackAssignment>,
  modulePortIndex: Map<string, ModulePortInfo>,
  internalFanoutRank: Map<string, { rank: number; total: number }>,
  faceToFaceCount: Map<string, number>,
): Point[] {
  const edge = model.edges[route.edgeIndex]!;
  const srcCell = placement.cells.get(edge.from)!;
  const tgtCell = placement.cells.get(edge.to)!;
  const srcSize = model.nodes.find((n) => n.id === edge.from)?.size ?? {
    width: 1,
    height: 1,
  };
  const tgtSize = model.nodes.find((n) => n.id === edge.to)?.size ?? {
    width: 1,
    height: 1,
  };

  // DESIGN-PHASE5-MODULES.md §4.1 — when the edge source is a qualified
  // module ref (`mod.foo`), the slot pixel is the *internal* node's
  // translated pixel position, not the synthetic cell's face slot.
  // Same for the target. The corridor sequence is still planned around
  // the synthetic cell (because that's what the parent placer sees),
  // but the trace enters/leaves the corridor at the internal-node's
  // position, giving a clean perpendicular L-bend inside the module
  // body instead of a face-to-face trunk with a jump at each end.
  const startPoint = portPointFor(
    edge.from,
    edge.fromInternal,
    route.sourceSide,
    () => slotPixel(
      route.sourceSide,
      route.sourceSlot,
      srcCell,
      srcSize.width,
      srcSize.height,
      layout,
    ),
    modulePortIndex,
    internalFanoutRank.get(`${route.edgeIndex}|from`),
    faceToFaceCount.get(`${edge.from}|${route.sourceSide}`) ?? 0,
  );
  const endPoint = portPointFor(
    edge.to,
    edge.toInternal,
    route.targetSide,
    () => slotPixel(
      route.targetSide,
      route.targetSlot,
      tgtCell,
      tgtSize.width,
      tgtSize.height,
      layout,
    ),
    modulePortIndex,
    internalFanoutRank.get(`${route.edgeIndex}|to`),
    faceToFaceCount.get(`${edge.to}|${route.targetSide}`) ?? 0,
  );

  // Precompute, for each corridor in the sequence:
  //   - longAxisEntry/Exit: the long-axis pixel coord at the trace's
  //     entry and exit. For H corridors that's an x; for V, a y.
  //   - perpCoord: the trace's perp coord WHEN running along the
  //     corridor's long axis (its assigned track).
  // The polyline then consists of segments connecting these waypoints.
  //
  // The trace either:
  //   - runs ALONG the corridor's long axis (entry and exit on
  //     different long-axis coords) at perpCoord, OR
  //   - crosses through perpendicular to the long axis (entry and
  //     exit at the same long-axis coord, perp coord determined by
  //     adjacent corridors / endpoints).
  interface CorridorStep {
    corridor: Corridor;
    track: number;
    /** True if the trace runs ALONG this corridor's long axis. */
    alongLong: boolean;
  }

  const steps: CorridorStep[] = [];
  for (const c of route.corridorSequence) {
    const tk = trackLookup.get(`${route.edgeIndex}|${corridorKey(c)}`);
    if (!tk) {
      throw new PolylineError(
        `internal: missing track for edge ${route.edgeIndex} in corridor ${corridorKey(c)}`,
      );
    }
    steps.push({ corridor: c, track: tk.track, alongLong: false });
  }

  // Determine "alongLong" for each step. A corridor's perp axis is:
  //   H corridor: y (long axis is x)
  //   V corridor: x (long axis is y)
  //
  // For an H corridor, the trace's y at entry can be:
  //   - startPoint.y if it's the first step (from source slot).
  //   - The previous H corridor's track.y (continuing east-west).
  //   - The previous V corridor's exit.y, which is THIS H's track.y
  //     (since the trace runs ALONG H at its track y, that's where it
  //     entered from V too).
  // Similarly exit.y.
  //
  // Simplification: for the perp comparison, the trace's perp coord
  // when adjacent to a perpendicular corridor IS this corridor's
  // track perp (because the trace runs along this corridor at its
  // track). When adjacent to a same-orientation corridor or to a
  // box face, the perp is determined by that adjacent thing.
  //
  // Concretely:
  //   H corridor's entry y = (first ? startPoint.y : H's own track.y)
  //   H corridor's exit  y = (last ? endPoint.y   : H's own track.y)
  //   V corridor's entry x = (first ? startPoint.x : V's own track.x)
  //   V corridor's exit  x = (last ? endPoint.x   : V's own track.x)
  //
  // alongLong = entry perp ≠ exit perp. For a single-corridor route,
  // that means source.perp ≠ target.perp (true diagonal trace).
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const trackPerp = trackPerpCoord(s.corridor, s.track, layout);
    let entryPerp: number;
    let exitPerp: number;
    if (s.corridor.kind === "H") {
      entryPerp = i === 0 ? startPoint.y : trackPerp;
      exitPerp = i === steps.length - 1 ? endPoint.y : trackPerp;
    } else if (s.corridor.kind === "V") {
      entryPerp = i === 0 ? startPoint.x : trackPerp;
      exitPerp = i === steps.length - 1 ? endPoint.x : trackPerp;
    } else {
      throw new PolylineError("internal: diagonals not yet supported");
    }
    s.alongLong = entryPerp !== exitPerp;
  }

  // Compute the entry and exit pixel for each corridor step.
  // The trace's per-corridor geometry is:
  //   - H corridor: x varies from entry.x to exit.x at perp = track.y
  //                 (or constant y if alongLong=false).
  //   - V corridor: y varies from entry.y to exit.y at perp = track.x.
  //
  // entry.x for V_i = (i == 0) ? startPoint.x : prev.exit.x
  //                 = first-step source-slot.x, or prev step's exit
  //                   which is its own track.x (since it ran along
  //                   its long axis).
  // entry.y for V_i = (i == 0) ? startPoint.y : prev.exit.y
  //                 = first-step source-slot.y, or prev step's
  //                   exit-into-V.y. For a previous H, that's H's
  //                   track.y (the trace was at H's track during H,
  //                   and the V/H intersection at (V.track.x,H.track.y)
  //                   carries that y into V).
  //
  // Pixel-level model:
  //
  //   For step V_i with track perp x_t:
  //     entry  = (entry.x, entry.y)
  //     mid_in = (x_t, entry.y)        [deflect to track]
  //     mid_out= (x_t, exit.y)         [run along V to exit.y]
  //     exit   = (exit.x, exit.y)      [deflect out of track]
  //   When entry.x == x_t (already at track), skip mid_in.
  //   When exit.x  == x_t (exit at track),  skip exit deflection
  //   (mid_out IS the exit, basically).
  //
  // For H steps, swap x↔y.

  // Compute entry/exit pixels per step.
  interface StepPixels {
    entry: Point;
    exit: Point;
    trackPerp: number; // y for H, x for V
  }
  const stepPixels: StepPixels[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const trackPerp = trackPerpCoord(s.corridor, s.track, layout);
    let entry: Point;
    let exit: Point;
    if (s.corridor.kind === "H") {
      // long = x. entry.x and exit.x are the long-axis coords. perp = y.
      const entryX =
        i === 0 ? startPoint.x : trackPerpCoord(steps[i - 1]!.corridor, steps[i - 1]!.track, layout);
      const exitX =
        i === steps.length - 1
          ? endPoint.x
          : trackPerpCoord(steps[i + 1]!.corridor, steps[i + 1]!.track, layout);
      // entry.y / exit.y: the trace's y inside this H is trackPerp.
      // But at the *boundary*, the trace's y is what the adjacent
      // corridor / box brings. Specifically:
      //   - first step: entry.y = startPoint.y (the source slot's y).
      //     Then a deflection inside the corridor moves y → trackPerp.
      //   - non-first step: entry.y = trackPerp (already at track from
      //     prev corridor / box adjacency that delivered the y).
      //     Wait — a previous V brings its own track.x to the boundary;
      //     the y at the boundary is whatever the trace had in V, which
      //     for V→H is H's track.y. So entry.y is trackPerp.
      const entryY = i === 0 ? startPoint.y : trackPerp;
      const exitY = i === steps.length - 1 ? endPoint.y : trackPerp;
      entry = { x: entryX, y: entryY };
      exit = { x: exitX, y: exitY };
    } else if (s.corridor.kind === "V") {
      const entryY =
        i === 0 ? startPoint.y : trackPerpCoord(steps[i - 1]!.corridor, steps[i - 1]!.track, layout);
      const exitY =
        i === steps.length - 1
          ? endPoint.y
          : trackPerpCoord(steps[i + 1]!.corridor, steps[i + 1]!.track, layout);
      const entryX = i === 0 ? startPoint.x : trackPerp;
      const exitX = i === steps.length - 1 ? endPoint.x : trackPerp;
      entry = { x: entryX, y: entryY };
      exit = { x: exitX, y: exitY };
    } else {
      throw new PolylineError("internal: diagonals not yet supported");
    }
    stepPixels.push({ entry, exit, trackPerp });
  }

  // Emit waypoints. For each step:
  //   - cursor starts at the step's entry.
  //   - If alongLong: deflect into track, run along track, deflect to
  //     exit. (entry → (track, entry.perp_other) → (track, exit.perp_other)
  //     → exit.) If entry.long == track on perp axis, skip first deflect.
  //   - Else: run straight from entry to exit (single segment).
  //
  // Between steps, cursor moves orthogonally from one step's exit to
  // the next step's entry if they differ.

  const points: Point[] = [startPoint];
  let cursor = { ...startPoint };

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const sp = stepPixels[i]!;
    // Connect cursor to step entry (if needed).
    if (cursor.x !== sp.entry.x || cursor.y !== sp.entry.y) {
      // Orthogonal connection.
      if (cursor.x !== sp.entry.x && cursor.y !== sp.entry.y) {
        // Pick axis to bend on. Use the previous corridor's long axis
        // if there is one; otherwise pick one that matches this step's
        // long axis.
        if (s.corridor.kind === "H") {
          points.push({ x: sp.entry.x, y: cursor.y });
        } else {
          points.push({ x: cursor.x, y: sp.entry.y });
        }
      }
      points.push(sp.entry);
      cursor = { ...sp.entry };
    }

    // Now traverse this corridor.
    if (s.alongLong) {
      // Deflect into the track on the perp axis, then traverse the
      // long axis, then deflect out.
      if (s.corridor.kind === "H") {
        if (cursor.y !== sp.trackPerp) {
          points.push({ x: cursor.x, y: sp.trackPerp });
          cursor = { x: cursor.x, y: sp.trackPerp };
        }
        if (cursor.x !== sp.exit.x) {
          points.push({ x: sp.exit.x, y: cursor.y });
          cursor = { x: sp.exit.x, y: cursor.y };
        }
        if (cursor.y !== sp.exit.y) {
          points.push({ x: cursor.x, y: sp.exit.y });
          cursor = { x: cursor.x, y: sp.exit.y };
        }
      } else if (s.corridor.kind === "V") {
        if (cursor.x !== sp.trackPerp) {
          points.push({ x: sp.trackPerp, y: cursor.y });
          cursor = { x: sp.trackPerp, y: cursor.y };
        }
        if (cursor.y !== sp.exit.y) {
          points.push({ x: cursor.x, y: sp.exit.y });
          cursor = { x: cursor.x, y: sp.exit.y };
        }
        if (cursor.x !== sp.exit.x) {
          points.push({ x: sp.exit.x, y: cursor.y });
          cursor = { x: sp.exit.x, y: cursor.y };
        }
      }
    } else {
      // Cross-through. Move straight to exit on the long axis.
      if (s.corridor.kind === "H") {
        if (cursor.x !== sp.exit.x) {
          points.push({ x: sp.exit.x, y: cursor.y });
          cursor = { x: sp.exit.x, y: cursor.y };
        }
      } else if (s.corridor.kind === "V") {
        if (cursor.y !== sp.exit.y) {
          points.push({ x: cursor.x, y: sp.exit.y });
          cursor = { x: cursor.x, y: sp.exit.y };
        }
      }
    }
  }

  // Connect cursor to endPoint with up to one bend.
  if (cursor.x !== endPoint.x || cursor.y !== endPoint.y) {
    if (cursor.x !== endPoint.x && cursor.y !== endPoint.y) {
      const lastCorridor = steps[steps.length - 1]!.corridor;
      if (lastCorridor.kind === "H") {
        points.push({ x: endPoint.x, y: cursor.y });
      } else {
        points.push({ x: cursor.x, y: endPoint.y });
      }
    }
    points.push(endPoint);
  }

  return dedupe(points);
}

interface CorridorStep {
  corridor: Corridor;
  track: number;
  alongLong: boolean;
}

function vCorridorCenterX(c: Corridor, layout: PixelLayout): number {
  if (c.kind !== "V") return 0;
  const gutterLeft =
    c.index === 0
      ? 0
      : layout.colX[c.index - 1]! + layout.colWidthPx[c.index - 1]!;
  const gutterWidth = layout.colGutterPx[c.index]!;
  return gutterLeft + gutterWidth / 2;
}

function hCorridorCenterY(c: Corridor, layout: PixelLayout): number {
  if (c.kind !== "H") return 0;
  const gutterTop =
    c.index === 0
      ? 0
      : layout.rowY[c.index - 1]! + layout.rowHeightPx[c.index - 1]!;
  const gutterHeight = layout.rowGutterPx[c.index]!;
  return gutterTop + gutterHeight / 2;
}

function dedupe(points: Point[]): Point[] {
  if (points.length <= 1) return points;
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = points[i]!;
    if (prev.x !== cur.x || prev.y !== cur.y) out.push(cur);
  }
  return out;
}

// --- 2b. X-junction materialisation ---------------------------------------

/**
 * An X-pair: two routes whose orthogonal in-corridor paths produce
 * overlapping horizontal/vertical segments at their source/target
 * perp coords because they run opposite directions along the same
 * corridor with swapped endpoints.
 *
 * Resolution: at the corridor's long-axis midpoint, both traces swap
 * to the other's track via short 45° diagonal segments. The two
 * diagonals form a clean X-junction. The result keeps each trace
 * mostly orthogonal (no full-corridor diagonals — which would be
 * an "abuse" of the diagonal-route feature in §4.2) while removing
 * the segment overlap.
 */
interface XPair {
  edgeIndexA: number;
  edgeIndexB: number;
  corridorKey: string;
  corridorKind: "H" | "V";
  /** Pixel coord of trace A's track and B's track on the perp axis. */
  trackA: number;
  trackB: number;
  /** Corridor long-axis midpoint (y for V, x for H). */
  longMid: number;
}

/**
 * Detect X-pairs by inspecting each route's orthogonal polyline. For
 * each corridor that two routes both traverse along the long axis,
 * compare their entry/exit pixel coords. They form an X-pair iff:
 *   - directions are opposite, AND
 *   - one's entry perp ≈ the other's exit perp (and vice versa)
 *
 * The entry/exit perp coords are read off the orthogonal polylines:
 * for a V corridor, find the trace's vertical segment (the run with
 * constant x at the track), and read its endpoints' y values.
 */
function findXPairs(
  reservation: Reservation,
  trackLookup: Map<string, TrackAssignment>,
  orthogonalByEdge: Map<number, Point[]>,
  layout: PixelLayout,
): XPair[] {
  interface RouteVertical {
    route: Route;
    /** Pixel perp coord of this trace's track inside the corridor. */
    trackPerp: number;
    /**
     * The corridor's "entry perp" and "exit perp" for this trace — the
     * long-axis coords at which the trace enters and leaves the
     * corridor's vertical/horizontal run.
     */
    entryLong: number;
    exitLong: number;
  }

  const byCorridor = new Map<string, RouteVertical[]>();
  for (const r of reservation.routes) {
    const polyline = orthogonalByEdge.get(r.edgeIndex)!;
    for (const c of r.corridorSequence) {
      const cKey = corridorKey(c);
      const t = trackLookup.get(`${r.edgeIndex}|${cKey}`);
      if (!t) continue;
      const trackPx = trackPerpCoord(c, t.track, layout);
      const seg = extractCorridorSegment(polyline, c, trackPx, layout);
      if (!seg) continue;
      if (!byCorridor.has(cKey)) byCorridor.set(cKey, []);
      byCorridor.get(cKey)!.push({
        route: r,
        trackPerp: trackPx,
        entryLong: seg.entryLong,
        exitLong: seg.exitLong,
      });
    }
  }

  const pairs: XPair[] = [];
  const seenPairs = new Set<string>();
  const tol = COMB_PITCH / 2;
  for (const [cKey, infos] of byCorridor) {
    const corridor = decodeCorridor(cKey);
    if (corridor.kind === "D") continue;
    for (let i = 0; i < infos.length; i++) {
      for (let j = i + 1; j < infos.length; j++) {
        const a = infos[i]!;
        const b = infos[j]!;
        const aDir = a.exitLong - a.entryLong;
        const bDir = b.exitLong - b.entryLong;
        if (aDir === 0 || bDir === 0) continue;
        if (Math.sign(aDir) === Math.sign(bDir)) continue;
        if (
          Math.abs(a.entryLong - b.exitLong) <= tol &&
          Math.abs(a.exitLong - b.entryLong) <= tol
        ) {
          const pairKey = `${cKey}|${Math.min(a.route.edgeIndex, b.route.edgeIndex)}|${Math.max(a.route.edgeIndex, b.route.edgeIndex)}`;
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          pairs.push({
            edgeIndexA: a.route.edgeIndex,
            edgeIndexB: b.route.edgeIndex,
            corridorKey: cKey,
            corridorKind: corridor.kind,
            trackA: a.trackPerp,
            trackB: b.trackPerp,
            longMid: (a.entryLong + a.exitLong) / 2,
          });
        }
      }
    }
  }
  return pairs;
}

/**
 * Find the trace's "long-axis run" inside the corridor: the segment
 * of the orthogonal polyline that sits at the trace's track perp
 * coord. Returns the entry and exit long-axis coords of this run.
 *
 * For a V corridor (long=y), the run is the vertical segment at
 * x=trackPx. Its endpoints' y values are entryLong and exitLong.
 *
 * Returns null if the trace doesn't have such a run (e.g., it's a
 * transverse cross-through).
 */
function extractCorridorSegment(
  polyline: Point[],
  corridor: Corridor,
  trackPx: number,
  layout: PixelLayout,
): { entryLong: number; exitLong: number } | null {
  const bounds = corridorXYBounds(corridor, layout);
  if (!bounds) return null;
  const tol = 0.5;
  // For a V corridor: look for two consecutive waypoints at x=trackPx
  // (both inside corridor x-range). The run is the vertical between
  // those waypoints. Capture the first such pair.
  if (corridor.kind === "V") {
    let entry: number | null = null;
    let exit: number | null = null;
    for (let i = 0; i + 1 < polyline.length; i++) {
      const p1 = polyline[i]!;
      const p2 = polyline[i + 1]!;
      if (
        Math.abs(p1.x - trackPx) < tol &&
        Math.abs(p2.x - trackPx) < tol &&
        p1.x >= bounds.xMin - tol &&
        p1.x <= bounds.xMax + tol &&
        p1.y !== p2.y
      ) {
        entry = entry ?? p1.y;
        exit = p2.y;
      }
    }
    if (entry === null || exit === null) return null;
    return { entryLong: entry, exitLong: exit };
  }
  // H corridor.
  let entry: number | null = null;
  let exit: number | null = null;
  for (let i = 0; i + 1 < polyline.length; i++) {
    const p1 = polyline[i]!;
    const p2 = polyline[i + 1]!;
    if (
      Math.abs(p1.y - trackPx) < tol &&
      Math.abs(p2.y - trackPx) < tol &&
      p1.y >= bounds.yMin - tol &&
      p1.y <= bounds.yMax + tol &&
      p1.x !== p2.x
    ) {
      entry = entry ?? p1.x;
      exit = p2.x;
    }
  }
  if (entry === null || exit === null) return null;
  return { entryLong: entry, exitLong: exit };
}

interface XYBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

function corridorXYBounds(c: Corridor, layout: PixelLayout): XYBounds | null {
  if (c.kind === "V") {
    const left =
      c.index === 0
        ? 0
        : layout.colX[c.index - 1]! + layout.colWidthPx[c.index - 1]!;
    const right =
      c.index >= layout.colX.length ? layout.totalWidth : layout.colX[c.index]!;
    return { xMin: left, xMax: right, yMin: 0, yMax: layout.totalHeight };
  }
  if (c.kind === "H") {
    const top =
      c.index === 0
        ? 0
        : layout.rowY[c.index - 1]! + layout.rowHeightPx[c.index - 1]!;
    const bottom =
      c.index >= layout.rowY.length ? layout.totalHeight : layout.rowY[c.index]!;
    return { xMin: 0, xMax: layout.totalWidth, yMin: top, yMax: bottom };
  }
  return null;
}

/**
 * Apply a proper X-swap to a pair of opposite-direction traces in a
 * shared corridor.
 *
 * The two original tracks are sorted into T_lo and T_hi. Each trace
 * uses BOTH tracks: trace A uses (T_lo, T_hi) on its (entry, exit)
 * sides; trace B uses (T_hi, T_lo) — the opposite. At the corridor
 * midpoint, each trace emits a single 45° diagonal that connects its
 * entry-side track to its exit-side track. The two diagonals cross
 * at the corridor centre; their endpoints are 4 distinct corners of
 * the swap rectangle, so the segments don't overlap.
 *
 * Returned polylines preserve the source/target horizontal segments
 * outside the corridor and reroute the in-corridor portion.
 */
function applyXSwap(
  polyA: Point[],
  polyB: Point[],
  pair: XPair,
  layout: PixelLayout,
): { a: Point[]; b: Point[] } {
  const corridor = decodeCorridor(pair.corridorKey);
  const bounds = corridorXYBounds(corridor, layout);
  if (!bounds) return { a: polyA, b: polyB };
  const T_lo = Math.min(pair.trackA, pair.trackB);
  const T_hi = Math.max(pair.trackA, pair.trackB);
  // Half-extent of the swap diagonal along the long axis. The swap
  // is 45°, so its long-axis extent equals its perp extent =
  // (T_hi - T_lo) / 2 on either side of midL.
  const half = (T_hi - T_lo) / 2;
  // For each trace we need to know which track it uses on the
  // entry side (where source horizontal terminates) vs exit side
  // (where target horizontal begins). The rule (proven above by
  // case analysis): the trace whose source is on the LOWER-y
  // entry side uses T_lo on entry; the other uses T_hi. The same
  // trace's exit side gets the opposite. This guarantees that
  // each trace's source horizontal is left of the other's target
  // horizontal on the same side.
  //
  // Concretely for V corridors (long axis = y): the trace going
  // SOUTH (exit y > entry y) has its source on the NORTH side
  // (lower y). It exits at the SOUTH (higher y).
  //
  // For each trace, determine direction and which side is "low y"
  // vs "high y", and assign tracks accordingly.
  const aDir = directionOfRoute(polyA, corridor, layout);
  const bDir = directionOfRoute(polyB, corridor, layout);
  // aDir/bDir: "fwd" = goes positive along long axis (south for V,
  // east for H); "bwd" = goes negative.

  // Track allocation for the X-swap (derived in §4.4.4):
  //
  // Each trace uses two tracks — its "entry-side track" (where its
  // source horizontal terminates inside the corridor) and its
  // "exit-side track" (where its target horizontal begins). Choosing
  // these tracks asymmetrically across the pair eliminates segment
  // overlap on all four sides:
  //
  //   - FWD trace (going positive along long axis): entry side =
  //     north (low long-axis). Source horizontal: box → entry track.
  //     Exit side = south. Target horizontal: exit track → box.
  //   - BWD trace (going negative): mirror — entry south, exit north.
  //
  // With 2 tracks T_lo and T_hi: at the NORTH side, the trace
  // entering there (the FWD trace) takes T_lo so its source
  // horizontal ends at the smaller x; the BWD trace exiting there
  // takes T_hi so its target horizontal starts at the larger x.
  // Result: FWD source [box_lo, T_lo] and BWD target [T_hi, box_hi]
  // don't overlap. Similarly at the SOUTH side.
  //
  // So FWD: entry=T_lo (north), exit=T_hi (south).
  //    BWD: entry=T_lo (south), exit=T_hi (north).
  //
  // Both directions have entry=T_lo, exit=T_hi — but the meaning of
  // entry/exit differs. The swap diagonals end up at distinct corner
  // points (4 corners of the swap rectangle) because the two traces
  // traverse the swap zone in opposite long-axis directions.
  const aTracks = { entry: T_lo, exit: T_hi };
  const bTracks = { entry: T_lo, exit: T_hi };

  return {
    a: rewriteForXSwap(polyA, pair, layout, aTracks, aDir, half),
    b: rewriteForXSwap(polyB, pair, layout, bTracks, bDir, half),
  };
}

/**
 * Determine which direction a route travels through a corridor along
 * the corridor's long axis. "fwd" = travels in the positive direction
 * (south for V, east for H); "bwd" = negative.
 */
function directionOfRoute(
  polyline: Point[],
  corridor: Corridor,
  layout: PixelLayout,
): "fwd" | "bwd" {
  const bounds = corridorXYBounds(corridor, layout);
  if (!bounds) return "fwd";
  const tol = 0.5;
  // Find the first point at the corridor's entry side and the last
  // point at the exit side; compare their long-axis coords.
  let firstLong = Number.NaN;
  let lastLong = Number.NaN;
  for (let i = 0; i < polyline.length; i++) {
    const p = polyline[i]!;
    const insideX =
      p.x >= bounds.xMin - tol && p.x <= bounds.xMax + tol;
    const insideY =
      p.y >= bounds.yMin - tol && p.y <= bounds.yMax + tol;
    if (insideX && insideY) {
      if (Number.isNaN(firstLong)) {
        firstLong = corridor.kind === "V" ? p.y : p.x;
      }
      lastLong = corridor.kind === "V" ? p.y : p.x;
    }
  }
  if (Number.isNaN(firstLong) || Number.isNaN(lastLong)) return "fwd";
  return lastLong >= firstLong ? "fwd" : "bwd";
}

/**
 * Rewrite a polyline to use the X-swap geometry. The trace's path
 * through the corridor is replaced by:
 *   entry-horizontal → vertical at entry-track → 45° diagonal at the
 *   midpoint connecting entry-track to exit-track → vertical at
 *   exit-track → exit-horizontal.
 *
 * The source horizontal (before corridor entry) and target horizontal
 * (after corridor exit) outside the corridor are preserved but their
 * connection point to the corridor is patched to land on the new
 * track perp.
 */
function rewriteForXSwap(
  polyline: Point[],
  pair: XPair,
  layout: PixelLayout,
  tracks: { entry: number; exit: number },
  dir: "fwd" | "bwd",
  half: number,
): Point[] {
  const corridor = decodeCorridor(pair.corridorKey);
  const bounds = corridorXYBounds(corridor, layout);
  if (!bounds) return polyline;
  const tol = 0.5;
  // Find the trace's first and last points inside the corridor (or
  // at its boundary). These are the entry and exit of the in-corridor
  // portion.
  let entryIdx = -1;
  let exitIdx = -1;
  for (let i = 0; i < polyline.length; i++) {
    const p = polyline[i]!;
    const insideX =
      p.x >= bounds.xMin - tol && p.x <= bounds.xMax + tol;
    const insideY =
      p.y >= bounds.yMin - tol && p.y <= bounds.yMax + tol;
    if (insideX && insideY) {
      if (entryIdx < 0) entryIdx = i;
      exitIdx = i;
    }
  }
  if (entryIdx < 0 || exitIdx <= entryIdx) return polyline;
  const entryPt = polyline[entryIdx]!;
  const exitPt = polyline[exitIdx]!;
  // Build the new in-corridor path.
  const newPath: Point[] = [];
  // The polyline's first point is the source slot. It might be at the
  // corridor boundary (if source box is adjacent to the corridor) or
  // outside. Either way, preserve it as the starting waypoint, then
  // emit a source horizontal to the entry track.
  const srcPoint = polyline[0]!;
  newPath.push(srcPoint);
  if (pair.corridorKind === "V") {
    // long axis = y; perp = x.
    // Entry point: align to entry-track on x.
    const entryY = entryPt.y;
    const exitY = exitPt.y;
    newPath.push({ x: tracks.entry, y: entryY });
    // Vertical at entry-track to the swap zone.
    // Swap zone: from y_swap_in to y_swap_out, where for fwd
    //   y_swap_in = pair.longMid - half (north end of swap)
    //   y_swap_out = pair.longMid + half (south end of swap)
    // For bwd, swap_in and swap_out flip.
    const swapInY = dir === "fwd" ? pair.longMid - half : pair.longMid + half;
    const swapOutY = dir === "fwd" ? pair.longMid + half : pair.longMid - half;
    newPath.push({ x: tracks.entry, y: swapInY });
    // 45° diagonal across the swap.
    newPath.push({ x: tracks.exit, y: swapOutY });
    // Vertical at exit-track to the corridor exit y.
    newPath.push({ x: tracks.exit, y: exitY });
  } else {
    // H corridor: long axis = x; perp = y.
    const entryX = entryPt.x;
    const exitX = exitPt.x;
    newPath.push({ x: entryX, y: tracks.entry });
    const swapInX = dir === "fwd" ? pair.longMid - half : pair.longMid + half;
    const swapOutX = dir === "fwd" ? pair.longMid + half : pair.longMid - half;
    newPath.push({ x: swapInX, y: tracks.entry });
    newPath.push({ x: swapOutX, y: tracks.exit });
    newPath.push({ x: exitX, y: tracks.exit });
  }
  // Append a target horizontal from the exit-track at the exit
  // perp to the original target slot (last point of the polyline).
  const tgtPoint = polyline[polyline.length - 1]!;
  // If the last point is at the corridor's far boundary, just push it
  // directly. Otherwise we need to route to it.
  newPath.push(tgtPoint);
  return newPath;
}

// --- 3. chamfering pass ---------------------------------------------------

/**
 * Replace each 90° bend in the polyline with a 45° chamfer of radius
 * `COMB_PITCH / 2`, clamped to half the shorter adjacent segment so
 * adjacent chamfers don't overlap.
 *
 * A bend at point P with incoming direction `d_in` (unit vector) and
 * outgoing direction `d_out` is replaced by two waypoints:
 *   P - r * d_in    (chamfer entry, on the incoming segment)
 *   P + r * d_out   (chamfer exit, on the outgoing segment)
 *
 * The connecting segment between them is at 45° because `d_in` and
 * `d_out` are perpendicular cardinal vectors.
 *
 * Start and end points are not chamfered (they sit on box faces).
 */
function chamferBends(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const r0 = COMB_PITCH / 2;
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const here = points[i]!;
    const next = points[i + 1]!;
    const lenIn = Math.hypot(here.x - prev.x, here.y - prev.y);
    const lenOut = Math.hypot(next.x - here.x, next.y - here.y);
    if (lenIn === 0 || lenOut === 0) {
      out.push(here);
      continue;
    }
    const dInX = (here.x - prev.x) / lenIn;
    const dInY = (here.y - prev.y) / lenIn;
    const dOutX = (next.x - here.x) / lenOut;
    const dOutY = (next.y - here.y) / lenOut;
    // If the in and out directions are parallel (same or opposite), no
    // bend — skip chamfering and drop the redundant intermediate point.
    const cross = dInX * dOutY - dInY * dOutX;
    if (Math.abs(cross) < 1e-9) {
      // No bend; the point is collinear. Skip it entirely so the
      // polyline doesn't carry a redundant waypoint.
      continue;
    }
    const r = Math.min(r0, lenIn / 2, lenOut / 2);
    if (r <= 0) {
      out.push(here);
      continue;
    }
    out.push({ x: here.x - r * dInX, y: here.y - r * dInY });
    out.push({ x: here.x + r * dOutX, y: here.y + r * dOutY });
  }
  out.push(points[points.length - 1]!);
  return dedupe(out);
}

// --- 4. crossing markers --------------------------------------------------

function buildCrossingMarker(
  crossing: { corridor: string; edgeIndexA: number; edgeIndexB: number },
  _packing: Packing,
  layout: PixelLayout,
  trackLookup: Map<string, TrackAssignment>,
): CrossingMarker {
  const a = trackLookup.get(`${crossing.edgeIndexA}|${crossing.corridor}`);
  const b = trackLookup.get(`${crossing.edgeIndexB}|${crossing.corridor}`);
  if (!a || !b) {
    throw new PolylineError(
      `internal: crossing references unknown (edge, corridor) pair`,
    );
  }
  const corridor = decodeCorridor(crossing.corridor);
  // Place the marker at the geometric crossing of the two traces
  // inside the corridor.
  //
  // Each trace's per-corridor long-axis range is `[entry, exit]`
  // measured as a (boundaryIndex, slotIndex) tuple. Convert to pixels
  // by mapping the boundary index to its corridor coordinate.
  //
  // For a V corridor (long axis = y), the trace's perp coord is the
  // track's x; the long-axis range is the y-range as it traverses V.
  // The crossing y is the midpoint of the overlap between the two
  // y-ranges; if the ranges only touch at a single point (one trace
  // is straight), that's the crossing y.
  if (corridor.kind === "V") {
    const aTrackX = trackPerpCoord(corridor, a.track, layout);
    const bTrackX = trackPerpCoord(corridor, b.track, layout);
    const aRangeY = longAxisRangeY(a, layout);
    const bRangeY = longAxisRangeY(b, layout);
    const overlapLo = Math.max(aRangeY[0], bRangeY[0]);
    const overlapHi = Math.min(aRangeY[1], bRangeY[1]);
    const y = (overlapLo + overlapHi) / 2;
    return {
      corridor: crossing.corridor,
      x: (aTrackX + bTrackX) / 2,
      y,
      edgeIndexA: crossing.edgeIndexA,
      edgeIndexB: crossing.edgeIndexB,
    };
  }
  // H corridor: long axis = x.
  const aTrackY = trackPerpCoord(corridor, a.track, layout);
  const bTrackY = trackPerpCoord(corridor, b.track, layout);
  const aRangeX = longAxisRangeX(a, layout);
  const bRangeX = longAxisRangeX(b, layout);
  const overlapLo = Math.max(aRangeX[0], bRangeX[0]);
  const overlapHi = Math.min(aRangeX[1], bRangeX[1]);
  const x = (overlapLo + overlapHi) / 2;
  return {
    corridor: crossing.corridor,
    x,
    y: (aTrackY + bTrackY) / 2,
    edgeIndexA: crossing.edgeIndexA,
    edgeIndexB: crossing.edgeIndexB,
  };
}

/**
 * Pixel-space range of a trace's long-axis traversal in a V corridor.
 * Maps (boundaryIndex, slotIndex) tuples to pixel y by treating the
 * boundary as a row boundary and adding the slot offset.
 */
function longAxisRangeY(
  t: TrackAssignment,
  layout: PixelLayout,
): [number, number] {
  const eY = boundaryToPixelY(t.entryLongAxis, layout);
  const xY = boundaryToPixelY(t.exitLongAxis, layout);
  return [Math.min(eY, xY), Math.max(eY, xY)];
}

function longAxisRangeX(
  t: TrackAssignment,
  layout: PixelLayout,
): [number, number] {
  const eX = boundaryToPixelX(t.entryLongAxis, layout);
  const xX = boundaryToPixelX(t.exitLongAxis, layout);
  return [Math.min(eX, xX), Math.max(eX, xX)];
}

function boundaryToPixelY(
  coord: { boundaryIndex: number; slotIndex: number },
  layout: PixelLayout,
): number {
  const r = coord.boundaryIndex;
  // boundaryIndex is a row index; the boundary is the top of that row.
  // For r >= nRows, the trace exits past the bottom-most row — use
  // the page bottom.
  const rowTop =
    r >= layout.rowY.length ? layout.totalHeight : layout.rowY[r]!;
  return rowTop + coord.slotIndex * COMB_PITCH + COMB_PITCH / 2;
}

function boundaryToPixelX(
  coord: { boundaryIndex: number; slotIndex: number },
  layout: PixelLayout,
): number {
  const c = coord.boundaryIndex;
  const colLeft =
    c >= layout.colX.length ? layout.totalWidth : layout.colX[c]!;
  return colLeft + coord.slotIndex * COMB_PITCH + COMB_PITCH / 2;
}

function decodeCorridor(key: string): Corridor {
  if (key.startsWith("H")) {
    return { kind: "H", index: Number(key.slice(1)) };
  }
  if (key.startsWith("V")) {
    return { kind: "V", index: Number(key.slice(1)) };
  }
  const body = key.slice(1);
  const parts = body.split(",");
  return {
    kind: "D",
    row: Number(parts[0]),
    col: Number(parts[1]),
    dir: parts[2] as "NE" | "SE" | "SW" | "NW",
  };
}
