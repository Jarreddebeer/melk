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

Renders to a clean orthogonal SVG with a frame, label, and a tinted
`audit_log` cylinder. The layout is deterministic — the same source
always produces the same diagram.

## Install

```sh
npm install -g @jarreddebeer/melk
```

The CLI binary is `melk`:

```sh
melk render   examples/01-simple.melk            # writes examples/01-simple.svg next to input
melk render   examples/01-simple.melk -o out.svg # explicit output path
melk validate examples/01-simple.melk
melk format   examples/01-simple.melk
```

`render` defaults `-o` to `<input-without-.melk>.svg` next to the
input. If `-o` resolves to the input path, melk appends `.svg` and
warns rather than clobbering the source.

CLI subcommands: `parse`, `bind`, `validate`, `format`, `render`. Run
with no args for full usage.

Library import:

```js
import { tokenize, parse, bind, renderSVG } from "@jarreddebeer/melk";
```

Or run from a local checkout:

```sh
git clone <this repo> && cd melk
npm install
npx tsx src/cli.ts render examples/01-simple.melk
```

## How it works

- **Composition primitives** (`pipeline`, `branch`, `fan-out`, `bus`,
  `highway`, `intersect`) name the *structure* of the diagram. Naming
  the structure gives the layout pass a shape to honour, and lets the
  source stay terse — a four-node flow is a single `pipeline` line.
- **Global-grid placement** snaps every box, port, and label to a
  uniform pitch. Layout is deterministic — the same source always
  produces the same diagram. Composition primitives *anchor* nodes
  to specific cells; the placer refuses to guess when two
  constraints collide. See SYNTAX.md §3.11 and EXAMPLES.md §5 for
  the mental model and the common error shapes.
- **Orthogonal Manhattan routing** with bend, crossing, and overlap
  penalties produces clean engineered-looking traces, with dedicated
  channels for back-edges, fan-outs, and shared buses.
- **Themes are separate JSON.** A theme owns colour, typography,
  strokes, dash patterns, tag rules, and module-frame chrome. The same
  `.melk` re-skins by swapping themes without source edits.

## Authoring with an LLM

melk is built to be LLM-friendly:

- **One-file syntax reference**: [SYNTAX.md](SYNTAX.md) is exhaustive
  and self-contained. Every directive, attribute, shape, tag property,
  and error code is documented in one place.
- **Worked examples by feature**: [EXAMPLES.md](EXAMPLES.md) groups
  the 43 examples in [examples/](examples/) by what they demonstrate,
  with copy-pasteable recipes for common patterns.
- **Structured errors with fix hints**: every error has an `E_*` code
  and a `Hint:` suffix on the high-traffic ones, so seeing
  `E_AMBIGUOUS_PLACEMENT` gives the author a concrete `branch :right:`
  template to apply.
- **Fast iterate loop**: `melk validate <file>` runs the full pipeline
  and prints `OK` or a single-line error — quick feedback without
  rendering an SVG.
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
6. Once OK, `melk render <name>.melk` (writes `<name>.svg`).
```

## Features

### Topology

- Forward edges (`->`) and back edges (`>-`).
- Pipelines, branches, fan-outs, buses, highways, intersect crossings.
- Module imports — compose multiple `.melk` files into one canvas;
  cross-module references and per-module themes.

### Layout

- Layered, deterministic, rank-aligned, no diagonal drift.
- LR and TB modes; swapping them rotates the diagram with no other
  edits.
- Composition primitives anchor placement; the placer never randomises.
- Per-node `offset: "WxH"` for manual nudges when the auto-placer
  needs a small override (integer cells or sub-cell pixel shifts).
- Auto via-shim aligns highway via members' slot clusters with the
  bundle's pixel grid — no manual intervention needed for the
  common case.

### Routing

- Orthogonal Manhattan routing with bend/crossing/overlap penalties.
- Highway bundles for many-to-one or one-to-many flows. Multi-trace
  fan-outs stair monotonically — the lane closest to the source slot
  is also the first to bend, so adjacent chamfers don't overlap.
- `exit:` / `entry:` per-edge face overrides force a specific source
  or target face. The router auto-routes around the target's body
  with a perimeter U-shape when the natural L would cut through it
  (e.g. entering a node from its south face when the source is above).
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
complete. 411 unit tests pass. 43 example renders cover the language
surface (42 currently render; ex 29 is a known 5×5 intersect routing
limit tracked in [next-session.md](next-session.md)). The active
architecture spec is split across phase docs in the project root.

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
