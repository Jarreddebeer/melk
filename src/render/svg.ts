/**
 * Phase 4 renderer (Step 8).
 *
 * Inputs: the four upstream products (Model, Placement, Reservation,
 * Polylines). Output: an SVG string ready to write to disk.
 *
 * This is the final stage of the pipeline (DESIGN-PHASE4.md §7). It does
 * not compute geometry — the placer, corridor reserver, track packer,
 * and polyline builder have already produced the pixel waypoints, slot
 * positions, gutter widths, and X-junction materialisations. The
 * renderer's job is purely: assemble SVG primitives in the right layer
 * order, apply the canonical visual style, and emit text.
 *
 * Layer order, back to front (per §6.5 and feedback-circuit-board-metaphor):
 *   1. background
 *   2. nodeset bounding rectangles (dashed, behind everything else)
 *   3. polylines (forward edges + back-edges)
 *   4. path highlights (thicker coloured overlay on the polylines they touch)
 *   5. boxes (per-shape SVG primitive)
 *   6. node labels
 *   7. edge labels with a white halo
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

// --- canonical style ------------------------------------------------------

const FONT_FAMILY = "Inter, -apple-system, Segoe UI, Roboto, sans-serif";
const FONT_SIZE = 13;
const EDGE_LABEL_SIZE = 11;
const NODESET_LABEL_SIZE = 11;

const BG_FILL = "#ffffff";

const BOX_FILL = "#f7f9fc";
const BOX_STROKE = "#2b3340";
const BOX_STROKE_WIDTH = 1.5;
const TEXT = "#1a1f2b";

const EDGE_STROKE = "#3a4658";
const EDGE_WIDTH = 1.5;
const BACK_EDGE_DASH = "5 3";

// §11.11: underground trace stretch (interior of a `render: underground`
// highway) renders at half opacity and thinner to imply depth. Manholes
// at the perimeter are filled circles in the trace stroke colour.
const UNDERGROUND_OPACITY = 0.45;
const UNDERGROUND_WIDTH = 1;
const MANHOLE_RADIUS = 3;

const ARROW_LENGTH = 5;
const LABEL_OFFSET = 5;
const LABEL_HALO = "#ffffff";

const NODESET_STROKE = "#9fa9bb";
const NODESET_DASH = "4 3";
const NODESET_LABEL_FILL = "#5a6678";
const NODESET_PADDING = 6;

// Cycled across the diagram's `path` annotations in declaration order.
const PATH_COLOURS = [
  "#2b6cb0",
  "#c53030",
  "#2f855a",
  "#b7791f",
  "#553c9a",
  "#0987a0",
  "#9c4221",
  "#702459",
];
const PATH_WIDTH = 3.5;

// --- entry point ----------------------------------------------------------

/**
 * Pure function: same inputs → same SVG byte-for-byte.
 */
export function renderSVG(
  model: Model,
  placement: Placement,
  reservation: Reservation,
  polylines: Polylines,
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

  const canvas = canvasBounds(polylines, nodesetRects);
  const W = canvas.width;
  const H = canvas.height;
  const tx = -canvas.x;
  const ty = -canvas.y;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(W)} ${fmt(H)}" width="${fmt(W)}" height="${fmt(H)}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}">`,
  );
  parts.push(renderDefs());
  parts.push(`<rect width="${fmt(W)}" height="${fmt(H)}" fill="${BG_FILL}"/>`);
  parts.push(`<g transform="translate(${fmt(tx)} ${fmt(ty)})">`);

  for (const { name, rect } of nodesetRects) {
    parts.push(renderNodeset(name, rect));
  }

  for (let i = 0; i < polylines.polylines.length; i++) {
    const poly = polylines.polylines[i]!;
    const edge = model.edges[poly.edgeIndex];
    if (!edge) continue;
    parts.push(renderEdge(edge, poly));
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
    if (underground) {
      parts.push(
        `<g data-via-through="${orig}" data-underground="1">` +
          `<path d="M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(end.x)} ${fmt(end.y)}" fill="none" stroke="${EDGE_STROKE}" stroke-width="${UNDERGROUND_WIDTH}" stroke-opacity="${UNDERGROUND_OPACITY}" stroke-linecap="butt" stroke-linejoin="miter"/>` +
          `<circle cx="${fmt(start.x)}" cy="${fmt(start.y)}" r="${MANHOLE_RADIUS}" fill="${EDGE_STROKE}"/>` +
          `<circle cx="${fmt(end.x)}" cy="${fmt(end.y)}" r="${MANHOLE_RADIUS}" fill="${EDGE_STROKE}"/>` +
          `</g>`,
      );
    } else {
      parts.push(
        `<g data-via-through="${orig}"><path d="M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(end.x)} ${fmt(end.y)}" fill="none" stroke="${EDGE_STROKE}" stroke-width="${EDGE_WIDTH}" stroke-linecap="butt" stroke-linejoin="miter"/></g>`,
      );
    }
  }

  // Path highlights: lay coloured thick strokes on top of every polyline
  // that participates in the path's chain. A path "a -> b -> c" matches
  // either forward edges or back edges between consecutive members.
  for (let i = 0; i < model.paths.length; i++) {
    const path = model.paths[i]!;
    const colour = PATH_COLOURS[i % PATH_COLOURS.length]!;
    const segs = pathSegments(path.chain, model.edges, polylines.polylines);
    for (const seg of segs) {
      parts.push(renderPathHighlight(seg, colour));
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
    parts.push(renderNode(n, b, renderZ));
  }

  for (let i = 0; i < polylines.polylines.length; i++) {
    const poly = polylines.polylines[i]!;
    const edge = model.edges[poly.edgeIndex];
    if (!edge || !edge.label) continue;
    parts.push(renderEdgeLabel(edge, poly));
  }

  parts.push(`</g>`);
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
 * NODESET_LABEL_SIZE + 2 of extra headroom above the topmost nodeset.
 */
function canvasBounds(
  polylines: Polylines,
  nodesetRects: { name: string; rect: BoxBounds }[],
): BoxBounds {
  let minX = 0;
  let minY = 0;
  let maxX = polylines.width;
  let maxY = polylines.height;
  for (const { rect } of nodesetRects) {
    const x0 = rect.x - NODESET_PADDING;
    const y0 = rect.y - NODESET_PADDING - (NODESET_LABEL_SIZE + 2);
    const x1 = rect.x + rect.width + NODESET_PADDING;
    const y1 = rect.y + rect.height + NODESET_PADDING;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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

function renderDefs(): string {
  return [
    `<defs>`,
    `  <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="${ARROW_LENGTH}" markerHeight="${ARROW_LENGTH}" orient="auto">`,
    `    <path d="M 0 0 L 10 5 L 0 10 Z" fill="${EDGE_STROKE}"/>`,
    `  </marker>`,
    `</defs>`,
  ].join("\n");
}

function renderNodeset(name: string, rect: BoxBounds): string {
  const x = rect.x - NODESET_PADDING;
  const y = rect.y - NODESET_PADDING;
  const w = rect.width + 2 * NODESET_PADDING;
  const h = rect.height + 2 * NODESET_PADDING;
  return [
    `<g data-nodeset="${escapeAttr(name)}">`,
    `  <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="4" ry="4" fill="none" stroke="${NODESET_STROKE}" stroke-width="1" stroke-dasharray="${NODESET_DASH}"/>`,
    `  <text x="${fmt(x + 6)}" y="${fmt(y - 2)}" text-anchor="start" font-size="${NODESET_LABEL_SIZE}" fill="${NODESET_LABEL_FILL}">${escapeText(name)}</text>`,
    `</g>`,
  ].join("\n");
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

function renderEdge(edge: ModelEdge, poly: Polyline): string {
  if (poly.points.length < 2) return "";
  const d = polylineD(poly.points);
  const dash = edge.isBackEdge ? ` stroke-dasharray="${BACK_EDGE_DASH}"` : "";
  // First half of a via-pair (source -> highway): no arrowhead, since
  // the visible trace continues into the second half (highway -> target)
  // which carries the arrow. (DESIGN-PHASE4.md §11.9 v2.)
  const arrow = edge.viaFirstHalf ? "" : ' marker-end="url(#arrow)"';
  return [
    `<g data-edge="${escapeAttr(edge.from)}->${escapeAttr(edge.to)}">`,
    `  <path d="${d}" fill="none" stroke="${EDGE_STROKE}" stroke-width="${EDGE_WIDTH}" stroke-linecap="butt" stroke-linejoin="miter"${dash}${arrow}/>`,
    `</g>`,
  ].join("\n");
}

function renderPathHighlight(poly: Polyline, colour: string): string {
  const d = polylineD(poly.points);
  return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${PATH_WIDTH}" stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>`;
}

function polylineD(points: Point[]): string {
  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${fmt(points[i]!.x)} ${fmt(points[i]!.y)}`;
  }
  return d;
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

function renderNode(n: ModelNode, b: BoxBounds, z: number = 0): string {
  // §11.13: nodes at z < 0 (underground) render faded to imply depth.
  // The fade amount scales with depth: z=-1 → 0.45 opacity, z=-2 → 0.30,
  // etc., bottoming out at 0.15 to keep faintly-readable text.
  const opacityAttr = z < 0
    ? ` opacity="${Math.max(0.15, 0.45 + (z + 1) * 0.15).toFixed(2)}"`
    : "";
  const groupOpen = `<g data-id="${escapeAttr(n.id)}"${z !== 0 ? ` data-z="${z}"` : ""}${opacityAttr}>`;
  // Highway nodes: render as a faint dashed outline so the bundle's
  // boundaries are visible. No label. (DESIGN-PHASE4.md §11.9.)
  if (n.shape === "highway") {
    return [
      groupOpen,
      `  <rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" height="${fmt(b.height)}" fill="none" stroke="#9fa9bb" stroke-width="1" stroke-dasharray="4 3"/>`,
      `</g>`,
    ].join("\n");
  }
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return [
    groupOpen,
    `  ${nodeShape(n.shape, b)}`,
    `  <text x="${fmt(cx)}" y="${fmt(cy)}" text-anchor="middle" dominant-baseline="central" fill="${TEXT}">${escapeText(n.label)}</text>`,
    `</g>`,
  ].join("\n");
}

function nodeShape(shape: ShapeName, b: BoxBounds): string {
  const common = `fill="${BOX_FILL}" stroke="${BOX_STROKE}" stroke-width="${BOX_STROKE_WIDTH}"`;
  switch (shape) {
    case "rect":
      return `<rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" height="${fmt(b.height)}" ${common}/>`;
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
 * (for vertical). A white halo drawn underneath keeps it readable
 * when crossing other edges.
 */
function renderEdgeLabel(edge: ModelEdge, poly: Polyline): string {
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
  const common = `x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-size="${EDGE_LABEL_SIZE}"`;
  return [
    `<g data-edge-label="${escapeAttr(edge.from)}->${escapeAttr(edge.to)}">`,
    `  <text ${common} fill="${LABEL_HALO}" stroke="${LABEL_HALO}" stroke-width="3" stroke-linejoin="round">${txt}</text>`,
    `  <text ${common} fill="${TEXT}">${txt}</text>`,
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

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
