#!/usr/bin/env node
/**
 * Phase 4 CLI entry point. The full pipeline:
 *
 *   tokenize → parse → bind → place → reserveCorridors → packTracks
 *            → buildPolylines → renderSVG
 *
 * Subcommands expose intermediate stages for debugging; `render` runs
 * the whole thing and writes an SVG.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tokenize } from "./parser/lexer.js";
import { parse } from "./parser/parser.js";
import { bind } from "./bind/bind.js";
import { place } from "./layout/place.js";
import { reserveCorridors } from "./layout/corridors.js";
import { packTracks } from "./layout/tracks.js";
import { buildPolylines } from "./layout/polyline.js";
import { renderSVG } from "./render/svg.js";

function usage(): never {
  process.stderr.write("usage: melk <command> <file.melk> [options]\n");
  process.stderr.write("commands:\n");
  process.stderr.write("  parse                 print the parsed AST as JSON\n");
  process.stderr.write("  bind                  print the bound Model as JSON\n");
  process.stderr.write("  render [-o OUT.svg]   render to SVG (stdout, or to OUT.svg with -o)\n");
  process.exit(1);
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
    const placement = place(model);
    const reservation = reserveCorridors(model, placement);
    const packing = packTracks(model, placement, reservation);
    const polylines = buildPolylines(model, placement, reservation, packing);
    const svg = renderSVG(model, placement, reservation, polylines);

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
