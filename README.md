# melk

Text-first architectural diagramming. Circuit-board-style orthogonal routing, deterministic layout, clean back-edges.

**Status:** Phase 1 complete. See [DESIGN.md](DESIGN.md) for the architecture and roadmap.

## Try it

```
npm install
npx tsx src/cli.ts render examples/01-simple.melk > out.svg
```

CLI subcommands: `parse`, `bind`, `layout`, `route`, `render`. Each prints the result of the corresponding pipeline stage to stdout.

## Why

Existing diagramming tools (Mermaid, ELK, Graphviz) produce knotted output on non-trivial diagrams — especially around back-edges, which often loop forward and wrap awkwardly. melk's premise: a layered (Sugiyama-style) node placer for rank-aligned, deterministic positions, plus an orthogonal-visibility-graph router (Wybrow et al., GD 2009) for clean Manhattan edge routing. Back-edges route naturally through the cheapest channel — usually a dedicated lane above or below the spine.

## Phase 1 features

- DSL: nodes with shape (`rect`, `roundrect`, `circle`, `diamond`, `cylinder`), T-shirt or explicit sizes, edges with labels, `lr`/`tb` layout.
- Layered placement: deterministic, rank-aligned, no diagonal drift.
- Orthogonal routing: visibility graph + A* with bend/crossing/overlap penalties, rip-up-and-reroute, nudging for parallel-segment separation.
- SVG output: clean labels above edges with a small text-halo for readability, arrowheads land exactly at port positions.

## Roadmap

Phase 2+ — see [DESIGN.md §3.1](DESIGN.md): `spine` / `lane` / `group` primitives, composition via `import`, style separation, radial layout, the bidirectional editor.
