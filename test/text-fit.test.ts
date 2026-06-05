/**
 * Phase 5 text-fit tests.
 *
 * The pass is now a no-op: declared `size` is authoritative for
 * placement, and labels that don't fit inside the box overflow
 * visually. The pure measurement helpers are still exercised so
 * downstream callers (corridor reserver, theme tests) keep a stable
 * contract.
 */
import { describe, expect, it } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import { applyTextFit, applyTextFitToSizes, estimateLabelWidth, neededBoxWidthPx } from "../src/layout/text-fit.js";
import { loadTheme } from "../src/theme/theme.js";

const theme = loadTheme("document-light"); // body=10pt

function run(src: string) {
  const model = bind(parse(tokenize(src)));
  applyTextFitToSizes(model, theme);
  const placement = applyTextFit(place(model), model, theme);
  return { model, placement };
}

describe("text-fit — declared size is authoritative", () => {
  it("single-char ids stay at default 5x5", () => {
    const { model, placement } = run("a -> b");
    expect(model.nodes.find((n) => n.id === "a")?.size).toEqual({ width: 5, height: 5 });
    // Multi-cell: every cell unit is 1; the node's 5-cell width is
    // expressed via its footprint spanning 5 cols, not by colUnits inflation.
    expect(placement.colUnits.every((u) => u === 1)).toBe(true);
  });

  it("long-id default-sized nodes stay 5x5 — label overflows", () => {
    // Pre-rule, text-fit grew this past 5; now the box stays put and the
    // label spills out the side.
    const { model } = run("src_v2 -> dst");
    expect(model.nodes.find((n) => n.id === "src_v2")?.size).toEqual({ width: 5, height: 5 });
  });

  it("explicit size: 7x3 is respected verbatim", () => {
    const { model } = run('big { size: 7x3, label: "ab" }\nbig -> x');
    expect(model.nodes.find((n) => n.id === "big")?.size).toEqual({ width: 7, height: 3 });
  });

  it("explicit size smaller than a long label is respected — overflow is fine", () => {
    const { model } = run('a { size: 5x5, label: "this_is_a_very_long_label" }\na -> b');
    expect(model.nodes.find((n) => n.id === "a")?.size).toEqual({ width: 5, height: 5 });
  });
});

describe("text-fit — icons and circles also stay at declared size", () => {
  it("an icon node keeps its declared size; label overflows below", () => {
    const { model } = run(
      [
        'icons: aws from "./icons/aws/"',
        "srv { shape: icon(aws/server), label: \"API server\" }",
        "srv -> b",
      ].join("\n"),
    );
    const srv = model.nodes.find((n) => n.id === "srv")!;
    expect(srv.size).toEqual({ width: 5, height: 5 });
    expect(srv.iconArea).toBeUndefined();
  });

  it("a circle keeps its declared size; label overflows below", () => {
    const { model } = run('client { shape: circle, label: "Client App" }\na -> client');
    const client = model.nodes.find((n) => n.id === "client")!;
    expect(client.size).toEqual({ width: 5, height: 5 });
    expect(client.iconArea).toBeUndefined();
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
    expect(model1.nodes.find((n) => n.id === "longname")!.size).toEqual(
      model1.nodes.find((n) => n.id === "longname")!.size,
    );
  });
});
