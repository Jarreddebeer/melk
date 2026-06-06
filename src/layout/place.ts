/**
 * Phase 4 grid placer.
 *
 * Pure function from bound `Model` to `Placement` (DESIGN-PHASE4.md §2).
 * Three passes:
 *
 *   1. Anchor pass — pipelines, buses, fan-outs force their members'
 *      relative cells. Conflicting anchors raise E_ANCHOR_CONFLICT.
 *   2. Flow pass   — each remaining edge (whose endpoints aren't both
 *      already placed) walks one cell along the flow axis from the
 *      placed endpoint to the unplaced one. Free nodes (no incident
 *      edges yet) get parked at a fresh row.
 *   3. Conflict pass — any cell collision after passes 1+2 raises
 *      E_AMBIGUOUS_PLACEMENT.
 *
 * The placer is deterministic: declaration order is the tiebreak
 * everywhere. The same Model always produces the same Placement,
 * byte-for-byte.
 *
 * Row/col cell-unit sizes are initialised from the max node cell-size
 * landing in each row/col. Corridor reservation (Step 5) widens these.
 */
import type { Branch, Bus, FanOut, HighwayMembership, Model, ModelNode, Pipeline } from "../bind/model.js";
import {
  type Cell,
  type Direction,
  type FlowAxis,
  type Placement,
  PlacementError,
  extentOf,
  footprintCells,
} from "./placement.js";

interface PlaceCtx {
  cells: Map<string, Cell>;
  /**
   * Tracks which constraint placed a node first. Used only for crafting
   * better E_ANCHOR_CONFLICT messages — not load-bearing for the
   * algorithm itself.
   */
  placedBy: Map<string, string>;
  /**
   * Each node's local forward direction. Populated by the anchor pass
   * (each anchor function passes its forward into applyAnchor); the flow
   * pass and orphan parking fall back to the page-level default. Read
   * downstream of the placer to make corridor / slot / track decisions
   * isometric under inheritance (DESIGN-PHASE4.md §2.5).
   */
  forward: Map<string, Direction>;
  flowAxis: FlowAxis;
  /** Page-level default forward — used by the flow pass and orphan parking. */
  defaultForward: Direction;
  /**
   * Lowest row index that's known not to host any currently-placed node
   * in any column. Used to park new constraint groups / disconnected
   * components without overlapping earlier work.
   */
  nextFreeRow: number;
  /** Node-id → ModelNode for size lookups during anchor and flow passes. */
  nodeOf: Map<string, ModelNode>;
}

export function place(model: Model): Placement {
  const flowAxis: FlowAxis = model.layoutMode === "tb" ? "south" : "east";
  const ctx: PlaceCtx = {
    cells: new Map(),
    placedBy: new Map(),
    forward: new Map(),
    flowAxis,
    defaultForward: flowAxis === "east" ? "E" : "S",
    nextFreeRow: 0,
    nodeOf: new Map(model.nodes.map((n) => [n.id, n])),
  };

  // Anchors are applied in declaration order — not kind-precedence
  // order — so that a `branch` declared between two pipelines is
  // anchored after its parent and before any pipeline rooted on its
  // members. This is what makes the source-order-dependent inheritance
  // of local forward work (DESIGN-PHASE4.md §2.5, §11.6).
  for (const a of model.anchors) {
    switch (a.kind) {
      case "pipeline":    anchorPipeline(model.pipelines[a.index]!, ctx); break;
      case "bus":         anchorBus(model.buses[a.index]!, ctx); break;
      case "fan-out":     anchorFanOut(model.fanOuts[a.index]!, ctx); break;
      case "branch":      anchorBranch(model.branches[a.index]!, ctx); break;
      case "highway-via": anchorHighwayVia(model.highwayMemberships[a.index]!, model, ctx); break;
    }
  }

  // §11.11: apply intersect declarations. For each group, shift the
  // second-and-later highways (and their via-anchor members) so they
  // coincide with the first highway's cell.
  applyIntersections(model, ctx);

  flowPass(model, ctx);
  parkOrphans(model, ctx);
  detectCollisions(model, ctx);

  return normalise(model, ctx);
}

/**
 * Gap (in cell-units) inserted between every consecutive pair of
 * stacked members in a bus, fan-out, or fan-in. Uniform regardless of
 * member count or which construct is doing the placing — members that
 * participate in two constructs (e.g. workers downstream of a fan-out
 * and upstream of a bus) get the same spacing either way.
 *
 * For even n, the middle pair's gap is what shared straddles to land
 * centered between the two middle members. Shared's declared height
 * does not affect any spacing decisions.
 *
 * A future spacing setting in the theme/page will set this value (1-3
 * cells).
 */
const MEMBER_GAP = 5;

/** Forward / perp cell-extent of a node id given its local forward direction. */
function extentFor(id: string, ctx: PlaceCtx): { forward: number; perp: number } {
  const node = ctx.nodeOf.get(id);
  const w = node?.size.width ?? 1;
  const h = node?.size.height ?? 1;
  const fwd = ctx.forward.get(id) ?? ctx.defaultForward;
  return extentOf(w, h, fwd);
}

// --- direction helpers ----------------------------------------------------

/**
 * The unit cell-step (drow, dcol) for moving one cell in direction `d`.
 * Used to build offset tables for the four-way-symmetric anchor functions.
 */
function step(d: Direction): Cell {
  switch (d) {
    case "E": return { row: 0, col: 1 };
    case "W": return { row: 0, col: -1 };
    case "S": return { row: 1, col: 0 };
    case "N": return { row: -1, col: 0 };
  }
}

/** Rotate a direction 90° counter-clockwise (the `:left` rotation). */
function left(d: Direction): Direction {
  switch (d) {
    case "E": return "N";
    case "N": return "W";
    case "W": return "S";
    case "S": return "E";
  }
}

/** Rotate a direction 90° clockwise (the `:right` rotation). */
function right(d: Direction): Direction {
  switch (d) {
    case "E": return "S";
    case "S": return "W";
    case "W": return "N";
    case "N": return "E";
  }
}

// --- anchor pass ----------------------------------------------------------

/**
 * Constraint application is uniform across pipeline / bus / fan-out /
 * branch: compute each member's offset from a reference member
 * (offsets[0] = (0,0) by construction), then resolve the reference's
 * cell using one of three cases.
 *
 * `forwards` carries the local forward direction the anchor assigns
 * each member — usually a single direction repeated for every member,
 * but `bus`/`fan-out`/`branch` may differ (e.g. fan-out's `shared` has
 * the parent's forward while consumers carry the bus's forward).
 */
function applyAnchor(
  members: string[],
  offsets: Cell[],
  forwards: Direction[],
  ctx: PlaceCtx,
  constructLabel: string,
): void {
  // Which (if any) members are already placed, and at what cells?
  const placed: { idx: number; cell: Cell }[] = [];
  for (let i = 0; i < members.length; i++) {
    const c = ctx.cells.get(members[i]!);
    if (c) placed.push({ idx: i, cell: c });
  }

  let refRow: number;
  let refCol: number;

  if (placed.length === 0) {
    // Park the whole group at a fresh row, col 0. When prior anchors
    // have already placed nodes, pad by MEMBER_GAP rows so the new
    // construct doesn't land flush against the previous block's bottom
    // edge (visual rhythm consistent with bus/fan-out spacing, and the
    // nodeset rectangles drawn around each disconnected group don't
    // visually overlap their neighbours).
    const pad = ctx.cells.size > 0 ? MEMBER_GAP : 0;
    refRow = ctx.nextFreeRow + pad;
    refCol = 0;
  } else {
    // Derive reference from the first already-placed member. Then check
    // every other already-placed member agrees.
    const first = placed[0]!;
    refRow = first.cell.row - offsets[first.idx]!.row;
    refCol = first.cell.col - offsets[first.idx]!.col;

    for (const p of placed) {
      const expectedRow = refRow + offsets[p.idx]!.row;
      const expectedCol = refCol + offsets[p.idx]!.col;
      if (p.cell.row !== expectedRow || p.cell.col !== expectedCol) {
        const memberId = members[p.idx]!;
        const placedBy = ctx.placedBy.get(memberId) ?? "earlier constraint";
        throw new PlacementError(
          `E_ANCHOR_CONFLICT: node '${memberId}' is anchored at ` +
            `(row ${p.cell.row}, col ${p.cell.col}) by ${placedBy} ` +
            `but ${constructLabel} would place it at ` +
            `(row ${expectedRow}, col ${expectedCol}). ` +
            `Drop the node from one of the constructs or split it in two.`,
        );
      }
    }
  }

  // Place every still-unplaced member at its offset, and record its
  // local forward. forward is set the *first* time a node is anchored;
  // later constructs that re-mention an already-anchored node leave its
  // forward as-is (the first anchor's forward wins, matching declaration
  // order). Z is taken from the offset; default 0 for non-highway anchors.
  for (let i = 0; i < members.length; i++) {
    if (ctx.cells.has(members[i]!)) continue;
    const cell: Cell = {
      row: refRow + offsets[i]!.row,
      col: refCol + offsets[i]!.col,
    };
    if (offsets[i]!.z !== undefined) cell.z = offsets[i]!.z;
    ctx.cells.set(members[i]!, cell);
    ctx.placedBy.set(members[i]!, constructLabel);
    if (!ctx.forward.has(members[i]!)) {
      ctx.forward.set(members[i]!, forwards[i]!);
    }
  }

  // Advance the "next free row" past anything this constraint placed.
  // Multi-cell: count each node's full footprint height.
  for (let i = 0; i < members.length; i++) {
    const c = ctx.cells.get(members[i]!)!;
    const node = ctx.nodeOf.get(members[i]!);
    const h = Math.max(1, Math.ceil(node?.size.height ?? 1));
    if (c.row + h > ctx.nextFreeRow) ctx.nextFreeRow = c.row + h;
  }
}

/**
 * The forward direction a primitive uses for its own geometry. If the
 * anchor node is already placed (by an earlier primitive), inherit its
 * local forward. Otherwise fall back to the page-level default.
 *
 * Pipelines are anchored at member[0]; buses at the shared consumer;
 * fan-outs at the shared producer; branches at the spine.
 */
function inheritForward(anchor: string, ctx: PlaceCtx): Direction {
  return ctx.forward.get(anchor) ?? ctx.defaultForward;
}

function anchorPipeline(p: Pipeline, ctx: PlaceCtx): void {
  // Pipeline members lie along the local forward direction with one
  // empty cell between consecutive members (DESIGN §2.2, §2.5). The
  // empty cell is the channel-router's runway: traces from member i
  // exit the forward face, walk one empty cell, and enter member i+1's
  // rear face. Multi-cell occupancy: each member's offset advances by
  // the PREVIOUS member's forward extent PLUS one PIPELINE_GAP cell.
  const fwd = inheritForward(p.members[0]!, ctx);
  const s = step(fwd);
  const offsets: Cell[] = [];
  let accum = 0;
  for (let i = 0; i < p.members.length; i++) {
    offsets.push({ row: s.row * accum, col: s.col * accum });
    accum += extentFor(p.members[i]!, ctx).forward + PIPELINE_GAP;
  }
  const forwards = p.members.map(() => fwd);
  applyAnchor(p.members, offsets, forwards, ctx, `pipeline '${p.name}'`);
}

/**
 * Cells of empty space between consecutive pipeline members along the
 * flow axis. The channel router needs empty cells to walk the trace
 * from one member's forward face into the next's rear face — and
 * enough of them that the polyline reads as a real arrow, not a stub.
 *
 * Set to 5 so the visible gap between adjacent boxes equals one
 * default-node-width and the diagram doesn't look squashed. Smaller
 * values left back-to-back boxes nearly touching (Redis kissing
 * worker.2 in ex 38).
 */
const PIPELINE_GAP = 5;

function anchorBus(b: Bus, ctx: PlaceCtx): void {
  // Bus geometry, isometric (DESIGN §2.5): producers stack along the
  // perpendicular axis with a uniform `MEMBER_GAP` between each
  // consecutive pair. Shared sits one max-producer-forward step
  // forward at the anchor perp (geometric centre of the producer
  // block). The bus's forward is inherited from `shared`.
  const fwd = inheritForward(b.shared, ctx);
  const fStep = step(fwd);
  const pStep = step(left(fwd)); // perpendicular axis; -i*pStep stacks producers along it
  const n = b.producers.length;
  const members = [...b.producers, b.shared];
  const offsets: Cell[] = [];

  // perpOffsets[i] = perp offset of producer i from producer 0, with
  // MEMBER_GAP inserted between every consecutive pair.
  const perpOffsets: number[] = [];
  let perpAccum = 0;
  for (let i = 0; i < n; i++) {
    perpOffsets.push(perpAccum);
    perpAccum += extentFor(b.producers[i]!, ctx).perp;
    if (i < n - 1) perpAccum += MEMBER_GAP;
  }
  // pStepSign is the signed magnitude of `-pStep` on whichever axis is
  // non-zero. Under LR pStep=N, -pStep=S → +1 (rows). Under TB pStep=E,
  // -pStep=W → -1 (cols). The anchor formula needs it to convert between
  // perpOffset and signed cell coordinate.
  const pStepSign = -pStep.row !== 0 ? -pStep.row : -pStep.col;
  const anchorPerp = anchorPerpOf(b.producers, perpOffsets, b.shared, ctx, pStepSign);

  for (let i = 0; i < n; i++) {
    const po = perpOffsets[i]!;
    offsets.push({ row: -pStep.row * po, col: -pStep.col * po });
  }
  // Shared: one max-producer-forward-extent step forward at the anchor,
  // plus a gap for the channel-router runway. Scale the gap with `n` so
  // each producer's trace gets its own lane in the V-channel.
  let maxProducerFwd = 1;
  for (const p of b.producers) {
    const ext = extentFor(p, ctx).forward;
    if (ext > maxProducerFwd) maxProducerFwd = ext;
  }
  const busGap = Math.max(PIPELINE_GAP, n + 2);
  const busForward = maxProducerFwd + busGap;
  offsets.push({
    row: fStep.row * busForward + -pStep.row * anchorPerp,
    col: fStep.col * busForward + -pStep.col * anchorPerp,
  });
  const forwards = members.map(() => fwd);
  applyAnchor(members, offsets, forwards, ctx, `bus '${b.name}'`);
}

/**
 * Anchor offset (signed cell-units along -pStep) for `shared` such that
 * shared's geometric cell centre lands on the producer block's geometric
 * cell centre. The returned value `anchorPerp` is consumed as
 * `cell = -pStep * anchorPerp` by the caller, so it represents the
 * leading edge of `shared` in the same -pStep frame that member offsets
 * use.
 *
 * The geometry depends on which direction -pStep points (members extend
 * cell-positive from their leading-cell, regardless of pStep's sign).
 * Under LR (-pStep = +row), members at po=0 .. po=last all extend
 * row-positive from their leading row, so the block in cells spans
 * `0 .. last + lastMember.perp - 1`. Under TB (-pStep = -col), members
 * at po=0 .. po=last extend col-positive from their leading col, but
 * leading cols are negative — the block spans `-last .. 0 + firstMember.perp - 1`.
 *
 * We work in cell coordinates of one fixed axis (the axis -pStep moves
 * along) and solve directly for `shared`'s leading cell, then convert
 * back to a -pStep-frame perpOffset.
 */
function anchorPerpOf(
  memberIds: string[],
  perpOffsets: number[],
  sharedId: string,
  ctx: PlaceCtx,
  pStepSign: number, // -pStep's sign on the perp axis: +1 (LR) or -1 (TB)
): number {
  // Each member's leading-cell on the perp axis = pStepSign * po.
  // Members extend cell-positive from their leading cell regardless of
  // pStep's direction, so trailing-cell = leading-cell + member.perp - 1.
  let minCell = Infinity;
  let maxCell = -Infinity;
  for (let i = 0; i < memberIds.length; i++) {
    const leading = pStepSign * perpOffsets[i]!;
    const trailing = leading + extentFor(memberIds[i]!, ctx).perp - 1;
    if (leading < minCell) minCell = leading;
    if (trailing > maxCell) maxCell = trailing;
  }
  const blockCentre = (minCell + maxCell) / 2;
  const sharedPerp = extentFor(sharedId, ctx).perp;
  // shared.leading-cell = blockCentre - (sharedPerp - 1) / 2.
  const sharedLeadingCell = blockCentre - (sharedPerp - 1) / 2;
  // Convert back to a -pStep perpOffset: cell = pStepSign * po, so
  // po = sharedLeadingCell / pStepSign. Floor for whole-cell snapping
  // (half-cell asymmetry is unavoidable when block-perp and shared-perp
  // have different parity).
  return Math.floor(sharedLeadingCell / pStepSign);
}

function anchorFanOut(f: FanOut, ctx: PlaceCtx): void {
  // Mirror of bus: shared at the origin, consumers one shared-forward-
  // extent step forward at consecutive perpendicular offsets with a
  // uniform `MEMBER_GAP` between each consecutive pair. Shared anchors
  // at the geometric centre of the consumer block — same formula as
  // bus, no parity branch.
  const fwd = inheritForward(f.shared, ctx);
  const fStep = step(fwd);
  const pStep = step(left(fwd));
  const n = f.consumers.length;
  const members = [f.shared, ...f.consumers];
  const offsets: Cell[] = [];

  const perpOffsets: number[] = [];
  let perpAccum = 0;
  for (let i = 0; i < n; i++) {
    perpOffsets.push(perpAccum);
    perpAccum += extentFor(f.consumers[i]!, ctx).perp;
    if (i < n - 1) perpAccum += MEMBER_GAP;
  }
  const pStepSign = -pStep.row !== 0 ? -pStep.row : -pStep.col;
  const anchorPerp = anchorPerpOf(f.consumers, perpOffsets, f.shared, ctx, pStepSign);

  // Shared sits at -pStep * anchorPerp (perp-centered on consumers).
  offsets.push({ row: -pStep.row * anchorPerp, col: -pStep.col * anchorPerp });
  // Each consumer: shared-forward-extent + gap step forward at its perp
  // (the gap is the channel-router runway between shared and consumer
  // columns). Scale the gap with `n` so each consumer has its own lane
  // in the V-channel: PIPELINE_GAP works for small fans (≤4); larger
  // fans need n+1 cols to fit n lanes plus 1 col of clearance.
  const fanGap = Math.max(PIPELINE_GAP, n + 1);
  const sharedFwdExtent = extentFor(f.shared, ctx).forward + fanGap;
  for (let i = 0; i < n; i++) {
    const po = perpOffsets[i]!;
    offsets.push({
      row: fStep.row * sharedFwdExtent + -pStep.row * po,
      col: fStep.col * sharedFwdExtent + -pStep.col * po,
    });
  }
  const forwards = members.map(() => fwd);
  applyAnchor(members, offsets, forwards, ctx, `fan-out '${f.name}'`);
}

function anchorBranch(b: Branch, ctx: PlaceCtx): void {
  // Direction change: anchor `member` one (spine-perp-extent) step off
  // `spine` on the 90°-rotated axis, with `member` carrying the rotated
  // forward. Any downstream primitive rooted on `member` inherits that
  // forward (§2.5, §6.4). Multi-cell: step by spine's extent in the
  // branch direction so a 5x9 spine and a 5x5 branch member don't
  // overlap.
  //
  // Center-align on the parentFwd axis (the axis perpendicular to the
  // branch direction): different-sized spine and member otherwise share
  // a leading edge, which under LR puts sidecar's W edge flush with
  // hub's W edge — the trace exits sidecar's S face and enters hub's N
  // face off-centre. Mirror of the bus/fan-out median-alignment fix.
  const parentFwd = inheritForward(b.spine, ctx);
  const side = b.side ?? "left";
  const branchFwd: Direction = side === "left" ? left(parentFwd) : right(parentFwd);
  const s = step(branchFwd);
  // Step along the branch direction by the spine's perp extent plus
  // PIPELINE_GAP — channel-router runway between spine and branch member.
  const spinePerp = extentFor(b.spine, ctx).perp + PIPELINE_GAP;
  // Centring shim along the parentFwd axis: parentFwd-extent of spine
  // minus parentFwd-extent of member, divided by 2. Floored for whole-
  // cell snapping. Compute member's extent under its eventual branchFwd
  // (set by applyAnchor below) — ctx.forward doesn't have it yet.
  const memberNode = ctx.nodeOf.get(b.member);
  const memberW = memberNode?.size.width ?? 1;
  const memberH = memberNode?.size.height ?? 1;
  const memberExtOnParentFwd = extentOf(memberW, memberH, branchFwd).perp;
  const spineFwdExt = extentFor(b.spine, ctx).forward;
  const centreShim = Math.floor((spineFwdExt - memberExtOnParentFwd) / 2);
  const pStepFwd = step(parentFwd);
  applyAnchor(
    [b.spine, b.member],
    [
      { row: 0, col: 0 },
      {
        row: s.row * spinePerp + pStepFwd.row * centreShim,
        col: s.col * spinePerp + pStepFwd.col * centreShim,
      },
    ],
    [parentFwd, branchFwd],
    ctx,
    `branch '${b.name}'`,
  );
}

/**
 * Highway-via anchor (DESIGN-PHASE4.md §11.9). Places source-side
 * via-members one cell back from the highway, target-side via-members
 * one cell forward, both centered on the highway's perp coord.
 *
 * For a horizontal highway under `layout: lr`, forward = E. Sources
 * stack vertically (perp axis = N-S) in col `hwy.col - 1`; targets in
 * col `hwy.col + 1`. The highway's `size:` widens its column to fit
 * its visual length (handled by the row/col-unit pass).
 */
function anchorHighwayVia(
  m: HighwayMembership,
  model: Model,
  ctx: PlaceCtx,
): void {
  // The highway's forward defaults to the page-level flow direction —
  // we don't inherit from anything because the highway itself has no
  // pre-existing parent. §11.11: an explicit `orient:` on the highway
  // node overrides the default — `orient: horizontal` → forward = E,
  // `orient: vertical` → forward = S. This is what lets two perpendicular
  // highways coexist at the same cell.
  const hwyNode = model.nodes.find((n) => n.id === m.name);
  let fwd: Direction;
  if (hwyNode?.orient === "horizontal") fwd = "E";
  else if (hwyNode?.orient === "vertical") fwd = "S";
  else fwd = ctx.forward.get(m.name) ?? ctx.defaultForward;
  ctx.forward.set(m.name, fwd);
  const fStep = step(fwd);
  const pStep = step(left(fwd));

  // §11.11/§11.13: the highway's Z depth is derived from `render:`.
  // `render: underground` → z = -1 (below surface), default → z = 0.
  // The highway box AND all its via-anchor members (sources, targets,
  // through-traces) live at this z. Two highways at perpendicular
  // orientations and different z can share an (row, col) cell because
  // they're on different depth layers.
  const hwyZ = hwyNode?.render === "underground" ? -1 : 0;

  // Members of the via-anchor: [highway, ...sources, ...targets]. The
  // highway sits at the origin; sources stack at -fStep with consecutive
  // perp offsets; targets at +fStep similarly.
  const members: string[] = [m.name, ...m.sources, ...m.targets];
  const offsets: Cell[] = [];
  const forwards: Direction[] = [];

  // Highway itself at origin, carrying its own forward (= page default).
  offsets.push({ row: 0, col: 0, z: hwyZ });
  forwards.push(fwd);

  // Source-side: one (source-extent)-step BACK from the highway, stacked
  // at consecutive perp offsets centered around the highway. Multi-cell
  // occupancy: each source's perp offset is the cumulative perp extent
  // of all earlier sources, centered on the median.
  const nSrc = m.sources.length;
  const srcPerpOffsets: number[] = [];
  {
    let acc = 0;
    for (let i = 0; i < nSrc; i++) {
      srcPerpOffsets.push(acc);
      acc += extentFor(m.sources[i]!, ctx).perp;
      if (i < nSrc - 1) acc += MEMBER_GAP;
    }
  }
  const srcMedianIdx = Math.floor((nSrc - 1) / 2);
  const srcMedianPerp = srcPerpOffsets[srcMedianIdx] ?? 0;
  // For the source's back-step: use the source's own forward extent so
  // the trailing edge of source-col touches the leading edge of hwy-col.
  // With uniform-size sources (the common case) this is just 1 source's
  // forward extent.
  let maxSrcFwd = 1;
  for (const s of m.sources) {
    const ext = extentFor(s, ctx).forward;
    if (ext > maxSrcFwd) maxSrcFwd = ext;
  }
  // Channel-router runway: one PIPELINE_GAP cell between source's
  // trailing edge and highway's leading edge.
  const srcBackStep = maxSrcFwd + PIPELINE_GAP;
  for (let i = 0; i < nSrc; i++) {
    const po = srcPerpOffsets[i]! - srcMedianPerp;
    offsets.push({
      row: -fStep.row * srcBackStep + -pStep.row * po,
      col: -fStep.col * srcBackStep + -pStep.col * po,
      z: hwyZ,
    });
    forwards.push(fwd);
  }

  // Target-side: one (highway-extent)-step FORWARD from the highway.
  const nTgt = m.targets.length;
  const tgtPerpOffsets: number[] = [];
  {
    let acc = 0;
    for (let i = 0; i < nTgt; i++) {
      tgtPerpOffsets.push(acc);
      acc += extentFor(m.targets[i]!, ctx).perp;
      if (i < nTgt - 1) acc += MEMBER_GAP;
    }
  }
  const tgtMedianIdx = Math.floor((nTgt - 1) / 2);
  const tgtMedianPerp = tgtPerpOffsets[tgtMedianIdx] ?? 0;
  // Highway forward extent: how far targets must sit beyond the
  // highway's anchor cell to be east of the highway's east face.
  const hwyFwdExtent = extentFor(m.name, ctx).forward + PIPELINE_GAP;
  for (let i = 0; i < nTgt; i++) {
    const po = tgtPerpOffsets[i]! - tgtMedianPerp;
    offsets.push({
      row: fStep.row * hwyFwdExtent + -pStep.row * po,
      col: fStep.col * hwyFwdExtent + -pStep.col * po,
      z: hwyZ,
    });
    forwards.push(fwd);
  }

  applyAnchor(members, offsets, forwards, ctx, `highway '${m.name}'`);
  // Suppress unused-warning if model isn't used; kept in signature in
  // case a future extension needs it.
  void model;
}

// --- flow pass ------------------------------------------------------------

/**
 * For each non-back edge in declaration order: ensure at least one
 * endpoint is placed (parking the source at a fresh row when neither
 * is), then walk to the other endpoint along the flow axis.
 *
 * The fixed-point loop runs in declaration order so chains of free
 * edges (`a -> b`, `b -> c`, `c -> d`) all share the row of the first
 * edge's source. Re-runs continue until no edge changes the cell map.
 */
function flowPass(model: Model, ctx: PlaceCtx): void {
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of model.edges) {
      if (e.isBackEdge) continue;
      let fromPlaced = ctx.cells.has(e.from);
      let toPlaced = ctx.cells.has(e.to);
      if (fromPlaced && toPlaced) continue;
      if (!fromPlaced && !toPlaced) {
        // Park the source at a fresh row, col 0 so the flow pass can
        // walk forward from a known starting point. Without this,
        // disconnected fragments never get visited.
        const start = nextOrigin(ctx);
        ctx.cells.set(e.from, start);
        ctx.placedBy.set(e.from, `edge ${e.from} -> ${e.to}`);
        ctx.forward.set(e.from, ctx.defaultForward);
        ctx.nextFreeRow = Math.max(ctx.nextFreeRow, start.row + 1);
        fromPlaced = true;
      }
      if (fromPlaced) {
        const a = ctx.cells.get(e.from)!;
        const fwd = ctx.forward.get(e.from) ?? ctx.defaultForward;
        // Step past `from`'s forward extent, plus one PIPELINE_GAP cell
        // of channel-router runway. The empty cell between consecutive
        // boxes is where the trace exits and turns.
        const fromExt = extentFor(e.from, ctx).forward + PIPELINE_GAP;
        // Centre `to` on `from`'s perp axis: when source and target have
        // different perp extents, leading-edge alignment puts their slot
        // centres at different perp coords and the trace exits off-axis
        // (e.g. small `client` above wide `api`). Shim by half the perp
        // difference. Same trick as anchorBus/anchorFanOut/anchorBranch.
        const fromPerp = extentFor(e.from, ctx).perp;
        const toPerp = extentFor(e.to, ctx).perp;
        const perpShim = Math.floor((fromPerp - toPerp) / 2);
        ctx.cells.set(e.to, perpShimAlong(stepForward(a, fwd, fromExt), fwd, perpShim));
        ctx.placedBy.set(e.to, `edge ${e.from} -> ${e.to}`);
        if (!ctx.forward.has(e.to)) ctx.forward.set(e.to, fwd);
      } else {
        // Reverse-flow: place `from` `to-extent + gap` cells *back* from
        // `to` so the channel-router has a runway between them.
        const b = ctx.cells.get(e.to)!;
        const fwd = ctx.forward.get(e.to) ?? ctx.defaultForward;
        const fromExt = extentFor(e.from, ctx).forward + PIPELINE_GAP;
        const fromPerp = extentFor(e.from, ctx).perp;
        const toPerp = extentFor(e.to, ctx).perp;
        const perpShim = Math.floor((toPerp - fromPerp) / 2);
        ctx.cells.set(e.from, perpShimAlong(stepBack(b, fwd, fromExt), fwd, perpShim));
        ctx.placedBy.set(e.from, `edge ${e.from} -> ${e.to}`);
        if (!ctx.forward.has(e.from)) ctx.forward.set(e.from, fwd);
      }
      progress = true;
    }
  }
}

/**
 * Pick a starting cell for a not-yet-anchored connected component. Use
 * the next free row at col 0; tracked on ctx so subsequent components
 * stack vertically.
 */
function nextOrigin(ctx: PlaceCtx): Cell {
  // Re-derive from current placement in case the anchor pass pushed
  // some nodes below the recorded nextFreeRow. Multi-cell: use each
  // node's FOOTPRINT bottom row, not just its anchor row.
  let maxRow = ctx.nextFreeRow - 1;
  for (const [id, c] of ctx.cells) {
    const node = ctx.nodeOf.get(id);
    const h = Math.max(1, Math.ceil(node?.size.height ?? 1));
    const bottom = c.row + h - 1;
    if (bottom > maxRow) maxRow = bottom;
  }
  // Pad past the existing block by MEMBER_GAP cells so a new flow
  // doesn't land flush against the previous block's bottom edge —
  // important when an anchor construct (e.g. fan-out) already occupies
  // rows above, and a disconnected fragment needs its own row.
  const padding = ctx.cells.size > 0 ? MEMBER_GAP : 0;
  return { row: maxRow + 1 + padding, col: 0 };
}

function stepForward(c: Cell, fwd: Direction, extent: number = 1): Cell {
  const s = step(fwd);
  return { row: c.row + s.row * extent, col: c.col + s.col * extent };
}

function stepBack(c: Cell, fwd: Direction, extent: number = 1): Cell {
  const s = step(fwd);
  return { row: c.row - s.row * extent, col: c.col - s.col * extent };
}

/**
 * Offset a cell by `n` units along the perp axis of `fwd` (the local
 * "left" direction). Used to centre a different-perp-extent successor on
 * its predecessor: shim by (predPerp - succPerp) / 2 on that axis so
 * their geometric centres line up.
 */
function perpShimAlong(c: Cell, fwd: Direction, n: number): Cell {
  if (n === 0) return c;
  const p = step(left(fwd));
  return { row: c.row + p.row * n, col: c.col + p.col * n };
}

// --- orphan parking -------------------------------------------------------

/**
 * Any node still unplaced after the anchor + flow passes has no edges
 * tying it to anything else (or all its edges connect to other still-
 * unplaced nodes — disconnected component). Park each such node at a
 * fresh row, col 0. They render but stand alone.
 *
 * E_DISCONNECTED (DESIGN §5.1) lands in a future strict-mode pass; for
 * now isolated nodes are permitted so degenerate test inputs keep
 * working.
 */
function parkOrphans(model: Model, ctx: PlaceCtx): void {
  // Gap (in cells) inserted between the last anchor-placed node and the
  // first parked orphan, so orphans don't end up flush against e.g.
  // a fan-out's bottom member. Same value MEMBER_GAP uses between
  // construct members — keeps the visual rhythm consistent.
  const ORPHAN_GAP = MEMBER_GAP;
  let firstOrphan = true;
  for (const n of model.nodes) {
    if (ctx.cells.has(n.id)) continue;
    let maxRow = -1;
    for (const [id, c] of ctx.cells) {
      const placed = ctx.nodeOf.get(id);
      const h = Math.max(1, Math.ceil(placed?.size.height ?? 1));
      const bottom = c.row + h - 1;
      if (bottom > maxRow) maxRow = bottom;
    }
    // For the first orphan, add ORPHAN_GAP cells of padding past the
    // last anchor-placed node. Subsequent orphans pack tight against
    // each other (no extra gap between orphans).
    const padding = firstOrphan ? ORPHAN_GAP : 0;
    if (maxRow + 1 + padding > ctx.nextFreeRow) ctx.nextFreeRow = maxRow + 1 + padding;
    ctx.cells.set(n.id, { row: ctx.nextFreeRow, col: 0 });
    ctx.placedBy.set(n.id, "orphan parking");
    if (!ctx.forward.has(n.id)) ctx.forward.set(n.id, ctx.defaultForward);
    const myH = Math.max(1, Math.ceil(n.size.height));
    ctx.nextFreeRow += myH;
    firstOrphan = false;
  }
}

// --- conflict detection ---------------------------------------------------

/**
 * §11.11: apply `intersect a, b` declarations. For each group, the
 * first highway's already-placed cell is the anchor; each subsequent
 * highway is shifted (along with all its via-anchor members) so it
 * coincides with the anchor cell.
 *
 * Member collision is detected naturally by the existing
 * `detectCollisions` pass — if shifting hwy_b on top of hwy_a causes
 * hwy_b's members to overlap nodes not in hwy_b's via-anchor, the
 * later collision check will flag it.
 */
function applyIntersections(model: Model, ctx: PlaceCtx): void {
  for (const group of model.intersections) {
    if (group.highways.length < 2) continue;
    const anchorName = group.highways[0]!;
    const anchorCell = ctx.cells.get(anchorName);
    if (!anchorCell) continue; // shouldn't happen — bind validated
    for (let i = 1; i < group.highways.length; i++) {
      const otherName = group.highways[i]!;
      const otherCell = ctx.cells.get(otherName);
      if (!otherCell) continue;
      const dRow = anchorCell.row - otherCell.row;
      const dCol = anchorCell.col - otherCell.col;
      // Collect the node IDs to shift: the highway itself plus all its
      // via-anchor members (sources + targets).
      const m = model.highwayMemberships.find((hm) => hm.name === otherName);
      const toShift = new Set<string>([otherName]);
      const otherSources = m ? [...m.sources] : [];
      const otherTargets = m ? [...m.targets] : [];
      for (const s of otherSources) toShift.add(s);
      for (const t of otherTargets) toShift.add(t);

      // Build occupiedFiltered: cells occupied by nodes NOT in toShift.
      // This is the obstacle set the dodge must avoid. Built per-iteration
      // so multi-highway intersections see each other's already-committed
      // members from previous iterations.
      // Multi-cell: include every footprint cell, not just the anchor.
      const occupiedFiltered = new Set<string>();
      for (const [id, c] of ctx.cells) {
        if (toShift.has(id)) continue;
        const node = ctx.nodeOf.get(id);
        const w = Math.max(1, Math.ceil(node?.size.width ?? 1));
        const h = Math.max(1, Math.ceil(node?.size.height ?? 1));
        for (let dr = 0; dr < h; dr++) {
          for (let dc = 0; dc < w; dc++) {
            occupiedFiltered.add(`${c.row + dr},${c.col + dc}`);
          }
        }
      }

      if (dRow === 0 && dCol === 0) continue;
      // First pass: naive shift onto the anchor cell.
      const tentative = new Map<string, Cell>();
      for (const id of toShift) {
        const c = ctx.cells.get(id);
        if (!c) continue;
        const shifted: Cell = { row: c.row + dRow, col: c.col + dCol };
        if (c.z !== undefined) shifted.z = c.z;
        tentative.set(id, shifted);
      }

      // Detect collisions between tentative positions and the anchor's
      // existing members (occupiedFiltered). For each colliding member,
      // bump it OUTWARD along the other-highway's flow axis until it
      // finds a free cell. The "other" highway's flow direction is in
      // ctx.forward — for sources, bump opposite-forward (north for S
      // forward); for targets, bump along-forward (south for S forward).
      const otherFwd = ctx.forward.get(otherName);
      const fStepOther = otherFwd ? step(otherFwd) : { row: 0, col: 0 };

      const bumpUntilFree = (
        id: string,
        bumpRow: number,
        bumpCol: number,
      ): void => {
        const t = tentative.get(id);
        if (!t) return;
        let row = t.row;
        let col = t.col;
        const z = t.z;
        const node = ctx.nodeOf.get(id);
        const w = Math.max(1, Math.ceil(node?.size.width ?? 1));
        const h = Math.max(1, Math.ceil(node?.size.height ?? 1));
        // Bump until the ENTIRE FOOTPRINT is free.
        const otherIds = [...tentative.keys()].filter((k) => k !== id);
        for (let step = 0; step < 40; step++) {
          let collides = false;
          for (let dr = 0; dr < h && !collides; dr++) {
            for (let dc = 0; dc < w && !collides; dc++) {
              const key = `${row + dr},${col + dc}`;
              if (occupiedFiltered.has(key)) collides = true;
              if (collides) break;
              for (const oid of otherIds) {
                const oc = tentative.get(oid)!;
                const onode = ctx.nodeOf.get(oid);
                const ow = Math.max(1, Math.ceil(onode?.size.width ?? 1));
                const oh = Math.max(1, Math.ceil(onode?.size.height ?? 1));
                if (
                  row + dr >= oc.row && row + dr < oc.row + oh &&
                  col + dc >= oc.col && col + dc < oc.col + ow
                ) {
                  collides = true;
                  break;
                }
              }
            }
          }
          if (!collides) break;
          row += bumpRow;
          col += bumpCol;
        }
        const out: Cell = { row, col };
        if (z !== undefined) out.z = z;
        tentative.set(id, out);
      };

      // Source-side bumps: bump in -forward direction (away from highway).
      for (const s of otherSources) {
        bumpUntilFree(s, -fStepOther.row, -fStepOther.col);
      }
      // Target-side bumps: bump in +forward direction.
      for (const t of otherTargets) {
        bumpUntilFree(t, fStepOther.row, fStepOther.col);
      }

      // Commit tentative positions. The next iteration's
      // `occupiedFiltered` will pick these up from ctx.cells.
      for (const [id, cell] of tentative) {
        ctx.cells.set(id, cell);
      }
    }
  }
}

function detectCollisions(model: Model, ctx: PlaceCtx): void {
  const occupied: Map<string, string> = new Map();
  // §11.11/§11.13: cell occupancy is keyed by (row, col, z) for
  // HIGHWAY nodes — two perpendicular highways at different z (e.g.,
  // surface + underground from `render: underground`) share an
  // intersection cell without collision. Non-highway nodes always
  // collide on (row, col) regardless of z: even an underground
  // highway's source/target boxes are physical surface boxes the
  // renderer draws, and two boxes can't occupy the same screen cell.
  //
  // Multi-cell occupancy: each node claims every cell in its size-
  // derived footprint (anchor + ceil(width-1) east / ceil(height-1)
  // south), not just the anchor. Two nodes whose footprints overlap on
  // any cell collide.
  const sizeOf = new Map(model.nodes.map((n) => [n.id, n.size]));
  const orientOf = (id: string): "horizontal" | "vertical" | null => {
    const node = model.nodes.find((n) => n.id === id);
    if (!node || node.shape !== "highway") return null;
    const fwd = ctx.forward.get(id);
    if (fwd === "E" || fwd === "W") return "horizontal";
    if (fwd === "N" || fwd === "S") return "vertical";
    return null;
  };
  const isHighway = (id: string): boolean => {
    const node = model.nodes.find((n) => n.id === id);
    return node?.shape === "highway";
  };
  for (const [id, cell] of ctx.cells) {
    const z = cell.z ?? 0;
    const sz = sizeOf.get(id) ?? { width: 1, height: 1 };
    const cells = footprintCells(cell, sz.width, sz.height);
    for (const fc of cells) {
      // Non-highway nodes always key on (row, col) — same cell collides
      // even at different z. Highway nodes key on (row, col, z) so two
      // perpendicular highways at different z can share an intersection.
      const key = isHighway(id)
        ? `${fc.row},${fc.col},${z}`
        : `${fc.row},${fc.col}`;
      const prev = occupied.get(key);
      if (prev !== undefined && prev !== id) {
        const oPrev = orientOf(prev);
        const oCurr = orientOf(id);
        if (oPrev !== null && oCurr !== null && oPrev !== oCurr) {
          // Perpendicular highways at the same cell — allowed `+` case.
          continue;
        }
        throw new PlacementError(
          `E_AMBIGUOUS_PLACEMENT: nodes '${prev}' and '${id}' both placed at ` +
            `(row ${fc.row}, col ${fc.col}). ` +
            `Add a structured-flow constraint to disambiguate, or split the source. ` +
            `Hint: if '${id}' is a side-channel off a spine member, use ` +
            `\`branch <name>:right: <spine> -> ${id}\` (or \`:left:\`) — a bare ` +
            `edge to '${id}' makes the placer extend the spine and collide. ` +
            `For multiple side-shoots off the same node, use \`fan-out\` instead of ` +
            `several \`branch\`es with the same side.`,
        );
      }
      occupied.set(key, id);
    }
  }
}

// --- normalisation --------------------------------------------------------

/**
 * Shift all cells so the minimum row and col are both 0, then derive
 * the per-row / per-col cell-unit sizes from the nodes that landed in
 * each row/col.
 */
function normalise(model: Model, ctx: PlaceCtx): Placement {
  // Compute grid extent from each node's FOOTPRINT, not just its anchor.
  // A node at anchor (r, c) with size (w, h) occupies rows
  // [r, r + ceil(h) - 1] and cols [c, c + ceil(w) - 1].
  const sizeOf = new Map(model.nodes.map((n) => [n.id, n.size]));
  let minRow = Infinity;
  let minCol = Infinity;
  let maxRow = -Infinity;
  let maxCol = -Infinity;
  for (const [id, c] of ctx.cells) {
    const sz = sizeOf.get(id) ?? { width: 1, height: 1 };
    const hCells = Math.max(1, Math.ceil(sz.height));
    const wCells = Math.max(1, Math.ceil(sz.width));
    if (c.row < minRow) minRow = c.row;
    if (c.col < minCol) minCol = c.col;
    if (c.row + hCells - 1 > maxRow) maxRow = c.row + hCells - 1;
    if (c.col + wCells - 1 > maxCol) maxCol = c.col + wCells - 1;
  }
  if (!Number.isFinite(minRow)) {
    // Empty model.
    return {
      cells: new Map(),
      rowUnits: [],
      colUnits: [],
      flowAxis: ctx.flowAxis,
      forwardAt: new Map(),
    };
  }
  // Back-edge perimeter buffer: when the model has back-edges, reserve
  // a 2-cell buffer around the diagram so the channel router's
  // perimeter routing has room to wrap around the outermost nodes
  // rather than threading through interior gaps. Without this, a
  // tightly-packed diagram has no "outside" — every column is occupied
  // by some node — and back-edges fall back to interior corridors. The
  // shift below pulls every cell IN by `BACK_EDGE_PAD` on min{row,col}
  // and grows the grid extent by another `BACK_EDGE_PAD` past max so
  // the buffer appears on all four sides.
  const BACK_EDGE_PAD = 2;
  const hasBackEdge = model.edges.some((e) => e.isBackEdge);
  const pad = hasBackEdge ? BACK_EDGE_PAD : 0;
  const shifted: Map<string, Cell> = new Map();
  for (const [id, c] of ctx.cells) {
    const cell: Cell = { row: c.row - minRow + pad, col: c.col - minCol + pad };
    if (c.z !== undefined) cell.z = c.z;
    shifted.set(id, cell);
  }
  const nRows = maxRow - minRow + 1 + 2 * pad;
  const nCols = maxCol - minCol + 1 + 2 * pad;
  // Multi-cell occupancy: every row contributes a unit cell (= 1).
  // Nodes' larger sizes are expressed by their footprints spanning
  // multiple rows/cols, not by inflating the anchor row's unit count.
  // Text-fit handles fractional last-row contributions separately.
  const rowUnits = new Array<number>(nRows).fill(1);
  const colUnits = new Array<number>(nCols).fill(1);
  return {
    cells: shifted,
    rowUnits,
    colUnits,
    flowAxis: ctx.flowAxis,
    forwardAt: new Map(ctx.forward),
  };
}
