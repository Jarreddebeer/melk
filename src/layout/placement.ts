/**
 * Phase 4 placement types.
 *
 * The placer (DESIGN-PHASE4.md §2) maps each `ModelNode` to a `(row, col)`
 * grid cell, and assigns each row/col a size in cell-units. Cell-units are
 * grid-native; the pixel translation happens at render time using `CELL_PX`.
 *
 * Origin convention: the placer normalises the resulting cells so that the
 * minimum row is 0 and the minimum col is 0. Negative intermediate coords
 * are fine while passes are still running; they're shifted before the
 * Placement is returned.
 *
 * Row/col units are initialised here at Step 4 from the max cell-size of
 * any node landing in that row/col. Step 5 (corridor reservation) widens
 * them further to accommodate trace demand.
 */

/**
 * A grid cell. row and col are non-negative integers in the final
 * Placement. `z` is the depth layer — 0 (default, surface) for ordinary
 * nodes, negative for underground (e.g., `render: underground` highways),
 * positive for bridges/overpasses (future). Nodes anchored by a highway
 * inherit that highway's z. Two nodes can occupy the same (row, col) if
 * their z differs; the collision check ignores cross-z comparisons.
 */
export interface Cell {
  row: number;
  col: number;
  z?: number;
}

/**
 * The flow axis derived from the layout mode at the top level. The
 * "forward" direction is the one the placer's flow pass walks when laying
 * out a free edge `a -> b` with no other anchor.
 *
 *   - layout: lr  →  forward = east (col + 1)
 *   - layout: tb  →  forward = south (row + 1)
 *
 * Back-edges are placed wherever their endpoints land; the router handles
 * the rear-facing corridor.
 *
 * For Phase 4 isometry, `flowAxis` is a *page-level default*, not the
 * source of truth for any node's geometry. Downstream stages read each
 * node's local forward from `Placement.forwardAt` (see §2.5 of the
 * Phase 4 design doc).
 */
export type FlowAxis = "east" | "south";

/**
 * A cardinal direction. Used as a node's *local* forward (the direction
 * its primitive extends from its anchor) and as an edge's forward (the
 * direction its trace travels from source to target).
 *
 * See DESIGN-PHASE4.md §2.5.
 */
export type Direction = "N" | "E" | "S" | "W";

export interface Placement {
  /** Node id → (row, col). Always non-negative after normalisation. */
  cells: Map<string, Cell>;
  /** rowUnits[r] = height of row r in cell-units. */
  rowUnits: number[];
  /** colUnits[c] = width of col c in cell-units. */
  colUnits: number[];
  /**
   * Flow axis the placer used at the top level. Carried forward for
   * stages that want a page-level hint; per-node local forward lives in
   * `forwardAt`.
   */
  flowAxis: FlowAxis;
  /**
   * Each node's *local* forward direction — the forward of the primitive
   * that placed it (or inherited from the parent chain through branches).
   * Downstream stages (corridors, slot ordering, back-edge geometry)
   * read this rather than `flowAxis` so primitives compose isometrically
   * under inheritance (DESIGN-PHASE4.md §2.5, §11.6).
   */
  forwardAt: Map<string, Direction>;
}

/**
 * The placer errors out as soon as it detects a violation; errors are
 * thrown as PlacementError, mirroring the parser/bind convention. The
 * compiler refuses to render diagrams with placement errors
 * (DESIGN-PHASE4.md §7.3).
 */
export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
  }
}
