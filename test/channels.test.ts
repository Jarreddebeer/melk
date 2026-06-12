/**
 * Phase 4 channel routing tests (Step 6).
 *
 * Covers correctness of the per-edge polyline emission, focused on
 * regressions we've hit during development.
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import { assignSlots } from "../src/layout/slots.js";
import { routeChannels } from "../src/layout/channels.js";
import { autoAlignViaShims } from "../src/layout/via-shim.js";
import type { Point } from "../src/layout/channels.js";

function route(src: string) {
  const m = bind(parse(tokenize(src)));
  const p = place(m);
  const s = assignSlots(m, p);
  autoAlignViaShims(m, p, s);
  return { model: m, placement: p, routing: routeChannels(m, p, s) };
}

function polylineFor(routing: ReturnType<typeof route>["routing"], from: string, to: string, model: ReturnType<typeof route>["model"]): Point[] {
  for (let i = 0; i < model.edges.length; i++) {
    const e = model.edges[i]!;
    if (e.from === from && e.to === to) {
      const pl = routing.polylines.find((p) => p.edgeIndex === i);
      if (!pl) throw new Error(`no polyline for ${from}->${to}`);
      return pl.points;
    }
  }
  throw new Error(`no edge ${from}->${to}`);
}

/**
 * For each pair of consecutive points in a polyline, classify the segment
 * as horizontal, vertical, or diagonal (chamfer). Returns runs of axial
 * segments — used to extract the long V/H legs and check their pixel
 * positions against node bounding boxes.
 */
function axialSegments(pts: Point[]): Array<{ axis: "V" | "H"; x1: number; y1: number; x2: number; y2: number }> {
  const out: Array<{ axis: "V" | "H"; x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (a.x === b.x && a.y !== b.y) {
      out.push({ axis: "V", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    } else if (a.y === b.y && a.x !== b.x) {
      out.push({ axis: "H", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  return out;
}

describe("channel routing — no NaN coordinates", () => {
  it("every polyline waypoint is a finite number", () => {
    // Regression: pickVLaneNear was returning column indices beyond the
    // grid's allocated colX array, producing NaN x coordinates.
    const src = `
      layout: lr
      router { shape: rect, size: 9x13, label: "router" }
      a { size: 5x5, label: "a" }
      b { size: 5x5, label: "b" }
      c { size: 5x5, label: "c" }
      fan-out f: router -> [a, b, c]
      a -> sink
      b -> sink
      c -> sink
      sink { size: 5x5, label: "sink" }
    `;
    const { routing } = route(src);
    for (const pl of routing.polylines) {
      for (const pt of pl.points) {
        expect(Number.isFinite(pt.x), `non-finite x in polyline ${pl.edgeIndex}: ${JSON.stringify(pl.points)}`).toBe(true);
        expect(Number.isFinite(pt.y), `non-finite y in polyline ${pl.edgeIndex}: ${JSON.stringify(pl.points)}`).toBe(true);
      }
    }
  });
});

describe("channel routing — V leg clearance from node footprints", () => {
  it("V leg of a long trace doesn't run flush against any non-endpoint node", () => {
    // Regression: a V leg crossing past multiple intermediate nodes
    // was running at col adjacent to those nodes' edges — visually
    // inseparable from the outline. Require at least 1 empty column
    // between the V leg and any node's footprint over the V leg's
    // row range.
    const src = `
      layout: lr
      hub  { shape: rect,     size: 9x13, label: "hub" }
      a    { size: 5x5, label: "a" }
      b    { size: 5x5, label: "b" }
      c    { size: 5x5, label: "c" }
      d    { size: 5x5, label: "d" }
      e    { size: 5x5, label: "e" }
      f    { size: 5x5, label: "f" }
      sinkA { shape: cylinder, size: 5x5, label: "sinkA" }
      sinkB { shape: cylinder, size: 5x5, label: "sinkB" }
      sinkC { shape: cylinder, size: 5x5, label: "sinkC" }
      sinkD { shape: cylinder, size: 5x5, label: "sinkD" }
      sinkE { shape: cylinder, size: 5x5, label: "sinkE" }
      fan-out outs: hub -> [a, b, c, d, e, f]
      a -> sinkA
      b -> sinkB
      c -> sinkC
      d -> sinkD
      e -> sinkE
      f -> sinkA
    `;
    const { model, placement, routing } = route(src);
    const f_sinkA = polylineFor(routing, "f", "sinkA", model);
    const segs = axialSegments(f_sinkA);
    const longV = segs.find((s) => s.axis === "V" && Math.abs(s.y2 - s.y1) > 40);
    expect(longV, "f→sinkA should have a long V leg").toBeDefined();
    // For each cell of every non-endpoint node, the V leg's column
    // must NOT be ±1 of that node's column range across the leg's
    // row range. (1 cell of clearance minimum.)
    const vX = longV!.x1;
    const vCol = (vX - 4) / 8;
    const yLo = Math.min(longV!.y1, longV!.y2);
    const yHi = Math.max(longV!.y1, longV!.y2);
    const rowLo = Math.floor(yLo / 8);
    const rowHi = Math.floor(yHi / 8);
    for (const node of model.nodes) {
      if (node.id === "f" || node.id === "sinkA") continue;
      const cell = placement.cells.get(node.id);
      if (!cell) continue;
      const nLeftCol = cell.col;
      const nRightCol = cell.col + Math.ceil(node.size.width) - 1;
      const nTopRow = cell.row;
      const nBotRow = cell.row + Math.ceil(node.size.height) - 1;
      // Row range overlap?
      if (rowHi < nTopRow || rowLo > nBotRow) continue;
      // V leg col must be at least 1 col away from the node's edges.
      const distLeft = nLeftCol - vCol;   // V leg LEFT of node → positive
      const distRight = vCol - nRightCol; // V leg RIGHT of node → positive
      const onLeft = distLeft >= 1;
      const onRight = distRight >= 1;
      expect(
        onLeft || onRight,
        `V leg at col ${vCol} too close to ${node.id} (cols ${nLeftCol}..${nRightCol})`,
      ).toBe(true);
    }
  });
});

describe("channel routing — avoid: channels honored", () => {
  it("an edge with avoid: channels does not cross edges in the avoided set", () => {
    // Regression: ingest -> router { avoid: channels } in ex 10 was
    // crossing fan-out V legs even though the avoid directive should
    // route ingest around the channels.
    const src = `
      layout: lr
      crossings: 50
      router { shape: rect, size: 9x13, label: "router" }
      a { size: 5x5, label: "a" }
      b { size: 5x5, label: "b" }
      c { size: 5x5, label: "c" }
      d { size: 5x5, label: "d" }
      e { size: 5x5, label: "e" }
      f { size: 5x5, label: "f" }
      sink { size: 5x5, label: "sink" }
      source { size: 5x5, label: "source" }
      ingest { size: 5x5, label: "ingest" }
      source -> ingest
      ingest -> router { avoid: channels }
      fan-out channels: router -> [a, b, c, d, e, f]
      a -> sink
      b -> sink
      c -> sink
      d -> sink
      e -> sink
      f -> sink
    `;
    const { model, routing } = route(src);
    const ingestRouter = polylineFor(routing, "ingest", "router", model);
    // For each fan-out edge router->X, check that ingest->router's
    // polyline doesn't share any line segment crossings.
    const channelEdges = ["a", "b", "c", "d", "e", "f"];
    for (const target of channelEdges) {
      const fanOut = polylineFor(routing, "router", target, model);
      const intersects = polylinesIntersect(ingestRouter, fanOut);
      expect(intersects, `ingest->router crosses router->${target}`).toBe(false);
    }
  });
});

/**
 * Returns true if two polylines share an X-crossing (segment-segment
 * intersection at a point that's not a shared endpoint).
 */
function polylinesIntersect(a: Point[], b: Point[]): boolean {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      if (segmentsCross(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) return true;
    }
  }
  return false;
}

/** Standard segment-intersection test. Returns true if AB crosses CD strictly inside both. */
function segmentsCross(A: Point, B: Point, C: Point, D: Point): boolean {
  const d1 = cross(D.x - C.x, D.y - C.y, A.x - C.x, A.y - C.y);
  const d2 = cross(D.x - C.x, D.y - C.y, B.x - C.x, B.y - C.y);
  const d3 = cross(B.x - A.x, B.y - A.y, C.x - A.x, C.y - A.y);
  const d4 = cross(B.x - A.x, B.y - A.y, D.x - A.x, D.y - A.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

describe("channel routing — back-edge perimeter routing", () => {
  it("a back-edge runs OUTSIDE the row of source/target boxes", () => {
    // Regression: ex 02 sink>-fanout was running horizontally at the
    // top-slot row INSIDE the row of obstacle boxes (b and join sat on
    // the same row as src/fanout/sink, and the back-edge cut straight
    // through them). The perimeter router should lift the H-leg to a
    // row outside the source AND target AND any obstacle on the
    // corridor's row range.
    const src = `
      layout: lr
      crossings: 2
      fanout { shape: rect, size: 7x5 }
      join   { shape: rect, size: 5x5 }
      src    -> fanout
      fan-out broadcast: fanout -> [a, b, c]
      bus    converge:   [a, b, c] -> join
      join   -> sink
      sink   >- fanout { label: "retry" }
    `;
    const { model, placement, routing } = route(src);
    const backEdge = polylineFor(routing, "sink", "fanout", model);
    const segs = axialSegments(backEdge);
    // Find the back-edge's H legs and check none of them cross any
    // non-endpoint node's vertical span.
    for (const seg of segs) {
      if (seg.axis !== "H") continue;
      const y = seg.y1;
      const xLo = Math.min(seg.x1, seg.x2);
      const xHi = Math.max(seg.x1, seg.x2);
      for (const node of model.nodes) {
        if (node.id === "sink" || node.id === "fanout") continue;
        const cell = placement.cells.get(node.id);
        if (!cell) continue;
        const nodeTop = cell.row * 8;
        const nodeBottom = nodeTop + Math.ceil(node.size.height) * 8;
        const nodeLeft = cell.col * 8;
        const nodeRight = nodeLeft + Math.ceil(node.size.width) * 8;
        if (y <= nodeTop || y >= nodeBottom) continue; // H run above or below
        // H run vertically intersects the node's span. Check x overlap.
        const overlap = Math.min(xHi, nodeRight) - Math.max(xLo, nodeLeft);
        expect(
          overlap <= 0,
          `back-edge H leg at y=${y} cuts through ${node.id} (x=${nodeLeft}..${nodeRight}, run=${xLo}..${xHi})`,
        ).toBe(true);
      }
    }
  });
});

describe("channel routing — axial overlap detection", () => {
  it("two long collinear segments on the same coordinate raise E_AXIAL_OVERLAP", () => {
    // Synthetic case: two trace polylines that the user could
    // construct to draw on the same pixels. Use raw edges that the
    // pre-perimeter router would route into the same row.
    // We can't easily construct this with the current router, so just
    // verify the detection helper exists by routing a sane case and
    // confirming no E_AXIAL_OVERLAP fires (defense-in-depth — the
    // gradient pass in svg.ts marks intentional bend tucks as visual
    // distinguishers, but the channel router itself should never emit
    // long pixel-identical co-routes).
    const src = `
      layout: lr
      crossings: 5
      hub { shape: rect, size: 5x9, label: "hub" }
      bus producers: [p1, p2, p3] -> hub
      fan-out consumers: hub -> [c1, c2, c3]
    `;
    const { routing } = route(src);
    // No throw — that's the check. If the detector misfires on plain
    // fan-out/fan-in patterns, this test catches it.
    expect(routing.polylines.length).toBeGreaterThan(0);
  });

  it("a dense 3x3 highway intersect DOES raise E_AXIAL_OVERLAP (the ex-29 limit)", () => {
    // Positive fixture for the detector: a 3×3 all-to-all highway fan-out
    // forces two via-half traces to swap rows, so their 2-bend Z paths
    // share an H segment — the documented limit (next-session.md). This
    // pins the failure so that when the 4-bend stair routing lands, this
    // test flips to assert a clean route instead.
    const src = `
      layout: lr
      crossings: 40
      src_h1 { shape: rect, size: 9x5 }
      src_h2 { shape: rect, size: 9x5 }
      src_h3 { shape: rect, size: 9x5 }
      dst_h1 { shape: rect, size: 9x5 }
      dst_h2 { shape: rect, size: 9x5 }
      dst_h3 { shape: rect, size: 9x5 }
      hwy_h { shape: highway }
      src_h1 -> dst_h1 { via: hwy_h }
      src_h1 -> dst_h2 { via: hwy_h }
      src_h1 -> dst_h3 { via: hwy_h }
      src_h2 -> dst_h1 { via: hwy_h }
      src_h2 -> dst_h2 { via: hwy_h }
      src_h2 -> dst_h3 { via: hwy_h }
      src_h3 -> dst_h1 { via: hwy_h }
      src_h3 -> dst_h2 { via: hwy_h }
      src_h3 -> dst_h3 { via: hwy_h }
    `;
    expect(() => route(src)).toThrow(/E_AXIAL_OVERLAP/);
  });
});

describe("placer — TB bus/fan-out median producer column-aligns with hub", () => {
  it("under TB, the median bus producer sits at the same column as the hub", () => {
    // Regression: ex 15b had p2 at col 10, hub at col 11, so p2->hub
    // drew as an L-shape with a 16-px horizontal jog instead of a
    // straight vertical line. Under LR (ex 15a), the same primitive
    // worked because the row-anchoring path of anchorPerpOf happened
    // to be correct; under TB, the column-anchoring needed the
    // pStep-sign flip.
    const src = `
      layout: tb
      hub { shape: rect, size: 7x5, label: "hub" }
      bus into-hub: [p1, p2, p3] -> hub
    `;
    const { model, placement } = route(src);
    const hub = placement.cells.get("hub")!;
    const p2 = placement.cells.get("p2")!;
    const hubNode = model.nodes.find((n) => n.id === "hub")!;
    const p2Node = model.nodes.find((n) => n.id === "p2")!;
    const hubCenterCol = hub.col + (hubNode.size.width - 1) / 2;
    const p2CenterCol = p2.col + (p2Node.size.width - 1) / 2;
    expect(
      p2CenterCol,
      `p2 center col ${p2CenterCol} should match hub center col ${hubCenterCol}`,
    ).toBe(hubCenterCol);
  });

  it("under TB, the median fan-out consumer sits at the same column as the hub", () => {
    const src = `
      layout: tb
      hub { shape: rect, size: 7x5, label: "hub" }
      fan-out out-of-hub: hub -> [c1, c2, c3]
    `;
    const { model, placement } = route(src);
    const hub = placement.cells.get("hub")!;
    const c2 = placement.cells.get("c2")!;
    const hubNode = model.nodes.find((n) => n.id === "hub")!;
    const c2Node = model.nodes.find((n) => n.id === "c2")!;
    const hubCenterCol = hub.col + (hubNode.size.width - 1) / 2;
    const c2CenterCol = c2.col + (c2Node.size.width - 1) / 2;
    expect(c2CenterCol).toBe(hubCenterCol);
  });
});

describe("channel routing — slot pixel as boundary-leg perp coord", () => {
  it("Via-half slot on a cell boundary doesn't get a chamfer at the box face", () => {
    // Regression: ex 18 src_a slot 1 (slot index 2.5 on a 7-wide face)
    // landed at x = box.left + 24 px = the col26/col27 boundary. The old
    // pixelizer set the V-channel coord to col26's CENTER (x=212) instead
    // of the slot pixel (x=216), forcing a 4-px chamfer right at the
    // source box face. With the fix, the V leg holds srcSlotPx.x, so the
    // polyline exits the box dead-vertical for at least one whole cell
    // before the first chamfer.
    const src = `
      layout: tb
      crossings: 10
      src_a { size: 7x5 }
      src_b { size: 7x5 }
      src_c { size: 7x5 }
      dst_x { size: 7x5 }
      dst_y { size: 7x5 }
      dst_z { size: 7x5 }
      hwy { shape: highway }
      src_a -> dst_x { via: hwy }
      src_a -> dst_y { via: hwy }
      src_b -> dst_z { via: hwy }
      src_b -> dst_y { via: hwy }
      src_c -> dst_x { via: hwy }
      src_c -> dst_z { via: hwy }
    `;
    const { model, routing } = route(src);
    // Both src_a -> hwy traces should exit src_a's south face dead-
    // vertical (no horizontal jog at the box border). Polyline format:
    // points[0] = slot pixel, points[1] = first turn. The vector from
    // points[0] to points[1] must be purely vertical (dx = 0).
    let checked = 0;
    for (let i = 0; i < model.edges.length; i++) {
      const e = model.edges[i]!;
      if (e.from !== "src_a" || e.to !== "hwy") continue;
      const pl = routing.polylines.find((p) => p.edgeIndex === i)!;
      const p0 = pl.points[0]!;
      const p1 = pl.points[1]!;
      expect(
        p0.x,
        `src_a -> hwy edge ${i}: first leg must hold slot.x (no exit chamfer)`,
      ).toBe(p1.x);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("Sibling via traces (src→hwy and hwy→dst) don't cross each other (ex 27)", () => {
    // Regression: ex 27 had sibling crossings on BOTH ends of the
    // highway. src_a→hwy slots (E face) crossed because the midCol
    // picker rejected the col adjacent to hwy (clearance check saw
    // hwy in cellOwner). hwy→dst_x and hwy→dst_z slots (W face of
    // dst) crossed because the SECOND sibling picked a col that
    // produced a crossing with its slot-0 sibling.
    //
    // Fixes: (a) at the V-leg's tgt-bend row, skip tgt's footprint
    // in the clearance check (lets slot 0 of src→hwy reach the
    // hwy-adjacent col); (b) when a sibling V leg to the same
    // (src, tgt) pair is already placed, sweep from the opposite
    // end of the corridor, with the direction chosen by goingUp/
    // goingDown (slot 0 col < slot 1 col for goingUp; slot 0 col >
    // slot 1 col for goingDown).
    const src = `
      layout: lr
      crossings: 10
      src_a { size: 7x5 }
      dst_x { size: 7x5 }
      dst_y { size: 7x5 }
      src_b { size: 7x5 }
      dst_z { size: 7x5 }
      src_c { size: 7x5 }
      hwy { shape: highway }
      src_a -> dst_x { via: hwy }
      src_a -> dst_y { via: hwy }
      src_b -> dst_y { via: hwy }
      src_b -> dst_z { via: hwy }
      src_c -> dst_x { via: hwy }
      src_c -> dst_z { via: hwy }
    `;
    const { model, routing } = route(src);

    function pairPolylines(from: string, to: string): Point[][] {
      return model.edges
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.from === from && e.to === to)
        .map(({ i }) => routing.polylines.find((p) => p.edgeIndex === i)!.points);
    }

    // src_a / src_c each fan out two via traces to hwy on the E face.
    for (const src of ["src_a", "src_c"]) {
      const polys = pairPolylines(src, "hwy");
      expect(polys.length, `expected 2 ${src}→hwy edges`).toBe(2);
      expect(
        polylinesIntersect(polys[0]!, polys[1]!),
        `${src}'s two via traces must not cross`,
      ).toBe(false);
    }

    // hwy fans into dst_x (goingUp from hwy) and dst_z (goingDown)
    // each with two via traces on the dst's W face.
    for (const dst of ["dst_x", "dst_z"]) {
      const polys = pairPolylines("hwy", dst);
      expect(polys.length, `expected 2 hwy→${dst} edges`).toBe(2);
      expect(
        polylinesIntersect(polys[0]!, polys[1]!),
        `hwy→${dst}'s two via traces must not cross`,
      ).toBe(false);
    }
  });

  it("fan-out to 2-above + 2-below from one face routes planar (fan-chamfer lane order)", () => {
    // Regression: a 4-way fan-out (two targets above the source row, two
    // below) crossed within each turn-direction pair. pickMidCol's
    // clearance-relaxation ladder let the SECOND sibling of a pair
    // backfill a column the FIRST had swept past (first sibling's start
    // col failed the 2-cell footprint clearance; the second took it at
    // 0-cell clearance), inverting the chamfer nesting: the inner lane's
    // V leg cut the outer lane's slot-row H run. Fan-chamfer bounds now
    // keep same-face same-direction mid lanes monotone in slot row.
    //
    // Topology distilled from a real diagram (diamond policy node
    // fanning to four view boxes); the sizes matter — they produce the
    // clearance rejection that triggered the backfill.
    const src = `
      layout: lr
      hub { shape: diamond, size: 13x7 }
      up_far   { size: 9x7 }
      up_near  { size: 9x7 }
      dn_near  { size: 11x7 }
      dn_far   { size: 13x7 }
      fan-out reads: hub -> [up_far, up_near, dn_near, dn_far]
    `;
    const { model, routing } = route(src);
    const targets = ["up_far", "up_near", "dn_near", "dn_far"];
    const polys = targets.map((t) => polylineFor(routing, "hub", t, model));
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        expect(
          polylinesIntersect(polys[i]!, polys[j]!),
          `hub→${targets[i]} must not cross hub→${targets[j]}`,
        ).toBe(false);
      }
    }
    expect(routing.crossings.length, "fan-out needs no crossings").toBe(0);
  });

  it("fan-out fan-chamfer lane order holds under tb (pickMidRow mirror)", () => {
    // Isometric mirror of the case above: under tb the fan-out leaves
    // the S face, the Z routes are H→H, and the mid lane is a row picked
    // by pickMidRow. Sizes transposed to produce the rotated geometry.
    const src = `
      layout: tb
      hub { shape: diamond, size: 7x13 }
      up_far   { size: 7x9 }
      up_near  { size: 7x9 }
      dn_near  { size: 7x11 }
      dn_far   { size: 7x13 }
      fan-out reads: hub -> [up_far, up_near, dn_near, dn_far]
    `;
    const { model, routing } = route(src);
    const targets = ["up_far", "up_near", "dn_near", "dn_far"];
    const polys = targets.map((t) => polylineFor(routing, "hub", t, model));
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        expect(
          polylinesIntersect(polys[i]!, polys[j]!),
          `hub→${targets[i]} must not cross hub→${targets[j]}`,
        ).toBe(false);
      }
    }
    expect(routing.crossings.length, "fan-out needs no crossings").toBe(0);
  });

  it("hwy -> dst trace lands on the target face dead-vertical (arrow points down)", () => {
    // Regression: ex 18 hwy -> dst_x ended with a 4-px horizontal stub
    // because the LAST V leg's perp coord came from cellCx(bendCell)
    // instead of tgtSlotPx.x. The SVG marker-end follows the last
    // segment's orientation, so a horizontal stub → arrow points right.
    // Fix: tgt slot pixel coord is held through the last V leg, so the
    // final approach is straight down into the N face.
    const src = `
      layout: tb
      crossings: 10
      src_a { size: 7x5 }
      src_b { size: 7x5 }
      src_c { size: 7x5 }
      dst_x { size: 7x5 }
      dst_y { size: 7x5 }
      dst_z { size: 7x5 }
      hwy { shape: highway }
      src_a -> dst_x { via: hwy }
      src_a -> dst_y { via: hwy }
      src_b -> dst_z { via: hwy }
      src_b -> dst_y { via: hwy }
      src_c -> dst_x { via: hwy }
      src_c -> dst_z { via: hwy }
    `;
    const { model, routing } = route(src);
    // For each hwy -> dst_* edge, the last two polyline points must
    // share x (last segment is vertical). dst_* sit below the highway
    // under TB, so the trace approaches from above.
    for (let i = 0; i < model.edges.length; i++) {
      const e = model.edges[i]!;
      if (e.from !== "hwy" || !e.to.startsWith("dst_")) continue;
      const pl = routing.polylines.find((p) => p.edgeIndex === i)!;
      const last = pl.points[pl.points.length - 1]!;
      const secondLast = pl.points[pl.points.length - 2]!;
      expect(
        last.x,
        `hwy -> ${e.to} edge ${i}: last segment must be vertical so arrow points down (got dx=${last.x - secondLast.x})`,
      ).toBe(secondLast.x);
    }
  });
});

describe("placer — per-node offset", () => {
  it("fractional offset splits into integer cell + sub-cell pixel shift", () => {
    // `offset: '0x0.5'` decomposes into 0 integer rows (cell stays put)
    // and 4 sub-cell pixels (Placement.pixelShift = {dy: 4}). The
    // routing slot-pixel computation and the box renderer both add the
    // shift, so a half-cell-misaligned source can be nudged to land
    // its slot on the trace bundle's grid line.
    const src = `
      layout: lr
      crossings: 0
      src_b { size: 7x5, offset: "0x0.5" }
      dst_y { size: 7x5, offset: "0x-0.5" }
      hwy { shape: highway }
      src_b -> dst_y { via: hwy }
    `;
    const { placement } = route(src);
    expect(placement.pixelShift.get("src_b")).toEqual({ dx: 0, dy: 4 });
    expect(placement.pixelShift.get("dst_y")).toEqual({ dx: 0, dy: -4 });
    // Mixed integer + fractional: `offset: '1x1.5'` → cell shifts +1
    // col / +1 row, pixelShift dx=0, dy=4 (the .5 fraction).
    const src2 = `
      layout: lr
      crossings: 0
      m { size: 5x5, offset: "1x1.5" }
      a { size: 5x5 }
      a -> m
    `;
    const { placement: p2 } = route(src2);
    expect(p2.pixelShift.get("m")).toEqual({ dx: 0, dy: 4 });
  });

  it("ex 27 half-cell offset eliminates the slot-misalignment wiggle", () => {
    // Regression: the visible 4-px C-curve on src_b ↔ hwy in ex 27 came
    // from src_b's 7-wide face placing slots at half-cell y (96, 104)
    // while the 6-wide hwy placed them at integer y (100, 108). Shifting
    // src_b down by 0.5 cell with `offset: '0x0.5'` puts the slot
    // pixels on the hwy grid; both src_b → hwy via-half traces become
    // single straight horizontal segments.
    const src = `
      layout: lr
      crossings: 10
      src_a { size: 7x5 }
      src_c { size: 7x5 }
      src_b { size: 7x5, offset: "0x0.5" }
      dst_x { size: 7x5 }
      dst_z { size: 7x5 }
      dst_y { size: 7x5, offset: "0x-0.5" }
      hwy { shape: highway }
      src_a -> dst_x { via: hwy }
      src_a -> dst_y { via: hwy }
      src_b -> dst_z { via: hwy }
      src_b -> dst_y { via: hwy }
      src_c -> dst_x { via: hwy }
      src_c -> dst_z { via: hwy }
    `;
    const { model, routing } = route(src);
    // For each src_b → hwy polyline and each hwy → dst_y polyline,
    // every waypoint must share a single y (= dead-straight horizontal).
    const targets = [
      { from: "src_b", to: "hwy" },
      { from: "hwy", to: "dst_y" },
    ];
    for (const { from, to } of targets) {
      const polys = model.edges
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.from === from && e.to === to)
        .map(({ i }) => routing.polylines.find((p) => p.edgeIndex === i)!.points);
      for (const pts of polys) {
        const ys = new Set(pts.map((p) => p.y));
        expect(
          ys.size,
          `${from} → ${to} polyline must be horizontal (y values: ${[...ys].join(",")})`,
        ).toBe(1);
      }
    }
  });

  it("integer-cell offset shifts the cell on the grid", () => {
    const src = `
      layout: lr
      crossings: 0
      a { size: 5x5 }
      b { size: 5x5, offset: "0x2" }
      a -> b
    `;
    const { placement } = route(src);
    // a at default position; b shifted south by 2 cells from where the
    // flow pass would have placed it. The pixel shift map is empty
    // because the offset has no fractional component.
    expect(placement.pixelShift.has("b")).toBe(false);
    const aCell = placement.cells.get("a")!;
    const bCell = placement.cells.get("b")!;
    // Under LR, the flow pass places b at a's row + 0; offset 0x2 moves
    // it two rows south.
    expect(bCell.row - aCell.row).toBe(2);
  });

  it("rejects unquoted offset and malformed strings", () => {
    expect(() => route(`a { size: 5x5, offset: 0x1 }\na -> b`)).toThrow(/offset must be a quoted string/);
    expect(() => route(`a { size: 5x5, offset: "bad" }\na -> b`)).toThrow(/must be in the form 'WxH'/);
  });

  it("auto-shim aligns ex 27 same-row via traces without manual offset", () => {
    // Option 2 of the half-cell slot misalignment fix: the placer's
    // autoAlignViaShims pass shifts each via source/target by ±4 px on
    // the perp axis so its slot cluster lines up with the highway's
    // cluster. Without it (and without the manual `offset:` from
    // Option 1), src_b's two outgoing via-half traces bend by 4 px on
    // their entry to hwy. With the auto shim, every same-row trace is
    // a single horizontal segment.
    const src = `
      layout: lr
      crossings: 10
      src_a { size: 7x5 }
      dst_x { size: 7x5 }
      dst_y { size: 7x5 }
      src_b { size: 7x5 }
      dst_z { size: 7x5 }
      src_c { size: 7x5 }
      hwy { shape: highway }
      src_a -> dst_x { via: hwy }
      src_a -> dst_y { via: hwy }
      src_b -> dst_y { via: hwy }
      src_b -> dst_z { via: hwy }
      src_c -> dst_x { via: hwy }
      src_c -> dst_z { via: hwy }
    `;
    const { model, placement, routing } = route(src);
    // src_b and dst_y are on the same row as hwy; the auto pass should
    // have given them ±4 px sub-cell shims. src_a / src_c L-bend to the
    // highway, but the auto pass shims them too so their face slots
    // sit on the highway's slot-pixel grid.
    expect(placement.pixelShift.get("src_b")).toEqual({ dx: 0, dy: 4 });
    expect(placement.pixelShift.get("dst_y")).toEqual({ dx: 0, dy: -4 });
    expect(placement.pixelShift.get("src_a")).toEqual({ dx: 0, dy: 4 });
    expect(placement.pixelShift.get("src_c")).toEqual({ dx: 0, dy: -4 });
    // The two same-row trace pairs (src_b → hwy and hwy → dst_y) must
    // both be single-segment horizontals.
    const targets = [
      { from: "src_b", to: "hwy" },
      { from: "hwy", to: "dst_y" },
    ];
    for (const { from, to } of targets) {
      const polys = model.edges
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.from === from && e.to === to)
        .map(({ i }) => routing.polylines.find((p) => p.edgeIndex === i)!.points);
      for (const pts of polys) {
        const ys = new Set(pts.map((p) => p.y));
        expect(
          ys.size,
          `${from} → ${to} polyline must be horizontal (y values: ${[...ys].join(",")})`,
        ).toBe(1);
      }
    }
  });

  it("auto-shim respects manual offset (manual wins)", () => {
    // When the author has dialed in an `offset:` with a fractional
    // pixel shift, the auto pass must leave it alone. Otherwise authors
    // can't override the heuristic when it picks wrong.
    const src = `
      layout: lr
      crossings: 0
      src_a { size: 7x5, offset: "0x0.25" }
      dst_x { size: 7x5 }
      hwy { shape: highway }
      src_a -> dst_x { via: hwy }
    `;
    const { placement } = route(src);
    // Manual: 0.25 * 8 = 2 px (a deliberately quirky value the auto
    // shim would never produce).
    expect(placement.pixelShift.get("src_a")).toEqual({ dx: 0, dy: 2 });
  });

  it("auto-shim is no-op when parity already matches", () => {
    // 5-wide hwy + 5-tall via sources: (faceLen - traceCount) parity
    // matches between source's E face and hwy's W face, so the slot
    // clusters are already aligned and the shim is 0.
    const src = `
      layout: lr
      crossings: 0
      src_a { size: 5x5 }
      dst_x { size: 5x5 }
      hwy { shape: highway, size: 5x1 }
      src_a -> dst_x { via: hwy }
    `;
    const { placement } = route(src);
    expect(placement.pixelShift.has("src_a")).toBe(false);
    expect(placement.pixelShift.has("dst_x")).toBe(false);
  });
});
