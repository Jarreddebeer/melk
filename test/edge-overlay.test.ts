/**
 * Structural-edge attribute overlay (bind.ts).
 *
 * A primitive (pipeline / bus / fan-out / branch) creates the edge for a
 * from→to pair, but its member list has nowhere to hang per-trace
 * attributes. So a *plain* edge restating the same pair acts as an
 * overlay: it merges its label/tags onto the structural edge instead of
 * drawing a second trace. This is the only way to style one member of a
 * fan-out / fan-in.
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";

function model(src: string) {
  return bind(parse(tokenize(src)));
}

function edgesBetween(m: ReturnType<typeof model>, from: string, to: string) {
  return m.edges.filter((e) => e.from === from && e.to === to);
}

describe("structural-edge attribute overlay", () => {
  it("merges tags onto a fan-out member without drawing a duplicate", () => {
    const m = model(
      `fan-out f: router -> [a, b, c]\n` +
      `router -> b { tags: [hot] }`,
    );
    const rb = edgesBetween(m, "router", "b");
    expect(rb).toHaveLength(1); // not two — overlay merged
    expect(rb[0]!.source).toBe("fan-out"); // still the structural edge
    expect(rb[0]!.tags).toEqual(["hot"]);
    // The other members are untouched.
    expect(edgesBetween(m, "router", "a")[0]!.tags).toBeUndefined();
  });

  it("merges a label onto a structural member", () => {
    const m = model(
      `fan-out f: router -> [a, b]\n` +
      `router -> a { label: "primary" }`,
    );
    const ra = edgesBetween(m, "router", "a");
    expect(ra).toHaveLength(1);
    expect(ra[0]!.label).toBe("primary");
  });

  it("overlays onto a bus (fan-in) member", () => {
    const m = model(
      `bus agg: [a, b, c] -> sink\n` +
      `b -> sink { tags: [hot] }`,
    );
    const bs = edgesBetween(m, "b", "sink");
    expect(bs).toHaveLength(1);
    expect(bs[0]!.source).toBe("bus");
    expect(bs[0]!.tags).toEqual(["hot"]);
  });

  it("overlays onto a pipeline segment", () => {
    const m = model(
      `pipeline p: a -> b -> c\n` +
      `b -> c { tags: [hot] }`,
    );
    const bc = edgesBetween(m, "b", "c");
    expect(bc).toHaveLength(1);
    expect(bc[0]!.source).toBe("pipeline");
    expect(bc[0]!.tags).toEqual(["hot"]);
  });

  it("does not merge when there is no structural edge for the pair", () => {
    // A plain edge with no matching primitive is a normal free edge.
    const m = model(`a -> b { tags: [hot] }`);
    const ab = edgesBetween(m, "a", "b");
    expect(ab).toHaveLength(1);
    expect(ab[0]!.source).toBe("explicit");
    expect(ab[0]!.tags).toEqual(["hot"]);
  });

  it("a routing-prop line stays a distinct edge (not an overlay)", () => {
    // exit:/via:/avoid: signal a real free edge the author wants routed
    // separately, so they fall through rather than merging.
    const m = model(
      `fan-out f: router -> [a, b]\n` +
      `router -> b { exit: S }`,
    );
    const rb = edgesBetween(m, "router", "b");
    expect(rb.length).toBeGreaterThan(1); // distinct edge, not merged
  });
});
