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
const MEMBER_GAP = 1;

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
    // Park the whole group at a fresh row, col 0.
    refRow = ctx.nextFreeRow;
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
  // Pipeline members lie on consecutive cells along the local forward
  // direction (DESIGN §2.2, §2.5). Multi-cell occupancy: each member's
  // offset advances by the PREVIOUS member's forward extent, so a 5x9
  // hub at members[0] and a 5x5 default at members[1] sit on adjacent
  // cells, not overlapping. Forward is inherited from member[0] if
  // already placed; otherwise the page default.
  const fwd = inheritForward(p.members[0]!, ctx);
  const s = step(fwd);
  const offsets: Cell[] = [];
  let accum = 0;
  for (let i = 0; i < p.members.length; i++) {
    offsets.push({ row: s.row * accum, col: s.col * accum });
    accum += extentFor(p.members[i]!, ctx).forward;
  }
  const forwards = p.members.map(() => fwd);
  applyAnchor(p.members, offsets, forwards, ctx, `pipeline '${p.name}'`);
}

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
  const anchorPerp = anchorPerpOf(b.producers, perpOffsets, b.shared, ctx);

  for (let i = 0; i < n; i++) {
    const po = perpOffsets[i]!;
    offsets.push({ row: -pStep.row * po, col: -pStep.col * po });
  }
  // Shared: one max-producer-forward-extent step forward at the anchor.
  let maxProducerFwd = 1;
  for (const p of b.producers) {
    const ext = extentFor(p, ctx).forward;
    if (ext > maxProducerFwd) maxProducerFwd = ext;
  }
  offsets.push({
    row: fStep.row * maxProducerFwd + -pStep.row * anchorPerp,
    col: fStep.col * maxProducerFwd + -pStep.col * anchorPerp,
  });
  const forwards = members.map(() => fwd);
  applyAnchor(members, offsets, forwards, ctx, `bus '${b.name}'`);
}

/**
 * Anchor offset (in perp cell-units) for `shared` such that shared's
 * geometric centre lands on the member block's geometric centre.
 *
 *   blockCentre = midpoint of (first member's leading edge,
 *                              last member's trailing edge)
 *   anchorPerp  = blockCentre - sharedPerp / 2   (shared's top row)
 *
 * Same expression for odd and even n — no parity branch. A non-integer
 * result is snapped down by `Math.floor` so the cell map only sees
 * whole cells; that introduces at most a half-cell asymmetry when
 * block-height and shared-height have different parity.
 */
function anchorPerpOf(
  memberIds: string[],
  perpOffsets: number[],
  sharedId: string,
  ctx: PlaceCtx,
): number {
  const first = perpOffsets[0]!;
  const lastIdx = memberIds.length - 1;
  const last = perpOffsets[lastIdx]! + extentFor(memberIds[lastIdx]!, ctx).perp;
  const blockCentre = (first + last) / 2;
  const sharedPerp = extentFor(sharedId, ctx).perp;
  return Math.floor(blockCentre - sharedPerp / 2);
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
  const anchorPerp = anchorPerpOf(f.consumers, perpOffsets, f.shared, ctx);

  // Shared sits at -pStep * anchorPerp (perp-centered on consumers).
  offsets.push({ row: -pStep.row * anchorPerp, col: -pStep.col * anchorPerp });
  // Each consumer: one shared-forward-extent step forward at its perp.
  const sharedFwdExtent = extentFor(f.shared, ctx).forward;
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
  const parentFwd = inheritForward(b.spine, ctx);
  const side = b.side ?? "left";
  const branchFwd: Direction = side === "left" ? left(parentFwd) : right(parentFwd);
  const s = step(branchFwd);
  // The branch direction is perpendicular to parentFwd, so we step by
  // the spine's perp extent (its dim along the branch axis).
  const spinePerp = extentFor(b.spine, ctx).perp;
  applyAnchor(
    [b.spine, b.member],
    [{ row: 0, col: 0 }, { row: s.row * spinePerp, col: s.col * spinePerp }],
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
  for (let i = 0; i < nSrc; i++) {
    const po = srcPerpOffsets[i]! - srcMedianPerp;
    offsets.push({
      row: -fStep.row * maxSrcFwd + -pStep.row * po,
      col: -fStep.col * maxSrcFwd + -pStep.col * po,
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
    }
  }
  const tgtMedianIdx = Math.floor((nTgt - 1) / 2);
  const tgtMedianPerp = tgtPerpOffsets[tgtMedianIdx] ?? 0;
  // Highway forward extent: how far targets must sit beyond the
  // highway's anchor cell to be east of the highway's east face.
  const hwyFwdExtent = extentFor(m.name, ctx).forward;
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
        // Step past `from`'s forward extent (multi-cell): the next free
        // cell east of from is at from.col + from's width (lr layout).
        const fromExt = extentFor(e.from, ctx).forward;
        ctx.cells.set(e.to, stepForward(a, fwd, fromExt));
        ctx.placedBy.set(e.to, `edge ${e.from} -> ${e.to}`);
        if (!ctx.forward.has(e.to)) ctx.forward.set(e.to, fwd);
      } else {
        // Reverse-flow: place `from` `to-extent` cells *back* from `to`
        // so its trailing edge touches `to`'s leading edge.
        const b = ctx.cells.get(e.to)!;
        const fwd = ctx.forward.get(e.to) ?? ctx.defaultForward;
        const fromExt = extentFor(e.from, ctx).forward;
        ctx.cells.set(e.from, stepBack(b, fwd, fromExt));
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
  return { row: maxRow + 1, col: 0 };
}

function stepForward(c: Cell, fwd: Direction, extent: number = 1): Cell {
  const s = step(fwd);
  return { row: c.row + s.row * extent, col: c.col + s.col * extent };
}

function stepBack(c: Cell, fwd: Direction, extent: number = 1): Cell {
  const s = step(fwd);
  return { row: c.row - s.row * extent, col: c.col - s.col * extent };
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
  for (const n of model.nodes) {
    if (ctx.cells.has(n.id)) continue;
    // Re-derive nextFreeRow from the current placement to be sure we
    // don't overlap anything the flow pass put down. Multi-cell: use
    // each existing node's full footprint bottom row.
    let maxRow = -1;
    for (const [id, c] of ctx.cells) {
      const placed = ctx.nodeOf.get(id);
      const h = Math.max(1, Math.ceil(placed?.size.height ?? 1));
      const bottom = c.row + h - 1;
      if (bottom > maxRow) maxRow = bottom;
    }
    if (maxRow + 1 > ctx.nextFreeRow) ctx.nextFreeRow = maxRow + 1;
    ctx.cells.set(n.id, { row: ctx.nextFreeRow, col: 0 });
    ctx.placedBy.set(n.id, "orphan parking");
    if (!ctx.forward.has(n.id)) ctx.forward.set(n.id, ctx.defaultForward);
    // Advance past THIS node's own footprint.
    const myH = Math.max(1, Math.ceil(n.size.height));
    ctx.nextFreeRow += myH;
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
  const shifted: Map<string, Cell> = new Map();
  for (const [id, c] of ctx.cells) {
    const cell: Cell = { row: c.row - minRow, col: c.col - minCol };
    if (c.z !== undefined) cell.z = c.z;
    shifted.set(id, cell);
  }
  const nRows = maxRow - minRow + 1;
  const nCols = maxCol - minCol + 1;
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
