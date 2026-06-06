/**
 * Module endpoint translation (DESIGN-PHASE5-MODULES.md §4.1, §4.2).
 *
 * Shared helpers for resolving module-internal endpoints to pixel
 * positions in parent-frame coordinates. The channel router emits
 * trace endpoints on the synthetic module-shape cell's face; for edges
 * with `fromInternal` / `toInternal`, this post-pass replaces those
 * endpoints with the internal node's actual port pixel so the trace
 * lands inside the module body on the right node.
 */
import type { Model } from "../bind/model.js";
import { CELL_PX } from "./slots.js";
import { computePixelLayout } from "./pixels.js";
import type { Placement } from "./placement.js";
import type { ChannelRouting } from "./channels.js";

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
 * Build a map from import alias to the module's parent-frame origin and
 * its port table. Each module's origin is the top-left of its sub-SVG
 * body in parent pixel space, with bodyOffsetX/Y from applyModuleAlignment
 * applied so face-to-face ports line up cleanly.
 */
export function buildModulePortIndex(
  model: Model,
  placement: Placement,
): Map<string, ModulePortInfo> {
  const out = new Map<string, ModulePortInfo>();
  if (model.imports.length === 0) return out;
  const layout = computePixelLayout(placement);
  for (const imported of model.imports) {
    if (imported.ports === undefined) continue;
    const cell = placement.cells.get(imported.alias);
    if (cell === undefined) continue;
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
 * Replace trace endpoints on module-internal edges with the internal
 * node's actual port pixel. The channel router lands its first/last
 * point on the synthetic cell's face by default; this post-pass moves
 * the endpoint inward to the qualified internal node.
 *
 * Edges without `fromInternal`/`toInternal` are untouched.
 */
export function applyModulePortEndpoints(
  routing: ChannelRouting,
  model: Model,
  placement: Placement,
): void {
  if (model.imports.length === 0) return;
  const index = buildModulePortIndex(model, placement);
  for (const pl of routing.polylines) {
    const edge = model.edges[pl.edgeIndex];
    if (edge === undefined) continue;
    if (edge.fromInternal !== undefined) {
      const info = index.get(edge.from);
      const port = info?.ports.get(edge.fromInternal);
      if (info !== undefined && port !== undefined && pl.points.length > 0) {
        pl.points[0] = {
          x: info.originX + port.localX,
          y: info.originY + port.localY,
        };
      }
    }
    if (edge.toInternal !== undefined) {
      const info = index.get(edge.to);
      const port = info?.ports.get(edge.toInternal);
      if (info !== undefined && port !== undefined && pl.points.length > 0) {
        pl.points[pl.points.length - 1] = {
          x: info.originX + port.localX,
          y: info.originY + port.localY,
        };
      }
    }
  }
  void CELL_PX;
}
