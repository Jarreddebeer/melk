/**
 * Phase 4 renderer (Step 8), Phase 5 themed.
 *
 * Inputs: the four upstream products (Model, Placement, Reservation,
 * Polylines) plus a Theme. Output: an SVG string ready to write to disk.
 *
 * Phase 4 wired the geometry pipeline; Phase 5 (DESIGN-PHASE5-THEMING.md)
 * lifted every hardcoded visual constant into the Theme. The renderer now
 * has no module-level colour, font, or stroke values — every visible
 * attribute is sourced from the Theme. Themes are swappable; geometry is
 * untouched.
 *
 * Layer order, back to front (per §6.5 and feedback-circuit-board-metaphor):
 *   1. background
 *   2. nodeset bounding rectangles (dashed, behind everything else)
 *   3. polylines (forward edges + back-edges)
 *   4. path highlights (thicker coloured overlay on the polylines they touch)
 *   5. boxes (per-shape SVG primitive)
 *   6. node labels
 *   7. edge labels with a halo (surface-coloured, so it works in dark themes)
 *
 * Crossing markers are intentionally NOT drawn. Step 7 already
 * materialised X-junctions inline in the polyline geometry; any
 * remaining same-point crossings between polylines are visually
 * resolved by the 45° chamfers and the line-join. A small debug-only
 * dot was useful during the eyeball checkpoint but is not part of the
 * shipped output.
 */
import type { ImportedModule, Model, ModelEdge, ModelNode } from "../bind/model.js";
import type { ModulePlacedBody } from "../layout/module-place.js";
import type { ShapeName } from "../parser/ast.js";
import type { Placement } from "../layout/placement.js";
import { CELL_PX } from "../layout/slots.js";
import { computePixelLayout, type PixelLayout } from "../layout/pixels.js";
import { estimateLabelWidth } from "../layout/text-fit.js";
import type { ChannelRouting, Point, Polyline } from "../layout/channels.js";
import type { TagRule, Theme } from "../theme/theme.js";
import {
  isGradientString,
  parseGradientStops,
  resolveColour,
  resolveTags,
} from "../theme/theme.js";
import { buildLegend, renderLegend, type LegendLayout } from "./legend.js";
import {
  buildFooter,
  buildHeader,
  renderTitleStrip,
  type TitleStripLayout,
} from "./titles.js";
import {
  buildIconRegistry,
  loadIcon,
  renderIconBadge,
  renderIconBody,
  renderIconPlaceholder,
  type IconRegistry,
} from "./icons.js";

// --- pixel and bounds layout ---------------------------------------------

const LABEL_OFFSET = 5;
const NODESET_PADDING = 6;

/**
 * Page margin around the entire rendered diagram, in pixels. Gives
 * the SVG breathing room on slides and in documents. Set to 1 cell
 * (32px) per the elegance pass — small enough to not feel indulgent,
 * large enough that the diagram never feels cropped.
 */
const PAGE_MARGIN = 32;

// --- entry point ----------------------------------------------------------

export interface RenderOpts {
  /**
   * Directory the .melk file lives in. Used to resolve local icon-pack
   * paths and to place the .melk-cache/ directory. Defaults to cwd
   * when omitted.
   */
  meltFileDir?: string;
  /**
   * When false, URL icon packs become cache-only (no HTTPS fetches).
   * CLI passes the inverse of `--no-network`. Defaults to true.
   */
  allowNetwork?: boolean;
}

/**
 * Pure function: same inputs → same SVG byte-for-byte. The Theme is part
 * of the input contract: re-rendering with a different Theme gives a
 * different SVG, with no other change.
 *
 * The optional `opts` argument carries side-effect configuration for
 * the icon-pack loader (DESIGN-PHASE5-ICONS): the directory to resolve
 * relative pack paths from, and whether URL packs may hit the network.
 */
export function renderSVG(
  model: Model,
  placement: Placement,
  routing: ChannelRouting,
  theme: Theme,
  opts: RenderOpts = {},
): string {
  // `routing` carries both the per-edge polylines and the diagram
  // pixel extent. Kept as a separate name from `polylines` because
  // downstream code reads both `routing.polylines` and the canvas
  // width/height.
  const polylines = routing;
  // DESIGN-PHASE5-ICONS §5.1 — build the icon registry once per render.
  // Side effects (disk reads / HTTPS fetches / cache writes / stderr
  // warnings) all live in icons.ts; the rest of this function still
  // produces the same SVG for the same inputs.
  const iconRegistry = buildIconRegistry(
    model,
    opts.meltFileDir ?? process.cwd(),
    opts.allowNetwork ?? true,
  );

  const layout = computePixelLayout(placement);
  const boxes = boxBounds(model, placement, layout);

  // Non-fatal label-overflow check: the placer takes `size:` at face
  // value and never grows a box to fit its label, so a too-long label
  // silently overflows — invisible to a text-only agent. Warn (with the
  // exact recommended size) so the author can fix it without eyeballing
  // the SVG.
  warnLabelOverflow(model, boxes, theme);

  // Pre-compute nodeset rects so we can both (a) draw them and (b) extend
  // the SVG canvas to cover them. With a tight diagram and a nodeset
  // around all the boxes, the padded rect would otherwise spill into
  // negative coords and get clipped by the viewBox.
  const nodesetRects: { name: string; rect: BoxBounds }[] = [];
  for (const ns of model.nodesets) {
    const r = nodesetRect(ns.members, boxes);
    if (r) nodesetRects.push({ name: ns.name, rect: r });
  }

  const frameLabelSize = theme.typography.size.frame;
  // Circles render their label below the shape; collect each circle's
  // label-pixel extent so canvasBounds can expand the canvas to fit.
  const circleLabelExtents = collectCircleLabelExtents(model, boxes, theme);
  const canvas = canvasBounds(polylines, nodesetRects, circleLabelExtents, frameLabelSize);
  let W = canvas.width;
  let H = canvas.height;
  let tx = -canvas.x;
  let ty = -canvas.y;

  // DESIGN-PHASE5-LEGEND §3.4 — compute legend strip if enabled and extend
  // canvas accordingly. The diagram body stays where it is; the legend
  // takes the new space. Translate (tx, ty) accounts for top/left
  // positioning where the diagram shifts inward to make room.
  let legendLayout: LegendLayout | undefined;
  let legendOriginX = 0;
  let legendOriginY = 0;
  if (model.legend?.on) {
    legendLayout = buildLegend(model, theme, model.legend.position, W, H);
    switch (model.legend.position) {
      case "bottom":
        legendOriginX = 0;
        legendOriginY = H;
        H += legendLayout.height;
        break;
      case "top":
        legendOriginX = 0;
        legendOriginY = 0;
        ty += legendLayout.height;
        H += legendLayout.height;
        break;
      case "right":
        legendOriginX = W;
        legendOriginY = 0;
        W += legendLayout.width;
        break;
      case "left":
        legendOriginX = 0;
        legendOriginY = 0;
        tx += legendLayout.width;
        W += legendLayout.width;
        break;
    }
  }

  // DESIGN-PHASE5-TITLES §3.4 — header strip (title + subtitle) above
  // everything else; footer strip (caption) below everything else.
  // The header pushes the diagram body AND the legend down; the footer
  // is appended at the bottom of the canvas.
  const headerLayout: TitleStripLayout | undefined = buildHeader(model, theme);
  const footerLayout: TitleStripLayout | undefined = buildFooter(model, theme);
  if (headerLayout) {
    ty += headerLayout.height;
    legendOriginY += headerLayout.height;
    H += headerLayout.height;
  }
  let footerOriginY = 0;
  if (footerLayout) {
    footerOriginY = H;
    H += footerLayout.height;
  }
  // DESIGN-PHASE5-TITLES §3.3 — widen the canvas if title text overflows.
  // The diagram body stays at its left-aligned position; the extra width
  // is added to the right.
  const requiredWidth = Math.max(
    headerLayout?.minWidth ?? 0,
    footerLayout?.minWidth ?? 0,
  );
  if (requiredWidth > W) {
    W = requiredWidth;
  }

  // Build a node-id → shape map for the diamond endpoint clip pass.
  // Diamonds need their trace endpoints reprojected onto the diamond
  // perimeter (the polyline pipeline targets the rect face, which leaves
  // a visible gap to the inset diamond edge at non-vertex slots).
  const shapeOf = new Map(model.nodes.map((n) => [n.id, n.shape]));

  // We need the clipped polylines for both the main render AND the
  // bend-disambiguation pass below.
  const clippedPolys: Polyline[] = polylines.polylines.map((poly) => {
    const edge = model.edges[poly.edgeIndex];
    if (!edge) return poly;
    return clipDiamondEndpoints(poly, edge, shapeOf, boxes);
  });

  // Bend-disambiguation pre-pass: find shared-chamfer-point bend
  // intersections. Returns a map: polyIdx → list of intersection
  // points. The renderer uses this to split the trace's stroke into
  // sub-paths around each intersection, with a gradient stroke on the
  // intersection-containing segment (default → darker → default).
  const gradientDefs: string[] = [];
  const intersectionsByPoly = detectBendIntersections(clippedPolys, model, theme, gradientDefs);

  // Tag-rule gradient paints (DESIGN-PHASE5 gradient addendum). The
  // resolver handles either fills, borders, or icon colours — any
  // `linear ...` value emits a <linearGradient> def and returns a
  // url(...) reference; solid colours pass through resolveColour.
  // Shared definitions get a stable id so identical paints reuse the
  // same def.
  //
  // The defs are emitted into `gradientDefs` (which feeds renderDefs
  // before the diagram body). To make sure every gradient referenced
  // in the body is also defined, we pre-walk the nodes here so the
  // resolver has a chance to register its def before renderDefs runs.
  const fillResolver = createFillResolver(theme, gradientDefs);
  for (const n of model.nodes) {
    const o = resolveTags(theme, n.tags, `node '${n.id}'`);
    if (o.fill !== undefined) fillResolver(o.fill);
    if (o.border !== undefined) fillResolver(o.border);
    if (o["icon-color"] !== undefined) fillResolver(o["icon-color"]);
  }
  // Legend swatches can carry the same gradient paints as nodes (a tag
  // with a gradient `fill`/`border`/`trace`). Register them here too so
  // their <linearGradient> defs exist before renderDefs runs below.
  if (legendLayout) {
    for (const placed of legendLayout.placed) {
      const rule = placed.entry.rule;
      if (rule.fill !== undefined) fillResolver(rule.fill);
      if (rule.border !== undefined) fillResolver(rule.border);
      if (rule.trace !== undefined) fillResolver(rule.trace);
    }
  }

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(W)} ${fmt(H)}" width="${fmt(W)}" height="${fmt(H)}" font-family="${escapeAttr(theme.typography.face)}" font-size="${theme.typography.size.body}" font-weight="${theme.typography.weight.label}">`,
  );
  parts.push(renderDefs(theme, gradientDefs));
  parts.push(
    `<rect width="${fmt(W)}" height="${fmt(H)}" fill="${theme.tokens.surface}"/>`,
  );
  parts.push(`<g transform="translate(${fmt(tx)} ${fmt(ty)})">`);

  for (const { name, rect } of nodesetRects) {
    parts.push(renderNodeset(name, rect, theme));
  }

  for (let i = 0; i < polylines.polylines.length; i++) {
    const poly = clippedPolys[i]!;
    const edge = model.edges[poly.edgeIndex];
    if (!edge) continue;
    const overrides = resolveTags(theme, edge.tags, `edge '${edge.from} -> ${edge.to}'`);
    const intersections = intersectionsByPoly.get(i) ?? [];
    parts.push(renderEdge(edge, poly, theme, overrides, intersections));
  }

  // Via-pair through-segments. The slot allocator forces each via-
  // pair's second-half entry slot on the highway's exit face to match
  // its first-half exit slot on the entry face — so the two polylines
  // meet at the same perp coord and we just draw a straight segment
  // across the highway interior.
  const firstHalfByOriginal = new Map<number, number>();
  const secondHalfByOriginal = new Map<number, number>();
  for (let i = 0; i < polylines.polylines.length; i++) {
    const edge = model.edges[polylines.polylines[i]!.edgeIndex];
    if (!edge || edge.viaOriginal === undefined) continue;
    if (edge.viaFirstHalf) firstHalfByOriginal.set(edge.viaOriginal, i);
    else secondHalfByOriginal.set(edge.viaOriginal, i);
  }
  for (const [orig, firstIdx] of firstHalfByOriginal) {
    const secondIdx = secondHalfByOriginal.get(orig);
    if (secondIdx === undefined) continue;
    const firstPts = polylines.polylines[firstIdx]!.points;
    const secondPts = polylines.polylines[secondIdx]!.points;
    const start = firstPts[firstPts.length - 1]!;
    const end = secondPts[0]!;
    // §11.11: if the highway is `render: underground`, draw the through-
    // segment lighter + thinner and add manhole circles at the perimeter
    // crossings. The first-half ends at the highway's entry face; the
    // second-half starts at its exit face — so `start` and `end` are
    // already the perimeter intersection points.
    const firstHalfEdge = model.edges[polylines.polylines[firstIdx]!.edgeIndex];
    const hwyId = firstHalfEdge?.to;
    const hwyNode = hwyId ? model.nodes.find((n) => n.id === hwyId) : undefined;
    const underground = hwyNode?.render === "underground";
    const traceStroke = theme.tokens["trace-default"];
    if (underground) {
      // Underground: trace dips below the surface at the entry manhole
      // and re-emerges at the exit manhole. Render the faded line from
      // centre to centre (so it visibly enters/exits the manhole), then
      // hollow circles on top to mark the manholes themselves.
      const ugWidth = theme.strokes["underground-width"];
      const ugOpacity = theme.strokes["underground-opacity"];
      const r = theme.strokes["manhole-radius"];
      // Manhole: outline only (fill=none) so the surface trace passes
      // visibly through the centre — like a shoelace through an eyelet.
      parts.push(
        `<g data-via-through="${orig}" data-underground="1">` +
          `<path d="M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(end.x)} ${fmt(end.y)}" fill="none" stroke="${traceStroke}" stroke-width="${ugWidth}" stroke-opacity="${ugOpacity}" stroke-linecap="round" stroke-linejoin="round"/>` +
          `<circle cx="${fmt(start.x)}" cy="${fmt(start.y)}" r="${r}" fill="none" stroke="${traceStroke}" stroke-width="${theme.strokes.trace}"/>` +
          `<circle cx="${fmt(end.x)}" cy="${fmt(end.y)}" r="${r}" fill="none" stroke="${traceStroke}" stroke-width="${theme.strokes.trace}"/>` +
          `</g>`,
      );
    } else {
      // Surface: trace runs continuously through the highway. No
      // manholes — the line speaks for itself.
      parts.push(
        `<g data-via-through="${orig}">` +
          `<path d="M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(end.x)} ${fmt(end.y)}" fill="none" stroke="${traceStroke}" stroke-width="${theme.strokes.trace}" stroke-linecap="round" stroke-linejoin="round"/>` +
          `</g>`,
      );
    }
  }

  // Path highlights: lay coloured thick strokes on top of every polyline
  // that participates in the path's chain. A path "a -> b -> c" matches
  // either forward edges or back edges between consecutive members.
  for (let i = 0; i < model.paths.length; i++) {
    const path = model.paths[i]!;
    const colour = theme.tokens.accents[i % theme.tokens.accents.length]!;
    const segs = pathSegments(path.chain, model.edges, polylines.polylines);
    for (const seg of segs) {
      parts.push(renderPathHighlight(seg, colour, theme.strokes.emphasis));
    }
  }

  // §11.13: only highway nodes themselves carry visual z (faded
  // dashed outline for underground). Non-highway members anchored by
  // an underground highway carry a placement z for collision-avoidance
  // only, but render as surface boxes — they're conceptually
  // "manhole entrances" on the surface, not underground cells.
  //
  // Render order: underground highway boxes first (so they appear
  // behind), then surface nodes (boxes, sinks, sources) on top.
  const nodeOrder = model.nodes
    .map((n, i) => {
      const cellZ = placement.cells.get(n.id)?.z ?? 0;
      const renderZ = n.shape === "highway" ? cellZ : 0;
      return { n, i, renderZ };
    })
    .sort((a, b) => a.renderZ - b.renderZ || a.i - b.i);
  for (const { n, renderZ } of nodeOrder) {
    const b = boxes.get(n.id);
    if (!b) continue;
    // DESIGN-PHASE5-MODULES.md §11 — module-shape nodes emit a
    // <g transform> containing the module's body rendered under its
    // own theme. The body is the placed sub-model that the per-module
    // placement pass stashed on `ImportedModule.body`.
    if (n.shape === "module") {
      const imported = model.imports.find((m) => m.alias === n.id);
      if (imported !== undefined && imported.body !== undefined) {
        // Pass the *cell* rect — not the synthetic node's centered
        // rect — so the body has the full cell allocation as slack to
        // shift inside under applyModuleAlignment. The synthetic node
        // is invisible; only the body draws.
        const cell = placement.cells.get(n.id);
        const cellRect = cell
          ? {
              x: layout.colX[cell.col]!,
              y: layout.rowY[cell.row]!,
              width: layout.colWidthPx[cell.col]!,
              height: layout.rowHeightPx[cell.row]!,
            }
          : b;
        parts.push(
          renderModuleBody(imported, cellRect, theme, opts, iconRegistry),
        );
      }
      continue;
    }
    const overrides = resolveTags(theme, n.tags, `node '${n.id}'`);
    parts.push(renderNode(n, b, theme, overrides, renderZ, iconRegistry, fillResolver));
  }

  for (let i = 0; i < polylines.polylines.length; i++) {
    const poly = polylines.polylines[i]!;
    const edge = model.edges[poly.edgeIndex];
    if (!edge || !edge.label) continue;
    parts.push(renderEdgeLabel(edge, poly, theme));
  }

  parts.push(`</g>`);
  if (legendLayout) {
    parts.push(renderLegend(legendLayout, legendOriginX, legendOriginY, theme, fillResolver));
  }
  if (headerLayout) {
    parts.push(renderTitleStrip(headerLayout, 0, 0, theme));
  }
  if (footerLayout) {
    parts.push(renderTitleStrip(footerLayout, 0, footerOriginY, theme));
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}

/**
 * The canvas must cover both the routed-polyline extent (polylines.width
 * / .height, which is also the box-bounding extent because polylines
 * terminate at slot ports on the box faces) AND any nodeset rectangles,
 * which extend by NODESET_PADDING on every side and can spill into
 * negative coords on a tight diagram. The returned (x, y) is the
 * minimum corner; renderSVG translates the content so it lands at (0, 0).
 *
 * The nodeset label sits above the rect's top edge — we reserve
 * `frameLabelSize + 2` of extra headroom above the topmost nodeset.
 */
function canvasBounds(
  polylines: ChannelRouting,
  nodesetRects: { name: string; rect: BoxBounds }[],
  circleLabelExtents: { x: number; y0: number; y1: number; halfWidth: number }[],
  frameLabelSize: number,
): BoxBounds {
  let minX = 0;
  let minY = 0;
  let maxX = polylines.width;
  let maxY = polylines.height;
  for (const { rect } of nodesetRects) {
    const x0 = rect.x - NODESET_PADDING;
    const y0 = rect.y - NODESET_PADDING - (frameLabelSize + 2);
    const x1 = rect.x + rect.width + NODESET_PADDING;
    const y1 = rect.y + rect.height + NODESET_PADDING;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  // Circles render their label BELOW the shape; expand the canvas
  // vertically (and horizontally for long labels) so labels never clip.
  for (const ext of circleLabelExtents) {
    if (ext.y1 > maxY) maxY = ext.y1;
    const xLeft = ext.x - ext.halfWidth;
    const xRight = ext.x + ext.halfWidth;
    if (xLeft < minX) minX = xLeft;
    if (xRight > maxX) maxX = xRight;
  }
  // Page margin: 1 cell each side. Diagrams never sit edge-to-edge.
  return {
    x: minX - PAGE_MARGIN,
    y: minY - PAGE_MARGIN,
    width: maxX - minX + 2 * PAGE_MARGIN,
    height: maxY - minY + 2 * PAGE_MARGIN,
  };
}

// --- pixel layout ---------------------------------------------------------
// Pixel positions come from the shared computePixelLayout (src/layout/
// pixels.ts) — the single source of truth, also used by the router so
// boxes and polyline waypoints land on identical coords.

interface BoxBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxBounds(
  model: Model,
  placement: Placement,
  layout: PixelLayout,
): Map<string, BoxBounds> {
  const sizeOf = new Map(model.nodes.map((n) => [n.id, n.size]));
  const out = new Map<string, BoxBounds>();
  for (const [id, cell] of placement.cells) {
    const sz = sizeOf.get(id) ?? { width: 1, height: 1 };
    const width = sz.width * CELL_PX;
    const height = sz.height * CELL_PX;
    const shift = placement.pixelShift.get(id);
    // Multi-cell occupancy: box is anchored at the top-left of its
    // footprint cell and fills its declared pixel size. No centering;
    // boxes wider/taller than 1 cell span multiple grid rows/cols.
    // A per-node `offset:` fractional part shifts the box by the
    // accumulated sub-cell pixels — slot pixels in the router are
    // shifted by the same delta, so the polyline endpoints stay
    // attached to the box face after the shift.
    out.set(id, {
      x: layout.colX[cell.col]! + (shift?.dx ?? 0),
      y: layout.rowY[cell.row]! + (shift?.dy ?? 0),
      width,
      height,
    });
  }
  return out;
}

// --- pieces ---------------------------------------------------------------

/**
 * Returns a function that resolves a tag-rule `fill` value (solid
 * colour or `linear ...` gradient) into the corresponding SVG paint
 * value:
 *   - Solid colour → resolved hex.
 *   - Gradient → `url(#gradient-N)`, with the matching
 *     <linearGradient> emitted into `defs` exactly once per unique
 *     gradient string.
 *
 * Caching is by raw fill string, so identical gradient declarations on
 * different nodes share a single def (smaller SVG, predictable diffs).
 *
 * The angle convention follows CSS: 0deg = bottom-to-top, 90deg =
 * left-to-right. SVG's coordinate system is y-down, so we rotate
 * accordingly when computing the gradient vector.
 */
function createFillResolver(
  theme: Theme,
  defs: string[],
): (value: string) => string {
  const cache = new Map<string, string>();
  let nextId = 0;
  return (value: string): string => {
    if (!isGradientString(value)) {
      return resolveColour(theme, value);
    }
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const spec = parseGradientStops(value);
    if (spec === undefined) {
      // Validator should have rejected this — defensive fallback.
      return resolveColour(theme, theme.tokens["surface-raised"]);
    }
    const id = `tag-gradient-${nextId++}`;
    // CSS angle → SVG gradient vector. CSS: 0deg = upward; 90deg =
    // rightward. SVG (y-down): rotate the vector clockwise by `angle`
    // starting from "up" (0,-1) so 0deg points up, 90deg right.
    const rad = (spec.angle * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    // Project the vector onto the unit-square gradient box (CSS
    // gradient lines extend through opposite corners). We use the
    // gradient box [(0,0)-(1,1)] in objectBoundingBox units so the
    // gradient scales with the shape automatically.
    const x1 = 0.5 - dx / 2;
    const y1 = 0.5 - dy / 2;
    const x2 = 0.5 + dx / 2;
    const y2 = 0.5 + dy / 2;
    const stops = spec.colours
      .map((c, i) => {
        const offset = spec.colours.length === 1
          ? 0
          : (i / (spec.colours.length - 1)) * 100;
        return `    <stop offset="${fmt(offset)}%" stop-color="${resolveColour(theme, c)}"/>`;
      })
      .join("\n");
    defs.push(
      `  <linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}">\n${stops}\n  </linearGradient>`,
    );
    const url = `url(#${id})`;
    cache.set(value, url);
    return url;
  };
}

function renderDefs(theme: Theme, extraDefs: string[]): string {
  // Arrow marker (skipped if the theme opts out of arrowheads).
  const arrowDefs: string[] = [];
  if (theme.strokes.arrow["head-shape"] !== "none") {
    const arrowFill = theme.tokens["trace-default"];
    const w = theme.strokes.arrow.scale;
    const h = theme.strokes.arrow.scale;
    arrowDefs.push(
      `  <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="${w}" markerHeight="${h}" orient="auto">`,
      `    <path d="M 0 0 L 10 5 L 0 10 Z" fill="${arrowFill}"/>`,
      `  </marker>`,
    );
  }
  if (arrowDefs.length === 0 && extraDefs.length === 0) {
    return `<defs></defs>`;
  }
  return [
    `<defs>`,
    ...arrowDefs,
    ...extraDefs.map((d) => `  ${d}`),
    `</defs>`,
  ].join("\n");
}

function renderNodeset(name: string, rect: BoxBounds, theme: Theme): string {
  const x = rect.x - NODESET_PADDING;
  const y = rect.y - NODESET_PADDING;
  const w = rect.width + 2 * NODESET_PADDING;
  const h = rect.height + 2 * NODESET_PADDING;
  const dash = theme.strokes.dash.frame.join(" ");
  return [
    `<g data-nodeset="${escapeAttr(name)}">`,
    `  <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="4" ry="4" fill="none" stroke="${theme.tokens["border-subtle"]}" stroke-width="${theme.strokes.frame}" stroke-dasharray="${dash}"/>`,
    `  <text x="${fmt(x + 6)}" y="${fmt(y - 2)}" text-anchor="start" font-size="${theme.typography.size.frame}" fill="${theme.tokens["ink-secondary"]}">${escapeText(name)}</text>`,
    `</g>`,
  ].join("\n");
}

/**
 * For every circle node, compute the pixel extent of its label (which
 * renders BELOW the shape). canvasBounds uses these to expand the
 * canvas so labels never clip into the page-margin or past the SVG
 * edge.
 *
 * Returns {x, y0, y1, halfWidth} per circle: x = label centre x,
 * (y0..y1) = label vertical range, halfWidth = half the estimated
 * label width (for horizontal expansion).
 */
function collectCircleLabelExtents(
  model: Model,
  boxes: Map<string, BoxBounds>,
  theme: Theme,
): { x: number; y0: number; y1: number; halfWidth: number }[] {
  const out: { x: number; y0: number; y1: number; halfWidth: number }[] = [];
  const fontSize = theme.typography.size.body;
  for (const n of model.nodes) {
    if (n.shape !== "circle") continue;
    const b = boxes.get(n.id);
    if (!b) continue;
    const cx = b.x + b.width / 2;
    const labelY = b.y + b.height + fontSize * 0.9 + 4;
    // Shared width heuristic from the text-fit pass (no local copy — the
    // old "would create a cycle" claim was wrong; layout never imports render).
    const halfWidth = estimateLabelWidth(n.label, fontSize) / 2;
    out.push({
      x: cx,
      y0: b.y + b.height,
      y1: labelY + fontSize * 0.3, // descender room
      halfWidth,
    });
  }
  return out;
}

// Shapes whose label renders BELOW the glyph (not inside the box), so a
// long label never overflows the box itself — skip them.
const LABEL_BELOW_SHAPES = new Set<ShapeName>(["circle", "icon", "highway"]);

/**
 * Warn (non-fatal) for any node whose label is wider than its box. The
 * placer never grows a box to fit its label, so this is the only feedback
 * a text-only author gets that a size is too small. The warning carries
 * the minimum width in cells that would fit, so the fix is mechanical.
 */
function warnLabelOverflow(
  model: Model,
  boxes: Map<string, BoxBounds>,
  theme: Theme,
): void {
  const fontSize = theme.typography.size.body;
  for (const n of model.nodes) {
    if (!n.label) continue;
    if (LABEL_BELOW_SHAPES.has(n.shape)) continue;
    const b = boxes.get(n.id);
    if (!b) continue;
    // Per-line: a multi-line label overflows if its WIDEST line does.
    const widest = n.label
      .split("\n")
      .reduce((mx, line) => Math.max(mx, estimateLabelWidth(line, fontSize)), 0);
    // Inner width = box width minus a small horizontal padding either side.
    const innerWidth = b.width - fontSize * 0.6;
    if (widest <= innerWidth) continue;
    // Minimum width in cells: enough px for the label + padding, rounded
    // up to a whole cell. Diamonds/cylinders need their shape's text inset,
    // but a width-cell suggestion is the dominant lever, so keep it simple.
    const neededPx = widest + fontSize * 0.6;
    const neededCells = Math.ceil(neededPx / CELL_PX);
    const heightCells = Math.round(b.height / CELL_PX);
    labelOverflowWarn(
      `W_LABEL_OVERFLOW: label of '${n.id}' (${widest.toFixed(0)}px) ` +
        `overflows its ${Math.round(b.width)}px box. ` +
        `Grow it: \`${n.id} { size: ${neededCells}x${heightCells} }\` ` +
        `(SYNTAX.md §3.3 has the size-from-label table).`,
    );
  }
}

const labelOverflowSeen = new Set<string>();
function labelOverflowWarn(message: string): void {
  if (labelOverflowSeen.has(message)) return;
  labelOverflowSeen.add(message);
  process.stderr.write(message + "\n");
}

/** Reset the label-overflow dedup table; called from tests. */
export function resetLabelOverflowWarnings(): void {
  labelOverflowSeen.clear();
}

function nodesetRect(
  members: string[],
  boxes: Map<string, BoxBounds>,
): BoxBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const id of members) {
    const b = boxes.get(id);
    if (!b) continue;
    any = true;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  if (!any) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Re-project the first/last point of a polyline onto the diamond
 * perimeter when the source/target node is a diamond. The polyline
 * pipeline targets the rect face (which is where slot ports live),
 * but the diamond's actual edge is inset everywhere except at the
 * four cardinal vertices — leaving a visible gap at non-vertex slots
 * (e.g. multi-trace fan-ins).
 *
 * The diamond perimeter equation, for a diamond inscribed in box
 * (x, y, w, h) with centre (cx, cy):
 *
 *   |2*(px - cx)/w| + |2*(py - cy)/h| = 1
 *
 * For a W-face slot at (b.x, py): the diamond's left-edge x at py is
 * cx - (w/2) * (1 - |2*(py - cy)/h|). Similar for N/E/S. Routing is
 * unchanged; only the rendered endpoint moves.
 *
 * Returns a new polyline with the same shape minus the adjusted
 * endpoints, or the original poly if neither end touches a diamond.
 */
function clipDiamondEndpoints(
  poly: Polyline,
  edge: ModelEdge,
  shapeOf: Map<string, ShapeName>,
  boxes: Map<string, BoxBounds>,
): Polyline {
  if (poly.points.length < 2) return poly;
  const srcShape = shapeOf.get(edge.from);
  const tgtShape = shapeOf.get(edge.to);
  const srcDiamond = srcShape === "diamond";
  const tgtDiamond = tgtShape === "diamond";
  if (!srcDiamond && !tgtDiamond) return poly;
  const points = poly.points.slice();
  if (srcDiamond) {
    const b = boxes.get(edge.from);
    if (b) {
      const projected = projectOntoDiamond(points[0]!, b);
      points[0] = projected;
    }
  }
  if (tgtDiamond) {
    const b = boxes.get(edge.to);
    if (b) {
      const projected = projectOntoDiamond(points[points.length - 1]!, b);
      points[points.length - 1] = projected;
    }
  }
  return { ...poly, points };
}

/**
 * Given a point on the rect face of a diamond, return the corresponding
 * point on the diamond's actual perimeter at the same face position.
 * Preserves the cross-axis coord (so a W-face slot at y=42 stays at y=42
 * but x moves from b.x to the diamond's left-edge x at y=42).
 */
function projectOntoDiamond(p: Point, b: BoxBounds): Point {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  // Which face is `p` on? Pick by which rect-edge is closest.
  const dW = Math.abs(p.x - b.x);
  const dE = Math.abs(p.x - (b.x + b.width));
  const dN = Math.abs(p.y - b.y);
  const dS = Math.abs(p.y - (b.y + b.height));
  const minD = Math.min(dW, dE, dN, dS);
  const horizontalNorm = Math.abs(2 * (p.y - cy) / b.height); // 0 at midline, 1 at top/bottom vertex
  const verticalNorm = Math.abs(2 * (p.x - cx) / b.width);   // 0 at midline, 1 at left/right vertex
  if (minD === dW) {
    // W face: x = cx - (w/2) * (1 - horizontalNorm)
    return { x: cx - (b.width / 2) * (1 - horizontalNorm), y: p.y };
  }
  if (minD === dE) {
    return { x: cx + (b.width / 2) * (1 - horizontalNorm), y: p.y };
  }
  if (minD === dN) {
    return { x: p.x, y: cy - (b.height / 2) * (1 - verticalNorm) };
  }
  // dS
  return { x: p.x, y: cy + (b.height / 2) * (1 - verticalNorm) };
}

/**
 * Half-length (in pixels) of the gradient "lump" rendered on a trace
 * at each detected bend-ambiguity. The lump fades in over
 * BEND_LUMP_HALF px, peaks at the bend, and fades out over another
 * BEND_LUMP_HALF px. Subtle — just enough to disambiguate which trace
 * owns the corner where two chamfers interlock.
 */
const BEND_LUMP_HALF = 6;

/**
 * Find every chamfer (bend) in a polyline. A chamfer is a diagonal
 * segment (or two collinear diagonals) between two axis-aligned
 * segments. Returns one record per chamfer carrying:
 *
 *   - centre: midpoint of the diagonal — used for proximity detection
 *   - incomingStart / chamferStart / chamferEnd / outgoingEnd:
 *       points along the trace defining the bend region. The lump
 *       sub-path follows the trace from incomingStart through the
 *       chamfer to outgoingEnd, so it overlays the bend exactly.
 *   - incomingHoriz / outgoingHoriz: orientation of surrounding axials
 *       (for gradient orientation pick later).
 */
interface BendInfo {
  centre: Point;
  /**
   * Sub-polyline tracing the lump's path — incomingStart, the
   * chamfer's internal points, and outgoingEnd. polylineD on this
   * produces the same Q/C curve the main trace renders, but bounded
   * to the bend region so the gradient stroke only covers the bend.
   */
  lumpPoints: Point[];
  incomingHoriz: boolean;
  outgoingHoriz: boolean;
}

function findBendCenters(
  points: Point[],
  lumpHalf: number = BEND_LUMP_HALF,
): BendInfo[] {
  const out: BendInfo[] = [];
  let i = 1;
  while (i < points.length) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (dx !== 0 && dy !== 0) {
      const endIdx = findChamferEnd(points, i);
      if (endIdx >= i) {
        const chamferStart = prev;
        const chamferEnd = points[endIdx]!;
        const centre = {
          x: (chamferStart.x + chamferEnd.x) / 2,
          y: (chamferStart.y + chamferEnd.y) / 2,
        };
        const incomingPrev = i >= 2 ? points[i - 2]! : chamferStart;
        const outgoingNext = endIdx + 1 < points.length ? points[endIdx + 1]! : chamferEnd;
        const incomingHoriz =
          chamferStart.y === incomingPrev.y && chamferStart.x !== incomingPrev.x;
        const outgoingHoriz =
          chamferEnd.y === outgoingNext.y && chamferEnd.x !== outgoingNext.x;
        // For the lump sub-path, walk LUMP_HALF px back along the
        // incoming axial from chamferStart and LUMP_HALF px forward
        // along the outgoing axial from chamferEnd — clamped to the
        // surrounding segment room.
        const incomingRoom = incomingHoriz
          ? Math.abs(chamferStart.x - incomingPrev.x)
          : Math.abs(chamferStart.y - incomingPrev.y);
        const outgoingRoom = outgoingHoriz
          ? Math.abs(outgoingNext.x - chamferEnd.x)
          : Math.abs(outgoingNext.y - chamferEnd.y);
        const incomingLumpRoom = Math.min(lumpHalf, incomingRoom);
        const outgoingLumpRoom = Math.min(lumpHalf, outgoingRoom);
        const incomingStart: Point = incomingHoriz
          ? {
              x: chamferStart.x - Math.sign(chamferStart.x - incomingPrev.x) * incomingLumpRoom,
              y: chamferStart.y,
            }
          : {
              x: chamferStart.x,
              y: chamferStart.y - Math.sign(chamferStart.y - incomingPrev.y) * incomingLumpRoom,
            };
        const outgoingEnd: Point = outgoingHoriz
          ? {
              x: chamferEnd.x + Math.sign(outgoingNext.x - chamferEnd.x) * outgoingLumpRoom,
              y: chamferEnd.y,
            }
          : {
              x: chamferEnd.x,
              y: chamferEnd.y + Math.sign(outgoingNext.y - chamferEnd.y) * outgoingLumpRoom,
            };
        // lumpPoints follows the same axis layout polylineD expects:
        // an axial → chamfer-internal pts → axial sub-path. Including
        // the chamfer-internal pts (between chamferStart and
        // chamferEnd) is critical — polylineD walks them to detect
        // 4-point chamfers and the parallel-offset C-curve case.
        const lumpPoints: Point[] = [incomingStart, chamferStart];
        for (let k = i; k < endIdx; k++) lumpPoints.push(points[k]!);
        lumpPoints.push(chamferEnd, outgoingEnd);
        out.push({
          centre,
          lumpPoints,
          incomingHoriz,
          outgoingHoriz,
        });
        i = endIdx + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Find adjacent-bend ambiguities: pairs of chamfers from different
 * polylines whose centres are within BEND_AMBIGUITY_THRESHOLD pixels
 * of each other. For each such pair, emit a fading dark lump on the
 * UPPER trace (= the polyline with the higher index) along its
 * outgoing axis at the bend, so the eye can pick out the upper trace
 * through the ambiguous region.
 *
 * The lump uses an SVG linear gradient: transparent → darker → transparent
 * along the trace direction. The gradient is defined inline in `defs`
 * and shared across all H-oriented or V-oriented lumps.
 */
/**
 * Where the trace's stroke transitions to a darker tone for a bend
 * intersection. `bendIdx` identifies which bend on the polyline; the
 * intersection point is at that bend's chamfer-end (or chamfer-start,
 * depending on the geometry).
 */
export interface BendIntersection {
  bendIdx: number;
  point: Point;
  /**
   * "primary" = LOWER trace at the intersection (rendered first, then
   * the upper trace is drawn on top). Gets a deeper peak so it remains
   * legible under the overlying chamfer.
   * "secondary" = UPPER trace at the intersection. Gets a lighter peak
   * so the eye can still see that *something* is happening at the
   * corner without it competing with the lower trace.
   */
  tier: "primary" | "secondary";
}


/**
 * BEND-INTERSECTION detector. Two bends visually intersect when they
 * share a chamfer point — i.e. one bend's chamfer endpoint matches
 * another bend's chamfer endpoint exactly.
 *
 * Canonical case (ex 24 hwy exit):
 *   hwy->sink_b chamfer ends at (236, 28)
 *   hwy->sink_c chamfer starts at (236, 28)
 *   → shared point → bend intersection
 *
 * Returns a map: polyIdx → list of intersection points found on that
 * polyline. The renderer uses this to split the trace into segments
 * around each intersection, with a gradient stroke on the segment
 * immediately after the intersection (default → darker → default).
 *
 * Also pushes the required gradient defs into `defs`.
 */
function detectBendIntersections(
  polys: Polyline[],
  _model: Model,
  _theme: Theme,
  _defs: string[],
): Map<number, BendIntersection[]> {
  const result = new Map<number, BendIntersection[]>();
  const bendsOf = polys.map((p) => findBendCenters(p.points));
  const chamferPointsOf: { x: number; y: number; bendIdx: number }[][] =
    polys.map(() => []);
  for (let pi = 0; pi < polys.length; pi++) {
    bendsOf[pi]!.forEach((b, bIdx) => {
      for (let k2 = 1; k2 < b.lumpPoints.length - 1; k2++) {
        const p = b.lumpPoints[k2]!;
        chamferPointsOf[pi]!.push({ x: p.x, y: p.y, bendIdx: bIdx });
      }
    });
  }

  // Axial segments per polyline: every straight piece between two
  // consecutive polyline vertices that share an x or y.  Used to find
  // collinear overlaps between distinct polylines — the structural
  // condition for a "you can't tell which trace is which" tuck.
  type AxialSeg = {
    horiz: boolean;
    fixed: number;
    lo: number;
    hi: number;
  };
  const axialsOf: AxialSeg[][] = polys.map(() => []);
  for (let pi = 0; pi < polys.length; pi++) {
    const pts = polys[pi]!.points;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1]!;
      const b = pts[k]!;
      if (a.x === b.x && a.y !== b.y) {
        axialsOf[pi]!.push({
          horiz: false,
          fixed: a.x,
          lo: Math.min(a.y, b.y),
          hi: Math.max(a.y, b.y),
        });
      } else if (a.y === b.y && a.x !== b.x) {
        axialsOf[pi]!.push({
          horiz: true,
          fixed: a.y,
          lo: Math.min(a.x, b.x),
          hi: Math.max(a.x, b.x),
        });
      }
    }
  }

  const addIntersection = (
    polyIdx: number,
    bendIdx: number,
    p: Point,
    tier: "primary" | "secondary",
  ) => {
    let list = result.get(polyIdx);
    if (!list) {
      list = [];
      result.set(polyIdx, list);
    }
    if (list.some((it) => it.bendIdx === bendIdx && it.point.x === p.x && it.point.y === p.y)) {
      return;
    }
    list.push({ bendIdx, point: { x: p.x, y: p.y }, tier });
  };

  // For an axial overlap to read as a "tuck", we need to mark the
  // bend on each polyline whose endpoint lies at the overlap. Helper:
  // find the bend on `polyIdx` whose chamferStart or chamferEnd sits
  // at the overlap boundary on the shared axis.
  const findBendAtOverlap = (
    polyIdx: number,
    horiz: boolean,
    fixed: number,
    lo: number,
    hi: number,
  ): { bendIdx: number; point: Point } | undefined => {
    const bends = bendsOf[polyIdx]!;
    for (let bIdx = 0; bIdx < bends.length; bIdx++) {
      const b = bends[bIdx]!;
      const cs = b.lumpPoints[1]!;
      const ce = b.lumpPoints[b.lumpPoints.length - 2]!;
      for (const ep of [cs, ce]) {
        if (horiz && ep.y === fixed && ep.x >= lo && ep.x <= hi) {
          return { bendIdx: bIdx, point: { x: ep.x, y: ep.y } };
        }
        if (!horiz && ep.x === fixed && ep.y >= lo && ep.y <= hi) {
          return { bendIdx: bIdx, point: { x: ep.x, y: ep.y } };
        }
      }
    }
    return undefined;
  };

  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      // 1) Exact chamfer-point equality (canonical hwy exit interlock).
      if (chamferPointsOf[i]!.length > 0 && chamferPointsOf[j]!.length > 0) {
        for (const pi of chamferPointsOf[i]!) {
          for (const pj of chamferPointsOf[j]!) {
            if (pi.x !== pj.x || pi.y !== pj.y) continue;
            addIntersection(i, pi.bendIdx, { x: pi.x, y: pi.y }, "primary");
            addIntersection(j, pj.bendIdx, { x: pj.x, y: pj.y }, "secondary");
          }
        }
      }
      // 2) Collinear axial-segment overlap. When two polylines draw
      //    on the same gridline over a shared coordinate range, the
      //    eye literally cannot tell which trace is which. Mark the
      //    bend on each polyline whose endpoint sits at the overlap.
      for (const si of axialsOf[i]!) {
        for (const sj of axialsOf[j]!) {
          if (si.horiz !== sj.horiz) continue;
          if (si.fixed !== sj.fixed) continue;
          const lo = Math.max(si.lo, sj.lo);
          const hi = Math.min(si.hi, sj.hi);
          if (hi <= lo) continue; // touching at a single point doesn't count
          const bi = findBendAtOverlap(i, si.horiz, si.fixed, lo, hi);
          const bj = findBendAtOverlap(j, sj.horiz, sj.fixed, lo, hi);
          if (!bi || !bj) continue;
          addIntersection(i, bi.bendIdx, bi.point, "primary");
          addIntersection(j, bj.bendIdx, bj.point, "secondary");
        }
      }
    }
  }
  return result;
}

/** Look up a bend by index for use by the renderer when splitting a trace. */
export function bendInfoAt(poly: Polyline, bendIdx: number): BendInfo | undefined {
  const bends = findBendCenters(poly.points);
  return bends[bendIdx];
}

function renderEdge(
  edge: ModelEdge,
  poly: Polyline,
  theme: Theme,
  overrides: TagRule,
  intersections: BendIntersection[],
): string {
  if (poly.points.length < 2) return "";
  // Tag overrides win over theme defaults (DESIGN-PHASE5 §5.2):
  // trace colour, trace width, dash, opacity.
  const baseStroke = edge.isBackEdge
    ? theme.tokens["trace-muted"]
    : theme.tokens["trace-default"];
  const stroke = overrides.trace !== undefined
    ? resolveColour(theme, overrides.trace)
    : baseStroke;
  const strokeWidth = overrides["trace-width"] ?? theme.strokes.trace;
  let dashAttr = "";
  if (overrides.dash !== undefined) {
    if (overrides.dash !== null) {
      dashAttr = ` stroke-dasharray="${overrides.dash.join(" ")}"`;
    }
  } else if (edge.isBackEdge) {
    dashAttr = ` stroke-dasharray="${theme.strokes.dash["back-edge"].join(" ")}"`;
  }
  const opacityAttr = overrides.opacity !== undefined
    ? ` opacity="${overrides.opacity}"`
    : "";
  // First half of a via-pair (source -> highway): no arrowhead, since
  // the visible trace continues into the second half. Also: the theme
  // may opt out of arrows entirely (schematic style).
  const arrowsOn = theme.strokes.arrow["head-shape"] !== "none";
  const arrow = arrowsOn && !edge.viaFirstHalf ? ' marker-end="url(#arrow)"' : "";
  const lineCommon = `fill="none" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}`;

  // Fast path: no bend intersections, emit one solid trace path.
  if (intersections.length === 0) {
    const d = polylineD(poly.points);
    return [
      `<g data-edge="${escapeAttr(edge.from)}->${escapeAttr(edge.to)}"${opacityAttr}>`,
      `  <path d="${d}" stroke="${stroke}" ${lineCommon}${arrow}/>`,
      `</g>`,
    ].join("\n");
  }

  // Bend-intersection path: paint the gradient on the CHAMFER ITSELF
  // (plus ~BEND_LUMP_HALF px of each adjoining leg). The gradient is
  // symmetric — default at both ends, peak (ink-primary) at the chamfer
  // midpoint — so the corner reads as a curve highlight rather than a
  // directional tail. The lump sub-path is built from bend.lumpPoints,
  // which already includes the chamfer's internal points and pre-walks
  // BEND_LUMP_HALF px back into each adjoining leg, so polylineD on
  // lumpPoints reproduces the bend's exact Bezier geometry.
  const parts: string[] = [
    `<g data-edge="${escapeAttr(edge.from)}->${escapeAttr(edge.to)}"${opacityAttr}>`,
  ];
  if (intersections.length === 1) {
    const { bendIdx, point: ip, tier } = intersections[0]!;
    // Secondary (upper) trace gets a longer lump so its lighter
    // gradient has more room to read; primary stays tight so it
    // doesn't pull the eye away from the corner itself.
    const lumpHalf = tier === "secondary" ? BEND_LUMP_HALF * 2 : BEND_LUMP_HALF;
    const bends = findBendCenters(poly.points, lumpHalf);
    const bend = bends[bendIdx];
    if (bend) {
      const lumpStart = bend.lumpPoints[0]!;
      const lumpEnd = bend.lumpPoints[bend.lumpPoints.length - 1]!;
      const prePts = pointsUpToCut(poly.points, lumpStart);
      const lumpD = polylineD(bend.lumpPoints);
      const postPts = pointsFromCut(poly.points, lumpEnd);
      const preD = prePts.length >= 2 ? polylineD(prePts) : "";
      const postD = postPts.length >= 2 ? polylineD(postPts) : "";
      // Peak position: project `ip` onto the line lumpStart→lumpEnd
      // and use that fraction as the gradient stop. This lands the
      // peak AT the actual intersection point — i.e. at the corner
      // where the two traces overlap — rather than at the lump's
      // geometric midpoint.
      const peakFrac = projectFraction(lumpStart, lumpEnd, ip);
      // Tier picks peak colour. Primary blends ink-secondary toward
      // trace-default so the darker accent doesn't dominate the corner;
      // secondary uses trace-muted (just a hair darker than default).
      const defaultC = theme.tokens["trace-default"];
      const peak = tier === "primary"
        ? mixHex(theme.tokens["ink-secondary"], defaultC, 0.5)
        : theme.tokens["trace-muted"];
      const gradId = `bf-${escapeAttr(edge.from)}-${escapeAttr(edge.to)}-${fmt(bend.centre.x)}-${fmt(bend.centre.y)}`.replace(/[^a-zA-Z0-9_-]/g, "-");
      const peakStop = Math.round(peakFrac * 100);
      parts.push(
        `  <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="${fmt(lumpStart.x)}" y1="${fmt(lumpStart.y)}" x2="${fmt(lumpEnd.x)}" y2="${fmt(lumpEnd.y)}">` +
          `<stop offset="0%" stop-color="${defaultC}"/>` +
          `<stop offset="${peakStop}%" stop-color="${peak}"/>` +
          `<stop offset="100%" stop-color="${defaultC}"/>` +
          `</linearGradient>`,
      );
      if (preD) {
        parts.push(`  <path d="${preD}" stroke="${stroke}" ${lineCommon}/>`);
      }
      const lumpHasArrow = !postD;
      parts.push(
        `  <path d="${lumpD}" stroke="url(#${gradId})" ${lineCommon}${lumpHasArrow ? arrow : ""}/>`,
      );
      if (postD) {
        parts.push(`  <path d="${postD}" stroke="${stroke}" ${lineCommon}${arrow}/>`);
      }
      parts.push(`</g>`);
      return parts.join("\n");
    }
  }
  // Fallback: solid stroke.
  const d = polylineD(poly.points);
  parts.push(
    `  <path d="${d}" stroke="${stroke}" ${lineCommon}${arrow}/>`,
  );
  parts.push(`</g>`);
  return parts.join("\n");
}

/**
 * Return the prefix of `pts` up to and including `cut`, where `cut`
 * may be a vertex OR lie on an axial segment between two consecutive
 * vertices. In the latter case, the segment is split and `cut` becomes
 * the final point of the prefix.
 */
function pointsUpToCut(pts: Point[], cut: Point): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (p.x === cut.x && p.y === cut.y) {
      out.push(p);
      return out;
    }
    out.push(p);
    if (i + 1 < pts.length) {
      const next = pts[i + 1]!;
      if (pointOnAxialSegment(p, next, cut)) {
        out.push(cut);
        return out;
      }
    }
  }
  return out;
}

/**
 * Return the suffix of `pts` starting at `cut`. Symmetric to
 * pointsUpToCut: handles `cut` either at a vertex or mid-segment.
 */
function pointsFromCut(pts: Point[], cut: Point): Point[] {
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (p.x === cut.x && p.y === cut.y) {
      return pts.slice(i);
    }
    if (i + 1 < pts.length) {
      const next = pts[i + 1]!;
      if (pointOnAxialSegment(p, next, cut)) {
        return [cut, ...pts.slice(i + 1)];
      }
    }
  }
  return [];
}

/**
 * Linearly interpolate between two `#rrggbb` colours by `t` ∈ [0,1].
 * t=0 returns `a`, t=1 returns `b`. Used to soften gradient peak
 * stops by mixing a theme token with the trace's default colour.
 */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 0xff;
  const ag = (pa >> 8) & 0xff;
  const ab = pa & 0xff;
  const br = (pb >> 16) & 0xff;
  const bg = (pb >> 8) & 0xff;
  const bb = pb & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Project `q` onto the line through `a` and `b`, returning its
 * fractional position along the segment (0 = at a, 1 = at b). Clamps
 * to [0, 1]. Used to place a gradient peak stop AT a specific point
 * along a linearGradient's vector — the projection works correctly
 * for both axial gradients (e.g. lumpStart and lumpEnd colinear) and
 * diagonal ones (the L-shaped lump case).
 */
function projectFraction(a: Point, b: Point, q: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  const t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2;
  return Math.max(0, Math.min(1, t));
}

/**
 * True iff `q` lies strictly between `a` and `b` on an axis-aligned
 * segment (same x or same y).
 */
function pointOnAxialSegment(a: Point, b: Point, q: Point): boolean {
  if (a.x === b.x && q.x === a.x) {
    return (q.y > a.y && q.y < b.y) || (q.y > b.y && q.y < a.y);
  }
  if (a.y === b.y && q.y === a.y) {
    return (q.x > a.x && q.x < b.x) || (q.x > b.x && q.x < a.x);
  }
  return false;
}

function renderPathHighlight(poly: Polyline, colour: string, width: number): string {
  const d = polylineD(poly.points);
  return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>`;
}

/**
 * Emit the path's `d=` attribute. The polyline builder produces 45°
 * chamfered bends: a short diagonal segment between two axis-aligned
 * segments. We render the diagonal as a small quadratic-Bezier arc
 * tucked into the right-angle corner, so each bend reads as a smooth
 * rounded corner while every other segment stays dead-straight.
 *
 * Chamfer pattern in `points` (5-point form, what the polyline emitter
 * produces): [..., A, M, B, ...] where A→M and M→B are equal-length
 * diagonal sub-segments tracing a 45° chamfer of side ~COMB_PITCH/2.
 * The right-angle corner is the intersection of the axis-aligned
 * segment continuing from `before A` and the axis-aligned segment
 * starting at B.
 *
 * Rendered as: L to A, Q corner B (quadratic with control = corner),
 * resume L from B. The Q's arc tangent matches the axis at A and B,
 * so the transition is smooth.
 */
/**
 * Emit the path's `d=` attribute. The polyline builder produces 45°
 * chamfered bends: a small diagonal segment (or two collinear diagonal
 * sub-segments) sandwiched between two axis-aligned segments. We
 * replace the diagonal with a small quadratic-Bezier arc whose
 * control point is the implicit right-angle corner — so each bend
 * reads as a smooth rounded corner while every other segment stays
 * dead-straight.
 *
 * Two chamfer point-patterns occur in practice:
 *   - 3-point (axis, DIAG, axis): A → cur (diagonal) → B
 *   - 4-point (axis, DIAG, DIAG, axis): A → mid (diagonal) → B (diagonal)
 *     where the two diagonal sub-segments are collinear (same direction).
 *
 * For both, the rendered output is identical: an L up to the chamfer
 * entry, a Q via the right-angle corner to the chamfer exit, then L
 * onwards. The arc is tangent to both axis-aligned segments, so the
 * transition is smooth on both sides.
 *
 * Lone non-collinear diagonals (X-junction crossings) keep their L's.
 */
function polylineD(points: Point[]): string {
  if (points.length === 0) return "";
  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  let i = 1;
  while (i < points.length) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const isDiagonal = dx !== 0 && dy !== 0;
    if (isDiagonal) {
      // Detect chamfer end-point: the first axis-aligned point after
      // this diagonal. Handles both 3-point chamfers (single diagonal)
      // and 4-point chamfers (two collinear diagonals).
      const chamferEndIdx = findChamferEnd(points, i);
      if (chamferEndIdx >= i) {
        const chamferEnd = points[chamferEndIdx]!;
        // Determine whether this is a true 90° corner (incoming and
        // outgoing axials perpendicular) or a parallel-offset transition
        // (incoming and outgoing axials parallel, with the chamfer
        // bridging a small offset between them).
        const before = points[i - 1]!;
        const incomingPrev = i >= 2 ? points[i - 2]! : before;
        const outgoingNext = chamferEndIdx + 1 < points.length
          ? points[chamferEndIdx + 1]!
          : chamferEnd;
        const inHoriz = before.y === incomingPrev.y && before.x !== incomingPrev.x;
        const outHoriz = outgoingNext.y === chamferEnd.y && outgoingNext.x !== chamferEnd.x;
        const perpendicular = inHoriz !== outHoriz;

        // Look ahead: is the segment after `chamferEnd` a short axial
        // followed by another chamfer? That's an S-bend — render as
        // one cubic Bezier across both chamfers.
        const sBendInfo = detectSBend(points, i - 1, chamferEndIdx);
        if (sBendInfo) {
          d += ` C ${fmt(sBendInfo.cp1.x)} ${fmt(sBendInfo.cp1.y)} ${fmt(sBendInfo.cp2.x)} ${fmt(sBendInfo.cp2.y)} ${fmt(sBendInfo.end.x)} ${fmt(sBendInfo.end.y)}`;
          i = sBendInfo.endIdx + 1;
          continue;
        }

        if (perpendicular) {
          // True 90° corner: Q via the right-angle corner.
          const corner = chamferCorner(points, i - 1, chamferEnd);
          d += ` Q ${fmt(corner.x)} ${fmt(corner.y)} ${fmt(chamferEnd.x)} ${fmt(chamferEnd.y)}`;
        } else {
          // Parallel-offset transition (no right-angle corner). Render
          // as a smooth S using a cubic Bezier — control points sit on
          // the axis just past each chamfer endpoint so the curve
          // tangents match the incoming/outgoing axials. Looks like a
          // smooth lane-change instead of a 90° elbow.
          const midX = (before.x + chamferEnd.x) / 2;
          const midY = (before.y + chamferEnd.y) / 2;
          const cp1: Point = inHoriz
            ? { x: midX, y: before.y }
            : { x: before.x, y: midY };
          const cp2: Point = outHoriz
            ? { x: midX, y: chamferEnd.y }
            : { x: chamferEnd.x, y: midY };
          d += ` C ${fmt(cp1.x)} ${fmt(cp1.y)} ${fmt(cp2.x)} ${fmt(cp2.y)} ${fmt(chamferEnd.x)} ${fmt(chamferEnd.y)}`;
        }
        i = chamferEndIdx + 1;
        continue;
      }
      // Lone diagonal not part of a chamfer (e.g. X-junction crossing):
      // fall through to plain L.
    }
    d += ` L ${fmt(cur.x)} ${fmt(cur.y)}`;
    i++;
  }
  return d;
}

/**
 * Walk forward from `i` (the end-index of a diagonal segment from
 * points[i-1] to points[i]) through any further collinear-diagonal
 * sub-segments. Returns the index of the chamfer's exit point: the
 * last axis-aligned-bound point of the chamfer.
 *
 *   - Single-segment chamfer (3-point): returns `i`.
 *   - Multi-segment chamfer (4-point and beyond): returns the last
 *     collinear diagonal's end-index.
 *
 * Returns -1 if the chamfer isn't followed by an axis-aligned segment
 * (X-junction crossings or end-of-polyline) — caller falls back to L.
 */
function findChamferEnd(points: Point[], i: number): number {
  if (i >= points.length) return -1;
  const prev = points[i - 1]!;
  const cur = points[i]!;
  const sx = Math.sign(cur.x - prev.x);
  const sy = Math.sign(cur.y - prev.y);
  let j = i;
  // Extend through any further collinear diagonal sub-segments.
  while (j + 1 < points.length) {
    const a = points[j]!;
    const b = points[j + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const sameDiag = dx !== 0 && dy !== 0 &&
      Math.sign(dx) === sx && Math.sign(dy) === sy;
    if (!sameDiag) break;
    j++;
  }
  // Now confirm what follows j is axial (or j is the polyline end and
  // we treat the chamfer as terminating the polyline — but in that
  // case we'd rather emit L). Require an axial successor for a true
  // chamfer.
  if (j + 1 >= points.length) return -1;
  const a = points[j]!;
  const b = points[j + 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const axial = (dx === 0) !== (dy === 0);
  if (!axial) return -1;
  return j;
}

/**
 * Detect an "S-bend": two consecutive chamfers separated by a short
 * axial segment, like [diag1, short-axial, diag2]. The eye reads this
 * as one continuous transition; rendering each chamfer independently
 * with a straight stub between them creates a visible kink.
 *
 *   chamferStartIdx: index of the diagonal-entry point (the axis-aligned
 *     point where the FIRST chamfer started; = the point BEFORE
 *     points[i] in polylineD).
 *   firstChamferEndIdx: index of the axis-aligned point where the FIRST
 *     chamfer ended (returned by findChamferEnd).
 *
 * Returns the cubic Bezier control points + the polyline end-index to
 * skip past, or null if this isn't an S-bend pattern.
 */
function detectSBend(
  points: Point[],
  chamferStartIdx: number,
  firstChamferEndIdx: number,
): { cp1: Point; cp2: Point; end: Point; endIdx: number } | null {
  // Need: [start (axial), ...diag1..., mid1 (axial), mid2 (axial), ...diag2..., end (axial)]
  // where mid1→mid2 is a short axial segment.
  const mid1Idx = firstChamferEndIdx;
  const mid2Idx = firstChamferEndIdx + 1;
  if (mid2Idx >= points.length) return null;
  const mid1 = points[mid1Idx]!;
  const mid2 = points[mid2Idx]!;
  const midDx = mid2.x - mid1.x;
  const midDy = mid2.y - mid1.y;
  const midAxial = (midDx === 0) !== (midDy === 0);
  if (!midAxial) return null;
  // The middle segment must be short — we only want to merge tight
  // S-bends. Long axial segments between bends are intentional and
  // should be rendered as their own straight runs.
  const midLen = Math.abs(midDx) + Math.abs(midDy);
  if (midLen > 8) return null;
  // After mid2, expect another chamfer (one or more collinear diagonals).
  const secondChamferEndIdx = findChamferEnd(points, mid2Idx + 1);
  if (secondChamferEndIdx <= mid2Idx) return null;
  const end = points[secondChamferEndIdx]!;
  // The two control points are the right-angle corners of each chamfer.
  // Corner 1: intersection of axis-aligned incoming segment (ending at
  // `start`) extended, and the perpendicular axis through mid1.
  // Corner 2: perpendicular axis through mid2 + axis-aligned outgoing
  // segment (starting at `end`) extended.
  const cp1 = chamferCorner(points, chamferStartIdx, mid1);
  const cp2 = chamferCornerOutgoing(points, secondChamferEndIdx, mid2);
  return { cp1, cp2, end, endIdx: secondChamferEndIdx };
}

/**
 * Mirror of chamferCorner but for the OUTGOING chamfer: `to` is the
 * point inside the chamfer (mid2), and we look at the segment AFTER
 * `fromIdx` (the end of the chamfer) to determine which axis the
 * outgoing segment uses.
 */
function chamferCornerOutgoing(points: Point[], fromIdx: number, to: Point): Point {
  const from = points[fromIdx]!;
  if (fromIdx + 1 < points.length) {
    const afterFrom = points[fromIdx + 1]!;
    const outgoingHorizontal = afterFrom.y === from.y && afterFrom.x !== from.x;
    if (outgoingHorizontal) return { x: to.x, y: from.y };
    if (afterFrom.x === from.x && afterFrom.y !== from.y) {
      return { x: from.x, y: to.y };
    }
  }
  return { x: to.x, y: from.y };
}

/**
 * Compute the right-angle corner that the chamfer "rounds off". `from`
 * is the axis-aligned point where the chamfer entered (= prev of the
 * diagonal); `to` is the axis-aligned point where the chamfer exits.
 * The corner shares one coord with each: it's at (to.x, from.y) or
 * (from.x, to.y) depending on the incoming axis (read from the segment
 * BEFORE `from`).
 */
function chamferCorner(points: Point[], fromIdx: number, to: Point): Point {
  const from = points[fromIdx]!;
  if (fromIdx >= 1) {
    const beforeFrom = points[fromIdx - 1]!;
    const incomingHorizontal = beforeFrom.y === from.y && beforeFrom.x !== from.x;
    if (incomingHorizontal) return { x: to.x, y: from.y };
    if (beforeFrom.x === from.x && beforeFrom.y !== from.y) {
      return { x: from.x, y: to.y };
    }
  }
  // No clear prior axis (start of polyline or prior diagonal). Pick
  // the "natural" corner from the chamfer's own geometry — the corner
  // that lies on the outward side of the diagonal.
  return { x: to.x, y: from.y };
}

/**
 * Resolve a `path: a -> b -> c` chain to the actual polylines for the
 * edges connecting consecutive members. Each consecutive pair must
 * correspond to an edge in either direction (bind already verified
 * this with E_PATH_MISSING_EDGE); we look in both directions and
 * return whichever polyline matched.
 */
function pathSegments(
  chain: string[],
  edges: ModelEdge[],
  polys: Polyline[],
): Polyline[] {
  const out: Polyline[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    const idx = edges.findIndex(
      (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a),
    );
    if (idx < 0) continue;
    const poly = polys.find((p) => p.edgeIndex === idx);
    if (poly) out.push(poly);
  }
  return out;
}

function renderNode(
  n: ModelNode,
  b: BoxBounds,
  theme: Theme,
  overrides: TagRule,
  z: number = 0,
  iconRegistry?: IconRegistry,
  resolveFill?: (value: string) => string,
): string {
  // §11.13: nodes at z < 0 (underground) render faded to imply depth.
  // The fade amount scales with depth: z=-1 → 0.45 opacity, z=-2 → 0.30,
  // etc., bottoming out at 0.15 to keep faintly-readable text.
  //
  // A tag override `opacity:` takes priority over the depth-fade (the
  // author has explicitly said what they want).
  let opacityAttr = "";
  if (overrides.opacity !== undefined) {
    opacityAttr = ` opacity="${overrides.opacity}"`;
  } else if (z < 0) {
    opacityAttr = ` opacity="${Math.max(0.15, 0.45 + (z + 1) * 0.15).toFixed(2)}"`;
  }
  const groupOpen = `<g data-id="${escapeAttr(n.id)}"${z !== 0 ? ` data-z="${z}"` : ""}${opacityAttr}>`;
  // Highway nodes are routing-only — they reserve grid cells and shape
  // the bundle but have no visible mark. The bundle's actual traces are
  // self-evident; the dashed enclosure was redundant with them.
  if (n.shape === "highway") {
    return "";
  }
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const textColour = overrides.text !== undefined
    ? resolveColour(theme, overrides.text)
    : theme.tokens["ink-primary"];
  const textWeight = overrides["text-weight"];
  const textWeightAttr = textWeight !== undefined ? ` font-weight="${textWeight}"` : "";

  // For shapes that render the label OUTSIDE the glyph (icon, circle),
  // the text-fit pass has grown the cell to contain BOTH the glyph and
  // the label-below. `n.iconArea` records the original (pre-grow) cell
  // size the glyph should occupy. The glyph + label group is then
  // vertically centred inside the grown cell so top and bottom padding
  // are symmetric — arrows entering from above and leaving from below
  // have matching breathing room. Falling back to the full box bounds
  // keeps the math right when text-fit wasn't applied.
  let iconBounds: BoxBounds = b;
  if (n.iconArea) {
    const iconH = n.iconArea.height * CELL_PX;
    // labelGap = icon-bottom → label baseline. Matches the labelY
    // offset below (kept in sync — see the icon/circle render
    // branches further down).
    const labelGap = theme.typography.size.body * 0.9 + 4;
    // Visible descender extends ~0.2em below the baseline. The
    // label's ascender height is absorbed into labelGap (the
    // baseline-relative offset includes room for the cap-height),
    // so the group's *visible* bottom edge is just baseline + descender.
    const descender = theme.typography.size.body * 0.2;
    const groupH = iconH + labelGap + descender;
    const topInset = Math.max(0, (b.height - groupH) / 2);
    iconBounds = {
      x: b.x,
      y: b.y + topInset,
      width: b.width,
      height: iconH,
    };
  }

  // Optional border + background around icon-as-body / circle nodes
  // (DESIGN-PHASE5 border + gradient addenda). Per-node
  // `border: true|false` overrides the theme's `strokes.icon-border`
  // default. The rect wraps the full grown cell (b) so it contains
  // both the glyph and the label.
  //
  // Tag overrides apply the same way they would on a regular shape:
  //   - `border` → stroke colour (or gradient via resolveFill)
  //   - `border-width` → stroke width
  //   - `fill` → background fill (solid colour or `linear ...` gradient)
  //
  // When `fill` is set with no border, the rect still draws so the
  // background can show; we just omit the stroke. The 2px corner
  // radius matches `shape: rect`.
  const paintHere = resolveFill ?? ((v: string) => resolveColour(theme, v));
  const themeBorderDefault = theme.strokes["icon-border"] === "on";
  const drawIconBorder = n.border ?? themeBorderDefault;
  const iconBorderStroke = overrides.border !== undefined
    ? paintHere(overrides.border)
    : theme.tokens["border-strong"];
  const iconBorderWidth = overrides["border-width"] ?? theme.strokes.outline;
  let iconBorderDashAttr = "";
  if (overrides.dash !== undefined && overrides.dash !== null) {
    iconBorderDashAttr = ` stroke-dasharray="${overrides.dash.join(" ")}"`;
  }
  const iconBgFill = overrides.fill !== undefined && resolveFill
    ? resolveFill(overrides.fill)
    : undefined;
  let iconBorderRect = "";
  if (drawIconBorder) {
    const fillAttr = iconBgFill ?? "none";
    iconBorderRect = `  <rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" height="${fmt(b.height)}" rx="2" ry="2" fill="${fillAttr}" stroke="${iconBorderStroke}" stroke-width="${iconBorderWidth}"${iconBorderDashAttr}/>`;
  } else if (iconBgFill !== undefined) {
    // No border but fill set — draw a stroke-less background rect.
    iconBorderRect = `  <rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" height="${fmt(b.height)}" rx="2" ry="2" fill="${iconBgFill}"/>`;
  }

  // DESIGN-PHASE5-ICONS §2 — icon as the node body. Renders the icon
  // (or placeholder) at iconBounds; label sits below it within the
  // node's footprint. Tag-driven re-tint: `icon-color` is the
  // explicit tag-rule property for monochrome icons. Drives the
  // wrapping `<g>`'s `color` attribute so any element using
  // `currentColor` re-paints (works for both outlined and filled
  // styles — see DESIGN-PHASE5 icon-color addendum). Multi-colour
  // brand icons (literal `fill="#hex"`) ignore the override.
  if (n.shape === "icon") {
    const iconTint = overrides["icon-color"] !== undefined
      ? paintHere(overrides["icon-color"])
      : undefined;
    const iconBlock = renderIconAsBody(n, iconBounds, theme, iconRegistry, iconTint);
    const labelY = iconBounds.y + iconBounds.height + theme.typography.size.body * 0.9 + 4;
    return [
      groupOpen,
      ...(iconBorderRect ? [iconBorderRect] : []),
      `  ${iconBlock}`,
      `  <text x="${fmt(cx)}" y="${fmt(labelY)}" text-anchor="middle" dominant-baseline="alphabetic" fill="${textColour}"${textWeightAttr}>${labelContent(n.label, cx, "alphabetic")}</text>`,
      `</g>`,
    ].join("\n");
  }

  // Circles render their label BELOW the shape (BPMN/flowchart
  // convention for sources, sinks, and events — small markers with
  // adjacent text). The renderer reserves vertical room in
  // canvasBounds so the label doesn't clip.
  if (n.shape === "circle") {
    const labelY = iconBounds.y + iconBounds.height + theme.typography.size.body * 0.9 + 4;
    return [
      groupOpen,
      ...(iconBorderRect ? [iconBorderRect] : []),
      `  ${nodeShape(n.shape, iconBounds, theme, overrides, resolveFill)}`,
      `  <text x="${fmt(cx)}" y="${fmt(labelY)}" text-anchor="middle" dominant-baseline="alphabetic" fill="${textColour}"${textWeightAttr}>${labelContent(n.label, cx, "alphabetic")}</text>`,
      `</g>`,
    ].join("\n");
  }

  // DESIGN-PHASE5-ICONS §3 — badge form. If `icon:` set on a non-icon
  // shape, draw the badge between shape and label. Same tint rule as
  // the body form: tag-rule `icon-color` drives the badge's
  // monochrome tint.
  const badgeTint = overrides["icon-color"] !== undefined
    ? paintHere(overrides["icon-color"])
    : undefined;
  const badge = n.icon
    ? renderIconAsBadge(n, b, theme, iconRegistry, badgeTint)
    : "";

  return [
    groupOpen,
    `  ${nodeShape(n.shape, b, theme, overrides, resolveFill)}`,
    ...(badge ? [`  ${badge}`] : []),
    `  <text x="${fmt(cx)}" y="${fmt(cy)}" text-anchor="middle" dominant-baseline="central" fill="${textColour}"${textWeightAttr}>${labelContent(n.label, cx, "central")}</text>`,
    `</g>`,
  ].join("\n");
}

/**
 * Body-form helper — loads the icon and emits either the icon SVG or
 * the hatched placeholder, at the box's full pixel bounds.
 */
function renderIconAsBody(
  n: ModelNode,
  b: BoxBounds,
  theme: Theme,
  iconRegistry: IconRegistry | undefined,
  tint?: string,
): string {
  if (!n.icon || !iconRegistry) {
    return renderIconPlaceholder(b.x, b.y, b.width, b.height, theme, tint);
  }
  const loaded = loadIcon(iconRegistry, n.icon);
  if (!loaded) {
    return renderIconPlaceholder(b.x, b.y, b.width, b.height, theme, tint);
  }
  return renderIconBody(loaded, b.x, b.y, b.width, b.height, theme, tint);
}

/**
 * Badge-form helper — loads the icon and emits either the badge SVG or
 * a small hatched placeholder, placed per icon-position.
 */
function renderIconAsBadge(
  n: ModelNode,
  b: BoxBounds,
  theme: Theme,
  iconRegistry: IconRegistry | undefined,
  tint?: string,
): string {
  if (!n.icon || !iconRegistry) return "";
  const loaded = loadIcon(iconRegistry, n.icon);
  const position = n.iconPosition ?? "inline";
  if (!loaded) {
    // Small placeholder roughly where a badge would go.
    if (position === "corner") {
      const size = Math.min(24, Math.min(b.width, b.height) * 0.3);
      return renderIconPlaceholder(b.x + 4, b.y + 4, size, size, theme, tint);
    }
    const size = Math.min(16, Math.min(b.width, b.height) * 0.3);
    return renderIconPlaceholder(
      b.x + (b.width - size) / 2,
      b.y + (b.height - size) / 2,
      size,
      size,
      theme,
      tint,
    );
  }
  return renderIconBadge(loaded, b.x, b.y, b.width, b.height, position, undefined, theme, tint);
}

/**
 * Render an imported module's body inside a parent-frame `<g transform>`
 * (DESIGN-PHASE5-MODULES.md §11). The module's placed body
 * (`imported.body`) was produced by the per-module placement pass and
 * carries the placement, reservation, polylines, and the module's own
 * resolved theme.
 *
 * The body is rendered under the module's theme — palette and weights
 * stay local to the `<g>`. The parent's theme covers parent-level
 * chrome.
 *
 * Subset rendered at v1: nodes (regular shapes + recursive modules) and
 * edge polylines. Skipped at v1: nodesets-inside-modules, bend-
 * intersection gradients, via-pair through-segments, path highlights.
 * Real-world modules that need those are a Cut 9 follow-up.
 */
function renderModuleBody(
  imported: ImportedModule,
  parentBox: BoxBounds,
  parentTheme: Theme,
  opts: RenderOpts,
  parentIconRegistry: IconRegistry | undefined,
): string {
  const body = imported.body as ModulePlacedBody | undefined;
  if (body === undefined) return "";
  const subModel = imported.model;
  const subTheme = body.theme;

  // Center the module's local frame within the synthetic node's box
  // (the parent placer may have allocated a cell larger than the
  // module's pixel footprint because ceil() rounded up). The cross-
  // flow body offset (populated by applyModuleAlignment) shifts the
  // body inside its cell so flow-axis ports line up with connected
  // counterparts.
  const pixelWidth = imported.pixelWidth ?? body.routing.width;
  const pixelHeight = imported.pixelHeight ?? body.routing.height;
  const padX = Math.max(0, (parentBox.width - pixelWidth) / 2);
  const padY = Math.max(0, (parentBox.height - pixelHeight) / 2);
  const offX = imported.bodyOffsetX ?? 0;
  const offY = imported.bodyOffsetY ?? 0;
  const originX = parentBox.x + padX + offX;
  const originY = parentBox.y + padY + offY;

  // Build the sub-model's pixel layout + box bounds the same way the
  // top-level renderer does. We can't call renderSVG recursively
  // because it emits a full <svg> document; instead we replay the
  // node/edge emission loops inside our own <g>.
  const subLayout = computePixelLayout(body.placement);
  const subBoxes = boxBounds(subModel, body.placement, subLayout);

  // The icon registry is built per-render in the main entry; modules
  // may register their own packs. For v1, reuse the parent's registry
  // (which already includes any packs the parent imported).
  // TODO(Cut 9): if a module registers packs the parent doesn't know
  // about, build a per-module registry from `subModel.iconPacks`.
  const iconRegistry = parentIconRegistry;
  void opts;

  // Defs for any gradient paints in the sub-model. The module's body
  // is a self-contained context; its <linearGradient> defs live inside
  // its <defs>, so they don't conflict with parent gradient ids.
  const subDefs: string[] = [];
  const subFillResolver = createFillResolver(subTheme, subDefs);
  for (const n of subModel.nodes) {
    const o = resolveTags(subTheme, n.tags, `node '${n.id}' (module ${imported.alias})`);
    if (o.fill !== undefined) subFillResolver(o.fill);
    if (o.border !== undefined) subFillResolver(o.border);
    if (o["icon-color"] !== undefined) subFillResolver(o["icon-color"]);
  }

  const parts: string[] = [];
  parts.push(
    `<g data-module="${escapeAttr(imported.alias)}" transform="translate(${fmt(originX)} ${fmt(originY)})">`,
  );
  if (subDefs.length > 0) {
    parts.push(`<defs>${subDefs.join("")}</defs>`);
  }

  // DESIGN-PHASE5-MODULES.md §6 — optional module frame, opt-in via the
  // parent theme's `modules` block. Drawn FIRST so it sits behind the
  // body (the body's nodes/edges paint over the frame interior). The
  // frame's outer dimensions are pixelWidth x pixelHeight + padding on
  // each side.
  const modulesTheme = parentTheme.modules;
  if (modulesTheme !== undefined && modulesTheme.border !== undefined) {
    const pad = modulesTheme.padding ?? 0;
    const w = modulesTheme["border-width"] ?? 1.0;
    const borderColour = resolveColour(parentTheme, modulesTheme.border);
    let dashAttr = "";
    if (modulesTheme.dash !== undefined && modulesTheme.dash !== null) {
      dashAttr = ` stroke-dasharray="${modulesTheme.dash.join(" ")}"`;
    }
    parts.push(
      `<rect x="${fmt(-pad)}" y="${fmt(-pad)}" width="${fmt(pixelWidth + 2 * pad)}" height="${fmt(pixelHeight + 2 * pad)}" fill="none" stroke="${borderColour}" stroke-width="${w}"${dashAttr}/>`,
    );
    // Label, if requested.
    const labelPos = modulesTheme["label-position"];
    if (labelPos !== undefined && labelPos !== null) {
      const labelWeight = modulesTheme["label-weight"]
        ?? parentTheme.typography.weight.label;
      const labelSize = parentTheme.typography.size.frame;
      const labelY = -pad - 4;
      let labelX: number;
      let anchor: string;
      if (labelPos === "top-left") {
        labelX = -pad;
        anchor = "start";
      } else if (labelPos === "top-right") {
        labelX = pixelWidth + pad;
        anchor = "end";
      } else {
        labelX = pixelWidth / 2;
        anchor = "middle";
      }
      parts.push(
        `<text x="${fmt(labelX)}" y="${fmt(labelY)}" text-anchor="${anchor}" font-size="${labelSize}" font-weight="${labelWeight}" fill="${resolveColour(parentTheme, "ink-secondary")}">${escapeText(imported.alias)}</text>`,
      );
    }
  }

  // Internal edges (polylines) first so they sit behind boxes.
  for (let i = 0; i < body.routing.polylines.length; i++) {
    const poly = body.routing.polylines[i]!;
    const edge = subModel.edges[poly.edgeIndex];
    if (!edge) continue;
    const overrides = resolveTags(
      subTheme,
      edge.tags,
      `edge '${edge.from} -> ${edge.to}' (module ${imported.alias})`,
    );
    parts.push(renderEdge(edge, poly, subTheme, overrides, []));
  }

  // Internal nodes. Recurse into nested modules — Cut 5 supports
  // module-of-modules because `placeModules` already handled them
  // recursively and they have their own body on `imported.body`.
  const nodeOrder = subModel.nodes
    .map((n, i) => {
      const cellZ = body.placement.cells.get(n.id)?.z ?? 0;
      const renderZ = n.shape === "highway" ? cellZ : 0;
      return { n, i, renderZ };
    })
    .sort((a, b) => a.renderZ - b.renderZ || a.i - b.i);
  for (const { n, renderZ } of nodeOrder) {
    const b = subBoxes.get(n.id);
    if (!b) continue;
    if (n.shape === "module") {
      const nestedImport = subModel.imports.find((m) => m.alias === n.id);
      if (nestedImport !== undefined && nestedImport.body !== undefined) {
        const cell = body.placement.cells.get(n.id);
        const cellRect = cell
          ? {
              x: subLayout.colX[cell.col]!,
              y: subLayout.rowY[cell.row]!,
              width: subLayout.colWidthPx[cell.col]!,
              height: subLayout.rowHeightPx[cell.row]!,
            }
          : b;
        parts.push(
          renderModuleBody(nestedImport, cellRect, subTheme, opts, iconRegistry),
        );
      }
      continue;
    }
    const overrides = resolveTags(subTheme, n.tags, `node '${n.id}' (module ${imported.alias})`);
    parts.push(renderNode(n, b, subTheme, overrides, renderZ, iconRegistry, subFillResolver));
  }

  // Edge labels last, so they sit on top of the polylines they label.
  for (let i = 0; i < body.routing.polylines.length; i++) {
    const poly = body.routing.polylines[i]!;
    const edge = subModel.edges[poly.edgeIndex];
    if (!edge || !edge.label) continue;
    parts.push(renderEdgeLabel(edge, poly, subTheme));
  }

  parts.push(`</g>`);
  return parts.join("");
}

function nodeShape(
  shape: ShapeName,
  b: BoxBounds,
  theme: Theme,
  overrides: TagRule,
  resolvePaint?: (value: string) => string,
): string {
  // `resolvePaint` handles either fills or strokes: solid colours
  // round-trip via resolveColour; gradient strings register a
  // <linearGradient> def and return a url(...) reference.
  const paint = resolvePaint ?? ((v) => resolveColour(theme, v));
  const fill = overrides.fill !== undefined
    ? paint(overrides.fill)
    : theme.tokens["surface-raised"];
  const stroke = overrides.border !== undefined
    ? paint(overrides.border)
    : theme.tokens["border-strong"];
  const sw = overrides["border-width"] ?? theme.strokes.outline;
  // Border-dash: `null` clears any dash (always solid); `array` sets a
  // dash; undefined means "no dash" for non-highway boxes (which is the
  // theme default anyway). Highways are dashed by their own code path.
  let dashAttr = "";
  if (overrides.dash !== undefined && overrides.dash !== null) {
    dashAttr = ` stroke-dasharray="${overrides.dash.join(" ")}"`;
  }
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dashAttr}`;
  switch (shape) {
    case "rect":
      // Subtle 2px corner radius — still reads as a rectangle but
      // softens the silhouette to match the rounded trace bends.
      // `roundrect` (rx=8) remains visibly more pillowed.
      return `<rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" height="${fmt(b.height)}" rx="2" ry="2" ${common}/>`;
    case "roundrect":
      return `<rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" height="${fmt(b.height)}" rx="8" ry="8" ${common}/>`;
    case "circle": {
      const r = Math.min(b.width, b.height) / 2;
      return `<circle cx="${fmt(b.x + b.width / 2)}" cy="${fmt(b.y + b.height / 2)}" r="${fmt(r)}" ${common}/>`;
    }
    case "diamond": {
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const points = `${fmt(cx)},${fmt(b.y)} ${fmt(b.x + b.width)},${fmt(cy)} ${fmt(cx)},${fmt(b.y + b.height)} ${fmt(b.x)},${fmt(cy)}`;
      return `<polygon points="${points}" ${common}/>`;
    }
    case "cylinder": {
      const rx = b.width / 2;
      const ry = Math.min(10, b.height / 4);
      const top = b.y + ry;
      const bottom = b.y + b.height - ry;
      const outline = [
        `M ${fmt(b.x)} ${fmt(top)}`,
        `A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(b.x + b.width)} ${fmt(top)}`,
        `L ${fmt(b.x + b.width)} ${fmt(bottom)}`,
        `A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(b.x)} ${fmt(bottom)}`,
        `Z`,
      ].join(" ");
      const backArc = [
        `M ${fmt(b.x)} ${fmt(top)}`,
        `A ${fmt(rx)} ${fmt(ry)} 0 0 0 ${fmt(b.x + b.width)} ${fmt(top)}`,
      ].join(" ");
      const backStroke = theme.tokens["border-subtle"];
      return (
        `<path d="${outline}" ${common}/>` +
        `<path d="${backArc}" fill="none" stroke="${backStroke}" stroke-width="${sw}"${dashAttr}/>`
      );
    }
    case "highway":
      // Highways render nothing; renderNode returns "" before calling
      // nodeShape for them. Returning "" here is defensive in case a
      // future caller invokes nodeShape directly on a highway.
      return "";
    case "module":
      // Modules emit their own <g> structure in renderModuleBody; the
      // node-shape dispatch never reaches this case in practice because
      // the main render loop intercepts shape: module before calling
      // renderNode → nodeShape. Defensive empty.
      return "";
    case "icon":
      // Icon-as-body is rendered by renderIconAsBody, intercepted in
      // renderNode before reaching nodeShape. Defensive empty (same
      // reasoning as module).
      return "";
    default: {
      const _exhaustive: never = shape;
      void _exhaustive;
      return "";
    }
  }
}

/**
 * Label placement: pick the longest straight segment of the polyline
 * and place the label above (for horizontal segments) or to the right
 * (for vertical). A halo in the surface colour drawn underneath keeps
 * it readable when crossing other edges (works in both light and dark
 * themes — the halo is always whatever colour the canvas is).
 */
function renderEdgeLabel(edge: ModelEdge, poly: Polyline, theme: Theme): string {
  if (edge.label === undefined) return "";
  const seg = longestStraightSegment(poly.points);
  if (!seg) return "";
  const midX = (seg.a.x + seg.b.x) / 2;
  const midY = (seg.a.y + seg.b.y) / 2;
  const horizontal = seg.a.y === seg.b.y;

  let x: number, y: number, anchor: string, baseline: string;
  if (horizontal) {
    x = midX;
    y = midY - LABEL_OFFSET;
    anchor = "middle";
    baseline = "alphabetic";
  } else {
    x = midX + LABEL_OFFSET;
    y = midY;
    anchor = "start";
    baseline = "central";
  }

  const txt = labelContent(edge.label!, x, baseline === "central" ? "central" : "alphabetic");
  const halo = theme.tokens["label-halo"];
  const ink = theme.tokens["ink-secondary"];
  const size = theme.typography.size.edge;
  const common = `x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-size="${size}"`;
  return [
    `<g data-edge-label="${escapeAttr(edge.from)}->${escapeAttr(edge.to)}">`,
    `  <text ${common} fill="${halo}" stroke="${halo}" stroke-width="3" stroke-linejoin="round">${txt}</text>`,
    `  <text ${common} fill="${ink}">${txt}</text>`,
    `</g>`,
  ].join("\n");
}

interface SegmentRef {
  a: Point;
  b: Point;
  length: number;
}

function longestStraightSegment(poly: Point[]): SegmentRef | null {
  let best: SegmentRef | null = null;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    // Skip non-axis-aligned (chamfer / X-junction diagonal) segments —
    // the label is awkward to place along a 45° edge and the orthogonal
    // segments tend to be longer anyway.
    if (a.x !== b.x && a.y !== b.y) continue;
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (best === null || len > best.length) best = { a, b, length: len };
  }
  return best;
}

export function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

export function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render label content for a `<text>` element, handling `\n` line breaks.
 * SVG ignores newlines inside `<text>`, so multi-line labels need
 * `<tspan>` elements each at the original x with a `dy` line-height.
 *
 * - Single-line labels: returns the escaped text untouched.
 * - Multi-line labels: emits one `<tspan>` per line. The first sits at
 *   `dy=0`; subsequent lines step by `lineHeight` em. The caller's
 *   `text-anchor` and `y` are inherited — `x` is restated per `<tspan>`
 *   so each line wraps back to the same horizontal position.
 * - For `dominant-baseline="central"` labels (the common in-box case),
 *   the block is shifted up by half its total height so the visual
 *   centre of the multi-line block sits on the original `y`.
 */
function labelContent(
  s: string,
  x: number,
  baseline: "central" | "alphabetic" = "central",
  lineHeightEm = 1.15,
): string {
  if (!s.includes("\n")) return escapeText(s);
  const lines = s.split("\n");
  const xs = fmt(x);
  const n = lines.length;
  // For central baseline, shift the block up so its visual centre aligns
  // with the original y. For alphabetic baseline (e.g. icon-below labels),
  // the original y is the baseline of the FIRST line, so just stack down.
  const firstDy = baseline === "central"
    ? `${(-(n - 1) * lineHeightEm) / 2}em`
    : "0em";
  return lines
    .map((line, i) =>
      i === 0
        ? `<tspan x="${xs}" dy="${firstDy}">${escapeText(line)}</tspan>`
        : `<tspan x="${xs}" dy="${lineHeightEm}em">${escapeText(line)}</tspan>`,
    )
    .join("");
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// resolveColour is re-exported so future callers (e.g. tag-rule
// application in Step 7) can reuse the same resolution logic.
export { resolveColour };
