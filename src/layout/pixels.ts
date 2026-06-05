/**
 * Shared pixel layout. Moved from polyline.ts so the track packer can
 * also resolve cell/slot references to pixels — needed for pixel-aware
 * interval encoding in `tracks.ts` (see DESIGN-PHASE4.md §4 and the
 * `Pixel-aware interval encoding` note in `feedback-highway-invariants`).
 *
 * Inputs (`placement` cell counts + `reservation` gutter widths) are
 * both available by the end of Step 5. Step 6 (track packing) can call
 * `computePixelLayout` directly; Step 7 (polyline) re-uses the same
 * function with the same inputs.
 */
import type { Cell, Placement } from "./placement.js";
import type { Reservation, Side } from "./corridors.js";
import { CELL_PX, COMB_PITCH } from "./corridors.js";

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
  /** colGutterPx[g] = width of column gutter g in pixels. */
  colGutterPx: number[];
  /** rowGutterPx[g] = height of row gutter g in pixels. */
  rowGutterPx: number[];
  totalWidth: number;
  totalHeight: number;
}

export function computePixelLayout(
  placement: Placement,
  reservation: Reservation,
): PixelLayout {
  const nCols = placement.colUnits.length;
  const nRows = placement.rowUnits.length;

  const colWidthPx = placement.colUnits.map((u) => u * CELL_PX);
  const rowHeightPx = placement.rowUnits.map((u) => u * CELL_PX);
  const colGutterPx = reservation.colGutterUnits.map((u) => u * CELL_PX);
  const rowGutterPx = reservation.rowGutterUnits.map((u) => u * CELL_PX);

  // colX[c] = sum of (col widths + col gutters) west of col c.
  // Gutter 0 = left page margin; gutter c = the one immediately west of col c.
  const colX = new Array<number>(nCols).fill(0);
  let xAccum = colGutterPx[0]!;
  for (let c = 0; c < nCols; c++) {
    colX[c] = xAccum;
    xAccum += colWidthPx[c]! + colGutterPx[c + 1]!;
  }
  const totalWidth = xAccum;

  const rowY = new Array<number>(nRows).fill(0);
  let yAccum = rowGutterPx[0]!;
  for (let r = 0; r < nRows; r++) {
    rowY[r] = yAccum;
    yAccum += rowHeightPx[r]! + rowGutterPx[r + 1]!;
  }
  const totalHeight = yAccum;

  return {
    colX,
    rowY,
    colWidthPx,
    rowHeightPx,
    colGutterPx,
    rowGutterPx,
    totalWidth,
    totalHeight,
  };
}

/**
 * Pixel position of a slot port on a box face. The slot is centered
 * in its comb-tooth cell (+ COMB_PITCH/2 offset from the slot's edge).
 *
 * Multi-cell occupancy: the box is anchored at the top-left of its
 * footprint cell (`boxCell`) and its pixel size is declared
 * (`boxWidthCells * CELL_PX` × `boxHeightCells * CELL_PX`). No
 * centering — the box fills its footprint by construction (cells
 * span multiple grid rows/cols when needed instead of inflating).
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

/**
 * Pixel x of a V-corridor's western edge (= the col boundary the
 * corridor sits on). Used to compute corridor-corridor intersection
 * positions for the track packer's interval encoding.
 */
export function vCorridorWestEdgeX(corridorIndex: number, layout: PixelLayout): number {
  return corridorIndex === 0
    ? 0
    : layout.colX[corridorIndex - 1]! + layout.colWidthPx[corridorIndex - 1]!;
}

/**
 * Pixel y of an H-corridor's northern edge. Used similarly to
 * `vCorridorWestEdgeX`.
 */
export function hCorridorNorthEdgeY(corridorIndex: number, layout: PixelLayout): number {
  return corridorIndex === 0
    ? 0
    : layout.rowY[corridorIndex - 1]! + layout.rowHeightPx[corridorIndex - 1]!;
}
