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
    const syntheticNode: ModelNode | undefined = model.nodes.find(
      (n) => n.id === imported.alias && n.shape === "module",
    );
    if (syntheticNode !== undefined) {
      syntheticNode.size = {
        width: Math.max(1, Math.ceil(pixelWidth / CELL_PX)),
        height: Math.max(1, Math.ceil(pixelHeight / CELL_PX)),
      };
    }
  }
}

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
