/**
 * Module endpoint translation (DESIGN-PHASE5-MODULES.md §4.1, §4.2).
 *
 * Shared helpers + the back-compat post-pass `applyModulePortEndpoints`.
 *
 * The router now consults `buildModulePortIndex` directly inside
 * `buildOrthogonalPolyline` so that the slot pixels at module
 * endpoints are the actual internal-node positions, not the synthetic
 * cell's face center. That means the corridor trunk routes correctly
 * around the *real* endpoints and the entry/exit segment lands cleanly
 * inside the module body (a perpendicular L-bend from the corridor
 * exit to the internal node).
 *
 * `applyModulePortEndpoints` is retained as a no-op fallback for
 * callers that don't yet integrate the routed path — keeps the public
 * surface from breaking, but it now does nothing because the polyline
 * builder already lands on the right pixels.
 */
import type { Model } from "../bind/model.js";
import type { Reservation } from "./corridors.js";
import { CELL_PX } from "./corridors.js";
import { computePixelLayout } from "./pixels.js";
import type { Placement } from "./placement.js";
import type { Polylines } from "./polyline.js";

/**
 * Per-module info needed to translate a port reference into a pixel
 * position in parent-frame coordinates.
 *
 * `ports` carries qualified-ref ports (`module.internal` named in the
 * parent edge). `facePorts` carries implicit per-face entry/exit
 * positions used by face-to-face module edges (no qualified ref); the
 * polyline builder picks the appropriate face from the route's
 * source/target side.
 */
export interface ModulePortInfo {
  originX: number;
  originY: number;
  ports: Map<string, { localX: number; localY: number }>;
  facePorts: {
    N: { localX: number; localY: number }[];
    S: { localX: number; localY: number }[];
    E: { localX: number; localY: number }[];
    W: { localX: number; localY: number }[];
  };
}

/**
 * Build a map from import alias to the module's parent-frame origin
 * and its port table. Each module's origin is the top-left of its
 * sub-SVG body in parent pixel space — already accounting for the
 * centering of the module's pixel extent inside its (possibly larger,
 * because of cell-ceil) synthetic node box. Same formula used by the
 * renderer in `renderModuleBody`.
 */
export function buildModulePortIndex(
  model: Model,
  placement: Placement,
  reservation: Reservation,
): Map<string, ModulePortInfo> {
  const out = new Map<string, ModulePortInfo>();
  if (model.imports.length === 0) return out;
  const layout = computePixelLayout(placement, reservation);
  for (const imported of model.imports) {
    if (imported.ports === undefined) continue;
    const node = model.nodes.find((n) => n.id === imported.alias);
    if (node === undefined) continue;
    const cell = placement.cells.get(imported.alias);
    if (cell === undefined) continue;
    const widthPx = node.size.width * CELL_PX;
    const heightPx = node.size.height * CELL_PX;
    const boxX = layout.colX[cell.col]! +
      (layout.colWidthPx[cell.col]! - widthPx) / 2;
    const boxY = layout.rowY[cell.row]! +
      (layout.rowHeightPx[cell.row]! - heightPx) / 2;
    const padX = Math.max(0, (widthPx - (imported.pixelWidth ?? 0)) / 2);
    const padY = Math.max(0, (heightPx - (imported.pixelHeight ?? 0)) / 2);
    out.set(imported.alias, {
      originX: boxX + padX,
      originY: boxY + padY,
      ports: imported.ports,
      facePorts: imported.facePorts ?? { N: [], S: [], E: [], W: [] },
    });
  }
  return out;
}

/**
 * Back-compat shim. The polyline builder now lands directly on
 * internal node pixels, so the original "post-process the endpoint"
 * approach is a no-op. Retained to avoid breaking existing call sites
 * (the CLI, tests, anyone else who imported it). Will be removed in a
 * future cleanup.
 *
 * If any polyline endpoint is still at the synthetic cell's face when
 * this is called, that's a sign the router didn't see the override
 * (e.g. a future code path that bypasses `buildOrthogonalPolyline`) —
 * the shim quietly patches the endpoint so the renderer at least
 * doesn't show a clearly-wrong landing point.
 */
export function applyModulePortEndpoints(
  polylines: Polylines,
  model: Model,
  placement: Placement,
  reservation: Reservation,
): void {
  if (model.imports.length === 0) return;
  const index = buildModulePortIndex(model, placement, reservation);
  for (const pl of polylines.polylines) {
    const edge = model.edges[pl.edgeIndex];
    if (edge === undefined) continue;
    if (edge.fromInternal !== undefined) {
      const info = index.get(edge.from);
      const port = info?.ports.get(edge.fromInternal);
      if (info !== undefined && port !== undefined && pl.points.length > 0) {
        const px = info.originX + port.localX;
        const py = info.originY + port.localY;
        const first = pl.points[0]!;
        if (first.x !== px || first.y !== py) {
          pl.points[0] = { x: px, y: py };
        }
      }
    }
    if (edge.toInternal !== undefined) {
      const info = index.get(edge.to);
      const port = info?.ports.get(edge.toInternal);
      if (info !== undefined && port !== undefined && pl.points.length > 0) {
        const px = info.originX + port.localX;
        const py = info.originY + port.localY;
        const last = pl.points[pl.points.length - 1]!;
        if (last.x !== px || last.y !== py) {
          pl.points[pl.points.length - 1] = { x: px, y: py };
        }
      }
    }
  }
}
