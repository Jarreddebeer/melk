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
bus         branch     caption    crossings
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

`mode` is `lr` (left-to-right) or `tb` (top-to-bottom). Default: `lr`.

```melk
layout: lr
```

The layout mode is "isometric": swapping `lr` ↔ `tb` rotates the entire
diagram with no other edits required.

### 2.2 `crossings: <n>`

Integer ≥ 0. Caps the number of edge crossings the router will accept.
**Default is `0`** — the router rejects *any* crossing unless you opt in.
A topology whose edges must cross (most non-planar diagrams: meshes,
all-to-all fan-ins, ≥20-node graphs) fails routing with
`E_CROSSINGS_OVER_BUDGET` until you raise the budget. The error message
names the exact number required, e.g. `crossings: 8`. Set it generously
(`crossings: 10`) and let the compiler still fail-loudly only if a
re-layout introduces *more* tangles than you allowed.

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
orient   render     slot-order   offset
```

```melk
ingest      { shape: rect, size: 4x2, label: "Ingest tier" }
publish     { shape: rect, label: "Publish" }
cache       { shape: cylinder, size: 2x4 }
core        { shape: circle, icon: aws/lambda }
hot_path    { tags: [hot, critical] }
```

A node referenced from an edge or composition primitive but never
explicitly declared is **auto-declared as `5x5` `rect`** at bind time.
That's a feature, not a warning — you can sketch the topology first
and add attributes later. (Note: §3.2 — default to `rect`. The `roundrect`
shape is a stylistic alternative; mixing them on one diagram reads as
inconsistency unless explained in a legend.)

### 3.2 `shape:`

One of:

| value       | meaning                                                 |
|-------------|---------------------------------------------------------|
| `rect`      | rectangle, 2-px corner radius. Default.                 |
| `roundrect` | rectangle, 8-px corner radius. Stylistic alternative to `rect`. |
| `circle`    | circle; label renders below (BPMN convention).          |
| `diamond`   | diamond/rhombus.                                        |
| `cylinder`  | cylinder (datastore).                                   |
| `highway`   | invisible routing channel; reserves cells, no visible mark. |
| `module`    | synthetic marker for an imported module — set automatically by the `import` directive. Don't write this by hand. |
| `icon(<alias>/<name>)` | icon as the node body. Requires the named icon pack to be registered. |

**Choosing between `rect` and `roundrect`.** Default to `rect`.
The two shapes look very similar by design — corner radius is too
subtle to carry meaning a reader will reliably pick up. Pick one
per diagram. If you genuinely want both, do it deliberately:
attach a tag to the rounded ones and define what the tag means in
a legend entry. Mixing them without that scaffolding reads as
inconsistency, not intent.

### 3.3 `size:`

`WxH` cell dimensions, in 8-px cell units. Examples: `5x5` (40×40 px,
the default), `5x9`, `7x3`. Phase 4 dropped T-shirt sizes — writing
`size: S` raises `E_DEPRECATED_TSHIRT_SIZE`.

Default: `5x5` (40×40 px). This default holds 5 trace slots per face
(face length 5 cell-units × `TRACES_PER_CELL_UNIT` = 1 trace per cell-
unit at default pitch). Hubs with 6+ peers on one face need explicit
sizing — see EXAMPLES.md §5 `E_SIDE_OVERSUBSCRIBED` for recipes.

**Cell pitch equals slot pitch** (8 px). Moving a node from row r to
row r+1 shifts it by exactly one slot position, so slots on adjacent
boxes line up by construction. **Cells are slots.**

**Odd dimensions matter** for boxes that act as hubs. A face of length
L with F traces clustered on it produces slot positions at cell centres
only when `L ≡ F (mod 2)`. Otherwise slots fall on cell boundaries
(half-cell offsets) and the downstream node's centred slot can't align
— producing a 4-px chamfer kink. The bind pass auto-bumps highway and
hub-rect dimensions by 1 to enforce matched parity; explicit sizes
declared on hubs may grow by 1 cell on the breadth axis for the same
reason. Plain non-hub nodes are usually best as `5x5` (default).

**Multi-cell occupancy.** A `size: 5x9` node occupies a 5×9 grid
block, not a 1×1 cell with inflated row/col units. Two nodes whose
footprints overlap collide with `E_AMBIGUOUS_PLACEMENT`. Every
`rowUnits[r]` / `colUnits[c]` is always 1 — node extents are
expressed by footprint span, not by per-row inflation.

**Declared size is authoritative.** The placer takes `size:` at face
value; nothing grows a node to fit its label. If a label is longer
than the box, the text overflows the box edge visually. Size the box
for the label up front using the table below.

#### Picking `size:` from the label

Read the visible label (the literal characters that render — the
node id if no `label:`, otherwise the `label:` value). Count
characters in the LONGEST line. Pick the row from the table; apply
the shape adjustment.

| Longest line | rect / roundrect | cylinder      | diamond | circle |
|--------------|------------------|---------------|---------|--------|
| 1–4 chars    | `5x5`            | `5x5`         | `5x5`   | `5x5`  |
| 5–6 chars    | `7x5`            | `7x5`         | `7x7`   | `7x7`  |
| 7–9 chars    | `9x5`            | `9x7`         | `9x9`   | `9x9`  |
| 10–12 chars  | `11x5`           | `11x7`        | `11x11` | `11x11`|
| 13–15 chars  | `13x5`           | `13x9`        | `13x13` | `13x13`|
| 16–18 chars  | `15x5`           | `15x11`       | `15x15` | `15x15`|

A cylinder looks squashed when its width is much greater than its
height. The cylinder column already enforces `height ≥ ⌈width × 2/3⌉`
— don't override that for a tighter look.

**Per extra line** (`\n` in the label), add 2 cells to the height.
A 2-line rect with each line ≤ 6 chars wants `7x7`; a 3-line
cylinder with the longest line at 9 chars wants `9x11` (height 7
from the cylinder column, +2 per extra line = 7+4 = 11).

**ALL-CAPS / wide-char labels** ("WWW", "DTCC GTR"): bump up one
row. Uppercase glyphs render ~1.4× the width of lowercase.

**Shape rationale.** Cylinders need height ≈ ⅔ × width so the
ellipse caps don't squash; diamonds and circles need width = height
because the inscribed text uses both diagonals.

**Hub parity bump.** A node that's the shared of a `bus` or
`fan-out` (the side every trace converges on) is auto-bumped +1 on
the breadth axis when the trace count parity doesn't match — see
§11 for the rule. Picking sizes from this table already lands on
odd values, so the bump usually leaves the source dimensions
intact.

**Examples.**
- `web1 { label: "web.1" }` — 5 chars → `5x5` (rect default).
- `queue { label: "queue\n(broker)" }` — longest line "(broker)" =
  8 chars → `9x5` baseline, +2 for the extra line → `9x7`.
- `db { shape: cylinder, label: "PostgreSQL\n(primary)" }` —
  longest line "PostgreSQL" = 10 chars (capital P, L) → bump to
  `13x9` (cylinder column, then +2 for the extra line).
- `clearing { shape: diamond, label: "clearing\neligibility?" }` —
  longest line "eligibility?" = 12 chars → `11x11` baseline, +2 for
  the extra line → `11x13`; diamond wants square so bump width to
  match → `13x13`.

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

### 3.10 `offset:`

Per-node nudge in `(col, row)` cells. Quoted-string syntax — the
quotes let you write fractions and negatives without inventing new
token shapes:

```melk
src_b { size: 7x5, offset: "0x0.5"  }   # +0 col, +0.5 row → 4 px down
dst_y { size: 7x5, offset: "0x-0.5" }   # 4 px up
m     { size: 5x5, offset: "1x1.5"  }   # +1 col, +1 row, +4 px down
```

Format: `'WxH'` where each half is `-?\d+(\.\d+)?`. Bare cells syntax
(`offset: 0x1` without quotes) raises a bind error directing you to
quote it.

**Two parts:**

- **Integer part** moves the node a whole number of cells on the grid.
  `offset: "0x2"` shifts the node 2 rows south of where the placer
  would otherwise have put it. The grid stays integer; downstream
  placement math is unaffected.
- **Fractional part** (`0.5`, `-0.5`, `0.25`, etc.) becomes a sub-cell
  pixel shift. The node's slot pixels and rendered box pick up the
  shift; the grid coordinates do not. Use this to align a node's slot
  cluster with a trace bundle whose pixel parity it would otherwise
  miss by 4 px.

**When you need it.** Most cases are auto-handled. Highway via members
(`{ via: hwy }`) get a sub-cell shim automatically when their slot
cluster's pixel parity differs from the highway's — see §3.11's
"Auto via-shim" callout below. Reach for `offset:` when the auto
shim picks wrong, or for non-via cases where a node visually wants
to sit half a cell off its anchored row/col to straighten a trace.

**Caveats.**

- The placer doesn't re-check footprints after the offset applies.
  Two nodes whose cells overlap after offsets collide silently in
  the router — author's responsibility to verify.
- Sub-cell offsets shift only endpoints + the rendered box. The
  channel-routed polyline body stays grid-aligned, so very large
  fractional offsets distort the leg geometry. Designed for ≤ 1-cell
  nudges.
- Manual `offset:` overrides the auto via-shim — the auto pass skips
  any node already carrying a pixel shift.

### 3.11 Placement model — how nodes get cells

This is the mental model every author needs. It's why
`E_AMBIGUOUS_PLACEMENT` exists, why `branch` has a `:side`, and why
"just connect them" sometimes doesn't work.

**What you have to specify, and why.** melk gives the author two
levers that no other input controls: which composition primitive
each group of edges belongs to, and the cell-size of any node that
exceeds default capacity. Both are manual on purpose. Their *why*
is the same: the same `.melk` source must always render the same
diagram. Inferring either lever from edge counts would mean an
unrelated edit elsewhere silently shifts the layout. The rest of
this section spells out the three rules that follow.

**1. The grid.** Layout is a uniform grid of cells indexed by
`(row, col)`. Every node occupies at least one cell (more for nodes
with `size: WxH`). In `layout: lr`, `col` advances along the flow;
in `layout: tb`, `row` does. Bare edges are *unconstrained
placement* — `a -> b` just extends `a`'s row by one column. That's
gap-filling, not intent.

**2. Composition primitives are how you express intent.** Each
primitive both creates edges *and* anchors cells. Picking the right
one is the author's job; the placer won't guess from a wall of
plain edges.

| primitive | what it anchors |
|-----------|-----------------|
| `pipeline a -> b -> c` | all on the same row, consecutive columns |
| `bus [a, b, c] -> sink` | producers stacked in one column; `sink` one column further, at the median row |
| `fan-out src -> [a, b, c]` | targets stacked in one column, one past `src` |
| `branch :side: spine -> m` | `m` placed perpendicular to spine (one cell up for default `:left`, one down for `:right` in LR layout) |
| `intersect h1, h2` | the listed highways meet at one shared cell |

*Why:* primitive choice is the diagram's structural intent, and
intent has to be authored. A `bus` and four bare edges to the same
sink produce visually different layouts — the author has to pick.

**3. Faces have capacity, and you grow nodes manually to fit.**
Each cell-unit of a node's face holds one trace
(`CELL_PX = COMB_PITCH = 8` → `TRACES_PER_CELL_UNIT = 1`). A default
`5x5` node therefore takes 5 edges per face. A hub with 6+ peers on
one face needs explicit growth: in `lr` layout grow the height
(e.g. `size: 5x7`); in `tb` grow the width (e.g. `size: 7x5`). Each
extra cell-unit adds 1 slot. Highways and hub-rects (any rect that's
the shared of a bus or fan-out) auto-size: highway breadth grows to
match via-edge count; hub-rect breadth gets a +1 parity bump when
its face length and trace count disagree on parity (so slots land
on cell centres). The author can still set explicit larger sizes;
the parity bump only fires on top of the declared minimum.

*Why:* a node's cell-size affects the grid (each extra cell-unit
adds one slot pitch). Silent growth on edge-count changes would
mean adding a single peer to a hub silently relays out the whole
diagram. Making the explicit minimum is the author's call; the
parity bump is a small +1 adjustment that prevents kinks without
changing the diagram's structure.

Exceeding face capacity raises `E_SIDE_OVERSUBSCRIBED`; the error
names the failing face and gives the exact size to use.

**4. Multi-cell occupancy.** A `size: 5x9` node occupies a 5×9 grid
block. Two nodes whose footprints overlap collide with
`E_AMBIGUOUS_PLACEMENT` — even if their anchor cells don't match.
This is what makes `size: 5x9` visually "take up 5 cols and 9 rows"
on the rendered diagram (rather than inflating one cell). Every
neighbouring primitive (pipeline, bus, branch, etc.) advances by
the previous node's full forward extent, so a `5x9` node followed
by a `5x5` node sits at col 5, col 10, not col 1, col 2.

---

**Two constraints can collide on the same cell.** This is the
error you'll hit most. Common shapes:

- Two `branch`es to the same side of the same spine node → both
  members land at the same perpendicular cell.
- A `bus` and a `fan-out` both terminating one column past the same
  row → both sinks claim that cell.
- A `branch` member and the next pipeline node both want to occupy
  the column adjacent to the branched node.
- A bare `a -> b` extends `a`'s row, but the next column already
  belongs to a primitive's anchored target.

The placer refuses to guess — it throws `E_AMBIGUOUS_PLACEMENT` and
asks you to be more explicit.

**How to fix a collision.** Six recipes cover ~95% of cases:

1. **Two side-shoots off the same spine node** — change to one
   `fan-out` rooted on the spine node.
2. **Two side-shoots on opposite sides** — use one `:left` and one
   `:right` branch.
3. **A bare edge to a "side-channel" node** — wrap it in
   `branch <name>:right: <spine-node> -> <side-channel>` so the
   placer knows the destination is off-axis.
4. **A shared backing service (DB / cache / queue) reached from
   many producers** — pick *one* anchoring construct (typically a
   `bus`) and let the rest reach it via plain edges. The plain
   edges find the already-placed target and don't try to anchor it
   again.
5. **A node downstream of a primitive that the next pipeline step
   also wants** — drop the bare edge, or split the spine into two
   shorter pipelines and let the shared node sit between them.
6. **Many things off one branch** — root a `pipeline` or `fan-out`
   on the branched node; one chained construct beats N branches.


For copy-pasteable collision recipes, see EXAMPLES.md §3
("Shared backing service", "Side-channel off a spine", etc.)
and §5 (placement errors keyed by the source shape that triggers
each one).

**5. Auto via-shim — when a node's slot cluster falls off the
trace bundle's pixel grid.** A highway via member (`{ via: hwy }`
sources and targets) gets a sub-cell pixel shift applied
automatically when its face's slot cluster is half a cell out of
phase with the highway's. The slot allocator centres each face's
cluster independently; when `(faceLen - traceCount)` parity
differs between member and highway, every paired slot lands 4 px
off-grid. Untreated, that bias renders as a small C-curve kink on
every same-row/same-col trace and as a chamfer at each end of
L-bent traces. The shim is silent and never moves grid cells —
only slot pixels and the rendered box pick up the 4-px nudge. No
authoring action required.

If the heuristic shifts wrong (rare, but possible with members
that fan to multiple highways or have asymmetric trace counts),
override it with an explicit `offset: '0xh'` — manual `offset:`
on a node wins over the auto shim. See §3.10.

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

```melk
publish >- ingest    # back-edge: ingest <- publish
```

The `>-` operator is the flipped `->`. Both endpoints are *node
references* (§4.4). Back-edges route through a rear-facing
corridor lane so they don't tangle with forward flow.

Attributes work the same way as forward edges:

```melk
publish >- ingest { label: "retry", tags: [deprecated] }
```

For grouped return paths, put consecutive `>-` lines together with
a comment header — there is no block form.

### 4.3 Edge attributes

| key      | value form                              | notes                                                                                                |
|----------|-----------------------------------------|------------------------------------------------------------------------------------------------------|
| `label`  | quoted string                           | Edge label, drawn near the midpoint with a small text halo.                                          |
| `tags`   | identifier or `[a, b, ...]`             | Theme tag list (same semantics as node tags). For edges, `trace`/`trace-width`/`dash`/`opacity` apply. |
| `via`    | highway-node identifier (single)        | Route through this highway. Multi-highway `via: [a, b]` is not supported (`E_VIA_MULTI_NOT_SUPPORTED`). |
| `pivot`  | `source` or `target`                    | Z-route pivot side override. Rejected on structural edges (those produced by primitives).            |
| `exit`   | `N`, `E`, `S`, `W`                      | Force the source face. Rejected on back-edges and via-edges. See note on U-routing below.            |
| `entry`  | `N`, `E`, `S`, `W`                      | Force the target face. Same restrictions. See note on U-routing below.                               |
| `avoid`  | name or edge ref or `[a, b -> c, ...]`  | Routing must avoid these obstacles. Members can be node ids, primitive names, edgeset names, or `a -> b` edge refs. |

#### `exit:` / `entry:` and U-routing

The default router picks each face from the edge's forward direction.
Use `exit:` to force the source face and `entry:` to force the target
face — useful when the natural geometry would route the trace through
another box.

When `entry:` points to a face on the **wrong side** of the source
(e.g. `entry: S` on a target whose source sits above it), the router
auto-routes a perimeter U: the trace exits the source perpendicular
to its face, runs along a perimeter row/col past the target's outer
edge, then approaches the target's face perpendicular to it (arrow
points into the face).

```melk
# query is north of orders_rm; we want the trace to enter from the
# south, not cut across the read-models in between.
query -> orders_rm { entry: S }
```

The placer reserves 2 perimeter cells around the diagram whenever any
edge sets `exit:` or `entry:` so the router has room to wrap. Each
trace's first segment runs perpendicular to its exit face for at
least one cell before any bend (no "running down the side of the
source box" artefacts).

If a perimeter row/col isn't free, the router falls back to the
standard L/Z — which may cut through the obstacle. Re-check your
layout if the U doesn't materialise.

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
melk parse    <file.melk>                            # print AST as JSON
melk bind     <file.melk>                            # print bound Model as JSON
melk validate <file.melk>                            # run full pipeline; print errors only
melk format   <file.melk>                            # emit canonical-form .melk
melk render   <file.melk> [options]                  # render to SVG
```

### `validate`

Runs the full pipeline (parse → bind → place → reserve corridors →
pack tracks → build polylines) and reports the first error
encountered, if any. Prints `OK` on success.

Errors print to stderr in the form
`[<stage>] E_CODE: message. Hint: <suggested fix>.` No stack trace.
Exits 0 on success, 1 on any error.

```
$ melk validate examples/01-simple.melk
OK

$ melk validate broken.melk
[place] E_AMBIGUOUS_PLACEMENT: nodes 'publish' and 'audit' both placed at (row 0, col 2). Add a structured-flow constraint to disambiguate, or split the source. Hint: if 'audit' is a side-channel off a spine member, use `branch <name>:right: <spine> -> audit` (or `:left:`)...
```

Use this for fast structural checking — quick feedback during
authoring without rendering an SVG each time. If you also need to
catch theme-resolution problems, run `render` instead.

### `format`

Emits a canonical, normalized form of the source to stdout:

- Stable directive order: top-level directives → `icons:` →
  `import` → nodes → primitives → edges → annotations.
- Declaration order *within* each category is preserved (it's
  load-bearing for slot/lane allocation).
- Single-space convention everywhere (`key: value`, `, ` between
  list items, `->` with single spaces).
- One blank line between category groups.
- **Comments are dropped** at v1.

Idempotent: `melk format $(melk format file.melk)` is a no-op.

Use case: an LLM author edits a `.melk`; run `melk format` before
diffing so the change-set focuses on meaningful edits instead of
incidental whitespace or reordering.

### `render` options:

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

**Placement** (the *positions* of nodes are ambiguous or over-constrained):

| code                              | when                                                                | author fix |
|-----------------------------------|---------------------------------------------------------------------|------------|
| `E_ANCHOR_CONFLICT`               | A node anchored to two different cells by different primitives      | Drop the node from one construct, or split it. See EXAMPLES.md §5. |
| `E_AMBIGUOUS_PLACEMENT`           | Source doesn't determine a unique placement                         | Wrap the colliding edge in a `branch`/`fan-out`/`bus`, or split the spine. EXAMPLES.md §5 lists the five shapes. |
| `E_SIDE_OVERSUBSCRIBED`           | More than 6 edges demand one node face                              | Grow the hub on the perpendicular axis (`size: 5x9`). EXAMPLES.md §5. |

**Routing** (positions are fine, but no clean orthogonal path fits). These
were undocumented before v0.1.5; the fixes below are the author-controllable
levers — the router has no per-edge width knob:

| code                              | when                                                                | author fix |
|-----------------------------------|---------------------------------------------------------------------|------------|
| `E_CROSSINGS_OVER_BUDGET`         | Routing needs more crossings than the `crossings:` budget (default `0`) | Add `crossings: N` at the file top; the message names the exact `N`. |
| `E_UNROUTABLE`                    | An edge's straight corridor is blocked by a node in between, or no bend cell is free | If the edge points *against* the flow (target upstream of source), write it as a back-edge `c >- a`. Otherwise add `crossings:`, set `exit:`/`entry:` to route the trace around the obstacle (§4.3), or move the obstacle with `offset:`. |
| `E_NO_CHANNEL`                    | An edge's exit/entry cell at a node face is occupied (slot opens into a wall) | Insert a gap between the touching nodes — grow `size:` on a neighbour or pull them apart with `offset:`. |
| `E_LANE_FULL`                     | No free channel row/column exists in the band an edge must cross     | Widen the gap the trace crosses (resize/`offset:` the flanking nodes), or reduce trace density (fewer via-edges per highway face). |
| `E_AXIAL_OVERLAP`                 | Two distinct edges' orthogonal polylines would draw on the same pixels | Reduce trace density across the shared corridor (split a dense highway, drop a via-edge), or give one edge an `exit:`/`entry:` override so its path diverges. |
| `E_CLEARANCE`                     | A routed segment violates the minimum clearance from a node body     | Add space around the node (`offset:` / larger neighbours). |
| `E_AVOID_UNROUTABLE`              | `avoid:` constraint blocks every viable route                       | Relax or remove the `avoid:`. |

> A note on routing errors: unlike placement errors, these depend on the
> *density* of traces through a region, so the fix is usually "make more
> room" (resize/offset neighbours, split a dense bundle) rather than a
> topology change. melk has no syntax to insert a bare empty row/column —
> create the gap by sizing or offsetting the nodes that flank it.

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
   names the chain and constrains the placement. Prefer one
   `pipeline a -> b -> c -> d` over four standalone edges — terser
   source, and the placer has a structure to honour. Refine with
   node attributes afterwards.

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
