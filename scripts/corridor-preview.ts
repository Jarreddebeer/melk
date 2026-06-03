/**
 * Eyeball checkpoint for Steps 5 + 6: show the corridor reservation +
 * track packing output for a handful of examples. Run with
 * `npx tsx scripts/corridor-preview.ts`.
 *
 * Each example prints:
 *   - the source melk fragment
 *   - the cell grid (same as scripts/place-preview.ts)
 *   - the row and col gutter widths (cell-units; 0 = no extra space)
 *   - each edge's route summary: source side+slot, target side+slot,
 *     corridor sequence, plus per-corridor track number
 *   - any crossings detected (corridor + edge pair)
 *
 * This is the user's first opportunity to sanity-check that traces
 * are entering and leaving box faces sensibly, that gutter widening
 * matches expected demand, and that crossings are or aren't materialised
 * as expected.
 */
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { place } from "../src/layout/place.js";
import { reserveCorridors, corridorKey } from "../src/layout/corridors.js";
import { packTracks } from "../src/layout/tracks.js";

const examples: { title: string; src: string }[] = [
  {
    title: "1. Pipeline a → b → c (single row)",
    src: "pipeline p: a -> b -> c",
  },
  {
    title: "2. Bus with 3 producers into a 1x3 shared",
    src: "s { size: 1x3 }\nbus power: [p1, p2, p3] -> s",
  },
  {
    title: "3. Fan-out with 3 consumers from a 1x3 shared",
    src: "s { size: 1x3 }\nfan-out broadcast: s -> [c1, c2, c3]",
  },
  {
    title: "4. Bus + fan-out at a shared hub",
    src:
      "h { size: 1x3 }\nbus b: [p1, p2, p3] -> h\nfan-out f: h -> [c1, c2, c3]",
  },
  {
    title: "5. TB pipeline (south flow)",
    src: "layout: tb\npipeline p: a -> b -> c",
  },
  {
    title: "6. Back-edge (forward chain + return)",
    src: "pipeline p: a -> b -> c\nback: c -> a",
  },
  {
    title: "7. Free chain a → b → c → d",
    src: "a -> b\nb -> c\nc -> d",
  },
  {
    title: "8. 9-fan-hub equivalent (Phase 4 grammar)",
    src:
      "switch { size: 2x3 }\n" +
      "bus inflow:  [p1, p2, p3, p4, p5, p6] -> switch\n" +
      "fan-out outflow: switch -> [c1, c2, c3, c4, c5, c6]",
  },
  {
    title: "9. Oversubscribed side (should error)",
    src: "bus power: [a, b, c, d] -> s",
  },
  {
    title: "10. Crossing-forcing two-pipeline (should error at budget 0)",
    src: [
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
    title: "11. Same as 10 but with crossings: 10 (should succeed)",
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
];

for (const ex of examples) {
  console.log("\n" + "=".repeat(72));
  console.log(ex.title);
  console.log("-".repeat(72));
  console.log("source:");
  for (const line of ex.src.split("\n")) console.log("  " + line);

  let placement;
  let reservation;
  let packing;
  try {
    const model = bind(parse(tokenize(ex.src)));
    placement = place(model);
    reservation = reserveCorridors(model, placement);
    packing = packTracks(model, placement, reservation);
    var edges = model.edges;
  } catch (err) {
    console.log("\nERROR: " + (err as Error).message);
    continue;
  }

  // Cell grid.
  const nRows = placement.rowUnits.length;
  const nCols = placement.colUnits.length;
  const grid: string[][] = Array.from({ length: nRows }, () =>
    Array.from({ length: nCols }, () => "."),
  );
  for (const [id, c] of placement.cells) {
    grid[c.row]![c.col] = id;
  }
  const colW = Math.max(
    3,
    ...[...placement.cells.keys()].map((id) => id.length),
  );
  console.log("\nplacement:");
  for (const row of grid) {
    console.log("  " + row.map((cell) => cell.padEnd(colW)).join(" "));
  }

  // Gutter strips.
  console.log(
    `\nrowUnits:        ${JSON.stringify(reservation.rowUnits)}` +
      `   colUnits:        ${JSON.stringify(reservation.colUnits)}`,
  );
  console.log(
    `rowGutterUnits:  ${JSON.stringify(reservation.rowGutterUnits)}` +
      `   colGutterUnits:  ${JSON.stringify(reservation.colGutterUnits)}`,
  );

  // Demand summary.
  const demandEntries = [...reservation.demand.entries()].sort();
  console.log("demand:          " + demandEntries.map(([k, v]) => `${k}=${v}`).join(", "));

  // Routes with track annotations.
  console.log("\nroutes (with per-corridor track):");
  const trackByEdgeAndCorridor = new Map<string, number>();
  for (const t of packing.tracks) {
    trackByEdgeAndCorridor.set(`${t.edgeIndex}|${t.corridor}`, t.track);
  }
  for (const r of reservation.routes) {
    const edge = edges[r.edgeIndex]!;
    const seq = r.corridorSequence
      .map((c) => {
        const k = corridorKey(c);
        const tr = trackByEdgeAndCorridor.get(`${r.edgeIndex}|${k}`);
        return `${k}:t${tr}`;
      })
      .join(" → ");
    const tag = edge.isBackEdge ? "  (back)" : "";
    console.log(
      `  ${edge.from} -> ${edge.to}${tag}  ` +
        `src=${r.sourceSide}#${r.sourceSlot}  ` +
        `tgt=${r.targetSide}#${r.targetSlot}  ` +
        `corridors: [${seq}]`,
    );
  }

  // Crossings.
  if (packing.crossings.length === 0) {
    console.log("\ncrossings: none");
  } else {
    console.log("\ncrossings:");
    for (const x of packing.crossings) {
      const a = edges[x.edgeIndexA]!;
      const b = edges[x.edgeIndexB]!;
      console.log(
        `  ${x.corridor}: ${a.from}->${a.to} (edge ${x.edgeIndexA}) × ${b.from}->${b.to} (edge ${x.edgeIndexB})`,
      );
    }
  }
}
