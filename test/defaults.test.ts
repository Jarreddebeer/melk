/**
 * Doc-truth guard: pins the compiler defaults that SYNTAX.md documents,
 * so the docs and the code can't silently drift apart again.
 *
 * Each assertion here corresponds to a stated default in SYNTAX.md:
 *   - §2.1 layout default
 *   - §2.2 crossings budget default
 *   - §3.1 auto-declared node size/shape
 *
 * If you change a default in src/bind/bind.ts, update the matching
 * sentence in SYNTAX.md and this test in the same commit.
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";

function run(src: string) {
  return bind(parse(tokenize(src))) as any;
}

describe("documented compiler defaults (SYNTAX.md doc-truth guard)", () => {
  it("layout default is lr (SYNTAX.md §2.1)", () => {
    expect(run("a -> b").layoutMode).toBe("lr");
  });

  it("crossings budget default is 0 (SYNTAX.md §2.2)", () => {
    expect(run("a -> b").crossingsBudget).toBe(0);
  });

  it("explicit layout: tb overrides the lr default", () => {
    expect(run("layout: tb\na -> b").layoutMode).toBe("tb");
  });

  it("auto-declared node is 5x5 rect (SYNTAX.md §3.1)", () => {
    const m = run("a -> b");
    const a = m.nodes.find((n: any) => n.id === "a");
    expect(a.shape).toBe("rect");
    expect(a.size).toEqual({ width: 5, height: 5 });
  });
});
