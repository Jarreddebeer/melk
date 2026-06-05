/**
 * Phase 5 text-fit pass — now a no-op.
 *
 * The declared `size` on a node is authoritative for placement: the
 * placer cannot reason about typography without leaking visual concerns
 * into spacing, and a grown box eats into neighbours' footprints in
 * hard-to-predict ways once multi-cell occupancy is in play. So this
 * file no longer mutates anything — labels that don't fit inside their
 * declared box overflow visually, the same way a long highway label
 * would.
 *
 * The pure label-measurement helpers (`estimateLabelWidth`,
 * `estimateLabelHeight`, `neededBoxWidthPx`) are kept because callers
 * outside this pass (corridor reserver, theme tests) still want to
 * measure text without running a full render.
 */
import type { Model, ModelNode } from "../bind/model.js";
import type { Placement } from "./placement.js";
import type { Theme } from "../theme/theme.js";

const AVG_CHAR_WIDTH_RATIO = 0.6;
const WIDE_CHAR_MULTIPLIER = 1.4;
const TEXT_PAD_X = 8;

const SHAPE_EXTRA_X: Record<string, number> = {
  cylinder: 4,
  diamond: 6,
  circle: 8,
};

export function estimateLabelWidth(label: string, fontSize: number): number {
  if (label.length === 0) return 0;
  let totalUnits = 0;
  for (const ch of label) {
    if (/[A-Z]/.test(ch)) totalUnits += WIDE_CHAR_MULTIPLIER;
    else if (ch === " ") totalUnits += 0.4;
    else if (/[iljt!.,;:'`|]/.test(ch)) totalUnits += 0.4;
    else totalUnits += 1;
  }
  return totalUnits * fontSize * AVG_CHAR_WIDTH_RATIO;
}

export function estimateLabelHeight(fontSize: number): number {
  return fontSize * 1.2;
}

export function neededBoxWidthPx(
  label: string,
  fontSize: number,
  shape: ModelNode["shape"],
): number {
  const textWidthPx = estimateLabelWidth(label, fontSize);
  const extraX = SHAPE_EXTRA_X[shape] ?? 0;
  return textWidthPx + 2 * TEXT_PAD_X + 2 * extraX;
}

/**
 * No-op. Kept exported so existing call-sites compile while they
 * migrate; the declared `size` on each node is now authoritative for
 * placement.
 */
export function applyTextFitToSizes(model: Model, theme: Theme): void {
  void model;
  void theme;
}

/**
 * No-op. The pipeline once mutated `colUnits` / `rowUnits` here; under
 * multi-cell occupancy every unit is 1 and a node's pixel size flows
 * from the cells its footprint spans.
 */
export function applyTextFit(
  placement: Placement,
  model: Model,
  theme: Theme,
): Placement {
  void model;
  void theme;
  return placement;
}
