/**
 * Phase 5 titles + captions (DESIGN-PHASE5-TITLES.md).
 *
 * The diagram canvas gains an optional header strip (top) carrying a
 * title and/or subtitle, and an optional footer strip (bottom) carrying
 * a caption. Both strips are theme-styled, left-aligned, and extend the
 * canvas without touching layout. They co-exist with the legend on any
 * of its four positions.
 *
 * The module is pure: same inputs → same output. No I/O, no globals.
 */
import type { Model } from "../bind/model.js";
import type { Theme } from "../theme/theme.js";
import { escapeText, fmt } from "./svg.js";

// --- public types --------------------------------------------------------

/**
 * A laid-out title strip (header or footer). Coordinates are LOCAL to
 * the strip's origin — the renderer translates the whole strip into
 * place with a single `<g transform="translate(...)">`.
 *
 * `height` is the strip's vertical extent; `minWidth` is the strip
 * content's required horizontal extent (used to widen the canvas if
 * the title text is wider than the diagram body — DESIGN §3.3).
 */
export interface TitleStripLayout {
  height: number;
  minWidth: number;
  rows: PlacedTextRow[];
}

export interface PlacedTextRow {
  text: string;
  /** Left edge of the text in local strip coords. */
  x: number;
  /** Text baseline y in local strip coords. */
  y: number;
  fontSize: number;
  fontWeight: number;
  fill: string;
  kind: "title" | "subtitle" | "caption";
}

// --- layout constants ----------------------------------------------------

/**
 * Strip padding (DESIGN §3.1). Top has more headroom than bottom so the
 * header reads as a document chrome strip rather than a centred caption.
 */
const HEADER_PADDING_TOP = 16;
const HEADER_PADDING_BOTTOM = 8;
const FOOTER_PADDING_TOP = 8;
const FOOTER_PADDING_BOTTOM = 12;

/**
 * Row vertical padding — added to the typography font-size to give the
 * row room around the glyphs. Title gets more breathing room (8px vs
 * 4px for subtitle/caption) per the design ramp.
 */
const TITLE_ROW_PADDING = 8;
const SUBTITLE_ROW_PADDING = 4;
const CAPTION_ROW_PADDING = 4;

/** Gap between title and subtitle rows when both are present. */
const TITLE_SUBTITLE_GAP = 4;

/**
 * Conservative-on-the-wide-side char-width estimate. The legend layout
 * uses the same constant for its caption width estimation. Real SVG
 * text widths depend on the font; this is enough for canvas-extension
 * decisions (we err on giving more room, not less).
 */
const CHAR_WIDTH_RATIO = 0.6;

/**
 * Left-edge indent matches the renderer's PAGE_MARGIN. Defined here as
 * a constant rather than imported to keep the module standalone — the
 * renderer passes its PAGE_MARGIN value to the strip's origin when it
 * translates the strip, but inside the strip the text origin is this
 * local margin.
 */
const STRIP_LEFT_MARGIN = 32;

// --- public API ----------------------------------------------------------

/**
 * Build the header strip layout. Returns undefined when neither title
 * nor subtitle is set on the model.
 */
export function buildHeader(model: Model, theme: Theme): TitleStripLayout | undefined {
  const hasTitle = model.title !== undefined;
  const hasSubtitle = model.subtitle !== undefined;
  if (!hasTitle && !hasSubtitle) return undefined;

  const titleSize = theme.typography.size.title;
  const subtitleSize = theme.typography.size.subtitle;
  const titleWeight = theme.typography.weight.title;
  const subtitleWeight = theme.typography.weight.subtitle;
  const titleFill = theme.tokens["ink-primary"];
  const subtitleFill = theme.tokens["ink-secondary"];

  const titleRowH = titleSize + TITLE_ROW_PADDING;
  const subtitleRowH = subtitleSize + SUBTITLE_ROW_PADDING;

  let y = HEADER_PADDING_TOP;
  const rows: PlacedTextRow[] = [];
  let maxTextWidth = 0;
  if (hasTitle) {
    const t = model.title!;
    const baselineY = y + titleSize * 0.85; // text top + ascent ≈ baseline
    rows.push({
      text: t,
      x: STRIP_LEFT_MARGIN,
      y: baselineY,
      fontSize: titleSize,
      fontWeight: titleWeight,
      fill: titleFill,
      kind: "title",
    });
    maxTextWidth = Math.max(maxTextWidth, estimateTextWidth(t, titleSize));
    y += titleRowH;
    if (hasSubtitle) y += TITLE_SUBTITLE_GAP;
  }
  if (hasSubtitle) {
    const s = model.subtitle!;
    const baselineY = y + subtitleSize * 0.85;
    rows.push({
      text: s,
      x: STRIP_LEFT_MARGIN,
      y: baselineY,
      fontSize: subtitleSize,
      fontWeight: subtitleWeight,
      fill: subtitleFill,
      kind: "subtitle",
    });
    maxTextWidth = Math.max(maxTextWidth, estimateTextWidth(s, subtitleSize));
    y += subtitleRowH;
  }
  const height = y + HEADER_PADDING_BOTTOM;
  // Min width = left margin + text + right margin (mirror the left margin).
  const minWidth = STRIP_LEFT_MARGIN + maxTextWidth + STRIP_LEFT_MARGIN;
  return { height, minWidth, rows };
}

/**
 * Build the footer strip layout. Returns undefined when no caption is
 * set on the model.
 */
export function buildFooter(model: Model, theme: Theme): TitleStripLayout | undefined {
  if (model.caption === undefined) return undefined;
  const captionSize = theme.typography.size.caption;
  // Caption reuses the label weight rather than a dedicated slot.
  const captionWeight = theme.typography.weight.label;
  const captionFill = theme.tokens["ink-secondary"];

  const rowH = captionSize + CAPTION_ROW_PADDING;
  const baselineY = FOOTER_PADDING_TOP + captionSize * 0.85;
  const rows: PlacedTextRow[] = [
    {
      text: model.caption,
      x: STRIP_LEFT_MARGIN,
      y: baselineY,
      fontSize: captionSize,
      fontWeight: captionWeight,
      fill: captionFill,
      kind: "caption",
    },
  ];
  const height = FOOTER_PADDING_TOP + rowH + FOOTER_PADDING_BOTTOM;
  const minWidth =
    STRIP_LEFT_MARGIN + estimateTextWidth(model.caption, captionSize) + STRIP_LEFT_MARGIN;
  return { height, minWidth, rows };
}

/**
 * Emit a strip's SVG inside a `<g transform="translate(originX, originY)">`
 * group. The strip's local rows are placed in strip-local coords
 * (already x = STRIP_LEFT_MARGIN, y = baseline-relative), so the only
 * transform is the strip's outer origin.
 */
export function renderTitleStrip(
  layout: TitleStripLayout,
  originX: number,
  originY: number,
  theme: Theme,
): string {
  const face = theme.typography.face;
  const parts: string[] = [];
  parts.push(`<g data-title-strip="1" transform="translate(${fmt(originX)} ${fmt(originY)})">`);
  for (const row of layout.rows) {
    parts.push(
      `<text x="${fmt(row.x)}" y="${fmt(row.y)}" font-family="${escapeAttrLocal(face)}" ` +
        `font-size="${row.fontSize}" font-weight="${row.fontWeight}" ` +
        `fill="${row.fill}" data-row="${row.kind}" ` +
        `text-anchor="start" dominant-baseline="alphabetic">` +
        `${escapeText(row.text)}</text>`,
    );
  }
  parts.push(`</g>`);
  return parts.join("\n");
}

// --- helpers -------------------------------------------------------------

function estimateTextWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * CHAR_WIDTH_RATIO);
}

/** Local escape — avoids importing escapeAttr from svg.ts (cyclic worry). */
function escapeAttrLocal(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
