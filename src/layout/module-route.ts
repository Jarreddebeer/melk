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
  ports: Map<
    string,
    { localX: number; localY: number; localWidth: number; localHeight: number }
  >;
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
    // Center the body inside the full *cell* pixel rect — not the
    // synthetic node's smaller rect. The module body owns the cell;
    // the synthetic node is invisible. This gives applyModuleAlignment
    // the full (cellPx - body) slack to shift inside, mirroring the
    // renderer's `renderModuleBody` which now also uses the cell rect.
    void node;
    const cellX = layout.colX[cell.col]!;
    const cellY = layout.rowY[cell.row]!;
    const cellW = layout.colWidthPx[cell.col]!;
    const cellH = layout.rowHeightPx[cell.row]!;
    const padX = Math.max(0, (cellW - (imported.pixelWidth ?? 0)) / 2);
    const padY = Math.max(0, (cellH - (imported.pixelHeight ?? 0)) / 2);
    const offX = imported.bodyOffsetX ?? 0;
    const offY = imported.bodyOffsetY ?? 0;
    out.set(imported.alias, {
      originX: cellX + padX + offX,
      originY: cellY + padY + offY,
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
  // Skip if the current endpoint already sits on the internal node's
  // bounding box (any face, with slot-spread along the face axis). The
  // router lands on a face midpoint with COMB_PITCH spread for fan-in/
  // fan-out, so a true no-op needs to accept any point on the node's
  // perimeter — not just the centroid.
  const epsilon = 1e-3;
  const isOnNodePerimeter = (
    point: { x: number; y: number },
    info: { originX: number; originY: number },
    port: {
      localX: number;
      localY: number;
      localWidth: number;
      localHeight: number;
    },
  ): boolean => {
    const cx = info.originX + port.localX;
    const cy = info.originY + port.localY;
    const halfW = port.localWidth / 2;
    const halfH = port.localHeight / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    const onN = Math.abs(dy + halfH) < epsilon && Math.abs(dx) <= halfW + epsilon;
    const onS = Math.abs(dy - halfH) < epsilon && Math.abs(dx) <= halfW + epsilon;
    const onW = Math.abs(dx + halfW) < epsilon && Math.abs(dy) <= halfH + epsilon;
    const onE = Math.abs(dx - halfW) < epsilon && Math.abs(dy) <= halfH + epsilon;
    const onCentroid = Math.abs(dx) < epsilon && Math.abs(dy) < epsilon;
    return onN || onS || onW || onE || onCentroid;
  };
  for (const pl of polylines.polylines) {
    const edge = model.edges[pl.edgeIndex];
    if (edge === undefined) continue;
    if (edge.fromInternal !== undefined) {
      const info = index.get(edge.from);
      const port = info?.ports.get(edge.fromInternal);
      if (info !== undefined && port !== undefined && pl.points.length > 0) {
        const first = pl.points[0]!;
        if (!isOnNodePerimeter(first, info, port)) {
          pl.points[0] = {
            x: info.originX + port.localX,
            y: info.originY + port.localY,
          };
        }
      }
    }
    if (edge.toInternal !== undefined) {
      const info = index.get(edge.to);
      const port = info?.ports.get(edge.toInternal);
      if (info !== undefined && port !== undefined && pl.points.length > 0) {
        const last = pl.points[pl.points.length - 1]!;
        if (!isOnNodePerimeter(last, info, port)) {
          pl.points[pl.points.length - 1] = {
            x: info.originX + port.localX,
            y: info.originY + port.localY,
          };
        }
      }
    }
  }
}
