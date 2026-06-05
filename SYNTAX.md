# melk syntax reference

Complete grammar and semantics for the `.melk` source language. This is
the authoring reference — read it (or feed it to an LLM) before writing
a `.melk` file. For LLM authoring, also see [EXAMPLES.md](EXAMPLES.md).

If you're modifying the parser/bind code, the design docs (`DESIGN.md`,
`DESIGN-PHASE4.md`, `DESIGN-PHASE5-*.md`) are the source of truth.

---

## Quick mental model

A `.melk` file declares:

1. **Top-level directives** — page-level settings (layout, theme,
   title, legend, imports, icon packs).
2. **Nodes** — boxes/shapes with optional attributes.
3. **Edges** — directed connections between nodes.
4. **Composition primitives** — `pipeline`, `branch`, `fan-out`, `bus`,
   `intersect`, `back` block. These both *create edges* and *constrain
   placement*.
5. **Annotation primitives** — `nodeset`, `path`, `edgeset`. These add
   visual highlights without creating edges or placement.

Layout is deterministic: every box snaps to a uniform 8-px-pitch grid
("global grid snapping"); positions are decided from declaration order
and composition primitives. There is no random jitter.

Themes (separate JSON files) supply all visual style — colours,
typography, strokes, tag rules, module-frame chrome. The same `.melk`
re-skins by swapping themes.

---

## 1. Lexical

### 1.1 Comments

Single-line, start with `#`:

```melk
# this is a comment
node_a { label: "A" }  # trailing comments allowed
```

No block comments.

### 1.2 Strings

Double-quoted. Backslash-escapes for `\"`, `\\`, `\n`. Single-line in
directives like `title:` — multi-line literals raise
`E_TITLE_MULTILINE`. Newlines inside `label:` are allowed.

### 1.3 Identifiers

Letters, digits, `_`, `-`. Must start with a letter or `_`. Examples:
`my_node`, `ingest-a`, `Worker3`. Case-sensitive.

### 1.4 Numbers

Non-negative integers in most positions. Floating-point allowed where
the value is a measurement (`border-width: 1.5`).

### 1.5 Cell dimensions

`WxH` form. `2x1` means 2 columns wide, 1 row tall. Both sides are
positive integers. Used as the value of `size:`.

### 1.6 Reserved words

These identifiers cannot be node IDs because they introduce
directives or primitives:

```
back        bus        branch     caption    crossings
fan-out     icons      import     intersect  layout
legend      legend-position
nodeset     path       pipeline   subtitle   theme       title
```

Deprecated reserved words (still rejected with a hint):
`tag`, `lane`, `group`.

Context-sensitive (special only in specific positions): `as`, `from`,
`left`, `right`.

---

## 2. Top-level directives

Each directive appears at most once per file (later occurrences
override earlier ones — "last wins"). Order is otherwise free.

### 2.1 `layout: <mode>`

`mode` is `lr` (left-to-right) or `tb` (top-to-bottom). Default: `tb`.

```melk
layout: lr
```

The layout mode is "isometric": swapping `lr` ↔ `tb` rotates the entire
diagram with no other edits required.

### 2.2 `crossings: <n>`

Integer ≥ 0. Caps the number of edge crossings the router will accept.
Default is unlimited. Useful for hand-tuned diagrams where you want
the compiler to fail-loudly if a re-layout introduces tangles.

### 2.3 `theme: <name-or-path>`

`<name-or-path>` is one of:

- A bare identifier matching a built-in theme name:
  `document-light`, `document-dark`, `schematic-light`, `schematic-dark`.
- A quoted string with a relative or absolute path to a `.json` theme
  file.

Default: `document-light`.

```melk
theme: document-dark
theme: "./themes/our-brand.json"
```

CLI flag `--theme=...` overrides this directive.

### 2.4 `title:` / `subtitle:` / `caption:`

Display-text directives. Each takes a single-line non-empty quoted
string and is rendered in its own strip by the theme.

```melk
title:    "Payment platform"
subtitle: "Q4 2025 architecture review"
caption:  "Source: platform-team/architecture@2026-06-04"
```

Empty string (`title: ""`) raises `E_TITLE_EMPTY`. Newlines raise
`E_TITLE_MULTILINE`. CLI flags `--title=`, `--subtitle=`, `--caption=`
override; empty CLI value disables the field.

### 2.5 `legend: on | off`

Binary. `on` enables the theme-driven legend strip; any other value
disables. Captions come from each used tag's `legend:` field in the
theme.

```melk
legend: on
```

### 2.6 `legend-position: bottom | right | top | left`

Where the legend strip sits relative to the canvas. Strict-validated:
exactly one of the four values. Requires `legend: on` (else
`E_LEGEND_POSITION_WITHOUT_LEGEND`). Default: `bottom`.

### 2.7 `icons: <alias> from "<source>"`

Registers an icon pack so nodes can reference its icons.

- `alias`: bare identifier used in `icon:` and `shape: icon(alias/name)`.
- `<source>`: quoted string with either a local directory path or
  an `https://` URL. `http://` is rejected (`E_ICON_PACK_INSECURE`).

```melk
icons: aws  from "./icons/aws/"
icons: arch from "https://cdn.example.com/icons/architecture/"
```

Duplicate aliases: `E_ICON_PACK_DUPLICATE_ALIAS`.

### 2.8 `import "<path>" as <alias> [ { overrides } ]`

Composes another `.melk` file as an opaque module on this canvas.

- `<path>`: quoted string, relative to the importing file's directory.
  Only file paths supported at v1 — `https://` raises
  `E_MODULE_URL_UNSUPPORTED`.
- `<alias>`: bare identifier. Used to reference internal nodes via
  `alias.internal_name`. Must not collide with any local node id
  (`E_MODULE_ALIAS_COLLIDES_WITH_NODE`).
- `{ overrides }`: optional block. Allowed keys (each takes the same
  value form as the matching top-level directive):
  - `theme:`, `layout:`, `legend:`, `title:`, `subtitle:`, `caption:`.
  Unknown override keys raise `E_MODULE_OVERRIDE_UNKNOWN`.

```melk
import "./modules/payments.melk"   as payments
import "./modules/observability.melk" as obs { theme: "./themes/obs-teal.json" }
```

The imported module's own `title:`, `legend:`, `subtitle:`, `caption:`
directives are silently stripped at bind time — only the parent's
chrome surfaces.

Cycle detection compares resolved absolute paths
(`E_MODULE_CYCLE`). Diamond imports (two paths to the same file)
load it twice as independent instances.

---

## 3. Nodes

### 3.1 Declaration

```
<id> { <attr>: <value>, <attr>: <value>, ... }
```

The brace block is optional — `my_node` is a complete declaration.
Trailing commas are accepted. The block accepts these attributes
(each described below):

```
shape    size       label       tags
icon     icon-position           border
orient   render     slot-order
```

```melk
ingest      { shape: rect, size: 2x1, label: "Ingest tier" }
publish     { shape: roundrect, label: "Publish" }
cache       { shape: cylinder, size: 1x2 }
core        { shape: circle, icon: aws/lambda }
hot_path    { tags: [hot, critical] }
```

A node referenced from an edge or composition primitive but never
explicitly declared is **auto-declared as `1x1` `rect`** at bind time.
That's a feature, not a warning — you can sketch the topology first
and add attributes later.

### 3.2 `shape:`

One of:

| value       | meaning                                                 |
|-------------|---------------------------------------------------------|
| `rect`      | rectangle, 2-px corner radius. Default.                 |
| `roundrect` | rectangle, 8-px corner radius.                          |
| `circle`    | circle; label renders below (BPMN convention).          |
| `diamond`   | diamond/rhombus.                                        |
| `cylinder`  | cylinder (datastore).                                   |
| `highway`   | invisible routing channel; reserves cells, no visible mark. |
| `module`    | synthetic marker for an imported module — set automatically by the `import` directive. Don't write this by hand. |
| `icon(<alias>/<name>)` | icon as the node body. Requires the named icon pack to be registered. |

### 3.3 `size:`

`WxH` cell dimensions. Examples: `1x1`, `2x1`, `3x2`. Phase 4 dropped
T-shirt sizes — writing `size: S` raises `E_DEPRECATED_TSHIRT_SIZE`.

Default: `1x1`.

### 3.4 `label:`

Quoted display string. Multi-line allowed inside the literal. If
absent, the renderer falls back to the node id.

### 3.5 `tags:`

A single bare identifier, or a bracketed list:

```melk
node_a { tags: future }
node_b { tags: [critical, hot] }
```

Each tag name must exist in the resolved theme's `tags:` block, or the
renderer fails with `E_UNKNOWN_TAG`. Tag rules drive border colour,
fill, label colour, dash, opacity, and legend caption — see §6.6.

### 3.6 `icon:` and `icon-position:`

Badge form — the node still draws its base shape, with a small icon
overlaid.

```melk
auth { shape: rect, icon: aws/cognito }
auth { shape: rect, icon: aws/cognito, icon-position: corner }
```

- `icon:` value is `alias/name`. The alias must come from a registered
  icon pack.
- `icon-position:` is `inline` (default — icon left of label) or
  `corner` (top-right of node).

Mutually exclusive with `shape: icon(...)`. Combining them raises
`E_ICON_SHAPE_WITH_ICON_ATTR`.

### 3.7 `border:`

Boolean, `true` or `false`. Only honoured on `shape: icon` and
`shape: circle`. Forces the outer border on or off, overriding the
theme's `icon-border` strokes setting.

### 3.8 `orient:` and `render:`

Highway-only attributes. `orient:` is `horizontal` or `vertical` (axis
override; default inferred from incoming edges). `render:` is `surface`
or `underground` (underground highways draw with a faded dashed outline
behind everything else; default `surface`).

Either attribute on a non-highway node raises
`E_HIGHWAY_ATTR_ON_NON_HIGHWAY`.

### 3.9 `slot-order:`

Only legal value: `declaration`. When set, the node's outgoing edges
use slot order matching their declaration order in the source instead
of the layout-derived spatial order. Lets you hand-tune fan-out
ordering when the geometry-derived default isn't what you want.

---

## 4. Edges

### 4.1 Forward edges

```
<source> -> <target> { <attr>: <value>, ... }
```

The brace block is optional. Both endpoints are *node references* (see
§4.4).

```melk
ingest -> transform
transform -> publish { label: "etl complete" }
gateway:auth -> backend { tags: [critical] }
```

### 4.2 Back edges

Two forms — both produce edges flagged `isBackEdge: true`, routed
through a rear-facing corridor lane.

Inline:

```melk
publish >- ingest    # right-arrow flipped: B from A
```

Block form (groups multiple back edges):

```melk
back: {
  publish -> ingest
  archive -> ingest
}

# Single-line variant for one edge:
back: publish -> ingest
```

### 4.3 Edge attributes

| key      | value form                              | notes                                                                                                |
|----------|-----------------------------------------|------------------------------------------------------------------------------------------------------|
| `label`  | quoted string                           | Edge label, drawn near the midpoint with a small text halo.                                          |
| `tags`   | identifier or `[a, b, ...]`             | Theme tag list (same semantics as node tags). For edges, `trace`/`trace-width`/`dash`/`opacity` apply. |
| `via`    | highway-node identifier (single)        | Route through this highway. Multi-highway `via: [a, b]` is not supported (`E_VIA_MULTI_NOT_SUPPORTED`). |
| `pivot`  | `source` or `target`                    | Z-route pivot side override. Rejected on structural edges (those produced by primitives).            |
| `exit`   | `N`, `E`, `S`, `W`                      | Force the source face. Rejected on back-edges and via-edges.                                         |
| `entry`  | `N`, `E`, `S`, `W`                      | Force the target face. Same restrictions.                                                            |
| `avoid`  | name or edge ref or `[a, b -> c, ...]`  | Routing must avoid these obstacles. Members can be node ids, primitive names, edgeset names, or `a -> b` edge refs. |

### 4.4 Node references

A node reference appears as an edge endpoint or as a member of a
composition primitive. Forms:

```
nodename                 # plain
module.nodename          # module-qualified (modules-only context)
nodename:portname        # port-qualified (rare; reserved for future per-port docking)
module.nodename:portname # both
```

Module-qualified refs are **only allowed as edge endpoints**, not in
`pipeline`, `bus`, `fan-out`, `branch`, or any primitive member list.
The latter would require resolving across the module boundary at
layout time, which is deferred.

---

## 5. Composition primitives

Each primitive creates one or more edges *and* constrains placement.
A `pipeline` doesn't just say "connect these" — it says "place these
on consecutive cells along the flow axis." That's why primitives are
the main lever for laying out a coherent diagram: most boxes shouldn't
need explicit positioning.

Every primitive takes a *name* (used in error messages and as the
edge source attribution). Duplicate names within a category raise the
matching `E_DUPLICATE_*` error.

### 5.1 `pipeline`

```
pipeline <name>: a -> b -> c [-> d, ...]
```

2 or more members. Edges run member-to-member along the flow axis,
all on the same row.

```melk
pipeline ingest_flow: ingress -> parse -> validate -> publish
```

### 5.2 `bus`

```
bus <name>: [a, b, c, ...] -> shared
```

Multiple producers all feed one consumer. Producers stack on
consecutive rows in one column; `shared` sits one column further along
the flow, at the median row.

```melk
bus join_results: [worker_a, worker_b, worker_c] -> aggregator
```

### 5.3 `fan-out`

Mirror of `bus`:

```
fan-out <name>: shared -> [a, b, c, ...]
```

```melk
fan-out dispatch: scheduler -> [worker_a, worker_b, worker_c]
```

### 5.4 `branch`

```
branch <name>: spine -> member
branch <name>:<side>: spine -> member    # side = left | right
```

Single member only — `branch` is a *direction change*, not a fan-out.
The member places perpendicular to the parent flow. `:right` (CW from
parent forward) is the natural side for an off-spine annotation;
`:left` (CCW, default) puts it the other way.

```melk
branch audit-out:        validate -> audit       # default left
branch error-out:right:  validate -> dead_letter
```

To put more than one member off the spine, root a `pipeline` or
`fan-out` on the branched node.

### 5.5 `intersect`

```
intersect hwy_a, hwy_b [, hwy_c, ...]
```

Pre-places multiple highways at a shared cell so their traces actually
cross. Members must be `shape: highway` nodes and must have at least
two distinct orientations (else `E_INTERSECT_SAME_ORIENTATION`).

```melk
control_bus { shape: highway, orient: horizontal }
data_bus    { shape: highway, orient: vertical }
intersect control_bus, data_bus
```

### 5.6 `back:` block

See §4.2. Counts as a primitive for naming purposes (source
attribution `back-block`).

---

## 6. Annotation primitives

These add overlays but do not affect routing or placement.

### 6.1 `nodeset`

Draws a dashed bounding rectangle around 1+ named nodes.

```
nodeset <name>: a, b, c [, ...]
```

```melk
nodeset core_services: auth, billing, profile
```

### 6.2 `path`

Highlights a chain of edges with a coloured emphasis stroke.

```
path <name>: a -> b -> c [-> d, ...]
```

Every consecutive pair must match a declared edge (in either
direction) or `E_PATH_MISSING_EDGE`.

```melk
path checkout_flow: cart -> payment -> ledger -> receipt
```

Colour cycles through the theme's `tokens.accents` array per
declared path.

### 6.3 `edgeset`

Names a set of edges so they can be referenced (e.g. in `avoid:`).

```
edgeset <name>: a -> b, c -> d [, ...]
```

```melk
edgeset hot_paths: ingest -> aggregator, parse -> validate
later_edge -> sink { avoid: hot_paths }
```

---

## 7. Themes

Themes are JSON files. The schema below is enforced strictly —
unknown keys raise `E_THEME_BAD_*` errors. See
[examples/themes/](examples/themes/) for working samples.

### 7.1 Top-level fields

| field        | type                       | required |
|--------------|----------------------------|----------|
| `name`       | string                     | yes      |
| `tokens`     | object (§7.2)              | yes      |
| `typography` | object (§7.3)              | yes      |
| `strokes`    | object (§7.4)              | yes      |
| `tags`       | `{ tagName: TagRule }`     | yes (may be `{}`) |
| `modules`    | object (§7.6)              | no       |

### 7.2 `tokens`

Colour tokens — semantic names other parts of the theme can refer to.

Required string fields (hex `#rrggbb` or `#rgb`):
- `surface`, `surface-raised`, `surface-sunken`
- `ink-primary`, `ink-secondary`
- `border-strong`, `border-subtle`
- `trace-default`, `trace-emphasis`, `trace-muted`
- `status-error`, `status-warn`, `status-ok`, `status-info`
- `label-halo`

Required array field:
- `accents` — 3-9 hex colours (path-highlight palette;
  cycles per declared `path`).

### 7.3 `typography`

| field         | type                                                                                           |
|---------------|------------------------------------------------------------------------------------------------|
| `face`        | string (CSS font stack)                                                                        |
| `face-mono`   | string                                                                                         |
| `size`        | `{ body, edge, frame, title, subtitle, caption }` — all numbers ≥ 0                            |
| `weight`      | `{ label, heading, title, subtitle }` — integers 100-900                                       |

### 7.4 `strokes`

| field                  | type                                                                            |
|------------------------|---------------------------------------------------------------------------------|
| `outline`              | number ≥ 0 (node border width)                                                  |
| `trace`                | number ≥ 0 (edge stroke width)                                                  |
| `emphasis`             | number ≥ 0 (path-highlight width)                                               |
| `frame`                | number ≥ 0 (nodeset border width)                                               |
| `underground-opacity`  | number 0-1                                                                      |
| `underground-width`    | number ≥ 0                                                                      |
| `manhole-radius`       | number ≥ 0 (via-hole radius)                                                    |
| `dash`                 | `{ frame: number[], back-edge: number[] }` — each entry ≥ 0                     |
| `arrow`                | `{ scale: number, head-shape: "filled-triangle" | "none" }`                     |
| `icon-style?`          | `"filled"` (default) or `"outlined"`                                            |
| `icon-border?`         | `"on"` or `"off"` (default `"off"`)                                             |

### 7.5 `tags` and tag properties

A tag is a named override rule keyed by name (e.g. `critical`, `hot`,
`future`). Each rule is an object with any subset of these properties:

| key            | value form                                            | applies to                |
|----------------|-------------------------------------------------------|---------------------------|
| `fill`         | token name, hex, or gradient string                   | node only                 |
| `border`       | token name, hex, or gradient string                   | node only                 |
| `border-width` | number ≥ 0                                            | node only                 |
| `text`         | token name or hex                                     | node only                 |
| `text-weight`  | integer 100-900                                       | node only                 |
| `trace`        | token name or hex                                     | edge only                 |
| `trace-width`  | number ≥ 0                                            | edge only                 |
| `dash`         | `null` (solid) or `number[]`                          | both                      |
| `opacity`      | number 0-1                                            | both                      |
| `icon-color`   | token name, hex, or gradient string                   | node icon only            |
| `legend`       | single-line string (caption shown in legend strip)    | enables tag in legend     |
| `swatch`       | `"box"` or `"line"`                                   | explicit legend swatch shape |

Unknown tag properties raise `E_UNKNOWN_TAG_PROPERTY` at theme-load
time.

Gradient strings (for `fill`, `border`, `icon-color`) have the form:

```
linear 90deg, #fee2e2, #fff5f5
linear 135deg, #0d9488, #06b6d4, #818cf8
```

Angle is degrees; 2 or more stops; each stop is a hex colour.

### 7.6 `modules` (optional)

Visual chrome for the frame drawn around each imported module. All
fields optional; if `modules` block is absent or has no `border`,
no frame is drawn.

| key              | value form                                                 |
|------------------|------------------------------------------------------------|
| `border`         | token name or hex (frame stroke colour)                    |
| `border-width`   | number ≥ 0 (default 1.0)                                   |
| `dash`           | `null` (solid) or `number[]`                               |
| `padding`        | number ≥ 0 (inside-frame padding in pixels)                |
| `label-position` | `"top-left"`, `"top-center"`, `"top-right"`, or `null`     |
| `label-weight`   | integer 100-900                                            |

### 7.7 Built-in tags

Every built-in theme (`document-light`, `document-dark`,
`schematic-light`, `schematic-dark`) ships these three:

| tag         | shape       | legend caption       |
|-------------|-------------|----------------------|
| `future`    | node border | "Future state"       |
| `critical`  | node border | "Critical path"      |
| `deprecated`| edge trace  | "Deprecated route"   |

User themes can extend, override, or replace these. A custom theme's
`tags: {}` block *replaces* the built-in set — it doesn't merge.

---

## 8. Imported modules

Recap of authoring rules (full design in
[DESIGN-PHASE5-MODULES.md](DESIGN-PHASE5-MODULES.md)):

- An imported module is a complete `.melk` file. It uses its own theme
  and layout unless overridden.
- Internal nodes are reachable from the parent as `alias.internal_name`,
  but **only as edge endpoints** — not in primitive members.
- Parent-level edges between two modules (no qualified ref) attach to
  each module's *closest* internal node on the facing side (the
  `facePorts[side][0]` candidate). With multiple parent edges on the
  same face, they spread across distinct internal nodes.
- Bodies are auto-shifted along the cross-flow axis so face-to-face
  flow-axis ports line up. The user doesn't ask for this; it just
  happens. Result: chains of imported modules render as a straight
  spine.

---

## 9. CLI

```
melk parse  <file.melk>                              # print AST as JSON
melk bind   <file.melk>                              # print bound Model as JSON
melk render <file.melk> [options]                    # render to SVG
```

Render options:

| flag                       | effect                                                                                                |
|----------------------------|-------------------------------------------------------------------------------------------------------|
| `-o <path>`                | Write SVG to file (default: stdout).                                                                  |
| `--theme=<NAME>`           | Override the in-source `theme:`. Accepts a built-in name or a file path.                              |
| `--legend=<VALUE>`         | `on`, `off`, or a position (`bottom`/`right`/`top`/`left`).                                           |
| `--title=<STR>`            | Override in-source title. Empty string disables the field.                                            |
| `--subtitle=<STR>`         | Same for subtitle.                                                                                    |
| `--caption=<STR>`          | Same for caption.                                                                                     |
| `--no-network`             | URL-loaded icon packs become cache-only (no network requests).                                        |

CLI flags take precedence over in-source directives.

---

## 10. Error catalogue

Every error melk raises is structured. The format is
`E_<UPPER_SNAKE>: <human description>`. An LLM author should treat
errors as ground truth and re-emit with the suggested fix in mind.

### 10.1 Parsing

| code                          | when                                                                |
|-------------------------------|---------------------------------------------------------------------|
| `E_MODULE_PATH_EMPTY`         | `import ""` with empty path                                         |
| `E_TITLE_EMPTY`               | `title:`/`subtitle:`/`caption:` with empty string                   |
| `E_TITLE_MULTILINE`           | A title/subtitle/caption value contains a newline                   |
| `E_LEGEND_BAD_POSITION`       | `legend-position:` not one of bottom/right/top/left                 |
| `E_ICON_BAD_REF`              | An `icon:`/`shape: icon(...)` value isn't `alias/name`              |
| `E_DEPRECATED_LANE`           | The Phase 3 `lane:` keyword is no longer accepted                   |
| `E_DEPRECATED_GROUP`          | The Phase 3 `group:` keyword is no longer accepted                  |
| `E_DEPRECATED_TAG`            | The Phase 3 `tag:` keyword is now split into `nodeset:` + `path:`   |
| `E_DEPRECATED_TSHIRT_SIZE`    | Phase 3 sizes (`S`/`M`/`L`/`XL`) — use `WxH`                        |

### 10.2 Binding (semantics)

| code                                    | when                                                                                       |
|-----------------------------------------|--------------------------------------------------------------------------------------------|
| `E_DUPLICATE_PIPELINE/BUS/FAN_OUT/BRANCH/NODESET/PATH/EDGESET` | Same name reused within a category                              |
| `E_NAME_CONFLICT`                       | A name shadows another declaration                                                         |
| `E_NODESET_UNKNOWN_NODE`                | A nodeset member isn't a declared node                                                     |
| `E_PATH_MISSING_EDGE`                   | A path link doesn't correspond to a declared edge                                          |
| `E_EDGESET_UNKNOWN_EDGE`                | An edgeset member edge doesn't exist                                                       |
| `E_INTERSECT_UNKNOWN_HIGHWAY` / `_NOT_HIGHWAY` / `_DUPLICATE` / `_SAME_ORIENTATION` | `intersect` member problems                              |
| `E_AVOID_UNKNOWN_NODE` / `_UNKNOWN_REF` / `_UNROUTABLE` | `avoid:` references something that doesn't exist or makes routing impossible |
| `E_VIA_UNKNOWN_HIGHWAY` / `_NOT_HIGHWAY` / `_MULTI_NOT_SUPPORTED` / `_FIRST_HALF` | `via:` problems                                            |
| `E_HIGHWAY_AS_ENDPOINT`                 | A highway is used as an edge source/target (use `via:`)                                    |
| `E_HIGHWAY_ATTR_ON_NON_HIGHWAY`         | `orient:` or `render:` on a non-highway                                                    |
| `E_EXIT_INVALID_VALUE` / `_ON_BACK_EDGE` / `_ON_VIA_EDGE` | `exit:` or `entry:` value/context invalid                                   |
| `E_PIVOT_ON_STRUCTURAL_EDGE`            | `pivot:` on an edge created by a primitive                                                 |
| `E_INVALID_ICON_POSITION`               | `icon-position:` not `inline` or `corner`                                                  |
| `E_INVALID_BORDER_VALUE`                | `border:` not `true` or `false`                                                            |
| `E_INVALID_ORIENT_VALUE`                | `orient:` not `horizontal` or `vertical`                                                   |
| `E_INVALID_RENDER_VALUE`                | `render:` not `surface` or `underground`                                                   |
| `E_INVALID_SLOT_ORDER_VALUE`            | `slot-order:` not `declaration`                                                            |
| `E_ICON_PACK_INSECURE`                  | `icons: ... from "http://..."` — use `https://` or a local path                            |
| `E_ICON_PACK_DUPLICATE_ALIAS`           | Same `icons: <alias>` registered twice                                                     |
| `E_ICON_PACK_UNKNOWN`                   | A node references an icon-pack alias that wasn't registered                                |
| `E_ICON_SHAPE_WITH_ICON_ATTR`           | A node has both `shape: icon(...)` and `icon:`                                             |
| `E_ICON_POSITION_WITHOUT_ICON`          | `icon-position:` set but neither `icon:` nor `shape: icon(...)` is                         |
| `E_LEGEND_POSITION_WITHOUT_LEGEND`      | `legend-position:` set but `legend:` is off                                                |

### 10.3 Module imports

| code                                  | when                                                              |
|---------------------------------------|-------------------------------------------------------------------|
| `E_MODULE_FILE_NOT_FOUND`             | Import path doesn't resolve                                       |
| `E_MODULE_ALIAS_DUPLICATE`            | Same `as <alias>` used twice                                      |
| `E_MODULE_ALIAS_UNKNOWN`              | A qualified ref uses an unknown alias                             |
| `E_MODULE_NODE_UNKNOWN`               | A qualified ref names a node the module doesn't declare           |
| `E_MODULE_ALIAS_COLLIDES_WITH_NODE`   | Alias matches a local node id                                     |
| `E_MODULE_OVERRIDE_UNKNOWN`           | Unknown override key in `{ ... }`                                 |
| `E_MODULE_OVERRIDE_BAD_VALUE`         | Override value type is wrong                                      |
| `E_MODULE_CYCLE`                      | Circular imports                                                  |
| `E_MODULE_URL_UNSUPPORTED`            | `import "https://..."` (v1: local paths only)                     |
| `E_MODULE_PATH_EMPTY`                 | Empty `import ""`                                                 |

### 10.4 Theme loading

| code                              | when                                                                |
|-----------------------------------|---------------------------------------------------------------------|
| `E_THEME_LOAD_FAILED`             | File read or JSON parse error                                       |
| `E_THEME_MISSING_FIELD`           | Required theme field missing                                        |
| `E_THEME_UNKNOWN_TOKEN`           | Reference to a token that doesn't exist                             |
| `E_THEME_BAD_COLOUR`              | Value isn't hex or a known token                                    |
| `E_THEME_BAD_ACCENTS_LENGTH`      | `accents` array isn't 3–9 elements                                  |
| `E_THEME_BAD_NUMBER`              | Number out of range / wrong type                                    |
| `E_THEME_BAD_VALUE`               | Other shape-mismatch                                                |
| `E_THEME_BAD_MODULES`             | `modules:` block validation                                         |
| `E_THEME_UNKNOWN_MODULES_KEY`     | Unknown field in `modules:` block                                   |
| `E_THEME_BAD_GRADIENT`            | Gradient string format invalid                                      |
| `E_UNKNOWN_TAG_PROPERTY`          | Tag rule uses an unknown property name                              |

### 10.5 Render time

| code                              | when                                                                |
|-----------------------------------|---------------------------------------------------------------------|
| `E_UNKNOWN_TAG`                   | A node/edge tag has no rule in the resolved theme                   |
| `E_LEGEND_TAG_HAS_NO_CAPTION`     | A used tag's rule lacks a `legend:` field                           |
| `E_LEGEND_NO_TAGS_USED`           | `legend: on` but no tags appear in the diagram                      |

### 10.6 Layout / routing

| code                              | when                                                                |
|-----------------------------------|---------------------------------------------------------------------|
| `E_ANCHOR_CONFLICT`               | A node anchored to two different cells by different primitives      |
| `E_AMBIGUOUS_PLACEMENT`           | Source doesn't determine a unique placement                         |
| `E_SIDE_OVERSUBSCRIBED`           | Too many edges demand the same node face                            |
| `E_CROSSINGS_OVER_BUDGET`         | Edge crossings exceed the `crossings:` cap                          |
| `E_AVOID_UNROUTABLE`              | `avoid:` constraint blocks every viable route                       |

Warnings (don't fail the build):

| code                              | when                                                                |
|-----------------------------------|---------------------------------------------------------------------|
| `W_ICON_NOT_FOUND`                | Local icon file missing                                             |
| `W_ICON_NOT_CACHED`               | URL icon not cached, `--no-network` set                             |
| `W_ICON_PARSE_FAILED`             | Icon SVG won't parse                                                |
| `W_ICON_CACHE_WRITE_FAILED`       | Couldn't write icon cache (disk full, perms)                        |

---

## 11. Conventions for LLM authoring

This section is advice, not enforcement, for an LLM emitting `.melk`.

1. **Sketch topology with primitives first.** A `pipeline` line both
   names the chain and decides the placement. Pages of one-edge-per-line
   declarations are a code smell for diagram-DSLs — write the pipeline,
   then refine with node attributes.

2. **Let nodes auto-declare.** You don't need to declare every node
   before using it in a pipeline. Add `{ shape: ..., label: ... }`
   only where you want non-default attributes.

3. **Use `branch` for direction changes only.** It's deliberately
   single-member. If you have 3 things hanging off the spine in the
   same direction, root a `fan-out` on the branched node.

4. **Themes don't add layout; they re-skin.** Don't try to use tags or
   themes to move things — that's the placer's job (via primitives).

5. **Modules collapse complexity.** When a sub-diagram is its own
   thing (e.g. "the payments plane"), put it in its own `.melk` and
   `import` it. The parent file then only talks about the spine.

6. **Names are messages.** Every primitive is named (`pipeline
   ingest_flow: ...`). The name shows up in error messages and in
   diff context. Use snake_case and be specific.

7. **When in doubt, look at examples.** See [EXAMPLES.md](EXAMPLES.md)
   for the 35 worked examples indexed by feature.
