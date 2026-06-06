/**
 * Phase 4 placer tests (Step 4).
 *
 * Covers the three placement passes and the cell-unit assignment.
 * Reads source via the parser → bind → place chain so the surface
 * matches the user's actual workflow.
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import type { Cell } from "../src/layout/placement.js";

function placement(src: string) {
  return place(bind(parse(tokenize(src))));
}

function cellOf(p: ReturnType<typeof placement>, id: string): Cell {
  const c = p.cells.get(id);
  if (!c) throw new Error(`'${id}' not placed`);
  return c;
}

describe("placer — anchor pass: pipeline", () => {
  it("places pipeline members one PIPELINE_GAP cell apart on the same row", () => {
    const p = placement("pipeline ingest: a -> b -> c");
    const a = cellOf(p, "a");
    const b = cellOf(p, "b");
    const c = cellOf(p, "c");
    expect(a.row).toBe(b.row);
    expect(b.row).toBe(c.row);
    // Default 5x5 nodes step by 5 + PIPELINE_GAP(5) = 10 cols. The gap
    // is the channel router's runway between consecutive members.
    expect(b.col).toBe(a.col + 10);
    expect(c.col).toBe(b.col + 10);
  });

  it("places TB pipelines south of each other on the same col", () => {
    const p = placement("layout: tb\npipeline ingest: a -> b -> c");
    const a = cellOf(p, "a");
    const b = cellOf(p, "b");
    const c = cellOf(p, "c");
    expect(a.col).toBe(b.col);
    expect(b.col).toBe(c.col);
    expect(b.row).toBe(a.row + 10);
    expect(c.row).toBe(b.row + 10);
  });

  it("parks unrelated pipelines on disjoint rows", () => {
    const p = placement(
      "pipeline one: a -> b\npipeline two: c -> d",
    );
    const a = cellOf(p, "a");
    const c = cellOf(p, "c");
    expect(a.row).not.toBe(c.row);
  });
});

describe("placer — anchor pass: bus", () => {
  it("stacks producers with a uniform MEMBER_GAP and centres shared on the block", () => {
    const p = placement("s { size: 5x7 }\nbus power: [a, b, c] -> s");
    const a = cellOf(p, "a");
    const b = cellOf(p, "b");
    const c = cellOf(p, "c");
    const s = cellOf(p, "s");
    expect(a.col).toBe(b.col);
    expect(b.col).toBe(c.col);
    // Default 5x5 producers stack by 5 + MEMBER_GAP(5) = 10 rows.
    expect(b.row).toBe(a.row + 10);
    expect(c.row).toBe(b.row + 10);
    // Shared sits one shared-width(5) + PIPELINE_GAP(5) = 10 east of producers.
    expect(s.col).toBe(a.col + 10);
    // perpOffsets [0, 10, 20]. Block end = 25. Block centre = 12.5.
    // Shared h=7, centre offset = 3.5. anchorPerp = floor(12.5 - 3.5) = 9.
    expect(s.row).toBe(a.row + 9);
  });

  it("centres shared on the block for an even producer count", () => {
    const p = placement("s { size: 5x9 }\nbus power: [a, b, c, d] -> s");
    const a = cellOf(p, "a");
    const s = cellOf(p, "s");
    // 4 producers, h=5, MEMBER_GAP=5: perpOffsets [0, 10, 20, 30].
    // Block end = 35. Block centre = 17.5. Shared h=9 (parity-bumped
    // to 10), centre offset = 5. anchorPerp = floor(17.5 - 5) = 12.
    expect(s.row).toBe(a.row + 12);
  });
});

describe("placer — anchor pass: fan-out", () => {
  it("mirrors bus: shared at one col, consumers stacked at the next col", () => {
    const p = placement("s { size: 5x7 }\nfan-out broadcast: s -> [a, b, c]");
    const s = cellOf(p, "s");
    const a = cellOf(p, "a");
    const b = cellOf(p, "b");
    const c = cellOf(p, "c");
    expect(a.col).toBe(b.col);
    expect(b.col).toBe(c.col);
    // Consumers sit one shared-width(5) + PIPELINE_GAP(5) = 10 east of shared.
    expect(a.col).toBe(s.col + 10);
    // Default 5x5 consumers stack by 5 + MEMBER_GAP(5) = 10 rows.
    expect(b.row).toBe(a.row + 10);
    expect(c.row).toBe(b.row + 10);
    // perpOffsets [0, 10, 20]. Block centre = 12.5. Shared h=7,
    // centre offset = 3.5. anchorPerp = floor(12.5 - 3.5) = 9.
    expect(s.row).toBe(a.row + 9);
  });
});

describe("placer — anchor pass: branch", () => {
  // Multi-cell + PIPELINE_GAP: branch member is offset by spine's perp
  // extent + PIPELINE_GAP. For default 5x5 spines, that's 5 + 5 = 10.
  it("under LR, default :left puts member north of the spine (CCW rotation of east is north)", () => {
    const p = placement(
      "pipeline main: a -> b -> c\nbranch off: b -> x",
    );
    const b = cellOf(p, "b");
    const x = cellOf(p, "x");
    expect(x.col).toBe(b.col);
    expect(x.row).toBe(b.row - 10);
  });

  it("under LR, explicit :right puts member south of the spine", () => {
    const p = placement(
      "pipeline main: a -> b -> c\nbranch off:right: b -> x",
    );
    const b = cellOf(p, "b");
    const x = cellOf(p, "x");
    expect(x.col).toBe(b.col);
    expect(x.row).toBe(b.row + 10);
  });

  it("under TB, default :left puts member east of the spine (CCW of south is east)", () => {
    const p = placement(
      "layout: tb\npipeline main: a -> b -> c\nbranch off: b -> x",
    );
    const b = cellOf(p, "b");
    const x = cellOf(p, "x");
    expect(x.row).toBe(b.row);
    expect(x.col).toBe(b.col + 10);
  });

  it("under TB, explicit :right puts member west of the spine", () => {
    const p = placement(
      "layout: tb\npipeline main: a -> b -> c\nbranch off:right: b -> x",
    );
    const b = cellOf(p, "b");
    const x = cellOf(p, "x");
    expect(x.row).toBe(b.row);
    expect(x.col).toBe(b.col - 10);
  });

  it("a pipeline rooted on the branched node extends along the branch direction", () => {
    const p = placement(
      "pipeline main: a -> b -> c\n" +
        "branch off: b -> x\n" +
        "pipeline tail: x -> y",
    );
    const b = cellOf(p, "b");
    const x = cellOf(p, "x");
    const y = cellOf(p, "y");
    expect(x.col).toBe(b.col);
    // Branch member is offset by spine perp extent + PIPELINE_GAP.
    expect(x.row).toBe(b.row - 10);
    expect(y.col).toBe(x.col);
    // The tail `pipeline tail: x -> y` adds PIPELINE_GAP(5) between x and y.
    expect(y.row).toBe(x.row - 10);
  });
});

describe("placer — anchor conflicts", () => {
  it("rejects a node placed at incompatible cells by two pipelines", () => {
    // `b` is at col 1 of pipeline one (row R, col C+1) and at col 0 of
    // pipeline two (row R', col C'). After applying `one` we have b at
    // some cell, then `two` tries to put b at row R' (a fresh row) but
    // pipeline one already placed `a` at b.row, col-1; the conflict
    // surfaces because pipeline two derives its origin from b and then
    // places `c` at b.col+1 — which doesn't conflict, actually.
    //
    // To force a real conflict, share TWO nodes between the pipelines
    // at incompatible offsets:
    expect(() =>
      placement(
        "pipeline one: a -> b -> c\npipeline two: c -> b -> a",
      ),
    ).toThrow(/E_ANCHOR_CONFLICT/);
  });

  it("rejects a node placed at incompatible cells by pipeline + bus", () => {
    // Pipeline places a@(0,0), b@(0,1).
    // Bus then wants a@(0,0), b@(1,0), shared@(0,1) — but b is already
    // at (0,1), not (1,0). E_ANCHOR_CONFLICT.
    expect(() =>
      placement("pipeline p: a -> b\nbus bb: [a, b] -> shared"),
    ).toThrow(/E_ANCHOR_CONFLICT/);
  });
});

describe("placer — flow pass", () => {
  // Multi-cell + PIPELINE_GAP: flow-pass steps by source extent + 5
  // gap cells. Default 5x5 + 5 = 10 cells per step.
  it("places the target of a free edge one extent + gap east of the source", () => {
    const p = placement("a -> b");
    const a = cellOf(p, "a");
    const b = cellOf(p, "b");
    expect(b.row).toBe(a.row);
    expect(b.col).toBe(a.col + 10);
  });

  it("chains free edges along the flow axis", () => {
    const p = placement("a -> b\nb -> c\nc -> d");
    const cells = ["a", "b", "c", "d"].map((id) => cellOf(p, id));
    for (let i = 0; i < cells.length - 1; i++) {
      expect(cells[i + 1]!.row).toBe(cells[i]!.row);
      expect(cells[i + 1]!.col).toBe(cells[i]!.col + 10);
    }
  });

  it("ignores back-edges for placement", () => {
    const p = placement("a -> b\nb >- a");
    const a = cellOf(p, "a");
    const b = cellOf(p, "b");
    expect(b.col).toBe(a.col + 10);
    expect(b.row).toBe(a.row);
  });

  it("extends an anchored pipeline with a free edge", () => {
    const p = placement(
      "pipeline pi: a -> b\nb -> c",
    );
    const a = cellOf(p, "a");
    const b = cellOf(p, "b");
    const c = cellOf(p, "c");
    // Both pipeline and free-edge flow now use extent + PIPELINE_GAP.
    expect(b.col).toBe(a.col + 10);
    expect(c.col).toBe(b.col + 10);
    expect(c.row).toBe(b.row);
  });
});

describe("placer — collisions", () => {
  it("raises E_AMBIGUOUS_PLACEMENT when two flow edges target the same cell", () => {
    // a -> b puts b at (0, 1). Then c -> b doesn't move b (already
    // placed) but c -> d would put d at... wait, this needs more care.
    // Force the collision: anchor two pipelines that start at the same
    // origin (both park at row 0). The flow pass will then collide.
    //
    // Actually, parking puts pipeline `two` at the next free row, so no
    // collision. We need explicit edges that converge.
    //
    // Simplest: a -> b and c -> b force b at two different cells.
    // First edge: a at (0,0), b at (0,1). Second edge: c at fresh
    // row, b... is already placed at (0,1). So the second edge places
    // c by stepping back from b: c at (0,0) — colliding with a.
    expect(() => placement("a -> b\nc -> b")).toThrow(/E_AMBIGUOUS_PLACEMENT/);
  });
});

describe("placer — row/col cell units", () => {
  it("sizes a row at 1 cell unit under multi-cell occupancy", () => {
    const p = placement(
      "a { size: 3x5 }\nb { size: 3x3 }\npipeline pi: a -> b",
    );
    const a = cellOf(p, "a");
    // Multi-cell: every row contributes exactly one cell unit. A node
    // taller than one cell expresses itself by its footprint spanning
    // additional rows, not by inflating its anchor row's unit count.
    expect(p.rowUnits[a.row]).toBe(1);
  });

  it("sizes a col at 1 cell unit under multi-cell occupancy", () => {
    const p = placement(
      "s { size: 5x7 }\na { size: 7x3 }\nb { size: 3x3 }\nbus bb: [a, b] -> s",
    );
    const a = cellOf(p, "a");
    expect(p.colUnits[a.col]).toBe(1);
  });

  it("normalises the placement so min row and min col are 0", () => {
    const p = placement("pipeline x: a -> b -> c");
    const cells = [...p.cells.values()];
    expect(Math.min(...cells.map((c) => c.row))).toBe(0);
    expect(Math.min(...cells.map((c) => c.col))).toBe(0);
  });
});

describe("placer — orphan parking", () => {
  it("parks an isolated node at a fresh row, col 0", () => {
    const p = placement("a -> b\nlonely");
    const a = cellOf(p, "a");
    const lonely = cellOf(p, "lonely");
    expect(lonely.col).toBe(0);
    expect(lonely.row).not.toBe(a.row);
  });
});

describe("placer — flowAxis carry-through", () => {
  it("reports east when layout is lr (default)", () => {
    const p = placement("a -> b");
    expect(p.flowAxis).toBe("east");
  });

  it("reports south when layout is tb", () => {
    const p = placement("layout: tb\na -> b");
    expect(p.flowAxis).toBe("south");
  });
});

describe("placer — local forward (isometry)", () => {
  it("pipeline members carry the page default forward under LR", () => {
    const p = placement("pipeline main: a -> b -> c");
    expect(p.forwardAt.get("a")).toBe("E");
    expect(p.forwardAt.get("b")).toBe("E");
    expect(p.forwardAt.get("c")).toBe("E");
  });

  it("pipeline members carry the page default forward under TB", () => {
    const p = placement("layout: tb\npipeline main: a -> b -> c");
    expect(p.forwardAt.get("a")).toBe("S");
    expect(p.forwardAt.get("b")).toBe("S");
    expect(p.forwardAt.get("c")).toBe("S");
  });

  it("branch member carries the branch's forward, not the parent's", () => {
    // Default :left of east = N. The branched member should report N,
    // while the spine reports the pipeline's E.
    const p = placement(
      "pipeline main: a -> b -> c\nbranch off: b -> x",
    );
    expect(p.forwardAt.get("b")).toBe("E");
    expect(p.forwardAt.get("x")).toBe("N");
  });

  it("a primitive rooted on a branched node inherits the branch's forward", () => {
    // Multi-cell: x advances 5 cells north of b's footprint top, and
    // z advances 5 cells north of x.
    const p = placement(
      "pipeline main: a -> b -> c\n" +
        "branch off: b -> x\n" +
        "pipeline tail: x -> z",
    );
    const x = cellOf(p, "x");
    const z = cellOf(p, "z");
    expect(z.col).toBe(x.col);
    // pipeline tail: x -> z adds PIPELINE_GAP(5) between x and z.
    expect(z.row).toBe(x.row - 10);
    expect(p.forwardAt.get("z")).toBe("N");
  });
});
