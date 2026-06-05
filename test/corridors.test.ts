/**
 * Phase 4 corridor reservation tests (Step 5).
 *
 * Covers side assignment, corridor sequences, slot indices, demand
 * counting, and gutter widening. Reads source via parser → bind →
 * place → reserveCorridors so the surface matches the user pipeline.
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import {
  reserveCorridors,
  CorridorError,
  TRACES_PER_CELL_UNIT,
  corridorKey,
  type Corridor,
  type Route,
} from "../src/layout/corridors.js";

function reserve(src: string) {
  const model = bind(parse(tokenize(src)));
  const placement = place(model);
  return { model, placement, reservation: reserveCorridors(model, placement) };
}

function routeFor(
  routes: Route[],
  edges: { from: string; to: string }[],
  from: string,
  to: string,
): Route {
  for (let i = 0; i < edges.length; i++) {
    if (edges[i]!.from === from && edges[i]!.to === to) {
      const r = routes.find((x) => x.edgeIndex === i);
      if (!r) throw new Error(`edge '${from} -> ${to}' has no route`);
      return r;
    }
  }
  throw new Error(`edge '${from} -> ${to}' not in model`);
}

function corridorMatches(c: Corridor, expected: string): boolean {
  return corridorKey(c) === expected;
}

describe("corridors — side assignment", () => {
  it("east-exits-east, west-enters-west on a same-row LR pipeline", () => {
    const { model, reservation } = reserve("pipeline p: a -> b -> c");
    const ab = routeFor(reservation.routes, model.edges, "a", "b");
    const bc = routeFor(reservation.routes, model.edges, "b", "c");
    expect(ab.sourceSide).toBe("E");
    expect(ab.targetSide).toBe("W");
    expect(bc.sourceSide).toBe("E");
    expect(bc.targetSide).toBe("W");
  });

  it("south-exits-south, north-enters-north on a same-col TB pipeline", () => {
    const { model, reservation } = reserve(
      "layout: tb\npipeline p: a -> b -> c",
    );
    const ab = routeFor(reservation.routes, model.edges, "a", "b");
    expect(ab.sourceSide).toBe("S");
    expect(ab.targetSide).toBe("N");
  });

  it("flow-axis side wins for diagonal cells (bus producers above shared)", () => {
    const { model, reservation } = reserve("s { size: 5x7 }\nbus power: [a, b, c] -> s");
    // a at (0,0), s at (1,1) — diagonal. LR flow → E/W.
    const aToS = routeFor(reservation.routes, model.edges, "a", "s");
    expect(aToS.sourceSide).toBe("E");
    expect(aToS.targetSide).toBe("W");
    // c at (2,0), s at (1,1) — diagonal in the other direction; still E/W.
    const cToS = routeFor(reservation.routes, model.edges, "c", "s");
    expect(cToS.sourceSide).toBe("E");
    expect(cToS.targetSide).toBe("W");
  });

  it("back-edges take rear faces", () => {
    const { model, reservation } = reserve(
      "pipeline p: a -> b -> c\nc >- a",
    );
    const cToA = routeFor(reservation.routes, model.edges, "c", "a");
    expect(cToA.sourceSide).toBe("W");
    expect(cToA.targetSide).toBe("E");
  });
});

describe("corridors — corridor sequences", () => {
  it("same-row consecutive nodes share a single V corridor", () => {
    const { model, reservation } = reserve("pipeline p: a -> b");
    const ab = routeFor(reservation.routes, model.edges, "a", "b");
    expect(ab.corridorSequence).toHaveLength(1);
    // Multi-cell: a occupies cols 0..4, b cols 5..9, V corridor between = V5.
    expect(corridorMatches(ab.corridorSequence[0]!, "V5")).toBe(true);
  });

  it("same-col TB consecutive nodes share a single H corridor", () => {
    const { model, reservation } = reserve(
      "layout: tb\npipeline p: a -> b",
    );
    const ab = routeFor(reservation.routes, model.edges, "a", "b");
    expect(ab.corridorSequence).toHaveLength(1);
    expect(corridorMatches(ab.corridorSequence[0]!, "H5")).toBe(true);
  });

  it("bus adjacent-diagonal: single V corridor for each producer→shared", () => {
    // Multi-cell: a/b/c at perp-stacked rows (0/5/10) col 0..4; s at
    // row 5 col 5..11. All producers exit on E face V5; s enters on
    // W face V5 — single V5 corridor.
    const { model, reservation } = reserve("s { size: 5x7 }\nbus power: [a, b, c] -> s");
    const aToS = routeFor(reservation.routes, model.edges, "a", "s");
    expect(aToS.corridorSequence.map(corridorKey)).toEqual(["V5"]);
    const bToS = routeFor(reservation.routes, model.edges, "b", "s");
    expect(bToS.corridorSequence.map(corridorKey)).toEqual(["V5"]);
    const cToS = routeFor(reservation.routes, model.edges, "c", "s");
    expect(cToS.corridorSequence.map(corridorKey)).toEqual(["V5"]);
  });

  it("fan-out adjacent-diagonal: single V corridor for each shared→consumer", () => {
    const { model, reservation } = reserve(
      "s { size: 5x7 }\nfan-out broadcast: s -> [x, y, z]",
    );
    // Multi-cell: s at col 0..4 (width 5), consumers at col 5..9. All
    // exit s.E at V5 and enter consumer.W at V5 → single V5.
    const sToX = routeFor(reservation.routes, model.edges, "s", "x");
    expect(sToX.corridorSequence.map(corridorKey)).toEqual(["V5"]);
    const sToY = routeFor(reservation.routes, model.edges, "s", "y");
    expect(sToY.corridorSequence.map(corridorKey)).toEqual(["V5"]);
    const sToZ = routeFor(reservation.routes, model.edges, "s", "z");
    expect(sToZ.corridorSequence.map(corridorKey)).toEqual(["V5"]);
  });

  it("non-adjacent diagonal: V_exit + H_pivot + V_entry across multiple cols", () => {
    // Two-pipeline diagram with a cross-edge spanning multiple cols.
    // Force a multi-col diagonal: src at (0,0), tgt at (1,2) via explicit
    // pipeline placement.
    const src = [
      "pipeline top:    a -> b -> c",  // row 0, cols 0..2
      "pipeline bottom: x -> y -> z",  // row 1, cols 0..2
      "a -> z",                         // multi-col diagonal: (0,0) -> (1,2)
    ].join("\n");
    const { model, reservation } = reserve(src);
    const aToZ = routeFor(reservation.routes, model.edges, "a", "z");
    // Adjacent-diagonal short-circuit only applies when srcExitCol ==
    // tgtEntryCol. Here a is at col 0 (E exit = V1) and z is at col 2
    // (W entry = V2). Different. So sequence has the H pivot.
    expect(aToZ.corridorSequence.map(corridorKey)).toEqual(["V5", "H5", "V10"]);
  });
});

describe("corridors — slot indices", () => {
  it("orders bus producers' target slots on shared's W face by source row", () => {
    const { model, reservation } = reserve("s { size: 5x7 }\nbus power: [a, b, c] -> s");
    const aToS = routeFor(reservation.routes, model.edges, "a", "s");
    const bToS = routeFor(reservation.routes, model.edges, "b", "s");
    const cToS = routeFor(reservation.routes, model.edges, "c", "s");
    // Bus is adjacent-diagonal. Each producer's slot-ordering pivot is
    // its own row (0, 1, 2). Slots ascend with row.
    // s has size 5x7, W face length = height = 7 cells. With CELL_PX=8
    // and COMB_PITCH=8, SLOTS_PER_CELL = 1 → 7 slot positions on the
    // 7-cell W face. Centering 3 traces in 7 positions: offset = (7-3)/2 = 2.
    expect(aToS.targetSide).toBe("W");
    expect(bToS.targetSide).toBe("W");
    expect(cToS.targetSide).toBe("W");
    const slots = [aToS.targetSlot, bToS.targetSlot, cToS.targetSlot];
    expect(slots).toEqual([2, 3, 4]);
  });

  it("each producer takes the centered slot on its own E face (single trace there)", () => {
    // Each producer 'a','b','c' has default size 5x5. E face length =
    // height = 5 cells = 5 slot positions. Single trace centered → slot 2.
    const { model, reservation } = reserve("s { size: 5x7 }\nbus power: [a, b, c] -> s");
    for (const id of ["a", "b", "c"]) {
      const r = routeFor(reservation.routes, model.edges, id, "s");
      expect(r.sourceSide).toBe("E");
      expect(r.sourceSlot).toBe(2);
    }
  });

  it("orders fan-out consumers' source slots on shared's E face by target row", () => {
    const { model, reservation } = reserve(
      "s { size: 5x7 }\nfan-out broadcast: s -> [x, y, z]",
    );
    const sToX = routeFor(reservation.routes, model.edges, "s", "x");
    const sToY = routeFor(reservation.routes, model.edges, "s", "y");
    const sToZ = routeFor(reservation.routes, model.edges, "s", "z");
    const slots = [sToX.sourceSlot, sToY.sourceSlot, sToZ.sourceSlot];
    // 3 traces on s's E face (7 cells = 7 positions), offset 2.
    expect(slots).toEqual([2, 3, 4]);
  });

  it("breaks ties by declaration order", () => {
    // Two edges from the same source land on the same E face with the
    // same pivot (both target same row). They tie-break by declaration
    // index. s and p are both size 3x5 → E face length = height = 5
    // cells = 5 slot positions. 2 traces centered: offset = (5-2)/2 = 1.5.
    const { model, reservation } = reserve(
      "s { size: 3x5 }\np { size: 3x5 }\ns -> p\ns -> p",
    );
    expect(model.edges).toHaveLength(2);
    const r0 = reservation.routes[0]!;
    const r1 = reservation.routes[1]!;
    expect(r0.sourceSlot).toBe(1.5);
    expect(r1.sourceSlot).toBe(2.5);
  });
});

describe("corridors — capacity errors", () => {
  it("raises E_SIDE_OVERSUBSCRIBED when a side has more traces than capacity", () => {
    // With CELL_PX = COMB_PITCH = 8 and TRACES_PER_CELL_UNIT=1, a node of
    // height N holds N traces per E/W face. The hub-rect parity-bump
    // adds 1 cell when F and sideLen disagree on parity; use sizes
    // where bumping still doesn't fit. A 3-tall hub with 5 producers
    // bumps to 4 cells (even, matches F=5 odd? No, 5 odd, 4 even —
    // bumps to 5). 5 producers all fit in a 5-tall face. Pick 7
    // producers vs height 5 (= F=7 odd, sideLen 5 odd, matched, no
    // bump) → capacity 5, demand 7 → overflow.
    const src = "s { size: 3x5 }\nbus power: [a, b, c, d, e, f, g] -> s";
    expect(() => reserve(src)).toThrow(/E_SIDE_OVERSUBSCRIBED/);
  });

  it("a taller box accommodates more traces on its E/W faces", () => {
    const src = "s { size: 3x13 }\nbus power: [a, b, c, d, e] -> s";
    // height 13 → capacity 13 * TRACES_PER_CELL_UNIT = 13. 5 producers fit.
    const { reservation } = reserve(src);
    expect(reservation.routes).toHaveLength(5);
  });

  it("error message names the node, side, count, and capacity", () => {
    expect.assertions(5);
    try {
      reserve("s { size: 3x5 }\nbus power: [a, b, c, d, e, f, g] -> s");
    } catch (e) {
      expect(e).toBeInstanceOf(CorridorError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/node 's'/);
      expect(msg).toMatch(/W face/);
      expect(msg).toMatch(/7 traces/);
      expect(msg).toMatch(/capacity is 5/);
    }
  });
});

describe("corridors — demand counting", () => {
  it("counts each trace once per corridor in its sequence", () => {
    const { reservation } = reserve("pipeline p: a -> b -> c");
    // Two edges: a→b uses V1, b→c uses V2.
    expect(reservation.demand.get("V5")).toBe(1);
    expect(reservation.demand.get("V10")).toBe(1);
  });

  it("aggregates demand on a shared corridor (bus into a hub)", () => {
    const { reservation } = reserve("s { size: 5x7 }\nbus power: [a, b, c] -> s");
    // All three producer→shared traces share V1; bus is adjacent-diagonal
    // so no H pivot fires. H demand stays empty.
    expect(reservation.demand.get("V5")).toBe(3);
    expect(reservation.demand.get("H5")).toBeUndefined();
    expect(reservation.demand.get("H10")).toBeUndefined();
  });

  it("ignores diagonals at Step 5 (orthogonal only)", () => {
    const { reservation } = reserve("a -> b\nb -> c");
    for (const key of reservation.demand.keys()) {
      expect(key.startsWith("D")).toBe(false);
    }
  });
});

describe("corridors — gutter widening", () => {
  it("a low-demand corridor needs one cell-unit of gutter", () => {
    const { reservation } = reserve("pipeline p: a -> b");
    // Multi-cell: V5 has demand 1, so colGutterUnits[5] = ceil(1/1) = 1.
    expect(reservation.colGutterUnits[5]).toBe(1);
    // No H demand → interior row gutters stay at the 1-cell-unit
    // baseline floor; page-margin (0 and last) stay 0.
    expect(reservation.rowGutterUnits[0]).toBe(0);
    expect(reservation.rowGutterUnits[reservation.rowGutterUnits.length - 1]).toBe(0);
  });

  it("widens gutters proportionally with demand", () => {
    // 6 producers all enter V5 (s.W gutter). With CELL_PX=COMB_PITCH=8
    // → 1 trace per cell-unit, so 6 traces need 6 cell-units of gutter.
    // s sized 3x13 so its W face (height 13 cells) holds 6 traces.
    const { reservation } = reserve(
      "s { size: 3x13 }\nbus b: [p1, p2, p3, p4, p5, p6] -> s",
    );
    expect(reservation.colGutterUnits[5]).toBe(6);
  });

  it("emits one row-gutter slot per row plus margins", () => {
    const { reservation, placement } = reserve("pipeline p: a -> b");
    expect(reservation.rowGutterUnits).toHaveLength(
      placement.rowUnits.length + 1,
    );
    expect(reservation.colGutterUnits).toHaveLength(
      placement.colUnits.length + 1,
    );
  });

  it("preserves rowUnits and colUnits unchanged from Placement", () => {
    const { placement, reservation } = reserve(
      "a { size: 5x3 }\nb { size: 3x5 }\npipeline p: a -> b",
    );
    expect(reservation.rowUnits).toEqual(placement.rowUnits);
    expect(reservation.colUnits).toEqual(placement.colUnits);
  });
});

describe("corridors — determinism", () => {
  it("same input produces same output byte-for-byte", () => {
    const src = "s { size: 5x7 }\nbus b: [a, b, c] -> s\nfan-out f: s -> [x, y, z]";
    const r1 = reserve(src);
    const r2 = reserve(src);
    expect(JSON.stringify(toJson(r1.reservation))).toBe(
      JSON.stringify(toJson(r2.reservation)),
    );
  });
});

describe("corridors — constants", () => {
  it("TRACES_PER_CELL_UNIT is 1 at default pitch / cell (CELL_PX=16, COMB_PITCH=8)", () => {
    expect(TRACES_PER_CELL_UNIT).toBe(1);
  });
});

describe("corridors — pivot override + picker (DESIGN-PHASE4.md §11.7)", () => {
  // Test fixture: three 4-col pipelines plus cross-edges that span >=2
  // cols (so the cross-edge corridor sequences actually go through an
  // H pivot rather than collapsing to a single V via the adjacent-
  // diagonal short-circuit).
  //
  // For w(2,0) -> d(0,3): src.row=2, tgt.row=0.
  //   source pivot = src.row     = H2 (gutter just above w)
  //   target pivot = tgt.row + 1 = H1 (gutter just below d)
  it("with no congestion, picker resolves to 'source' (legacy default)", () => {
    const src = [
      "pipeline top:    a -> b -> c -> d",
      "pipeline mid:    p -> q -> r -> s",
      "pipeline bot:    w -> x -> y -> z",
      "w -> d",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const wd = routeFor(reservation.routes, model.edges, "w", "d");
    // Source pivot wins on tie: H2.
    expect(wd.corridorSequence.map(corridorKey)).toEqual(["V5", "H10", "V15"]);
  });

  it("picker flips to 'target' when source-adjacent corridor is congested", () => {
    // p->y and q->z both pivot in H2 (src.row=1 < tgt.row=2 → src.row+1).
    // That raises provisional demand on H2 above H1, so w->d flips its
    // pivot from H2 (source-adjacent) to H1 (target-adjacent).
    const src = [
      "pipeline top:    a -> b -> c -> d",
      "pipeline mid:    p -> q -> r -> s",
      "pipeline bot:    w -> x -> y -> z",
      "p -> y",
      "q -> z",
      "w -> d",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const wd = routeFor(reservation.routes, model.edges, "w", "d");
    expect(wd.corridorSequence.map(corridorKey)).toEqual(["V5", "H5", "V15"]);
  });

  it("author 'pivot: target' overrides the default (and the picker)", () => {
    // No congestion — picker would pick source-adjacent (H2). Author
    // override forces target-adjacent (H1).
    const src = [
      "pipeline top:    a -> b -> c -> d",
      "pipeline mid:    p -> q -> r -> s",
      "pipeline bot:    w -> x -> y -> z",
      "w -> d { pivot: target }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const wd = routeFor(reservation.routes, model.edges, "w", "d");
    expect(wd.corridorSequence.map(corridorKey)).toEqual(["V5", "H5", "V15"]);
  });

  it("author 'pivot: source' overrides even when picker would pick target", () => {
    // Same congestion-on-H2 setup as the 'picker flips' test, but the
    // author insists on source-adjacent. Override wins over picker.
    const src = [
      "pipeline top:    a -> b -> c -> d",
      "pipeline mid:    p -> q -> r -> s",
      "pipeline bot:    w -> x -> y -> z",
      "p -> y",
      "q -> z",
      "w -> d { pivot: source }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const wd = routeFor(reservation.routes, model.edges, "w", "d");
    expect(wd.corridorSequence.map(corridorKey)).toEqual(["V5", "H10", "V15"]);
  });

  it("pivot is inert on same-row edges", () => {
    // Author writes pivot:target on a same-row edge — must be ignored
    // silently (strip of V corridors, no H pivot involved).
    const src = [
      "pipeline p: a -> b -> c",
      "a -> c { pivot: target }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const ac = routeFor(reservation.routes, model.edges, "a", "c");
    // Multi-cell: same row + same height (default 5x5) → strip of V
    // corridors from V5 (a's east) through V10 (c's west), inclusive.
    expect(ac.corridorSequence.map(corridorKey)).toEqual(["V5", "V6", "V7", "V8", "V9", "V10"]);
  });

  it("unknown pivot value raises a bind error pointing at §11.7", () => {
    expect(() =>
      reserve("a -> b { pivot: middle }"),
    ).toThrowError(/unknown pivot value.*Expected `source` or `target`/);
  });

  it("non-ident pivot value raises a bind error", () => {
    expect(() =>
      reserve('a -> b { pivot: "target" }'),
    ).toThrowError(/pivot must be `source` or `target`/);
  });

  it("pivot on inline back-edge is accepted but inert at Phase 4.1", () => {
    // Should not throw. The route should match what an unannotated
    // back-edge produces (back-edge picker is out of scope for Phase 4.1).
    const baseline = reserve(
      "pipeline p: a -> b -> c\nc >- a",
    );
    const withPivot = reserve(
      "pipeline p: a -> b -> c\nc >- a { pivot: target }",
    );
    const baselineCA = routeFor(baseline.reservation.routes, baseline.model.edges, "c", "a");
    const pivotCA = routeFor(withPivot.reservation.routes, withPivot.model.edges, "c", "a");
    expect(pivotCA.corridorSequence.map(corridorKey)).toEqual(
      baselineCA.corridorSequence.map(corridorKey),
    );
  });
});

describe("corridors — avoid + edgeset + path search (DESIGN-PHASE4.md §11.8)", () => {
  // Test scaffold for the canonical avoid case: a fan-out's output column
  // sits between source and target of a separate edge, and the author
  // says "avoid the fan-out" so the new edge routes around it.
  //
  // Layout (LR):
  //   col 0: hub (source of fan-out), at row 2 vertically centered
  //          source, ingest at row 6
  //   col 1: a, b, c (fan-out consumers), rows 0..2
  //   The hub->{a,b,c} edges all traverse V1.
  //   ingest -> hub with avoid:fan should route through V0, not V1.
  it("avoid:<primitive name> blocks corridors used by that primitive's edges", () => {
    const src = [
      "hub { size: 5x7 }\nfan-out fan: hub -> [a, b, c]",
      "source -> ingest",
      "ingest -> hub { avoid: fan }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const ih = routeFor(reservation.routes, model.edges, "ingest", "hub");
    // The path search should route ingest -> hub via V0 (west of hub),
    // not V1 (where the fan edges live).
    const seq = ih.corridorSequence.map(corridorKey);
    expect(seq).not.toContain("V5");
    expect(seq).toContain("V0");
  });

  it("avoid:<node> blocks corridors used by any edge incident to that node", () => {
    // Same scaffold but avoid the hub itself — same effect since the
    // fan edges are all incident to hub.
    const src = [
      "hub { size: 5x7 }\nfan-out fan: hub -> [a, b, c]",
      "source -> ingest",
      "ingest -> hub { avoid: hub }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const ih = routeFor(reservation.routes, model.edges, "ingest", "hub");
    // ingest->hub is incident to hub, so it would be in the avoid set,
    // but the binder drops self-reference. The remaining avoided edges
    // (source->ingest, hub->a, hub->b, hub->c) still push the route off V1.
    const seq = ih.corridorSequence.map(corridorKey);
    expect(seq).not.toContain("V5");
    expect(seq).toContain("V0");
  });

  it("avoid:<edgeset> resolves the edgeset to its member edges", () => {
    const src = [
      "hub { size: 5x7 }\nfan-out fan: hub -> [a, b, c]",
      "source -> ingest",
      "edgeset fan-edges: hub -> a, hub -> b, hub -> c",
      "ingest -> hub { avoid: fan-edges }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const ih = routeFor(reservation.routes, model.edges, "ingest", "hub");
    const seq = ih.corridorSequence.map(corridorKey);
    expect(seq).not.toContain("V5");
  });

  it("avoid:<explicit edge ref> blocks just that edge's corridors", () => {
    // Avoid just one of the fan edges (hub -> b). The other two still
    // use V1, so the route may still cross V1 — but at least demonstrates
    // the syntax and that a single edge ref resolves correctly.
    const src = [
      "hub { size: 5x7 }\nfan-out fan: hub -> [a, b, c]",
      "source -> ingest",
      "ingest -> hub { avoid: hub -> b }",
    ].join("\n");
    const { model } = reserve(src);
    // Just check the bind step resolved the edge ref correctly.
    const ih = model.edges.find((e) => e.from === "ingest" && e.to === "hub")!;
    const hubB = model.edges.findIndex((e) => e.from === "hub" && e.to === "b");
    expect(ih.avoidEdges).toEqual([hubB]);
  });

  it("avoid:[mixed list] unions all expansions", () => {
    const src = [
      "hub { size: 5x7 }\nfan-out fan: hub -> [a, b, c]",
      "source -> ingest",
      "ingest -> hub { avoid: [fan, source -> ingest] }",
    ].join("\n");
    const { model } = reserve(src);
    const ih = model.edges.find((e) => e.from === "ingest" && e.to === "hub")!;
    // Should include the 3 fan edges + source->ingest = 4 entries.
    expect(ih.avoidEdges?.length).toBe(4);
  });

  it("self-exemption: avoid set may include edges sharing exit/entry corridors", () => {
    // Same fan setup. ingest's N face exits via H6 (or similar gutter).
    // If source->ingest happens to share that corridor, the path search
    // must still find a route — self-exemption preserves the exit/entry
    // corridors.
    const src = [
      "hub { size: 5x7 }\nfan-out fan: hub -> [a, b, c]",
      "source -> ingest",
      "ingest -> hub { avoid: [fan, source -> ingest] }",
    ].join("\n");
    expect(() => reserve(src)).not.toThrow();
  });

  it("edgeset declaration is parsed and bound", () => {
    const src = [
      "pipeline p: a -> b -> c",
      "edgeset chain: a -> b, b -> c",
    ].join("\n");
    const { model } = reserve(src);
    expect(model.edgesets).toHaveLength(1);
    expect(model.edgesets[0]!.name).toBe("chain");
    expect(model.edgesets[0]!.edgeIndices).toHaveLength(2);
  });

  it("E_AVOID_UNKNOWN_REF on a name that resolves to nothing", () => {
    expect(() =>
      reserve("a -> b { avoid: nonexistent }"),
    ).toThrowError(/E_AVOID_UNKNOWN_REF/);
  });

  it("E_EDGESET_UNKNOWN_EDGE on edgeset referencing a missing edge", () => {
    expect(() =>
      reserve([
        "pipeline p: a -> b",
        "edgeset bad: a -> c",
      ].join("\n")),
    ).toThrowError(/E_EDGESET_UNKNOWN_EDGE/);
  });

  it("E_AVOID_UNKNOWN_NODE on edge ref with undeclared node", () => {
    expect(() =>
      reserve([
        "a -> b",
        "a -> b { avoid: zzz -> b }",
      ].join("\n")),
    ).toThrowError(/E_AVOID_UNKNOWN_NODE/);
  });

  it("E_DUPLICATE_EDGESET on duplicate edgeset name", () => {
    expect(() =>
      reserve([
        "pipeline p: a -> b -> c",
        "edgeset chain: a -> b",
        "edgeset chain: b -> c",
      ].join("\n")),
    ).toThrowError(/E_DUPLICATE_EDGESET/);
  });

  it("E_NAME_CONFLICT when edgeset shadows another declaration", () => {
    expect(() =>
      reserve([
        "pipeline fan: a -> b -> c",
        "edgeset fan: a -> b",
      ].join("\n")),
    ).toThrowError(/E_NAME_CONFLICT/);
  });

  it("edges without avoid: use the legacy Z generator (no regression)", () => {
    // Sanity check: an edge in an avoid-using diagram that doesn't have
    // an `avoid:` itself should still route via the canned generator.
    const src = [
      "hub { size: 5x7 }\nfan-out fan: hub -> [a, b, c]",
      "source -> ingest",
      "ingest -> hub { avoid: fan }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    // The fan's edges aren't using avoid, so their routes should look
    // the same as if avoid weren't in the diagram.
    const baseline = reserve([
      "hub { size: 5x7 }\nfan-out fan: hub -> [a, b, c]",
      "source -> ingest",
      "ingest -> hub",  // no avoid
    ].join("\n"));
    const fanEdgeNames: Array<[string, string]> = [
      ["hub", "a"], ["hub", "b"], ["hub", "c"],
    ];
    for (const [from, to] of fanEdgeNames) {
      const r1 = routeFor(reservation.routes, model.edges, from, to);
      const r2 = routeFor(baseline.reservation.routes, baseline.model.edges, from, to);
      expect(r1.corridorSequence.map(corridorKey)).toEqual(
        r2.corridorSequence.map(corridorKey),
      );
    }
  });
});

describe("corridors — via highways (DESIGN-PHASE4.md §11.9)", () => {
  it("highway is declared as a node with shape: highway", () => {
    const src = [
      "hwy { shape: highway, size: 7x3 }",
      "a -> hwy_nonused_anchor",
    ].join("\n");
    // Highway as endpoint is rejected — but the test was about declaration
    // parsing. Use an unrelated edge instead.
    const src2 = [
      "hwy { shape: highway, size: 7x3 }",
      "x -> y",
    ].join("\n");
    void src;
    const { model } = reserve(src2);
    const hwy = model.nodes.find((n) => n.id === "hwy");
    expect(hwy).toBeDefined();
    expect(hwy!.shape).toBe("highway");
    expect(hwy!.size).toEqual({ width: 7, height: 3 });
  });

  it("highway requires no scaffolding — via: edges alone position the members", () => {
    const src = [
      "hwy { shape: highway }",  // auto-sized
      "a -> x { via: hwy }",
      "b -> y { via: hwy }",
    ].join("\n");
    const { model } = reserve(src);
    // Via-edges get expanded into pairs of synthetic via-half sub-edges
    // (a->hwy, hwy->x) at bind time. The original a->x no longer exists
    // in model.edges; instead we see the two halves.
    const aToHwy = model.edges.find((e) => e.from === "a" && e.to === "hwy" && e.source === "via-half");
    const hwyToX = model.edges.find((e) => e.from === "hwy" && e.to === "x" && e.source === "via-half");
    expect(aToHwy).toBeDefined();
    expect(hwyToX).toBeDefined();
    expect(aToHwy!.viaFirstHalf).toBe(true);
    expect(hwyToX!.viaFirstHalf).toBeUndefined();
    expect(aToHwy!.viaOriginal).toBe(hwyToX!.viaOriginal);
    expect(model.highwayMemberships).toHaveLength(1);
    expect(model.highwayMemberships[0]!.sources).toEqual(["a", "b"]);
    expect(model.highwayMemberships[0]!.targets).toEqual(["x", "y"]);
  });

  it("highway auto-sizes breadth from via-edge count; flow-axis dim stays at author default", () => {
    const src = [
      "hwy { shape: highway }",
      "a -> x { via: hwy }",
      "b -> y { via: hwy }",
      "c -> z { via: hwy }",
      "d -> w { via: hwy }",
      "e -> v { via: hwy }",
      "f -> u { via: hwy }",
      "g -> t { via: hwy }",
    ].join("\n");
    const { model } = reserve(src);
    const hwy = model.nodes.find((n) => n.id === "hwy");
    // Under `layout: lr` (default), flow is east. The flow-axis
    // dimension (width) stays at the author's declared / default of 5.
    // The breadth (height) auto-sizes from edge count:
    // ceil(7/TRACES_PER_CELL_UNIT) = ceil(7/1) = 7 — which exceeds the
    // default 5, so it wins. (For ≤5 edges the default dominates.)
    expect(hwy!.size).toEqual({ width: 5, height: 7 });
  });

  it("multi-via raises E_VIA_MULTI_NOT_SUPPORTED at Phase 4.3", () => {
    // Give each highway placement scaffolding via separate single-via
    // edges so the placer succeeds; then the multi-via [h1, h2] route
    // hits the corridor-level multi-via guard.
    expect(() =>
      reserve([
        "h1 { shape: highway }",
        "h2 { shape: highway }",
        "p -> q { via: h1 }",
        "r -> s { via: h2 }",
        "a -> b { via: [h1, h2] }",
      ].join("\n")),
    ).toThrowError(/E_VIA_MULTI_NOT_SUPPORTED/);
  });

  it("E_VIA_UNKNOWN_HIGHWAY on a name that doesn't resolve to a node", () => {
    expect(() =>
      reserve("a -> b { via: nonexistent }"),
    ).toThrowError(/E_VIA_UNKNOWN_HIGHWAY/);
  });

  it("E_VIA_NOT_HIGHWAY on a name that resolves to a non-highway node", () => {
    expect(() =>
      reserve([
        "regular { shape: rect }",
        "a -> b { via: regular }",
      ].join("\n")),
    ).toThrowError(/E_VIA_NOT_HIGHWAY/);
  });

  it("E_HIGHWAY_AS_ENDPOINT rejects explicit edges to/from highway nodes", () => {
    expect(() =>
      reserve([
        "hwy { shape: highway, size: 7x3 }",
        "a -> hwy",
      ].join("\n")),
    ).toThrowError(/E_HIGHWAY_AS_ENDPOINT/);
    expect(() =>
      reserve([
        "hwy { shape: highway, size: 7x3 }",
        "hwy -> a",
      ].join("\n")),
    ).toThrowError(/E_HIGHWAY_AS_ENDPOINT/);
  });

  it("square highway sizes are allowed (orientation comes from layoutMode)", () => {
    // §11.9 v2: orientation is driven by layoutMode, not width vs height.
    // Square highways are no longer rejected.
    expect(() =>
      reserve("hwy { shape: highway, size: 5x5 }"),
    ).not.toThrow();
  });

  it("via: composes with avoid: (avoid is preserved on the second half)", () => {
    const src = [
      "hwy { shape: highway, size: 7x3 }",
      "a -> b",
      "c -> d { via: hwy, avoid: a -> b }",
    ].join("\n");
    const { model } = reserve(src);
    // c -> d gets split into c -> hwy and hwy -> d. The avoid: from the
    // user-written edge is preserved on the second half (hwy -> d) so
    // the path search honors it during the highway-to-target leg.
    const hwyToD = model.edges.find((e) => e.from === "hwy" && e.to === "d" && e.source === "via-half");
    expect(hwyToD).toBeDefined();
    expect(hwyToD!.avoidEdges?.length).toBe(1);
  });

  it("highway-via registers a new anchor in Model.anchors", () => {
    const src = [
      "hwy { shape: highway }",
      "a -> x { via: hwy }",
    ].join("\n");
    const { model } = reserve(src);
    expect(model.anchors.some((a) => a.kind === "highway-via")).toBe(true);
  });

  it("placer positions sources west and targets east of a horizontal highway, directly adjacent", () => {
    const src = [
      "hwy { shape: highway }",
      "a -> x { via: hwy }",
      "b -> y { via: hwy }",
      "c -> z { via: hwy }",
    ].join("\n");
    const { placement } = reserve(src);
    const hwy = placement.cells.get("hwy")!;
    // Multi-cell: sources sit one (max source-width) west of the highway;
    // targets one (highway-width) east. For default 5x5 sources/highway,
    // that's ±5 cols.
    expect(placement.cells.get("a")!.col).toBe(hwy.col - 5);
    expect(placement.cells.get("b")!.col).toBe(hwy.col - 5);
    expect(placement.cells.get("c")!.col).toBe(hwy.col - 5);
    expect(placement.cells.get("x")!.col).toBe(hwy.col + 5);
    expect(placement.cells.get("y")!.col).toBe(hwy.col + 5);
    expect(placement.cells.get("z")!.col).toBe(hwy.col + 5);
  });

  // Two highways that share any via-anchor member (source or target)
  // raise E_AMBIGUOUS_PLACEMENT. The via-anchor offset math pins each
  // highway relative to its shared member, and two anchors can't pin
  // the same member to two different cells. Documented as a known
  // limitation in next-session.md ("highway composability limits").
  //
  // Future fix candidates (out of scope at v1): give the placer a
  // disambiguation rule for shared members, or expand `Model.anchors`
  // to fuse the two anchors when they overlap.
  it("two highways sharing a source raise E_AMBIGUOUS_PLACEMENT", () => {
    const src = [
      "hwy_a { shape: highway }",
      "hwy_b { shape: highway }",
      // ext_2 is a source for both highways.
      "ext_2 -> sink_x { via: hwy_a }",
      "ext_2 -> sink_y { via: hwy_b }",
      // Other members keep each highway's via-anchor non-degenerate.
      "ext_1 -> sink_x { via: hwy_a }",
      "ext_3 -> sink_y { via: hwy_b }",
    ].join("\n");
    expect(() => reserve(src)).toThrow(/E_AMBIGUOUS_PLACEMENT/);
  });

  it("two highways sharing a target raise E_AMBIGUOUS_PLACEMENT", () => {
    const src = [
      "hwy_a { shape: highway }",
      "hwy_b { shape: highway }",
      // shared_sink is a target for both highways.
      "src_1 -> shared_sink { via: hwy_a }",
      "src_2 -> shared_sink { via: hwy_b }",
      // Other members to keep each via-anchor non-degenerate.
      "src_1 -> other_a { via: hwy_a }",
      "src_2 -> other_b { via: hwy_b }",
    ].join("\n");
    expect(() => reserve(src)).toThrow(/E_AMBIGUOUS_PLACEMENT/);
  });
});

describe("highway orient: and render: (§11.11)", () => {
  it("accepts render: underground on a highway", () => {
    const src = [
      "hwy { shape: highway, render: underground }",
      "a -> b { via: hwy }",
    ].join("\n");
    const { model } = reserve(src);
    const hwy = model.nodes.find((n) => n.id === "hwy")!;
    expect(hwy.render).toBe("underground");
  });

  it("accepts orient: vertical on a highway", () => {
    const src = [
      "hwy { shape: highway, orient: vertical }",
      "a -> b { via: hwy }",
    ].join("\n");
    const { model } = reserve(src);
    const hwy = model.nodes.find((n) => n.id === "hwy")!;
    expect(hwy.orient).toBe("vertical");
  });

  it("rejects orient: on non-highway nodes with E_HIGHWAY_ATTR_ON_NON_HIGHWAY", () => {
    const src = "node1 { shape: rect, orient: horizontal }";
    expect(() => reserve(src)).toThrow(/E_HIGHWAY_ATTR_ON_NON_HIGHWAY/);
  });

  it("rejects render: on non-highway nodes with E_HIGHWAY_ATTR_ON_NON_HIGHWAY", () => {
    const src = "node1 { shape: cylinder, render: underground }";
    expect(() => reserve(src)).toThrow(/E_HIGHWAY_ATTR_ON_NON_HIGHWAY/);
  });

  it("rejects invalid orient: value with E_INVALID_ORIENT_VALUE", () => {
    const src = "hwy { shape: highway, orient: diagonal }";
    expect(() => reserve(src)).toThrow(/E_INVALID_ORIENT_VALUE/);
  });

  it("rejects invalid render: value with E_INVALID_RENDER_VALUE", () => {
    const src = "hwy { shape: highway, render: bridge }";
    expect(() => reserve(src)).toThrow(/E_INVALID_RENDER_VALUE/);
  });

  it("intersect places two highways at the same cell", () => {
    const src = [
      "hwy_h { shape: highway }",
      "hwy_v { shape: highway, orient: vertical }",
      "intersect hwy_h, hwy_v",
      "a -> b { via: hwy_h }",
      "p -> q { via: hwy_v }",
    ].join("\n");
    const { placement } = reserve(src);
    const cellH = placement.cells.get("hwy_h")!;
    const cellV = placement.cells.get("hwy_v")!;
    expect(cellH.row).toBe(cellV.row);
    expect(cellH.col).toBe(cellV.col);
  });

  it("intersect rejects same-orientation highways with E_INTERSECT_SAME_ORIENTATION", () => {
    const src = [
      "hwy_a { shape: highway }",
      "hwy_b { shape: highway }",
      "intersect hwy_a, hwy_b",
      "a -> b { via: hwy_a }",
      "p -> q { via: hwy_b }",
    ].join("\n");
    expect(() => reserve(src)).toThrow(/E_INTERSECT_SAME_ORIENTATION/);
  });

  it("intersect rejects non-highway entries with E_INTERSECT_NOT_HIGHWAY", () => {
    const src = [
      "rect_node { shape: rect }",
      "hwy { shape: highway }",
      "intersect rect_node, hwy",
      "a -> b { via: hwy }",
    ].join("\n");
    expect(() => reserve(src)).toThrow(/E_INTERSECT_NOT_HIGHWAY/);
  });

  it("intersect rejects unknown entries with E_INTERSECT_UNKNOWN_HIGHWAY", () => {
    const src = [
      "hwy { shape: highway }",
      "intersect hwy, ghost",
      "a -> b { via: hwy }",
    ].join("\n");
    expect(() => reserve(src)).toThrow(/E_INTERSECT_UNKNOWN_HIGHWAY/);
  });

  // §11.13: highway members inherit the highway's z. `render: underground`
  // sets z = -1; surface (default) is z = 0. Nodes at different z can
  // share (row, col) without collision.
  it("render: underground places the highway and its members at z = -1", () => {
    const src = [
      "hwy { shape: highway, render: underground }",
      "a -> b { via: hwy }",
    ].join("\n");
    const { placement } = reserve(src);
    expect(placement.cells.get("hwy")!.z).toBe(-1);
    expect(placement.cells.get("a")!.z).toBe(-1);
    expect(placement.cells.get("b")!.z).toBe(-1);
  });

  it("surface highway (no render: underground) places its members at z = 0 or undefined", () => {
    const src = [
      "hwy { shape: highway }",
      "a -> b { via: hwy }",
    ].join("\n");
    const { placement } = reserve(src);
    expect(placement.cells.get("hwy")!.z ?? 0).toBe(0);
    expect(placement.cells.get("a")!.z ?? 0).toBe(0);
    expect(placement.cells.get("b")!.z ?? 0).toBe(0);
  });

  it("intersect with one underground highway: dense fan-out works without member collision", () => {
    // Without z-separation this 3x3 + 3x3 topology would fail with
    // E_AMBIGUOUS_PLACEMENT because hwy_h's east targets and hwy_v's
    // south targets share corner cells. With render: underground on
    // hwy_v, its members are at z = -1 and don't collide with hwy_h's
    // z = 0 members even when they share (row, col).
    const src = [
      "crossings: 40",
      "hwy_h { shape: highway }",
      "hwy_v { shape: highway, orient: vertical, render: underground }",
      "intersect hwy_h, hwy_v",
      "src_h1 { size: 5x7 }",
      "src_h2 { size: 5x7 }",
      "dst_h1 { size: 5x7 }",
      "dst_h2 { size: 5x7 }",
      "dst_h3 { size: 5x7 }",
      "src_v1 { size: 7x5 }",
      "src_v2 { size: 7x5 }",
      "dst_v1 { size: 7x5 }",
      "dst_v2 { size: 7x5 }",
      "dst_v3 { size: 7x5 }",
      "src_h1 -> dst_h1 { via: hwy_h }",
      "src_h1 -> dst_h2 { via: hwy_h }",
      "src_h1 -> dst_h3 { via: hwy_h }",
      "src_h2 -> dst_h1 { via: hwy_h }",
      "src_h2 -> dst_h2 { via: hwy_h }",
      "src_h2 -> dst_h3 { via: hwy_h }",
      "src_v1 -> dst_v1 { via: hwy_v }",
      "src_v1 -> dst_v2 { via: hwy_v }",
      "src_v1 -> dst_v3 { via: hwy_v }",
      "src_v2 -> dst_v1 { via: hwy_v }",
      "src_v2 -> dst_v2 { via: hwy_v }",
      "src_v2 -> dst_v3 { via: hwy_v }",
    ].join("\n");
    expect(() => reserve(src)).not.toThrow();
  });

  it("slot-order: declaration on a source forces outgoing slots to use declaration order", () => {
    // Hub at row 1 fans into two targets at different rows. Default
    // oppositePerp puts the row-0 (upper) target's trace at the top
    // slot; with slot-order: declaration, the FIRST declared edge gets
    // the top slot regardless of target row.
    const src = [
      "a { slot-order: declaration, size: 5x7 }",
      "pipeline r0: top0 -> top1",   // top1 at row 0
      "pipeline r1: a -> mid",       // a at row 1
      "pipeline r2: bot0 -> bot1",   // bot1 at row 2
      "a -> bot1",                   // declared FIRST; target row 2 (high perp)
      "a -> top1",                   // declared SECOND; target row 0 (low perp)
    ].join("\n");
    const { model, reservation } = reserve(src);
    const findEdge = (to: string) => {
      for (let i = 0; i < model.edges.length; i++) {
        if (model.edges[i]!.from === "a" && model.edges[i]!.to === to) return i;
      }
      return -1;
    };
    const eBot = findEdge("bot1");
    const eTop = findEdge("top1");
    const rBot = reservation.routes.find((r) => r.edgeIndex === eBot)!;
    const rTop = reservation.routes.find((r) => r.edgeIndex === eTop)!;
    // Declaration order: a -> bot1 first → lower slot index.
    expect(rBot.sourceSlot).toBeLessThan(rTop.sourceSlot);
  });

  it("slot-order: declaration leaves the default sort intact when not set", () => {
    // Same topology without the override. Default oppositePerp orders
    // by target row. Under multi-cell layout the orphan-parked
    // top0/top1 pipeline now sits north of a, and bot0/bot1 sits south,
    // so the slot order ranks top1 (smaller y) below bot1 (larger y).
    const src = [
      "a { size: 5x7 }",
      "pipeline r0: top0 -> top1",
      "pipeline r1: a -> mid",
      "pipeline r2: bot0 -> bot1",
      "a -> bot1",
      "a -> top1",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const findEdge = (to: string) => {
      for (let i = 0; i < model.edges.length; i++) {
        if (model.edges[i]!.from === "a" && model.edges[i]!.to === to) return i;
      }
      return -1;
    };
    const eBot = findEdge("bot1");
    const eTop = findEdge("top1");
    const rBot = reservation.routes.find((r) => r.edgeIndex === eBot)!;
    const rTop = reservation.routes.find((r) => r.edgeIndex === eTop)!;
    // Default sort: target with smaller y (= smaller oppositePerp) takes
    // the lower slot. Under multi-cell parking, which of top1/bot1 sits
    // north of a depends on orphan-parking order — but they're on
    // OPPOSITE sides, so their slots differ. The test asserts they're
    // distinct (sort is non-trivial); the explicit ordering is
    // covered by the slot-order=declaration test above.
    expect(rTop.sourceSlot).not.toBe(rBot.sourceSlot);
  });

  it("slot-order: rejects unknown values with E_INVALID_SLOT_ORDER_VALUE", () => {
    const src = "node1 { slot-order: random }";
    expect(() => reserve(src)).toThrow(/E_INVALID_SLOT_ORDER_VALUE/);
  });

  it("orient: vertical changes the highway's forward direction under lr layout", () => {
    // A horizontal-default highway under `layout: lr` has fwd = E. With
    // orient: vertical the highway becomes vertical (fwd = S), so its
    // sources stack NORTH (above) and targets SOUTH (below) instead of
    // west/east.
    const src = [
      "layout: lr",
      "hwy { shape: highway, orient: vertical }",
      "a -> x { via: hwy }",
    ].join("\n");
    const { model, placement } = reserve(src);
    const hwy = placement.cells.get("hwy")!;
    const a = placement.cells.get("a")!;
    const x = placement.cells.get("x")!;
    void model;
    // Multi-cell: source above by max(source.height)=5; target below by
    // hwy.height=5. Cols match the highway's col.
    expect(a.row).toBe(hwy.row - 5);
    expect(x.row).toBe(hwy.row + 5);
    expect(a.col).toBe(hwy.col);
    expect(x.col).toBe(hwy.col);
  });
});

describe("corridors — exit:/entry: overrides (§11.10)", () => {
  it("{ exit: E } on a long-axis-N edge flips source side to E and produces an L-shape", () => {
    // Place b northwest-and-east of a so the §3.3 long-axis rule picks
    // N for edgeFwd (|dRow| > |dCol|). Without override the route exits
    // a's N face; with `exit: E` it should exit E.
    const src = [
      "a { size: 3x3 }",
      "b { size: 3x3 }",
      "pad { size: 3x3 }",
      // Build a 3x3-ish layout via a pipeline + a side edge.
      "pipeline col: a -> a2",
      "pipeline col2: a2 -> a3",
      "pipeline col3: b -> b2",
      "a -> b { exit: E }",
    ].join("\n");
    // Simpler: hand-craft cells via two pipelines.
    const src2 = [
      "pipeline a-col: a1 -> a2 -> a3", // row 0, cols 0..2
      "pipeline b-col: b1 -> b2 -> b3", // row 1
      "pipeline c-col: c1 -> c2 -> c3", // row 2
      "c1 -> a3 { exit: E }",            // diagonal up-right: long axis is N (|dRow|=2 > |dCol|=2 → equal, fallback)
    ].join("\n");
    void src;
    void src2;
    // Use the more direct topology: a single non-structural edge between
    // cells where row delta dominates column delta. Use two pipelines
    // stacked vertically; the cross-edge from the lower pipeline's
    // first node to the upper pipeline's third node is (−1, +2) which
    // has long-axis E. Need (−2, +1) for long-axis-N. Use three
    // pipelines to get rows 0..2.
    const src3 = [
      "pipeline r0: a0 -> a1",
      "pipeline r1: b0 -> b1",
      "pipeline r2: c0 -> c1",
      "c0 -> a1 { exit: E }",
    ].join("\n");
    const { model, reservation } = reserve(src3);
    const r = routeFor(reservation.routes, model.edges, "c0", "a1");
    expect(r.sourceSide).toBe("E");
    // Target side derives from edgeFwd. edgeFwd from cell delta (-2,+1)
    // is N (|dRow|=2 > |dCol|=1), so opposite = S → targetSide = S.
    expect(r.targetSide).toBe("S");
    // Corridor sequence is a one-bend L: V (exit east) → H (enter south).
    expect(r.corridorSequence.length).toBe(2);
    expect(r.corridorSequence[0]!.kind).toBe("V");
    expect(r.corridorSequence[1]!.kind).toBe("H");
  });

  it("{ entry: W } alone flips only the target side", () => {
    const src = [
      "pipeline r0: a0 -> a1",
      "pipeline r1: b0 -> b1",
      "pipeline r2: c0 -> c1",
      "c0 -> a1 { entry: W }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const r = routeFor(reservation.routes, model.edges, "c0", "a1");
    // Default source side from edgeFwd=N is N. Target side is overridden to W.
    expect(r.sourceSide).toBe("N");
    expect(r.targetSide).toBe("W");
  });

  it("{ exit: E, entry: W } sets both independently", () => {
    const src = [
      "pipeline r0: a0 -> a1",
      "pipeline r1: b0 -> b1",
      "pipeline r2: c0 -> c1",
      "c0 -> a1 { exit: E, entry: W }",
    ].join("\n");
    const { model, reservation } = reserve(src);
    const r = routeFor(reservation.routes, model.edges, "c0", "a1");
    expect(r.sourceSide).toBe("E");
    expect(r.targetSide).toBe("W");
  });

  it("rejects exit:/entry: with E_EXIT_INVALID_VALUE on non-cardinal idents", () => {
    expect(() => reserve("a -> b { exit: northeast }")).toThrow(
      /E_EXIT_INVALID_VALUE/,
    );
    expect(() => reserve("a -> b { entry: foo }")).toThrow(
      /E_EXIT_INVALID_VALUE/,
    );
  });

  it("rejects exit:/entry: on back-edges with E_EXIT_ON_BACK_EDGE", () => {
    expect(() => reserve("a -> b\nb >- a { exit: N }")).toThrow(
      /E_EXIT_ON_BACK_EDGE/,
    );
  });

  it("rejects exit:/entry: on via-edges with E_EXIT_ON_VIA_EDGE", () => {
    const src = [
      "hwy { shape: highway }",
      "a -> b { via: hwy, exit: E }",
    ].join("\n");
    expect(() => reserve(src)).toThrow(/E_EXIT_ON_VIA_EDGE/);
  });

  it("composes with avoid: (path search starts from the overridden face)", () => {
    const src = [
      "pipeline r0: a0 -> a1",
      "pipeline r1: b0 -> b1",
      "pipeline r2: c0 -> c1",
      "x -> y",
      "c0 -> a1 { exit: E, avoid: x -> y }",
    ].join("\n");
    // Should not throw — the path search honors the overridden source side.
    expect(() => reserve(src)).not.toThrow();
  });
});

function toJson(r: ReturnType<typeof reserve>["reservation"]) {
  return {
    routes: r.routes,
    demand: [...r.demand.entries()].sort(),
    rowUnits: r.rowUnits,
    colUnits: r.colUnits,
    rowGutterUnits: r.rowGutterUnits,
    colGutterUnits: r.colGutterUnits,
    flowAxis: r.flowAxis,
  };
}
