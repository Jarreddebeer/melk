/**
 * Phase 4 slot allocator (channel-routing model).
 *
 * Input: bound `Model` + the `Placement` from §2.
 * Output: per-edge `SlotAssignment` carrying side + slot on each endpoint.
 *
 * This module owns the parts of the legacy `corridors.ts` that survive the
 * channel-routing rewrite (DESIGN-PHASE4.md §3):
 *   - side assignment from edge forward direction (§3.4 / §6.4),
 *   - slot index per face under the uniform-flux ordering rule (§3.5),
 *   - back-edge slot segregation,
 *   - module-face override for qualified imports,
 *   - author-side overrides (§11.10),
 *   - highway through-trace slot mirroring (§11.9 v2),
 *   - declaration-order slot ordering (§11.12).
 *
 * The corridor-sequence concept is gone — channel routing picks bend cells
 * geometrically, so slot ordering no longer depends on a per-edge pivot
 * coord. The remaining ordering keys are spatial (oppositePerp of the
 * other endpoint) + via-half eventual-endpoint refinement + declaration
 * order. See `assignSlots` for details.
 */
import type { Model } from "../bind/model.js";
import type { Cell, Direction, Placement } from "./placement.js";

// --- public types ---------------------------------------------------------

/**
 * The four cardinal sides of a box. Slot ports sit perpendicular to the
 * side they're on; traces enter/exit horizontally on E/W sides and
 * vertically on N/S sides (DESIGN §1.3).
 */
export type Side = "N" | "E" | "S" | "W";

/**
 * Per-edge slot assignment. `sourceSlot`/`targetSlot` are fractional indices
 * into the comb teeth on each face — `slot * COMB_PITCH + COMB_PITCH/2`
 * gives the perpendicular pixel offset from the face's start corner.
 *
 * The edge identity is referenced by index into `Model.edges` so downstream
 * passes can correlate back to provenance.
 */
export interface SlotAssignment {
  edgeIndex: number;
  sourceSide: Side;
  sourceSlot: number;
  targetSide: Side;
  targetSlot: number;
}

export class SlotError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// --- constants ------------------------------------------------------------

/**
 * Render-time pitch values. **Cells are slots:** `CELL_PX = COMB_PITCH = 8`.
 * Moving a node from row r to row r+1 shifts it by exactly one slot
 * position, so adjacent boxes' slots align by construction with no
 * centering math (feedback-cell-equals-slot).
 *
 * Default node size is 5x5 (40×40 px). Odd dimensions put a single-trace
 * centered slot at the middle cell's center.
 */
export const COMB_PITCH = 8;
export const CELL_PX = 8;

// --- entry point ----------------------------------------------------------

/**
 * Pure function from `Model` + `Placement` to per-edge slot assignments.
 * Same input always produces the same output, byte-for-byte (DESIGN §7.2).
 *
 * Pipeline:
 *   1. For every edge: compute edge-forward direction, then derive
 *      sourceSide / targetSide. Apply module-face and author overrides.
 *   2. Group edge endpoints by (nodeId, side) and assign slot indices in
 *      uniform-flux order: bucket by oppositePerp (spatial order of the
 *      other endpoint on the perpendicular axis), tiebreak by via-half
 *      eventualPerp, then declaration order. Forwards land in a centered
 *      cluster; back-edges land in the outer slots above the cluster.
 *   3. Mirror highway through-traces: a via-half second leg's source slot
 *      equals its first leg's target slot on the highway, so the trace
 *      runs straight through the highway box.
 */
export function assignSlots(
  model: Model,
  placement: Placement,
): Map<number, SlotAssignment> {
  // Per-edge invariants: forward direction + sides + cells.
  type EdgeCtx = {
    src: Cell;
    tgt: Cell;
    sides: { sourceSide: Side; targetSide: Side };
  };
  const edgeCtxs: EdgeCtx[] = [];
  for (let i = 0; i < model.edges.length; i++) {
    const edge = model.edges[i]!;
    const src = placement.cells.get(edge.from);
    const tgt = placement.cells.get(edge.to);
    if (!src || !tgt) {
      throw new SlotError(
        `internal: edge '${edge.from} -> ${edge.to}' has unplaced endpoint`,
      );
    }
    // Edge forward direction (DESIGN §2.5):
    //   - back-edge: opposite of the source node's local forward — the
    //     trace leaves the rear face and wraps around.
    //   - structured edge (pipeline/bus/fan-out/branch): the *target*
    //     node's local forward. Captures the primitive's intent and
    //     keeps bus producers exiting on the correct side even when
    //     they're off-median diagonal to the shared sink.
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
      edgeFwd = tgtLocalFwd;
    }
    const sides = assignSides(edgeFwd);
    // DESIGN-PHASE5-MODULES.md §4.6 — for edges with a qualified module
    // endpoint, pick the module face that points toward the other
    // endpoint AND is closest to the internal node's position.
    if (edge.fromInternal !== undefined) {
      const fromMod = model.imports.find((m) => m.alias === edge.from);
      const port = fromMod?.ports?.get(edge.fromInternal);
      if (fromMod !== undefined && port !== undefined &&
          fromMod.pixelWidth !== undefined && fromMod.pixelHeight !== undefined) {
        sides.sourceSide = pickModuleFaceForInternal(
          port.localX, port.localY,
          fromMod.pixelWidth, fromMod.pixelHeight,
          tgt.row - src.row, tgt.col - src.col,
        );
      }
    }
    if (edge.toInternal !== undefined) {
      const toMod = model.imports.find((m) => m.alias === edge.to);
      const port = toMod?.ports?.get(edge.toInternal);
      if (toMod !== undefined && port !== undefined &&
          toMod.pixelWidth !== undefined && toMod.pixelHeight !== undefined) {
        sides.targetSide = pickModuleFaceForInternal(
          port.localX, port.localY,
          toMod.pixelWidth, toMod.pixelHeight,
          src.row - tgt.row, src.col - tgt.col,
        );
      }
    }
    // §11.10: author can override either or both endpoint faces.
    if (edge.exitSide !== undefined) sides.sourceSide = edge.exitSide as Side;
    if (edge.entrySide !== undefined) sides.targetSide = edge.entrySide as Side;
    edgeCtxs.push({ src, tgt, sides });
  }

  // Slot index per (nodeId, side, edgeIndex, endpoint) — accumulated
  // through the per-face allocator below.
  const slotMap = new Map<string, number>();

  // Group pending endpoints by (nodeId, side).
  type Pending = {
    edgeIndex: number;
    endpoint: "from" | "to";
    oppositePerp: number;
    /**
     * Via-half-only refinement: perp of the EVENTUAL endpoint (the
     * non-highway endpoint on the OTHER half). Used as a secondary
     * sort key so single-bundle traces order by spatial target instead
     * of declaration order. For non-via edges this equals oppositePerp.
     */
    eventualPerp: number;
    /** True if the edge is a back-edge (wraps through page margin). */
    isBack: boolean;
  };
  const bySide = new Map<string, Pending[]>();

  // §11.9 v2: paired via-halves so we can promote the eventual endpoint
  // perp into the secondary sort key.
  const viaPairs = new Map<number, { firstIdx: number; secondIdx: number }>();
  for (let i = 0; i < model.edges.length; i++) {
    const e = model.edges[i]!;
    if (e.source !== "via-half" || e.viaOriginal === undefined) continue;
    const existing = viaPairs.get(e.viaOriginal) ?? { firstIdx: -1, secondIdx: -1 };
    if (e.viaFirstHalf) existing.firstIdx = i;
    else existing.secondIdx = i;
    viaPairs.set(e.viaOriginal, existing);
  }

  for (let i = 0; i < edgeCtxs.length; i++) {
    const ctx = edgeCtxs[i]!;
    const edge = model.edges[i]!;
    const srcCell = ctx.src;
    const tgtCell = ctx.tgt;
    const srcKey = `${edge.from}|${ctx.sides.sourceSide}`;
    const tgtKey = `${edge.to}|${ctx.sides.targetSide}`;
    const isBack = !!edge.isBackEdge;
    if (!bySide.has(srcKey)) bySide.set(srcKey, []);
    if (!bySide.has(tgtKey)) bySide.set(tgtKey, []);
    const srcOppositePerp = perpOf(ctx.sides.sourceSide, tgtCell);
    const tgtOppositePerp = perpOf(ctx.sides.targetSide, srcCell);
    let srcEventualPerp = srcOppositePerp;
    let tgtEventualPerp = tgtOppositePerp;
    if (edge.source === "via-half" && edge.viaOriginal !== undefined) {
      const pair = viaPairs.get(edge.viaOriginal);
      if (pair) {
        if (edge.viaFirstHalf && pair.secondIdx >= 0) {
          const second = model.edges[pair.secondIdx]!;
          const eventualTgt = placement.cells.get(second.to);
          if (eventualTgt) {
            srcEventualPerp = perpOf(ctx.sides.sourceSide, eventualTgt);
            tgtEventualPerp = perpOf(ctx.sides.targetSide, eventualTgt);
          }
        } else if (!edge.viaFirstHalf && pair.firstIdx >= 0) {
          const first = model.edges[pair.firstIdx]!;
          const eventualSrc = placement.cells.get(first.from);
          if (eventualSrc) {
            srcEventualPerp = perpOf(ctx.sides.sourceSide, eventualSrc);
            tgtEventualPerp = perpOf(ctx.sides.targetSide, eventualSrc);
          }
        }
      }
    }
    bySide.get(srcKey)!.push({
      edgeIndex: i,
      endpoint: "from",
      oppositePerp: srcOppositePerp,
      eventualPerp: srcEventualPerp,
      isBack,
    });
    bySide.get(tgtKey)!.push({
      edgeIndex: i,
      endpoint: "to",
      oppositePerp: tgtOppositePerp,
      eventualPerp: tgtEventualPerp,
      isBack,
    });
  }

  // Side capacity is one slot per cell-unit of face length (CELL_PX =
  // COMB_PITCH = 8). A 5-tall E face holds 5 traces.
  const sizeOf = new Map(model.nodes.map((n) => [n.id, n.size]));

  for (const [key, pending] of bySide) {
    const [nodeId, side] = key.split("|") as [string, Side];
    const sz = sizeOf.get(nodeId) ?? { width: 1, height: 1 };
    const sideLen = side === "E" || side === "W" ? sz.height : sz.width;
    const capacity = sideLen;
    if (pending.length > capacity) {
      throw new SlotError(
        `E_SIDE_OVERSUBSCRIBED: node '${nodeId}' has ${pending.length} ` +
          `traces on its ${side} face but capacity is ${capacity} ` +
          `(side length ${sideLen} cell-units). ` +
          `Increase 'size' (e.g. ${sz.width}x${sz.height + 1} for E/W or ` +
          `${sz.width + 1}x${sz.height} for N/S), split the node, or rebalance edges.`,
      );
    }
    // Slot-ordering keys (in priority order):
    //   1. oppositePerp ascending — spatial order of the other endpoint
    //      on the perpendicular axis. Minimises crossings: a fan whose
    //      targets sit in increasing perp order leaves the source face
    //      in the same order. Auto-flips under isometric rotation.
    //   2. eventualPerp ascending — via-half refinement (= oppositePerp
    //      for non-via). Breaks ties between siblings within the same
    //      bundle by the EVENTUAL endpoint's perp.
    //   3. edgeIndex — declaration-order tiebreak.
    //
    // §11.12: a node tagged `slot-order: declaration` forces declaration
    // order on OUTGOING (endpoint = "from") entries. Incoming entries
    // keep the default sort.
    const node = model.nodes.find((n) => n.id === nodeId);
    const declarationOrderOutgoing = node?.slotOrder === "declaration";
    const sortKey = (a: Pending, b: Pending) => {
      if (declarationOrderOutgoing && a.endpoint === "from" && b.endpoint === "from") {
        return a.edgeIndex - b.edgeIndex;
      }
      if (a.oppositePerp !== b.oppositePerp) return a.oppositePerp - b.oppositePerp;
      if (a.eventualPerp !== b.eventualPerp) return a.eventualPerp - b.eventualPerp;
      return a.edgeIndex - b.edgeIndex;
    };

    // Segregate back-edges from forwards. Back-edges wrap through page
    // margins so their face slot sits at the OUTER end of the centered
    // forward cluster (above the cluster for north-wrap).
    const backs = pending.filter((p) => p.isBack).sort(sortKey);
    const forwards = pending.filter((p) => !p.isBack).sort(sortKey);

    // Forward cluster is centered on the face midpoint INDEPENDENTLY of
    // how many backs are present. This lets a same-row trace land at
    // the same y on both endpoints even when those endpoints have
    // different counts of backs on their faces.
    //
    // Slot index is fractional: slot `s` on an E/W face of height H sits
    // at y = top + s * COMB_PITCH + COMB_PITCH/2 for s ∈ [0, H).
    // CELL_PX = COMB_PITCH, so 1 slot per cell-unit.
    const slotPositions = sideLen;
    const F = forwards.length;
    const forwardClusterStart = (slotPositions - F) / 2;
    forwards.forEach((p, k) => {
      slotMap.set(
        slotKey(nodeId, side, p.edgeIndex, p.endpoint),
        forwardClusterStart + k,
      );
    });
    backs.forEach((p, k) => {
      slotMap.set(
        slotKey(nodeId, side, p.edgeIndex, p.endpoint),
        forwardClusterStart - 1 - k,
      );
    });
  }

  // Post-pass: same-row/same-col alignment. For an edge whose source
  // and target are on the same row (E↔W faces) or same col (N↔S faces),
  // a fractional offset between the two slot indices produces a 4-px
  // kink in an otherwise-straight trace. When possible, shift the slot
  // with fewer constraints to land at the same index as the other end.
  //
  // "Possible" means: the candidate slot is integer-valued on the face
  // (so it actually realigns), it isn't already occupied by another
  // edge's slot on the same (nodeId, side), and the source/target ends
  // of the edge share a row (E/W) or col (N/S).
  //
  // Strategy: walk edges in declaration order. For each edge with a
  // mismatch and shared row/col, prefer shifting the TARGET to match
  // the source (producers usually flow into hubs; aligning at the hub
  // adapts the hub to the producer's natural pixel). Only shift if no
  // collision; otherwise leave the kink in place.
  // Build per-(nodeId, side) slot-to-edge map for the alignment pass —
  // we need to know which integer slots are free on each face. Slots
  // are fractional, so "free" means no other edge holds that exact value.
  type SlotKey = string;  // `${nodeId}|${side}|${slot}`
  const occupied = new Map<string, Set<number>>(); // key: `${nodeId}|${side}` → set of slot values
  for (const [skey, slot] of slotMap) {
    // skey format: `${nodeId}|${side}|${edgeIndex}|${endpoint}`
    const parts = skey.split("|");
    const nodeId = parts[0]!;
    const side = parts[1]!;
    const key = `${nodeId}|${side}`;
    if (!occupied.has(key)) occupied.set(key, new Set());
    occupied.get(key)!.add(slot);
  }

  // Count edges on each (nodeId, side) face — used to restrict alignment
  // to cases where one endpoint is the only edge on its face (F=1).
  // Multi-edge faces have a centered cluster whose slots aren't free to
  // shift without breaking other edges' alignment.
  const faceCount = new Map<string, number>();
  for (const skey of slotMap.keys()) {
    const parts = skey.split("|");
    const key = `${parts[0]!}|${parts[1]!}`;
    faceCount.set(key, (faceCount.get(key) ?? 0) + 1);
  }

  for (let i = 0; i < edgeCtxs.length; i++) {
    const edge = model.edges[i]!;
    const ctx = edgeCtxs[i]!;
    const eIsHoriz = ctx.sides.sourceSide === "E" || ctx.sides.sourceSide === "W";
    const tIsHoriz = ctx.sides.targetSide === "E" || ctx.sides.targetSide === "W";
    if (eIsHoriz !== tIsHoriz) continue;
    if (eIsHoriz && ctx.src.row !== ctx.tgt.row) continue;
    if (!eIsHoriz && ctx.src.col !== ctx.tgt.col) continue;
    const sSlot = slotMap.get(slotKey(edge.from, ctx.sides.sourceSide, i, "from"));
    const tSlot = slotMap.get(slotKey(edge.to, ctx.sides.targetSide, i, "to"));
    if (sSlot === undefined || tSlot === undefined) continue;
    if (sSlot === tSlot) continue;
    // Restrict alignment to cases where ONE side has a singleton edge
    // on its face (F=1). On a single-edge face the slot is the face
    // center — alignment doesn't disturb anything else. Multi-edge
    // faces have a centered cluster whose slot positions are
    // interlocked; shifting one breaks the cluster geometry for the
    // others.
    const srcFaceKey = `${edge.from}|${ctx.sides.sourceSide}`;
    const tgtFaceKey = `${edge.to}|${ctx.sides.targetSide}`;
    const srcF = faceCount.get(srcFaceKey) ?? 0;
    const tgtF = faceCount.get(tgtFaceKey) ?? 0;
    if (srcF !== 1 && tgtF !== 1) continue;
    // Try aligning either endpoint to the other. Prefer shifting the
    // target (toward the producer's slot); fall back to shifting the
    // source toward the target if the source slot is fractional but the
    // target is integer.
    const srcSize = sizeOf.get(edge.from) ?? { width: 1, height: 1 };
    const tgtSize = sizeOf.get(edge.to) ?? { width: 1, height: 1 };
    const tgtFaceLen = ctx.sides.targetSide === "E" || ctx.sides.targetSide === "W"
      ? tgtSize.height : tgtSize.width;
    const srcFaceLen = ctx.sides.sourceSide === "E" || ctx.sides.sourceSide === "W"
      ? srcSize.height : srcSize.width;
    const tgtKey = `${edge.to}|${ctx.sides.targetSide}`;
    const srcKey = `${edge.from}|${ctx.sides.sourceSide}`;
    const tgtOccupied = occupied.get(tgtKey) ?? new Set();
    const srcOccupied = occupied.get(srcKey) ?? new Set();

    // Try: shift target to source's slot. Only commit if the shift
    // preserves the monotonic ordering of slots on the target face —
    // i.e. the new slot still sits between its neighbours' slots in
    // the centered cluster, so the producer fan doesn't reorder.
    if (Number.isInteger(sSlot) && sSlot >= 0 && sSlot < tgtFaceLen &&
        !tgtOccupied.has(sSlot) &&
        preservesOrder(tSlot, sSlot, tgtOccupied)) {
      slotMap.set(slotKey(edge.to, ctx.sides.targetSide, i, "to"), sSlot);
      tgtOccupied.delete(tSlot);
      tgtOccupied.add(sSlot);
      occupied.set(tgtKey, tgtOccupied);
      continue;
    }
    if (Number.isInteger(tSlot) && tSlot >= 0 && tSlot < srcFaceLen &&
        !srcOccupied.has(tSlot) &&
        preservesOrder(sSlot, tSlot, srcOccupied)) {
      slotMap.set(slotKey(edge.from, ctx.sides.sourceSide, i, "from"), tSlot);
      srcOccupied.delete(sSlot);
      srcOccupied.add(tSlot);
      occupied.set(srcKey, srcOccupied);
      continue;
    }
  }

  // §11.9 v2: highway through-trace mirroring. The second-half edge's
  // entry slot on the highway's exit face is forced to mirror its
  // sibling first-half edge's exit slot on the entry face, so the
  // trace runs straight through the highway box.
  const firstByOriginal = new Map<number, { edgeIndex: number; hwyId: string; entrySide: Side }>();
  for (let i = 0; i < edgeCtxs.length; i++) {
    const edge = model.edges[i]!;
    if (!edge.viaFirstHalf || edge.viaOriginal === undefined) continue;
    firstByOriginal.set(edge.viaOriginal, {
      edgeIndex: i,
      hwyId: edge.to,
      entrySide: edgeCtxs[i]!.sides.targetSide,
    });
  }
  for (let i = 0; i < edgeCtxs.length; i++) {
    const edge = model.edges[i]!;
    if (edge.viaFirstHalf || edge.viaOriginal === undefined) continue;
    if (edge.source !== "via-half") continue;
    const first = firstByOriginal.get(edge.viaOriginal);
    if (!first) continue;
    const firstHwySlot = slotMap.get(slotKey(first.hwyId, first.entrySide, first.edgeIndex, "to"));
    if (firstHwySlot === undefined) continue;
    slotMap.set(
      slotKey(edge.from, edgeCtxs[i]!.sides.sourceSide, i, "from"),
      firstHwySlot,
    );
  }

  // Stitch per-edge slot assignments.
  const out = new Map<number, SlotAssignment>();
  for (let i = 0; i < edgeCtxs.length; i++) {
    const edge = model.edges[i]!;
    const ctx = edgeCtxs[i]!;
    const ss = slotMap.get(slotKey(edge.from, ctx.sides.sourceSide, i, "from"));
    const ts = slotMap.get(slotKey(edge.to, ctx.sides.targetSide, i, "to"));
    if (ss === undefined || ts === undefined) {
      throw new SlotError(
        `internal: missing slot assignment for edge ${i} '${edge.from} -> ${edge.to}'`,
      );
    }
    out.set(i, {
      edgeIndex: i,
      sourceSide: ctx.sides.sourceSide,
      sourceSlot: ss,
      targetSide: ctx.sides.targetSide,
      targetSlot: ts,
    });
  }
  return out;
}

// --- helpers --------------------------------------------------------------

/**
 * Check that shifting one slot from `oldSlot` to `newSlot` on a face
 * (with `face` containing all current slot values including `oldSlot`)
 * preserves the monotonic ordering — i.e. the number of slots less
 * than `oldSlot` equals the number of slots less than `newSlot` after
 * the swap.
 */
function preservesOrder(oldSlot: number, newSlot: number, face: Set<number>): boolean {
  let lessThanOld = 0;
  let lessThanNew = 0;
  for (const s of face) {
    if (s === oldSlot) continue;
    if (s < oldSlot) lessThanOld++;
    if (s < newSlot) lessThanNew++;
  }
  return lessThanOld === lessThanNew;
}

function opposite(d: Direction): Direction {
  switch (d) {
    case "N": return "S";
    case "S": return "N";
    case "E": return "W";
    case "W": return "E";
  }
}

/**
 * Edge-forward rule (DESIGN §3.3). The source exits in the edge's
 * forward direction; the target enters from the rear-of-forward face.
 * For a back-edge the caller passes `opposite(forwardAt[source])`,
 * which sends the trace out the source's rear face and into the
 * target's front face for the wrap.
 */
function assignSides(
  edgeFwd: Direction,
): { sourceSide: Side; targetSide: Side } {
  return {
    sourceSide: edgeFwd as Side,
    targetSide: opposite(edgeFwd) as Side,
  };
}

/**
 * Compute cardinal forward direction for a forward edge from its placed
 * cells (DESIGN §2.5). For axis-aligned src→tgt this is the unambiguous
 * cardinal. For diagonals the long-axis component wins; equal magnitudes
 * fall back to the source's local forward axis to break the tie.
 */
function forwardOfEdge(src: Cell, tgt: Cell, srcLocalFwd: Direction): Direction {
  const dRow = tgt.row - src.row;
  const dCol = tgt.col - src.col;
  const absRow = Math.abs(dRow);
  const absCol = Math.abs(dCol);
  if (absRow > absCol) return dRow > 0 ? "S" : "N";
  if (absCol > absRow) return dCol > 0 ? "E" : "W";
  if (srcLocalFwd === "E" || srcLocalFwd === "W") {
    return dCol > 0 ? "E" : "W";
  }
  return dRow > 0 ? "S" : "N";
}

/**
 * DESIGN-PHASE5-MODULES.md §4.6 — pick the face of a module-shape
 * synthetic cell that's best for a polyline emerging from (or arriving
 * at) a specific internal node. Direction-correct faces win over closer-
 * but-wrong-direction; within a tied direction, the closer face wins.
 */
function pickModuleFaceForInternal(
  localX: number,
  localY: number,
  moduleW: number,
  moduleH: number,
  dRow: number,
  dCol: number,
): Side {
  const DIR_BONUS = 1_000_000;
  const scoreN = localY - (dRow < 0 ? DIR_BONUS : 0);
  const scoreS = (moduleH - localY) - (dRow > 0 ? DIR_BONUS : 0);
  const scoreE = (moduleW - localX) - (dCol > 0 ? DIR_BONUS : 0);
  const scoreW = localX - (dCol < 0 ? DIR_BONUS : 0);
  let best: Side = "E";
  let bestScore = scoreE;
  if (scoreW < bestScore) { best = "W"; bestScore = scoreW; }
  if (scoreN < bestScore) { best = "N"; bestScore = scoreN; }
  if (scoreS < bestScore) { best = "S"; bestScore = scoreS; }
  return best;
}

/**
 * The perpendicular cell-coord of `cell` relative to a face on the other
 * endpoint. E/W face → perp axis = north-south → cell.row. N/S face →
 * perp axis = east-west → cell.col. Used as the primary slot-ordering
 * key so fans line up in spatial order, not declaration order — and so
 * the resulting order auto-rotates under isometric flip.
 */
function perpOf(side: Side, otherEndpoint: Cell): number {
  if (side === "E" || side === "W") return otherEndpoint.row;
  return otherEndpoint.col;
}

function slotKey(
  nodeId: string,
  side: Side,
  edgeIndex: number,
  endpoint: "from" | "to",
): string {
  return `${nodeId}|${side}|${edgeIndex}|${endpoint}`;
}
