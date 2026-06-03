/**
 * Eyeball checkpoint for Step 4: render a few placements as ASCII grids.
 * Run with `npx tsx scripts/place-preview.ts`.
 *
 * Each example prints:
 *   - the source melk fragment
 *   - the resulting cell map as a row × col ASCII grid
 *   - the row/col cell-unit widths/heights
 *
 * This is the user's first opportunity to sanity-check the layout
 * geometry before Step 5 (corridor reservation) builds on top of it.
 * If anything looks wrong, fix the placer before continuing.
 */
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";

const examples: { title: string; src: string }[] = [
  {
    title: "1. Simple pipeline (LR)",
    src: "pipeline ingest: a -> transform -> validate -> publish",
  },
  {
    title: "2. Bus (3 producers → shared)",
    src: "bus power: [a, b, c] -> shared",
  },
  {
    title: "3. Fan-out (shared → 3 consumers)",
    src: "fan-out broadcast: shared -> [x, y, z]",
  },
  {
    title: "4. Pipeline + downstream fan-out (shared node)",
    src: "pipeline pi: source -> hub\nfan-out fo: hub -> [a, b, c]",
  },
  {
    title: "5. Free chain (no anchors)",
    src: "a -> b\nb -> c\nc -> d",
  },
  {
    title: "6. Two disconnected pipelines",
    src: "pipeline one: a -> b -> c\npipeline two: x -> y -> z",
  },
  {
    title: "7. TB layout (south flow)",
    src: "layout: tb\npipeline ingest: a -> transform -> publish",
  },
  {
    title: "8. Orphan node alongside an edge",
    src: "a -> b\nlonely",
  },
  {
    title: "9. Variable cell sizes",
    src: "a { size: 2x1 }\nb { size: 1x2 }\nc { size: 1x1 }\npipeline pi: a -> b -> c",
  },
];

for (const ex of examples) {
  console.log("\n" + "=".repeat(60));
  console.log(ex.title);
  console.log("-".repeat(60));
  console.log("source:");
  for (const line of ex.src.split("\n")) console.log("  " + line);
  const placement = place(bind(parse(tokenize(ex.src))));

  // Find grid dimensions.
  const nRows = placement.rowUnits.length;
  const nCols = placement.colUnits.length;
  // Build grid: rows x cols of node-id (or ".").
  const grid: string[][] = Array.from({ length: nRows }, () =>
    Array.from({ length: nCols }, () => "."),
  );
  for (const [id, c] of placement.cells) {
    grid[c.row]![c.col] = id;
  }
  // Pick a uniform column width for readability.
  const colW = Math.max(
    3,
    ...[...placement.cells.keys()].map((id) => id.length),
  );
  console.log("\nplacement:");
  for (const row of grid) {
    console.log(
      "  " + row.map((cell) => cell.padEnd(colW)).join(" "),
    );
  }
  console.log(`\nrowUnits: ${JSON.stringify(placement.rowUnits)}`);
  console.log(`colUnits: ${JSON.stringify(placement.colUnits)}`);
  console.log(`flowAxis: ${placement.flowAxis}`);
}
