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
import { dirname, resolve } from "node:path";
import { tokenize } from "./parser/lexer.js";
import { parse } from "./parser/parser.js";
import { formatProgram } from "./parser/format.js";
import { bind } from "./bind/bind.js";
import { place } from "./layout/place.js";
import { applyTextFit, applyTextFitToSizes } from "./layout/text-fit.js";
import { assignSlots } from "./layout/slots.js";
import { routeChannels } from "./layout/channels.js";
import { applyModulePortEndpoints } from "./layout/module-route.js";
import { applyModuleAlignment, placeModules } from "./layout/module-place.js";
import { autoAlignViaShims } from "./layout/via-shim.js";
import { renderSVG } from "./render/svg.js";
import { BUILTIN_THEME_NAMES } from "./theme/theme.js";
import { resolveTheme, validateSource, parseDiagnostic, type Diagnostic } from "./compile.js";
import type { Model } from "./bind/model.js";

/** Format a diagnostic as `message[. Hint: ...]`, no double period. */
function formatDiag(diag: Diagnostic): string {
  const base = diag.message.replace(/\s*$/, "");
  const tail = diag.hint ? ` Hint: ${diag.hint}` : "";
  return `${base}${tail}`;
}

function usage(): never {
  process.stderr.write("usage: melk <command> <file.melk> [options]\n");
  process.stderr.write("commands:\n");
  process.stderr.write("  parse                 print the parsed AST as JSON\n");
  process.stderr.write("  bind                  print the bound Model as JSON\n");
  process.stderr.write("  validate              run the full pipeline; report errors only (no SVG output)\n");
  process.stderr.write("  format                emit a canonical, normalized form of the .melk source\n");
  process.stderr.write("  render [-o OUT.svg] [--theme=NAME] [--legend=VALUE]\n");
  process.stderr.write("                        defaults -o to <input-without-.melk>.svg\n");
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

/**
 * Top-level entry. Wraps the whole dispatch in ONE clean error handler
 * so every command — not just validate/format — reports failures as a
 * single `[stage] E_CODE: message. Hint: ...` line and exits 1, instead
 * of leaking a Node stack trace (noise when an LLM reads the output).
 * Pass `--debug` to re-throw and get the full stack while iterating on a
 * compiler bug. A missing input file is reported as a clean
 * `E_FILE_NOT_FOUND` rather than a raw ENOENT stack.
 */
function main(): void {
  const argv = process.argv.slice(2);
  const debug = argv.includes("--debug");
  try {
    dispatch(argv);
  } catch (err) {
    if (debug) throw err;
    // ENOENT on the input read → clean E_FILE_NOT_FOUND.
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT" &&
      (err as NodeJS.ErrnoException).syscall === "open"
    ) {
      const path = (err as NodeJS.ErrnoException).path ?? "<input>";
      process.stderr.write(`E_FILE_NOT_FOUND: no such file '${path}'\n`);
      process.exit(1);
    }
    // Any other thrown pipeline error: format it like validate does.
    const raw = err instanceof Error ? err.message : String(err);
    const diag = parseDiagnostic("render", raw);
    process.stderr.write(`[${diag.stage}] ${formatDiag(diag)}\n`);
    process.stderr.write(`(re-run with --debug for a full stack trace)\n`);
    process.exit(1);
  }
}

function dispatch(argv: string[]): void {
  const command = argv[0];
  const fileArg = argv[1];
  if (!command || !fileArg) usage();

  const filePath = resolve(fileArg!);
  const source = readFileSync(filePath, "utf8");

  if (command === "validate") {
    const code = runValidate(source, filePath);
    process.exit(code);
  }
  if (command === "format") {
    const code = runFormat(source);
    process.exit(code);
  }

  const ast = parse(tokenize(source));

  if (command === "parse") {
    process.stdout.write(JSON.stringify(ast, null, 2) + "\n");
    return;
  }

  const model = bind(ast, { importerPath: filePath });

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

    // DESIGN-PHASE5-MODULES.md §3.1, §3.2 — per-module placement runs
    // first so the parent placer knows each module's cell footprint
    // before it starts placing.
    placeModules(model, (imported) =>
      resolveTheme(undefined, imported.model.themeName, dirname(filePath)),
    );

    // Multi-cell occupancy requires the placer to see the final node
    // sizes (after label-fit growth), so it can space neighbours
    // correctly. applyTextFitToSizes mutates node.size in place;
    // applyTextFit after place() is now a no-op carried for symmetry.
    applyTextFitToSizes(model, theme);
    const rawPlacement = place(model);
    const placement = applyTextFit(rawPlacement, model, theme);
    const slots = assignSlots(model, placement);
    // DESIGN-PHASE5-MODULES.md §3.3 (extension) — shift each imported
    // module body inside its synthetic cell along the cross-flow axis
    // so face-to-face flow-axis ports line up with their counterparts.
    applyModuleAlignment(model, placement, slots);
    // Auto-centring shim for highway via members: align each member's
    // slot cluster pixel-parity with the highway's, so via traces
    // don't get a 4-px C-curve kink on every entry/exit.
    autoAlignViaShims(model, placement, slots);
    const routing = routeChannels(model, placement, slots);
    // DESIGN-PHASE5-MODULES.md §4.1 — replace trace endpoints on
    // module-internal edges with the internal node's actual port pixel.
    applyModulePortEndpoints(routing, model, placement);
    const noNetwork = argv.includes("--no-network");
    const svg = renderSVG(model, placement, routing, theme, {
      meltFileDir: dirname(filePath),
      allowNetwork: !noNetwork,
    });

    // Output path:
    //   - `-o OUT` flag → write to OUT.
    //   - no flag → write to <input-without-.melk>.<format> next to input.
    // Safety: if the resolved output equals the input, append the format
    // extension instead of clobbering the source.
    const outIdx = argv.indexOf("-o");
    const outFormat = "svg";
    let outPath: string;
    if (outIdx >= 0) {
      const flagVal = argv[outIdx + 1];
      if (!flagVal) usage();
      outPath = resolve(flagVal!);
    } else {
      const base = filePath.endsWith(".melk")
        ? filePath.slice(0, -".melk".length)
        : filePath;
      outPath = `${base}.${outFormat}`;
    }
    if (outPath === filePath) {
      outPath = `${filePath}.${outFormat}`;
      process.stderr.write(
        `warning: output path equals input path; writing to '${outPath}' to avoid overwriting source.\n`,
      );
    }
    writeFileSync(outPath, svg);
    return;
  }

  usage();
}

/**
 * `melk validate <file>` — run the full pipeline (parse → bind → place
 * → reserveCorridors → packTracks → buildPolylines), catching any
 * thrown error. Prints one clean line per problem to stderr in
 * `E_CODE: message` form (no stack trace). Returns 0 on success, 1 on
 * any error.
 *
 * Fail-fast: the first failed stage stops the pipeline because
 * downstream stages depend on it. So a `validate` run reports the
 * *first* error, not all of them. Iterative authoring still works
 * because fixing the surfaced error reveals the next.
 *
 * Why no SVG output? An LLM author wants a fast "is this source
 * valid?" check without 16 KB of SVG noise in the response.
 */
function runValidate(source: string, filePath: string): number {
  // Delegate to the canonical pipeline (src/compile.ts) so `validate`
  // and `render` can never diverge. validateSource renders internally
  // (discarding the SVG) so tag/legend/theme errors surface here too —
  // the documented checkpoint. Returns a structured diagnostic; we print
  // it in the same `[stage] message[. Hint: ...]` shape as before.
  const diag = validateSource(source, { filePath });
  if (!diag) {
    process.stdout.write("OK\n");
    return 0;
  }
  process.stderr.write(`[${diag.stage}] ${formatDiag(diag)}\n`);
  return 1;
}

/**
 * `melk format <file>` — emit a canonical, normalized form of the
 * source: stable directive order, single-space convention, no
 * comments preserved.
 *
 * Use case: an LLM author edits a .melk; the user runs `melk format`
 * before review so the diff focuses on the meaningful change instead
 * of incidental whitespace.
 *
 * Not byte-stable across versions of the formatter; we don't promise
 * the exact whitespace. We do promise idempotence: format(format(s)) =
 * format(s).
 */
function runFormat(source: string): number {
  try {
    const ast = parse(tokenize(source));
    const out = formatProgram(ast);
    process.stdout.write(out);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    return 1;
  }
}

main();
