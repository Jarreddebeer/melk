# melk — Phase 5 design: theming

**Status:** spec (not yet implemented)
**Builds on:** [DESIGN-PHASE4.md](DESIGN-PHASE4.md). Adds a render-time theming layer over the existing pipeline; does not touch parse / bind / place / corridor / track / polyline stages.
**Replaces:** the hardcoded `BG_FILL`, `BOX_FILL`, `BOX_STROKE`, font, and stroke constants at the top of [src/render/svg.ts](src/render/svg.ts).

Phase 4 closed with the renderer functional but every visual choice baked into module-level constants. Phase 5 lifts those choices into a **theme** — a named, swappable bundle of semantic tokens, typography, stroke metrics, and tag-rule overrides that the renderer reads through a single interface. The .melk source describes what the diagram *is*; the theme describes what it *looks like*. Switching themes is a lick of paint — no layout move, no edge reroute, no byte of geometry differs.

The design has five pillars:

1. **Semantic tokens, not literal slots.** A theme exposes `surface`, `ink-primary`, `trace-default`, etc. — not `BOX_FILL` or `EDGE_STROKE`. Mapping tokens to SVG attributes is the renderer's job. Future back-ends (WebGPU, Canvas) read the same tokens and decide their own mapping.
2. **Strict separation from layout.** A theme can never change geometry — not cell position, not routing, not box size, not anchor direction. The set of properties a theme can touch is enumerated and bounded.
3. **Built-in theme catalogue.** Four themes ship: `document-light` (default), `document-dark`, `schematic-light`, `schematic-dark`. They demonstrate the two aesthetic polarities the abstraction is designed to handle.
4. **Tags + theme rules for structured overrides.** Authors tag nodes/edges in .melk (`{ tags: [future, critical] }`); the theme defines what each tag means (`tags.future.border = status-warn`). Reusable across diagrams; consistent under theme swap. CSS class semantics.
5. **External theme files.** Built-in names are resolved first; otherwise the value is treated as a path to a JSON theme file. Authors can ship a corporate-brand theme without forking melk.

The user-facing surface is small: one new top-level directive (`theme: NAME`), one new node/edge brace-attr (`tags: [...]`), one new CLI flag (`--theme=NAME`). Everything else lives in JSON.

---

## 1. The theme as data

### 1.1 Theme structure

A theme is a JSON object with four required sections:

```json
{
  "name": "document-light",
  "tokens":     { "surface": "#fafafa", "ink-primary": "#161616", ... },
  "typography": { "face": "Inter, ...", "size": { "body": 13, ... }, ... },
  "strokes":    { "outline": 1.5, "trace": 1.5, "emphasis": 3.5, ... },
  "tags":       { "future": { "border": "status-warn" }, ... }
}
```

`name` is the identifier used by `theme: NAME` directives. For built-in themes it matches the file's slug; for external files, it's informational. The renderer resolves themes by *the value the author wrote*, not by reading `name` from the file.

### 1.2 The token vocabulary

Tokens are semantic, not slot-shaped. Every token has a fixed meaning across themes; only the value changes. The vocabulary is **closed** — adding a token is a doc change, not a per-theme decision. This is the discipline that makes dark-mode work consistently (Material Design 3 and Carbon both ship this way).

**Surfaces (the substrate layer).** These cover the canvas, raised cards, sunken regions.

| Token            | Purpose                                                       |
|------------------|---------------------------------------------------------------|
| `surface`        | Main canvas fill — the background of the SVG.                 |
| `surface-raised` | Box fill (one layer up from the canvas).                      |
| `surface-sunken` | Underground-highway through-segment background (§11.11 v2).   |

**Ink (text and primary marks).**

| Token             | Purpose                                              |
|-------------------|------------------------------------------------------|
| `ink-primary`     | Node labels, primary text.                           |
| `ink-secondary`   | Edge labels, nodeset captions, less-prominent text.  |

**Borders (the outlines that delimit shapes).**

| Token             | Purpose                                              |
|-------------------|------------------------------------------------------|
| `border-strong`   | Box outline.                                         |
| `border-subtle`   | Nodeset dashed frame, highway dashed bounds.         |

**Traces (the wires).**

| Token             | Purpose                                              |
|-------------------|------------------------------------------------------|
| `trace-default`   | Standard edge stroke.                                |
| `trace-emphasis`  | Path-highlight overlay fallback (used when `path: NAME color: ...` is absent and the per-path palette is exhausted). |
| `trace-muted`     | Back-edge stroke (still dashed; see §1.4).           |

**Accents (path-highlight palette).** A fixed-length array of 5–7 hues, indexed in declaration order across the diagram's `path` annotations. Wrap around if more paths than colours.

| Token        | Purpose                                              |
|--------------|------------------------------------------------------|
| `accents[]`  | Array (length 5–7). Path highlights cycle through it.|

**Status (semantic role colours for tags).** These are *referenceable* from tag rules — e.g. `tags.future.border = status-warn` produces the same visible meaning across themes.

| Token            | Purpose                                              |
|------------------|------------------------------------------------------|
| `status-error`   | Failed, broken, deprecated.                          |
| `status-warn`    | Future-state, in-progress, conditional.              |
| `status-ok`      | Implemented, validated.                              |
| `status-info`    | Annotation, callout.                                 |

**Label-halo.** A single colour used to draw the white halo behind edge labels so they remain readable when crossing other traces. In dark themes this becomes the surface colour, not white.

| Token           | Purpose                                                  |
|-----------------|----------------------------------------------------------|
| `label-halo`    | Halo behind edge labels (matches `surface`).             |

That's 18 tokens total (plus the variable-length `accents` array). The list is small enough that a custom theme author can fill it in 5 minutes; the discipline of having a fixed set is what makes future renderers (WebGPU, Canvas) reuse the same theme files.

### 1.3 Typography

Three sizes, two weights, two faces. The face strings are CSS font-family strings; the renderer emits them into the SVG `font-family` attribute. WebGPU back-ends would map them to font-atlas selection.

```json
"typography": {
  "face":      "Inter, -apple-system, Segoe UI, Roboto, sans-serif",
  "face-mono": "JetBrains Mono, Consolas, Monaco, monospace",
  "size":   { "body": 13, "edge": 11, "frame": 11 },
  "weight": { "label": 500, "heading": 600 }
}
```

`face` is the primary sans for all labels. `face-mono` is reserved for future use (code-ish identifiers); the current renderer doesn't emit monospaced text but the slot exists so themes can declare a pairing now.

Size names match the three text contexts the renderer currently emits: `body` (node labels), `edge` (edge labels), `frame` (nodeset captions). These are pt-sized, matching the existing constants (13/11/11). Adding a new size category is a renderer change; themes only fill the existing three.

### 1.4 Strokes

Stroke widths and dash patterns. All measurements in CSS pixels (the SVG default unit).

```json
"strokes": {
  "outline":  1.5,
  "trace":    1.5,
  "emphasis": 3.5,
  "frame":    1.0,
  "underground-opacity": 0.45,
  "underground-width":   1.0,
  "manhole-radius":      3,
  "dash": {
    "frame":     [4, 3],
    "back-edge": [5, 3]
  },
  "arrow": {
    "scale":      3.5,
    "head-shape": "filled-triangle"
  }
}
```

`arrow.scale` is the marker size as a multiplier of `trace` width. Conventional value 3.5 (≈ research-recommended `markerWidth=6` for a 1.5 px line). `head-shape` is a discrete enum — themes can opt into `none` (no arrowhead, schematic-style) or `filled-triangle` (the current default). Two values for now; more can be added without breaking existing themes.

### 1.5 Tag rules

Tags are how authors name a per-node or per-edge override semantically rather than visually. The author writes `{ tags: [future] }` on a node; the theme's `tags.future` rule maps to one or more visual overrides:

```json
"tags": {
  "future": {
    "border":       "status-warn",
    "border-width": 2,
    "dash":         [4, 3]
  },
  "critical": {
    "border":       "status-error",
    "border-width": 2
  },
  "deprecated": {
    "trace":        "ink-secondary",
    "dash":         [3, 3],
    "opacity":      0.6
  }
}
```

**The override property set is closed.** Tag rules can touch exactly these properties — nothing else:

| Property        | Applies to | Type                                |
|-----------------|------------|-------------------------------------|
| `fill`          | nodes      | token name or literal `#hex`        |
| `border`        | nodes      | token name or literal `#hex`        |
| `border-width`  | nodes      | px number                           |
| `text`          | nodes      | token name or literal `#hex`        |
| `text-weight`   | nodes      | 100–900 integer                     |
| `trace`         | edges      | token name or literal `#hex`        |
| `trace-width`   | edges      | px number                           |
| `dash`          | both       | array of px numbers, or `null` for solid |
| `opacity`       | both       | 0–1 number                          |

This is the **complete** tag-rule grammar. A property not in this list is rejected at theme-load time with `E_UNKNOWN_TAG_PROPERTY`. The bound list is what guarantees a theme can't change geometry — `shape`, `size`, `cell`, `routing`, `exit-side`, etc. are not in the table and can never be.

**Token references vs literals.** Colour-valued properties accept either a token name from §1.2 (`status-warn`, `accent-2`, `trace-default`) or a literal hex string (`"#c53030"`). Token names are preferred — they remain consistent under theme swap. Literals are an escape hatch for true one-offs (e.g. matching a corporate brand colour that doesn't fit any token role).

**Multiple tags compose by declaration order.** If a node has `{ tags: [future, critical] }`, `future`'s overrides apply first, then `critical`'s. Conflicting properties: the later tag wins. This is the same rule as CSS class order.

**Unknown tag names are an error**, not a silent no-op. `E_UNKNOWN_TAG` fires at bind time if `{ tags: [foo] }` references a tag the active theme doesn't define. Rationale: silent failure here would mean a node intended to render red simply doesn't, with no signal. Strict-from-day-one (§11 lock from Phase 4).

### 1.6 Validation

Theme files are validated at load time. Errors:

- `E_THEME_MISSING_FIELD` — a required token, typography size, or stroke key is absent.
- `E_THEME_UNKNOWN_TOKEN` — an unrecognised token name (typo of `surface` as `surfaec`).
- `E_THEME_BAD_COLOUR` — a value where a colour is expected isn't a `#rrggbb` / `#rgb` / token-name.
- `E_THEME_BAD_NUMBER` — a numeric field has a non-number, negative width, etc.
- `E_THEME_BAD_ACCENTS_LENGTH` — `accents[]` has fewer than 3 or more than 9 entries.
- `E_UNKNOWN_TAG_PROPERTY` — a tag rule uses a property not in §1.5's table.
- `E_THEME_LOAD_FAILED` — the file can't be read or parsed as JSON.

All theme errors fire before rendering begins; partial themes never render.

---

## 2. Selecting a theme

### 2.1 The `theme:` directive

A new top-level .melk directive, alongside `layout:` and `crossings:`:

```
layout: lr
theme:  schematic-dark
crossings: 0

pipeline main: a -> b -> c
```

The directive is **optional**. When absent, the default theme is `document-light`.

The value is either:

1. A **built-in theme name** — `document-light`, `document-dark`, `schematic-light`, `schematic-dark`. Resolved against the catalogue first.
2. A **relative or absolute file path** — `./themes/acme.json`, `../shared/brand-theme.json`. Resolved relative to the .melk file's directory.

The renderer tries built-in resolution first; if no match, falls back to file resolution. This means built-in names are reserved and cannot be shadowed by a file (no `./document-light.json` substitution).

### 2.2 CLI override

The `melk render` CLI gets a `--theme=NAME` flag that overrides any in-source `theme:` directive:

```
melk render foo.melk --theme=schematic-dark -o foo.svg
```

This lets a user re-skin a file without editing it — useful for batch rendering a directory under a corporate theme, or generating both light and dark versions of every example.

CLI precedence: `--theme=` > in-source `theme:` > built-in default.

### 2.3 No "theme inheritance"

A theme is loaded as a complete unit. Themes do not inherit from other themes, there is no `extends:` field, and partial themes are rejected. Rationale: theme inheritance is a known regret in Mermaid's `themeVariables` system — it pushes the difficult work (filling in derived values) into the theme author. Requiring complete themes keeps each one a coherent design statement.

(A future tooling improvement could be a `melk theme init NAME` CLI that copies a built-in to a starting file. That's a generator, not inheritance.)

---

## 3. Tags as the override mechanism

### 3.1 Tagging nodes

Tags attach to nodes and edges as a brace-attr `{ tags: [name, name, ...] }`:

```
node my_service shape: rect { tags: [future, critical] }

bus log_bus: [svc_a, svc_b] -> log_store {
  // ... edge attrs go inside the structured-flow's edges
}

svc_a -> log_store { tags: [deprecated] }
```

A tag name is an identifier (same lexical rules as a node id). The list may be empty (`{ tags: [] }`) — equivalent to no tag attr at all.

### 3.2 Resolution

At bind time, each tag name on a node/edge is looked up against the active theme's `tags` table. Unknown tags fire `E_UNKNOWN_TAG` with the file location of the offending `tags: [...]`.

Tag rules compose in declaration order (§1.5). The resolved override set is attached to the model node/edge and consumed by the renderer.

### 3.3 What tags can NOT do

The override-property table in §1.5 is exhaustive. In particular, tags cannot change:

- `shape` (a `rect` cannot be re-shaped into a `circle` via a tag)
- `size`, `width`, `height` (cell footprint is locked in the grammar)
- `pivot`, `avoid`, `via`, `exit-side`, `entry-side` (routing knobs)
- `orient`, `render` (highway semantics)
- `slot-order` (slot allocator behaviour)
- Any layout-affecting brace-attr from DESIGN-PHASE4.md §11

This is the bright line: a tag is a paint job, not a structural edit. If an author wants a different shape for the "future" state, they declare a different node shape — that's a model decision, not a theme decision.

### 3.4 Tags are theme-coupled, by design

A diagram with `{ tags: [future] }` is meaningful only under a theme that defines `future`. Swapping to a theme that lacks `future` is a bind-time error.

This *is* a coupling — but it's the intended one: the author has declared "this node is special in a way the theme system understands"; the theme has declared "this is how special-ness shows up visually". Both halves are needed for the override to be meaningful, and either half going missing should be loud. The alternative (silent skip) leads to "why isn't this red?" debugging.

For the case where an author truly wants a one-off colour with no semantic name, the escape hatch is **literal-hex tag rules** at the .melk-side (rejected) or the **inline-style approach** (deferred — see §6.3). At v1 the answer is: invent a tag name, define it in your theme. The friction is intentional.

---

## 4. The built-in catalogue

Four themes ship with melk. Each is a fully-specified JSON file under `themes/` in the source tree, loaded at renderer init.

### 4.1 document-light (default)

The "corporate architecture diagram" aesthetic. Off-white substrate, dark traces, sans-serif labels. Reads like C4 or draw.io. Prints well, fits a slide deck.

Key tokens:

```
surface:        #fafafa   // Gray-50, not pure white (Carbon convention)
surface-raised: #f7f9fc   // very light cool grey
ink-primary:    #161616   // Gray-90, not pure black
ink-secondary:  #5a6678
border-strong:  #2b3340
border-subtle:  #9fa9bb
trace-default:  #3a4658   // charcoal
trace-emphasis: #2b6cb0   // saturated blue (fallback)
label-halo:     #fafafa   // matches surface
accents:        ["#2b6cb0","#c53030","#2f855a","#b7791f","#553c9a","#0987a0"]
```

Typography: Inter 13/500, edge 11, frame 11.
Strokes: outline 1.5, trace 1.5, emphasis 3.5, frame 1.0 dashed `4 3`.
Arrow: `filled-triangle`, scale 3.5.

This is essentially the current renderer's hardcoded look, lifted into theme form, with `#ffffff` softened to `#fafafa` and `#1a1f2b` softened to `#161616` per Carbon's "never pure" rule.

### 4.2 document-dark

The light theme re-tuned for dark substrate. Not a colour inversion — surfaces preserve the layered ordering (deep → shallow), and accents shift to lighter tonal stops so they don't vibrate.

```
surface:        #1c1f26   // not pure black
surface-raised: #262a33   // one layer up
ink-primary:    #e6edf3
ink-secondary:  #8b95a7
border-strong:  #c4ccda
border-subtle:  #4a5160
trace-default:  #c4ccda
trace-emphasis: #79b8ff
label-halo:     #1c1f26   // matches surface
accents:        ["#79b8ff","#fb7474","#85e89d","#f0c14b","#d2a8ff","#5dd5e3"]
```

Typography: Inter 13/500.
Strokes: same as document-light.

### 4.3 schematic-light

The PCB-substrate aesthetic on a light background. KiCad's light theme inspiration. Saturated trace colours, IBM Plex Sans for a schematic feel, no default arrowheads (direction comes from topology).

```
surface:        #f5f1e8   // off-cream, like silkscreen
surface-raised: #ffffff
ink-primary:    #1a2332
ink-secondary:  #4a5568
border-strong:  #2c5282   // PCB-blue trace colour
border-subtle:  #a0aec0
trace-default:  #2c5282   // saturated blue trace
trace-emphasis: #c05621   // copper-orange highlight
label-halo:     #f5f1e8
accents:        ["#2c5282","#c05621","#2f855a","#b7791f","#553c9a"]
```

Typography: IBM Plex Sans 13/500.
Strokes: outline 1.5, trace 1.5, emphasis 3.5.
Arrow: `none` (schematic convention — direction is routing-implied).

### 4.4 schematic-dark

The full PCB look. Deep dark substrate, lighter cyan traces (the inverted polarity the research called out), schematic font. This is the theme that proves the abstraction — if it can render the same diagram convincingly in this style without changing one cell of layout, the separation is real.

```
surface:        #0d1117   // deep substrate
surface-raised: #161b22
ink-primary:    #e6edf3
ink-secondary:  #8b949e
border-strong:  #30363d
border-subtle:  #21262d
trace-default:  #58a6ff   // cyan-on-dark, PCB classic
trace-emphasis: #f0883e   // orange-copper highlight
label-halo:     #0d1117
accents:        ["#58a6ff","#f0883e","#3fb950","#d29922","#bc8cff"]
```

Typography: IBM Plex Sans 13/500.
Strokes: outline 1.5, trace 1.5, emphasis 3.5.
Arrow: `none`.

### 4.5 Why these four

The two axes are **polarity** (document = trace darker than canvas; schematic = trace lighter than canvas) and **mode** (light vs dark canvas). The 2×2 = 4 combinations exhausts the design space at the highest level.

A theme author building a corporate brand picks the polarity closest to the desired feel, copies the JSON, retunes the tokens. A user picking a built-in for a one-off render has four meaningful choices, not forty.

---

## 5. Renderer integration

### 5.1 Threading the theme

`renderSVG` gains a `theme: Theme` parameter:

```typescript
export function renderSVG(
  model: Model,
  placement: Placement,
  reservation: Reservation,
  polylines: Polylines,
  theme: Theme,
): string;
```

A `Theme` is a parsed-and-validated theme object (TypeScript interface mirroring §1). The CLI is responsible for resolving the theme (built-in name → file → JSON parse → validate) and passing it in.

Every reference to a hardcoded constant in [src/render/svg.ts](src/render/svg.ts) is replaced by a token lookup:

- `BG_FILL` → `theme.tokens.surface`
- `BOX_FILL` → `theme.tokens["surface-raised"]`
- `BOX_STROKE` → `theme.tokens["border-strong"]`
- `BOX_STROKE_WIDTH` → `theme.strokes.outline`
- `TEXT` → `theme.tokens["ink-primary"]`
- `EDGE_STROKE` → `theme.tokens["trace-default"]`
- `EDGE_WIDTH` → `theme.strokes.trace`
- `BACK_EDGE_DASH` → `theme.strokes.dash["back-edge"]`
- `UNDERGROUND_OPACITY` → `theme.strokes["underground-opacity"]`
- `UNDERGROUND_WIDTH` → `theme.strokes["underground-width"]`
- `MANHOLE_RADIUS` → `theme.strokes["manhole-radius"]`
- `NODESET_STROKE` → `theme.tokens["border-subtle"]`
- `NODESET_DASH` → `theme.strokes.dash.frame`
- `NODESET_LABEL_FILL` → `theme.tokens["ink-secondary"]`
- `PATH_COLOURS` → `theme.tokens.accents`
- `PATH_WIDTH` → `theme.strokes.emphasis`
- `FONT_FAMILY` → `theme.typography.face`
- `FONT_SIZE` → `theme.typography.size.body`
- `EDGE_LABEL_SIZE` → `theme.typography.size.edge`
- `NODESET_LABEL_SIZE` → `theme.typography.size.frame`
- `LABEL_HALO` → `theme.tokens["label-halo"]`
- `ARROW_LENGTH` → derived from `theme.strokes.arrow.scale * theme.strokes.trace`

No new constants are introduced in the renderer file. The mapping is exhaustive — if a hardcoded value remains, it's a theming bug.

### 5.2 Tag-rule application

After tokens are resolved, the renderer applies per-node and per-edge tag overrides:

1. For each node, look up the node's resolved tag-overrides (computed at bind time).
2. For each property in the override set, replace the corresponding theme-default with the override value (resolving any token references at this point).
3. Same for edges.

Tag overrides apply *on top of* theme tokens, not instead of them. A node tagged `future` (which sets `border: status-warn`) still inherits its fill from the theme's `surface-raised`. Only the explicitly-listed properties change.

### 5.3 Arrow toggle

`theme.strokes.arrow.head-shape` controls whether arrowheads render. When `none`, the `<marker id="arrow">` defn is omitted and `marker-end="url(#arrow)"` is suppressed on every edge. When `filled-triangle`, current behaviour is preserved.

The schematic themes default to `none`; the document themes default to `filled-triangle`. This is the second-biggest visual difference between the two aesthetics (after canvas polarity).

### 5.4 Renderer remains pure

The function signature stays referentially transparent: `(model, placement, reservation, polylines, theme) → string`, no side effects. This preserves the existing testing pattern (one render call per assertion; byte-for-byte determinism).

---

## 6. Out of scope for Phase 5

These are intentionally deferred to keep the v1 surface small. Each is a real future feature; none of them block shipping the core theming layer.

### 6.1 Inline style overrides on .melk source

A common urge: let the author write `node a { style: { border: "#c53030" } }` inline for true one-offs that don't deserve a tag name. v1 says no — invent a tag name, define it in your theme.

Rationale: the inline-style surface is the gateway drug to "style and layout in the same brace-attr", which is the Structurizr regret. Locking the v1 spec to "tags only, no inline" forces every override to live in the theme — keeping the *what* in .melk separate from the *how* in JSON. If after some real usage we find one-offs genuinely don't fit the tag model, we can add inline style as a v2 addition.

### 6.2 Per-shape style table

Structurizr's `style` block applies styles per-tag, not per-shape kind. v1 borrows this. A future extension could add `shapes.highway = { stroke: ..., dash: ... }` to a theme so themes can re-skin a specific shape kind. Not needed for the v1 catalogue (the four built-ins don't need it; they all use the same highway treatment).

### 6.3 Computed / derived themes

Material 3 generates an entire colour system from a single seed colour. v1 requires every token be specified literally. If theme authoring proves tedious in practice, a `melk theme init` generator could derive a starter from a seed colour + light/dark + polarity choice. Not a runtime feature — a tooling feature.

### 6.4 Theme variables in .melk source

Some systems let the .melk source override individual theme tokens inline (`theme: schematic-dark { surface: #000 }`). v1 says no — a theme is a coherent unit; one-off token tweaks defeat the point. If a user wants a custom theme, they author a JSON file.

### 6.5 Print / web / dark-aware adaptive themes

Future browsers may signal user preference (`prefers-color-scheme: dark`). At v1 the .melk → SVG conversion is one-shot and the theme is chosen at render time. A future CSS-in-SVG approach (using CSS custom properties + media queries) could let a single SVG adapt to the viewer's preference. Architecturally aligned but not v1.

### 6.6 Per-edge / per-node label visibility

Hiding labels on specific nodes is a real authoring need (e.g. for "trace-only" emphasis diagrams). v1 keeps all labels visible. A future tag rule could add `label-visible: false` to the override property table.

### 6.7 Theme application to nodesets and paths

`path: NAME color: "#xxx"` (per-path explicit colour) was mentioned in the Phase-4 follow-on list and remains useful. v1 cycles through `theme.tokens.accents` in declaration order; v2 could let `path NAME color: accent-3` (or a literal) override the round-robin. Strictly orthogonal to the v1 theme spec.

---

## 7. Decisions locked

From this design pass:

- **Aesthetic: ship both polarities as built-ins.** Document (trace-on-paper) and schematic (trace-on-substrate). Four themes shipped: `document-light`, `document-dark`, `schematic-light`, `schematic-dark`. Default is `document-light`.
- **Token model: semantic, not literal slots.** The closed vocabulary (§1.2) is the contract. New tokens require a spec update, not a per-theme decision.
- **Override model: tags + theme rules.** No inline-style escape hatch at v1. Property surface bounded by the §1.5 table — geometry properties not in the table can never be touched.
- **Selection: source directive + CLI override, built-in names + file paths.** `theme: NAME` in .melk; `--theme=NAME` on CLI; either accepts a built-in name or a file path; CLI wins on conflict.
- **Strict by default.** Unknown tag names, unknown tokens, missing theme fields all raise bind-time errors. No silent fallbacks.
- **No theme inheritance.** Each theme is a complete unit. (Generator tooling can address the boilerplate concern separately.)
- **Renderer signature change: `renderSVG(..., theme)`.** No globals, no module-level constants surviving. Future WebGPU back-ends consume the same `Theme` interface.
- **Layout is sacred.** A theme can never change `(row, col)`, size, anchor, routing, shape, exit/entry, slot-order, or any DESIGN-PHASE4.md §11 brace-attr. The override property set (§1.5) is the bright line.

## 8. Implementation order

A suggested cut order. Each step ends with passing tests and a regenerated example set.

1. **Theme types + validator.** Define the `Theme` TypeScript interface, write `loadTheme(name | path) → Theme | ThemeError`. Tests cover all `E_THEME_*` paths.
2. **Built-in catalogue.** Write the four JSON files under `themes/`. Each is a fully-specified theme; no inheritance shortcuts. Snapshot-test the loaded objects.
3. **Renderer refactor.** Add `theme: Theme` parameter to `renderSVG`; replace every hardcoded constant per §5.1 mapping. No new functionality yet — existing tests still pass byte-for-byte with `document-light` (modulo the `#ffffff` → `#fafafa` softening).
4. **`theme:` directive.** Lexer/parser/AST/binder additions for the top-level directive. Default to `document-light` when absent.
5. **CLI flag.** `--theme=NAME` override. CLI resolves built-in or file, parses, validates, passes to renderer.
6. **Tags grammar.** `{ tags: [name, name] }` brace-attr on nodes and edges. Parser/AST/binder, with `E_UNKNOWN_TAG` resolved against the active theme.
7. **Tag-rule application.** Renderer applies per-node and per-edge overrides from §5.2. Tests cover composition order, literal/token mix, all property types.
8. **Arrow toggle.** Wire `theme.strokes.arrow.head-shape` to marker-defn emission. Schematic themes lose arrowheads; document themes keep them.
9. **Regenerate the 29 examples.** Confirm `document-light` output is visually identical (modulo the surface softening). Hand-eyeball a handful under each of the other three themes for sanity.
10. **Add a `theme:` directive to 2–3 examples.** Demonstrate `schematic-dark` on a circuit-heavy example (e.g. 28 or 29) and `document-dark` on a simpler one (e.g. 01 or 04).

After step 10, the user has a real reference for the theme system in action and can decide whether to push deferred items (§6) into a Phase 5.1.
