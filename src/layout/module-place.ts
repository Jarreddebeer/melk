/**
 * Per-module placement pass (DESIGN-PHASE5-MODULES.md §3.1, §3.2).
 *
 * Runs after `bind` and before the parent `place` step. For each imported
 * module:
 *
 *   1. Run the full layout pipeline on the module's sub-Model (place →
 *      text-fit → corridors → tracks → polylines) under the module's own
 *      resolved theme.
 *   2. Compute the module's pixel-space footprint and the local pixel
 *      positions of every internal node that's referenced from the
 *      parent (the port table).
 *   3. Replace the synthetic module-shape node's placeholder 1x1 size on
 *      the parent model with the cell-derived size (ceil(width / CELL_PX)
 *      x ceil(height / CELL_PX)) so the parent placer reserves enough
 *      room.
 *
 * Why a separate pass and not part of bind? Bind is a pure AST → Model
 * transform; running the placer inside bind would entangle two layers.
 * Why not let the parent placer handle it lazily? The parent placer
 * needs to know module dimensions *before* it places any cell — a
 * separate pre-pass gives it those numbers without coupling.
 */
import type {
  ImportedModule,
  Model,
  ModelNode,
  ModulePort,
} from "../bind/model.js";
import type { Theme } from "../theme/theme.js";
import { CELL_PX } from "./corridors.js";
import type { Reservation } from "./corridors.js";
import { reserveCorridors } from "./corridors.js";
import { place } from "./place.js";
import type { Placement } from "./placement.js";
import { computePixelLayout } from "./pixels.js";
import { applyTextFit } from "./text-fit.js";
import { packTracks } from "./tracks.js";
import { buildPolylines } from "./polyline.js";
import type { Polylines } from "./polyline.js";

/**
 * The post-place sub-model state attached to each `ImportedModule` so
 * the renderer (Cut 5) can emit the module's body without re-running
 * the layout pipeline. Carries the resolved theme so the renderer
 * knows which palette to use inside the module's `<g>`.
 */
export interface ModulePlacedBody {
  placement: Placement;
  reservation: Reservation;
  polylines: Polylines;
  theme: Theme;
}

/**
 * Resolves the theme to apply to one imported module
 * (DESIGN-PHASE5-MODULES.md §9.2). The caller supplies a function that
 * takes a module's `themeName` (already resolved against the module's
 * own directory at bind-time override application) and returns a
 * loaded `Theme`. This keeps theme I/O out of the layout layer.
 */
export type ModuleThemeResolver = (module: ImportedModule) => Theme;

/**
 * Run per-module placement for every imported module in `model.imports`.
 *
 * Mutates:
 *   - Each `ImportedModule` to populate `pixelWidth`, `pixelHeight`,
 *     `ports`.
 *   - The corresponding synthetic node on `model.nodes` (with id ===
 *     module's alias) to update `size` from the placeholder 1x1 to the
 *     cell-derived footprint.
 *
 * Recursive: a module that itself contains imports has its own
 * `placeModules` call before its placement runs.
 */
export function placeModules(
  model: Model,
  resolveTheme: ModuleThemeResolver,
): void {
  // Index parent edges by the module alias they touch so we can build
  // each module's port table from "internal node ids actually referenced
  // from the parent".
  const referencedInternalsByAlias = new Map<string, Set<string>>();
  for (const edge of model.edges) {
    if (edge.fromInternal !== undefined) {
      let set = referencedInternalsByAlias.get(edge.from);
      if (set === undefined) {
        set = new Set();
        referencedInternalsByAlias.set(edge.from, set);
      }
      set.add(edge.fromInternal);
    }
    if (edge.toInternal !== undefined) {
      let set = referencedInternalsByAlias.get(edge.to);
      if (set === undefined) {
        set = new Set();
        referencedInternalsByAlias.set(edge.to, set);
      }
      set.add(edge.toInternal);
    }
  }

  for (const imported of model.imports) {
    // Recurse first so any nested modules are fully placed before this
    // module's own placer runs.
    placeModules(imported.model, resolveTheme);

    const theme = resolveTheme(imported);

    // Run the placement pipeline on the sub-model. Track packing and
    // polyline building happen here too so the renderer (Cut 5) can
    // emit the module's body without re-running the layout pipeline.
    const subPlacement = place(imported.model);
    const subFit = applyTextFit(subPlacement, imported.model, theme);
    const subReservation = reserveCorridors(imported.model, subFit);
    const subPacking = packTracks(imported.model, subFit, subReservation);
    const subPolylines = buildPolylines(
      imported.model,
      subFit,
      subReservation,
      subPacking,
    );
    const layout = computePixelLayout(subFit, subReservation);

    const pixelWidth = layout.totalWidth;
    const pixelHeight = layout.totalHeight;

    imported.pixelWidth = pixelWidth;
    imported.pixelHeight = pixelHeight;
    imported.body = {
      placement: subFit,
      reservation: subReservation,
      polylines: subPolylines,
      theme,
    } satisfies ModulePlacedBody;

    // Build the port table for parent-referenced internal nodes.
    const referenced = referencedInternalsByAlias.get(imported.alias);
    const isLR = imported.model.layoutMode === "lr";
    if (referenced !== undefined && referenced.size > 0) {
      const ports = new Map<string, ModulePort>();
      const sizeOf = new Map(
        imported.model.nodes.map((n) => [n.id, n.size]),
      );
      for (const internalId of referenced) {
        const cell = subFit.cells.get(internalId);
        if (cell === undefined) continue;
        const sz = sizeOf.get(internalId) ?? { width: 1, height: 1 };
        const widthPx = sz.width * CELL_PX;
        const heightPx = sz.height * CELL_PX;
        const left = layout.colX[cell.col]! +
          (layout.colWidthPx[cell.col]! - widthPx) / 2;
        const top = layout.rowY[cell.row]! +
          (layout.rowHeightPx[cell.row]! - heightPx) / 2;
        const centerX = left + widthPx / 2;
        const centerY = top + heightPx / 2;
        ports.set(internalId, {
          internalNodeId: internalId,
          localX: centerX,
          localY: centerY,
          localWidth: widthPx,
          localHeight: heightPx,
          faceSide: pickFaceSide(
            centerX,
            centerY,
            pixelWidth,
            pixelHeight,
            isLR,
          ),
        });
      }
      imported.ports = ports;
    } else {
      imported.ports = new Map();
    }

    // Build face ports — implicit entry/exit positions for face-to-face
    // module edges (no qualified ref). For each face, pick the closest
    // internal node and use its matching face midpoint.
    imported.facePorts = buildFacePorts(
      imported.model,
      subFit,
      layout,
      pixelWidth,
      pixelHeight,
    );

    // Update the synthetic module node's size on the parent model.
    // Pad by MODULE_GUTTER on each axis so neighbouring modules don't
    // butt up against each other — the corridor space around each
    // module needs breathing room for trace channels, and the slack
    // is also what applyModuleAlignment uses to straighten flow-axis
    // ports.
    const syntheticNode: ModelNode | undefined = model.nodes.find(
      (n) => n.id === imported.alias && n.shape === "module",
    );
    if (syntheticNode !== undefined) {
      syntheticNode.size = {
        width: Math.max(1, Math.ceil(pixelWidth / CELL_PX)) +
          MODULE_GUTTER_COLS,
        height: Math.max(1, Math.ceil(pixelHeight / CELL_PX)) +
          MODULE_GUTTER_ROWS,
      };
    }
  }
}

/**
 * Extra rows/columns added to every imported module's synthetic node
 * size beyond what the body strictly needs. The cell allocation grows
 * by this much, creating outer slack along both axes:
 *
 *   - Visually, neighbouring modules sit further apart so the trace
 *     channels between them have room to breathe.
 *   - Mechanically, `applyModuleAlignment` uses the slack to shift the
 *     body inside its cell so flow-axis ports line up with neighbours.
 *     Zero-slack modules can't align; padding gives them headroom.
 *
 * Two rows/columns total (one on each side) is a balance: enough to
 * absorb a typical 1-row vertical mismatch between adjacent modules
 * without ballooning the canvas.
 */
const MODULE_GUTTER_ROWS = 2;
const MODULE_GUTTER_COLS = 2;

/**
 * Compute implicit face ports — entry/exit positions on each face for
 * face-to-face module edges (no qualified ref).
 *
 * Per face, return an ordered list of candidate port positions, each
 * the matching face midpoint of one visible internal node. The list is
 * sorted such that:
 *
 *   - The *closest* internal node to the face appears first
 *     (primary sort key: perpendicular distance to the face).
 *   - Ties (multiple nodes equally close, e.g. a horizontal pipeline
 *     all sharing one S boundary) are broken by position along the
 *     face axis (left-to-right for N/S; top-to-bottom for E/W).
 *
 * Effect for the polyline builder:
 *   - 1 incoming edge → slot 0 → first candidate (closest, leftmost-
 *     or-topmost on tie) — equivalent to the previous single-port
 *     behaviour.
 *   - N incoming edges → the slot allocator already orders them
 *     spatially by opposite-endpoint perp coord; mapping slot i →
 *     candidate i spreads them across distinct internal nodes when
 *     enough are available. Overflow cycles via modulo.
 *
 * Highways are excluded (routing-only, no visible mark). Nested
 * module-shape nodes are excluded too (would need their own face port
 * resolution — deferred).
 */
function buildFacePorts(
  subModel: Model,
  subPlacement: Placement,
  layout: ReturnType<typeof computePixelLayout>,
  pixelWidth: number,
  pixelHeight: number,
): ImportedModule["facePorts"] {
  const boxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
  for (const n of subModel.nodes) {
    if (n.shape === "highway") continue;
    if (n.shape === "module") continue;
    const cell = subPlacement.cells.get(n.id);
    if (cell === undefined) continue;
    const w = n.size.width * CELL_PX;
    const h = n.size.height * CELL_PX;
    const x = layout.colX[cell.col]! + (layout.colWidthPx[cell.col]! - w) / 2;
    const y = layout.rowY[cell.row]! + (layout.rowHeightPx[cell.row]! - h) / 2;
    boxes.push({ id: n.id, x, y, w, h });
  }
  if (boxes.length === 0) {
    return { N: [], S: [], E: [], W: [] };
  }
  // Helpers to compute "distance to face" and tie-break by face-axis
  // position. The face axis for E/W is Y (vertical); for N/S it's X.
  const candidatesForFace = (
    side: "N" | "S" | "E" | "W",
  ): { localX: number; localY: number }[] => {
    type Cand = {
      port: { localX: number; localY: number };
      dist: number; // perpendicular distance to the face line
      axis: number; // position along the face axis
    };
    const cands: Cand[] = [];
    for (const b of boxes) {
      switch (side) {
        case "W":
          cands.push({
            port: { localX: b.x, localY: b.y + b.h / 2 },
            dist: b.x,
            axis: b.y + b.h / 2,
          });
          break;
        case "E":
          cands.push({
            port: { localX: b.x + b.w, localY: b.y + b.h / 2 },
            dist: pixelWidth - (b.x + b.w),
            axis: b.y + b.h / 2,
          });
          break;
        case "N":
          cands.push({
            port: { localX: b.x + b.w / 2, localY: b.y },
            dist: b.y,
            axis: b.x + b.w / 2,
          });
          break;
        case "S":
          cands.push({
            port: { localX: b.x + b.w / 2, localY: b.y + b.h },
            dist: pixelHeight - (b.y + b.h),
            axis: b.x + b.w / 2,
          });
          break;
      }
    }
    // Sort by (distance ascending, then axis ascending).
    cands.sort((a, b) => a.dist - b.dist || a.axis - b.axis);
    return cands.map((c) => c.port);
  };
  return {
    N: candidatesForFace("N"),
    S: candidatesForFace("S"),
    E: candidatesForFace("E"),
    W: candidatesForFace("W"),
  };
}

/**
 * Pick the face of the module's bounding box closest to a port's
 * internal centroid (DESIGN-PHASE5-MODULES.md §4.3). The parent edge
 * router uses this as the *suggested* arrival direction for the
 * polyline's final segment.
 *
 * Distance is the perpendicular drop from the centroid to each face;
 * smallest wins. Ties are resolved by preferring the *flow-axis* faces
 * (W/E under LR, N/S under TB) — the natural entry/exit faces for a
 * module rendered under that layout. A horizontally-flowing 1-cell-tall
 * module would otherwise put every port on N (the closest tied face by
 * pure distance) instead of W/E, which is what the router and user
 * mental model expect.
 */
/**
 * Cross-flow body alignment for imported modules.
 *
 * Each module body is centered inside its synthetic cell by default
 * (`(parentBox - pixelBody) / 2`). If the cell allocates more room
 * than the body needs (the parent placer rounds the cell extent up to
 * a multiple of CELL_PX), the body has slack along the cross-flow
 * axis. We use that slack to shift the body so its flow-axis face
 * port (the closest internal node on the W face for an LR module
 * receiving a forward edge, or the E face for one emitting one) lines
 * up vertically with the corresponding port on the connected
 * counterpart — a regular node's centroid, or another module's face
 * port. Result: face-to-face module edges become straight lines
 * instead of S-curves.
 *
 * Two passes:
 *   1. Anchor pass — for each module touching a regular node via a
 *      face-to-face edge along the parent's flow axis, set the
 *      module's `bodyOffsetY` (LR parent) or `bodyOffsetX` (TB
 *      parent) so the module's relevant face port lines up with the
 *      regular node's centroid.
 *   2. Propagation pass — repeat: for each unanchored module
 *      neighbouring at least one anchored one, average the offsets
 *      implied by each anchored neighbour. Iterate until no change.
 *
 * Clamp each offset so the body stays inside the synthetic cell —
 * we never shift more than half the slack (`(cell - body) / 2`)
 * because the body still has to fit.
 *
 * Qualified-ref edges (`mod.foo -> ...`) are not considered here.
 * They're tied to specific internal nodes that may sit on any face
 * inside the module; aligning a body to satisfy them would conflict
 * with alignment from face-to-face edges. They route through the
 * polyline pipeline as-is.
 */
export function applyModuleAlignment(
  model: Model,
  placement: Placement,
  reservation: Reservation,
): void {
  if (model.imports.length === 0) return;
  const isLR = model.layoutMode === "lr";
  const layout = computePixelLayout(placement, reservation);
  const flowFromSide: "E" | "S" = isLR ? "E" : "S";
  const flowToSide: "W" | "N" = isLR ? "W" : "N";

  // Build a quick lookup: alias -> ImportedModule.
  const modules = new Map<string, ImportedModule>();
  for (const m of model.imports) modules.set(m.alias, m);

  // For each module, the full cell pixel rect — the box that owns the
  // module body. The synthetic node's smaller centered rect doesn't
  // matter here; only the cell allocation does, because that's where
  // the body has slack to shift.
  type CellBox = { x: number; y: number; w: number; h: number };
  const cellBoxOf = new Map<string, CellBox>();
  for (const imported of model.imports) {
    const cell = placement.cells.get(imported.alias);
    if (cell === undefined) continue;
    cellBoxOf.set(imported.alias, {
      x: layout.colX[cell.col]!,
      y: layout.rowY[cell.row]!,
      w: layout.colWidthPx[cell.col]!,
      h: layout.rowHeightPx[cell.row]!,
    });
  }

  // For each module, the centered-body origin (no offset applied yet).
  // The "free slot" along the cross-flow axis is (cell - body), shared
  // equally above and below as half-pitch slack.
  const baseOriginOf = new Map<string, { x: number; y: number }>();
  const slackOf = new Map<string, { x: number; y: number }>();
  for (const [alias, box] of cellBoxOf.entries()) {
    const imported = modules.get(alias)!;
    const pw = imported.pixelWidth ?? 0;
    const ph = imported.pixelHeight ?? 0;
    baseOriginOf.set(alias, {
      x: box.x + Math.max(0, (box.w - pw) / 2),
      y: box.y + Math.max(0, (box.h - ph) / 2),
    });
    slackOf.set(alias, {
      x: Math.max(0, (box.w - pw) / 2),
      y: Math.max(0, (box.h - ph) / 2),
    });
  }

  // Regular-node centroid in world pixels (for anchoring).
  const regularCentroid = (id: string): { x: number; y: number } | undefined => {
    const cell = placement.cells.get(id);
    if (cell === undefined) return undefined;
    const node = model.nodes.find((n) => n.id === id);
    if (node === undefined || node.shape === "module") return undefined;
    const w = node.size.width * CELL_PX;
    const h = node.size.height * CELL_PX;
    const x = layout.colX[cell.col]! +
      (layout.colWidthPx[cell.col]! - w) / 2;
    const y = layout.rowY[cell.row]! +
      (layout.rowHeightPx[cell.row]! - h) / 2;
    return { x: x + w / 2, y: y + h / 2 };
  };

  // For a module, the local port y/x on a given side — using the
  // [0] candidate (closest-to-face, the snap default for a single
  // face-to-face edge). Returns undefined when no candidate exists.
  const facePortLocal = (
    alias: string,
    side: "N" | "S" | "E" | "W",
  ): { localX: number; localY: number } | undefined => {
    const imported = modules.get(alias);
    if (imported === undefined) return undefined;
    return imported.facePorts?.[side]?.[0];
  };

  // The target world coord (y for LR, x for TB) for module M's flow
  // port to match counterpart C, given M and C are face-to-face on the
  // route's flow axis. Returns the implied bodyOffset to land on it,
  // before clamping.
  type Constraint = { alias: string; targetOffset: number };
  const constraintsForModule = new Map<string, Constraint[]>();
  for (const m of model.imports) constraintsForModule.set(m.alias, []);

  // Collect face-to-face flow-axis edges that touch a regular node OR
  // another module, and translate them into per-module offset
  // constraints.
  for (const route of reservation.routes) {
    const edge = model.edges[route.edgeIndex];
    if (edge === undefined) continue;
    const aIsMod = modules.has(edge.from);
    const bIsMod = modules.has(edge.to);
    if (!aIsMod && !bIsMod) continue;
    // Skip qualified refs — they pin to specific internal nodes, not
    // a face port. Aligning the body to satisfy them is out of scope
    // here.
    if (edge.fromInternal !== undefined || edge.toInternal !== undefined) {
      continue;
    }
    // Only consider edges where the route uses the parent flow-axis
    // faces on both ends. Cross-flow edges (e.g. the branch from
    // `ingest -> observability`) drive a perpendicular layout that
    // alignment along the cross-flow axis can't help.
    if (route.sourceSide !== flowFromSide && route.sourceSide !== flowToSide) {
      continue;
    }
    if (route.targetSide !== flowFromSide && route.targetSide !== flowToSide) {
      continue;
    }

    const aPort = aIsMod
      ? facePortLocal(edge.from, route.sourceSide)
      : undefined;
    const bPort = bIsMod
      ? facePortLocal(edge.to, route.targetSide)
      : undefined;

    // What world coord does each end *currently* want, before we shift
    // any body? For a module, that's baseOrigin + facePort.localCoord.
    // For a regular node, it's the centroid coord.
    const aWorld = aIsMod
      ? aPort === undefined
        ? undefined
        : {
            x: baseOriginOf.get(edge.from)!.x + aPort.localX,
            y: baseOriginOf.get(edge.from)!.y + aPort.localY,
          }
      : regularCentroid(edge.from);
    const bWorld = bIsMod
      ? bPort === undefined
        ? undefined
        : {
            x: baseOriginOf.get(edge.to)!.x + bPort.localX,
            y: baseOriginOf.get(edge.to)!.y + bPort.localY,
          }
      : regularCentroid(edge.to);
    if (aWorld === undefined || bWorld === undefined) continue;

    // The cross-flow coord both ends want to agree on:
    //   LR parent → align Y.
    //   TB parent → align X.
    const axisKey: "x" | "y" = isLR ? "y" : "x";

    // For each module side of the edge, the implied offset to bring
    // its port to match the other side's current world coord.
    if (aIsMod && aPort !== undefined) {
      const target = bWorld[axisKey];
      const current = aWorld[axisKey];
      const delta = target - current;
      constraintsForModule.get(edge.from)!.push({
        alias: edge.from,
        targetOffset: delta,
      });
    }
    if (bIsMod && bPort !== undefined) {
      const target = aWorld[axisKey];
      const current = bWorld[axisKey];
      const delta = target - current;
      constraintsForModule.get(edge.to)!.push({
        alias: edge.to,
        targetOffset: delta,
      });
    }
  }

  // Resolve constraints by iteration. Start with all modules at
  // offset 0; on each pass, for every module with a non-empty
  // constraint set, set its offset to the mean of the constraints'
  // targets (clamped to slack). Recompute the constraints' world coords
  // each pass (so propagation works). Stop when no module's offset
  // moves by more than 0.5 px.
  const offsetXOf = new Map<string, number>();
  const offsetYOf = new Map<string, number>();
  for (const m of model.imports) {
    offsetXOf.set(m.alias, 0);
    offsetYOf.set(m.alias, 0);
  }

  const portWorldCoord = (alias: string, side: "N" | "S" | "E" | "W"): number | undefined => {
    const p = facePortLocal(alias, side);
    if (p === undefined) return undefined;
    const base = baseOriginOf.get(alias)!;
    if (isLR) return base.y + (offsetYOf.get(alias) ?? 0) + p.localY;
    return base.x + (offsetXOf.get(alias) ?? 0) + p.localX;
  };
  const counterpartWorldCoord = (id: string, side: "N" | "S" | "E" | "W"): number | undefined => {
    if (modules.has(id)) return portWorldCoord(id, side);
    const c = regularCentroid(id);
    if (c === undefined) return undefined;
    return isLR ? c.y : c.x;
  };

  // Iterative propagation. Per pass, for each module collect the
  // deltas each connected edge implies. Categorize:
  //   - module-side: the other end is another module (flexible).
  //   - regular-side: the other end is a regular node (fixed).
  // Prefer module-side constraints when present — the user's mental
  // model is "module-to-module chains should be straight" (e.g.
  // edge -> ingest -> compute), and a regular endpoint usually has
  // unrelated y. Regular-side is used only when no module-side
  // constraint exists for this module.
  const maxIters = 24;
  for (let iter = 0; iter < maxIters; iter++) {
    let maxMove = 0;
    for (const imported of model.imports) {
      const moduleSide: number[] = [];
      const regularSide: number[] = [];
      for (const route of reservation.routes) {
        const edge = model.edges[route.edgeIndex];
        if (edge === undefined) continue;
        if (edge.fromInternal !== undefined || edge.toInternal !== undefined) {
          continue;
        }
        if (route.sourceSide !== flowFromSide && route.sourceSide !== flowToSide) continue;
        if (route.targetSide !== flowFromSide && route.targetSide !== flowToSide) continue;
        let myId: string;
        let mySide: "N" | "S" | "E" | "W";
        let otherId: string;
        let otherSide: "N" | "S" | "E" | "W";
        if (edge.from === imported.alias) {
          myId = edge.from;
          mySide = route.sourceSide;
          otherId = edge.to;
          otherSide = route.targetSide;
        } else if (edge.to === imported.alias) {
          myId = edge.to;
          mySide = route.targetSide;
          otherId = edge.from;
          otherSide = route.sourceSide;
        } else {
          continue;
        }
        const otherCoord = counterpartWorldCoord(otherId, otherSide);
        if (otherCoord === undefined) continue;
        const myPort = facePortLocal(myId, mySide);
        if (myPort === undefined) continue;
        const base = baseOriginOf.get(myId)!;
        const portLocal = isLR ? myPort.localY : myPort.localX;
        const baseCoord = isLR ? base.y : base.x;
        const delta = otherCoord - baseCoord - portLocal;
        if (modules.has(otherId)) {
          moduleSide.push(delta);
        } else {
          regularSide.push(delta);
        }
      }
      const sums = moduleSide.length > 0 ? moduleSide : regularSide;
      if (sums.length === 0) continue;
      const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
      const slack = slackOf.get(imported.alias)!;
      const limit = isLR ? slack.y : slack.x;
      const clamped = Math.max(-limit, Math.min(limit, mean));
      const map = isLR ? offsetYOf : offsetXOf;
      const prev = map.get(imported.alias) ?? 0;
      map.set(imported.alias, clamped);
      const move = Math.abs(clamped - prev);
      if (move > maxMove) maxMove = move;
    }
    if (maxMove < 0.5) break;
  }

  // Snap offsets to whole pixels (avoids sub-pixel SVG artifacts) and
  // write them back to the imports.
  for (const imported of model.imports) {
    const ox = Math.round(offsetXOf.get(imported.alias) ?? 0);
    const oy = Math.round(offsetYOf.get(imported.alias) ?? 0);
    if (ox !== 0) imported.bodyOffsetX = ox;
    if (oy !== 0) imported.bodyOffsetY = oy;
  }
}

function pickFaceSide(
  cx: number,
  cy: number,
  width: number,
  height: number,
  isLR: boolean,
): "N" | "S" | "E" | "W" {
  const dN = cy;
  const dS = height - cy;
  const dW = cx;
  const dE = width - cx;
  // Iterate in flow-axis-first order so the first-min wins ties on the
  // flow face. Under LR, try W, E, N, S; under TB, try N, S, W, E.
  const order: ("N" | "S" | "E" | "W")[] = isLR
    ? ["W", "E", "N", "S"]
    : ["N", "S", "W", "E"];
  const distances: Record<"N" | "S" | "E" | "W", number> = {
    N: dN,
    S: dS,
    E: dE,
    W: dW,
  };
  let best = order[0]!;
  let bestD = distances[best];
  for (let i = 1; i < order.length; i++) {
    const side = order[i]!;
    if (distances[side] < bestD) {
      best = side;
      bestD = distances[side];
    }
  }
  return best;
}
