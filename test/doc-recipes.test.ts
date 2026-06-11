/**
 * Doc-recipe guard (the project's "verify doc recipes against the CLI"
 * rule, automated). Every complete, copy-pasteable recipe in EXAMPLES.md
 * §3 must validate through the SAME pipeline the CLI runs, and every
 * error-example in §5 must fail with its documented code. If a recipe
 * breaks, an LLM author copying it hits a wall — so these are landmines,
 * not nitpicks.
 *
 * Recipes are inlined here (not scraped from markdown) so the assertion
 * is explicit and stable; when you change a recipe in EXAMPLES.md, change
 * its twin here in the same commit.
 */
import { describe, it, expect } from "vitest";
import { validateSource } from "../src/compile.js";

/** Validate in-memory; return the diagnostic code or null on success. */
function code(src: string): string | null {
  const d = validateSource(src, { filePath: "test/<doc-recipe>.melk" });
  return d ? (d.code ?? `<no-code:${d.stage}>`) : null;
}

describe("EXAMPLES.md §3 recipes validate clean", () => {
  it("Linear flow", () => {
    expect(code(`pipeline main: ingest -> transform -> load`)).toBeNull();
  });

  it("Spine with side branches", () => {
    expect(
      code(`pipeline main: api -> service -> db
branch audit:right: service -> audit_log
branch cache:left: service -> cache`),
    ).toBeNull();
  });

  it("Fan-out → bus rejoin", () => {
    expect(
      code(`fan-out split: lb -> [web1, web2, web3]
bus join: [web1, web2, web3] -> gateway`),
    ).toBeNull();
  });

  it("Shared backing service (one anchor, plain edges for the rest)", () => {
    expect(
      code(`bus enqueue: [web1, web2, web3] -> queue

fan-out workers:   queue -> [worker1, worker2]
bus db-writes:     [worker1, worker2] -> db
branch cache-warm:right: worker2 -> cache`),
    ).toBeNull();
  });

  it("Highway-routed many-to-many", () => {
    expect(
      code(`crossings: 10
trunk { shape: highway }
prod_a -> cons_a { via: trunk }
prod_a -> cons_b { via: trunk }
prod_b -> cons_a { via: trunk }
prod_b -> cons_b { via: trunk }`),
    ).toBeNull();
  });

  it("Nudging a node with offset", () => {
    expect(
      code(`pipeline main: a -> b -> c
b { offset: "0x0.5" }`),
    ).toBeNull();
  });

  it("Fan-in to a mid-pipeline stage (bus absorbs the spine head)", () => {
    expect(
      code(`bus feeds: [ingest, ext_a, ext_b] -> merge
pipeline tail: merge -> publish`),
    ).toBeNull();
  });

  it("Trees (chained fan-outs sized to subtree breadth)", () => {
    expect(
      code(`crossings: 20
fan-out root: r -> [mid_a, mid_b]
fan-out la: mid_a -> [leaf_a1, leaf_a2]
fan-out lb: mid_b -> [leaf_b1, leaf_b2]
mid_a { size: 5x11 }
mid_b { size: 5x11 }`),
    ).toBeNull();
  });
});

describe("EXAMPLES.md §5 error examples fail with the documented code", () => {
  it("Shape A — bare edge off a spine → E_AMBIGUOUS_PLACEMENT", () => {
    expect(
      code(`pipeline main: a -> b -> c
b -> side`),
    ).toBe("E_AMBIGUOUS_PLACEMENT");
  });

  it("Shape D — two anchoring busses to one sink → E_AMBIGUOUS_PLACEMENT", () => {
    expect(
      code(`bus a: [w1, w2] -> db
bus b: [w3, w4] -> db`),
    ).toBe("E_AMBIGUOUS_PLACEMENT");
  });

  it("E_ANCHOR_CONFLICT — a node re-anchored to two cells", () => {
    expect(
      code(`pipeline main: a -> b -> c
branch x:right: a -> b`),
    ).toBe("E_ANCHOR_CONFLICT");
  });

  it("E_HIGHWAY_AS_ENDPOINT — highway used as a direct endpoint", () => {
    expect(
      code(`hwy { shape: highway }
src -> hwy`),
    ).toBe("E_HIGHWAY_AS_ENDPOINT");
  });

  it("E_CROSSINGS_OVER_BUDGET — crossing topology with default budget 0", () => {
    // Two fan-outs from one source force a crossing; default budget is 0.
    expect(
      code(`fan-out f1: hub -> [a, b]
fan-out f2: hub -> [c, d, e]`),
    ).toBe("E_CROSSINGS_OVER_BUDGET");
  });
});
