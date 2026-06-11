/**
 * Public compile API (src/compile.ts). Guards the high-level entry points
 * the README documents and an embedding tool drives:
 *   - compileToSVG runs the EXACT CLI pipeline (incl. module bodies)
 *   - validateSource returns null | structured diagnostic
 *   - tryCompileToSVG is the non-throwing form
 *
 * The module-body assertion is the regression for the bug where the old
 * "compose stage functions yourself" recipe silently rendered module
 * diagrams without their internals.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileToSVG, validateSource, tryCompileToSVG } from "../src/compile.js";

const countRects = (svg: string) => (svg.match(/<rect/g) ?? []).length;

describe("compileToSVG", () => {
  it("compiles a simple diagram to SVG", () => {
    const { svg } = compileToSVG("pipeline main: a -> b -> c");
    expect(svg).toContain("<svg");
    expect(countRects(svg)).toBeGreaterThanOrEqual(3);
  });

  it("includes module bodies (regression: library import dropped them)", () => {
    const path = resolve("examples/33-modules-basic.melk");
    const src = readFileSync(path, "utf8");
    const { svg } = compileToSVG(src, { filePath: path });
    // The CLI renders this as 10 rects; a body-dropping pipeline gives 3.
    expect(countRects(svg)).toBeGreaterThanOrEqual(8);
  });
});

describe("validateSource", () => {
  it("returns null on success", () => {
    expect(validateSource("a -> b")).toBeNull();
  });

  it("returns a structured diagnostic on failure", () => {
    const d = validateSource("a -> a");
    expect(d).not.toBeNull();
    expect(d!.code).toBe("E_SELF_EDGE");
    expect(d!.stage).toBe("bind");
  });

  it("surfaces render-stage errors (tag/legend) at validate", () => {
    expect(validateSource("a { tags: [hot] }\na -> b")!.code).toBe("E_UNKNOWN_TAG");
    expect(validateSource("legend: on\na -> b")!.code).toBe("E_LEGEND_NO_TAGS_USED");
  });

  it("reports an unknown theme name cleanly (not a filesystem ENOENT)", () => {
    expect(validateSource("theme: dark\na -> b")!.code).toBe("E_THEME_UNKNOWN");
  });
});

describe("tryCompileToSVG", () => {
  it("returns ok:true with svg on success", () => {
    const r = tryCompileToSVG("a -> b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.svg).toContain("<svg");
  });

  it("returns ok:false with a diagnostic on failure", () => {
    const r = tryCompileToSVG("pipeline m: a -> b -> c\nb -> side");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostic.code).toBe("E_AMBIGUOUS_PLACEMENT");
  });
});
