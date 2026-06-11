/**
 * Canonical compile pipeline — the single source of truth for the stage
 * order that turns `.melk` source into an SVG. The CLI (`render`,
 * `validate`), the public library API (`src/index.ts`), and the test
 * suite all funnel through here so they can never drift apart.
 *
 * Pipeline:
 *   tokenize → parse → bind → placeModules → applyTextFitToSizes
 *            → place → applyTextFit → assignSlots → applyModuleAlignment
 *            → autoAlignViaShims → routeChannels → applyModulePortEndpoints
 *            → renderSVG
 *
 * `compileToSVG` runs the whole thing. `validateSource` runs everything
 * except SVG emission and returns a structured diagnostic instead of
 * throwing, so callers (the CLI, an agent loop) get a uniform
 * `{ code, stage, message, hint }` shape for every failure class.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { tokenize } from "./parser/lexer.js";
import { parse } from "./parser/parser.js";
import { bind } from "./bind/bind.js";
import { place } from "./layout/place.js";
import { applyTextFit, applyTextFitToSizes } from "./layout/text-fit.js";
import { assignSlots } from "./layout/slots.js";
import { routeChannels } from "./layout/channels.js";
import { applyModulePortEndpoints } from "./layout/module-route.js";
import { applyModuleAlignment, placeModules } from "./layout/module-place.js";
import { autoAlignViaShims } from "./layout/via-shim.js";
import { renderSVG } from "./render/svg.js";
import {
  BUILTIN_THEME_NAMES,
  DEFAULT_THEME_NAME,
  loadTheme,
  ThemeError,
  type Theme,
} from "./theme/theme.js";
import type { Model } from "./bind/model.js";

/** A pipeline stage name, used to tag diagnostics. */
export type Stage =
  | "parse"
  | "bind"
  | "theme"
  | "place"
  | "assignSlots"
  | "routeChannels"
  | "render";

/** Structured diagnostic — uniform across every failure class. */
export interface Diagnostic {
  /** Stable `E_*` / `W_*` code if the message carries one, else undefined. */
  code?: string;
  /** Which pipeline stage raised it. */
  stage: Stage;
  /** Human-readable message (without the leading `[stage]` tag). */
  message: string;
  /** Concrete fix template, if the message includes a `Hint:` clause. */
  hint?: string;
}

export interface CompileOptions {
  /**
   * Path of the source file. Used to resolve relative `import` and theme
   * paths. May be a synthetic path (e.g. `"<string>.melk"`) for in-memory
   * compiles; relative imports then resolve against cwd.
   */
  filePath?: string;
  /** Theme name or path overriding the in-source `theme:` directive. */
  theme?: string;
  /** Allow network fetches for remote icon packs (default false). */
  allowNetwork?: boolean;
}

const E_CODE_RE = /\b([EW]_[A-Z0-9_]+)\b/;

/** Levenshtein distance (uncapped — node-name lists are tiny). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

const typoWarnSeen = new Set<string>();

/**
 * Warn (non-fatal) when an auto-declared node name is within edit-distance
 * 1–2 of an *explicitly* declared node — the signature of a typo'd edge
 * endpoint (`api -> databse` where `database` was declared). Auto-declaration
 * is a feature, but name-drift between a declaration and an edge silently
 * produces a wrong diagram, so we surface the likely intent. Emitted to
 * stderr like the other `W_*` warnings.
 */
export function warnSuspectedTypos(model: Model): void {
  const auto = new Set(model.autoDeclared);
  if (auto.size === 0) return;
  const explicit = model.nodes.map((n) => n.id).filter((id) => !auto.has(id));
  if (explicit.length === 0) return;
  for (const name of model.autoDeclared) {
    let best: string | undefined;
    let bestDist = 3;
    for (const decl of explicit) {
      // Only consider near-misses where the lengths are close; "a"/"b"
      // are distance 1 but not typos. Require length ≥ 4 and ≤2 edits.
      if (Math.abs(decl.length - name.length) > 2 || name.length < 4) continue;
      const d = editDistance(name, decl);
      if (d < bestDist) {
        bestDist = d;
        best = decl;
      }
    }
    if (best && bestDist <= 2) {
      const msg =
        `W_SUSPECTED_TYPO: '${name}' was auto-declared (no explicit ` +
        `declaration) and is one or two characters from the declared node ` +
        `'${best}'. Did you mean '${best}'? (If '${name}' is intentional, ` +
        `declare it to silence this.)`;
      if (!typoWarnSeen.has(msg)) {
        typoWarnSeen.add(msg);
        process.stderr.write(msg + "\n");
      }
    }
  }
}

/** Reset the typo-warning dedup table; called from tests. */
export function resetTypoWarnings(): void {
  typoWarnSeen.clear();
}

/** Split a raw error message into `{ code, message, hint }`. */
export function parseDiagnostic(stage: Stage, raw: string): Diagnostic {
  const codeMatch = raw.match(E_CODE_RE);
  const code = codeMatch?.[1];
  // The message frequently looks like `E_CODE: body. Hint: fix.` — peel
  // off the trailing Hint clause so callers can surface it separately.
  let message = raw;
  let hint: string | undefined;
  const hintIdx = raw.indexOf("Hint:");
  if (hintIdx >= 0) {
    message = raw.slice(0, hintIdx).trimEnd();
    hint = raw.slice(hintIdx + "Hint:".length).trim();
  }
  return code ? { code, stage, message, hint } : { stage, message, hint };
}

/**
 * Resolve a theme value (CLI override > in-source directive > default)
 * to a Theme. Bare identifiers that aren't built-ins, and aren't an
 * existing file, raise a clean `E_THEME_UNKNOWN` listing the built-ins —
 * rather than the raw filesystem ENOENT a path lookup would produce.
 */
export function resolveTheme(
  override: string | undefined,
  modelValue: string | undefined,
  baseDir: string,
): Theme {
  const pick = (value: string, base: string): Theme => {
    if (BUILTIN_THEME_NAMES.includes(value)) return loadTheme(value);
    const looksLikePath =
      value.includes("/") ||
      value.includes("\\") ||
      value.endsWith(".json") ||
      isAbsolute(value);
    if (!looksLikePath) {
      throw new ThemeError(
        `E_THEME_UNKNOWN: '${value}' is not a built-in theme ` +
          `(built-ins: ${BUILTIN_THEME_NAMES.join(", ")}) and is not a ` +
          `path to a .json theme file. Hint: use one of the built-in ` +
          `names above, or a quoted relative/absolute path ending in .json.`,
      );
    }
    const path = isAbsolute(value) ? value : resolve(base, value);
    return loadTheme(path);
  };
  if (override !== undefined) return pick(override, process.cwd());
  if (modelValue !== undefined) return pick(modelValue, baseDir);
  return loadTheme(DEFAULT_THEME_NAME);
}

/** Result of a full compile. */
export interface CompileResult {
  model: Model;
  svg: string;
}

/**
 * Run the full pipeline and return the SVG. Throws on any stage error
 * (the thrown Error's message carries the `E_*` code); use
 * {@link validateSource} or {@link tryCompileToSVG} for the
 * non-throwing, structured-diagnostic form.
 */
export function compileToSVG(source: string, options: CompileOptions = {}): CompileResult {
  const filePath = options.filePath ?? resolve("<string>.melk");
  const baseDir = dirname(filePath);
  const ast = parse(tokenize(source));
  const model = bind(ast, { importerPath: filePath });
  warnSuspectedTypos(model);
  const theme = resolveTheme(options.theme, model.themeName, baseDir);
  placeModules(model, (imported) =>
    resolveTheme(undefined, imported.model.themeName, baseDir),
  );
  applyTextFitToSizes(model, theme);
  const rawPlacement = place(model);
  const placement = applyTextFit(rawPlacement, model, theme);
  const slots = assignSlots(model, placement);
  applyModuleAlignment(model, placement, slots);
  autoAlignViaShims(model, placement, slots);
  const routing = routeChannels(model, placement, slots);
  applyModulePortEndpoints(routing, model, placement);
  const svg = renderSVG(model, placement, routing, theme, {
    meltFileDir: baseDir,
    allowNetwork: options.allowNetwork ?? false,
  });
  return { model, svg };
}

/**
 * Run the full pipeline (including theme/tag/legend resolution via
 * renderSVG, so render-time errors surface here too) WITHOUT emitting an
 * SVG to the caller. Returns `null` on success, or a structured
 * {@link Diagnostic} on the first failing stage.
 *
 * This is what `melk validate` runs — and unlike the old validate path,
 * it renders, so `E_UNKNOWN_TAG` / `E_LEGEND_*` and theme problems are
 * caught at the documented checkpoint instead of only at `render`.
 */
export function validateSource(source: string, options: CompileOptions = {}): Diagnostic | null {
  let stage: Stage = "parse";
  try {
    const filePath = options.filePath ?? resolve("<string>.melk");
    const baseDir = dirname(filePath);
    const ast = parse(tokenize(source));
    stage = "bind";
    const model = bind(ast, { importerPath: filePath });
    warnSuspectedTypos(model);
    stage = "theme";
    const theme = resolveTheme(options.theme, model.themeName, baseDir);
    stage = "place";
    placeModules(model, (imported) =>
      resolveTheme(undefined, imported.model.themeName, baseDir),
    );
    applyTextFitToSizes(model, theme);
    const rawPlacement = place(model);
    const placement = applyTextFit(rawPlacement, model, theme);
    stage = "assignSlots";
    const slots = assignSlots(model, placement);
    applyModuleAlignment(model, placement, slots);
    autoAlignViaShims(model, placement, slots);
    stage = "routeChannels";
    const routing = routeChannels(model, placement, slots);
    applyModulePortEndpoints(routing, model, placement);
    // Render to catch tag/legend/theme errors at the validate checkpoint.
    // We discard the SVG; allowNetwork stays false so a missing remote
    // icon is a non-fatal warning, not a validate failure.
    stage = "render";
    renderSVG(model, placement, routing, theme, {
      meltFileDir: baseDir,
      allowNetwork: false,
    });
    return null;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return parseDiagnostic(stage, raw);
  }
}

/** Non-throwing full compile: `{ ok, svg }` or `{ ok: false, diagnostic }`. */
export function tryCompileToSVG(
  source: string,
  options: CompileOptions = {},
):
  | { ok: true; svg: string; model: Model }
  | { ok: false; diagnostic: Diagnostic } {
  let stage: Stage = "parse";
  try {
    // Re-run via compileToSVG but track the stage for diagnostics. We
    // re-implement the staged try here rather than wrapping compileToSVG
    // so the stage tag is precise.
    const filePath = options.filePath ?? resolve("<string>.melk");
    const baseDir = dirname(filePath);
    const ast = parse(tokenize(source));
    stage = "bind";
    const model = bind(ast, { importerPath: filePath });
    warnSuspectedTypos(model);
    stage = "theme";
    const theme = resolveTheme(options.theme, model.themeName, baseDir);
    stage = "place";
    placeModules(model, (imported) =>
      resolveTheme(undefined, imported.model.themeName, baseDir),
    );
    applyTextFitToSizes(model, theme);
    const rawPlacement = place(model);
    const placement = applyTextFit(rawPlacement, model, theme);
    stage = "assignSlots";
    const slots = assignSlots(model, placement);
    applyModuleAlignment(model, placement, slots);
    autoAlignViaShims(model, placement, slots);
    stage = "routeChannels";
    const routing = routeChannels(model, placement, slots);
    applyModulePortEndpoints(routing, model, placement);
    stage = "render";
    const svg = renderSVG(model, placement, routing, theme, {
      meltFileDir: baseDir,
      allowNetwork: options.allowNetwork ?? false,
    });
    return { ok: true, svg, model };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, diagnostic: parseDiagnostic(stage, raw) };
  }
}
