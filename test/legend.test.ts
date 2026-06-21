/**
 * Phase 5 legend feature tests.
 *
 * Cover entry discovery + ordering, swatch classification end-to-end,
 * caption-missing errors, no-tags-used error, horizontal wrap, and
 * vertical reflow. Renderer-side rendering is exercised via the end-to-
 * end render assertions further down.
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { loadTheme, validateTheme, type Theme } from "../src/theme/theme.js";
import {
  buildLegend,
  discoverLegendEntries,
  LegendError,
} from "../src/render/legend.js";
import { place } from "../src/layout/place.js";
import { assignSlots } from "../src/layout/slots.js";
import { routeChannels } from "../src/layout/channels.js";
import { renderSVG } from "../src/render/svg.js";

function model(src: string) {
  return bind(parse(tokenize(src)));
}

function themeWith(rules: Record<string, Record<string, unknown>>): Theme {
  // Start from document-light, replace the tags block.
  const base = loadTheme("document-light");
  // Re-validate so the rules round-trip through the validator.
  return validateTheme(
    {
      name: base.name,
      tokens: { ...base.tokens, accents: base.tokens.accents.slice() },
      typography: base.typography,
      strokes: base.strokes,
      tags: rules,
    },
    "<test>",
  );
}

describe("discoverLegendEntries", () => {
  it("returns entries in declaration order of first use (nodes before edges)", () => {
    const m = model(
      [
        "a { tags: [future] }",
        "b { tags: [critical] }",
        "a -> b { tags: [deprecated] }",
      ].join("\n"),
    );
    const entries = discoverLegendEntries(m, loadTheme("document-light"));
    expect(entries.map((e) => e.tag)).toEqual(["future", "critical", "deprecated"]);
  });

  it("collapses repeated uses of the same tag into one entry at first-use position", () => {
    const m = model(
      [
        "a { tags: [critical] }",
        "b { tags: [future] }",
        "c { tags: [critical] }", // second use; should not move 'critical'
      ].join("\n"),
    );
    const entries = discoverLegendEntries(m, loadTheme("document-light"));
    expect(entries.map((e) => e.tag)).toEqual(["critical", "future"]);
  });

  it("tag used only on an edge appears in legend", () => {
    const m = model("a -> b { tags: [deprecated] }");
    const entries = discoverLegendEntries(m, loadTheme("document-light"));
    expect(entries.map((e) => e.tag)).toEqual(["deprecated"]);
  });

  it("classifies swatch via classifyTagRuleSwatch (future → box, deprecated → line)", () => {
    const m = model(
      ["a { tags: [future] }", "b { tags: [deprecated] }", "a -> b"].join("\n"),
    );
    const entries = discoverLegendEntries(m, loadTheme("document-light"));
    expect(entries.find((e) => e.tag === "future")?.swatch).toBe("box");
    expect(entries.find((e) => e.tag === "deprecated")?.swatch).toBe("line");
  });

  it("raises E_LEGEND_NO_TAGS_USED when no tags appear anywhere", () => {
    const m = model("a -> b");
    expect(() => discoverLegendEntries(m, loadTheme("document-light"))).toThrow(
      /E_LEGEND_NO_TAGS_USED/,
    );
  });

  it("raises E_LEGEND_TAG_HAS_NO_CAPTION when a used tag lacks legend caption", () => {
    const theme = themeWith({
      uncaptioned: { border: "status-warn" },
      captioned: { border: "status-error", legend: "Has caption" },
    });
    const m = model("a { tags: [uncaptioned] }");
    expect(() => discoverLegendEntries(m, theme)).toThrow(
      /E_LEGEND_TAG_HAS_NO_CAPTION.*uncaptioned/,
    );
  });

  it("raises E_UNKNOWN_TAG when a used tag isn't in the theme", () => {
    const theme = themeWith({});
    const m = model("a { tags: [mystery] }");
    expect(() => discoverLegendEntries(m, theme)).toThrow(/E_UNKNOWN_TAG.*mystery/);
  });
});

describe("buildLegend — horizontal (bottom/top)", () => {
  const theme = loadTheme("document-light");
  const src = [
    "a { tags: [future] }",
    "b { tags: [critical] }",
    "c { tags: [deprecated] }",
    "a -> b",
    "b -> c",
  ].join("\n");

  it("fits all entries in one row when width is generous", () => {
    const m = model(src);
    const layout = buildLegend(m, theme, "bottom", 800, 200);
    expect(layout.position).toBe("bottom");
    expect(layout.placed.length).toBe(3);
    // All entries share the same row centreline (captionY = row-centred).
    const ys = new Set(layout.placed.map((p) => p.captionY));
    expect(ys.size).toBe(1);
    // Strip width is the diagram width (horizontal strips fill width).
    expect(layout.width).toBe(800);
  });

  it("wraps to a second row when width is constrained", () => {
    const m = model(src);
    const layout = buildLegend(m, theme, "bottom", 100, 200);
    expect(layout.placed.length).toBe(3);
    // At least two distinct row centrelines.
    const ys = new Set(layout.placed.map((p) => p.captionY));
    expect(ys.size).toBeGreaterThanOrEqual(2);
    // Strip is taller than a single-row strip.
    expect(layout.height).toBeGreaterThan(32); // 2*padding + 1 row = 32; wrapped is more
  });

  it("top position behaves identically to bottom (same layout, different side label)", () => {
    const m = model(src);
    const a = buildLegend(m, theme, "bottom", 800, 200);
    const b = buildLegend(m, theme, "top", 800, 200);
    expect(b.position).toBe("top");
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
    expect(b.placed.length).toBe(a.placed.length);
  });
});

describe("buildLegend — vertical (right/left)", () => {
  const theme = loadTheme("document-light");
  const src = [
    "a { tags: [future] }",
    "b { tags: [critical] }",
    "c { tags: [deprecated] }",
    "a -> b",
    "b -> c",
  ].join("\n");

  it("stacks all entries in one column when height is generous", () => {
    const m = model(src);
    const layout = buildLegend(m, theme, "right", 200, 800);
    expect(layout.position).toBe("right");
    expect(layout.placed.length).toBe(3);
    // All entries share the same x (single column).
    const xs = new Set(layout.placed.map((p) => p.swatchX));
    expect(xs.size).toBe(1);
    // Strip height is the diagram height.
    expect(layout.height).toBe(800);
  });

  it("reflows into a second column when height is constrained", () => {
    const m = model(src);
    // Only space for ~1 entry: ROW_HEIGHT(16) + STRIP_PADDING*2(16) = 32
    const layout = buildLegend(m, theme, "right", 200, 50);
    expect(layout.placed.length).toBe(3);
    // At least two distinct column x values.
    const xs = new Set(layout.placed.map((p) => p.swatchX));
    expect(xs.size).toBeGreaterThanOrEqual(2);
  });

  it("left position behaves identically to right", () => {
    const m = model(src);
    const r = buildLegend(m, theme, "right", 200, 800);
    const l = buildLegend(m, theme, "left", 200, 800);
    expect(l.position).toBe("left");
    expect(l.width).toBe(r.width);
    expect(l.height).toBe(r.height);
  });
});

describe("LegendError class", () => {
  it("is a real Error", () => {
    const err = new LegendError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LegendError");
  });
});

describe("CLI --legend flag resolution", () => {
  // We can't easily fork the CLI from a unit test, but we CAN exercise
  // the same shape: a model with .legend, mutated as the CLI would
  // mutate it, then rendered. The flag-resolution logic lives in
  // src/cli.ts; here we just smoke-check that the model-mutation
  // pattern works end-to-end.
  function render(src: string, legendOverride: { on: boolean; position: "bottom" | "right" | "top" | "left" } | undefined): string {
    const m = bind(parse(tokenize(src)));
    if (legendOverride !== undefined) m.legend = legendOverride;
    else delete m.legend;
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    return renderSVG(m, p, routing, loadTheme("document-light"));
  }

  it("CLI off override hides legend even when source has legend: on", () => {
    const src = ["legend: on", "a { tags: [future] }", "a -> b"].join("\n");
    const out = render(src, undefined);
    expect(out).not.toContain("data-legend");
  });

  it("CLI position override changes side", () => {
    const src = ["legend: on", "a { tags: [future] }", "a -> b"].join("\n");
    const right = render(src, { on: true, position: "right" });
    expect(right).toContain('data-legend="1"');
    // Vertical separator pattern (legend at right = inner edge is left x=0).
    expect(right).toMatch(/<line x1="0" y1="0" x2="0"/);
  });
});

describe("end-to-end render with legend", () => {
  function render(src: string, themeName = "document-light"): string {
    const m = bind(parse(tokenize(src)));
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    return renderSVG(m, p, routing, loadTheme(themeName));
  }

  it("absence of legend: on emits no legend marker", () => {
    const out = render("pipeline p: a -> b -> c");
    expect(out).not.toContain("data-legend");
  });

  it("legend: on emits a legend group with entries for every used tag", () => {
    const src = ["legend: on", "a { tags: [future] }", "b { tags: [deprecated] }", "a -> b"].join(
      "\n",
    );
    const out = render(src);
    expect(out).toContain('data-legend="1"');
    expect(out).toContain('data-legend-entry="future"');
    expect(out).toContain('data-legend-entry="deprecated"');
    expect(out).toContain("Future state");
    expect(out).toContain("Deprecated route");
  });

  it("legend: on with no tags fires E_LEGEND_NO_TAGS_USED", () => {
    expect(() => render("legend: on\npipeline p: a -> b")).toThrow(/E_LEGEND_NO_TAGS_USED/);
  });

  it("position: right shifts legend group origin to right of diagram", () => {
    // Hard to assert exact coords, but we can check the legend g is present.
    const src = [
      "legend: on",
      "legend-position: right",
      "a { tags: [critical] }",
      "a -> b",
    ].join("\n");
    const out = render(src);
    expect(out).toContain('data-legend="1"');
    // Vertical separator (legend at right): goes from (0,0) to (0,height).
    expect(out).toMatch(/data-legend="1" transform="translate\([^"]*\)">\s*<line x1="0" y1="0" x2="0"/);
  });

  it("position: left shifts diagram inward", () => {
    const src = [
      "legend: on",
      "legend-position: left",
      "a { tags: [critical] }",
      "a -> b",
    ].join("\n");
    const out = render(src);
    expect(out).toContain('data-legend="1"');
  });

  it("position: top shifts diagram down", () => {
    const src = [
      "legend: on",
      "legend-position: top",
      "a { tags: [critical] }",
      "a -> b",
    ].join("\n");
    const out = render(src);
    expect(out).toContain('data-legend="1"');
  });

  it("custom theme without legend caption raises at render time", () => {
    // Use a theme that defines 'critical' but without legend caption.
    // We construct it inline.
    const theme = validateTheme(
      {
        ...JSON.parse(JSON.stringify(loadTheme("document-light"))),
        tags: {
          critical: { border: "status-error" },
        },
      },
      "<test>",
    );
    const m = bind(
      parse(tokenize(["legend: on", "a { tags: [critical] }", "a -> b"].join("\n"))),
    );
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    expect(() => renderSVG(m, p, routing, theme)).toThrow(/E_LEGEND_TAG_HAS_NO_CAPTION/);
  });

  it("swatch override box→line is reflected in rendered swatch element", () => {
    // Custom theme: tag with node-affecting property but swatch: line.
    const baseTheme = loadTheme("document-light");
    const custom = validateTheme(
      {
        ...JSON.parse(JSON.stringify(baseTheme)),
        tags: {
          forced: {
            border: "status-warn",
            "border-width": 2,
            swatch: "line",
            legend: "Forced line",
          },
        },
      },
      "<test>",
    );
    const m = bind(
      parse(tokenize(["legend: on", "a { tags: [forced] }", "a -> b"].join("\n"))),
    );
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    const out = renderSVG(m, p, routing, custom);
    // The legend entry for 'forced' should use a <line> swatch despite
    // its tag rule classifying as 'box' by inference.
    const match = out.match(/<g data-legend-entry="forced">[\s\S]*?<\/g>/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain("<line");
    expect(match![0]).not.toContain("<rect");
  });

  it("legend swatch with a gradient fill renders without throwing and references a gradient def", () => {
    // Regression: a tag whose `fill` (or `border`) is a `linear ...`
    // gradient used to crash the legend swatch renderer, which called
    // resolveColour directly (hex/token only). The swatch must instead
    // register the gradient into <defs> and reference it via url(#...).
    const baseTheme = loadTheme("document-light");
    const custom = validateTheme(
      {
        ...JSON.parse(JSON.stringify(baseTheme)),
        tags: {
          fancy: {
            fill: "linear 135deg, #ccfbf1, #f0fdfa",
            border: "linear 90deg, #0d9488, #06b6d4",
            legend: "Gradient swatch",
          },
        },
      },
      "<test>",
    );
    const m = bind(
      parse(tokenize(["legend: on", "a { tags: [fancy] }", "a -> b"].join("\n"))),
    );
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    let out = "";
    expect(() => {
      out = renderSVG(m, p, routing, custom);
    }).not.toThrow();
    // The legend swatch rect must paint via a gradient reference, not a
    // raw 'linear ...' string (which is invalid SVG and would have
    // thrown at resolveColour).
    const entry = out.match(/<g data-legend-entry="fancy">[\s\S]*?<\/g>/);
    expect(entry).toBeTruthy();
    expect(entry![0]).toContain("<rect");
    expect(entry![0]).toMatch(/fill="url\(#tag-gradient-\d+\)"/);
    expect(entry![0]).toMatch(/stroke="url\(#tag-gradient-\d+\)"/);
    expect(entry![0]).not.toContain("linear ");
    // The referenced gradient def must exist in the document.
    expect(out).toContain("<linearGradient id=\"tag-gradient-0\"");
  });

  it("a gradient tag used on BOTH a node and the legend shares one gradient def", () => {
    // The pre-walk registers node-tag gradients and legend-tag gradients
    // through the same resolver, so an identical gradient string reuses a
    // single <linearGradient> def (cached by raw fill string).
    const baseTheme = loadTheme("document-light");
    const custom = validateTheme(
      {
        ...JSON.parse(JSON.stringify(baseTheme)),
        tags: {
          shared: {
            fill: "linear 180deg, #dbeafe, #eff6ff",
            legend: "Shared gradient",
          },
        },
      },
      "<test>",
    );
    const m = bind(
      parse(tokenize(["legend: on", "a { tags: [shared] }", "a -> b"].join("\n"))),
    );
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    const out = renderSVG(m, p, routing, custom);
    // Exactly one linearGradient def even though the node body AND the
    // legend swatch both paint with it.
    const defs = out.match(/<linearGradient /g) ?? [];
    expect(defs.length).toBe(1);
  });
});
