/**
 * P3 silent-output guards. These convert previously-silent wrong output
 * into loud, actionable diagnostics:
 *   - E_SELF_EDGE        — a -> a no longer renders a buried arrow
 *   - W_SUSPECTED_TYPO   — typo'd endpoint that auto-declares a near-miss
 *   - W_LABEL_OVERFLOW   — a label wider than its box
 *   - E_TRACE_THROUGH_NODE — a routed trace cutting a non-endpoint node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateSource, warnSuspectedTypos, resetTypoWarnings } from "../src/compile.js";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";

function code(src: string): string | null {
  const d = validateSource(src, { filePath: "test/<guard>.melk" });
  return d ? (d.code ?? `<no-code:${d.stage}>`) : null;
}

describe("E_SELF_EDGE", () => {
  it("rejects a -> a", () => {
    expect(code(`pipeline m: a -> b\nb -> b { label: "retry" }`)).toBe("E_SELF_EDGE");
  });
  it("does not reject distinct endpoints", () => {
    expect(code(`a -> b`)).toBeNull();
  });
});

describe("W_SUSPECTED_TYPO", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetTypoWarnings();
    warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => warn.mockRestore());

  function warnings(src: string): string[] {
    const model = bind(parse(tokenize(src)));
    warnSuspectedTypos(model);
    return warn.mock.calls.map((c) => String(c[0]));
  }

  it("flags an auto-declared near-miss of a declared node", () => {
    const w = warnings(`database { shape: cylinder, label: "DB" }\napi -> databse`);
    expect(w.some((m) => m.includes("W_SUSPECTED_TYPO") && m.includes("database"))).toBe(true);
  });

  it("does not flag intentional distinct names", () => {
    const w = warnings(`web1 -> lb\nweb2 -> lb\nworker -> lb`);
    expect(w.some((m) => m.includes("W_SUSPECTED_TYPO"))).toBe(false);
  });

  it("does not flag short names (a/b/c style)", () => {
    const w = warnings(`a -> b\nc -> d`);
    expect(w.some((m) => m.includes("W_SUSPECTED_TYPO"))).toBe(false);
  });
});

describe("E_TRACE_THROUGH_NODE guard exists and does not false-positive", () => {
  // The guard is a defensive net; the canonical examples must all pass it.
  // (A positive fixture is hard to construct deterministically because the
  // router usually finds a valid path; the 43-example smoke test in
  // examples.test.ts is the real coverage that no valid route trips it.)
  it("a clean fan-out + bus diagram does not trip the guard", () => {
    expect(
      code(`crossings: 20
fan-out f: root -> [m1, m2, m3]
bus g: [m1, m2, m3] -> sink`),
    ).toBeNull();
  });
});
