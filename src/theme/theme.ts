/**
 * Phase 5 theming.
 *
 * A Theme is a swappable bundle of semantic tokens, typography, stroke
 * metrics, and tag-rule overrides. The renderer reads tokens through this
 * interface instead of from module-level constants; swapping themes is
 * the only mechanism for changing the diagram's visual appearance.
 *
 * The vocabulary is CLOSED (DESIGN-PHASE5-THEMING.md §1.2 / §1.5):
 *
 *   - the set of token names is fixed; adding a token is a spec change
 *   - the set of tag-rule properties is fixed and intentionally excludes
 *     every geometry-affecting property (shape, size, cell, routing, ...)
 *
 * This file owns: the TS types, the four built-in theme loaders, the
 * loader/validator (loadTheme), and the error class.
 *
 * Themes are pure data — no module-level mutation, no side effects beyond
 * reading from disk in loadThemeFromPath.
 */
import { readFileSync } from "node:fs";

// --- token names ----------------------------------------------------------

/**
 * The closed set of semantic colour tokens. Every theme must provide a
 * value for every token. Validation rejects any extra keys (typos).
 *
 * See DESIGN-PHASE5-THEMING.md §1.2 for the per-token semantics.
 */
export const COLOUR_TOKEN_NAMES = [
  "surface",
  "surface-raised",
  "surface-sunken",
  "ink-primary",
  "ink-secondary",
  "border-strong",
  "border-subtle",
  "trace-default",
  "trace-emphasis",
  "trace-muted",
  "status-error",
  "status-warn",
  "status-ok",
  "status-info",
  "label-halo",
] as const;

export type ColourTokenName = (typeof COLOUR_TOKEN_NAMES)[number];

/** Set form for fast `has()` checks during validation. */
const COLOUR_TOKEN_SET = new Set<string>(COLOUR_TOKEN_NAMES);

/** Tag-rule properties that accept a colour value (token name or hex). */
const COLOUR_VALUED_TAG_PROPS = new Set([
  "fill",
  "border",
  "text",
  "trace",
]);

/** Tag-rule properties that accept a number value (pixels). */
const NUMBER_VALUED_TAG_PROPS = new Set([
  "border-width",
  "text-weight",
  "trace-width",
  "opacity",
]);

/** Tag-rule property that accepts an array-of-numbers or null. */
const DASH_VALUED_TAG_PROPS = new Set(["dash"]);

/** The full set of legal tag-rule property names (DESIGN-PHASE5 §1.5). */
export const TAG_PROPERTY_NAMES = [
  "fill",
  "border",
  "border-width",
  "text",
  "text-weight",
  "trace",
  "trace-width",
  "dash",
  "opacity",
] as const;

export type TagPropertyName = (typeof TAG_PROPERTY_NAMES)[number];

const TAG_PROPERTY_SET = new Set<string>(TAG_PROPERTY_NAMES);

// --- theme shape ----------------------------------------------------------

export interface ThemeTokens {
  surface: string;
  "surface-raised": string;
  "surface-sunken": string;
  "ink-primary": string;
  "ink-secondary": string;
  "border-strong": string;
  "border-subtle": string;
  "trace-default": string;
  "trace-emphasis": string;
  "trace-muted": string;
  "status-error": string;
  "status-warn": string;
  "status-ok": string;
  "status-info": string;
  "label-halo": string;
  /**
   * The accent palette. 3–9 colours; path highlights cycle through it in
   * declaration order. Validation rejects shorter/longer arrays.
   */
  accents: string[];
}

export interface ThemeTypography {
  face: string;
  "face-mono": string;
  size: {
    body: number;
    edge: number;
    frame: number;
  };
  weight: {
    label: number;
    heading: number;
  };
}

export type ArrowHeadShape = "filled-triangle" | "none";

export interface ThemeStrokes {
  outline: number;
  trace: number;
  emphasis: number;
  frame: number;
  "underground-opacity": number;
  "underground-width": number;
  "manhole-radius": number;
  dash: {
    frame: number[];
    "back-edge": number[];
  };
  arrow: {
    scale: number;
    "head-shape": ArrowHeadShape;
  };
}

/**
 * A resolved tag-rule value. After loadTheme runs, every value in here is
 * already in renderer-ready form: colour tokens are NOT yet resolved to
 * their hex (that happens at render time so a tag rule like
 * `{ border: status-warn }` follows the active theme even after override),
 * but everything is type-checked.
 */
export interface TagRule {
  fill?: string;
  border?: string;
  "border-width"?: number;
  text?: string;
  "text-weight"?: number;
  trace?: string;
  "trace-width"?: number;
  /** Array of dash/gap pixel lengths, or null for solid. */
  dash?: number[] | null;
  opacity?: number;
}

export interface Theme {
  name: string;
  tokens: ThemeTokens;
  typography: ThemeTypography;
  strokes: ThemeStrokes;
  tags: Record<string, TagRule>;
}

// --- errors ---------------------------------------------------------------

/**
 * Hard error from theme load/validate. Every error in DESIGN-PHASE5 §1.6
 * surfaces as a ThemeError with the matching code in `message`. We don't
 * use a code field because the renderer's error contract is "throw with
 * a readable message"; the prefix (E_THEME_*) is parseable by callers
 * that want to match.
 */
export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeError";
  }
}

// --- built-in catalogue ---------------------------------------------------

/**
 * The four built-in themes. Loaded as raw objects so they validate through
 * the same code path as external theme files. Each is a complete theme —
 * no inheritance, no partials (DESIGN-PHASE5 §2.3).
 *
 * Values per DESIGN-PHASE5-THEMING.md §4.
 */
const BUILTIN_THEMES_RAW: Record<string, unknown> = {
  "document-light": {
    name: "document-light",
    tokens: {
      // Softer-corporate palette (DESIGN-PHASE5 elegance pass).
      // Premium slate/grey, never pure black, traces lighter than ink so
      // the wires recede behind the boxes that are doing the talking.
      surface: "#fafafa",
      "surface-raised": "#ffffff",
      "surface-sunken": "#f1f5f9",
      "ink-primary": "#334155",
      "ink-secondary": "#64748b",
      "border-strong": "#334155",
      "border-subtle": "#cbd5e1",
      "trace-default": "#94a3b8",
      "trace-emphasis": "#2563eb",
      "trace-muted": "#cbd5e1",
      "status-error": "#dc2626",
      "status-warn": "#d97706",
      "status-ok": "#16a34a",
      "status-info": "#2563eb",
      "label-halo": "#fafafa",
      accents: ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"],
    },
    typography: {
      face: "Inter, -apple-system, Segoe UI, Roboto, sans-serif",
      "face-mono": "JetBrains Mono, Consolas, Monaco, monospace",
      // Smaller defaults than v1; the new 40px CELL_PX gives more room
      // but readable labels at scale don't need to shout.
      size: { body: 10, edge: 9, frame: 9 },
      weight: { label: 500, heading: 600 },
    },
    strokes: {
      // Thinner strokes for a premium feel. Box outline and trace match
      // (so a trace touching a box has no visual seam), highlight still
      // sits at ~2.5× for clear emphasis.
      outline: 1.0,
      trace: 1.0,
      emphasis: 2.5,
      frame: 0.75,
      "underground-opacity": 0.45,
      "underground-width": 0.75,
      "manhole-radius": 3,
      dash: { frame: [4, 3], "back-edge": [5, 3] },
      arrow: { scale: 4.5, "head-shape": "filled-triangle" },
    },
    tags: {
      future: { border: "status-warn", "border-width": 1.5, dash: [4, 3] },
      critical: { border: "status-error", "border-width": 1.5 },
      deprecated: { trace: "ink-secondary", dash: [3, 3], opacity: 0.6 },
    },
  },

  "document-dark": {
    name: "document-dark",
    tokens: {
      // Mirror of document-light tuned for dark substrate. Surfaces follow
      // the layered convention (deeper → base). Traces lighter than ink so
      // they still recede behind the boxes.
      surface: "#0f172a",
      "surface-raised": "#1e293b",
      "surface-sunken": "#020617",
      "ink-primary": "#e2e8f0",
      "ink-secondary": "#94a3b8",
      "border-strong": "#cbd5e1",
      "border-subtle": "#334155",
      "trace-default": "#64748b",
      "trace-emphasis": "#60a5fa",
      "trace-muted": "#475569",
      "status-error": "#f87171",
      "status-warn": "#fbbf24",
      "status-ok": "#4ade80",
      "status-info": "#60a5fa",
      "label-halo": "#0f172a",
      accents: ["#60a5fa", "#f87171", "#4ade80", "#fbbf24", "#c084fc", "#22d3ee"],
    },
    typography: {
      face: "Inter, -apple-system, Segoe UI, Roboto, sans-serif",
      "face-mono": "JetBrains Mono, Consolas, Monaco, monospace",
      size: { body: 10, edge: 9, frame: 9 },
      weight: { label: 500, heading: 600 },
    },
    strokes: {
      outline: 1.0,
      trace: 1.0,
      emphasis: 2.5,
      frame: 0.75,
      "underground-opacity": 0.45,
      "underground-width": 0.75,
      "manhole-radius": 3,
      dash: { frame: [4, 3], "back-edge": [5, 3] },
      arrow: { scale: 4.5, "head-shape": "filled-triangle" },
    },
    tags: {
      future: { border: "status-warn", "border-width": 1.5, dash: [4, 3] },
      critical: { border: "status-error", "border-width": 1.5 },
      deprecated: { trace: "ink-secondary", dash: [3, 3], opacity: 0.6 },
    },
  },

  "schematic-light": {
    name: "schematic-light",
    tokens: {
      surface: "#f5f1e8",
      "surface-raised": "#ffffff",
      "surface-sunken": "#e8e3d4",
      "ink-primary": "#1a2332",
      "ink-secondary": "#4a5568",
      "border-strong": "#2c5282",
      "border-subtle": "#a0aec0",
      "trace-default": "#2c5282",
      "trace-emphasis": "#c05621",
      "trace-muted": "#718096",
      "status-error": "#c53030",
      "status-warn": "#c05621",
      "status-ok": "#2f855a",
      "status-info": "#2c5282",
      "label-halo": "#f5f1e8",
      accents: ["#2c5282", "#c05621", "#2f855a", "#b7791f", "#553c9a"],
    },
    typography: {
      face: "IBM Plex Sans, Inter, sans-serif",
      "face-mono": "IBM Plex Mono, Consolas, monospace",
      size: { body: 10, edge: 9, frame: 9 },
      weight: { label: 500, heading: 600 },
    },
    strokes: {
      outline: 1.0,
      trace: 1.0,
      emphasis: 2.5,
      frame: 0.75,
      "underground-opacity": 0.45,
      "underground-width": 0.75,
      "manhole-radius": 3,
      dash: { frame: [4, 3], "back-edge": [5, 3] },
      arrow: { scale: 4.5, "head-shape": "none" },
    },
    tags: {
      future: { border: "status-warn", "border-width": 1.5, dash: [4, 3] },
      critical: { border: "status-error", "border-width": 1.5 },
      deprecated: { trace: "ink-secondary", dash: [3, 3], opacity: 0.6 },
    },
  },

  "schematic-dark": {
    name: "schematic-dark",
    tokens: {
      surface: "#0d1117",
      "surface-raised": "#161b22",
      "surface-sunken": "#05080c",
      "ink-primary": "#e6edf3",
      "ink-secondary": "#8b949e",
      "border-strong": "#30363d",
      "border-subtle": "#21262d",
      "trace-default": "#58a6ff",
      "trace-emphasis": "#f0883e",
      "trace-muted": "#484f58",
      "status-error": "#f85149",
      "status-warn": "#d29922",
      "status-ok": "#3fb950",
      "status-info": "#58a6ff",
      "label-halo": "#0d1117",
      accents: ["#58a6ff", "#f0883e", "#3fb950", "#d29922", "#bc8cff"],
    },
    typography: {
      face: "IBM Plex Sans, Inter, sans-serif",
      "face-mono": "IBM Plex Mono, Consolas, monospace",
      size: { body: 10, edge: 9, frame: 9 },
      weight: { label: 500, heading: 600 },
    },
    strokes: {
      outline: 1.0,
      trace: 1.0,
      emphasis: 2.5,
      frame: 0.75,
      "underground-opacity": 0.45,
      "underground-width": 0.75,
      "manhole-radius": 3,
      dash: { frame: [4, 3], "back-edge": [5, 3] },
      arrow: { scale: 4.5, "head-shape": "none" },
    },
    tags: {
      future: { border: "status-warn", "border-width": 1.5, dash: [4, 3] },
      critical: { border: "status-error", "border-width": 1.5 },
      deprecated: { trace: "ink-secondary", dash: [3, 3], opacity: 0.6 },
    },
  },
};

export const BUILTIN_THEME_NAMES = Object.keys(BUILTIN_THEMES_RAW);

/** Default theme when no `theme:` directive or `--theme=` flag is given. */
export const DEFAULT_THEME_NAME = "document-light";

// --- loading --------------------------------------------------------------

/**
 * Resolve a theme by name or path.
 *
 *   - If `nameOrPath` matches a built-in name, return the validated copy.
 *   - Otherwise treat it as a file path; read JSON; validate; return.
 *
 * Built-in names are reserved — a file `./document-light.json` will not
 * shadow the built-in. This matches DESIGN-PHASE5-THEMING.md §2.1.
 */
export function loadTheme(nameOrPath: string): Theme {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_THEMES_RAW, nameOrPath)) {
    return validateTheme(BUILTIN_THEMES_RAW[nameOrPath], `<built-in:${nameOrPath}>`);
  }
  return loadThemeFromPath(nameOrPath);
}

export function loadThemeFromPath(path: string): Theme {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ThemeError(`E_THEME_LOAD_FAILED: could not read theme '${path}': ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ThemeError(`E_THEME_LOAD_FAILED: theme '${path}' is not valid JSON: ${msg}`);
  }
  return validateTheme(parsed, path);
}

// --- validation -----------------------------------------------------------

/**
 * Validate and shape a raw object into a Theme. Throws ThemeError on any
 * issue. The validator is total: a returned Theme is guaranteed to have
 * every required field, of the right type and shape.
 *
 * Strict-keys policy: unknown token names raise E_THEME_UNKNOWN_TOKEN
 * (typo of `surface` as `surfaec` is loud, not silent). Same for tag-rule
 * properties not in the §1.5 table.
 */
export function validateTheme(raw: unknown, source: string): Theme {
  if (!isObject(raw)) {
    throw new ThemeError(`E_THEME_MISSING_FIELD: theme ${source} must be a JSON object`);
  }
  const name = requireString(raw, "name", source);

  const tokens = validateTokens(raw["tokens"], source);
  const typography = validateTypography(raw["typography"], source);
  const strokes = validateStrokes(raw["strokes"], source);
  const tags = validateTags(raw["tags"], source);

  return { name, tokens, typography, strokes, tags };
}

function validateTokens(raw: unknown, source: string): ThemeTokens {
  if (!isObject(raw)) {
    throw new ThemeError(`E_THEME_MISSING_FIELD: theme ${source} is missing 'tokens'`);
  }
  // Strict-keys: every key in raw must be a known token, and every known
  // token must be present.
  for (const key of Object.keys(raw)) {
    if (key === "accents") continue;
    if (!COLOUR_TOKEN_SET.has(key)) {
      throw new ThemeError(
        `E_THEME_UNKNOWN_TOKEN: theme ${source} has unknown token '${key}'. ` +
          `Legal token names: ${COLOUR_TOKEN_NAMES.join(", ")}.`,
      );
    }
  }
  const out = {} as ThemeTokens;
  for (const tok of COLOUR_TOKEN_NAMES) {
    const v = raw[tok];
    if (typeof v !== "string") {
      throw new ThemeError(
        `E_THEME_MISSING_FIELD: theme ${source} is missing required token '${tok}'`,
      );
    }
    if (!isColourLiteral(v)) {
      throw new ThemeError(
        `E_THEME_BAD_COLOUR: theme ${source} token '${tok}' must be a hex colour (#rrggbb or #rgb), got '${v}'`,
      );
    }
    (out as Record<string, string | string[]>)[tok] = v;
  }
  const accents = raw["accents"];
  if (!Array.isArray(accents)) {
    throw new ThemeError(
      `E_THEME_MISSING_FIELD: theme ${source} is missing required 'accents' array`,
    );
  }
  if (accents.length < 3 || accents.length > 9) {
    throw new ThemeError(
      `E_THEME_BAD_ACCENTS_LENGTH: theme ${source} 'accents' must have 3-9 entries, got ${accents.length}`,
    );
  }
  for (let i = 0; i < accents.length; i++) {
    const a = accents[i];
    if (typeof a !== "string" || !isColourLiteral(a)) {
      throw new ThemeError(
        `E_THEME_BAD_COLOUR: theme ${source} accent[${i}] must be a hex colour, got '${String(a)}'`,
      );
    }
  }
  out.accents = accents.slice();
  return out;
}

function validateTypography(raw: unknown, source: string): ThemeTypography {
  if (!isObject(raw)) {
    throw new ThemeError(`E_THEME_MISSING_FIELD: theme ${source} is missing 'typography'`);
  }
  const face = requireString(raw, "face", source, "typography.");
  const faceMono = requireString(raw, "face-mono", source, "typography.");
  const size = raw["size"];
  if (!isObject(size)) {
    throw new ThemeError(`E_THEME_MISSING_FIELD: theme ${source} is missing 'typography.size'`);
  }
  const body = requirePositiveNumber(size, "body", source, "typography.size.");
  const edge = requirePositiveNumber(size, "edge", source, "typography.size.");
  const frame = requirePositiveNumber(size, "frame", source, "typography.size.");
  const weight = raw["weight"];
  if (!isObject(weight)) {
    throw new ThemeError(`E_THEME_MISSING_FIELD: theme ${source} is missing 'typography.weight'`);
  }
  const label = requireIntInRange(weight, "label", 100, 900, source, "typography.weight.");
  const heading = requireIntInRange(weight, "heading", 100, 900, source, "typography.weight.");
  return {
    face,
    "face-mono": faceMono,
    size: { body, edge, frame },
    weight: { label, heading },
  };
}

function validateStrokes(raw: unknown, source: string): ThemeStrokes {
  if (!isObject(raw)) {
    throw new ThemeError(`E_THEME_MISSING_FIELD: theme ${source} is missing 'strokes'`);
  }
  const outline = requirePositiveNumber(raw, "outline", source, "strokes.");
  const trace = requirePositiveNumber(raw, "trace", source, "strokes.");
  const emphasis = requirePositiveNumber(raw, "emphasis", source, "strokes.");
  const frame = requirePositiveNumber(raw, "frame", source, "strokes.");
  const ugOpacity = requireNumberInRange(raw, "underground-opacity", 0, 1, source, "strokes.");
  const ugWidth = requirePositiveNumber(raw, "underground-width", source, "strokes.");
  const manhole = requirePositiveNumber(raw, "manhole-radius", source, "strokes.");
  const dash = raw["dash"];
  if (!isObject(dash)) {
    throw new ThemeError(`E_THEME_MISSING_FIELD: theme ${source} is missing 'strokes.dash'`);
  }
  const dashFrame = requireNumberArray(dash, "frame", source, "strokes.dash.");
  const dashBack = requireNumberArray(dash, "back-edge", source, "strokes.dash.");
  const arrow = raw["arrow"];
  if (!isObject(arrow)) {
    throw new ThemeError(`E_THEME_MISSING_FIELD: theme ${source} is missing 'strokes.arrow'`);
  }
  const arrowScale = requirePositiveNumber(arrow, "scale", source, "strokes.arrow.");
  const headShapeRaw = arrow["head-shape"];
  if (headShapeRaw !== "filled-triangle" && headShapeRaw !== "none") {
    throw new ThemeError(
      `E_THEME_BAD_VALUE: theme ${source} 'strokes.arrow.head-shape' must be 'filled-triangle' or 'none', got '${String(headShapeRaw)}'`,
    );
  }
  return {
    outline,
    trace,
    emphasis,
    frame,
    "underground-opacity": ugOpacity,
    "underground-width": ugWidth,
    "manhole-radius": manhole,
    dash: { frame: dashFrame, "back-edge": dashBack },
    arrow: { scale: arrowScale, "head-shape": headShapeRaw },
  };
}

function validateTags(raw: unknown, source: string): Record<string, TagRule> {
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    throw new ThemeError(`E_THEME_BAD_VALUE: theme ${source} 'tags' must be an object`);
  }
  const out: Record<string, TagRule> = {};
  for (const [tagName, rule] of Object.entries(raw)) {
    if (!isObject(rule)) {
      throw new ThemeError(
        `E_THEME_BAD_VALUE: theme ${source} tag '${tagName}' must be an object of overrides`,
      );
    }
    out[tagName] = validateTagRule(rule, tagName, source);
  }
  return out;
}

function validateTagRule(
  rule: Record<string, unknown>,
  tagName: string,
  source: string,
): TagRule {
  const out: TagRule = {};
  for (const [prop, value] of Object.entries(rule)) {
    if (!TAG_PROPERTY_SET.has(prop)) {
      throw new ThemeError(
        `E_UNKNOWN_TAG_PROPERTY: theme ${source} tag '${tagName}' uses unknown property '${prop}'. ` +
          `Legal properties: ${TAG_PROPERTY_NAMES.join(", ")}.`,
      );
    }
    if (COLOUR_VALUED_TAG_PROPS.has(prop)) {
      if (typeof value !== "string" || !isColourValue(value)) {
        throw new ThemeError(
          `E_THEME_BAD_COLOUR: theme ${source} tag '${tagName}.${prop}' must be a token name or hex colour, got '${String(value)}'`,
        );
      }
      (out as Record<string, unknown>)[prop] = value;
    } else if (NUMBER_VALUED_TAG_PROPS.has(prop)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ThemeError(
          `E_THEME_BAD_NUMBER: theme ${source} tag '${tagName}.${prop}' must be a number, got '${String(value)}'`,
        );
      }
      if (prop === "opacity" && (value < 0 || value > 1)) {
        throw new ThemeError(
          `E_THEME_BAD_NUMBER: theme ${source} tag '${tagName}.opacity' must be in [0, 1], got ${value}`,
        );
      }
      if ((prop === "border-width" || prop === "trace-width") && value < 0) {
        throw new ThemeError(
          `E_THEME_BAD_NUMBER: theme ${source} tag '${tagName}.${prop}' must be >= 0, got ${value}`,
        );
      }
      if (prop === "text-weight" && (!Number.isInteger(value) || value < 100 || value > 900)) {
        throw new ThemeError(
          `E_THEME_BAD_NUMBER: theme ${source} tag '${tagName}.text-weight' must be integer in [100, 900], got ${value}`,
        );
      }
      (out as Record<string, unknown>)[prop] = value;
    } else if (DASH_VALUED_TAG_PROPS.has(prop)) {
      if (value === null) {
        (out as Record<string, unknown>)[prop] = null;
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const v = value[i];
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            throw new ThemeError(
              `E_THEME_BAD_NUMBER: theme ${source} tag '${tagName}.dash[${i}]' must be a non-negative number, got '${String(v)}'`,
            );
          }
        }
        (out as Record<string, unknown>)[prop] = value.slice();
      } else {
        throw new ThemeError(
          `E_THEME_BAD_VALUE: theme ${source} tag '${tagName}.dash' must be an array of numbers or null, got '${String(value)}'`,
        );
      }
    }
  }
  return out;
}

// --- resolution helpers ---------------------------------------------------

/**
 * Resolve a colour value (token name or literal hex) against a theme's
 * tokens. Used at render time: tag rules store the token name; the
 * renderer asks "what's the actual hex right now?" so that tag overrides
 * follow theme swaps.
 *
 * Returns the input unchanged when it's already a hex literal. Throws
 * (programmer error) on unknown token — validation should have caught it
 * earlier, but the runtime check is cheap insurance.
 */
export function resolveColour(theme: Theme, value: string): string {
  if (value.startsWith("#")) return value;
  if (COLOUR_TOKEN_SET.has(value)) {
    return (theme.tokens as Record<string, string | string[]>)[value] as string;
  }
  throw new ThemeError(
    `E_INTERNAL: resolveColour got '${value}' which is neither a hex literal nor a known token`,
  );
}

/**
 * Compose a list of tag names into a single override TagRule. Later
 * tags' properties override earlier ones (CSS-class semantics —
 * DESIGN-PHASE5-THEMING.md §1.5).
 *
 * Raises E_UNKNOWN_TAG if any name doesn't resolve in the theme. This
 * fires at render time because bind doesn't know which theme will be
 * applied (CLI override may change the active theme post-bind).
 *
 * The `where` string is used in the error message for context (e.g.
 * "node 'svc_a'" or "edge 'ingest -> router'"). Returns an empty rule
 * when tagNames is empty or undefined.
 */
export function resolveTags(
  theme: Theme,
  tagNames: string[] | undefined,
  where: string,
): TagRule {
  if (!tagNames || tagNames.length === 0) return {};
  const out: TagRule = {};
  for (const name of tagNames) {
    const rule = theme.tags[name];
    if (rule === undefined) {
      throw new ThemeError(
        `E_UNKNOWN_TAG: ${where} uses tag '${name}' which is not defined in theme '${theme.name}'. ` +
          `Defined tags: ${Object.keys(theme.tags).join(", ") || "(none)"}.`,
      );
    }
    Object.assign(out, rule);
  }
  return out;
}

// --- low-level validators -------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isColourLiteral(v: string): boolean {
  return HEX_RE.test(v);
}

/** Colour values in tag rules may be a token name OR a hex literal. */
function isColourValue(v: string): boolean {
  return isColourLiteral(v) || COLOUR_TOKEN_SET.has(v);
}

function requireString(
  raw: Record<string, unknown>,
  key: string,
  source: string,
  prefix = "",
): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ThemeError(
      `E_THEME_MISSING_FIELD: theme ${source} is missing required string '${prefix}${key}'`,
    );
  }
  return v;
}

function requirePositiveNumber(
  raw: Record<string, unknown>,
  key: string,
  source: string,
  prefix = "",
): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ThemeError(
      `E_THEME_BAD_NUMBER: theme ${source} '${prefix}${key}' must be a non-negative number, got '${String(v)}'`,
    );
  }
  return v;
}

function requireNumberInRange(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  source: string,
  prefix = "",
): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new ThemeError(
      `E_THEME_BAD_NUMBER: theme ${source} '${prefix}${key}' must be in [${min}, ${max}], got '${String(v)}'`,
    );
  }
  return v;
}

function requireIntInRange(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  source: string,
  prefix = "",
): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ThemeError(
      `E_THEME_BAD_NUMBER: theme ${source} '${prefix}${key}' must be an integer in [${min}, ${max}], got '${String(v)}'`,
    );
  }
  return v;
}

function requireNumberArray(
  raw: Record<string, unknown>,
  key: string,
  source: string,
  prefix = "",
): number[] {
  const v = raw[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new ThemeError(
      `E_THEME_MISSING_FIELD: theme ${source} '${prefix}${key}' must be a non-empty array of numbers`,
    );
  }
  for (let i = 0; i < v.length; i++) {
    const n = v[i];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      throw new ThemeError(
        `E_THEME_BAD_NUMBER: theme ${source} '${prefix}${key}[${i}]' must be a non-negative number, got '${String(n)}'`,
      );
    }
  }
  return (v as number[]).slice();
}
