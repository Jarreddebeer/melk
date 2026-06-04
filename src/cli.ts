#!/usr/bin/env node
/**
 * Phase 4+5 CLI entry point. The full pipeline:
 *
 *   tokenize → parse → bind → place → reserveCorridors → packTracks
 *            → buildPolylines → renderSVG(theme)
 *
 * Theme resolution precedence (DESIGN-PHASE5-THEMING.md §2.2):
 *   --theme=NAME flag  >  in-source `theme:` directive  >  default
 *
 * The theme value may be a built-in name (resolved from the catalogue)
 * or a file path. Paths from `--theme=` resolve relative to cwd; paths
 * from `theme:` directives resolve relative to the .melk file's directory.
 *
 * Subcommands expose intermediate stages for debugging; `render` runs
 * the whole thing and writes an SVG.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tokenize } from "./parser/lexer.js";
import { parse } from "./parser/parser.js";
import { bind } from "./bind/bind.js";
import { place } from "./layout/place.js";
import { applyTextFit } from "./layout/text-fit.js";
import { reserveCorridors } from "./layout/corridors.js";
import { packTracks } from "./layout/tracks.js";
import { buildPolylines } from "./layout/polyline.js";
import { renderSVG } from "./render/svg.js";
import {
  BUILTIN_THEME_NAMES,
  DEFAULT_THEME_NAME,
  loadTheme,
  type Theme,
} from "./theme/theme.js";
import type { Model } from "./bind/model.js";

function usage(): never {
  process.stderr.write("usage: melk <command> <file.melk> [options]\n");
  process.stderr.write("commands:\n");
  process.stderr.write("  parse                 print the parsed AST as JSON\n");
  process.stderr.write("  bind                  print the bound Model as JSON\n");
  process.stderr.write("  render [-o OUT.svg] [--theme=NAME] [--legend=VALUE]\n");
  process.stderr.write("         [--title=STR] [--subtitle=STR] [--caption=STR] [--no-network]\n");
  process.stderr.write("                        render to SVG; --theme overrides the in-source theme directive\n");
  process.stderr.write("                        built-in themes: " + BUILTIN_THEME_NAMES.join(", ") + "\n");
  process.stderr.write("                        --legend values: on, off, or a position (bottom|right|top|left)\n");
  process.stderr.write("                        --title / --subtitle / --caption override in-source values;\n");
  process.stderr.write("                          empty string (e.g. --title=\"\") disables\n");
  process.stderr.write("                        --no-network: URL icon packs become cache-only\n");
  process.exit(1);
}

/**
 * Resolve the CLI --legend=VALUE flag into a LegendConfig override (or
 * undefined if no flag was supplied). Values:
 *   - "on"     → enable legend, keep model's position (or default bottom)
 *   - "off"    → disable legend
 *   - position → enable legend, use this position (bottom|right|top|left)
 *   - anything else → off (same binary content-match rule as the
 *     `legend:` directive)
 */
function resolveLegendFlag(
  cliValue: string | undefined,
  modelLegend: { on: boolean; position: "bottom" | "right" | "top" | "left" } | undefined,
): { on: boolean; position: "bottom" | "right" | "top" | "left" } | undefined {
  if (cliValue === undefined) return modelLegend;
  if (cliValue === "on") {
    return { on: true, position: modelLegend?.position ?? "bottom" };
  }
  if (cliValue === "bottom" || cliValue === "right" || cliValue === "top" || cliValue === "left") {
    return { on: true, position: cliValue };
  }
  // Anything else (including "off") disables.
  return undefined;
}

/**
 * Pick a theme value from CLI flag (highest priority) or model directive,
 * resolve it to a Theme. Paths are resolved against `baseDir` (the .melk
 * file's directory) when the value originated from the source directive;
 * CLI-flag paths resolve against cwd. Built-in names take precedence over
 * file paths in both cases — `--theme=document-light` always finds the
 * built-in, even if `./document-light.json` happens to exist.
 */
function resolveTheme(
  cliValue: string | undefined,
  modelValue: string | undefined,
  baseDir: string,
): Theme {
  if (cliValue !== undefined) {
    if (BUILTIN_THEME_NAMES.includes(cliValue)) return loadTheme(cliValue);
    const path = isAbsolute(cliValue) ? cliValue : resolve(process.cwd(), cliValue);
    return loadTheme(path);
  }
  if (modelValue !== undefined) {
    if (BUILTIN_THEME_NAMES.includes(modelValue)) return loadTheme(modelValue);
    const path = isAbsolute(modelValue) ? modelValue : resolve(baseDir, modelValue);
    return loadTheme(path);
  }
  return loadTheme(DEFAULT_THEME_NAME);
}

/**
 * DESIGN-PHASE5-TITLES §5.4. CLI override for one of the three text
 * directives. Empty-string value disables (deletes the field on the
 * model); any other non-undefined value sets the field. Multiline
 * strings are rejected loudly — same E_TITLE_MULTILINE code that the
 * parser uses, so the failure mode is consistent across surfaces.
 */
function applyTitleFlag(
  argv: string[],
  field: "title" | "subtitle" | "caption",
  model: Model,
): void {
  const cliValue = findFlag(argv, field);
  if (cliValue === undefined) return;
  if (cliValue === "") {
    delete model[field];
    return;
  }
  if (cliValue.includes("\n") || cliValue.includes("\r")) {
    process.stderr.write(
      `E_TITLE_MULTILINE: --${field} value must be single-line (no newlines)\n`,
    );
    process.exit(1);
  }
  model[field] = cliValue;
}

function findFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const fileArg = argv[1];
  if (!command || !fileArg) usage();

  const filePath = resolve(fileArg!);
  const source = readFileSync(filePath, "utf8");
  const ast = parse(tokenize(source));

  if (command === "parse") {
    process.stdout.write(JSON.stringify(ast, null, 2) + "\n");
    return;
  }

  const model = bind(ast);

  if (command === "bind") {
    process.stdout.write(JSON.stringify(model, null, 2) + "\n");
    return;
  }

  if (command === "render") {
    const cliTheme = findFlag(argv, "theme");
    const theme = resolveTheme(cliTheme, model.themeName, dirname(filePath));
    const cliLegend = findFlag(argv, "legend");
    const legendOverride = resolveLegendFlag(cliLegend, model.legend);
    if (legendOverride !== undefined) {
      model.legend = legendOverride;
    } else {
      delete model.legend;
    }

    // DESIGN-PHASE5-TITLES §5.4 — CLI overrides for title/subtitle/caption.
    // Each flag overrides the in-source directive. An empty string
    // disables the corresponding strip (delete the field). The
    // multiline/empty-source rule from the parser doesn't apply here:
    // the parser enforces it on .melk source, but the CLI is the
    // explicit "delete this" channel.
    applyTitleFlag(argv, "title", model);
    applyTitleFlag(argv, "subtitle", model);
    applyTitleFlag(argv, "caption", model);

    const rawPlacement = place(model);
    const placement = applyTextFit(rawPlacement, model, theme);
    const reservation = reserveCorridors(model, placement);
    const packing = packTracks(model, placement, reservation);
    const polylines = buildPolylines(model, placement, reservation, packing);
    const noNetwork = argv.includes("--no-network");
    const svg = renderSVG(model, placement, reservation, polylines, theme, {
      meltFileDir: dirname(filePath),
      allowNetwork: !noNetwork,
    });

    const outIdx = argv.indexOf("-o");
    if (outIdx >= 0) {
      const outPath = argv[outIdx + 1];
      if (!outPath) usage();
      writeFileSync(resolve(outPath!), svg);
    } else {
      process.stdout.write(svg);
    }
    return;
  }

  usage();
}

main();
