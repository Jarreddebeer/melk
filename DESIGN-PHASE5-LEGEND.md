# melk — Phase 5 design: legend

**Status:** spec (not yet implemented)
**Builds on:** [DESIGN-PHASE5-THEMING.md](DESIGN-PHASE5-THEMING.md). Adds an optional, theme-driven legend strip to the rendered SVG.
**Touches:** parser (one new top-level directive, optional position directive), theme schema (one new per-tag field), renderer (legend block emission + canvas bounds expansion). Does **not** touch bind / place / corridor / track / polyline stages.

Phase 5 introduced tags as the override mechanism: `{ tags: [future] }` attaches a tag to a node/edge, the theme defines what that tag *looks like*. What's missing is the bridge to the *reader*: opening a tagged diagram cold, there's no clue what the orange dashed border means. The legend feature closes that gap. The theme already owns the visual definition of every tag; the legend extends that to include a one-line caption. The author flips one switch (`legend: on`) and gets a typed key.

The design has four pillars:

1. **Theme-level definition, author-level opt-in.** Captions live next to the visual rule they describe (theme tag rules), keeping all "what does it look like" in one place. The .melk source just chooses whether to show the legend, never *what* it shows.
2. **Inferred swatch type per entry, with per-tag override.** A tag rule that touches node properties (`fill`, `border`, …) renders as a box swatch; one that touches edge properties (`trace`, `trace-width`) renders as a line swatch. The theme author can override per tag with a `swatch:` field. Authors writing .melk source never think about it.
3. **Configurable position, predictable canvas growth, auto-wrap.** Default position is `bottom`; the `legend-position:` directive overrides to `right`, `top`, or `left`. The canvas grows on that side by a deterministic amount; the existing diagram body is unmoved. Entries always wrap to fit — no overflow errors.
4. **Strict-from-day-one, same as everything else in Phase 4/5.** `legend: on` with no tags used is an error. Referencing a tag that exists in the theme but has no `legend:` caption is an error. Setting `legend-position:` without `legend: on` is an error. No silent skips.

The user-facing surface is two new top-level directives (`legend:`, `legend-position:`) and two new optional theme tag-rule fields (`legend:` caption string, `swatch:` override).

---

## 1. Theme schema additions

### 1.1 Per-tag `legend` field

Tag rules in the theme gain one new optional field:

```json
"tags": {
  "future": {
    "border":       "status-warn",
    "border-width": 1.5,
    "dash":         [4, 3],
    "legend":       "Future state"
  },
  "critical": {
    "border":       "status-error",
    "border-width": 1.5,
    "legend":       "Critical path"
  },
  "deprecated": {
    "trace":        "ink-secondary",
    "dash":         [3, 3],
    "opacity":      0.6,
    "legend":       "Deprecated route"
  }
}
```

`legend` is a single string — the caption shown next to the swatch. Optional. A tag without a `legend` field is renderable (the override still applies) but cannot appear in the legend; turning the legend on for a diagram that uses such a tag is an error (§4.2).

The field is added to the closed `TAG_PROPERTY_NAMES` table in [src/theme/theme.ts](src/theme/theme.ts) as a string-valued property. Validation rejects non-string or empty values with `E_THEME_BAD_VALUE`. Captions are single-line — embedded newlines are rejected with the same error (§6.4).

**Why theme-level not source-level.** The caption belongs next to the visual definition. If you change the theme, the visual changes and the caption that describes it must change too — they're a unit. Putting captions in the .melk source would couple them to the diagram, not to the theme, and would re-introduce the "two themes, two captions" problem that built-in themes ship with one consistent tag vocabulary specifically to avoid.

### 1.2 Per-tag `swatch` override

Tag rules also gain an optional `swatch` field:

```json
"tags": {
  "future": {
    "border":       "status-warn",
    "border-width": 1.5,
    "dash":         [4, 3],
    "legend":       "Future state",
    "swatch":       "line"
  }
}
```

Values: `box` or `line`. Optional. When absent, the swatch is inferred from the rule's properties (§1.4). When present, the override wins. Validation rejects other values with `E_THEME_BAD_VALUE`.

Use cases: a tag that touches `border` (node-affecting) but is semantically about a *connection style* — the author wants a line swatch even though the rule classifies as a box. Or vice-versa: a `dash`-and-`opacity`-only rule that's about emphasis on specific nodes wants a box swatch even though the inference would still pick box (the override is a no-op in that case; harmless).

The override lives in the theme alongside the `legend:` caption — same rationale as §1.1. A diagram doesn't override; a theme does.

### 1.3 Built-in catalogue updates

The three default tag rules (`future`, `critical`, `deprecated`) gain matching `legend` captions in all four built-in themes. The captions are identical across themes — the visual changes (orange-on-light vs amber-on-dark) but the meaning doesn't:

| Tag | Caption |
|-----|---------|
| `future` | Future state |
| `critical` | Critical path |
| `deprecated` | Deprecated route |

None of the built-in tags set `swatch:` — they all infer correctly under §1.4. External themes follow the same convention but the author picks their own captions and may set `swatch:` for tags where inference disagrees with intent.

### 1.4 What the swatch infers

Each tag-rule property is classified as node-affecting, edge-affecting, or both. The classification is fixed (it follows the existing §1.5 table from DESIGN-PHASE5-THEMING.md):

| Property | Class |
|----------|-------|
| `fill` | node |
| `border` | node |
| `border-width` | node |
| `text` | node |
| `text-weight` | node |
| `trace` | edge |
| `trace-width` | edge |
| `dash` | both |
| `opacity` | both |

Swatch inference rule (runs only when the tag's `swatch:` field is absent):
- If the tag rule touches at least one **node-only** property → **box swatch**.
- Else if the tag rule touches at least one **edge-only** property → **line swatch**.
- Else (only `dash` and/or `opacity`) → **box swatch** (the default fallback — boxes are the more readable form when neither class dominates).

`future` (border / border-width / dash) → box. `deprecated` (trace / dash / opacity) → line. `critical` (border / border-width) → box. The classification runs once per tag at theme load and is cached on the resolved tag rule. The explicit `swatch:` override skips inference.

---

## 2. Grammar additions

### 2.1 The `legend:` directive

A new top-level directive, alongside `layout:`, `crossings:`, `theme:`:

```
layout: lr
theme:  document-light
legend: on

pipeline main: a -> b -> c
```

The legend is **on** if and only if the value is the exact token `on`. Any other value — `off`, `false`, `no`, `disabled`, a typo like `onn` — turns it off. No directive at all = off. The directive is a simple token, not a brace-attr block; at v1 the legend doesn't take any options beyond the on switch plus its position.

Rationale: the only state worth checking is "on or not on". A misspelled `legend: onn` should be safely off, not an error, because the worst case (legend silently missing) is visible to the author at eyeball time. The opposite — making typos noisy — would be friction without payoff for a feature whose entire purpose is opt-in.

The duplicate-directive rule from the parser still applies: writing both `legend: on` and `legend: on` again is `E_DUPLICATE_DIRECTIVE`, same as repeating any other directive.

### 2.2 The `legend-position:` directive

A second optional directive:

```
legend: on
legend-position: right
```

Values: `bottom` (default), `right`, `top`, `left`. Single token. Errors:

- `E_LEGEND_POSITION_WITHOUT_LEGEND` — `legend-position:` appears without `legend: on`. The §2.1 rule ("anything not `on` is off") means a typo like `legend: onn` silently disables the legend; this error catches the common follow-on case where the author then writes `legend-position: right` and would otherwise get nothing. The directive only makes sense paired with an enabling `legend: on` — the orphan form is a strong signal something upstream is wrong.
- `E_LEGEND_BAD_POSITION` — value is not one of the four allowed. Position values, unlike `legend:`, are strict — a typo like `legend-position: rite` is almost certainly intended to take effect and silently defaulting it to `bottom` would be a confusing rendering surprise.

### 2.3 CLI override

The `melk render` CLI gains a `--legend=NAME` flag mirroring `--theme=`. Values are the same as the directive (`on`, `off`, or — for symmetry — a position word as a shorthand: `--legend=right` implies `legend: on, legend-position: right`).

CLI precedence: `--legend=` > in-source `legend:` directive > default (`off`).

The CLI override is useful for the same batch-rendering reason as `--theme=`: a single source can render with-and-without legend for two different downstream consumers.

### 2.4 No per-diagram tag inclusion list

The legend always shows **every tag actually used in the diagram** that the theme has a `legend:` caption for. The author can't pick a subset (`legend: on { include: [future] }`); rationale: a legend is for the reader, and the reader needs every tag they see explained. If the author wants fewer entries, they should use fewer tags.

This rule also means **unused tags never appear** — a theme can define ten tags but a diagram that only uses two of them gets a two-entry legend. No author bookkeeping required.

---

## 3. Layout

### 3.1 Entry ordering

Entries appear in the **declaration order of first use** in the .melk source. The first tag attached to any node or edge (depth-first as the parser walks the source) leads; subsequent unique tags follow in their first-use order.

Rationale: this follows the existing [feedback-declaration-order-respected](C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\feedback-declaration-order-respected.md) rule. The author's reading order is the natural one; alphabetical or theme-defined order would surprise the user when they rearrange the source.

A tag used inside a `nodeset` member declaration counts as first-used at that point. Tags on edges count when the edge is parsed. The binder builds the ordered list as it walks.

### 3.2 Per-entry dimensions

Each entry is laid out in a row:

```
[ swatch ] [ caption ]
```

- **Swatch.** Box: 16 × 10 px, styled per the resolved tag rule (fill, border, border-width, dash). Line: 24 × 4 px (two parallel pixels of dash + stroke), styled per trace / trace-width / dash. Both forms are vertically centred against the caption baseline.
- **Caption.** Single-line text at `theme.typography.size.edge` (the existing edge-label size, 9pt under the current `document-light` theme). Colour: `ink-secondary`. Same font face as the rest of the diagram.
- **Gap.** 8 px between swatch and caption (one global grid unit, [feedback-global-grid](C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\feedback-global-grid.md)).
- **Row height.** `max(swatch height, caption ascent + descent)` rounded up to the next 8 px multiple. With the current defaults this is 16 px per row.

### 3.3 Position-specific layout

| Position | Layout | Strip dimension |
|----------|--------|-----------------|
| `bottom` | Horizontal row of entries, left-aligned, left-margin = `PAGE_MARGIN` | Strip height = `row height + 2 × 8 px padding` |
| `top` | Same as bottom, above the diagram | Same |
| `right` | Vertical column of entries, top-aligned, top-margin = `PAGE_MARGIN` | Strip width = `max(entry width) + 2 × 8 px padding` |
| `left` | Same as right, to the left of the diagram | Same |

Bottom/top legends use a single horizontal row, with entries laid out left-to-right, separated by 24 px. If the row would exceed the canvas width minus margins, entries wrap to a second row (8 px line-height between rows). The strip's height grows to accommodate the wraps.

Right/left legends use a vertical column, with entries laid out top-to-bottom, separated by 8 px. If the column would exceed the canvas height minus margins, the layout reflows into a second column to the *outside* of the first (further from the diagram), separated by 24 px. The strip's width grows to accommodate the additional columns. The wrap budget is the canvas height; reflow continues until all entries fit or — in the absurd case of more entries than will fit even at single-entry-per-column — the layout settles into one column and accepts the overflow visually (no error, no hard cap). At v1 this absurd case is improbable: a theme with hundreds of distinct tags is the prerequisite, and §2.4's "only used tags appear" rule clamps practical sizes well below that.

Wrapping in both directions trades layout predictability for elasticity. The author can always switch to the opposite axis (right ↔ bottom) if the wrap geometry doesn't fit; no rendering error blocks them.

### 3.4 Canvas growth

The existing renderer computes `(minX, minY, maxX, maxY)` from the diagram contents plus `PAGE_MARGIN`. Legend layout extends one side of that box:

```
let { x, y, width, height } = computeBoundsFromDiagram(...);
const { side, strip } = layoutLegend(theme, model, position);
if (side === "bottom") { height += strip.h; }
if (side === "top")    { y -= strip.h; height += strip.h; }
if (side === "right")  { width  += strip.w; }
if (side === "left")   { x -= strip.w; width  += strip.w; }
```

The legend strip is rendered as a separate `<g>` group with its own translation, positioned just outside the diagram's PAGE_MARGIN. The diagram body is not translated; the legend takes the new space.

A thin 1px `border-subtle` separator line runs the full length of the legend's shared edge with the diagram (the inner edge of the strip). The separator is `theme.strokes.frame` thickness, no dash. This is the visual cue that the legend is a distinct region — without it, a bottom legend would blend into the diagram's bottom edge.

### 3.5 Worked example

A diagram declares `future` (used once), `critical` (used twice), and `deprecated` (used once), with `legend: on` (default `bottom`):

```
┌──────────────────────────────────────────────┐
│                                              │
│              [diagram body]                  │
│                                              │
├──────────────────────────────────────────────┤
│ [□] Future state   [□] Critical path   [─] Deprecated route │
└──────────────────────────────────────────────┘
```

Order: `future` first (declared first), `critical` second, `deprecated` third. Strip height: 32 px (16 row + 16 padding). Separator: 1 px line above the strip.

With `legend-position: right`:

```
┌──────────────────────────┬────────────────┐
│                          │ [□] Future     │
│                          │     state     │
│      [diagram body]      │ [□] Critical   │
│                          │     path      │
│                          │ [─] Deprecated │
│                          │     route     │
└──────────────────────────┴────────────────┘
```

Note: captions still single-line; the layout above is illustrative — long captions don't wrap inside an entry.

---

## 4. Errors

### 4.1 New error codes

- `E_LEGEND_BAD_POSITION` — `legend-position:` value not one of `bottom` / `right` / `top` / `left`.
- `E_LEGEND_POSITION_WITHOUT_LEGEND` — `legend-position:` without `legend: on`.
- `E_LEGEND_TAG_HAS_NO_CAPTION` — diagram uses a tag whose theme rule has no `legend:` field, with `legend: on` active.
- `E_LEGEND_NO_TAGS_USED` — `legend: on` set but the diagram uses no tags at all. (Rationale: empty legend is almost certainly an author mistake — they forgot to tag the nodes they intended to highlight.)

Note: there is no `E_LEGEND_BAD_VALUE` — per §2.1, anything other than `on` is treated as off. There is no `E_LEGEND_DOES_NOT_FIT` — per §3.3, vertical legends reflow into additional columns rather than erroring.

### 4.2 Why bind-time vs render-time

`E_LEGEND_BAD_POSITION`, `E_LEGEND_POSITION_WITHOUT_LEGEND` fire at parse/bind time — they're source-only checks.

`E_LEGEND_TAG_HAS_NO_CAPTION` and `E_LEGEND_NO_TAGS_USED` fire at render time — they depend on the active theme (which CLI `--theme=` can change post-bind).

All legend errors are hard errors. No partial render. Same strict-from-day-one rule that DESIGN-PHASE4 §11 locks for every other surface.

### 4.3 No "the theme should fix this"

`E_LEGEND_TAG_HAS_NO_CAPTION` says the *theme* is incomplete for the diagram's needs. The error message identifies the offending tag name and points to the theme file. The fix is to add a `legend:` field; the author is the one who picks the wording (caption is theme-level and theme-owned, §1.1). No automatic fallback caption like "tag: future" — that would be a silent quality regression.

---

## 5. Renderer integration

### 5.1 New module

A new file [src/render/legend.ts](src/render/legend.ts) owns legend layout and emission. It exports:

```typescript
export interface LegendLayout {
  side: "top" | "bottom" | "left" | "right";
  width: number;
  height: number;
  entries: LegendEntry[];
}

export interface LegendEntry {
  caption: string;
  swatchKind: "box" | "line";
  rule: TagRule;
}

export function buildLegend(
  model: Model,
  theme: Theme,
  position: LegendPosition,
): LegendLayout;

export function renderLegend(
  layout: LegendLayout,
  origin: { x: number; y: number },
  theme: Theme,
): string;
```

`buildLegend` walks the model to discover used tags in declaration order, classifies each rule's swatch kind, validates that every used tag has a caption (else `E_LEGEND_TAG_HAS_NO_CAPTION`), and returns the strip dimensions. `renderLegend` consumes a `LegendLayout` plus the position-translated origin and emits the `<g>` group SVG.

Keeping legend logic in a separate file mirrors the existing render-module discipline (one concern per file). The legend feature should not balloon [src/render/svg.ts](src/render/svg.ts).

### 5.2 Integration point in svg.ts

`renderSVG` checks `model.legend` (a new field on `Model` populated at bind time):

```typescript
let legend: LegendLayout | undefined;
if (model.legend?.on) {
  legend = buildLegend(model, theme, model.legend.position);
}

const diagramBounds = computeBoundsFromDiagram(...);
const canvas = applyLegendToBounds(diagramBounds, legend);

// ... emit diagram svg using `canvas` viewBox ...
if (legend) {
  parts.push(renderLegend(legend, legendOriginFrom(canvas, legend), theme));
  parts.push(renderSeparator(legend, canvas, theme));
}
```

The `applyLegendToBounds` / `legendOriginFrom` helpers live in the same legend module. The renderer doesn't need to know how the strip is internally laid out — it just gets a side, a size, and a callback.

### 5.3 Model field

[src/bind/model.ts](src/bind/model.ts) gains:

```typescript
export interface LegendConfig {
  on: boolean;
  position: "top" | "bottom" | "left" | "right";
}

export interface Model {
  // ... existing fields ...
  legend?: LegendConfig;
}
```

Bind populates `model.legend` from the parsed directives. When `legend: off` (or absent), `model.legend` is undefined; when `legend: on`, the field is filled with the parsed (or defaulted) position.

### 5.4 CLI changes

[src/cli.ts](src/cli.ts) adds `--legend=VALUE` argument parsing, mirroring `--theme=`. If the value is `on`/`off`, just sets `legend.on`; if it's a position (`bottom`/`right`/etc.), sets both `on: true` and the position. CLI override applied between bind and render, by mutating `model.legend` before passing to `renderSVG`.

### 5.5 Tag-usage discovery

`buildLegend` walks:

1. Every node in `model.nodes`, collecting `node.tags` (in declaration order via the existing `Model.anchors[]` order).
2. Every edge in `model.edges` (also in declaration order — `model.edges` is already declaration-ordered after Phase 4's anchor pass).

For each tag, record its first-use index. Sort the unique tag set by first-use index. Filter to tags whose theme rule has a `legend:` caption; the filter step is what raises `E_LEGEND_TAG_HAS_NO_CAPTION` (any used tag without caption is an error, not a silent drop).

---

## 6. Out of scope for v1

These are intentionally deferred to keep the v1 surface small.

### 6.1 Per-entry caption override in .melk

`{ tags: [future], legend-as: "Production future state" }` — let the author re-caption a tag for this diagram only. Useful for the rare "same tag, different meaning in this context" case. v1 says no: if the meaning differs, it's a different tag. Define a second tag in the theme.

### 6.2 Synthetic legend entries (no underlying tag usage)

v1 only shows tags that are *actually used* on a node or edge somewhere in the diagram (§2.4). If an author wants a legend entry for "this colour means production" but no node in the diagram is tagged with it, the entry doesn't appear. The workaround at v1: invent a tag and apply it to a representative node. A v2 could add a `legend-extra:` source directive or a `legend-only:` theme flag on a tag that forces inclusion without a usage site.

### 6.3 Inferred swatch type per usage site

If a tag is only ever used on edges, render the swatch as a line; if only on nodes, render as a box. v1's rule looks at *the tag rule's properties*, not its *usage sites* — simpler, deterministic, decoupled from the diagram body. Some authors will find usage-site inference more intuitive; we can add it in v2 if needed.

### 6.4 Multi-line captions

`legend: "Future state\nplanned 2026Q4"` — multi-line text per entry. v1 explicitly rejects newlines in caption strings at theme validate time (`E_THEME_BAD_VALUE`). Single-line is a v1 lock — it keeps row-height math trivial and the wrap budgets in §3.3 deterministic. If a caption needs more context, the author shortens it; if they really need multi-line, that's a Phase 5.x font-metrics problem.

### 6.5 Path-overlay legend

Currently the legend describes tags only. A diagram with multiple `path` overlays (each in a different accent colour) has no analogous key. A future addition could let `path: NAME caption: "Hot path"` register a path-entry into the same legend, with a line swatch styled with the assigned accent. Strictly orthogonal to v1.

### 6.6 Legend for built-in shape kinds

Some readers will want a key explaining what a cylinder vs a diamond means semantically in this diagram. v1 doesn't address this — shape semantics are author-defined and per-diagram, not theme-level. Could be a v2 addition (`shape-legend:` directive that names each shape).

### 6.7 Per-entry shape in box swatches

Currently the box swatch is always a rect — even if the tagged nodes are diamonds or cylinders. Matching swatch shape to the tagged node's shape would be more informative but requires either (a) one swatch per (tag, shape) combination, or (b) picking the most-common shape among tagged nodes. Neither is clean. v1 sticks with the rect — the *style* (border, dash, fill) is what the tag controls, not the shape.

### 6.8 Interactive legend (toggle/filter)

In an interactive HTML viewer, the legend could be a control surface — click an entry to dim everything else. Out of scope for the SVG-only v1.

---

## 7. Decisions locked

- **Theme owns the caption.** Captions live in the theme alongside the tag rule, not in the .melk source. Coupling captions to themes is correct; coupling captions to diagrams is not.
- **Author opts in, theme defines.** `legend: on` is the only .melk-side surface needed for the default case. The optional `legend-position:` is the only knob.
- **`legend:` is binary by content match.** The value `on` enables; any other value (including typos, `off`, blank) disables. No `E_LEGEND_BAD_VALUE`. The position directive *is* strict — typos there matter, and the orphan-without-`on` form is a hard error.
- **Swatch type inferred by default, theme can override.** Node-touching properties → box; edge-touching → line; both → box. The theme author can pin a specific swatch via the `swatch:` tag-rule field. Authors writing .melk source never think about it.
- **Always show every used tag.** No subsetting. The legend is for the reader; the reader needs every tag explained. Unused tags are silently absent.
- **Declaration-order entries.** First-use order, matching the [feedback-declaration-order-respected](C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\feedback-declaration-order-respected.md) rule.
- **Default position is bottom.** Most readable, wraps gracefully, doesn't compete with tall diagrams for vertical space.
- **Wraps both axes; no overflow errors.** Horizontal legends wrap rows; vertical legends reflow into additional columns. The author can always switch position if the resulting geometry doesn't fit, but they never get a hard error from layout sizing.
- **Single-line captions only.** Multi-line is a hard v1 reject at theme validation. Keeps row-height math trivial and wrap budgets deterministic.
- **Canvas grows; diagram body never moves.** The legend takes the extra space; existing coordinates are stable.
- **Strict errors where it matters.** Empty-tags use, missing caption, position-without-legend, bad-position — all hard errors. The `legend: on` binary value rule is the one place we accept silent fallback (off), because the worst case is visible at eyeball time.
- **Layout never changes from a legend.** The legend is render-only. No bind-time anchor change, no corridor change, no track repack. Same discipline as the theme spec's "layout is sacred" rule.

## 8. Implementation order

A suggested cut order. Each step ends with passing tests.

1. **Theme schema: add `legend` and `swatch` fields to tag rules.** Extend `TAG_PROPERTY_NAMES` with both. Validation accepts a non-empty single-line string for `legend` (newlines rejected with `E_THEME_BAD_VALUE`); accepts `"box"` or `"line"` for `swatch`. Built-in catalogue gets `legend:` on all three default tags; none of them set `swatch:` (the inference works). +5 tests (valid string, empty rejected, newline rejected, non-string rejected, swatch override).
2. **Swatch classification.** Add `classifyTagRuleSwatch(rule: TagRule): "box" | "line"` to the theme module. If the rule has an explicit `swatch:` field, return it; otherwise run inference. Pure function. Tests cover all branches plus override.
3. **Parser: `legend:` and `legend-position:` directives.** Lexer/parser/AST additions. Both are simple `keyword: identifier` directives. `legend:` parses as binary — `on` enables, anything else (including missing/empty/typo) leaves it off. `legend-position:` enforces the four-value set. Errors: `E_LEGEND_BAD_POSITION`, `E_LEGEND_POSITION_WITHOUT_LEGEND`. +5 parser tests (including "typo in legend value silently disables").
4. **Bind: populate `Model.legend`.** Carry the directives through to the `LegendConfig` field. +2 bind tests.
5. **Legend layout module (`src/render/legend.ts`).** Implement `buildLegend` (discover used tags in declaration order, validate captions, classify swatches) and the per-position layout math with two-axis wrapping (rows wrap for top/bottom, columns reflow for left/right). Tests cover: tag discovery, declaration ordering, every position, `E_LEGEND_TAG_HAS_NO_CAPTION`, `E_LEGEND_NO_TAGS_USED`, horizontal wrap to second row, vertical wrap to second column.
6. **Legend rendering.** Implement `renderLegend` — emit the `<g>` group with box/line swatches, captions, and the separator. Snapshot tests for each position under `document-light`.
7. **Canvas integration.** Wire `buildLegend` + `applyLegendToBounds` + `renderLegend` into `renderSVG`. Existing diagrams without legends render byte-for-byte identical. +1 integration test (a small diagram with `legend: on` matches a golden).
8. **CLI flag.** `--legend=VALUE` argument parsing in [src/cli.ts](src/cli.ts). +2 CLI tests.
9. **Add `legend: on` to 2–3 examples.** Demonstrate on a tag-heavy diagram (probably an updated `examples/04-spine.melk` with future/critical tags). Eyeball-check each position.
10. **Regenerate all 29 examples.** Confirm no visual regressions on the legend-less ones. Open the legend examples and confirm the strip looks right under all four built-in themes.

After step 10, the legend feature is shippable and the author has a real reference for how to use it. Deferred items from §6 can be picked off based on real usage feedback.
