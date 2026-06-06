/**
 * Shared pixel layout (Phase 4 channel-routing model).
 *
 * The grid is `cells × CELL_PX`. No gutter widening — the corridor +
 * track-packing concept that drove the gutter math is gone. Channel
 * routing (`channels.ts`) walks through empty cells, so spacing between
 * unrelated nodes shows up as the empty cells the placer left there
 * (e.g. `MEMBER_GAP = 1` cell between bus producers).
 *
 * `computePixelLayout(placement)` produces colX/rowY/widths/heights/
 * totals. `slotPixel` resolves a (side, slot, anchor cell, footprint
 * size) to its pixel position on a face.
 */
import type { Cell, Placement } from "./placement.js";
import type { Side } from "./slots.js";
import { CELL_PX, COMB_PITCH } from "./slots.js";

export interface Point {
  x: number;
  y: number;
}

export interface PixelLayout {
  /** colX[c] = left pixel x of column c. */
  colX: number[];
  /** rowY[r] = top pixel y of row r. */
  rowY: number[];
  /** colWidthPx[c] = width of col c in pixels (colUnits[c] * CELL_PX). */
  colWidthPx: number[];
  /** rowHeightPx[r] = height of row r in pixels. */
  rowHeightPx: number[];
  totalWidth: number;
  totalHeight: number;
}

export function computePixelLayout(placement: Placement): PixelLayout {
  const nCols = placement.colUnits.length;
  const nRows = placement.rowUnits.length;
  const colWidthPx = placement.colUnits.map((u) => u * CELL_PX);
  const rowHeightPx = placement.rowUnits.map((u) => u * CELL_PX);

  const colX = new Array<number>(nCols).fill(0);
  let xAccum = 0;
  for (let c = 0; c < nCols; c++) {
    colX[c] = xAccum;
    xAccum += colWidthPx[c]!;
  }
  const totalWidth = xAccum;

  const rowY = new Array<number>(nRows).fill(0);
  let yAccum = 0;
  for (let r = 0; r < nRows; r++) {
    rowY[r] = yAccum;
    yAccum += rowHeightPx[r]!;
  }
  const totalHeight = yAccum;

  return { colX, rowY, colWidthPx, rowHeightPx, totalWidth, totalHeight };
}

/**
 * Pixel position of a slot port on a box face. The slot is centered
 * in its comb-tooth cell (+ COMB_PITCH/2 offset from the slot's edge).
 *
 * Multi-cell occupancy: the box is anchored at the top-left of its
 * footprint cell (`boxCell`) and its pixel size is declared
 * (`boxWidthCells * CELL_PX` × `boxHeightCells * CELL_PX`). No
 * centering — the box fills its footprint by construction.
 */
export function slotPixel(
  side: Side,
  slot: number,
  boxCell: Cell,
  boxWidthCells: number,
  boxHeightCells: number,
  layout: PixelLayout,
): Point {
  const widthPx = boxWidthCells * CELL_PX;
  const heightPx = boxHeightCells * CELL_PX;
  const left = layout.colX[boxCell.col]!;
  const top = layout.rowY[boxCell.row]!;
  const slotOffset = slot * COMB_PITCH + COMB_PITCH / 2;
  switch (side) {
    case "W":
      return { x: left, y: top + slotOffset };
    case "E":
      return { x: left + widthPx, y: top + slotOffset };
    case "N":
      return { x: left + slotOffset, y: top };
    case "S":
      return { x: left + slotOffset, y: top + heightPx };
  }
}
