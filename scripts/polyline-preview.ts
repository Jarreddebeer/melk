/**
 * Eyeball checkpoint for Step 8: run the full pipeline (parse → bind →
 * place → reserve → pack → polylines → render) on a handful of
 * examples and write the SVGs under `tmp/preview/`.
 *
 * This script previously inlined a simplified renderer to ship the
 * Step 7 checkpoint; Step 8 collapses that into a thin wrapper around
 * `renderSVG` from src/render/svg.ts. Adding new examples here is the
 * fastest way to sanity-check renderer changes.
 *
 *   npx tsx scripts/polyline-preview.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import { applyTextFit } from "../src/layout/text-fit.js";
import { reserveCorridors } from "../src/layout/corridors.js";
import { packTracks } from "../src/layout/tracks.js";
import { buildPolylines } from "../src/layout/polyline.js";
import { renderSVG } from "../src/render/svg.js";
import { loadTheme } from "../src/theme/theme.js";

const OUT_DIR = "tmp/preview";
mkdirSync(OUT_DIR, { recursive: true });

const theme = loadTheme("document-light");

const examples: { title: string; filename: string; src: string }[] = [
  {
    title: "01 — pipeline",
    filename: "01-pipeline.svg",
    src: "pipeline p: a -> b -> c -> d",
  },
  {
    title: "02 — bus",
    filename: "02-bus.svg",
    src: "s { size: 1x3 }\nbus power: [p1, p2, p3] -> s",
  },
  {
    title: "03 — fan-out",
    filename: "03-fan-out.svg",
    src: "s { size: 1x3 }\nfan-out broadcast: s -> [c1, c2, c3]",
  },
  {
    title: "04 — bus + fan-out hub",
    filename: "04-hub.svg",
    src:
      "h { size: 1x3 }\nbus b: [p1, p2, p3] -> h\nfan-out f: h -> [c1, c2, c3]",
  },
  {
    title: "05 — TB pipeline",
    filename: "05-tb.svg",
    src: "layout: tb\npipeline p: a -> b -> c",
  },
  {
    title: "06 — back-edge",
    filename: "06-back.svg",
    src: "pipeline p: a -> b -> c\nback: c -> a",
  },
  {
    title: "07 — 6-fan hub (stress test)",
    filename: "07-fan-hub.svg",
    src:
      "switch { size: 2x3 }\n" +
      "bus inflow:  [p1, p2, p3, p4, p5, p6] -> switch\n" +
      "fan-out outflow: switch -> [c1, c2, c3, c4, c5, c6]",
  },
  {
    title: "08 — crossing-allowed two-pipeline",
    filename: "08-crossing.svg",
    src: [
      "crossings: 10",
      "a { size: 1x2 }",
      "b { size: 1x2 }",
      "x { size: 1x2 }",
      "y { size: 1x2 }",
      "pipeline lhs: a -> x",
      "pipeline rhs: b -> y",
      "b -> x",
      "a -> y",
    ].join("\n"),
  },
  {
    title: "09 — nodeset + path annotations",
    filename: "09-annotations.svg",
    src: [
      "pipeline p: ingest -> transform -> validate -> publish",
      "nodeset dataPlane: ingest, transform, validate, publish",
      "path fastPath: ingest -> transform -> validate -> publish",
    ].join("\n"),
  },
  {
    title: "10 — shape sampler",
    filename: "10-shapes.svg",
    src: [
      "db { shape: cylinder, label: \"DB\" }",
      "queue { shape: roundrect, label: \"queue\" }",
      "decide { shape: diamond, label: \"decide?\" }",
      "node { shape: circle, label: \"node\" }",
      "pipeline p: db -> queue -> decide -> node",
    ].join("\n"),
  },
];

for (const ex of examples) {
  try {
    const model = bind(parse(tokenize(ex.src)));
    const placement = applyTextFit(place(model), model, theme);
    const reservation = reserveCorridors(model, placement);
    const packing = packTracks(model, placement, reservation);
    const polylines = buildPolylines(model, placement, reservation, packing);
    const svg = renderSVG(model, placement, reservation, polylines, theme);
    writeFileSync(`${OUT_DIR}/${ex.filename}`, svg);
    console.log(`✓ ${ex.title} → ${OUT_DIR}/${ex.filename}`);
  } catch (err) {
    console.log(`✗ ${ex.title}: ${(err as Error).message}`);
  }
}
