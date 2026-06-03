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
      size: { body: 13, edge: 11, frame: 11 },
      weight: { label: 500, heading: 600 },
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
