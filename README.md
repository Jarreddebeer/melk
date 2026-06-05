# melk

Text-first architecture diagrams. Composition-primitive DSL,
deterministic Manhattan-router output, theme-driven visual style.

```melk
layout: lr
title: "Payment platform"

pipeline data_plane: client -> gateway -> auth -> ledger -> receipt

branch audit-out:right: ledger -> audit_log
audit_log { shape: cylinder, tags: [critical] }
```

Renders to a clean orthogonal SVG with a frame, label, and tinted
`audit_log` cylinder. No random jitter; the same source always
produces the same diagram.

## Try it

```sh
npm install
npx tsx src/cli.ts render examples/01-simple.melk > out.svg
```

CLI subcommands: `parse`, `bind`, `render`. Run with no args for full
usage.

## Why

Existing diagram-as-code tools (Mermaid, Graphviz, ELK) produce knotted
output on non-trivial diagrams — especially around back-edges, fan-outs,
and shared buses, which routinely loop or wrap. melk's approach:

- **Composition primitives** (`pipeline`, `branch`, `fan-out`, `bus`,
  `highway`, `intersect`) name the *structure*, not just the edges.
  Naming the structure constrains placement so the layout pass has a
  shape to honour, not a soup of unrelated edges.
- **Global-grid placement** snaps every box, port, and label to a
  uniform pitch. Trace routing then operates on a clean
  orthogonal-visibility graph with bend / crossing / overlap penalties.
- **Themes are separate JSON.** A theme owns colour, typography,
  strokes, dash patterns, tag rules, and module-frame chrome. The same
  `.melk` re-skins by swapping themes without source edits.

The result: source is small, output is honest about the diagram's
shape, and an LLM can author either side without the renderer
producing surprises.

## Authoring with an LLM

melk is built to be LLM-friendly:

- **One-file syntax reference**: [SYNTAX.md](SYNTAX.md) is exhaustive
  and self-contained. Every directive, attribute, shape, tag property,
  and error code is documented in one place.
- **Worked examples by feature**: [EXAMPLES.md](EXAMPLES.md) groups
  the 34 examples in [examples/](examples/) by what they demonstrate,
  with copy-pasteable recipes for common patterns.
- **Structured errors**: every error has an `E_*` code and a clear
  cause. An LLM seeing `E_DUPLICATE_PIPELINE` knows what to fix
  without context.

A reasonable system prompt for an LLM author:

```
You are a melk DSL author. Read SYNTAX.md and EXAMPLES.md.
Use composition primitives (pipeline / branch / fan-out / bus /
highway) to constrain placement — don't list edges one-by-one when a
primitive fits. Tags drive visual style, never layout. When the user's
description fits a known pattern in EXAMPLES.md §3, follow that recipe.
```

## Features

### Topology

- Forward and back edges, with inline (`>-`) and block (`back:`) forms.
- Pipelines, branches, fan-outs, buses, highways, intersect crossings.
- Module imports — compose multiple `.melk` files into one canvas;
  cross-module references and per-module themes.

### Layout

- Layered, deterministic, rank-aligned, no diagonal drift.
- LR and TB modes; swapping them rotates the diagram with no other
  edits.
- Composition primitives anchor placement; the placer never randomises.

### Routing

- Orthogonal Manhattan routing with bend/crossing/overlap penalties.
- Highway bundles for many-to-one or one-to-many flows.
- Underground render mode for back-of-board routing with faded
  outlines and manhole exits.
- X-junction materialisation for swapped opposite-direction edge pairs
  (crossings without segment overlap).

### Visual

- Themes for colour, typography, strokes, tag rules, module chrome.
- Built-in themes: `document-light`, `document-dark`, `schematic-light`,
  `schematic-dark`. Plus user themes (JSON files).
- Tag system: theme defines rules (`critical`, `future`, `deprecated`,
  custom ones); diagram uses `tags: [...]` per node/edge.
- Legend strip with automatic tag captions.
- Title / subtitle / caption strips.
- Icon packs (local or `https://`), with body-form
  (`shape: icon(...)`) and badge-form (`icon: ...`).
- Gradient fills/borders via the `linear <deg>, ...` syntax in tag
  rules.

## Project status

v1.0-prep — Phase 5 (modules + alignment + themes) is functionally
complete. 536 unit tests pass. 34 example renders cover the language
surface. The active architecture spec is split across phase docs in
the project root.

Active design docs:

- [DESIGN-PHASE4.md](DESIGN-PHASE4.md) — current layout / routing
  architecture (the Phase 1-3 docs are historical).
- [DESIGN-PHASE5-MODULES.md](DESIGN-PHASE5-MODULES.md) — module imports.
- [DESIGN-PHASE5-THEMING.md](DESIGN-PHASE5-THEMING.md) — theme schema
  and tag resolution.
- [DESIGN-PHASE5-ICONS.md](DESIGN-PHASE5-ICONS.md) — icon packs.
- [DESIGN-PHASE5-LEGEND.md](DESIGN-PHASE5-LEGEND.md) — legend strip.
- [DESIGN-PHASE5-TITLES.md](DESIGN-PHASE5-TITLES.md) — title / subtitle / caption.
- [next-session.md](next-session.md) — current session handoff (for
  contributors continuing work).
- [IDEAS.md](IDEAS.md) — sketched-but-not-yet-shipped ideas.

## License

TBD.
