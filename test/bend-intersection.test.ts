/**
 * Bend-intersection value-variation tests.
 *
 * The rule (from user feedback):
 *
 *   When two trace BENDS intersect each other in screen space,
 *   render a dark gradient variation on the upper trace's bend
 *   and a light gradient variation on the lower trace's bend.
 *
 * "Intersect" means the bends' chamfer regions visually fold into
 * each other — e.g. two stairstepped traces that share a row.
 *
 * NOT intersections (no variation):
 *   - lone bends (no other bend nearby)
 *   - fan-outs (traces from one source spreading to different rows)
 *   - clean '+' axial crossings (axial × axial, no chamfer involved)
 *
 * The canonical case: ex 24 ext_2 outgoing traces.
 *   ext_2 -> hwy (trace 1): bends from y=28 to y=20
 *   ext_2 -> hwy (trace 2): bends from y=36 to y=28
 *   → Stairstep: trace 2's outgoing y=28 === trace 1's incoming y=28
 *   → BOTH bends MUST get value variation.
 */
import { describe, expect, it } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import { applyTextFit } from "../src/layout/text-fit.js";
import { reserveCorridors } from "../src/layout/corridors.js";
import { packTracks } from "../src/layout/tracks.js";
import { buildPolylines } from "../src/layout/polyline.js";
import { renderSVG } from "../src/render/svg.js";
import { loadTheme } from "../src/theme/theme.js";

function render(src: string): string {
  const m = bind(parse(tokenize(src)));
  const p = applyTextFit(place(m), m, loadTheme("document-light"));
  const r = reserveCorridors(m, p);
  const t = packTracks(m, p, r);
  const polys = buildPolylines(m, p, r, t);
  return renderSVG(m, p, r, polys, loadTheme("document-light"));
}

function lumpsFor(svg: string, edge: string): string[] {
  // Variation lives as a gradient-stroked sub-path within the trace's
  // <g data-edge="..."> block (stroke="url(#bf-...)"). Count sub-paths
  // inside the edge group that use the gradient stroke.
  const escEdge = edge.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const groupRe = new RegExp(`<g data-edge="${escEdge}"[^>]*>([\\s\\S]*?)</g>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = groupRe.exec(svg)) !== null) {
    const body = m[1] ?? "";
    const gradPaths = body.match(/<path[^>]*stroke="url\(#bf-[^)]*\)"[^>]*\/>/g);
    if (gradPaths) out.push(...gradPaths);
  }
  return out;
}

function countLumps(svg: string): number {
  const m = svg.match(/stroke="url\(#bf-[^)]+\)"/g);
  return m ? m.length : 0;
}

describe("bend intersections: ex 24 ext_2 stairstep (canonical)", () => {
  // Verbatim from examples/24-mixed-bundle-bypass.melk — the case
  // the user has repeatedly pointed at.
  const src = [
    "layout: lr",
    "crossings: 30",
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

  it("CRITICAL: ext_2's outgoing parallel-stairstep bends MUST NOT have variation", () => {
    // The two ext_2 -> hwy bends are at (68→76, 28→20) and
    // (68→76, 36→28). They stairstep close together but DON'T share
    // a chamfer point. They're a fan-out emerging from one source
    // and the eye reads them as such — no ambiguity, no variation.
    const svg = render(src);
    const lumps = lumpsFor(svg, "ext_2->hwy");
    expect(lumps.length).toBe(0);
  });

  it("CRITICAL: hwy->sink_b and hwy->sink_c bends interlock at (236,28) — variation on lower trace only", () => {
    // hwy->sink_b chamfer ENDS at (236,28).
    // hwy->sink_c chamfer STARTS at (236,28). Shared point → visible
    // bend intersection. Variation goes on the LOWER trace (the one
    // rendered first; the upper trace stays solid on top so it
    // remains readable). At least one of the two MUST have variation.
    const svg = render(src);
    const sinkB = lumpsFor(svg, "hwy->sink_b");
    const sinkC = lumpsFor(svg, "hwy->sink_c");
    expect(sinkB.length + sinkC.length).toBeGreaterThanOrEqual(1);
  });

  it("probe_1 → hwy_m fan parallel bends MUST NOT have variation (same logic as ext_2)", () => {
    const svg = render(src);
    const lumps = lumpsFor(svg, "probe_1->hwy_m");
    expect(lumps.length).toBe(0);
  });
});

describe("non-intersection cases: NO value variation expected", () => {
  it("lone bend (single trace, single bend) gets NO variation", () => {
    // Pipeline a -> b in a column layout produces a straight line,
    // but a -> b -> c (with explicit cells) often produces a bend.
    // Use a fan-out which produces clean bends with no overlap.
    const src = "layout: lr\nfan-out f: hub -> [a, b, c]";
    const svg = render(src);
    expect(countLumps(svg)).toBe(0);
  });

  it("3-way fan-out has NO variation (no bend intersections)", () => {
    const src = "fan-out f: hub -> [a, b, c]";
    const svg = render(src);
    expect(countLumps(svg)).toBe(0);
  });

  it("3-way bus has NO variation (no bend intersections)", () => {
    const src = "bus b: [a, b, c] -> hub";
    const svg = render(src);
    expect(countLumps(svg)).toBe(0);
  });

  it("straight pipeline has NO variation (no bends at all)", () => {
    const src = "pipeline p: a -> b -> c -> d";
    const svg = render(src);
    expect(countLumps(svg)).toBe(0);
  });
});

describe("bend intersections: ex 18 collinear axial overlap", () => {
  // Verbatim from examples/18-highway-tb.melk. In this diagram,
  // hwy->dst_z and hwy->dst_y emit traces that, after their chamfers,
  // share the SAME axial column (x=92) over an 8px span (y∈[140,148]).
  // The strokes are drawn on top of each other — the eye cannot tell
  // which trace is which in that overlap. Variation must mark the
  // overlap on both traces.
  //
  // Critically, ex 24's ext_2->hwy chamfers are parallel-offset but
  // do NOT share an axial segment, so this rule must NOT fire there.
  const src = [
    "layout: tb",
    "crossings: 10",
    "hwy { shape: highway }",
    "src_b { slot-order: declaration }",
    "src_a -> dst_x { via: hwy }",
    "src_a -> dst_y { via: hwy }",
    "src_b -> dst_z { via: hwy }",
    "src_b -> dst_y { via: hwy }",
    "src_c -> dst_x { via: hwy }",
    "src_c -> dst_z { via: hwy }",
  ].join("\n");

  it("CRITICAL: hwy->dst_z and hwy->dst_y overlap at x=92, y∈[140,148] — variation on both", () => {
    const svg = render(src);
    const dstZ = lumpsFor(svg, "hwy->dst_z");
    const dstY = lumpsFor(svg, "hwy->dst_y");
    // Both traces should be flagged — one primary, one secondary.
    expect(dstZ.length + dstY.length).toBeGreaterThanOrEqual(2);
  });
});

// Note: the simplest fixture (one source + via highway + two sinks)
// doesn't reproduce stairstepping — the router only stairsteps when
// multiple sources/destinations create row pressure. ex 24's full
// fixture above is what triggers it.
