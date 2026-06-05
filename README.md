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

## Install

```sh
npm install -g @melk/cli
```

The package is published as `@melk/cli` because the unscoped `melk`
name is blocked by npm's similar-names check (too close to `mem`,
`meow`, `walk`, `del`). The CLI binary is still `melk`:

```sh
melk render examples/01-simple.melk > out.svg
melk validate examples/01-simple.melk
melk format   examples/01-simple.melk
```

Library import (for tooling that wraps melk):

```js
import { tokenize, parse, bind, renderSVG } from "@melk/cli";
```

Or run from a local checkout:

```sh
git clone <this repo> && cd melk
npm install
npx tsx src/cli.ts render examples/01-simple.melk > out.svg
```

CLI subcommands: `parse`, `bind`, `validate`, `format`, `render`.
Run with no args for full usage.

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
- **Structured errors with fix hints**: every error has an `E_*` code
  and a `Hint:` suffix on the high-traffic ones. Seeing
  `E_AMBIGUOUS_PLACEMENT` an LLM gets a concrete `branch :right:`
  template to apply.
- **Fast iterate loop**: `melk validate <file>` runs the full pipeline
  and prints `OK` or a single error line — no SVG noise — so an LLM
  can iterate without burning context on render output.
- **Canonical form**: `melk format <file>` normalizes whitespace and
  category ordering so diffs focus on meaningful change.

### Ready-to-paste system prompt

Use [prompts/melk-author.md](prompts/melk-author.md) as the system
prompt when delegating `.melk` authoring to an LLM. It's pure
pointers — the LLM reads SYNTAX.md and EXAMPLES.md from the project
itself — plus the hard-won lessons LLM authors reliably miss
(`branch` is single-member, highways are `via:`-only, bare edges off
a spine collide, etc.).

A typical LLM-driven authoring loop:

```
1. User describes the architecture.
2. LLM reads SYNTAX.md + EXAMPLES.md (first session only; subsequent
   sessions remember the rules).
3. LLM writes <name>.melk.
4. Run `melk validate <name>.melk`.
5. If non-OK, the error's Hint: tells the LLM what to fix. Iterate.
6. Once OK, `melk render <name>.melk -o <name>.svg`.
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

MIT — see [LICENSE](LICENSE).
