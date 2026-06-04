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
import type { Model, ModelEdge, ModelNode } from "../bind/model.js";
import type { ShapeName } from "../parser/ast.js";
import type { Placement } from "../layout/placement.js";
import type { Reservation } from "../layout/corridors.js";
import { CELL_PX } from "../layout/corridors.js";
import type { Point, Polyline, Polylines } from "../layout/polyline.js";
import type { TagRule, Theme } from "../theme/theme.js";
import { resolveColour, resolveTags } from "../theme/theme.js";
import { buildLegend, renderLegend, type LegendLayout } from "./legend.js";

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

/**
 * Pure function: same inputs → same SVG byte-for-byte. The Theme is part
 * of the input contract: re-rendering with a different Theme gives a
 * different SVG, with no other change.
 */
export function renderSVG(
  model: Model,
  placement: Placement,
  reservation: Reservation,
  polylines: Polylines,
  theme: Theme,
): string {
  const layout = pixelLayout(placement, reservation);
  const boxes = boxBounds(model, placement, layout);

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
    const overrides = resolveTags(theme, n.tags, `node '${n.id}'`);
    parts.push(renderNode(n, b, theme, overrides, renderZ));
  }

  for (let i = 0; i < polylines.polylines.length; i++) {
    const poly = polylines.polylines[i]!;
    const edge = model.edges[poly.edgeIndex];
    if (!edge || !edge.label) continue;
    parts.push(renderEdgeLabel(edge, poly, theme));
  }

  parts.push(`</g>`);
  if (legendLayout) {
    parts.push(renderLegend(legendLayout, legendOriginX, legendOriginY, theme));
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
  polylines: Polylines,
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

/**
 * Per-row / per-col pixel positions. Mirrors the computation inside
 * polyline.ts so the renderer can place boxes and nodeset rectangles
 * at the same pixel coords as the polyline waypoints.
 */
interface PixelLayout {
  colX: number[];
  rowY: number[];
  colWidthPx: number[];
  rowHeightPx: number[];
}

function pixelLayout(placement: Placement, reservation: Reservation): PixelLayout {
  const colWidthPx = placement.colUnits.map((u) => u * CELL_PX);
  const rowHeightPx = placement.rowUnits.map((u) => u * CELL_PX);
  const colX: number[] = [];
  let x = reservation.colGutterUnits[0]! * CELL_PX;
  for (let c = 0; c < placement.colUnits.length; c++) {
    colX.push(x);
    x += colWidthPx[c]!;
    x += reservation.colGutterUnits[c + 1]! * CELL_PX;
  }
  const rowY: number[] = [];
  let y = reservation.rowGutterUnits[0]! * CELL_PX;
  for (let r = 0; r < placement.rowUnits.length; r++) {
    rowY.push(y);
    y += rowHeightPx[r]!;
    y += reservation.rowGutterUnits[r + 1]! * CELL_PX;
  }
  return { colX, rowY, colWidthPx, rowHeightPx };
}

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
    // Center smaller boxes within their containing row/col (DESIGN
    // §2.4 — "Smaller boxes in a tall row are aligned to the row's
    // centre line"). The slot-port computation in polyline.ts uses the
    // same offset so the polylines terminate at the centered box face.
    out.set(id, {
      x: layout.colX[cell.col]! + (layout.colWidthPx[cell.col]! - width) / 2,
      y: layout.rowY[cell.row]! + (layout.rowHeightPx[cell.row]! - height) / 2,
      width,
      height,
    });
  }
  return out;
}

// --- pieces ---------------------------------------------------------------

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
    // Same width heuristic the text-fit pass uses, kept in sync via a
    // local copy (cheap to reuse the import would create a cycle).
    const halfWidth = estimateLabelWidthPx(n.label, fontSize) / 2;
    out.push({
      x: cx,
      y0: b.y + b.height,
      y1: labelY + fontSize * 0.3, // descender room
      halfWidth,
    });
  }
  return out;
}

/**
 * Pixel-width estimate for a label at `fontSize`. Mirrors the text-fit
 * pass's heuristic — keep these two in sync. Used here only for canvas
 * expansion (circle labels rendered below the shape).
 */
function estimateLabelWidthPx(label: string, fontSize: number): number {
  let units = 0;
  for (const ch of label) {
    if (/[A-Z]/.test(ch)) units += 1.4;
    else if (ch === " " || /[iljt!.,;:'`|]/.test(ch)) units += 0.4;
    else units += 1;
  }
  return units * fontSize * 0.6;
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
  // Circles render their label BELOW the shape (BPMN/flowchart
  // convention for sources, sinks, and events — small markers with
  // adjacent text). The renderer reserves vertical room in
  // canvasBounds so the label doesn't clip.
  if (n.shape === "circle") {
    const labelY = b.y + b.height + theme.typography.size.body * 0.9 + 4;
    return [
      groupOpen,
      `  ${nodeShape(n.shape, b, theme, overrides)}`,
      `  <text x="${fmt(cx)}" y="${fmt(labelY)}" text-anchor="middle" dominant-baseline="alphabetic" fill="${textColour}"${textWeightAttr}>${escapeText(n.label)}</text>`,
      `</g>`,
    ].join("\n");
  }
  return [
    groupOpen,
    `  ${nodeShape(n.shape, b, theme, overrides)}`,
    `  <text x="${fmt(cx)}" y="${fmt(cy)}" text-anchor="middle" dominant-baseline="central" fill="${textColour}"${textWeightAttr}>${escapeText(n.label)}</text>`,
    `</g>`,
  ].join("\n");
}

function nodeShape(
  shape: ShapeName,
  b: BoxBounds,
  theme: Theme,
  overrides: TagRule,
): string {
  const fill = overrides.fill !== undefined
    ? resolveColour(theme, overrides.fill)
    : theme.tokens["surface-raised"];
  const stroke = overrides.border !== undefined
    ? resolveColour(theme, overrides.border)
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
      const d = [
        `M ${fmt(b.x)} ${fmt(top)}`,
        `A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(b.x + b.width)} ${fmt(top)}`,
        `L ${fmt(b.x + b.width)} ${fmt(bottom)}`,
        `A ${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(b.x)} ${fmt(bottom)}`,
        `Z`,
        `M ${fmt(b.x)} ${fmt(top)}`,
        `A ${fmt(rx)} ${fmt(ry)} 0 0 0 ${fmt(b.x + b.width)} ${fmt(top)}`,
      ].join(" ");
      return `<path d="${d}" ${common} fill-rule="evenodd"/>`;
    }
    case "highway":
      // Highways render nothing; renderNode returns "" before calling
      // nodeShape for them. Returning "" here is defensive in case a
      // future caller invokes nodeShape directly on a highway.
      return "";
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

  const txt = escapeText(edge.label!);
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

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// resolveColour is re-exported so future callers (e.g. tag-rule
// application in Step 7) can reuse the same resolution logic.
export { resolveColour };
