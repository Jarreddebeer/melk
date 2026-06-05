/**
 * Phase 4 polyline tests (Step 7).
 *
 * Covers pixel-coord polyline emission: pixel layout, slot positions,
 * straight-line routes, chamfered bends, and crossing markers.
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import { reserveCorridors, CELL_PX, COMB_PITCH } from "../src/layout/corridors.js";
import { packTracks } from "../src/layout/tracks.js";
import { buildPolylines, type Polyline } from "../src/layout/polyline.js";

function polylines(src: string) {
  const model = bind(parse(tokenize(src)));
  const placement = place(model);
  const reservation = reserveCorridors(model, placement);
  const packing = packTracks(model, placement, reservation);
  return {
    model,
    placement,
    reservation,
    packing,
    polylines: buildPolylines(model, placement, reservation, packing),
  };
}

function polylineFor(
  out: ReturnType<typeof polylines>,
  from: string,
  to: string,
): Polyline {
  for (let i = 0; i < out.model.edges.length; i++) {
    const e = out.model.edges[i]!;
    if (e.from === from && e.to === to) {
      const p = out.polylines.polylines.find((pl) => pl.edgeIndex === i);
      if (!p) throw new Error(`no polyline for edge '${from}->${to}'`);
      return p;
    }
  }
  throw new Error(`edge '${from}->${to}' not in model`);
}

describe("polyline — straight routes", () => {
  it("a same-row pipeline edge is a single straight horizontal segment", () => {
    const out = polylines("pipeline p: a -> b -> c");
    const ab = polylineFor(out, "a", "b");
    // Fractional centering: 1 trace on a 1x1 face, offset = (4-1)/2 = 1.5.
    // Slot 1.5 → y = 1.5*8 + 4 = 16 at defaults (= face midpoint).
    expect(ab.points).toHaveLength(2);
    const expectedY = 1.5 * COMB_PITCH + COMB_PITCH / 2;
    expect(ab.points[0]!.y).toBe(expectedY);
    expect(ab.points[1]!.y).toBe(expectedY);
    expect(ab.points[1]!.x).toBeGreaterThan(ab.points[0]!.x);
  });

  it("a same-col TB pipeline edge is a single straight vertical segment", () => {
    const out = polylines("layout: tb\npipeline p: a -> b");
    const ab = polylineFor(out, "a", "b");
    expect(ab.points).toHaveLength(2);
    expect(ab.points[0]!.x).toBe(ab.points[1]!.x);
    expect(ab.points[1]!.y).toBeGreaterThan(ab.points[0]!.y);
  });
});

describe("polyline — chamfered bends", () => {
  it("a diagonal bus edge has chamfered bends (no sharp 90s)", () => {
    const out = polylines("s { size: 1x3 }\nbus power: [p1, p2, p3] -> s");
    const p1ToS = polylineFor(out, "p1", "s");
    // Should have at least one 45° segment in the chamfered polyline.
    let has45 = false;
    for (let i = 1; i < p1ToS.points.length; i++) {
      const dx = Math.abs(p1ToS.points[i]!.x - p1ToS.points[i - 1]!.x);
      const dy = Math.abs(p1ToS.points[i]!.y - p1ToS.points[i - 1]!.y);
      if (dx > 0 && dy > 0 && dx === dy) {
        has45 = true;
        break;
      }
    }
    expect(has45).toBe(true);
  });

  it("chamfer radius is COMB_PITCH/2 = 4 px on bends with adequate segment length", () => {
    const out = polylines(
      "s { size: 1x3 }\nbus power: [p1, p2, p3] -> s",
    );
    const p1ToS = polylineFor(out, "p1", "s");
    // Find the first 45° segment and check its length.
    for (let i = 1; i < p1ToS.points.length; i++) {
      const dx = p1ToS.points[i]!.x - p1ToS.points[i - 1]!.x;
      const dy = p1ToS.points[i]!.y - p1ToS.points[i - 1]!.y;
      if (Math.abs(dx) === Math.abs(dy) && Math.abs(dx) > 0) {
        // 45° segment. Length = COMB_PITCH/2 * sqrt(2) for a chamfer
        // of radius COMB_PITCH/2.
        const expected = (COMB_PITCH / 2) * Math.SQRT2;
        const actual = Math.hypot(dx, dy);
        expect(actual).toBeCloseTo(expected, 5);
        return;
      }
    }
    throw new Error("no 45° segment found");
  });

  it("polyline endpoints are exactly at the slot port pixel positions", () => {
    const out = polylines("pipeline p: a -> b");
    const ab = polylineFor(out, "a", "b");
    // a is at cell (0,0), 1x1 box, single trace on E face → centered
    // slot 1.5 → y = 16 at defaults (= face midpoint).
    expect(ab.points[0]).toEqual({
      x: CELL_PX,
      y: 1.5 * COMB_PITCH + COMB_PITCH / 2,
    });
  });
});

describe("polyline — back-edges", () => {
  it("a back-edge wraps over the top through H0 (page-top margin)", () => {
    // With back-edges allocated to the outermost (top) slot of the
    // shared face, the back-trace exits above the forward-edge cluster
    // and doesn't cross any forward edges. No crossings needed.
    const out = polylines("pipeline p: a -> b -> c\nc >- a");
    const cToA = polylineFor(out, "c", "a");
    // The polyline must visit a y-coord above row 0 (the page-top
    // gutter). row 0's top y = rowGutterUnits[0] * CELL_PX = 1 * 32 = 32.
    // Anything with y < 32 is in the gutter.
    const minY = Math.min(...cToA.points.map((p) => p.y));
    expect(minY).toBeLessThan(CELL_PX);
  });
});

describe("polyline — pixel layout", () => {
  it("computes total width and height covering all boxes", () => {
    const out = polylines("pipeline p: a -> b -> c");
    // 3 boxes, each 1 cell wide; 2 gutters between them widened to 1
    // unit (for the 1-trace demand). Plus the right page margin = 0.
    expect(out.polylines.width).toBeGreaterThan(0);
    expect(out.polylines.height).toBeGreaterThan(0);
  });

  it("a wider box widens the diagram horizontally", () => {
    const narrow = polylines("a { size: 1x1 }\npipeline p: a -> b");
    const wide = polylines("a { size: 4x1 }\npipeline p: a -> b");
    expect(wide.polylines.width).toBeGreaterThan(narrow.polylines.width);
  });
});

describe("polyline — crossings", () => {
  it("emits one crossing marker per crossing pair", () => {
    const src = [
      "crossings: 10",
      "a { size: 1x2 }",
      "b { size: 1x2 }",
      "x { size: 1x2 }",
      "y { size: 1x2 }",
      "pipeline lhs: a -> x",
      "pipeline rhs: b -> y",
      "b -> x",
      "a -> y",
    ].join("\n");
    const out = polylines(src);
    expect(out.polylines.crossings.length).toBe(out.packing.crossings.length);
  });

  it("crossing markers carry edgeIndexA and edgeIndexB matching the packing", () => {
    const src = [
      "crossings: 10",
      "a { size: 1x2 }",
      "b { size: 1x2 }",
      "x { size: 1x2 }",
      "y { size: 1x2 }",
      "pipeline lhs: a -> x",
      "pipeline rhs: b -> y",
      "b -> x",
      "a -> y",
    ].join("\n");
    const out = polylines(src);
    for (const c of out.polylines.crossings) {
      expect(c.edgeIndexA).toBeLessThan(c.edgeIndexB);
    }
  });

  it("polylines reference their crossings via crossingIndices", () => {
    const src = [
      "crossings: 10",
      "a { size: 1x2 }",
      "b { size: 1x2 }",
      "x { size: 1x2 }",
      "y { size: 1x2 }",
      "pipeline lhs: a -> x",
      "pipeline rhs: b -> y",
      "b -> x",
      "a -> y",
    ].join("\n");
    const out = polylines(src);
    // Every crossing's edgeIndexA polyline references that crossing
    // index, and same for edgeIndexB.
    for (let i = 0; i < out.polylines.crossings.length; i++) {
      const c = out.polylines.crossings[i]!;
      const pa = out.polylines.polylines.find(
        (p) => p.edgeIndex === c.edgeIndexA,
      )!;
      const pb = out.polylines.polylines.find(
        (p) => p.edgeIndex === c.edgeIndexB,
      )!;
      expect(pa.crossingIndices).toContain(i);
      expect(pb.crossingIndices).toContain(i);
    }
  });
});

describe("polyline — determinism", () => {
  it("same input produces identical output byte-for-byte", () => {
    const src =
      "s { size: 1x3 }\nbus b: [p1, p2, p3] -> s\nfan-out f: s -> [c1, c2, c3]";
    const out1 = polylines(src);
    const out2 = polylines(src);
    expect(JSON.stringify(out1.polylines)).toBe(JSON.stringify(out2.polylines));
  });
});

// --- tangle detection -----------------------------------------------------
//
// Helpers for detecting visual crossings between two polylines. A
// "tangle" is when two polylines that are NOT supposed to cross (per
// the X-junction crossings budget) intersect at a non-endpoint point.
//
// These tests pin known-tangled outputs so future fixes can convert
// them from `.skip` to `.it`. Each tangle has an example in
// `examples/` whose rendered SVG visibly shows the crossing.

/** Do two line segments [(x1,y1)-(x2,y2)] and [(x3,y3)-(x4,y4)] strictly cross? */
function segmentsCross(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): boolean {
  const d1 = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3);
  const d2 = (x4 - x3) * (y2 - y3) - (y4 - y3) * (x2 - x3);
  const d3 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  const d4 = (x2 - x1) * (y4 - y1) - (y2 - y1) * (x4 - x1);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

/** True iff `a` and `b` cross each other at any pair of segments. */
function polylinesCross(a: Polyline, b: Polyline): boolean {
  for (let i = 0; i + 1 < a.points.length; i++) {
    const a1 = a.points[i]!;
    const a2 = a.points[i + 1]!;
    for (let j = 0; j + 1 < b.points.length; j++) {
      const b1 = b.points[j]!;
      const b2 = b.points[j + 1]!;
      if (segmentsCross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y)) {
        return true;
      }
    }
  }
  return false;
}

describe("polyline — tangles (known issues from highway examples)", () => {
  // Issue from `examples/19-highway-with-pipeline.melk`: ext_1 has two
  // outgoing via-half edges (ext_1 -> svc_a and ext_1 -> svc_b through
  // the same inlet highway). On the fan-out side, the trace serving
  // svc_a bends down prematurely and crosses the trace serving svc_b.
  // The slot allocator and pivot picker don't currently coordinate
  // via-half siblings sharing a source — both pick the same V column,
  // forcing the chamfer to cross.
  it("ext_1 → svc_a/svc_b traces should not tangle on the fan-out side", () => {
    const src = [
      "crossings: 10",
      "inlet { shape: highway }",
      "db    { shape: cylinder, label: \"store\" }",
      "ext_1 -> svc_a { via: inlet }",
      "ext_1 -> svc_b { via: inlet }",
      "ext_2 -> svc_a { via: inlet }",
      "ext_2 -> svc_b { via: inlet }",
      "ext_3 -> svc_a { via: inlet }",
      "ext_3 -> svc_b { via: inlet }",
      "svc_a  -> norm_a",
      "norm_a -> db",
      "svc_b  -> norm_b",
      "norm_b -> db",
    ].join("\n");
    const out = polylines(src);
    const a = polylineFor(out, "inlet", "svc_a");
    const b = polylineFor(out, "inlet", "svc_b");
    expect(polylinesCross(a, b)).toBe(false);
  });

  // Issue from `examples/20-two-highways.melk`: svc_a has two outgoing
  // via-half edges through egress (svc_a -> sink_x, svc_a -> sink_y).
  // Both traces use the same V corridor but at different slot indices;
  // the chamfer from svc_a's E face slot crosses the other trace's V
  // descent. Same root cause as 19.
  it("svc_a → sink_x/sink_y via egress should not tangle", () => {
    const src = [
      "crossings: 20",
      "ingress { shape: highway }",
      "egress  { shape: highway }",
      "ext_1 -> svc_a { via: ingress }",
      "ext_1 -> svc_b { via: ingress }",
      "ext_2 -> svc_b { via: ingress }",
      "ext_2 -> svc_c { via: ingress }",
      "ext_3 -> svc_a { via: ingress }",
      "ext_3 -> svc_c { via: ingress }",
      "svc_a -> sink_x { via: egress }",
      "svc_a -> sink_y { via: egress }",
      "svc_b -> sink_y { via: egress }",
      "svc_c -> sink_y { via: egress }",
      "svc_c -> sink_z { via: egress }",
    ].join("\n");
    const out = polylines(src);
    const a = polylineFor(out, "svc_a", "egress");
    const b = polylineFor(out, "svc_a", "egress");
    // svc_a has TWO edges to egress; need to fetch them by edge index
    // separately. Re-do without polylineFor's first-match shortcut:
    const sas = out.model.edges
      .map((e, i) => (e.from === "svc_a" && e.to === "egress") ? i : -1)
      .filter((i) => i >= 0);
    expect(sas).toHaveLength(2);
    const p0 = out.polylines.polylines.find((p) => p.edgeIndex === sas[0])!;
    const p1 = out.polylines.polylines.find((p) => p.edgeIndex === sas[1])!;
    void a; void b;
    expect(polylinesCross(p0, p1)).toBe(false);
  });

  // Issue from `examples/24-mixed-bundle-bypass.melk`: ext_2 sits at
  // row 1 (middle), hwy spans rows 0..1 (top half of canvas). ext_2's
  // E face slots are at face mid (y=28, 36); hwy's W face slots are at
  // upper rows (y=20, 28). The two via-half edges from ext_2 must both
  // travel UP to reach the highway, but their chamfer zones overlap
  // because the second trace's chamfer-up passes through the first
  // trace's exit y. Inherent to the slot mismatch when source's face
  // mid != highway's available slot column.
  it("ext_2 → highway twin via-halves should not tangle in the chamfer zone", () => {
    const src = [
      "crossings: 10",
      "hwy   { shape: highway }",
      "hwy_m { shape: highway }",
      "ext_1 -> sink_a",
      "ext_2 -> sink_b { via: hwy }",
      "ext_2 -> sink_c { via: hwy }",
      "ext_3 -> sink_b { via: hwy }",
      "ext_3 -> sink_c { via: hwy }",
      "probe_1 -> metric_x { via: hwy_m }",
      "probe_1 -> metric_y { via: hwy_m }",
      "probe_2 -> metric_x { via: hwy_m }",
      "probe_2 -> metric_y { via: hwy_m }",
    ].join("\n");
    const out = polylines(src);
    const e2s = out.model.edges
      .map((e, i) => (e.from === "ext_2" && e.to === "hwy") ? i : -1)
      .filter((i) => i >= 0);
    expect(e2s).toHaveLength(2);
    const p0 = out.polylines.polylines.find((p) => p.edgeIndex === e2s[0])!;
    const p1 = out.polylines.polylines.find((p) => p.edgeIndex === e2s[1])!;
    expect(polylinesCross(p0, p1)).toBe(false);
  });

  // Issue from `examples/29-highway-intersect-large.melk`: three
  // traces from src_v3 follow the same multi-corridor staircase route
  // (`H1 → V1 → H2`) to hwy_v. Without the per-corridor rank flip at
  // the intermediate corridor, the three "parallel ribbons" criss-
  // cross at both corner chamfers, producing 6 visible crossings even
  // though source-slot order matches target-slot order.
  it("src_v3 → hwy_v staircase ribbon is parallel and crossing-free (ex 29)", () => {
    // Full example 29 source — the placer needs all the surrounding
    // pressure to produce the corner-far staircase route.
    const src = [
      "layout: lr",
      "crossings: 40",
      "hwy_h { shape: highway }",
      "hwy_v { shape: highway, orient: vertical, render: underground }",
      "intersect hwy_h, hwy_v",
      "src_h1 -> dst_h1 { via: hwy_h }",
      "src_h1 -> dst_h2 { via: hwy_h }",
      "src_h1 -> dst_h3 { via: hwy_h }",
      "src_h2 -> dst_h1 { via: hwy_h }",
      "src_h2 -> dst_h2 { via: hwy_h }",
      "src_h2 -> dst_h3 { via: hwy_h }",
      "src_h3 -> dst_h1 { via: hwy_h }",
      "src_h3 -> dst_h2 { via: hwy_h }",
      "src_h3 -> dst_h3 { via: hwy_h }",
      "src_v1 -> dst_v1 { via: hwy_v }",
      "src_v1 -> dst_v2 { via: hwy_v }",
      "src_v1 -> dst_v3 { via: hwy_v }",
      "src_v2 -> dst_v1 { via: hwy_v }",
      "src_v2 -> dst_v2 { via: hwy_v }",
      "src_v2 -> dst_v3 { via: hwy_v }",
      "src_v3 -> dst_v1 { via: hwy_v }",
      "src_v3 -> dst_v2 { via: hwy_v }",
      "src_v3 -> dst_v3 { via: hwy_v }",
    ].join("\n");
    const out = polylines(src);
    const srcV3Edges = out.model.edges
      .map((e, i) => (e.from === "src_v3" && e.viaFirstHalf ? i : -1))
      .filter((i) => i >= 0);
    expect(srcV3Edges).toHaveLength(3);
    const polys = srcV3Edges.map((i) => out.polylines.polylines.find((p) => p.edgeIndex === i)!);
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        expect(polylinesCross(polys[i]!, polys[j]!)).toBe(false);
      }
    }
  });

  // Mirror case: three traces from hwy_v to dst_v1 also follow the
  // staircase `H3 → V2 → H4`. The Z-stacked highway cell-sharing bug
  // (hwy_h and hwy_v at the same cell) made the coherence pass group
  // their second-halves together, mixing position parities and
  // disabling the flip. Grouping by source NODE id (not cell)
  // restores the per-route flip and the bundle is again parallel.
  it("hwy_v → dst_v1 staircase ribbon is parallel and crossing-free (ex 29)", () => {
    const src = [
      "layout: lr",
      "crossings: 40",
      "hwy_h { shape: highway }",
      "hwy_v { shape: highway, orient: vertical, render: underground }",
      "intersect hwy_h, hwy_v",
      "src_h1 -> dst_h1 { via: hwy_h }",
      "src_h1 -> dst_h2 { via: hwy_h }",
      "src_h1 -> dst_h3 { via: hwy_h }",
      "src_h2 -> dst_h1 { via: hwy_h }",
      "src_h2 -> dst_h2 { via: hwy_h }",
      "src_h2 -> dst_h3 { via: hwy_h }",
      "src_h3 -> dst_h1 { via: hwy_h }",
      "src_h3 -> dst_h2 { via: hwy_h }",
      "src_h3 -> dst_h3 { via: hwy_h }",
      "src_v1 -> dst_v1 { via: hwy_v }",
      "src_v1 -> dst_v2 { via: hwy_v }",
      "src_v1 -> dst_v3 { via: hwy_v }",
      "src_v2 -> dst_v1 { via: hwy_v }",
      "src_v2 -> dst_v2 { via: hwy_v }",
      "src_v2 -> dst_v3 { via: hwy_v }",
      "src_v3 -> dst_v1 { via: hwy_v }",
      "src_v3 -> dst_v2 { via: hwy_v }",
      "src_v3 -> dst_v3 { via: hwy_v }",
    ].join("\n");
    const out = polylines(src);
    const hvDst1 = out.model.edges
      .map((e, i) => (e.from === "hwy_v" && e.to === "dst_v1" ? i : -1))
      .filter((i) => i >= 0);
    expect(hvDst1).toHaveLength(3);
    const polys = hvDst1.map((i) => out.polylines.polylines.find((p) => p.edgeIndex === i)!);
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        expect(polylinesCross(polys[i]!, polys[j]!)).toBe(false);
      }
    }
  });

  // Issue from `examples/29-highway-intersect-large.melk`: under the
  // abstract (boundaryIndex, slotIndex) interval encoding, same-row
  // through-traces (src_h2 → hwy_h, no V-leg) appeared to "occupy"
  // their slot-jog range in V1, blocking nearby bundles' real V-leg
  // traces from sharing inner tracks. The result was an interleaved
  // V1 where src_v3's leftmost V-leg sat one column inside src_h1's
  // topmost H-stub end — visible as a crossing in the top-left
  // quadrant of example 29.
  //
  // Pixel-aware interval encoding (see src/layout/tracks.ts comment in
  // `assignTracksInCorridor`) detects the real y-range overlap and
  // doesn't artificially conflict same-row stubs with cross-row V-legs.
  // The leftmost src_v3 V-leg now sits one column further east, clear
  // of src_h1's topmost H stub.
  it("src_v3 leftmost vs src_h1 topmost should not cross (ex 29, pixel-aware encoding)", () => {
    const src = [
      "layout: lr",
      "crossings: 40",
      "hwy_h { shape: highway }",
      "hwy_v { shape: highway, orient: vertical, render: underground }",
      "intersect hwy_h, hwy_v",
      "src_h1 -> dst_h1 { via: hwy_h }",
      "src_h1 -> dst_h2 { via: hwy_h }",
      "src_h1 -> dst_h3 { via: hwy_h }",
      "src_h2 -> dst_h1 { via: hwy_h }",
      "src_h2 -> dst_h2 { via: hwy_h }",
      "src_h2 -> dst_h3 { via: hwy_h }",
      "src_h3 -> dst_h1 { via: hwy_h }",
      "src_h3 -> dst_h2 { via: hwy_h }",
      "src_h3 -> dst_h3 { via: hwy_h }",
      "src_v1 -> dst_v1 { via: hwy_v }",
      "src_v1 -> dst_v2 { via: hwy_v }",
      "src_v1 -> dst_v3 { via: hwy_v }",
      "src_v2 -> dst_v1 { via: hwy_v }",
      "src_v2 -> dst_v2 { via: hwy_v }",
      "src_v2 -> dst_v3 { via: hwy_v }",
      "src_v3 -> dst_v1 { via: hwy_v }",
      "src_v3 -> dst_v2 { via: hwy_v }",
      "src_v3 -> dst_v3 { via: hwy_v }",
    ].join("\n");
    const out = polylines(src);
    const v3l = out.model.edges.findIndex((e) => e.from === "src_v3" && e.viaFirstHalf && e.viaOriginal === 17);
    const h1t = out.model.edges.findIndex((e) => e.from === "src_h1" && e.viaFirstHalf && e.viaOriginal === 0);
    expect(v3l).toBeGreaterThanOrEqual(0);
    expect(h1t).toBeGreaterThanOrEqual(0);
    const pV3 = out.polylines.polylines.find((p) => p.edgeIndex === v3l)!;
    const pH1 = out.polylines.polylines.find((p) => p.edgeIndex === h1t)!;
    expect(polylinesCross(pV3, pH1)).toBe(false);
  });

  // Sanity: the helper detects real crossings. Two trivially crossing
  // segments must return true; non-crossing must return false.
  it("segmentsCross detects a true crossing", () => {
    expect(segmentsCross(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
  });
  it("segmentsCross rejects non-crossing segments", () => {
    expect(segmentsCross(0, 0, 10, 0, 0, 10, 10, 10)).toBe(false);
  });
});
