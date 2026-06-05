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
import type { Branch, Bus, FanOut, HighwayMembership, Model, Pipeline } from "../bind/model.js";
import { type Cell, type Direction, type FlowAxis, type Placement, PlacementError } from "./placement.js";

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
  for (let i = 0; i < members.length; i++) {
    const c = ctx.cells.get(members[i]!)!;
    if (c.row + 1 > ctx.nextFreeRow) ctx.nextFreeRow = c.row + 1;
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
  // direction (DESIGN §2.2, §2.5). Forward is inherited from member[0]
  // if that node was already placed; otherwise the page default.
  const fwd = inheritForward(p.members[0]!, ctx);
  const s = step(fwd);
  const offsets: Cell[] = p.members.map((_, i) => ({
    row: s.row * i,
    col: s.col * i,
  }));
  const forwards = p.members.map(() => fwd);
  applyAnchor(p.members, offsets, forwards, ctx, `pipeline '${p.name}'`);
}

function anchorBus(b: Bus, ctx: PlaceCtx): void {
  // Bus geometry, isometric (DESIGN §2.5): producers stack one cell apart
  // on the axis perpendicular to forward (a `:left`-rotated step); the
  // shared consumer sits one cell forward at the median producer's perp
  // offset. The bus's forward is inherited from `shared`.
  const fwd = inheritForward(b.shared, ctx);
  const fStep = step(fwd);
  const pStep = step(left(fwd)); // perpendicular axis; -i*pStep stacks producers along it
  const n = b.producers.length;
  const median = Math.floor((n - 1) / 2);
  const members = [...b.producers, b.shared];
  const offsets: Cell[] = [];
  for (let i = 0; i < n; i++) {
    // Producer i sits at i*pStep from producer 0. Sign here is positive
    // because `:left` of east is north, and producers were historically
    // stacked north-to-south; flipping pStep sign keeps that convention
    // — see lock entry in §11.6 "stacking direction is :left".
    // Note: stacking sign chosen so producer 0 sits at the "top" relative
    // to forward (clockwise from forward).
    offsets.push({ row: -pStep.row * i, col: -pStep.col * i });
  }
  // Shared: one step forward from producers, at the median producer's
  // perp coord.
  offsets.push({
    row: fStep.row + -pStep.row * median,
    col: fStep.col + -pStep.col * median,
  });
  const forwards = members.map(() => fwd);
  applyAnchor(members, offsets, forwards, ctx, `bus '${b.name}'`);
}

function anchorFanOut(f: FanOut, ctx: PlaceCtx): void {
  // Mirror of bus: shared at the origin, consumers one step forward at
  // consecutive perpendicular offsets.
  const fwd = inheritForward(f.shared, ctx);
  const fStep = step(fwd);
  const pStep = step(left(fwd));
  const n = f.consumers.length;
  const median = Math.floor((n - 1) / 2);
  const members = [f.shared, ...f.consumers];
  const offsets: Cell[] = [];
  offsets.push({ row: -pStep.row * median, col: -pStep.col * median });
  for (let i = 0; i < n; i++) {
    offsets.push({
      row: fStep.row + -pStep.row * i,
      col: fStep.col + -pStep.col * i,
    });
  }
  const forwards = members.map(() => fwd);
  applyAnchor(members, offsets, forwards, ctx, `fan-out '${f.name}'`);
}

function anchorBranch(b: Branch, ctx: PlaceCtx): void {
  // Direction change: anchor `member` one cell off `spine` on the
  // 90°-rotated axis, with `member` carrying the rotated forward. Any
  // downstream primitive rooted on `member` inherits that forward
  // (§2.5, §6.4).
  const parentFwd = inheritForward(b.spine, ctx);
  const side = b.side ?? "left";
  const branchFwd: Direction = side === "left" ? left(parentFwd) : right(parentFwd);
  const s = step(branchFwd);
  applyAnchor(
    [b.spine, b.member],
    [{ row: 0, col: 0 }, { row: s.row, col: s.col }],
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

  // Source-side: one cell BACK from the highway, stacked at consecutive
  // perp offsets centered around the highway. The single gutter between
  // source col and highway col carries the bundle's approach channels.
  const nSrc = m.sources.length;
  const srcMedian = Math.floor((nSrc - 1) / 2);
  for (let i = 0; i < nSrc; i++) {
    offsets.push({
      row: -fStep.row + -pStep.row * (i - srcMedian),
      col: -fStep.col + -pStep.col * (i - srcMedian),
      z: hwyZ,
    });
    forwards.push(fwd);
  }

  // Target-side: one cell FORWARD from the highway (mirror).
  const nTgt = m.targets.length;
  const tgtMedian = Math.floor((nTgt - 1) / 2);
  for (let i = 0; i < nTgt; i++) {
    offsets.push({
      row: fStep.row + -pStep.row * (i - tgtMedian),
      col: fStep.col + -pStep.col * (i - tgtMedian),
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
        ctx.cells.set(e.to, stepForward(a, fwd));
        ctx.placedBy.set(e.to, `edge ${e.from} -> ${e.to}`);
        if (!ctx.forward.has(e.to)) ctx.forward.set(e.to, fwd);
      } else {
        // Reverse-flow: place `from` one cell *back* from `to`. Keeps
        // the edge running in the flow direction.
        const b = ctx.cells.get(e.to)!;
        const fwd = ctx.forward.get(e.to) ?? ctx.defaultForward;
        ctx.cells.set(e.from, stepBack(b, fwd));
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
  // some nodes below the recorded nextFreeRow.
  let maxRow = ctx.nextFreeRow - 1;
  for (const c of ctx.cells.values()) if (c.row > maxRow) maxRow = c.row;
  return { row: maxRow + 1, col: 0 };
}

function stepForward(c: Cell, fwd: Direction): Cell {
  const s = step(fwd);
  return { row: c.row + s.row, col: c.col + s.col };
}

function stepBack(c: Cell, fwd: Direction): Cell {
  const s = step(fwd);
  return { row: c.row - s.row, col: c.col - s.col };
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
    // don't overlap anything the flow pass put down.
    let maxRow = -1;
    for (const c of ctx.cells.values()) if (c.row > maxRow) maxRow = c.row;
    if (maxRow + 1 > ctx.nextFreeRow) ctx.nextFreeRow = maxRow + 1;
    ctx.cells.set(n.id, { row: ctx.nextFreeRow, col: 0 });
    ctx.placedBy.set(n.id, "orphan parking");
    if (!ctx.forward.has(n.id)) ctx.forward.set(n.id, ctx.defaultForward);
    ctx.nextFreeRow++;
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
      const occupiedFiltered = new Set<string>();
      for (const [id, c] of ctx.cells) {
        if (toShift.has(id)) continue;
        occupiedFiltered.add(`${c.row},${c.col}`);
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
        // Bump until the cell is free (relative to occupiedFiltered and
        // already-bumped members of this same group). Cap at 20 to avoid
        // infinite loops on a pathological topology.
        const otherIds = [...tentative.keys()].filter((k) => k !== id);
        for (let step = 0; step < 20; step++) {
          const key = `${row},${col}`;
          const otherClaim = otherIds.some((oid) => {
            const oc = tentative.get(oid)!;
            return oc.row === row && oc.col === col;
          });
          if (!occupiedFiltered.has(key) && !otherClaim) break;
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
    // Non-highway nodes always key on (row, col) — same cell collides
    // even at different z. Highway nodes key on (row, col, z) so two
    // perpendicular highways at different z can share an intersection.
    const key = isHighway(id)
      ? `${cell.row},${cell.col},${z}`
      : `${cell.row},${cell.col}`;
    const prev = occupied.get(key);
    if (prev !== undefined) {
      const oPrev = orientOf(prev);
      const oCurr = orientOf(id);
      if (oPrev !== null && oCurr !== null && oPrev !== oCurr) {
        // Perpendicular highways at the same cell — allowed `+` case.
        continue;
      }
      throw new PlacementError(
        `E_AMBIGUOUS_PLACEMENT: nodes '${prev}' and '${id}' both placed at ` +
          `(row ${cell.row}, col ${cell.col}). ` +
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

// --- normalisation --------------------------------------------------------

/**
 * Shift all cells so the minimum row and col are both 0, then derive
 * the per-row / per-col cell-unit sizes from the nodes that landed in
 * each row/col.
 */
function normalise(model: Model, ctx: PlaceCtx): Placement {
  let minRow = Infinity;
  let minCol = Infinity;
  let maxRow = -Infinity;
  let maxCol = -Infinity;
  for (const c of ctx.cells.values()) {
    if (c.row < minRow) minRow = c.row;
    if (c.col < minCol) minCol = c.col;
    if (c.row > maxRow) maxRow = c.row;
    if (c.col > maxCol) maxCol = c.col;
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
  const rowUnits = new Array<number>(nRows).fill(1);
  const colUnits = new Array<number>(nCols).fill(1);
  const sizeOf = new Map(model.nodes.map((n) => [n.id, n.size]));
  for (const [id, c] of shifted) {
    const sz = sizeOf.get(id);
    if (!sz) continue;
    if (sz.height > rowUnits[c.row]!) rowUnits[c.row] = sz.height;
    if (sz.width > colUnits[c.col]!) colUnits[c.col] = sz.width;
  }
  return {
    cells: shifted,
    rowUnits,
    colUnits,
    flowAxis: ctx.flowAxis,
    forwardAt: new Map(ctx.forward),
  };
}
