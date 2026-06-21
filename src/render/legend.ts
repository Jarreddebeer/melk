/**
 * Phase 5 legend (DESIGN-PHASE5-LEGEND.md).
 *
 * Theme-driven, author-opt-in key for tags used in the diagram. The author
 * flips `legend: on`; the renderer:
 *
 *   1. walks the model and collects every tag actually used on a node or
 *      edge, in declaration order of first use;
 *   2. validates that every used tag has a `legend:` caption in the active
 *      theme (E_LEGEND_TAG_HAS_NO_CAPTION otherwise);
 *   3. classifies each tag's swatch (box vs line) via classifyTagRuleSwatch;
 *   4. lays the entries out as either a horizontal strip (top/bottom) or a
 *      vertical strip (left/right), wrapping rows/columns as needed.
 *
 * Layout never errors on overflow: vertical strips reflow into extra
 * columns; horizontal strips wrap to extra rows. The author can always
 * change `legend-position:` to the opposite axis if the resulting geometry
 * doesn't fit their use case.
 *
 * The module is pure: same inputs → same output. No I/O, no globals.
 */
import type { Model } from "../bind/model.js";
import type { LegendPosition } from "../parser/ast.js";
import {
  classifyTagRuleSwatch,
  resolveColour,
  type TagRule,
  type Theme,
} from "../theme/theme.js";
import { escapeAttr, escapeText, fmt } from "./svg.js";

// --- public types --------------------------------------------------------

/** One resolved entry: a tag name, its caption, its swatch kind, its rule. */
export interface LegendEntry {
  tag: string;
  caption: string;
  swatch: "box" | "line";
  rule: TagRule;
}

/**
 * The laid-out legend strip. Coordinates are LOCAL to the strip's origin
 * — the renderer translates the whole strip into place via a single
 * `<g transform="translate(x,y)">`.
 *
 *   - For horizontal strips (top/bottom), entries flow left-to-right and
 *     wrap to additional rows; `width` is the strip's total width (matches
 *     the diagram's width budget) and `height` grows to fit wrap rows.
 *   - For vertical strips (left/right), entries flow top-to-bottom and
 *     reflow into additional columns; `height` matches the diagram's
 *     height budget and `width` grows to fit reflow columns.
 */
export interface LegendLayout {
  position: LegendPosition;
  /** Strip total width in pixels. */
  width: number;
  /** Strip total height in pixels. */
  height: number;
  /**
   * Placed entries with their local (x, y) origin (top-left of the swatch).
   * Caption sits to the right of the swatch.
   */
  placed: PlacedEntry[];
  /** Per-entry geometry, useful to renderer (avoid recomputing). */
  swatchWidth: number;
  swatchHeight: number;
  entryRowHeight: number;
  captionSize: number;
  /** Padding inside the strip on every side (uniform). */
  padding: number;
}

export interface PlacedEntry {
  entry: LegendEntry;
  /** Top-left of the swatch in local strip coords. */
  swatchX: number;
  swatchY: number;
  /** Baseline x for the caption (left edge of the caption text). */
  captionX: number;
  /** Baseline y for the caption (text baseline, not top). */
  captionY: number;
  /** Caption text width in pixels (estimated). */
  captionWidth: number;
}

// --- layout constants ----------------------------------------------------

/**
 * Visual dimensions, in pixels. All multiples of the 8px global grid
 * (feedback-global-grid) except where typography metrics intrude.
 */
const SWATCH_BOX_WIDTH = 16;
const SWATCH_BOX_HEIGHT = 10;
const SWATCH_LINE_WIDTH = 24;
const SWATCH_LINE_HEIGHT = 4;
const SWATCH_CAPTION_GAP = 8;
/** Per-row vertical extent inside the strip; one global grid unit. */
const ROW_HEIGHT = 16;
/** Horizontal separator between adjacent entries in a row. */
const HORIZONTAL_ENTRY_GAP = 24;
/** Vertical separator between rows or between entries in a column. */
const VERTICAL_ENTRY_GAP = 8;
/** Inner padding on every side of the strip. */
const STRIP_PADDING = 8;
/**
 * Estimated px width per caption character at typical edge-size font.
 * Used only for layout — actual SVG text width depends on the font.
 * The estimate is conservative-on-the-wide-side so wrap decisions never
 * leave entries overflowing visible bounds in practice.
 */
const CAPTION_CHAR_WIDTH_RATIO = 0.6;

// --- public API ----------------------------------------------------------

/**
 * Discover every tag used in the diagram (in declaration order of first
 * use), validate captions, classify swatches, and return the ordered entry
 * list.
 *
 * Throws:
 *   - E_LEGEND_NO_TAGS_USED if the diagram declared no tags at all but
 *     legend: on was set;
 *   - E_LEGEND_TAG_HAS_NO_CAPTION if a used tag has no `legend:` field in
 *     the active theme.
 */
export function discoverLegendEntries(model: Model, theme: Theme): LegendEntry[] {
  const order: string[] = [];
  const seen = new Set<string>();
  // Nodes first (in declaration order — model.nodes preserves this), then
  // edges. A tag used on both still gets its first-encountered position.
  for (const node of model.nodes) {
    if (!node.tags) continue;
    for (const t of node.tags) {
      if (!seen.has(t)) {
        seen.add(t);
        order.push(t);
      }
    }
  }
  for (const edge of model.edges) {
    if (!edge.tags) continue;
    for (const t of edge.tags) {
      if (!seen.has(t)) {
        seen.add(t);
        order.push(t);
      }
    }
  }
  if (order.length === 0) {
    throw new LegendError(
      "E_LEGEND_NO_TAGS_USED: `legend: on` is set but the diagram uses no tags. " +
        "Either remove `legend: on` or tag at least one node/edge with `{ tags: [...] }`.",
    );
  }
  const entries: LegendEntry[] = [];
  for (const tag of order) {
    const rule = theme.tags[tag];
    if (rule === undefined) {
      // Unknown tag fires E_UNKNOWN_TAG elsewhere (resolveTags). We rely
      // on the renderer having validated tags already, but as a defensive
      // measure here we also reject — the legend can't show a tag that
      // doesn't exist in the theme.
      throw new LegendError(
        `E_UNKNOWN_TAG: tag '${tag}' used in diagram is not defined in theme '${theme.name}'.`,
      );
    }
    if (rule.legend === undefined) {
      throw new LegendError(
        `E_LEGEND_TAG_HAS_NO_CAPTION: tag '${tag}' is used in the diagram but the theme ` +
          `'${theme.name}' does not define a 'legend:' caption for it. ` +
          `Add a 'legend: "..."' field to the tag rule in the theme, or remove the use of this tag.`,
      );
    }
    entries.push({
      tag,
      caption: rule.legend,
      swatch: classifyTagRuleSwatch(rule),
      rule,
    });
  }
  return entries;
}

/**
 * Lay out the legend strip given the entries and the diagram's pixel
 * width / height (the canvas size BEFORE legend extension). Position
 * controls strip orientation:
 *
 *   - "bottom" / "top": horizontal strip, width = diagram width, height
 *     grows to fit wrapped rows;
 *   - "right" / "left": vertical strip, height = diagram height, width
 *     grows to fit reflowed columns.
 */
export function buildLegend(
  model: Model,
  theme: Theme,
  position: LegendPosition,
  diagramWidth: number,
  diagramHeight: number,
): LegendLayout {
  const entries = discoverLegendEntries(model, theme);
  const captionSize = theme.typography.size.edge;
  const measured = entries.map((e) => ({
    e,
    captionWidth: Math.ceil(e.caption.length * captionSize * CAPTION_CHAR_WIDTH_RATIO),
  }));

  if (position === "bottom" || position === "top") {
    return layoutHorizontal(measured, position, diagramWidth, captionSize);
  }
  return layoutVertical(measured, position, diagramHeight, captionSize);
}

// --- error ---------------------------------------------------------------

export class LegendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegendError";
  }
}

// --- horizontal (top/bottom) layout --------------------------------------

interface MeasuredEntry {
  e: LegendEntry;
  captionWidth: number;
}

function layoutHorizontal(
  measured: MeasuredEntry[],
  position: LegendPosition,
  diagramWidth: number,
  captionSize: number,
): LegendLayout {
  const usableWidth = Math.max(0, diagramWidth - 2 * STRIP_PADDING);
  // Place entries left-to-right; wrap when next entry would exceed usable
  // width. Each row's height is ROW_HEIGHT; inter-row gap = VERTICAL_ENTRY_GAP.
  const rows: { entries: MeasuredEntry[]; widths: number[] }[] = [
    { entries: [], widths: [] },
  ];
  let rowWidth = 0;
  for (const m of measured) {
    const entryWidth = entryPixelWidth(m);
    const candidate = rows[rows.length - 1]!.entries.length === 0
      ? entryWidth
      : rowWidth + HORIZONTAL_ENTRY_GAP + entryWidth;
    if (candidate > usableWidth && rows[rows.length - 1]!.entries.length > 0) {
      // Wrap.
      rows.push({ entries: [m], widths: [entryWidth] });
      rowWidth = entryWidth;
    } else {
      rows[rows.length - 1]!.entries.push(m);
      rows[rows.length - 1]!.widths.push(entryWidth);
      rowWidth = candidate;
    }
  }

  const stripHeight =
    2 * STRIP_PADDING + rows.length * ROW_HEIGHT + (rows.length - 1) * VERTICAL_ENTRY_GAP;
  const placed: PlacedEntry[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    let x = STRIP_PADDING;
    const y = STRIP_PADDING + r * (ROW_HEIGHT + VERTICAL_ENTRY_GAP);
    for (let i = 0; i < row.entries.length; i++) {
      const m = row.entries[i]!;
      placed.push(placeEntry(m, x, y, captionSize));
      x += row.widths[i]! + HORIZONTAL_ENTRY_GAP;
    }
  }
  return {
    position,
    width: diagramWidth,
    height: stripHeight,
    placed,
    swatchWidth: SWATCH_BOX_WIDTH,
    swatchHeight: SWATCH_BOX_HEIGHT,
    entryRowHeight: ROW_HEIGHT,
    captionSize,
    padding: STRIP_PADDING,
  };
}

// --- vertical (right/left) layout ----------------------------------------

function layoutVertical(
  measured: MeasuredEntry[],
  position: LegendPosition,
  diagramHeight: number,
  captionSize: number,
): LegendLayout {
  const usableHeight = Math.max(0, diagramHeight - 2 * STRIP_PADDING);
  // Place entries top-to-bottom; reflow when next entry would exceed
  // usable height. Each column's width = max(entry widths in column);
  // inter-column gap = HORIZONTAL_ENTRY_GAP.
  const cols: { entries: MeasuredEntry[]; widths: number[] }[] = [
    { entries: [], widths: [] },
  ];
  let colHeight = 0;
  for (const m of measured) {
    const entryWidth = entryPixelWidth(m);
    const candidate =
      cols[cols.length - 1]!.entries.length === 0
        ? ROW_HEIGHT
        : colHeight + VERTICAL_ENTRY_GAP + ROW_HEIGHT;
    if (candidate > usableHeight && cols[cols.length - 1]!.entries.length > 0) {
      cols.push({ entries: [m], widths: [entryWidth] });
      colHeight = ROW_HEIGHT;
    } else {
      cols[cols.length - 1]!.entries.push(m);
      cols[cols.length - 1]!.widths.push(entryWidth);
      colHeight = candidate;
    }
  }

  const colWidths = cols.map((c) => Math.max(...c.widths));
  const stripWidth =
    2 * STRIP_PADDING +
    colWidths.reduce((s, w) => s + w, 0) +
    (cols.length - 1) * HORIZONTAL_ENTRY_GAP;
  const placed: PlacedEntry[] = [];
  let cumColX = STRIP_PADDING;
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c]!;
    let y = STRIP_PADDING;
    for (let i = 0; i < col.entries.length; i++) {
      const m = col.entries[i]!;
      placed.push(placeEntry(m, cumColX, y, captionSize));
      y += ROW_HEIGHT + VERTICAL_ENTRY_GAP;
    }
    cumColX += colWidths[c]! + HORIZONTAL_ENTRY_GAP;
  }
  return {
    position,
    width: stripWidth,
    height: diagramHeight,
    placed,
    swatchWidth: SWATCH_BOX_WIDTH,
    swatchHeight: SWATCH_BOX_HEIGHT,
    entryRowHeight: ROW_HEIGHT,
    captionSize,
    padding: STRIP_PADDING,
  };
}

// --- entry placement helpers ---------------------------------------------

function entryPixelWidth(m: MeasuredEntry): number {
  const swatchW = m.e.swatch === "line" ? SWATCH_LINE_WIDTH : SWATCH_BOX_WIDTH;
  return swatchW + SWATCH_CAPTION_GAP + m.captionWidth;
}

function placeEntry(
  m: MeasuredEntry,
  x: number,
  y: number,
  captionSize: number,
): PlacedEntry {
  const swatchW = m.e.swatch === "line" ? SWATCH_LINE_WIDTH : SWATCH_BOX_WIDTH;
  const swatchH = m.e.swatch === "line" ? SWATCH_LINE_HEIGHT : SWATCH_BOX_HEIGHT;
  // Centre the swatch vertically within the row.
  const swatchY = y + (ROW_HEIGHT - swatchH) / 2;
  // Caption sits to the right of the swatch, vertically centred against
  // the row. Baseline = top of row + 0.75 * captionSize (rough metric).
  const captionX = x + swatchW + SWATCH_CAPTION_GAP;
  const captionY = y + ROW_HEIGHT / 2 + captionSize * 0.35;
  return {
    entry: m.e,
    swatchX: x,
    swatchY,
    captionX,
    captionY,
    captionWidth: m.captionWidth,
  };
}

// --- rendering -----------------------------------------------------------

/**
 * Emit the legend strip as an SVG fragment, translated to (originX, originY)
 * relative to the SVG canvas origin. Also draws a thin separator line on
 * the strip's inner edge (the edge facing the diagram).
 *
 * The strip's content sits inside a `<g transform="translate(...)">` so all
 * placed coords are interpreted in local strip space (matching the
 * LegendLayout's coordinate system).
 */
/**
 * Resolves a tag-rule paint value (solid colour or `linear ...`
 * gradient) to an SVG paint string. `svg.ts` supplies a resolver that
 * registers gradients into `<defs>` and returns `url(#...)`; without
 * one we fall back to `resolveColour`, which only accepts hex/token
 * (so a gradient swatch would throw — but standalone callers never
 * pass gradient tags).
 */
export type PaintResolver = (value: string) => string;

export function renderLegend(
  layout: LegendLayout,
  originX: number,
  originY: number,
  theme: Theme,
  paint?: PaintResolver,
): string {
  const resolve: PaintResolver = paint ?? ((v) => resolveColour(theme, v));
  const parts: string[] = [];
  parts.push(`<g data-legend="1" transform="translate(${fmt(originX)} ${fmt(originY)})">`);
  // Separator on the inner edge (the edge facing the diagram).
  parts.push(renderSeparator(layout, theme));
  for (const placed of layout.placed) {
    parts.push(renderEntry(placed, theme, resolve));
  }
  parts.push(`</g>`);
  return parts.join("\n");
}

function renderSeparator(layout: LegendLayout, theme: Theme): string {
  const stroke = theme.tokens["border-subtle"];
  const w = theme.strokes.frame;
  // Separator is along the strip's edge that touches the diagram:
  //   - bottom: top edge of strip (y=0, x∈[0,width])
  //   - top:    bottom edge of strip (y=height, x∈[0,width])
  //   - right:  left edge of strip (x=0, y∈[0,height])
  //   - left:   right edge of strip (x=width, y∈[0,height])
  switch (layout.position) {
    case "bottom":
      return `<line x1="0" y1="0" x2="${fmt(layout.width)}" y2="0" stroke="${stroke}" stroke-width="${w}"/>`;
    case "top":
      return `<line x1="0" y1="${fmt(layout.height)}" x2="${fmt(layout.width)}" y2="${fmt(layout.height)}" stroke="${stroke}" stroke-width="${w}"/>`;
    case "right":
      return `<line x1="0" y1="0" x2="0" y2="${fmt(layout.height)}" stroke="${stroke}" stroke-width="${w}"/>`;
    case "left":
      return `<line x1="${fmt(layout.width)}" y1="0" x2="${fmt(layout.width)}" y2="${fmt(layout.height)}" stroke="${stroke}" stroke-width="${w}"/>`;
  }
}

function renderEntry(placed: PlacedEntry, theme: Theme, paint: PaintResolver): string {
  const swatch = renderSwatch(placed, theme, paint);
  const captionColour = theme.tokens["ink-secondary"];
  const fontSize = theme.typography.size.edge;
  const caption =
    `<text x="${fmt(placed.captionX)}" y="${fmt(placed.captionY)}" ` +
    `fill="${captionColour}" font-size="${fontSize}" ` +
    `text-anchor="start" dominant-baseline="alphabetic" ` +
    `data-tag="${escapeAttr(placed.entry.tag)}">` +
    `${escapeText(placed.entry.caption)}</text>`;
  return `<g data-legend-entry="${escapeAttr(placed.entry.tag)}">\n  ${swatch}\n  ${caption}\n</g>`;
}

function renderSwatch(placed: PlacedEntry, theme: Theme, paint: PaintResolver): string {
  const rule = placed.entry.rule;
  if (placed.entry.swatch === "line") {
    // Line swatch: short horizontal segment styled per the tag's edge
    // properties. Trace colour: use `trace` override → token; fallback
    // to trace-default. Width: `trace-width` → fallback to theme trace.
    const stroke = rule.trace !== undefined
      ? paint(rule.trace)
      : theme.tokens["trace-default"];
    const sw = rule["trace-width"] ?? theme.strokes.trace;
    const yMid = placed.swatchY + SWATCH_LINE_HEIGHT / 2;
    const x1 = placed.swatchX;
    const x2 = placed.swatchX + SWATCH_LINE_WIDTH;
    let dashAttr = "";
    if (rule.dash !== undefined && rule.dash !== null) {
      dashAttr = ` stroke-dasharray="${rule.dash.join(" ")}"`;
    }
    const opacityAttr = rule.opacity !== undefined ? ` opacity="${rule.opacity}"` : "";
    return (
      `<line x1="${fmt(x1)}" y1="${fmt(yMid)}" x2="${fmt(x2)}" y2="${fmt(yMid)}" ` +
      `stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"${dashAttr}${opacityAttr}/>`
    );
  }
  // Box swatch: rect styled per the tag's node properties. Fill: `fill`
  // → token/gradient; fallback to surface-raised. Stroke: `border` →
  // token/gradient; fallback to border-strong. Width: `border-width` →
  // outline. `paint` registers gradients into <defs> and returns a
  // url(#...) reference.
  const fill = rule.fill !== undefined
    ? paint(rule.fill)
    : theme.tokens["surface-raised"];
  const stroke = rule.border !== undefined
    ? paint(rule.border)
    : theme.tokens["border-strong"];
  const sw = rule["border-width"] ?? theme.strokes.outline;
  let dashAttr = "";
  if (rule.dash !== undefined && rule.dash !== null) {
    dashAttr = ` stroke-dasharray="${rule.dash.join(" ")}"`;
  }
  const opacityAttr = rule.opacity !== undefined ? ` opacity="${rule.opacity}"` : "";
  return (
    `<rect x="${fmt(placed.swatchX)}" y="${fmt(placed.swatchY)}" ` +
    `width="${fmt(SWATCH_BOX_WIDTH)}" height="${fmt(SWATCH_BOX_HEIGHT)}" rx="1" ry="1" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dashAttr}${opacityAttr}/>`
  );
}
