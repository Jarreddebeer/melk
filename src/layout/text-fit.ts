/**
 * Phase 5 text-fit pass.
 *
 * Runs between `place` (Step 4) and `reserveCorridors` (Step 5). Walks
 * every node, estimates the pixel width of its label at the active
 * theme's body font size, and widens the node's own size + the cell's
 * column unit so the label fits inside the box with padding.
 *
 * Why a separate pass:
 *   - The placer is theme-agnostic. Stuffing typography metrics into
 *     the placer would couple layout to the visual theme, which is the
 *     bright line DESIGN-PHASE5-THEMING.md §3.3 explicitly preserves.
 *   - Cell-unit widening composes cleanly with the corridor reserver's
 *     own widening pass (Step 5 reads `colUnits`/`rowUnits` and widens
 *     further for trace demand). Bumping units up here just means the
 *     reserver starts from a slightly larger baseline.
 *
 * Why we grow the node's own size, not just the col:
 *   - A col can be wide for two reasons: (a) some OTHER node in the col
 *     declared `size: 2x1` (then this node stays at 1, centered — DESIGN
 *     §2.4), or (b) this node's own text needed the room. Only case (b)
 *     should grow this node. Mutating `model.nodes[i].size` is the only
 *     way `boxBounds` will render the wider box.
 *
 * What the algorithm does:
 *   1. For each node, estimate label width in pixels using a font-
 *      width heuristic (no canvas measurement — we run in Node and
 *      can't access the actual font metrics without DOM). The
 *      heuristic is calibrated against Inter / IBM Plex Sans at small
 *      sizes; over-estimating slightly is preferred to under-estimating
 *      (which would clip).
 *   2. Add padding (8px each side) and shape-specific allowance
 *      (cylinder needs more horizontal room for the ellipse caps;
 *      diamond/circle need extra for the geometry).
 *   3. Convert to cell units: ceil(neededPx / CELL_PX).
 *   4. Take max with the node's declared `size.width` — never shrink a
 *      node already declared at `size: 3x1`.
 *   5. Widen the cell's `colUnits[cell.col]` to at least the new size.
 *
 * Vertical fitting: only kicks in for very small declared cell heights
 * with very large fonts (rare in practice). Same algorithm, same max-
 * with-existing rule.
 *
 * Idempotent: running the pass twice gives the same result.
 *
 * Edge cases:
 *   - Empty label: no widening.
 *   - Highway nodes: no widening (they don't render a label, and their
 *     visible bounds are stretched by the renderer to span member rows).
 *   - Nodes declared with explicit `size: 2x1` etc.: respected as a
 *     floor. Text-fit can grow them further but cannot shrink them.
 */
import type { Model, ModelNode } from "../bind/model.js";
import type { Placement } from "./placement.js";
import type { Theme } from "../theme/theme.js";
import { CELL_PX } from "./corridors.js";

/**
 * Width-per-character heuristic for proportional sans-serifs (Inter,
 * IBM Plex Sans, Roboto, SF Pro) at 10-13pt. Slightly conservative
 * over-estimate so we don't clip in practice.
 */
const AVG_CHAR_WIDTH_RATIO = 0.6;

/** Width of "wide" characters (M, W, capitals) as a multiplier. */
const WIDE_CHAR_MULTIPLIER = 1.4;

/** Horizontal padding inside a box, in pixels, each side. */
const TEXT_PAD_X = 8;
/** Vertical padding inside a box, in pixels, each side. */
const TEXT_PAD_Y = 4;

/**
 * Per-shape extra horizontal allowance (in pixels) on top of padding.
 * Cylinder caps eat into the inner text area; diamond corners narrow
 * the usable width at the midline; circle inscribes text in a circle
 * smaller than its bounding box.
 */
const SHAPE_EXTRA_X: Record<string, number> = {
  cylinder: 4,
  diamond: 6,
  circle: 8,
};

/**
 * Estimate the rendered width of `label` at `fontSize` (CSS px). Uses
 * a character-class heuristic — not perfect, but consistently over-
 * estimating so the result fits in practice.
 */
export function estimateLabelWidth(label: string, fontSize: number): number {
  if (label.length === 0) return 0;
  let totalUnits = 0;
  for (const ch of label) {
    // Wide caps and "M"/"W" lookalikes; everything else gets the base
    // ratio. Spaces are narrow; digits average.
    if (/[A-Z]/.test(ch)) totalUnits += WIDE_CHAR_MULTIPLIER;
    else if (ch === " ") totalUnits += 0.4;
    else if (/[iljt!.,;:'`|]/.test(ch)) totalUnits += 0.4;
    else totalUnits += 1;
  }
  return totalUnits * fontSize * AVG_CHAR_WIDTH_RATIO;
}

/**
 * Estimate the rendered height of one line at `fontSize`. Inter / Plex
 * line-box height ≈ 1.2× font size.
 */
export function estimateLabelHeight(fontSize: number): number {
  return fontSize * 1.2;
}

/**
 * Apply text-fit widening. Returns a new Placement with widened
 * `colUnits` / `rowUnits`, and MUTATES `model.nodes[i].size` for any
 * node that needed to grow. The mutation is intentional: `boxBounds`
 * in the renderer reads `node.size` directly, and that's the path of
 * least surprise — the model post-text-fit represents the actual
 * rendered dimensions.
 *
 * Highway nodes are skipped — they don't render text.
 */
export function applyTextFit(
  placement: Placement,
  model: Model,
  theme: Theme,
): Placement {
  const fontSize = theme.typography.size.body;
  const colUnits = [...placement.colUnits];
  const rowUnits = [...placement.rowUnits];

  for (const node of model.nodes) {
    if (node.shape === "highway") continue;
    const label = node.label;
    if (label.length === 0) continue;
    const cell = placement.cells.get(node.id);
    if (!cell) continue;

    // Circle: don't grow for text. Circles render their label OUTSIDE
    // the shape (below it) — see svg.ts renderNode. The convention
    // matches BPMN/flowchart usage where circles are sources/sinks/events:
    // small markers with adjacent labels, not boxes-with-text-inside.
    if (node.shape === "circle") continue;

    const neededWidthPx = neededBoxWidthPx(label, fontSize, node.shape);
    const neededWidthUnits = Math.ceil(neededWidthPx / CELL_PX);
    let newWidth = Math.max(node.size.width, neededWidthUnits);

    const neededHeightPx = estimateLabelHeight(fontSize) + 2 * TEXT_PAD_Y;
    const neededHeightUnits = Math.ceil(neededHeightPx / CELL_PX);
    let newHeight = Math.max(node.size.height, neededHeightUnits);

    // Diamond: render as a proper kite (1:1 aspect). A 64×32 rhombus
    // looks crushed. Grow whichever dim is smaller to match the other.
    if (node.shape === "diamond") {
      const sq = Math.max(newWidth, newHeight);
      newWidth = sq;
      newHeight = sq;
    }

    // Cylinder: enforce a minimum height proportional to width so the
    // ellipse caps don't squash. Convention: at least 2/3 of width.
    if (node.shape === "cylinder") {
      const minHeight = Math.ceil((newWidth * 2) / 3);
      if (minHeight > newHeight) newHeight = minHeight;
    }

    if (newWidth !== node.size.width || newHeight !== node.size.height) {
      // Mutate the model's node size so boxBounds picks it up. The
      // model is per-render-pass; nothing else relies on the original
      // declared size after this point.
      node.size = { width: newWidth, height: newHeight };
    }

    if (newWidth > colUnits[cell.col]!) colUnits[cell.col] = newWidth;
    if (newHeight > rowUnits[cell.row]!) rowUnits[cell.row] = newHeight;
  }

  return {
    cells: placement.cells,
    rowUnits,
    colUnits,
    flowAxis: placement.flowAxis,
    forwardAt: placement.forwardAt,
  };
}

/**
 * Compute the box width (in pixels) needed to contain `label` at
 * `fontSize`, accounting for padding and shape-specific allowances.
 * Exported for tests.
 */
export function neededBoxWidthPx(
  label: string,
  fontSize: number,
  shape: ModelNode["shape"],
): number {
  const textWidthPx = estimateLabelWidth(label, fontSize);
  const extraX = SHAPE_EXTRA_X[shape] ?? 0;
  return textWidthPx + 2 * TEXT_PAD_X + 2 * extraX;
}
