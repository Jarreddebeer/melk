/**
 * Phase 4 channel routing (replaces corridors + tracks + polyline).
 *
 * Inputs: bound `Model`, `Placement`, and the per-edge `SlotAssignment`
 *   from `slots.ts`.
 * Output: a `ChannelRouting` — per-edge pixel polyline + crossings +
 *   total canvas extent.
 *
 * Algorithm (DESIGN-PHASE4.md §3):
 *
 *   1. Build the occupancy grid: every cell is either empty or owned
 *      by some node's footprint.
 *   2. For each edge in declaration order:
 *      a. Look up `(sourceSide, sourceSlot, targetSide, targetSlot)`
 *         from the SlotAssignment.
 *      b. Compute the entry cell — the empty cell immediately outside
 *         the source slot's pixel position.
 *      c. Pick the trace's geometry:
 *           - Straight (same row for E↔W, same col for N↔S, slots align).
 *           - L-shape (one bend cell, on the row of the perpendicular leg).
 *           - Z-shape detour (greedy bend claimed, try the next-best).
 *      d. Claim the bend cell — one trace per bend cell. Reserve the
 *         per-channel lane the trace uses for crossings detection +
 *         lazy growth.
 *      e. Emit the pixel polyline: source slot pixel → channel center
 *         points → target slot pixel, then chamfer 90° bends to 45°
 *         at radius COMB_PITCH / 2.
 *   3. Count crossings (a V-channel trace crosses an H-channel trace
 *      at any cell they share). Enforce `model.crossingsBudget`.
 *
 * Errors:
 *   E_NO_CHANNEL    — entry cell is occupied (slot opens into a wall).
 *   E_UNROUTABLE    — no available bend cell along any channel.
 *   E_CROSSINGS_OVER_BUDGET — actual crossings exceed the user's cap.
 */
import type { Model } from "../bind/model.js";
import type { Cell, Placement } from "./placement.js";
import type { SlotAssignment, Side } from "./slots.js";
import { CELL_PX, COMB_PITCH } from "./slots.js";
import { computePixelLayout, slotPixel } from "./pixels.js";
import type { PixelLayout, Point } from "./pixels.js";

// --- public types ---------------------------------------------------------

export type { Point };

export interface Polyline {
  edgeIndex: number;
  /** Pixel waypoints in order from source slot to target slot. */
  points: Point[];
  /** Indices into `ChannelRouting.crossings`. */
  crossingIndices: number[];
}

export interface CrossingMarker {
  x: number;
  y: number;
  edgeIndexA: number;
  edgeIndexB: number;
}

export interface ChannelRouting {
  polylines: Polyline[];
  crossings: CrossingMarker[];
  /** Diagram extent in pixels. */
  width: number;
  height: number;
}

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// --- entry point ----------------------------------------------------------

export function routeChannels(
  model: Model,
  placement: Placement,
  slots: Map<number, SlotAssignment>,
): ChannelRouting {
  const layout = computePixelLayout(placement);
  const sizeOf = new Map(model.nodes.map((n) => [n.id, n.size]));

  // Build occupancy grid: cellOwner["r,c"] = nodeId of the node whose
  // footprint covers that cell. Multi-cell occupancy: a node at (r, c)
  // with size (W, H) occupies cells (r..r+H-1, c..c+W-1).
  const cellOwner = new Map<string, string>();
  for (const node of model.nodes) {
    const cell = placement.cells.get(node.id);
    if (!cell) continue;
    const W = Math.ceil(node.size.width);
    const H = Math.ceil(node.size.height);
    for (let dr = 0; dr < H; dr++) {
      for (let dc = 0; dc < W; dc++) {
        cellOwner.set(cellKey(cell.row + dr, cell.col + dc), node.id);
      }
    }
  }

  // Bend ownership: one trace per (row, col) bend cell.
  const bendOwner = new Map<string, number>();
  // Per-cell V-leg occupancy: a cell traversed vertically by edge X can
  // only be traversed vertically by another edge if it shifts to a
  // different column. Horizontal traversals don't conflict with vertical
  // traversals at the same cell — that's a crossing, accounted for
  // separately. So V and H claims are tracked independently.
  // DESIGN-PHASE4.md §3 "lazy channel growth". Keys: `${row},${col}`.
  const vLegClaim = new Map<string, number>();
  const hLegClaim = new Map<string, number>();
  // Sibling-aware sweep direction: for each (srcId, tgtId) pair we've
  // already routed, remember every midCol picked. Subsequent edges to
  // the same pair pick a col STRICTLY past the prior extremum so the
  // bend cols form a monotone stair — goingDown each new col < min of
  // priors, goingUp each new col > max of priors. Without monotonicity
  // a 3+-sibling fan-in (ex 20 svc_a/b/c → sink_y) has its top and
  // bottom siblings land on the SAME bend col with the middle sibling
  // one cell off, and the chamfers visually overlap.
  const siblingMidCols = new Map<string, number[]>();
  // Channel lane bookkeeping for crossing detection. Keys:
  //   `V|<col>` and `H|<row>`. Value: list of {edgeIndex, rowSpan or
  //   colSpan} for crossings detection.
  const vChannelTraces = new Map<number, ChannelTrace[]>();
  const hChannelTraces = new Map<number, ChannelTrace[]>();

  const polylines: Polyline[] = [];
  const crossings: CrossingMarker[] = [];
  // Pre-chamfer orthogonal paths kept for axial-overlap detection. Each
  // entry has the Manhattan polyline (rectilinear waypoints) and edge ids
  // so the error message names the conflicting edges.
  const orthoPolylines: { edgeIndex: number; points: Point[]; srcId: string; tgtId: string }[] = [];

  // Edge processing order: declaration order by default, but if edge X
  // has `avoidEdges: [Y, ...]`, X must be routed AFTER all those edges
  // so their leg claims are already populated and block X's lane choices
  // (DESIGN-PHASE4.md §11.8). Defer avoiders to a second pass.
  const order: number[] = [];
  const deferred: number[] = [];
  for (let i = 0; i < model.edges.length; i++) {
    const edge = model.edges[i]!;
    if (edge.avoidEdges && edge.avoidEdges.length > 0) {
      deferred.push(i);
    } else {
      order.push(i);
    }
  }
  order.push(...deferred);

  // Edges are iterated per `order`; the polylines array is still indexed
  // by declaration order through `edgeIndex`.
  for (const i of order) {
    const slot = slots.get(i);
    if (!slot) continue;
    const edge = model.edges[i]!;
    const srcCell = placement.cells.get(edge.from);
    const tgtCell = placement.cells.get(edge.to);
    if (!srcCell || !tgtCell) {
      throw new ChannelError(
        `internal: edge ${i} '${edge.from} -> ${edge.to}' has unplaced endpoint`,
      );
    }

    // §11.8 `avoid:` honoring. Build an effective cellOwner for this
    // edge that includes — in addition to actual node footprints — the
    // V/H leg cells of the avoided edges. These cells become obstacles
    // for picking lanes, so the routing walks AROUND the avoided edges
    // rather than crossing them. The avoid-set is resolved at bind time;
    // the deferred-edge ordering above guarantees the avoided edges'
    // claims are already populated by the time we reach this edge.
    let effCellOwner = cellOwner;
    if (edge.avoidEdges && edge.avoidEdges.length > 0) {
      effCellOwner = new Map(cellOwner);
      const avoidSet = new Set(edge.avoidEdges);
      const stamp = `avoid-edge-${i}`;
      for (const [k, edgeIdx] of vLegClaim) {
        if (avoidSet.has(edgeIdx)) effCellOwner.set(k, stamp);
      }
      for (const [k, edgeIdx] of hLegClaim) {
        if (avoidSet.has(edgeIdx)) effCellOwner.set(k, stamp);
      }
    }

    const srcSize = sizeOf.get(edge.from) ?? { width: 1, height: 1 };
    const tgtSize = sizeOf.get(edge.to) ?? { width: 1, height: 1 };
    const srcW = Math.ceil(srcSize.width);
    const srcH = Math.ceil(srcSize.height);
    const tgtW = Math.ceil(tgtSize.width);
    const tgtH = Math.ceil(tgtSize.height);

    const srcShift = placement.pixelShift.get(edge.from);
    const tgtShift = placement.pixelShift.get(edge.to);
    const srcExitRaw = slotPixel(slot.sourceSide, slot.sourceSlot, srcCell, srcW, srcH, layout);
    const tgtEntryRaw = slotPixel(slot.targetSide, slot.targetSlot, tgtCell, tgtW, tgtH, layout);
    const srcExit = srcShift
      ? { x: srcExitRaw.x + srcShift.dx, y: srcExitRaw.y + srcShift.dy }
      : srcExitRaw;
    const tgtEntry = tgtShift
      ? { x: tgtEntryRaw.x + tgtShift.dx, y: tgtEntryRaw.y + tgtShift.dy }
      : tgtEntryRaw;

    // The "exit cell" of the source: the empty cell immediately adjacent
    // to the slot, outside the footprint.
    const srcExitCell = exitCellOf(srcCell, srcW, srcH, slot.sourceSide, slot.sourceSlot);
    const tgtExitCell = exitCellOf(tgtCell, tgtW, tgtH, slot.targetSide, slot.targetSlot);

    // If the source-exit cell is occupied by a third party (not the
    // edge's own endpoints), the slot opens into a wall — `E_NO_CHANNEL`.
    // It's OK for the source-exit cell to be the target's own footprint
    // (boxes touching face-to-face) — the trace lands directly without
    // a real channel walk.
    {
      const owner = cellOwner.get(cellKey(srcExitCell.row, srcExitCell.col));
      if (owner !== undefined && owner !== edge.from && owner !== edge.to) {
        throw new ChannelError(
          `E_NO_CHANNEL: edge '${edge.from} -> ${edge.to}' exits ${edge.from}'s ${slot.sourceSide} face but cell (${srcExitCell.row}, ${srcExitCell.col}) is occupied by '${owner}'. Insert an empty row/col between the nodes (grow MEMBER_GAP, resize a neighbour, restructure).`,
        );
      }
    }
    {
      const owner = cellOwner.get(cellKey(tgtExitCell.row, tgtExitCell.col));
      if (owner !== undefined && owner !== edge.from && owner !== edge.to) {
        throw new ChannelError(
          `E_NO_CHANNEL: edge '${edge.from} -> ${edge.to}' enters ${edge.to}'s ${slot.targetSide} face but cell (${tgtExitCell.row}, ${tgtExitCell.col}) is occupied by '${owner}'.`,
        );
      }
    }

    // Route geometry: same axis (V/H) → straight if slot pixels align,
    // otherwise Z; different axes → L with one bend cell. Back-edges
    // route through a perimeter row/col outside any obstacle row/col, so
    // they don't cut through unrelated boxes that sit on the same row as
    // the source/target boxes.
    const cellPath = computeCellPath(
      srcExitCell,
      tgtExitCell,
      srcExit,
      tgtEntry,
      slot.sourceSide,
      slot.targetSide,
      effCellOwner,
      bendOwner,
      vLegClaim,
      hLegClaim,
      i,
      edge.from,
      edge.to,
      edge.source === "via-half",
      layout.colX.length,
      layout.rowY.length,
      !!edge.isBackEdge,
      srcCell,
      tgtCell,
      srcW,
      srcH,
      tgtW,
      tgtH,
      siblingMidCols,
    );

    // Claim interior cells of long legs so subsequent edges shift to
    // adjacent lanes. V cells and H cells are tracked independently —
    // a V trace and H trace at the same cell is a legal crossing.
    claimLegCells(cellPath, i, vLegClaim, hLegClaim);

    // Convert cell-path to pixel waypoints. The first/last points are
    // the actual slot pixels; intermediate points are cell-center
    // coords on the channels traversed.
    const ortho = pixelizeCellPath(srcExit, tgtEntry, cellPath, layout, slot.sourceSide, slot.targetSide);
    const chamfered = chamferBends(ortho);

    // Track channel occupancy for crossing detection.
    recordChannelTraces(cellPath, i, vChannelTraces, hChannelTraces);

    polylines.push({
      edgeIndex: i,
      points: chamfered,
      crossingIndices: [],
    });
    orthoPolylines.push({ edgeIndex: i, points: ortho, srcId: edge.from, tgtId: edge.to });
  }

  // Axial-overlap check: two segments on the same axis at the same
  // coordinate that share any pixel range. feedback-axial-overlap-rule:
  // collinear overlap is not a legal crossing — it draws two traces on
  // the same pixels, which reads as one trace. The router shouldn't emit
  // it; if it does, surface the conflict instead of rendering ambiguous
  // geometry. Endpoint-only sharing (e.g. trace A ending where trace B
  // bends) is excluded — that's a corner, not an overlap.
  detectAxialOverlaps(orthoPolylines);

  // Detect crossings: a V-channel trace and H-channel trace share a
  // cell ⇒ one crossing at that cell.
  for (const [col, vTraces] of vChannelTraces) {
    for (const v of vTraces) {
      // Look for H traces that share any row in v's rowSpan and pass
      // through col.
      for (let r = Math.min(v.start, v.end); r <= Math.max(v.start, v.end); r++) {
        const hTraces = hChannelTraces.get(r);
        if (!hTraces) continue;
        for (const h of hTraces) {
          if (h.edgeIndex === v.edgeIndex) continue;
          const hMin = Math.min(h.start, h.end);
          const hMax = Math.max(h.start, h.end);
          if (col < hMin || col > hMax) continue;
          // Crossing at cell (r, col). Only count once per pair.
          if (v.edgeIndex >= h.edgeIndex) continue;
          const cx = layout.colX[col]! + CELL_PX / 2;
          const cy = layout.rowY[r]! + CELL_PX / 2;
          crossings.push({
            x: cx,
            y: cy,
            edgeIndexA: v.edgeIndex,
            edgeIndexB: h.edgeIndex,
          });
        }
      }
    }
  }

  if (crossings.length > model.crossingsBudget) {
    throw new ChannelError(
      `E_CROSSINGS_OVER_BUDGET: routing requires ${crossings.length} ` +
        `crossings but budget is ${model.crossingsBudget}. ` +
        `Raise the budget with 'crossings: ${crossings.length}' or restructure ` +
        `the diagram.`,
    );
  }

  return {
    polylines,
    crossings,
    width: layout.totalWidth,
    height: layout.totalHeight,
  };
}

/**
 * E_AXIAL_OVERLAP: two distinct edges' orthogonal polylines share a
 * non-trivial pixel range on a same-axis collinear segment
 * (feedback-axial-overlap-rule). Two traces on the same pixels read as
 * one trace, so we surface this as a routing error instead of letting
 * the SVG hide the topology.
 *
 * Endpoint-only touching is excluded: a trace bending at a corner
 * shares one pixel with the next segment, and that's by construction.
 * We require the overlap to be > 0 pixels in length (strict pixel
 * overlap on the parallel axis).
 */
function detectAxialOverlaps(
  orthoPolylines: { edgeIndex: number; points: Point[]; srcId: string; tgtId: string }[],
): void {
  interface Seg {
    edgeIndex: number;
    srcId: string;
    tgtId: string;
    axis: "H" | "V";
    coord: number; // y for H segments, x for V segments
    lo: number;
    hi: number;
  }
  // Pre-chamfer ortho segments overshoot into bend cells: each bend
  // waypoint is at the cell center (4 px past the cell's edge), and the
  // chamfer pass shaves the overshoot back to the actual visible body of
  // the segment. Two segments touching across a cell-pitch gap therefore
  // appear to overlap by up to one full CELL_PX in the ortho that
  // disappears after chamfering. Shrink each segment by CELL_PX at each
  // end so legitimate touch-at-corner cases don't fire; interior overlaps
  // (the 03-style long collinear runs) still register.
  const SHRINK = CELL_PX;
  const segs: Seg[] = [];
  for (const poly of orthoPolylines) {
    for (let i = 1; i < poly.points.length; i++) {
      const a = poly.points[i - 1]!;
      const b = poly.points[i]!;
      if (a.x === b.x && a.y === b.y) continue;
      if (a.y === b.y) {
        const lo = Math.min(a.x, b.x) + SHRINK;
        const hi = Math.max(a.x, b.x) - SHRINK;
        if (lo >= hi) continue;
        segs.push({
          edgeIndex: poly.edgeIndex, srcId: poly.srcId, tgtId: poly.tgtId,
          axis: "H", coord: a.y, lo, hi,
        });
      } else if (a.x === b.x) {
        const lo = Math.min(a.y, b.y) + SHRINK;
        const hi = Math.max(a.y, b.y) - SHRINK;
        if (lo >= hi) continue;
        segs.push({
          edgeIndex: poly.edgeIndex, srcId: poly.srcId, tgtId: poly.tgtId,
          axis: "V", coord: a.x, lo, hi,
        });
      }
    }
  }
  // Bucket by (axis, coord) so we only compare candidate pairs.
  const byCoord = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = `${s.axis}|${s.coord}`;
    if (!byCoord.has(k)) byCoord.set(k, []);
    byCoord.get(k)!.push(s);
  }
  for (const group of byCoord.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.edgeIndex === b.edgeIndex) continue; // self-overlap = bookkeeping, not a draw conflict
        const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
        if (overlap <= 0) continue;
        throw new ChannelError(
          `E_AXIAL_OVERLAP: edges '${a.srcId} -> ${a.tgtId}' and ` +
          `'${b.srcId} -> ${b.tgtId}' share a ${overlap}-px ${a.axis === "H" ? "horizontal" : "vertical"} ` +
          `segment at ${a.axis === "H" ? `y=${a.coord}` : `x=${a.coord}`}. ` +
          `Collinear overlap draws both traces on the same pixels; restructure or ` +
          `widen the corridor so one trace shifts to an adjacent lane.`,
        );
      }
    }
  }
}

// --- routing helpers ------------------------------------------------------

/**
 * The empty cell immediately outside a slot, on the face's outward side.
 * For an E face, that's the cell east of the footprint at the slot's row.
 */
function exitCellOf(
  anchor: Cell,
  W: number,
  H: number,
  side: Side,
  slot: number,
): Cell {
  // `slot` is fractional; the cell the slot pixel sits in is `floor(slot)`.
  // Clamp to [0, dim-1] in case the slot lands on the boundary (slot = H
  // would point at the cell beyond the footprint; the slot allocator
  // never returns that, but defensive flooring is cheap).
  const slotIntPerp = Math.min(Math.max(0, Math.floor(slot)), 99999);
  switch (side) {
    case "E":
      return { row: anchor.row + Math.min(slotIntPerp, H - 1), col: anchor.col + W };
    case "W":
      return { row: anchor.row + Math.min(slotIntPerp, H - 1), col: anchor.col - 1 };
    case "N":
      return { row: anchor.row - 1, col: anchor.col + Math.min(slotIntPerp, W - 1) };
    case "S":
      return { row: anchor.row + H, col: anchor.col + Math.min(slotIntPerp, W - 1) };
  }
}

/**
 * Back-edge perimeter route for V→V (E/W faces). The standard Z would
 * walk srcExit.row and tgtExit.row, both of which sit inside any box
 * footprint occupying those rows (back-edges exit the source's outer
 * slot, which is at row=anchor.row — the box's own first row). Other
 * boxes on the same row would get cut through.
 *
 * Perimeter route: lift the H-leg to a row outside ALL box footprints
 * between srcExit.col and tgtExit.col. The path is a "C" / "n":
 *
 *   srcExit  →  (perimRow, srcExit.col)
 *            →  (perimRow, tgtExit.col)
 *            →  tgtExit
 *
 * Two V-legs (up to perimeter, down to target row) and one H-leg at the
 * perimeter row. Returns null if no usable perimeter row exists (caller
 * falls back to standard Z; if that also fails it surfaces E_LANE_FULL).
 */
function tryPerimeterRouteVV(
  srcExit: Cell,
  tgtExit: Cell,
  srcAnchor: Cell,
  tgtAnchor: Cell,
  srcW: number,
  srcH: number,
  tgtW: number,
  tgtH: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  edgeIndex: number,
  srcId: string,
  tgtId: string,
  gridRows: number,
): Cell[] | null {
  void srcW; void tgtW;
  const loCol = Math.min(srcExit.col, tgtExit.col);
  const hiCol = Math.max(srcExit.col, tgtExit.col);

  // Pick a perimeter row: outside both src and tgt vertical spans, and
  // free of any node footprint or claimed lane across cols loCol..hiCol.
  // Try rows above first (R = srcAnchor.row - 1 going up), then below.
  const srcRowTop = srcAnchor.row;
  const srcRowBot = srcAnchor.row + srcH - 1;
  const tgtRowTop = tgtAnchor.row;
  const tgtRowBot = tgtAnchor.row + tgtH - 1;

  const isHLaneFreeAt = (r: number): boolean => {
    if (r < 0 || r >= gridRows) return false;
    for (let c = loCol; c <= hiCol; c++) {
      const k = cellKey(r, c);
      if (cellOwner.has(k) && cellOwner.get(k) !== srcId && cellOwner.get(k) !== tgtId) return false;
      if (hLegClaim.has(k)) return false;
    }
    return true;
  };
  const isVLegFreeAt = (col: number, fromR: number, toR: number): boolean => {
    const lo = Math.min(fromR, toR);
    const hi = Math.max(fromR, toR);
    for (let r = lo; r <= hi; r++) {
      const k = cellKey(r, col);
      if (cellOwner.has(k) && cellOwner.get(k) !== srcId && cellOwner.get(k) !== tgtId) return false;
      if (vLegClaim.has(k)) return false;
    }
    return true;
  };

  // Prefer rows that route AROUND the entire diagram (the user reads
  // back-edges as "go around the outside, not back through the middle").
  // Search from the grid edges inward: row 0 first (top of the diagram),
  // then row 1, ... up to minTop-1; then row gridRows-1 down to maxBot+1.
  // This picks the outermost free row before falling back to interior
  // gaps. Same outcome as the original "just above src/tgt" for small
  // diagrams where there are no nodes far above/below; for diagrams with
  // multiple far-flung nodes, traces wrap around them rather than weaving
  // through interior gaps.
  const candidates: number[] = [];
  const minTop = Math.min(srcRowTop, tgtRowTop);
  const maxBot = Math.max(srcRowBot, tgtRowBot);
  for (let r = 0; r < minTop; r++) candidates.push(r);
  for (let r = gridRows - 1; r > maxBot; r--) candidates.push(r);

  for (const perimRow of candidates) {
    if (!isHLaneFreeAt(perimRow)) continue;
    if (!isVLegFreeAt(srcExit.col, srcExit.row, perimRow)) continue;
    if (!isVLegFreeAt(tgtExit.col, tgtExit.row, perimRow)) continue;
    // Bend cells must be free of bend conflicts too.
    const bend1: Cell = { row: perimRow, col: srcExit.col };
    const bend2: Cell = { row: perimRow, col: tgtExit.col };
    if (!isBendFree(bend1, cellOwner, bendOwner, srcId, tgtId)) continue;
    if (!isBendFree(bend2, cellOwner, bendOwner, srcId, tgtId)) continue;

    bendOwner.set(cellKey(bend1.row, bend1.col), edgeIndex);
    bendOwner.set(cellKey(bend2.row, bend2.col), edgeIndex);

    const path: Cell[] = [];
    // V leg: srcExit.row → perimRow at srcExit.col.
    const stepR1 = srcExit.row <= perimRow ? 1 : -1;
    for (let r = srcExit.row; ; r += stepR1) {
      path.push({ row: r, col: srcExit.col });
      if (r === perimRow) break;
    }
    // H leg: srcExit.col → tgtExit.col at perimRow.
    const stepC = srcExit.col <= tgtExit.col ? 1 : -1;
    if (srcExit.col !== tgtExit.col) {
      for (let c = srcExit.col + stepC; ; c += stepC) {
        path.push({ row: perimRow, col: c });
        if (c === tgtExit.col) break;
      }
    }
    // V leg: perimRow → tgtExit.row at tgtExit.col.
    const stepR2 = perimRow <= tgtExit.row ? 1 : -1;
    if (perimRow !== tgtExit.row) {
      for (let r = perimRow + stepR2; ; r += stepR2) {
        path.push({ row: r, col: tgtExit.col });
        if (r === tgtExit.row) break;
      }
    }
    return path;
  }
  return null;
}

/**
 * U-shape route for V-axis src (E/W face) → H-axis tgt (N/S face) when
 * src sits on the WRONG side of tgt's face (e.g. src north of an S-face
 * tgt). Standard L would force the V leg through tgt's interior. The U
 * routes around the outside: V down (or up) from src to perimRow past
 * tgt's far edge, H across to tgtExit.col, then V back UP (or DOWN) into
 * the slot from outside.
 *
 * tgtSide=S: perimRow > tgtRowBot (south of tgt). Final V approaches
 *   tgtExit from below, arrow points north into the slot.
 * tgtSide=N: perimRow < tgtRowTop (north of tgt). Final V approaches
 *   tgtExit from above, arrow points south into the slot.
 */
function tryUPathVtoH(
  srcExit: Cell,
  tgtExit: Cell,
  tgtSide: Side,
  srcAnchor: Cell,
  tgtAnchor: Cell,
  srcW: number,
  srcH: number,
  tgtW: number,
  tgtH: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  edgeIndex: number,
  srcId: string,
  tgtId: string,
  gridRows: number,
): Cell[] | null {
  void srcW; void srcAnchor; void srcH;
  const loCol = Math.min(srcExit.col, tgtExit.col);
  const hiCol = Math.max(srcExit.col, tgtExit.col);
  const tgtRowTop = tgtAnchor.row;
  const tgtRowBot = tgtAnchor.row + tgtH - 1;
  void tgtW;

  const isHLaneFreeAt = (r: number): boolean => {
    if (r < 0 || r >= gridRows) return false;
    for (let c = loCol; c <= hiCol; c++) {
      const k = cellKey(r, c);
      const owner = cellOwner.get(k);
      if (owner !== undefined && owner !== srcId && owner !== tgtId) return false;
      if (hLegClaim.has(k)) return false;
    }
    return true;
  };
  const isVLegFreeAt = (col: number, fromR: number, toR: number): boolean => {
    const lo = Math.min(fromR, toR);
    const hi = Math.max(fromR, toR);
    for (let r = lo; r <= hi; r++) {
      const k = cellKey(r, col);
      const owner = cellOwner.get(k);
      if (owner !== undefined && owner !== srcId && owner !== tgtId) return false;
      if (vLegClaim.has(k)) return false;
    }
    return true;
  };

  // Candidate perim rows: must be strictly past tgtExit on the approach
  // side, so the final V leg has length >= 1 cell (the arrow points
  // perpendicular to the face).
  //   S face: tgtExit is just south of tgt's body (row = tgtRowBot+1).
  //           perimRow must be > tgtExit.row.
  //   N face: tgtExit is just north of tgt's body (row = tgtRowTop-1).
  //           perimRow must be < tgtExit.row.
  const candidates: number[] = [];
  if (tgtSide === "S") {
    for (let r = tgtExit.row + 1; r < gridRows; r++) candidates.push(r);
  } else {
    // tgtSide === "N"
    for (let r = tgtExit.row - 1; r >= 0; r--) candidates.push(r);
  }
  void tgtRowTop; void tgtRowBot;

  // V-axis exit means the first leg must run horizontally (along the
  // exit-face's normal) for at least one cell before the trace bends
  // south. The downward V leg sits one col east of srcExit (for E face;
  // west for W face). Same on the target side: the final approach into
  // the S/N face must be perpendicular to the face (vertical), so the
  // H "across" leg must end one col before tgtExit.col, with a final
  // small V leg taking the trace into the slot.
  //
  // Resulting topology: 4 legs H-V-H-V (an "around-the-corner" U).
  // For srcExit.col adjacent to tgtExit.col (rare in U cases) we'd
  // collapse to a degenerate 2-leg V, but in practice U-path only
  // fires when srcExit and tgtExit are well-separated.
  const srcStepC = srcExit.col <= tgtExit.col ? 1 : -1; // direction trace runs along H legs
  const exitCol = srcExit.col + srcStepC;               // first bend col: one east/west of src exit
  const approachCol = tgtExit.col;                       // V leg col that lands on tgt slot

  for (const perimRow of candidates) {
    if (!isHLaneFreeAt(perimRow)) continue;
    // First small H leg: srcExit → (srcExit.row, exitCol). One cell.
    // Then V leg from srcExit.row to perimRow at exitCol.
    if (!isVLegFreeAt(exitCol, srcExit.row, perimRow)) continue;
    // Final V leg from perimRow up/down into tgtExit.row at tgtExit.col.
    if (!isVLegFreeAt(approachCol, perimRow, tgtExit.row)) continue;
    // Bend cells:
    //   bend1 = (srcExit.row, exitCol)     — corner of H→V
    //   bend2 = (perimRow, exitCol)        — corner of V→H
    //   bend3 = (perimRow, approachCol)    — corner of H→V (final)
    const bend1: Cell = { row: srcExit.row, col: exitCol };
    const bend2: Cell = { row: perimRow, col: exitCol };
    const bend3: Cell = { row: perimRow, col: approachCol };
    if (!isBendFree(bend1, cellOwner, bendOwner, srcId, tgtId)) continue;
    if (!isBendFree(bend2, cellOwner, bendOwner, srcId, tgtId)) continue;
    if (!isBendFree(bend3, cellOwner, bendOwner, srcId, tgtId)) continue;

    bendOwner.set(cellKey(bend1.row, bend1.col), edgeIndex);
    bendOwner.set(cellKey(bend2.row, bend2.col), edgeIndex);
    bendOwner.set(cellKey(bend3.row, bend3.col), edgeIndex);

    const path: Cell[] = [];
    // H out: srcExit.col → exitCol at srcExit.row.
    path.push({ row: srcExit.row, col: srcExit.col });
    if (exitCol !== srcExit.col) {
      path.push({ row: srcExit.row, col: exitCol });
    }
    // V down/up: srcExit.row → perimRow at exitCol.
    const stepR1 = srcExit.row <= perimRow ? 1 : -1;
    if (srcExit.row !== perimRow) {
      for (let r = srcExit.row + stepR1; ; r += stepR1) {
        path.push({ row: r, col: exitCol });
        if (r === perimRow) break;
      }
    }
    // H across: exitCol → approachCol at perimRow.
    const stepC = exitCol <= approachCol ? 1 : -1;
    if (exitCol !== approachCol) {
      for (let c = exitCol + stepC; ; c += stepC) {
        path.push({ row: perimRow, col: c });
        if (c === approachCol) break;
      }
    }
    // V into face: perimRow → tgtExit.row at tgtExit.col.
    const stepR2 = perimRow <= tgtExit.row ? 1 : -1;
    if (perimRow !== tgtExit.row) {
      for (let r = perimRow + stepR2; ; r += stepR2) {
        path.push({ row: r, col: tgtExit.col });
        if (r === tgtExit.row) break;
      }
    }
    return path;
  }
  return null;
}

/**
 * Mirror of `tryUPathVtoH`: H-axis src (N/S face) → V-axis tgt (E/W
 * face) when src is on the WRONG side of tgt's face.
 */
function tryUPathHtoV(
  srcExit: Cell,
  tgtExit: Cell,
  tgtSide: Side,
  srcAnchor: Cell,
  tgtAnchor: Cell,
  srcW: number,
  srcH: number,
  tgtW: number,
  tgtH: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  edgeIndex: number,
  srcId: string,
  tgtId: string,
  gridCols: number,
): Cell[] | null {
  void srcAnchor; void srcW; void srcH; void tgtH;
  const loRow = Math.min(srcExit.row, tgtExit.row);
  const hiRow = Math.max(srcExit.row, tgtExit.row);
  const tgtColLeft = tgtAnchor.col;
  const tgtColRight = tgtAnchor.col + tgtW - 1;

  const isVLaneFreeAt = (c: number): boolean => {
    if (c < 0 || c >= gridCols) return false;
    for (let r = loRow; r <= hiRow; r++) {
      const k = cellKey(r, c);
      const owner = cellOwner.get(k);
      if (owner !== undefined && owner !== srcId && owner !== tgtId) return false;
      if (vLegClaim.has(k)) return false;
    }
    return true;
  };
  const isHLegFreeAt = (row: number, fromC: number, toC: number): boolean => {
    const lo = Math.min(fromC, toC);
    const hi = Math.max(fromC, toC);
    for (let c = lo; c <= hi; c++) {
      const k = cellKey(row, c);
      const owner = cellOwner.get(k);
      if (owner !== undefined && owner !== srcId && owner !== tgtId) return false;
      if (hLegClaim.has(k)) return false;
    }
    return true;
  };

  const candidates: number[] = [];
  if (tgtSide === "E") {
    for (let c = tgtColRight + 1; c < gridCols; c++) candidates.push(c);
  } else {
    // tgtSide === "W"
    for (let c = tgtColLeft - 1; c >= 0; c--) candidates.push(c);
  }

  // Same "exit-perpendicular first" rule as V→H: trace exits N/S → first
  // leg runs vertically for ≥1 cell before bending east/west. Final
  // approach into the E/W face is also vertical→horizontal: the V across
  // leg ends one row before tgtExit.row, with a small final H leg into
  // the slot. Topology: V-H-V-H.
  const srcStepR = srcExit.row <= tgtExit.row ? 1 : -1;
  const exitRow = srcExit.row + srcStepR;
  const approachRow = tgtExit.row;

  for (const perimCol of candidates) {
    if (!isVLaneFreeAt(perimCol)) continue;
    // V short out: srcExit.row → exitRow at srcExit.col.
    // Long H across: exitRow → approachRow at perimCol — but the H is at
    // exitRow first then a V into approachRow at perimCol, then final H
    // into slot. Verify lanes:
    if (!isHLegFreeAt(exitRow, srcExit.col, perimCol)) continue;
    if (!isHLegFreeAt(approachRow, perimCol, tgtExit.col)) continue;
    const bend1: Cell = { row: exitRow, col: srcExit.col };
    const bend2: Cell = { row: exitRow, col: perimCol };
    const bend3: Cell = { row: approachRow, col: perimCol };
    if (!isBendFree(bend1, cellOwner, bendOwner, srcId, tgtId)) continue;
    if (!isBendFree(bend2, cellOwner, bendOwner, srcId, tgtId)) continue;
    if (!isBendFree(bend3, cellOwner, bendOwner, srcId, tgtId)) continue;

    bendOwner.set(cellKey(bend1.row, bend1.col), edgeIndex);
    bendOwner.set(cellKey(bend2.row, bend2.col), edgeIndex);
    bendOwner.set(cellKey(bend3.row, bend3.col), edgeIndex);

    const path: Cell[] = [];
    // V out: srcExit.row → exitRow at srcExit.col.
    path.push({ row: srcExit.row, col: srcExit.col });
    if (exitRow !== srcExit.row) {
      path.push({ row: exitRow, col: srcExit.col });
    }
    // H across at exitRow: srcExit.col → perimCol.
    const stepC1 = srcExit.col <= perimCol ? 1 : -1;
    if (srcExit.col !== perimCol) {
      for (let c = srcExit.col + stepC1; ; c += stepC1) {
        path.push({ row: exitRow, col: c });
        if (c === perimCol) break;
      }
    }
    // V from exitRow to approachRow at perimCol.
    const stepR = exitRow <= approachRow ? 1 : -1;
    if (exitRow !== approachRow) {
      for (let r = exitRow + stepR; ; r += stepR) {
        path.push({ row: r, col: perimCol });
        if (r === approachRow) break;
      }
    }
    // H into face: perimCol → tgtExit.col at tgtExit.row.
    const stepC2 = perimCol <= tgtExit.col ? 1 : -1;
    if (perimCol !== tgtExit.col) {
      for (let c = perimCol + stepC2; ; c += stepC2) {
        path.push({ row: tgtExit.row, col: c });
        if (c === tgtExit.col) break;
      }
    }
    return path;
  }
  return null;
}

/**
 * U-shape route for H-axis src (N/S face) → H-axis tgt (N/S face) when
 * BOTH faces are on the same side (both S or both N), with src on the
 * wrong side of tgt. Standard Z's midRow sits between srcExit.row and
 * tgtExit.row, which forces the final V leg through tgt's interior.
 * The U routes around tgt's far edge: V perpendicular out of src, H
 * across to tgt's slot col past tgt's outer edge, V back into the slot.
 *
 * Topology: V-H-V (3 legs). First V matches src exit normal; last V
 * matches tgt entry normal.
 *
 *   tgtSide=S: perimRow > tgt's south edge. Final V approaches going
 *     north into the S face.
 *   tgtSide=N: mirror.
 */
function tryUPathHHSameSide(
  srcExit: Cell,
  tgtExit: Cell,
  tgtSide: Side,
  srcAnchor: Cell,
  tgtAnchor: Cell,
  srcW: number,
  srcH: number,
  tgtW: number,
  tgtH: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  edgeIndex: number,
  srcId: string,
  tgtId: string,
  gridRows: number,
): Cell[] | null {
  void srcAnchor; void srcW; void srcH; void tgtW;
  const loCol = Math.min(srcExit.col, tgtExit.col);
  const hiCol = Math.max(srcExit.col, tgtExit.col);
  const tgtRowTop = tgtAnchor.row;
  const tgtRowBot = tgtAnchor.row + tgtH - 1;

  const isHLaneFreeAt = (r: number): boolean => {
    if (r < 0 || r >= gridRows) return false;
    for (let c = loCol; c <= hiCol; c++) {
      const k = cellKey(r, c);
      const owner = cellOwner.get(k);
      if (owner !== undefined && owner !== srcId && owner !== tgtId) return false;
      if (hLegClaim.has(k)) return false;
    }
    return true;
  };
  const isVLegFreeAt = (col: number, fromR: number, toR: number): boolean => {
    const lo = Math.min(fromR, toR);
    const hi = Math.max(fromR, toR);
    for (let r = lo; r <= hi; r++) {
      const k = cellKey(r, col);
      const owner = cellOwner.get(k);
      if (owner !== undefined && owner !== srcId && owner !== tgtId) return false;
      if (vLegClaim.has(k)) return false;
    }
    return true;
  };

  // perimRow choices: strictly past tgtExit on the approach side, so the
  // final V leg has ≥1 cell perpendicular to the face.
  const candidates: number[] = [];
  if (tgtSide === "S") {
    for (let r = tgtExit.row + 1; r < gridRows; r++) candidates.push(r);
  } else {
    // tgtSide === "N"
    for (let r = tgtExit.row - 1; r >= 0; r--) candidates.push(r);
  }
  void tgtRowTop; void tgtRowBot;

  for (const perimRow of candidates) {
    if (!isHLaneFreeAt(perimRow)) continue;
    // V leg from srcExit south/north to perimRow at srcExit.col.
    if (!isVLegFreeAt(srcExit.col, srcExit.row, perimRow)) continue;
    // Final V leg from perimRow north/south to tgtExit.row at tgtExit.col.
    if (!isVLegFreeAt(tgtExit.col, perimRow, tgtExit.row)) continue;
    const bend1: Cell = { row: perimRow, col: srcExit.col };
    const bend2: Cell = { row: perimRow, col: tgtExit.col };
    if (!isBendFree(bend1, cellOwner, bendOwner, srcId, tgtId)) continue;
    if (!isBendFree(bend2, cellOwner, bendOwner, srcId, tgtId)) continue;

    bendOwner.set(cellKey(bend1.row, bend1.col), edgeIndex);
    bendOwner.set(cellKey(bend2.row, bend2.col), edgeIndex);

    const path: Cell[] = [];
    // V leg: srcExit.row → perimRow at srcExit.col.
    const stepR1 = srcExit.row <= perimRow ? 1 : -1;
    for (let r = srcExit.row; ; r += stepR1) {
      path.push({ row: r, col: srcExit.col });
      if (r === perimRow) break;
    }
    // H leg: srcExit.col → tgtExit.col at perimRow.
    const stepC = srcExit.col <= tgtExit.col ? 1 : -1;
    if (srcExit.col !== tgtExit.col) {
      for (let c = srcExit.col + stepC; ; c += stepC) {
        path.push({ row: perimRow, col: c });
        if (c === tgtExit.col) break;
      }
    }
    // V leg: perimRow → tgtExit.row at tgtExit.col.
    const stepR2 = perimRow <= tgtExit.row ? 1 : -1;
    if (perimRow !== tgtExit.row) {
      for (let r = perimRow + stepR2; ; r += stepR2) {
        path.push({ row: r, col: tgtExit.col });
        if (r === tgtExit.row) break;
      }
    }
    return path;
  }
  return null;
}

/**
 * Back-edge perimeter route for H→H (N/S faces). Mirror of the V→V
 * version: lift to a perimeter COLUMN outside both src and tgt's
 * horizontal spans, then run vertically at that column.
 */
function tryPerimeterRouteHH(
  srcExit: Cell,
  tgtExit: Cell,
  srcAnchor: Cell,
  tgtAnchor: Cell,
  srcW: number,
  srcH: number,
  tgtW: number,
  tgtH: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  edgeIndex: number,
  srcId: string,
  tgtId: string,
  gridCols: number,
): Cell[] | null {
  void srcH; void tgtH;
  const loRow = Math.min(srcExit.row, tgtExit.row);
  const hiRow = Math.max(srcExit.row, tgtExit.row);

  const srcColLeft = srcAnchor.col;
  const srcColRight = srcAnchor.col + srcW - 1;
  const tgtColLeft = tgtAnchor.col;
  const tgtColRight = tgtAnchor.col + tgtW - 1;

  const isVLaneFreeAt = (c: number): boolean => {
    if (c < 0 || c >= gridCols) return false;
    for (let r = loRow; r <= hiRow; r++) {
      const k = cellKey(r, c);
      if (cellOwner.has(k) && cellOwner.get(k) !== srcId && cellOwner.get(k) !== tgtId) return false;
      if (vLegClaim.has(k)) return false;
    }
    return true;
  };
  const isHLegFreeAt = (row: number, fromC: number, toC: number): boolean => {
    const lo = Math.min(fromC, toC);
    const hi = Math.max(fromC, toC);
    for (let c = lo; c <= hi; c++) {
      const k = cellKey(row, c);
      if (cellOwner.has(k) && cellOwner.get(k) !== srcId && cellOwner.get(k) !== tgtId) return false;
      if (hLegClaim.has(k)) return false;
    }
    return true;
  };

  // Prefer cols that route AROUND the entire diagram (see VV comment).
  const candidates: number[] = [];
  const minLeft = Math.min(srcColLeft, tgtColLeft);
  const maxRight = Math.max(srcColRight, tgtColRight);
  for (let c = 0; c < minLeft; c++) candidates.push(c);
  for (let c = gridCols - 1; c > maxRight; c--) candidates.push(c);

  for (const perimCol of candidates) {
    if (!isVLaneFreeAt(perimCol)) continue;
    if (!isHLegFreeAt(srcExit.row, srcExit.col, perimCol)) continue;
    if (!isHLegFreeAt(tgtExit.row, tgtExit.col, perimCol)) continue;
    const bend1: Cell = { row: srcExit.row, col: perimCol };
    const bend2: Cell = { row: tgtExit.row, col: perimCol };
    if (!isBendFree(bend1, cellOwner, bendOwner, srcId, tgtId)) continue;
    if (!isBendFree(bend2, cellOwner, bendOwner, srcId, tgtId)) continue;

    bendOwner.set(cellKey(bend1.row, bend1.col), edgeIndex);
    bendOwner.set(cellKey(bend2.row, bend2.col), edgeIndex);

    const path: Cell[] = [];
    const stepC1 = srcExit.col <= perimCol ? 1 : -1;
    for (let c = srcExit.col; ; c += stepC1) {
      path.push({ row: srcExit.row, col: c });
      if (c === perimCol) break;
    }
    const stepR = srcExit.row <= tgtExit.row ? 1 : -1;
    if (srcExit.row !== tgtExit.row) {
      for (let r = srcExit.row + stepR; ; r += stepR) {
        path.push({ row: r, col: perimCol });
        if (r === tgtExit.row) break;
      }
    }
    const stepC2 = perimCol <= tgtExit.col ? 1 : -1;
    if (perimCol !== tgtExit.col) {
      for (let c = perimCol + stepC2; ; c += stepC2) {
        path.push({ row: tgtExit.row, col: c });
        if (c === tgtExit.col) break;
      }
    }
    return path;
  }
  return null;
}

/**
 * Compute the cell path the trace walks: source-exit-cell → bend cells
 * → target-exit-cell. Same-axis straight routes have no bend; L-shapes
 * have one bend; Z-detours have two.
 *
 * The result is always a list of (row, col) cells joining src to tgt,
 * with each consecutive pair sharing either row or col (no diagonals
 * — channel routing is Manhattan at v1).
 */
function computeCellPath(
  srcExit: Cell,
  tgtExit: Cell,
  srcExitPx: Point,
  tgtEntryPx: Point,
  srcSide: Side,
  tgtSide: Side,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  edgeIndex: number,
  srcId: string,
  tgtId: string,
  isViaHalf: boolean,
  gridCols: number,
  gridRows: number,
  isBackEdge: boolean,
  srcAnchor: Cell,
  tgtAnchor: Cell,
  srcW: number,
  srcH: number,
  tgtW: number,
  tgtH: number,
  siblingMidCols: Map<string, number[]>,
): Cell[] {
  const srcAxis: "V" | "H" = srcSide === "E" || srcSide === "W" ? "V" : "H";
  const tgtAxis: "V" | "H" = tgtSide === "E" || tgtSide === "W" ? "V" : "H";

  // Back-edge perimeter routing: when the back-edge's H-leg row (V→V) or
  // V-leg col (H→H) would cut through a box on the same row/col as the
  // source/target, lift the run to a perimeter row/col outside ALL box
  // footprints in the corridor between src and tgt. Standard Z would
  // walk srcExit.row / tgtExit.row, both of which sit INSIDE the box
  // span of any neighbour on the same row as src/tgt.
  if (isBackEdge && srcAxis === "V" && tgtAxis === "V") {
    const perimPath = tryPerimeterRouteVV(
      srcExit, tgtExit, srcAnchor, tgtAnchor, srcW, srcH, tgtW, tgtH,
      cellOwner, bendOwner, vLegClaim, hLegClaim,
      edgeIndex, srcId, tgtId, gridRows,
    );
    if (perimPath) return perimPath;
  }
  if (isBackEdge && srcAxis === "H" && tgtAxis === "H") {
    const perimPath = tryPerimeterRouteHH(
      srcExit, tgtExit, srcAnchor, tgtAnchor, srcW, srcH, tgtW, tgtH,
      cellOwner, bendOwner, vLegClaim, hLegClaim,
      edgeIndex, srcId, tgtId, gridCols,
    );
    if (perimPath) return perimPath;
  }

  // Straight: same axis AND slot pixels align EXACTLY in the perp axis.
  // Exit cells sharing a row isn't enough — fractional slots on opposing
  // faces can give the same integer row but different pixel y (e.g.
  // E slot 2.5 vs W slot 2 both land in row 22 but differ by 4 px). A
  // straight cell-path would emit a diagonal trace; force an L/Z route
  // when the slot pixels don't actually coincide.
  if (srcAxis === "V" && tgtAxis === "V" && srcExit.row === tgtExit.row && srcExitPx.y === tgtEntryPx.y) {
    // Same row, exits face each other. Walk from srcExit to tgtExit along
    // the row. Verify the corridor is clear.
    const path: Cell[] = [];
    const r = srcExit.row;
    const lo = Math.min(srcExit.col, tgtExit.col);
    const hi = Math.max(srcExit.col, tgtExit.col);
    const step = srcExit.col <= tgtExit.col ? 1 : -1;
    for (let c = srcExit.col; ; c += step) {
      path.push({ row: r, col: c });
      if (c === tgtExit.col) break;
    }
    // Block check: any intermediate cell occupied by a node that's not
    // the src/tgt itself is a wall.
    for (let c = lo + 1; c < hi; c++) {
      const owner = cellOwner.get(cellKey(r, c));
      if (owner && owner !== srcId && owner !== tgtId) {
        throw new ChannelError(
          `E_UNROUTABLE: edge ${edgeIndex} '${srcId} -> ${tgtId}' straight-line corridor at row ${r} is blocked by node '${owner}' at col ${c}`,
        );
      }
    }
    return path;
  }
  if (srcAxis === "H" && tgtAxis === "H" && srcExit.col === tgtExit.col && srcExitPx.x === tgtEntryPx.x) {
    const path: Cell[] = [];
    const c = srcExit.col;
    const lo = Math.min(srcExit.row, tgtExit.row);
    const hi = Math.max(srcExit.row, tgtExit.row);
    const step = srcExit.row <= tgtExit.row ? 1 : -1;
    for (let r = srcExit.row; ; r += step) {
      path.push({ row: r, col: c });
      if (r === tgtExit.row) break;
    }
    for (let r = lo + 1; r < hi; r++) {
      const owner = cellOwner.get(cellKey(r, c));
      if (owner && owner !== srcId && owner !== tgtId) {
        throw new ChannelError(
          `E_UNROUTABLE: edge ${edgeIndex} '${srcId} -> ${tgtId}' straight-line corridor at col ${c} is blocked by node '${owner}' at row ${r}`,
        );
      }
    }
    return path;
  }

  // L-shape: src on V axis (E/W), tgt on H axis (N/S) — bend at
  // (srcExit.row, tgtExit.col).
  // src on H axis, tgt on V axis — bend at (tgtExit.row, srcExit.col).
  // src and tgt on same axis but different perp coords — Z-shape: two
  // bends, one on each end's channel, joined by a perpendicular run.
  if (srcAxis === "V" && tgtAxis === "H") {
    // Standard L: bend at (srcExit.row, tgtExit.col). Path is
    // H@srcRow → V@tgtCol. The V leg approaches tgt from srcExit.row,
    // so the final approach direction is determined by whether src is
    // NORTH or SOUTH of tgtExit.row.
    //
    // tgtSide=N: tgtExit is one row ABOVE tgt's body. To enter going
    //   south (the natural N-face approach), the V leg must come from
    //   above, i.e. srcExit.row < tgtExit.row. If src is BELOW tgt
    //   (srcExit.row > tgtExit.row), the L would force the V leg
    //   through tgt's interior. Route as U: drop to perimRow ABOVE
    //   tgt, jog horizontally, then come DOWN into the N-face slot.
    // tgtSide=S: mirror — to enter going north, src must be below
    //   (srcExit.row > tgtExit.row). If src is ABOVE (the common case
    //   for E/W→S routing), the L cuts through tgt's interior. Route
    //   as U: drop BELOW tgt, jog horizontally, come UP into the
    //   S-face slot.
    const wrongSide = (tgtSide === "S" && srcExit.row < tgtExit.row)
                  || (tgtSide === "N" && srcExit.row > tgtExit.row);
    if (wrongSide) {
      const uPath = tryUPathVtoH(srcExit, tgtExit, tgtSide,
                                  srcAnchor, tgtAnchor, srcW, srcH, tgtW, tgtH,
                                  cellOwner, bendOwner, vLegClaim, hLegClaim,
                                  edgeIndex, srcId, tgtId, gridRows);
      if (uPath) return uPath;
      // Fall through to standard L if U couldn't find a perimeter row.
    }
    const bend: Cell = { row: srcExit.row, col: tgtExit.col };
    return claimLPath(srcExit, bend, tgtExit, /*via=*/ "row-then-col",
                      cellOwner, bendOwner, vLegClaim, hLegClaim, edgeIndex, srcId, tgtId);
  }
  if (srcAxis === "H" && tgtAxis === "V") {
    // Mirror of V→H. tgtSide=W/E and src is N/S of tgt.
    // tgtSide=W: V leg approaches from src.col, the H-jog into W-face
    //   comes from the WEST (col < tgtExit.col). If src.col > tgtExit.col
    //   (src is east of tgt), L cuts through tgt. Route as U via a perim
    //   col WEST of tgt.
    // tgtSide=E: mirror.
    const wrongSide = (tgtSide === "E" && srcExit.col < tgtExit.col)
                  || (tgtSide === "W" && srcExit.col > tgtExit.col);
    if (wrongSide) {
      const uPath = tryUPathHtoV(srcExit, tgtExit, tgtSide,
                                  srcAnchor, tgtAnchor, srcW, srcH, tgtW, tgtH,
                                  cellOwner, bendOwner, vLegClaim, hLegClaim,
                                  edgeIndex, srcId, tgtId, gridCols);
      if (uPath) return uPath;
    }
    const bend: Cell = { row: tgtExit.row, col: srcExit.col };
    return claimLPath(srcExit, bend, tgtExit, /*via=*/ "col-then-row",
                      cellOwner, bendOwner, vLegClaim, hLegClaim, edgeIndex, srcId, tgtId);
  }
  // Same axis, different perp — Z. Two bends, one at each end's channel.
  // The intermediate run is along the perp axis.
  //
  // For V→V (e.g. E-face → W-face on different rows): bend1 at
  // (srcExit.row, midCol), bend2 at (tgtExit.row, midCol). midCol picked
  // as the col halfway between srcExit.col and tgtExit.col, snapped to
  // an empty col where (a) both bend cells are free of node footprints
  // and prior bends, and (b) the V-leg interior cells between the two
  // bends are not already claimed by another edge's V leg.
  if (srcAxis === "V" && tgtAxis === "V") {
    // Key for the sibling tracker:
    //   - via-half edges (highway fan-out): key by srcId + direction,
    //     so ALL traces exiting the same highway in the same
    //     up/down/flat direction share one monotone stair. The bottom
    //     trace (largest srcRow, going down) turns first (smallest x),
    //     regardless of which sink it lands in. Without grouping by
    //     srcId, sink_y's 3-trace stair and sink_z's 1-trace stair pick
    //     from separate pools and the chamfers cross. Without splitting
    //     by direction, the up-going trace claims a col that the down-
    //     going ratchet skips over and breaks monotonicity.
    //   - non-via-half: key by (srcId, tgtId) as before. Lane-ordering
    //     across unrelated edge pairs would over-constrain.
    const dirTag = srcExit.row < tgtExit.row ? "D" : srcExit.row > tgtExit.row ? "U" : "F";
    const pairKey = isViaHalf ? `${srcId}|${dirTag}` : `${srcId}|${tgtId}`;
    const siblingCols = siblingMidCols.get(pairKey);
    const candidate = pickMidCol(srcExit.col, tgtExit.col, srcExit.row, tgtExit.row,
                                  cellOwner, bendOwner, vLegClaim, hLegClaim, edgeIndex, srcId, tgtId,
                                  siblingCols);
    const arr = siblingMidCols.get(pairKey);
    if (arr) arr.push(candidate);
    else siblingMidCols.set(pairKey, [candidate]);
    const bend1: Cell = { row: srcExit.row, col: candidate };
    const bend2: Cell = { row: tgtExit.row, col: candidate };
    return claimZPath(srcExit, bend1, bend2, tgtExit, /*axis=*/ "V",
                      cellOwner, bendOwner, edgeIndex, srcId, tgtId);
  }
  // srcAxis === "H" && tgtAxis === "H"
  // Same-side faces (both S or both N): standard Z's midRow sits between
  // srcExit.row and tgtExit.row, which puts the H-jog INSIDE the row
  // band of any boxes that share rows with src/tgt and routes the final
  // V leg through tgt's interior. Use a U-shape past tgt's outer edge,
  // same as the V→H wrong-side case.
  //
  // Detect via tgtSide + relative position. For tgtSide=S, the trace
  // must approach the slot going north — requires final V leg starting
  // SOUTH of tgtExit. If srcExit is NORTH of tgtExit (the normal case
  // when tgt is downstream), standard Z lands the trace from the north
  // through the body. Same logic mirrored for tgtSide=N.
  const samesideWrong =
    (tgtSide === "S" && srcExit.row < tgtExit.row) ||
    (tgtSide === "N" && srcExit.row > tgtExit.row);
  if (samesideWrong) {
    const uPath = tryUPathHHSameSide(srcExit, tgtExit, tgtSide,
                                      srcAnchor, tgtAnchor, srcW, srcH, tgtW, tgtH,
                                      cellOwner, bendOwner, vLegClaim, hLegClaim,
                                      edgeIndex, srcId, tgtId, gridRows);
    if (uPath) return uPath;
  }
  const candidate = pickMidRow(srcExit.row, tgtExit.row, srcExit.col, tgtExit.col,
                                cellOwner, bendOwner, vLegClaim, hLegClaim, edgeIndex, srcId, tgtId);
  // V-lane near search: shift bend1.col/bend2.col off srcExit.col/
  // tgtExit.col when those columns are claimed by another edge's V leg.
  // Skipped for highway via-half edges — those are intentionally packed
  // tight in the highway bundle and shifting their V columns produces
  // wider H-end claims that exhaust pickMidRow's lanes later.
  const srcVCol = isViaHalf ? srcExit.col : pickVLaneNear(srcExit.col, srcExit.row, candidate,
                                cellOwner, vLegClaim, srcId, tgtId, gridCols);
  const tgtVCol = isViaHalf ? tgtExit.col : pickVLaneNear(tgtExit.col, tgtExit.row, candidate,
                                cellOwner, vLegClaim, srcId, tgtId, gridCols);
  const bend1: Cell = { row: candidate, col: srcVCol };
  const bend2: Cell = { row: candidate, col: tgtVCol };
  return claimZPath(srcExit, bend1, bend2, tgtExit, /*axis=*/ "H",
                    cellOwner, bendOwner, edgeIndex, srcId, tgtId);
}

/**
 * Choose a V-leg column for an H→H Z trace whose V leg runs from row
 * `fromRow` to row `toRow`. The natural column is `preferredCol` (the
 * source-or-target slot's exit column). If that column's row range is
 * already claimed by another edge, shift outward by ±1 to a free lane.
 * Returns `preferredCol` as fallback if no near lane is available.
 */
function pickVLaneNear(
  preferredCol: number,
  fromRow: number,
  toRow: number,
  cellOwner: Map<string, string>,
  vLegClaim: Map<string, number>,
  srcId: string,
  tgtId: string,
  gridCols: number,
): number {
  // Zero-length V legs (fromRow === toRow) can't conflict with a V
  // claim — they're just the endpoint cell. Skip the shift to keep
  // path geometry intact when there's no V leg to dodge.
  if (fromRow === toRow) return preferredCol;
  // Progressive relaxation: 2-cell clearance → 1-cell → 0-cell. Each
  // pass tries the preferred column first, then expands outward.
  for (const clearance of [2, 1, 0]) {
    if (isVLaneFree(preferredCol, fromRow, toRow, cellOwner, vLegClaim, srcId, tgtId, clearance)) {
      return preferredCol;
    }
    for (let radius = 1; radius < 16; radius++) {
      for (const dc of [-radius, radius]) {
        const c = preferredCol + dc;
        if (c < 0) continue;
        if (c >= gridCols) continue;
        if (isVLaneFree(c, fromRow, toRow, cellOwner, vLegClaim, srcId, tgtId, clearance)) {
          return c;
        }
      }
    }
  }
  return preferredCol;
}

function claimLPath(
  srcExit: Cell,
  bend: Cell,
  tgtExit: Cell,
  via: "row-then-col" | "col-then-row",
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  edgeIndex: number,
  srcId: string,
  tgtId: string,
): Cell[] {
  // Bend at `bend`. If already claimed OR the long leg overlaps another
  // edge's claim, shift the bend along the leg's perp axis to spread
  // the traces into adjacent lanes.
  const finalBend = findFreeLBend(bend, srcExit, tgtExit, via,
                                  cellOwner, bendOwner, vLegClaim, hLegClaim, srcId, tgtId);
  if (finalBend === null) {
    throw new ChannelError(
      `E_UNROUTABLE: edge ${edgeIndex} '${srcId} -> ${tgtId}' has no available bend cell near (${bend.row}, ${bend.col})`,
    );
  }
  bendOwner.set(cellKey(finalBend.row, finalBend.col), edgeIndex);

  const path: Cell[] = [];
  if (via === "row-then-col") {
    // src on V axis: walk row from srcExit.col to finalBend.col, then col
    // from finalBend.row to tgtExit.row.
    const stepC = srcExit.col <= finalBend.col ? 1 : -1;
    for (let c = srcExit.col; ; c += stepC) {
      path.push({ row: srcExit.row, col: c });
      if (c === finalBend.col) break;
    }
    const stepR = finalBend.row <= tgtExit.row ? 1 : -1;
    if (finalBend.row !== tgtExit.row) {
      for (let r = finalBend.row + stepR; ; r += stepR) {
        path.push({ row: r, col: finalBend.col });
        if (r === tgtExit.row) break;
      }
    }
  } else {
    const stepR = srcExit.row <= finalBend.row ? 1 : -1;
    for (let r = srcExit.row; ; r += stepR) {
      path.push({ row: r, col: srcExit.col });
      if (r === finalBend.row) break;
    }
    const stepC = finalBend.col <= tgtExit.col ? 1 : -1;
    if (finalBend.col !== tgtExit.col) {
      for (let c = finalBend.col + stepC; ; c += stepC) {
        path.push({ row: finalBend.row, col: c });
        if (c === tgtExit.col) break;
      }
    }
  }
  return path;
}

function claimZPath(
  srcExit: Cell,
  bend1: Cell,
  bend2: Cell,
  tgtExit: Cell,
  axis: "V" | "H",
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  edgeIndex: number,
  srcId: string,
  tgtId: string,
): Cell[] {
  // Claim bend1 and bend2; they live on the same perp coord (col for V,
  // row for H), so they don't collide with each other in the
  // perpendicular channel run.
  bendOwner.set(cellKey(bend1.row, bend1.col), edgeIndex);
  bendOwner.set(cellKey(bend2.row, bend2.col), edgeIndex);

  const path: Cell[] = [];
  if (axis === "V") {
    // Walk row from srcExit.col to bend1.col along srcExit.row.
    const stepC1 = srcExit.col <= bend1.col ? 1 : -1;
    for (let c = srcExit.col; ; c += stepC1) {
      path.push({ row: srcExit.row, col: c });
      if (c === bend1.col) break;
    }
    // Walk col from bend1.row to bend2.row along bend1.col.
    const stepR = bend1.row <= bend2.row ? 1 : -1;
    if (bend1.row !== bend2.row) {
      for (let r = bend1.row + stepR; ; r += stepR) {
        path.push({ row: r, col: bend1.col });
        if (r === bend2.row) break;
      }
    }
    // Walk row from bend2.col to tgtExit.col along tgtExit.row.
    const stepC2 = bend2.col <= tgtExit.col ? 1 : -1;
    if (bend2.col !== tgtExit.col) {
      for (let c = bend2.col + stepC2; ; c += stepC2) {
        path.push({ row: tgtExit.row, col: c });
        if (c === tgtExit.col) break;
      }
    }
  } else {
    // H axis: mirror. If bend1.col / bend2.col have shifted off
    // srcExit.col / tgtExit.col (pickVLaneNear chose an adjacent
    // V lane to dodge a prior trace), a tiny H jog at srcExit.row /
    // tgtExit.row bridges the slot to the new V lane.
    if (srcExit.col === bend1.col) {
      // No jog — start V leg at srcExit and walk to bend1.
      const stepR1 = srcExit.row <= bend1.row ? 1 : -1;
      for (let r = srcExit.row; ; r += stepR1) {
        path.push({ row: r, col: srcExit.col });
        if (r === bend1.row) break;
      }
    } else {
      // Walk one cell V at srcExit.col so the trace clearly exits the
      // box before jogging — without this, the jog reads as a bend
      // happening AT the slot edge. Then H jog from (jogRow, srcCol)
      // to (jogRow, bend1.col), then V the rest of the way to bend1.
      const stepR1 = srcExit.row <= bend1.row ? 1 : -1;
      path.push({ row: srcExit.row, col: srcExit.col });
      const jogRow = srcExit.row + stepR1;
      // H jog along jogRow from srcExit.col to bend1.col.
      const stepCsrc = srcExit.col <= bend1.col ? 1 : -1;
      for (let c = srcExit.col; ; c += stepCsrc) {
        path.push({ row: jogRow, col: c });
        if (c === bend1.col) break;
      }
      // V from jogRow to bend1.row at bend1.col.
      if (jogRow !== bend1.row) {
        for (let r = jogRow + stepR1; ; r += stepR1) {
          path.push({ row: r, col: bend1.col });
          if (r === bend1.row) break;
        }
      }
    }
    // H leg across bend row from bend1.col to bend2.col.
    const stepC = bend1.col <= bend2.col ? 1 : -1;
    if (bend1.col !== bend2.col) {
      for (let c = bend1.col + stepC; ; c += stepC) {
        path.push({ row: bend1.row, col: c });
        if (c === bend2.col) break;
      }
    }
    // V leg from bend2.row to tgtExit.row at bend2.col.
    if (bend2.col === tgtExit.col) {
      const stepR2 = bend2.row <= tgtExit.row ? 1 : -1;
      if (bend2.row !== tgtExit.row) {
        for (let r = bend2.row + stepR2; ; r += stepR2) {
          path.push({ row: r, col: tgtExit.col });
          if (r === tgtExit.row) break;
        }
      }
    } else {
      // V from bend2 down/up at bend2.col toward tgtExit, stopping one
      // cell short so the H jog happens one cell off the target face
      // (not flush against it). Then H jog to tgtExit.col, then one
      // final V cell into tgtExit.
      const stepR2 = bend2.row <= tgtExit.row ? 1 : -1;
      const jogRow = tgtExit.row - stepR2;
      if (bend2.row !== jogRow) {
        for (let r = bend2.row + stepR2; ; r += stepR2) {
          path.push({ row: r, col: bend2.col });
          if (r === jogRow) break;
        }
      } else {
        path.push({ row: bend2.row, col: bend2.col });
      }
      const stepCtgt = bend2.col <= tgtExit.col ? 1 : -1;
      for (let c = bend2.col + stepCtgt; ; c += stepCtgt) {
        path.push({ row: jogRow, col: c });
        if (c === tgtExit.col) break;
      }
      path.push({ row: tgtExit.row, col: tgtExit.col });
    }
  }
  // Cell-owner guard — silence unused warning; cell-occupancy along Z
  // legs is checked by recordChannelTraces (which only registers traces
  // through empty cells). A blocked Z surfaces as a wall at the bend
  // search above.
  void cellOwner;
  void srcId;
  void tgtId;
  return path;
}

/**
 * Search for an unclaimed bend cell near `preferred`. We try the
 * preferred cell first; if claimed by another edge, expand outward along
 * the row by ±1 cell at a time until we find a free cell whose row/col
 * are not blocked by node footprints between src and tgt.
 *
 * Returns null if nothing within a sane range works.
 */
/**
 * L-path bend search with lane awareness. Tries the preferred bend
 * first; if either the bend cell is claimed OR the long leg overlaps
 * another edge's V/H leg, shifts the bend along the LEG's perp axis
 * (i.e. for a row-then-col L the V leg sits on a column, so shift col).
 * Falls back to the side-search radius if the leg axis is fully claimed.
 */
function findFreeLBend(
  preferred: Cell,
  srcExit: Cell,
  tgtExit: Cell,
  via: "row-then-col" | "col-then-row",
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  srcId: string,
  tgtId: string,
): Cell | null {
  // For "row-then-col": long leg is V at `bend.col`, spanning rows
  // `bend.row..tgtExit.row`. Shifting bend.col moves the V leg.
  // For "col-then-row": long leg is H at `bend.row`, spanning cols
  // `bend.col..tgtExit.col`. Shifting bend.row moves the H leg.
  const isRowThenCol = via === "row-then-col";
  for (let radius = 0; radius < 32; radius++) {
    for (const d of radius === 0 ? [0] : [-radius, radius]) {
      const candidate: Cell = isRowThenCol
        ? { row: preferred.row, col: preferred.col + d }
        : { row: preferred.row + d, col: preferred.col };
      if (candidate.col < 0 || candidate.row < 0) continue;
      if (!isBendFree(candidate, cellOwner, bendOwner, srcId, tgtId)) continue;
      // Check the long leg between the candidate bend and the
      // *opposite* end (tgtExit for row-then-col leg, since the V leg
      // runs from candidate.row to tgtExit.row at candidate.col).
      if (isRowThenCol) {
        if (!isVLaneFree(candidate.col, candidate.row, tgtExit.row,
                         cellOwner, vLegClaim, srcId, tgtId)) continue;
      } else {
        if (!isHLaneFree(candidate.row, candidate.col, tgtExit.col,
                         cellOwner, hLegClaim, srcId, tgtId)) continue;
      }
      // Also verify the short leg from srcExit to the bend (along the
      // *other* axis) is clear of claims at the corner row/col.
      if (isRowThenCol) {
        if (!isHLaneFree(srcExit.row, srcExit.col, candidate.col,
                         cellOwner, hLegClaim, srcId, tgtId)) continue;
      } else {
        if (!isVLaneFree(srcExit.col, srcExit.row, candidate.row,
                         cellOwner, vLegClaim, srcId, tgtId)) continue;
      }
      return candidate;
    }
  }
  return null;
}

function findFreeBend(
  preferred: Cell,
  _srcExit: Cell,
  _tgtExit: Cell,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  srcId: string,
  tgtId: string,
): Cell | null {
  if (isBendFree(preferred, cellOwner, bendOwner, srcId, tgtId)) return preferred;
  // Expand outward by 1, 2, 3... cells along col then row.
  for (let radius = 1; radius < 32; radius++) {
    for (const dc of [-radius, radius]) {
      const c: Cell = { row: preferred.row, col: preferred.col + dc };
      if (c.col >= 0 && isBendFree(c, cellOwner, bendOwner, srcId, tgtId)) return c;
    }
    for (const dr of [-radius, radius]) {
      const c: Cell = { row: preferred.row + dr, col: preferred.col };
      if (c.row >= 0 && isBendFree(c, cellOwner, bendOwner, srcId, tgtId)) return c;
    }
  }
  return null;
}

function isBendFree(
  cell: Cell,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  srcId: string,
  tgtId: string,
): boolean {
  const k = cellKey(cell.row, cell.col);
  if (bendOwner.has(k)) return false;
  const owner = cellOwner.get(k);
  if (owner !== undefined && owner !== srcId && owner !== tgtId) return false;
  return true;
}

function pickMidCol(
  srcCol: number,
  tgtCol: number,
  row1: number,
  row2: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  _edgeIndex: number,
  srcId: string,
  tgtId: string,
  siblingCols: number[] | undefined,
): number {
  // Lane ordering: a fan-out (or bus, or any cluster of parallel V
  // traces) needs lanes assigned in monotonic order so the H exit runs
  // don't cross. The source-row already encodes that order (slot N
  // exits row sourceRow+N). For a trace targeting a row ABOVE the
  // source (row2 < row1), bias toward the LEFT side of the corridor;
  // targeting BELOW, bias RIGHT. This preserves the slot fan natural
  // sort. The midpoint heuristic alone produced lane-crossings because
  // every trace started from the same column.
  const lo = Math.min(srcCol, tgtCol);
  const hi = Math.max(srcCol, tgtCol);
  // Sweep direction: outward-from-lo when target is above src, outward-
  // from-hi when target is below. Identical srcRow/tgtRow (rare) falls
  // back to midpoint.
  //
  // Sibling rule: for 3+ V-V Z traces sharing the same (src, tgt) pair,
  // each successive bend col must lie STRICTLY past the prior extremum
  // so the corner chamfers form a clean stair instead of overlapping.
  //   goingDown: new col < min(siblingCols)  (sweep leftward, ratcheting)
  //   goingUp:   new col > max(siblingCols)  (sweep rightward, ratcheting)
  // Two-sibling case still satisfies this — the second sibling lands
  // one cell beyond the first. The original "sweep from opposite end"
  // was a 2-trace approximation that broke at 3+: top picked hi-1,
  // middle picked lo+1, bottom picked lo+1 → hi-1 (claim-pushed back)
  // and clashed with top.
  const goingUp = row2 < row1;
  const goingDown = row2 > row1;
  let start: number;
  let step: number;
  if (siblingCols !== undefined && siblingCols.length > 0) {
    if (goingUp) {
      start = Math.max(...siblingCols) + 1;
      step = +1;
    } else {
      // goingDown or flat: ratchet leftward past the leftmost prior.
      start = Math.min(...siblingCols) - 1;
      step = -1;
    }
  } else {
    start = goingUp ? lo + 1 : goingDown ? hi - 1 : Math.round((srcCol + tgtCol) / 2);
    step = goingUp ? +1 : goingDown ? -1 : 0;
  }
  // Progressive relaxation: 2-cell clearance → 1-cell → 0-cell, then
  // drop the face-clearance rule. Each pass tries every column at the
  // current clearance level before relaxing.
  for (const clearance of [2, 1, 0]) {
    for (let radius = 0; radius < 32; radius++) {
      const cands = step !== 0 ? [start + step * radius] : (radius === 0 ? [start] : [start - radius, start + radius]);
      for (const c of cands) {
        if (c < lo || c > hi) continue;
        if (Math.abs(c - tgtCol) < 1) continue;
        if (Math.abs(c - srcCol) < 1) continue;
        if (!midColFits(c, row1, row2, cellOwner, bendOwner, vLegClaim, srcId, tgtId, clearance)) continue;
        return c;
      }
    }
  }
  // Final fallback: drop face clearance too.
  for (let radius = 0; radius < 32; radius++) {
    const cands = step !== 0 ? [start + step * radius] : (radius === 0 ? [start] : [start - radius, start + radius]);
    for (const c of cands) {
      if (c < lo || c > hi) continue;
      if (!midColFits(c, row1, row2, cellOwner, bendOwner, vLegClaim, srcId, tgtId)) continue;
      return c;
    }
  }
  // Pass 3: corridor genuinely full. Bail loudly so the placer/source
  // can be widened — silently overlapping traces is a worse outcome.
  throw new ChannelError(
    `E_LANE_FULL: edge '${srcId} -> ${tgtId}' has no free V-channel column ` +
    `between cols ${lo}..${hi} for rows ${Math.min(row1, row2)}..${Math.max(row1, row2)}. ` +
    `Widen the gap between '${srcId}' and '${tgtId}' (insert an empty column or resize a neighbour).`,
  );
}

function midColFits(
  c: number,
  row1: number,
  row2: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  srcId: string,
  tgtId: string,
  clearance: number = 0,
): boolean {
  if (c < 0) return false;
  const b1: Cell = { row: row1, col: c };
  const b2: Cell = { row: row2, col: c };
  if (!isBendFree(b1, cellOwner, bendOwner, srcId, tgtId)) return false;
  if (!isBendFree(b2, cellOwner, bendOwner, srcId, tgtId)) return false;
  if (!isVLaneFree(c, row1, row2, cellOwner, vLegClaim, srcId, tgtId, clearance)) return false;
  return true;
}

/**
 * After a cell path is finalised, stake the interior cells of each long
 * leg in `legClaim` so subsequent edges' `pickMidCol` / `pickMidRow`
 * skip this lane and shift to ±1. Bend cells are owned by `bendOwner`
 * and not staked here.
 */
function claimLegCells(
  cellPath: Cell[],
  edgeIndex: number,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
): void {
  // Walk pairs and classify each segment: shared col → V move (claim
  // EVERY cell in the segment into vLegClaim, not just endpoints);
  // shared row → H move (claim every cell into hLegClaim). A V trace
  // crossing an H trace at the same cell is a legal crossing — they
  // don't conflict in the same map.
  for (let i = 1; i < cellPath.length; i++) {
    const a = cellPath[i - 1]!;
    const b = cellPath[i]!;
    if (a.col === b.col) {
      // V segment: claim every row between a and b at this col.
      const lo = Math.min(a.row, b.row);
      const hi = Math.max(a.row, b.row);
      for (let r = lo; r <= hi; r++) {
        const k = cellKey(r, a.col);
        if (!vLegClaim.has(k)) vLegClaim.set(k, edgeIndex);
      }
    } else if (a.row === b.row) {
      // H segment: claim every col between a and b at this row.
      const lo = Math.min(a.col, b.col);
      const hi = Math.max(a.col, b.col);
      for (let c = lo; c <= hi; c++) {
        const k = cellKey(a.row, c);
        if (!hLegClaim.has(k)) hLegClaim.set(k, edgeIndex);
      }
    }
  }
}

/** Cells of buffer between a V/H trace and the nearest node footprint. */
const LANE_CLEARANCE = 2;

function isVLaneFree(
  col: number,
  row1: number,
  row2: number,
  cellOwner: Map<string, string>,
  vLegClaim: Map<string, number>,
  _srcId: string,
  tgtId: string,
  clearance: number = 0,
): boolean {
  const lo = Math.min(row1, row2);
  const hi = Math.max(row1, row2);
  for (let r = lo; r <= hi; r++) {
    const k = cellKey(r, col);
    if (vLegClaim.has(k)) return false;
    if (cellOwner.has(k)) return false;
    // Tgt-side bend row: at row2 (= tgtExit.row), the V leg meets the
    // H leg landing on tgt's face. Clearance from tgt at row2 would
    // forbid the col adjacent to tgt — the best lane for the outer
    // sibling and the one that avoids sibling crossings (see ex 27's
    // src_a via traces, which used to cross because slot 0 fell back
    // to the inner col when this rule blocked the outer one).
    //
    // Src-side clearance at row1 is KEPT. Relaxing it lets every V
    // leg pick the col adjacent to src and exhausts the corridor for
    // the far side (see ex 23: 4 hwy→sink_X edges share rows; if any
    // claims col srcCol+1, the next runs out of lanes). The dst side
    // crossing-avoidance for hwy→dst is handled by `siblingOppositeCol`
    // in pickMidCol, which reverses the sweep direction when a prior
    // sibling already claimed a col.
    const atTgtBend = r === row2;
    for (let d = 1; d <= clearance; d++) {
      const left = cellOwner.get(cellKey(r, col - d));
      if (left !== undefined && !(atTgtBend && left === tgtId)) return false;
      const right = cellOwner.get(cellKey(r, col + d));
      if (right !== undefined && !(atTgtBend && right === tgtId)) return false;
    }
  }
  return true;
}

function isHLaneFree(
  row: number,
  col1: number,
  col2: number,
  cellOwner: Map<string, string>,
  hLegClaim: Map<string, number>,
  _srcId: string,
  tgtId: string,
  clearance: number = 0,
): boolean {
  const lo = Math.min(col1, col2);
  const hi = Math.max(col1, col2);
  for (let c = lo; c <= hi; c++) {
    const k = cellKey(row, c);
    if (hLegClaim.has(k)) return false;
    if (cellOwner.has(k)) return false;
    // Mirror of isVLaneFree's tgt-bend-only rule: at col2 (= tgtExit.col),
    // tgt clearance is skipped; src clearance and unrelated footprints
    // still apply.
    const atTgtBend = c === col2;
    for (let d = 1; d <= clearance; d++) {
      const above = cellOwner.get(cellKey(row - d, c));
      if (above !== undefined && !(atTgtBend && above === tgtId)) return false;
      const below = cellOwner.get(cellKey(row + d, c));
      if (below !== undefined && !(atTgtBend && below === tgtId)) return false;
    }
  }
  return true;
}

function pickMidRow(
  srcRow: number,
  tgtRow: number,
  col1: number,
  col2: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  vLegClaim: Map<string, number>,
  hLegClaim: Map<string, number>,
  _edgeIndex: number,
  srcId: string,
  tgtId: string,
): number {
  // Lane ordering by target-col position (mirror of pickMidCol).
  const lo = Math.min(srcRow, tgtRow);
  const hi = Math.max(srcRow, tgtRow);
  const goingLeft = col2 < col1;
  const goingRight = col2 > col1;
  const start = goingLeft ? lo + 1 : goingRight ? hi - 1 : Math.round((srcRow + tgtRow) / 2);
  const step = goingLeft ? +1 : goingRight ? -1 : 0;
  // Progressive relaxation: 2-cell clearance → 1-cell → 0-cell.
  for (const clearance of [2, 1, 0]) {
    for (let radius = 0; radius < 32; radius++) {
      const cands = step !== 0 ? [start + step * radius] : (radius === 0 ? [start] : [start - radius, start + radius]);
      for (const r of cands) {
        if (r < lo || r > hi) continue;
        if (Math.abs(r - tgtRow) < 1) continue;
        if (Math.abs(r - srcRow) < 1) continue;
        if (!midRowFits(r, col1, col2, cellOwner, bendOwner, hLegClaim, srcId, tgtId, clearance)) continue;
        return r;
      }
    }
  }
  // Final fallback: drop face clearance too.
  for (let radius = 0; radius < 32; radius++) {
    const cands = step !== 0 ? [start + step * radius] : (radius === 0 ? [start] : [start - radius, start + radius]);
    for (const r of cands) {
      if (r < lo || r > hi) continue;
      if (!midRowFits(r, col1, col2, cellOwner, bendOwner, hLegClaim, srcId, tgtId)) continue;
      return r;
    }
  }
  throw new ChannelError(
    `E_LANE_FULL: edge '${srcId} -> ${tgtId}' has no free H-channel row ` +
    `between rows ${lo}..${hi} for cols ${Math.min(col1, col2)}..${Math.max(col1, col2)}. ` +
    `Widen the gap between '${srcId}' and '${tgtId}' (insert an empty row or resize a neighbour).`,
  );
}

function midRowFits(
  r: number,
  col1: number,
  col2: number,
  cellOwner: Map<string, string>,
  bendOwner: Map<string, number>,
  hLegClaim: Map<string, number>,
  srcId: string,
  tgtId: string,
  clearance: number = 0,
): boolean {
  if (r < 0) return false;
  const b1: Cell = { row: r, col: col1 };
  const b2: Cell = { row: r, col: col2 };
  if (!isBendFree(b1, cellOwner, bendOwner, srcId, tgtId)) return false;
  if (!isBendFree(b2, cellOwner, bendOwner, srcId, tgtId)) return false;
  if (!isHLaneFree(r, col1, col2, cellOwner, hLegClaim, srcId, tgtId, clearance)) return false;
  return true;
}

// --- pixelize -------------------------------------------------------------

/**
 * Convert a cell path to pixel waypoints. Emits one waypoint per
 * straight run (not per cell) — the trace holds the slot's perp coord
 * until each turn, then snaps to the next channel's perp coord at the
 * bend cell.
 *
 * Run boundaries: a "turn" happens between cellPath[i-1]→[i] and
 * [i]→[i+1] when the shared axis flips (row-shared to col-shared, or
 * vice versa). The cell at the turn is a *bend cell*.
 *
 * Perp coord per leg:
 *   - leg sharing a row (horizontal walk in an H-channel): perp = y =
 *     a constant pixel y — the *slot* y on legs adjacent to a slot,
 *     the bend row's cell-center y on interior legs.
 *   - leg sharing a col (vertical walk in a V-channel): perp = x =
 *     the bend col's cell-center x.
 *
 * For a same-row straight trace, no bend → just src + tgt slots.
 */
function pixelizeCellPath(
  srcSlotPx: Point,
  tgtSlotPx: Point,
  cellPath: Cell[],
  layout: PixelLayout,
  _srcSide: Side,
  _tgtSide: Side,
): Point[] {
  if (cellPath.length === 0) return [srcSlotPx, tgtSlotPx];
  if (cellPath.length === 1) {
    // Source-and-target slots reachable through the single exit cell.
    // Just connect slot-to-slot through one corner so the SVG path has
    // a segment to stroke (chamfering will produce the final shape).
    return dedupe([srcSlotPx, tgtSlotPx]);
  }

  // Identify the bend cells: each transition where the shared-axis flips.
  // For a Manhattan path, consecutive cells always share exactly one of
  // (row, col). A bend is where the *shared axis* changes between
  // (i-1, i) and (i, i+1).
  const bendIndices: number[] = [];
  for (let i = 1; i < cellPath.length - 1; i++) {
    const prev = cellPath[i - 1]!;
    const here = cellPath[i]!;
    const next = cellPath[i + 1]!;
    const prevSharesRow = prev.row === here.row;
    const nextSharesRow = here.row === next.row;
    if (prevSharesRow !== nextSharesRow) bendIndices.push(i);
  }

  // Degenerate-Z dogleg: a single-axis cellPath whose endpoint slots have
  // different perp pixel coords. The cell-grid can't represent the
  // fractional offset (both slots resolve to the same row/col), so the
  // pixelizer would emit a diagonal. Insert a 90° jog midway: walk
  // perpendicular for half the run, cross over, continue. Produces a
  // Z-shape in pixel space.
  const first = cellPath[0]!;
  const last = cellPath[cellPath.length - 1]!;
  const sameRow = first.row === last.row;
  const sameCol = first.col === last.col;
  if (bendIndices.length === 0) {
    if (sameRow && srcSlotPx.y !== tgtSlotPx.y) {
      // H run with vertical jog — emit src → midX-at-srcY → midX-at-tgtY → tgt.
      const midX = (srcSlotPx.x + tgtSlotPx.x) / 2;
      return dedupe([
        srcSlotPx,
        { x: midX, y: srcSlotPx.y },
        { x: midX, y: tgtSlotPx.y },
        tgtSlotPx,
      ]);
    }
    if (sameCol && srcSlotPx.x !== tgtSlotPx.x) {
      const midY = (srcSlotPx.y + tgtSlotPx.y) / 2;
      return dedupe([
        srcSlotPx,
        { x: srcSlotPx.x, y: midY },
        { x: tgtSlotPx.x, y: midY },
        tgtSlotPx,
      ]);
    }
  }

  const cellCx = (c: Cell) => layout.colX[c.col]! + CELL_PX / 2;
  const cellCy = (c: Cell) => layout.rowY[c.row]! + CELL_PX / 2;

  // Build waypoints by walking leg by leg. A leg goes from one
  // boundary (slot or prior bend) to the next (slot or next bend).
  //
  // The trace's perp coord on the *first* leg is the source slot's y
  // (for V channel) or x (for H channel) — held constant from the
  // slot pixel along the channel.
  // After the first bend, the perp coord switches to the bend col's
  // cell-center x (or row's cell-center y) — the channel center —
  // until the next bend or final slot.
  // The *last* leg uses the target slot's perp coord.
  //
  // For a single-bend L-shape: 4 waypoints total (slot, corner1,
  // corner2, slot). corner1 = (bend.x, srcSlot.y). corner2 = (bend.x,
  // tgtSlot.y) — same x, different y → vertical segment between them.
  // Wait, that's wrong for an L: corner1 should = (bendCenterX,
  // srcSlot.y) and corner2 should = (bendCenterX, tgtSlot.y) only when
  // src side is V and tgt side is H. Each bend cell has ONE corner
  // point: the intersection of the trace's two perpendicular legs.

  const out: Point[] = [srcSlotPx];

  // Determine each leg's axis (V = column-aligned vertical run, H =
  // row-aligned horizontal run) by looking at the cells it spans.
  // Leg k covers cellPath indices [legStarts[k], legStarts[k+1]].
  const legStarts: number[] = [0, ...bendIndices, cellPath.length - 1];

  // For leg k, the perp coord is the slot pixel's perp on the boundary
  // legs (k === 0 from srcSlotPx, k === last from tgtSlotPx) and the
  // channel-center on intermediate bend cells. Holding the slot pixel
  // through the boundary leg means a slot on a cell boundary (fractional
  // slot index) doesn't get a 4-px lateral chamfer the moment the trace
  // exits the box. Same rationale on the last leg lets the trace land
  // square on the target face (so marker-end orients along the face
  // normal, not a horizontal stub).
  //
  // Note: for a single-leg cellPath where k=0 IS k=last, the first-leg
  // branch wins; the trailing slot endpoint is appended separately and
  // any mismatch becomes a final jog handled by the bend-emission below.
  const perpOfLeg = (k: number): { axis: "V" | "H"; coord: number } => {
    const startIdx = legStarts[k]!;
    const endIdx = legStarts[k + 1]!;
    const a = cellPath[startIdx]!;
    const b = cellPath[endIdx]!;
    const axis: "V" | "H" = a.col === b.col ? "V" : "H";
    if (k === 0) {
      return { axis, coord: axis === "V" ? srcSlotPx.x : srcSlotPx.y };
    }
    if (k === legStarts.length - 2) {
      // Last leg's perp coord: if the leg's channel cell aligns with the
      // tgt slot's perp (within half a cell), snap to the slot pixel so
      // the trailing segment lands square on the face. Otherwise the
      // leg's channel pixel is at cellCx(a) — the routed channel — and
      // the L-jog code below adds a final perp hop into the slot. This
      // matters when findFreeLBend pushed the bend col away from the
      // target's footprint (e.g. query→orders_rm.S routes around the
      // body of orders_rm and approaches from below).
      // Last leg's perp coord: when the cellPath's last leg sits in the
      // same cell column/row as the target slot (or adjacent — within
      // one cell), snap to the slot pixel so the arrow lands square on
      // the face. This is the common case and lets fractional slots /
      // shim-shifted slots still terminate dead-on the face.
      //
      // When the cellPath's last leg is FAR from the slot's col/row
      // (>1 cell), `findFreeLBend` or `pickMidCol` deliberately routed
      // the bend AWAY from the target — typically to avoid cutting
      // through the target's own footprint (e.g. query→orders_rm.S
      // entering from below with the V leg west of orders_rm). In that
      // case keep the channel coord; the L-jog code below adds a final
      // perp hop into the slot.
      const slotPerp = axis === "V" ? tgtSlotPx.x : tgtSlotPx.y;
      const slotCell = axis === "V"
        ? Math.floor(tgtSlotPx.x / CELL_PX)
        : Math.floor(tgtSlotPx.y / CELL_PX);
      const channelCell = axis === "V" ? a.col : a.row;
      const channelPerp = axis === "V" ? cellCx(a) : cellCy(a);
      const useSlot = Math.abs(slotCell - channelCell) <= 1;
      return { axis, coord: useSlot ? slotPerp : channelPerp };
    }
    return { axis, coord: axis === "V" ? cellCx(a) : cellCy(a) };
  };

  // Walk the legs, emitting a corner waypoint at each bend.
  for (let k = 0; k < legStarts.length - 1; k++) {
    const leg = perpOfLeg(k);
    const nextLeg = k + 1 < legStarts.length - 1 ? perpOfLeg(k + 1) : null;
    if (k === 0) {
      // First waypoint after source slot: slot pixel projected onto
      // the channel along the long axis. For a V leg, perp = x — so
      // the corner is (channelX, slotY). For an H leg, (slotX, channelY).
      if (leg.axis === "V") out.push({ x: leg.coord, y: srcSlotPx.y });
      else out.push({ x: srcSlotPx.x, y: leg.coord });
    }
    if (nextLeg !== null) {
      // Bend corner: intersection of this leg's channel and next leg's
      // channel. The bend cell is at cellPath[legStarts[k+1]].
      const bendCell = cellPath[legStarts[k + 1]!]!;
      const corner = legCornerAt(leg, nextLeg, bendCell, cellCx, cellCy);
      out.push(corner);
    } else {
      // Last leg → target slot. If the leg's channel-perp coord differs
      // from the target slot's perp (e.g. V leg on channel col 13 with
      // target slot on col 14's W boundary), the leg's channel pixel
      // doesn't terminate at the slot. Emit an L-jog: walk along the
      // leg to the target's long-axis coord, then perpendicular to the
      // slot. Without this jog the trailing segment is diagonal.
      const tgtPerp = leg.axis === "V" ? tgtSlotPx.x : tgtSlotPx.y;
      if (leg.coord !== tgtPerp) {
        // For a V last leg: arrive at (leg.coord, tgtSlotPx.y) then jog
        // horizontally to tgtSlotPx.x. For H last leg: mirror.
        if (leg.axis === "V") out.push({ x: leg.coord, y: tgtSlotPx.y });
        else out.push({ x: tgtSlotPx.x, y: leg.coord });
      }
    }
  }

  out.push(tgtSlotPx);
  return dedupe(out);
}

/**
 * Corner point where a V-axis leg meets an H-axis leg at a bend cell.
 * Returns `(V-leg's x, H-leg's y)`.
 */
function legCornerAt(
  leg: { axis: "V" | "H"; coord: number },
  nextLeg: { axis: "V" | "H"; coord: number },
  _bendCell: Cell,
  _cellCx: (c: Cell) => number,
  _cellCy: (c: Cell) => number,
): Point {
  // leg.axis === "V" → leg.coord is x, nextLeg.coord is y.
  // leg.axis === "H" → leg.coord is y, nextLeg.coord is x.
  if (leg.axis === "V") {
    return { x: leg.coord, y: nextLeg.coord };
  }
  return { x: nextLeg.coord, y: leg.coord };
}

// --- chamfer --------------------------------------------------------------

function chamferBends(points: Point[]): Point[] {
  if (points.length < 3) return dedupe(points);
  const r0 = COMB_PITCH / 2;
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const here = points[i]!;
    const next = points[i + 1]!;
    const lenIn = Math.hypot(here.x - prev.x, here.y - prev.y);
    const lenOut = Math.hypot(next.x - here.x, next.y - here.y);
    if (lenIn === 0 || lenOut === 0) { out.push(here); continue; }
    const dInX = (here.x - prev.x) / lenIn;
    const dInY = (here.y - prev.y) / lenIn;
    const dOutX = (next.x - here.x) / lenOut;
    const dOutY = (next.y - here.y) / lenOut;
    const cross = dInX * dOutY - dInY * dOutX;
    if (Math.abs(cross) < 1e-9) continue; // collinear, drop
    const r = Math.min(r0, lenIn / 2, lenOut / 2);
    if (r <= 0) { out.push(here); continue; }
    out.push({ x: here.x - r * dInX, y: here.y - r * dInY });
    out.push({ x: here.x + r * dOutX, y: here.y + r * dOutY });
  }
  out.push(points[points.length - 1]!);
  return dedupe(out);
}

function dedupe(pts: Point[]): Point[] {
  if (pts.length === 0) return pts;
  const out: Point[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1]!;
    const b = pts[i]!;
    if (Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001) continue;
    out.push(b);
  }
  return out;
}

// --- channel-trace bookkeeping --------------------------------------------

interface ChannelTrace {
  edgeIndex: number;
  /** Long-axis range start (row for V, col for H). */
  start: number;
  /** Long-axis range end. */
  end: number;
}

function recordChannelTraces(
  cellPath: Cell[],
  edgeIndex: number,
  vChannelTraces: Map<number, ChannelTrace[]>,
  hChannelTraces: Map<number, ChannelTrace[]>,
): void {
  // Walk the path and emit a (channel, range) record per straight run.
  if (cellPath.length < 2) return;
  let runStart = 0;
  for (let i = 1; i < cellPath.length; i++) {
    const a = cellPath[i - 1]!;
    const b = cellPath[i]!;
    const c = cellPath[runStart]!;
    const sharedRow = a.row === b.row && b.row === c.row;
    const sharedCol = a.col === b.col && b.col === c.col;
    if (!sharedRow && !sharedCol) {
      // Emit the run [runStart .. i-1] and start a new one at i-1.
      emitRun(cellPath, runStart, i - 1, edgeIndex, vChannelTraces, hChannelTraces);
      runStart = i - 1;
    }
  }
  emitRun(cellPath, runStart, cellPath.length - 1, edgeIndex, vChannelTraces, hChannelTraces);
}

function emitRun(
  path: Cell[],
  startIdx: number,
  endIdx: number,
  edgeIndex: number,
  vChannelTraces: Map<number, ChannelTrace[]>,
  hChannelTraces: Map<number, ChannelTrace[]>,
): void {
  if (startIdx >= endIdx) return;
  const first = path[startIdx]!;
  const last = path[endIdx]!;
  if (first.col === last.col) {
    // V channel at col `first.col`, range = rows.
    const col = first.col;
    const list = vChannelTraces.get(col) ?? [];
    list.push({ edgeIndex, start: first.row, end: last.row });
    vChannelTraces.set(col, list);
  } else if (first.row === last.row) {
    const row = first.row;
    const list = hChannelTraces.get(row) ?? [];
    list.push({ edgeIndex, start: first.col, end: last.col });
    hChannelTraces.set(row, list);
  }
}

// --- key helper -----------------------------------------------------------

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}
