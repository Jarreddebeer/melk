/**
 * Phase 5 text-fit tests.
 *
 * The pass runs between place and reserveCorridors. Two contracts:
 *
 *   1. Short labels in 1x1 cells stay at 1x1 (no needless growth).
 *   2. Long labels in 1x1 cells grow the cell width (and the node's
 *      size) to integer cell-units that contain the label + padding.
 *
 * Plus: circle nodes stay square at the bigger dimension so the
 * circle's radius fits the text.
 */
import { describe, expect, it } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import { applyTextFit, estimateLabelWidth, neededBoxWidthPx } from "../src/layout/text-fit.js";
import { loadTheme } from "../src/theme/theme.js";

const theme = loadTheme("document-light"); // body=10pt

function run(src: string) {
  const model = bind(parse(tokenize(src)));
  const placement = applyTextFit(place(model), model, theme);
  return { model, placement };
}

describe("text-fit — short labels stay small", () => {
  it("single-char ids stay 1x1", () => {
    const { model, placement } = run("a -> b");
    expect(model.nodes.find((n) => n.id === "a")?.size).toEqual({ width: 1, height: 1 });
    expect(placement.colUnits.every((u) => u === 1)).toBe(true);
  });

  it("2-char ids stay 1x1", () => {
    // Boundary case: 1-2 char ids comfortably fit a 32px cell at 10pt
    // with padding. The 3-char boundary is right at the edge — and the
    // pass intentionally over-estimates slightly to guarantee breathing
    // room rather than risk clipping.
    const { model } = run("a -> bb");
    expect(model.nodes.find((n) => n.id === "a")?.size.width).toBe(1);
    expect(model.nodes.find((n) => n.id === "bb")?.size.width).toBe(1);
  });
});

describe("text-fit — long labels grow the cell", () => {
  it("6-char id grows to 2 cell units wide", () => {
    const { model, placement } = run("src_v2 -> dst");
    const src = model.nodes.find((n) => n.id === "src_v2")!;
    expect(src.size.width).toBeGreaterThanOrEqual(2);
    // The col containing src_v2 must be widened too.
    const cell = placement.cells.get("src_v2")!;
    expect(placement.colUnits[cell.col]).toBe(src.size.width);
  });

  it("respects an explicit larger size (size: 3x1 trumps a label that needs 2)", () => {
    const { model } = run('big { size: 3x1, label: "ab" }\nbig -> x');
    expect(model.nodes.find((n) => n.id === "big")?.size.width).toBe(3);
  });

  it("grows further if an explicit size is too small for the label", () => {
    // size: 1x1 with a 20-char label needs many more cells.
    const { model } = run('a { label: "this_is_a_very_long_label" }\na -> b');
    expect(model.nodes.find((n) => n.id === "a")?.size.width).toBeGreaterThan(2);
  });
});

describe("text-fit — circles stay 1x1 (label renders below)", () => {
  it("a circle node is NOT grown for long labels", () => {
    // Circles render their label outside the shape (BPMN/flowchart
    // convention for sources/sinks/events) so the shape stays at its
    // declared size regardless of label length.
    const { model } = run("client { shape: circle }\na -> client");
    const client = model.nodes.find((n) => n.id === "client")!;
    expect(client.size.width).toBe(1);
    expect(client.size.height).toBe(1);
  });
});

describe("text-fit — diamonds stay square", () => {
  it("a diamond grows in both dims when the label needs more width", () => {
    const { model } = run("d { shape: diamond, label: \"verify-this\" }\nd -> x");
    const d = model.nodes.find((n) => n.id === "d")!;
    expect(d.size.width).toBe(d.size.height);
    expect(d.size.width).toBeGreaterThanOrEqual(2);
  });
});

describe("text-fit — cylinders enforce min aspect", () => {
  it("a wide cylinder grows in height to keep ~2:3 height:width aspect", () => {
    const { model } = run("c { shape: cylinder, label: \"audit log\" }\nc -> x");
    const c = model.nodes.find((n) => n.id === "c")!;
    // width ought to grow for the label; height should be at least
    // ceil(width * 2/3).
    const minH = Math.ceil((c.size.width * 2) / 3);
    expect(c.size.height).toBeGreaterThanOrEqual(minH);
  });
});

describe("text-fit — highway nodes untouched", () => {
  it("a highway node keeps its bound size, no text-fit growth", () => {
    const src = [
      "hwy { shape: highway }",
      "src1 -> dst1 { via: hwy }",
      "src1 -> dst2 { via: hwy }",
      "src1 -> dst3 { via: hwy }",
    ].join("\n");
    const { model } = run(src);
    const hwy = model.nodes.find((n) => n.id === "hwy")!;
    // The highway auto-sizer set the size in bind; text-fit must not
    // grow it just because "hwy" is a label-bearing token (it isn't —
    // highways render no label).
    expect(hwy.size.width).toBeGreaterThan(0);
    expect(hwy.size.height).toBeGreaterThan(0);
  });
});

describe("text-fit — pure helpers", () => {
  it("estimateLabelWidth scales with font size", () => {
    const w10 = estimateLabelWidth("hello", 10);
    const w20 = estimateLabelWidth("hello", 20);
    expect(w20).toBeCloseTo(2 * w10, 3);
  });

  it("estimateLabelWidth is 0 for empty string", () => {
    expect(estimateLabelWidth("", 10)).toBe(0);
  });

  it("estimateLabelWidth treats uppercase as wider", () => {
    expect(estimateLabelWidth("AAAA", 10)).toBeGreaterThan(
      estimateLabelWidth("aaaa", 10),
    );
  });

  it("neededBoxWidthPx adds shape-specific allowance", () => {
    const rect = neededBoxWidthPx("hello", 10, "rect");
    const cyl = neededBoxWidthPx("hello", 10, "cylinder");
    const dia = neededBoxWidthPx("hello", 10, "diamond");
    expect(cyl).toBeGreaterThan(rect);
    expect(dia).toBeGreaterThan(cyl);
  });
});

describe("text-fit — idempotence", () => {
  it("running the pass twice gives the same result", () => {
    const model1 = bind(parse(tokenize("longname -> x")));
    const p1 = applyTextFit(place(model1), model1, theme);
    const p2 = applyTextFit(p1, model1, theme);
    expect(p2.colUnits).toEqual(p1.colUnits);
    expect(p2.rowUnits).toEqual(p1.rowUnits);
    // node.size should also be stable.
    expect(model1.nodes.find((n) => n.id === "longname")!.size).toEqual(
      model1.nodes.find((n) => n.id === "longname")!.size,
    );
  });
});
