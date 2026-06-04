/**
 * Phase 5 theming tests.
 *
 * Cover the four built-in themes load cleanly, every validation error
 * path fires on the expected malformed input, and the resolveColour
 * helper handles token names + hex literals correctly.
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_THEME_NAMES,
  classifyTagRuleSwatch,
  COLOUR_TOKEN_NAMES,
  DEFAULT_THEME_NAME,
  loadTheme,
  resolveColour,
  resolveTags,
  TAG_PROPERTY_NAMES,
  ThemeError,
  validateTheme,
} from "../src/theme/theme.js";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import { reserveCorridors } from "../src/layout/corridors.js";
import { packTracks } from "../src/layout/tracks.js";
import { buildPolylines } from "../src/layout/polyline.js";
import { renderSVG } from "../src/render/svg.js";

// Helper: a minimal valid theme as a raw object. Tests mutate clones of
// this to exercise individual validation paths.
function validRaw(): Record<string, unknown> {
  return {
    name: "test",
    tokens: {
      surface: "#fafafa",
      "surface-raised": "#ffffff",
      "surface-sunken": "#eeeeee",
      "ink-primary": "#161616",
      "ink-secondary": "#5a6678",
      "border-strong": "#2b3340",
      "border-subtle": "#9fa9bb",
      "trace-default": "#3a4658",
      "trace-emphasis": "#2b6cb0",
      "trace-muted": "#7a8499",
      "status-error": "#c53030",
      "status-warn": "#b7791f",
      "status-ok": "#2f855a",
      "status-info": "#2b6cb0",
      "label-halo": "#fafafa",
      accents: ["#111111", "#222222", "#333333"],
    },
    typography: {
      face: "Inter",
      "face-mono": "JetBrains Mono",
      size: { body: 13, edge: 11, frame: 11, title: 20, subtitle: 13, caption: 9 },
      weight: { label: 500, heading: 600, title: 700, subtitle: 500 },
    },
    strokes: {
      outline: 1.5,
      trace: 1.5,
      emphasis: 3.5,
      frame: 1.0,
      "underground-opacity": 0.45,
      "underground-width": 1.0,
      "manhole-radius": 3,
      dash: { frame: [4, 3], "back-edge": [5, 3] },
      arrow: { scale: 3.5, "head-shape": "filled-triangle" },
    },
    tags: {},
  };
}

describe("built-in catalogue", () => {
  it("ships exactly four themes", () => {
    expect(BUILTIN_THEME_NAMES.sort()).toEqual([
      "document-dark",
      "document-light",
      "schematic-dark",
      "schematic-light",
    ]);
  });

  it("default is document-light", () => {
    expect(DEFAULT_THEME_NAME).toBe("document-light");
  });

  it.each(BUILTIN_THEME_NAMES)("loads built-in %s with no validation errors", (name) => {
    const theme = loadTheme(name);
    expect(theme.name).toBe(name);
    // Every token present.
    for (const tok of COLOUR_TOKEN_NAMES) {
      expect(theme.tokens[tok]).toMatch(/^#/);
    }
    // Accents in legal range.
    expect(theme.tokens.accents.length).toBeGreaterThanOrEqual(3);
    expect(theme.tokens.accents.length).toBeLessThanOrEqual(9);
  });

  it("schematic themes default to no arrowheads", () => {
    expect(loadTheme("schematic-light").strokes.arrow["head-shape"]).toBe("none");
    expect(loadTheme("schematic-dark").strokes.arrow["head-shape"]).toBe("none");
  });

  it("document themes default to filled-triangle arrowheads", () => {
    expect(loadTheme("document-light").strokes.arrow["head-shape"]).toBe("filled-triangle");
    expect(loadTheme("document-dark").strokes.arrow["head-shape"]).toBe("filled-triangle");
  });

  it("built-in tag library defines future / critical / deprecated", () => {
    for (const name of BUILTIN_THEME_NAMES) {
      const tags = loadTheme(name).tags;
      expect(Object.keys(tags).sort()).toEqual(["critical", "deprecated", "future"]);
    }
  });

  it("built-in tags ship with legend captions in every theme", () => {
    for (const name of BUILTIN_THEME_NAMES) {
      const tags = loadTheme(name).tags;
      expect(tags["future"]?.legend).toBe("Future state");
      expect(tags["critical"]?.legend).toBe("Critical path");
      expect(tags["deprecated"]?.legend).toBe("Deprecated route");
    }
  });
});

describe("validateTheme — required fields", () => {
  it("rejects non-object", () => {
    expect(() => validateTheme("hello", "test")).toThrow(/E_THEME_MISSING_FIELD/);
  });

  it("requires a name", () => {
    const raw = validRaw();
    delete raw["name"];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_MISSING_FIELD.*name/);
  });

  it("requires the tokens block", () => {
    const raw = validRaw();
    delete raw["tokens"];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_MISSING_FIELD.*tokens/);
  });

  it("requires every named token", () => {
    const raw = validRaw();
    delete (raw["tokens"] as Record<string, unknown>)["ink-primary"];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_MISSING_FIELD.*ink-primary/);
  });

  it("requires typography block", () => {
    const raw = validRaw();
    delete raw["typography"];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_MISSING_FIELD.*typography/);
  });

  it("requires strokes block", () => {
    const raw = validRaw();
    delete raw["strokes"];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_MISSING_FIELD.*strokes/);
  });
});

describe("validateTheme — colours", () => {
  it("rejects non-hex token value", () => {
    const raw = validRaw();
    (raw["tokens"] as Record<string, unknown>)["surface"] = "red";
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_COLOUR/);
  });

  it("accepts 3-digit hex", () => {
    const raw = validRaw();
    (raw["tokens"] as Record<string, unknown>)["surface"] = "#fff";
    expect(() => validateTheme(raw, "test")).not.toThrow();
  });

  it("rejects unknown token key", () => {
    const raw = validRaw();
    (raw["tokens"] as Record<string, unknown>)["surfaec"] = "#fafafa"; // typo
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_UNKNOWN_TOKEN.*surfaec/);
  });
});

describe("validateTheme — accents", () => {
  it("rejects too-short accents", () => {
    const raw = validRaw();
    (raw["tokens"] as Record<string, unknown>)["accents"] = ["#111", "#222"];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_ACCENTS_LENGTH/);
  });

  it("rejects too-long accents", () => {
    const raw = validRaw();
    (raw["tokens"] as Record<string, unknown>)["accents"] = new Array(10).fill("#111");
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_ACCENTS_LENGTH/);
  });

  it("rejects non-hex inside accents", () => {
    const raw = validRaw();
    (raw["tokens"] as Record<string, unknown>)["accents"] = ["#111", "red", "#333"];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_COLOUR.*accent/);
  });
});

describe("validateTheme — strokes", () => {
  it("rejects negative outline", () => {
    const raw = validRaw();
    (raw["strokes"] as Record<string, unknown>)["outline"] = -1;
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*outline/);
  });

  it("rejects underground-opacity > 1", () => {
    const raw = validRaw();
    (raw["strokes"] as Record<string, unknown>)["underground-opacity"] = 1.5;
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*underground-opacity/);
  });

  it("rejects bogus arrow head-shape", () => {
    const raw = validRaw();
    ((raw["strokes"] as Record<string, unknown>)["arrow"] as Record<string, unknown>)[
      "head-shape"
    ] = "circle";
    expect(() => validateTheme(raw, "test")).toThrow(/head-shape/);
  });

  it("accepts head-shape = none", () => {
    const raw = validRaw();
    ((raw["strokes"] as Record<string, unknown>)["arrow"] as Record<string, unknown>)[
      "head-shape"
    ] = "none";
    expect(() => validateTheme(raw, "test")).not.toThrow();
  });
});

describe("validateTheme — typography", () => {
  it("rejects non-integer weight", () => {
    const raw = validRaw();
    ((raw["typography"] as Record<string, unknown>)["weight"] as Record<string, unknown>)[
      "label"
    ] = 450.5;
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*weight/);
  });

  it("rejects weight out of [100, 900]", () => {
    const raw = validRaw();
    ((raw["typography"] as Record<string, unknown>)["weight"] as Record<string, unknown>)[
      "heading"
    ] = 50;
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*weight/);
  });

  it("rejects negative size", () => {
    const raw = validRaw();
    ((raw["typography"] as Record<string, unknown>)["size"] as Record<string, unknown>)["body"] =
      -1;
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*body/);
  });

  it("requires title size slot (DESIGN-PHASE5-TITLES §2.1)", () => {
    const raw = validRaw();
    delete ((raw["typography"] as Record<string, unknown>)["size"] as Record<string, unknown>)[
      "title"
    ];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*title/);
  });

  it("requires subtitle and caption size slots", () => {
    const raw = validRaw();
    delete ((raw["typography"] as Record<string, unknown>)["size"] as Record<string, unknown>)[
      "subtitle"
    ];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*subtitle/);
    const raw2 = validRaw();
    delete ((raw2["typography"] as Record<string, unknown>)["size"] as Record<string, unknown>)[
      "caption"
    ];
    expect(() => validateTheme(raw2, "test")).toThrow(/E_THEME_BAD_NUMBER.*caption/);
  });

  it("requires title and subtitle weight slots", () => {
    const raw = validRaw();
    delete ((raw["typography"] as Record<string, unknown>)["weight"] as Record<string, unknown>)[
      "title"
    ];
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*title/);
    const raw2 = validRaw();
    delete ((raw2["typography"] as Record<string, unknown>)["weight"] as Record<string, unknown>)[
      "subtitle"
    ];
    expect(() => validateTheme(raw2, "test")).toThrow(/E_THEME_BAD_NUMBER.*subtitle/);
  });

  it("built-in themes all carry the new title/subtitle/caption typography slots", () => {
    for (const name of BUILTIN_THEME_NAMES) {
      const t = loadTheme(name);
      expect(t.typography.size.title).toBeGreaterThan(0);
      expect(t.typography.size.subtitle).toBeGreaterThan(0);
      expect(t.typography.size.caption).toBeGreaterThan(0);
      expect(t.typography.weight.title).toBeGreaterThanOrEqual(100);
      expect(t.typography.weight.subtitle).toBeGreaterThanOrEqual(100);
    }
  });
});

describe("validateTheme — tag rules", () => {
  it("accepts empty tags block", () => {
    const raw = validRaw();
    raw["tags"] = {};
    expect(() => validateTheme(raw, "test")).not.toThrow();
  });

  it("accepts known properties with token name", () => {
    const raw = validRaw();
    raw["tags"] = { future: { border: "status-warn", "border-width": 2 } };
    const t = validateTheme(raw, "test");
    expect(t.tags["future"]?.border).toBe("status-warn");
    expect(t.tags["future"]?.["border-width"]).toBe(2);
  });

  it("accepts known properties with hex literal", () => {
    const raw = validRaw();
    raw["tags"] = { brand: { fill: "#abc123" } };
    expect(() => validateTheme(raw, "test")).not.toThrow();
  });

  it("rejects unknown tag property", () => {
    const raw = validRaw();
    raw["tags"] = { future: { shape: "circle" } }; // shape is geometry — forbidden
    expect(() => validateTheme(raw, "test")).toThrow(/E_UNKNOWN_TAG_PROPERTY.*shape/);
  });

  it("rejects colour-valued property with non-colour", () => {
    const raw = validRaw();
    raw["tags"] = { future: { border: "not-a-token" } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_COLOUR.*border/);
  });

  it("rejects opacity outside [0, 1]", () => {
    const raw = validRaw();
    raw["tags"] = { future: { opacity: 2 } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*opacity/);
  });

  it("accepts dash as array or null", () => {
    const raw = validRaw();
    raw["tags"] = {
      a: { dash: [4, 3] },
      b: { dash: null },
    };
    const t = validateTheme(raw, "test");
    expect(t.tags["a"]?.dash).toEqual([4, 3]);
    expect(t.tags["b"]?.dash).toBeNull();
  });

  it("rejects dash with negative entry", () => {
    const raw = validRaw();
    raw["tags"] = { a: { dash: [4, -1] } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_NUMBER.*dash/);
  });

  it("covers every property in the TAG_PROPERTY_NAMES table", () => {
    const raw = validRaw();
    raw["tags"] = {
      all: {
        fill: "surface-raised",
        border: "border-strong",
        "border-width": 2,
        text: "ink-primary",
        "text-weight": 600,
        trace: "trace-default",
        "trace-width": 2,
        dash: [4, 3],
        opacity: 0.8,
        legend: "All properties",
        swatch: "box",
        "icon-color": "ink-primary",
      },
    };
    const t = validateTheme(raw, "test");
    const rule = t.tags["all"]!;
    // Every TAG_PROPERTY_NAMES entry should have round-tripped.
    for (const prop of TAG_PROPERTY_NAMES) {
      expect(rule).toHaveProperty(prop);
    }
  });
});

describe("gradient parsing (fill addendum)", () => {
  it("accepts a two-stop linear gradient with explicit angle", () => {
    const raw = validRaw();
    raw["tags"] = { hot: { fill: "linear 45deg, status-warn, status-error" } };
    const t = validateTheme(raw, "test");
    expect(t.tags["hot"]?.fill).toBe("linear 45deg, status-warn, status-error");
  });

  it("accepts a three-stop gradient (mixed tokens + hex)", () => {
    const raw = validRaw();
    raw["tags"] = {
      tri: { fill: "linear 90deg, #ffffff, ink-secondary, #000000" },
    };
    expect(() => validateTheme(raw, "test")).not.toThrow();
  });

  it("rejects a gradient with no angle", () => {
    const raw = validRaw();
    raw["tags"] = { bad: { fill: "linear status-warn, status-error" } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_GRADIENT/);
  });

  it("rejects a gradient with only one stop", () => {
    const raw = validRaw();
    raw["tags"] = { lonely: { fill: "linear 45deg, status-warn" } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_GRADIENT/);
  });

  it("rejects a gradient with an invalid stop colour", () => {
    const raw = validRaw();
    raw["tags"] = {
      typo: { fill: "linear 45deg, status-warn, not-a-token" },
    };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_COLOUR.*not-a-token/);
  });

  it("border accepts gradients (fill + border + icon-color are gradient-eligible)", () => {
    const raw = validRaw();
    raw["tags"] = {
      gradient_border: { border: "linear 45deg, status-warn, status-error" },
    };
    expect(() => validateTheme(raw, "test")).not.toThrow();
  });

  it("icon-color accepts gradients", () => {
    const raw = validRaw();
    raw["tags"] = {
      gradient_icon: { "icon-color": "linear 90deg, status-info, status-ok" },
    };
    expect(() => validateTheme(raw, "test")).not.toThrow();
  });

  it("text rejects gradients (gradient-ineligible colour prop)", () => {
    const raw = validRaw();
    raw["tags"] = {
      gradient_text: { text: "linear 45deg, status-warn, status-error" },
    };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_COLOUR/);
  });

  it("trace rejects gradients (gradient-ineligible colour prop)", () => {
    const raw = validRaw();
    raw["tags"] = {
      gradient_trace: { trace: "linear 45deg, status-warn, status-error" },
    };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_COLOUR/);
  });
});

describe("validateTheme — legend caption", () => {
  it("accepts a non-empty single-line legend", () => {
    const raw = validRaw();
    raw["tags"] = { future: { border: "status-warn", legend: "Future state" } };
    const t = validateTheme(raw, "test");
    expect(t.tags["future"]?.legend).toBe("Future state");
  });

  it("rejects empty legend string", () => {
    const raw = validRaw();
    raw["tags"] = { future: { border: "status-warn", legend: "" } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_VALUE.*legend/);
  });

  it("rejects non-string legend", () => {
    const raw = validRaw();
    raw["tags"] = { future: { border: "status-warn", legend: 42 } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_VALUE.*legend/);
  });

  it("rejects multi-line legend (newline)", () => {
    const raw = validRaw();
    raw["tags"] = { future: { border: "status-warn", legend: "line1\nline2" } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_VALUE.*single-line/);
  });

  it("rejects multi-line legend (carriage return)", () => {
    const raw = validRaw();
    raw["tags"] = { future: { border: "status-warn", legend: "line1\rline2" } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_VALUE.*single-line/);
  });
});

describe("validateTheme — swatch override", () => {
  it("accepts 'box' and 'line'", () => {
    const raw = validRaw();
    raw["tags"] = {
      a: { border: "status-warn", swatch: "box" },
      b: { trace: "trace-default", swatch: "line" },
    };
    const t = validateTheme(raw, "test");
    expect(t.tags["a"]?.swatch).toBe("box");
    expect(t.tags["b"]?.swatch).toBe("line");
  });

  it("rejects bogus swatch value", () => {
    const raw = validRaw();
    raw["tags"] = { a: { border: "status-warn", swatch: "circle" } };
    expect(() => validateTheme(raw, "test")).toThrow(/E_THEME_BAD_VALUE.*swatch/);
  });
});

describe("classifyTagRuleSwatch", () => {
  it("classifies node-only rule as box", () => {
    expect(classifyTagRuleSwatch({ border: "status-warn", "border-width": 2 })).toBe("box");
    expect(classifyTagRuleSwatch({ fill: "#fff" })).toBe("box");
    expect(classifyTagRuleSwatch({ text: "#000", "text-weight": 600 })).toBe("box");
  });

  it("classifies edge-only rule as line", () => {
    expect(classifyTagRuleSwatch({ trace: "ink-secondary" })).toBe("line");
    expect(classifyTagRuleSwatch({ "trace-width": 2 })).toBe("line");
  });

  it("falls back to box for dash/opacity-only rule", () => {
    expect(classifyTagRuleSwatch({ dash: [4, 3] })).toBe("box");
    expect(classifyTagRuleSwatch({ opacity: 0.5 })).toBe("box");
    expect(classifyTagRuleSwatch({ dash: [4, 3], opacity: 0.5 })).toBe("box");
    expect(classifyTagRuleSwatch({})).toBe("box");
  });

  it("classifies mixed node+edge rule as box (node wins)", () => {
    // Mixed should prefer box per the inference rule (node check runs first).
    expect(classifyTagRuleSwatch({ border: "status-warn", trace: "trace-default" })).toBe(
      "box",
    );
  });

  it("explicit swatch override wins over inference", () => {
    expect(classifyTagRuleSwatch({ border: "status-warn", swatch: "line" })).toBe("line");
    expect(classifyTagRuleSwatch({ trace: "trace-default", swatch: "box" })).toBe("box");
    expect(classifyTagRuleSwatch({ swatch: "line" })).toBe("line");
  });

  it("ignores legend caption during inference", () => {
    // Caption is not a class affiliation.
    expect(classifyTagRuleSwatch({ legend: "Hello" })).toBe("box"); // fallback
    expect(classifyTagRuleSwatch({ legend: "X", trace: "trace-default" })).toBe("line");
  });
});

describe("loadTheme", () => {
  it("resolves a built-in name", () => {
    const t = loadTheme("schematic-dark");
    expect(t.name).toBe("schematic-dark");
  });

  it("fails clearly when path doesn't exist", () => {
    expect(() => loadTheme("./does-not-exist.json")).toThrow(/E_THEME_LOAD_FAILED/);
  });

  it("fails clearly on bad JSON", () => {
    // Pointing at the .ts file produces a parse error — close enough.
    expect(() => loadTheme("./src/theme/theme.ts")).toThrow(/E_THEME_LOAD_FAILED/);
  });
});

describe("resolveTags", () => {
  const theme = loadTheme("document-light"); // ships future/critical/deprecated

  it("returns empty rule for undefined / empty input", () => {
    expect(resolveTags(theme, undefined, "x")).toEqual({});
    expect(resolveTags(theme, [], "x")).toEqual({});
  });

  it("composes multiple tags, later overrides earlier", () => {
    // future: border=status-warn, border-width=1.5, dash=[4,3]
    // critical: border=status-error, border-width=1.5
    // critical comes second → its border wins; dash from future survives
    const rule = resolveTags(theme, ["future", "critical"], "node x");
    expect(rule.border).toBe("status-error");
    expect(rule["border-width"]).toBe(1.5);
    expect(rule.dash).toEqual([4, 3]);
  });

  it("raises E_UNKNOWN_TAG with theme name and known tags listed", () => {
    expect(() => resolveTags(theme, ["nope"], "node x")).toThrow(
      /E_UNKNOWN_TAG.*nope.*document-light/,
    );
  });
});

describe("`theme:` directive + bind", () => {
  it("propagates theme name into Model.themeName", () => {
    const m = bind(parse(tokenize("theme: schematic-dark\npipeline p: a -> b -> c")));
    expect(m.themeName).toBe("schematic-dark");
  });

  it("absent directive leaves Model.themeName undefined", () => {
    const m = bind(parse(tokenize("pipeline p: a -> b -> c")));
    expect(m.themeName).toBeUndefined();
  });

  it("accepts quoted path", () => {
    const m = bind(parse(tokenize('theme: "./themes/x.json"\npipeline p: a -> b')));
    expect(m.themeName).toBe("./themes/x.json");
  });

  it("multiple directives: last wins", () => {
    const m = bind(parse(tokenize("theme: document-dark\ntheme: schematic-light\na -> b")));
    expect(m.themeName).toBe("schematic-light");
  });
});

describe("`legend:` directive + bind (DESIGN-PHASE5-LEGEND §2.1)", () => {
  it("legend: on enables the legend with default position", () => {
    const m = bind(parse(tokenize("legend: on\na -> b")));
    expect(m.legend).toEqual({ on: true, position: "bottom" });
  });

  it("absence of directive leaves legend off (undefined field)", () => {
    const m = bind(parse(tokenize("a -> b")));
    expect(m.legend).toBeUndefined();
  });

  it("legend: off disables", () => {
    const m = bind(parse(tokenize("legend: off\na -> b")));
    expect(m.legend).toBeUndefined();
  });

  it("legend: <typo> silently disables (binary by content match)", () => {
    // Per the design, anything other than `on` is off. No error.
    const m = bind(parse(tokenize("legend: onn\na -> b")));
    expect(m.legend).toBeUndefined();
  });

  it("legend: on followed by legend: off → off (last wins)", () => {
    const m = bind(parse(tokenize("legend: on\nlegend: off\na -> b")));
    expect(m.legend).toBeUndefined();
  });

  it("legend: off followed by legend: on → on (last wins)", () => {
    const m = bind(parse(tokenize("legend: off\nlegend: on\na -> b")));
    expect(m.legend?.on).toBe(true);
  });
});

describe("`legend-position:` directive + bind (DESIGN-PHASE5-LEGEND §2.2)", () => {
  it("propagates to Model.legend.position when paired with legend: on", () => {
    const m = bind(parse(tokenize("legend: on\nlegend-position: right\na -> b")));
    expect(m.legend).toEqual({ on: true, position: "right" });
  });

  it("accepts all four legal positions", () => {
    for (const pos of ["bottom", "right", "top", "left"]) {
      const m = bind(parse(tokenize(`legend: on\nlegend-position: ${pos}\na -> b`)));
      expect(m.legend?.position).toBe(pos);
    }
  });

  it("rejects unknown position with E_LEGEND_BAD_POSITION", () => {
    expect(() => parse(tokenize("legend: on\nlegend-position: rite\na -> b"))).toThrow(
      /E_LEGEND_BAD_POSITION/,
    );
  });

  it("orphan legend-position (no legend: on) raises E_LEGEND_POSITION_WITHOUT_LEGEND", () => {
    expect(() => bind(parse(tokenize("legend-position: right\na -> b")))).toThrow(
      /E_LEGEND_POSITION_WITHOUT_LEGEND/,
    );
  });

  it("orphan legend-position even when legend: off raises the error", () => {
    expect(() =>
      bind(parse(tokenize("legend: off\nlegend-position: right\na -> b"))),
    ).toThrow(/E_LEGEND_POSITION_WITHOUT_LEGEND/);
  });
});

describe("`tags:` brace-attr + bind", () => {
  it("attaches tags to a node", () => {
    const m = bind(parse(tokenize("a { tags: [future, critical] }")));
    const node = m.nodes.find((n) => n.id === "a");
    expect(node?.tags).toEqual(["future", "critical"]);
  });

  it("accepts bare-ident form", () => {
    const m = bind(parse(tokenize("a { tags: future }")));
    expect(m.nodes.find((n) => n.id === "a")?.tags).toEqual(["future"]);
  });

  it("empty tag list yields no tags attr", () => {
    const m = bind(parse(tokenize("a { tags: [] }")));
    expect(m.nodes.find((n) => n.id === "a")?.tags).toBeUndefined();
  });

  it("attaches tags to an edge", () => {
    const m = bind(parse(tokenize("a -> b { tags: [deprecated] }")));
    expect(m.edges[0]?.tags).toEqual(["deprecated"]);
  });
});

describe("end-to-end: theme swap + tag overrides change SVG output", () => {
  function render(src: string, themeName: string): string {
    const m = bind(parse(tokenize(src)));
    const p = place(m);
    const r = reserveCorridors(m, p);
    const t = packTracks(m, p, r);
    const polys = buildPolylines(m, p, r, t);
    return renderSVG(m, p, r, polys, loadTheme(themeName));
  }

  it("same source renders different surface fill under different themes", () => {
    const src = "pipeline p: a -> b -> c";
    const light = render(src, "document-light");
    const dark = render(src, "schematic-dark");
    expect(light).toContain('fill="#fafafa"'); // document-light surface
    expect(dark).toContain('fill="#0d1117"'); // schematic-dark surface
  });

  it("schematic themes suppress arrowheads", () => {
    const src = "pipeline p: a -> b";
    const doc = render(src, "document-light");
    const sch = render(src, "schematic-dark");
    expect(doc).toContain('marker-end="url(#arrow)"');
    expect(sch).not.toContain('marker-end="url(#arrow)"');
    expect(sch).toContain("<defs></defs>"); // no marker either
  });

  it("tag override changes a node's border colour without moving anything", () => {
    const tagged = "a { tags: [critical] }\npipeline p: a -> b -> c";
    const untagged = "pipeline p: a -> b -> c";
    const t = render(tagged, "document-light");
    const u = render(untagged, "document-light");
    // The 'critical' tag in document-light sets border: status-error (#dc2626).
    expect(t).toContain('stroke="#dc2626"');
    expect(u).not.toContain('stroke="#dc2626"');
    // Polylines should be identical — same source-edges → same geometry.
    const tPaths = (t.match(/<path d="[^"]+"/g) || []).sort();
    const uPaths = (u.match(/<path d="[^"]+"/g) || []).sort();
    expect(tPaths).toEqual(uPaths);
  });

  it("unknown tag fires E_UNKNOWN_TAG at render time", () => {
    const src = "a { tags: [made-up] }\na -> b";
    expect(() => render(src, "document-light")).toThrow(/E_UNKNOWN_TAG.*made-up/);
  });

  it("edge tag override changes trace colour", () => {
    const src = "a -> b { tags: [deprecated] }";
    const out = render(src, "document-light");
    // 'deprecated' in document-light: trace: ink-secondary (= #64748b),
    // dash: [3,3], opacity: 0.6
    expect(out).toContain('stroke="#64748b"');
    expect(out).toContain('stroke-dasharray="3 3"');
    expect(out).toContain('opacity="0.6"');
  });
});

describe("end-to-end: gradient fill rendering", () => {
  function renderWith(src: string, themeOverride: (raw: Record<string, unknown>) => void) {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    themeOverride(raw);
    const theme = validateTheme(raw, "<test>");
    const m = bind(parse(tokenize(src)));
    const p = place(m);
    const r = reserveCorridors(m, p);
    const t = packTracks(m, p, r);
    const polys = buildPolylines(m, p, r, t);
    return renderSVG(m, p, r, polys, theme);
  }

  it("rect with gradient fill emits a <linearGradient> def + url() fill", () => {
    const out = renderWith(
      "a { shape: rect, tags: [hot], label: \"hot\" }\na -> b",
      (raw) => {
        raw.tags["hot"] = {
          fill: "linear 90deg, status-warn, status-error",
        };
      },
    );
    expect(out).toContain("<linearGradient");
    expect(out).toContain('id="tag-gradient-0"');
    expect(out).toMatch(/<rect[^>]+fill="url\(#tag-gradient-0\)"/);
    // Both stops are present at the resolved hex.
    expect(out).toContain('stop-color="#d97706"'); // status-warn
    expect(out).toContain('stop-color="#dc2626"'); // status-error
  });

  it("identical gradients on multiple nodes share a single def", () => {
    const out = renderWith(
      [
        "a { shape: rect, tags: [hot], label: \"a\" }",
        "b { shape: rect, tags: [hot], label: \"b\" }",
        "a -> b",
      ].join("\n"),
      (raw) => {
        raw.tags["hot"] = { fill: "linear 45deg, status-warn, status-error" };
      },
    );
    // One gradient def, two url() references.
    expect((out.match(/<linearGradient/g) || []).length).toBe(1);
    expect((out.match(/fill="url\(#tag-gradient-0\)"/g) || []).length).toBe(2);
  });

  it("icon node with gradient fill paints a background rect behind the glyph", () => {
    // No icon pack registered → placeholder, but the fill rect should
    // still emit (it's drawn behind whatever the icon-as-body
    // produces, which is the placeholder here).
    const out = renderWith(
      [
        'icons: arch from "./does-not-exist/"',
        'srv { shape: icon(arch/server), tags: [card], label: "API" }',
        "srv -> b",
      ].join("\n"),
      (raw) => {
        raw.tags["card"] = { fill: "linear 135deg, surface, surface-sunken" };
      },
    );
    // Background rect with gradient url, drawn over the cell footprint.
    expect(out).toMatch(/<rect[^>]+fill="url\(#tag-gradient-0\)"/);
  });

  it("circle with gradient fill resolves through the same path", () => {
    const out = renderWith(
      "c { shape: circle, tags: [glow], label: \"event\" }\nc -> b",
      (raw) => {
        raw.tags["glow"] = { fill: "linear 0deg, status-info, ink-primary" };
      },
    );
    expect(out).toContain("<linearGradient");
    expect(out).toMatch(/<circle[^>]+fill="url\(/);
  });

  it("rect with gradient border renders stroke as url()", () => {
    const out = renderWith(
      "a { shape: rect, tags: [edge], label: \"a\" }\na -> b",
      (raw) => {
        raw.tags["edge"] = { border: "linear 90deg, status-warn, status-error" };
      },
    );
    expect(out).toContain("<linearGradient");
    expect(out).toMatch(/<rect[^>]+stroke="url\(/);
  });

  it("rect with gradient border + gradient fill emits two distinct defs", () => {
    const out = renderWith(
      "a { shape: rect, tags: [both], label: \"a\" }\na -> b",
      (raw) => {
        raw.tags["both"] = {
          border: "linear 90deg, status-warn, status-error",
          fill: "linear 45deg, surface, surface-sunken",
        };
      },
    );
    expect((out.match(/<linearGradient/g) || []).length).toBe(2);
  });
});

describe("resolveColour", () => {
  const theme = loadTheme("document-light");

  it("returns hex literal unchanged", () => {
    expect(resolveColour(theme, "#abc123")).toBe("#abc123");
  });

  it("looks up token name in active theme", () => {
    expect(resolveColour(theme, "ink-primary")).toBe(theme.tokens["ink-primary"]);
  });

  it("throws on unknown name (defensive)", () => {
    expect(() => resolveColour(theme, "not-a-token")).toThrow(ThemeError);
  });
});
