# melk — Phase 5 design: titles + captions

**Status:** spec (not yet implemented)
**Builds on:** [DESIGN-PHASE5-THEMING.md](DESIGN-PHASE5-THEMING.md) and [DESIGN-PHASE5-LEGEND.md](DESIGN-PHASE5-LEGEND.md). Adds two more author-driven, theme-styled strips around the canvas.
**Touches:** parser (three new directives), bind (`Model.title?`, `Model.subtitle?`, `Model.caption?`), theme (new typography slots), renderer (top + bottom strips around the existing diagram body).

Phase 5 has lifted theming, tags, and the legend; the diagram now has chrome but no name. A reader opening one cold has no title to anchor the picture in. The titles feature closes that gap with two strips: a top strip carrying an optional **title** and **subtitle** (the "header"), and a bottom strip carrying an optional **caption** (the "footer"). Both strips are first-class — they extend the canvas, follow the same theme-driven discipline as the legend, and never touch layout.

The design has four pillars:

1. **Two purpose-built slots, not a configurable axis.** Title strip is always on top; caption strip is always on bottom. The legend already covers the configurable-position pattern; titles need different ergonomics (top-aligned, header-shaped) and an extra config knob would only complicate authoring without payoff.
2. **Content in .melk, styling in the theme.** The strings are per-diagram (different diagrams have different titles); the typography is theme-wide (every diagram in a doc should use the same heading style). This mirrors the legend's split: captions in the theme because they describe theme-wide tag semantics, title strings in .melk because they describe this diagram.
3. **Single-line strict, canvas widens to fit.** Embedded newlines are rejected at parse time. If a title is wider than the diagram body, the canvas widens to accommodate it (and the diagram body sits centred in the wider canvas). The author's deterministic layout never gets silently re-scaled.
4. **Coexists with the legend without special casing.** Both features extend the canvas in the same `renderSVG` flow. Top strip + bottom strip + left/right legend all compose; the diagram body's geometry never moves a pixel.

The user-facing surface is three new top-level directives (`title:`, `subtitle:`, `caption:`) and three new theme typography slots (`title`, `subtitle`, `caption` in `size` + matching `weight` entries).

---

## 1. Grammar

### 1.1 The three directives

Three new top-level directives, alongside `layout:`, `crossings:`, `theme:`, `legend:`, `legend-position:`:

```
layout:   lr
theme:    document-light
title:    "Order Service Architecture"
subtitle: "v2.1 — post-migration"
caption:  "Source: payments.melk + downstream consumers (2026-06)"
legend:   on

pipeline main: ingest -> transform -> publish
```

Each value is a **quoted string**. Bare-ident form is rejected (titles often contain spaces and punctuation; requiring quotes makes the grammar unambiguous). All three directives are optional and independent — any combination is valid. Absence of all three is the default (no chrome strips).

### 1.2 Single-line rule

Embedded newlines (`\n` after string-escape resolution) are rejected at parse time with `E_TITLE_MULTILINE`. Same rule as legend captions, same rationale: keeps strip-height math trivial and the canvas-extension flow deterministic. If real authoring proves multi-line is essential, a Phase 5.x extension can lift the rule (it's a font-metrics problem, not a grammar one).

The rejection is symmetric across all three directives — `subtitle` and `caption` follow the same rule.

### 1.3 Repetition

Multiple `title:` (or `subtitle:`, or `caption:`) directives are last-wins, matching the precedent set by `theme:`, `legend:`, and `legend-position:`. No `E_DUPLICATE_DIRECTIVE` for these — chrome strings are content, not structural commitments.

### 1.4 Empty strings

`title: ""` is rejected at parse with `E_TITLE_EMPTY`. Rationale: an empty title reserves canvas space for nothing. If the author wants to disable the title, they remove the directive (or comment it out). Same for `subtitle:` and `caption:`.

### 1.5 New parse errors

- `E_TITLE_MULTILINE` — title / subtitle / caption value contains a newline.
- `E_TITLE_EMPTY` — title / subtitle / caption value is the empty string.

That's it for parser-level rules. Everything else (overflow handling, position, strip layout) is render-time.

---

## 2. Theme schema additions

### 2.1 Typography size slots

Three new entries in `theme.typography.size`:

```json
"size": {
  "body":     10,
  "edge":     9,
  "frame":    9,
  "title":    20,
  "subtitle": 13,
  "caption":  9
}
```

All three are **required** in every theme — same closed-vocabulary discipline as the existing slots. A theme missing any of them raises `E_THEME_MISSING_FIELD: title` / etc. at validation. Adding new slots is a spec change, not a per-theme decision.

### 2.2 Typography weight slots

Two new entries in `theme.typography.weight`:

```json
"weight": {
  "label":    500,
  "heading":  600,
  "title":    700,
  "subtitle": 500
}
```

`caption` reuses the existing `label` weight (captions are normal-weight body-style annotations, not headings). Adding `caption` as its own weight slot is deferred — the simpler v1 surface ships first.

### 2.3 Built-in catalogue updates

All four built-in themes get the new slots. Per the existing elegance-pass discipline, sizes are tuned so they read as a proper headline ramp without shouting:

| Theme | title | subtitle | caption |
|-------|-------|----------|---------|
| `document-light` | 20 / 700 | 13 / 500 | 9 / 500 |
| `document-dark`  | 20 / 700 | 13 / 500 | 9 / 500 |
| `schematic-light`| 18 / 600 | 13 / 500 | 9 / 500 |
| `schematic-dark` | 18 / 600 | 13 / 500 | 9 / 500 |

Schematic themes go a tick smaller and lighter — PCB silkscreen titles are typically denser, less display-grade.

Colours are reused from existing tokens:
- Title text: `ink-primary`.
- Subtitle text: `ink-secondary`.
- Caption text: `ink-secondary`.

No new colour tokens are introduced — the existing ink hierarchy already has the right shape.

### 2.4 Validation

The validator extends `validateTypography` to require the three new size slots and two new weight slots. Errors reuse `E_THEME_MISSING_FIELD` and `E_THEME_BAD_NUMBER`. No new error codes.

---

## 3. Layout

### 3.1 Strip dimensions

The **header strip** (top) contains the title and/or subtitle, stacked. Each present row is sized by its theme typography slot:

- Title row height: `title font-size + 8 px row padding`.
- Subtitle row height: `subtitle font-size + 4 px row padding`.
- Inter-row gap (when both title and subtitle present): `4 px`.
- Header strip padding: `16 px` top + `8 px` bottom.

The **footer strip** (bottom) contains the caption, on a single row:

- Caption row height: `caption font-size + 4 px row padding`.
- Footer strip padding: `8 px` top + `12 px` bottom.

All values multiples of the 8 px global grid where reasonable; the small (4 px / 12 px) values are inter-element breathing room that respects typography metrics rather than dogmatically snapping.

Both strips span the **full canvas width** (after the legend has extended it, if applicable).

### 3.2 Horizontal alignment

Title, subtitle, and caption are all **left-aligned**, with their text starting at `x = PAGE_MARGIN` (the same indent as the diagram body's left edge in the unextended canvas).

Rationale: left-aligned reads as document chrome; centred reads as decorative title-card. melk's diagrams are workhorse architectural diagrams — they belong in docs and decks where left-aligned headlines are the convention. (If a use case for centred titles emerges, a `title-align:` directive can be added without grammar break.)

When the legend is on `right`, the strip's content still left-aligns at `x = PAGE_MARGIN` — it doesn't shift to cover the wider canvas. Same for `left`-position legends: the title sits above the diagram body (now shifted right), starting at the diagram body's left edge. This keeps the visual relationship "title labels diagram" consistent regardless of legend.

### 3.3 Canvas widening to fit titles

Title text width is estimated as `title.length * title-size * CHAR_WIDTH_RATIO` (the same conservative-on-the-wide-side estimate the legend uses). If the estimated title width plus left-and-right `PAGE_MARGIN` exceeds the canvas width, the canvas widens to fit — the diagram body stays where it is (left-aligned with the title), and the extra width is added on the right.

Same logic for subtitle and caption. The widest of the three sets the new canvas width.

Rationale: the author's deterministic layout never gets silently re-scaled. If they wrote a title that's too long for the diagram, the canvas grows; they see the result at eyeball time and can shorten if they want. The alternative ("auto-fit shrinks the title") makes title size diagram-dependent, which is the wrong determinism trade.

### 3.4 Coexistence with legend

Order of canvas extension in `renderSVG`:

1. Compute base canvas from diagram body + nodeset rects + circle labels (existing flow).
2. Build legend layout if `model.legend?.on`; extend canvas on its side (existing flow).
3. Build header strip layout if any of `model.title`, `model.subtitle` set; extend canvas height upward by `header.height` and translate the diagram + legend down by `header.height`.
4. Build footer strip layout if `model.caption` set; extend canvas height downward by `footer.height`. No further translation needed.
5. Widen canvas if title/subtitle/caption width exceeds current canvas width.

Steps 3 and 4 are independent. The title strip can be present without the caption strip, and vice versa.

The legend lives entirely below the header strip and above the footer strip — both vertical legends (left/right) and horizontal legends (top/bottom). For a horizontal `top`-position legend with a title also set, the order top-to-bottom is: **title strip → legend strip → diagram body → caption strip**. This is the natural reading order for a document figure.

### 3.5 Worked example

A diagram with all three strings set, legend on the right, default position elsewhere:

```
┌──────────────────────────────────────────────────┐
│ Order Service Architecture                       │   ← title (20pt, 700 wt)
│ v2.1 — post-migration                            │   ← subtitle (13pt, 500 wt)
├──────────────────────────────────┬───────────────┤
│                                  │ ▢ Future state│   ← legend (right)
│                                  │ ▢ Critical    │
│        [diagram body]            │ ─ Deprecated  │
│                                  │               │
│                                  │               │
├──────────────────────────────────┴───────────────┤
│ Source: payments.melk + downstream (2026-06)     │   ← caption (9pt, 500 wt)
└──────────────────────────────────────────────────┘
```

If the title is wider than `diagram_width + legend_width`, the canvas widens to fit; the diagram body stays at its left-aligned position, and the legend stays pinned to the right.

---

## 4. Errors

### 4.1 New error codes

- `E_TITLE_MULTILINE` — embedded newline in any of title / subtitle / caption.
- `E_TITLE_EMPTY` — empty-string value in any of the three.

Both fire at parse time. No render-time errors are added for titles — the worst case (title overruns canvas) widens the canvas rather than erroring, matching the legend's "no overflow errors" principle.

### 4.2 What's NOT an error

- Subtitle without title: legal. Renders just the subtitle row, with the same strip padding as a full header. Rare, but the symmetry is cleaner than special-casing.
- Caption with no diagram body: legal (empty model). The canvas is `2 × PAGE_MARGIN + caption row` tall. Unlikely in practice.
- Title width > canvas width: not an error; canvas widens (§3.3).

---

## 5. Renderer integration

### 5.1 Model fields

[src/bind/model.ts](src/bind/model.ts) gains three optional fields:

```typescript
export interface Model {
  // ... existing fields ...
  title?: string;
  subtitle?: string;
  caption?: string;
}
```

Bind populates them from the parsed directives (last-wins). All three are independent — any combination is legal.

### 5.2 Layout module

A new module [src/render/titles.ts](src/render/titles.ts) owns header and footer strip layout. It exports:

```typescript
export interface TitleStripLayout {
  /** Total strip height in pixels. */
  height: number;
  /** Width required to fit the strip's widest text + margins. */
  minWidth: number;
  /** Placed text rows with local (x, y) origin. */
  rows: PlacedTextRow[];
}

export interface PlacedTextRow {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontWeight: number;
  fill: string;
  kind: "title" | "subtitle" | "caption";
}

export function buildHeader(model: Model, theme: Theme): TitleStripLayout | undefined;
export function buildFooter(model: Model, theme: Theme): TitleStripLayout | undefined;

export function renderTitleStrip(
  layout: TitleStripLayout,
  originX: number,
  originY: number,
  theme: Theme,
): string;
```

`buildHeader` returns undefined when neither title nor subtitle is set; `buildFooter` returns undefined when caption is absent. `renderTitleStrip` emits a single `<g transform="translate(...)">` with the placed text rows. No separator line (unlike the legend) — the typographic weight ramp already provides visual separation; an extra rule would be noise.

### 5.3 Integration point in svg.ts

After the legend layout step, before computing the final transform:

```typescript
const header = buildHeader(model, theme);
const footer = buildFooter(model, theme);

if (header) {
  ty += header.height;
  H += header.height;
}
if (footer) {
  H += footer.height;
}

// Width adjustment: widen canvas if title/footer demand it.
const titleMinWidth = Math.max(
  header?.minWidth ?? 0,
  footer?.minWidth ?? 0,
);
if (titleMinWidth > W) {
  W = titleMinWidth;
}
```

Then emission:

```typescript
if (header) {
  parts.push(renderTitleStrip(header, 0, 0, theme));
}
// ... existing diagram body emission, with the updated tx/ty ...
if (footer) {
  parts.push(renderTitleStrip(footer, 0, H - footer.height, theme));
}
```

### 5.4 CLI flags

Mirroring `--theme=` and `--legend=`, the CLI gains:

```
--title="..."
--subtitle="..."
--caption="..."
```

Each overrides the in-source directive. An empty string on the CLI **disables** the corresponding strip (i.e. `--title=""` deletes any in-source title). Matches the legend flag's "anything that doesn't look like an enable disables" pattern, but adapted to titles' content-bearing nature.

The CLI precedence is: flag > in-source > absent.

---

## 6. Out of scope for v1

These are intentionally deferred to keep the v1 surface small.

### 6.1 Centred or right-aligned titles

A `title-align: left|centre|right` directive could exist. v1 ships left-aligned only — it's the document-chrome default and a single locked alignment makes the canvas-widening math trivial.

### 6.2 Multi-line titles

`title: "Order Service\nArchitecture"` — explicit newline support. v1 hard-rejects. Layout math (strip height) becomes line-aware; legend wrap behavior would need to coexist. Defer until a real diagram needs it.

### 6.3 Per-diagram typography overrides

`title: "..." { size: 28 }` — inline brace-attr to override the theme's font size on this one diagram. v1 says no — same rationale as the legend's "theme owns the visual definition". If you need a one-off title size, fork the theme.

### 6.4 Per-figure numbering

`title: "..." { figure: 7 }` or auto-numbering across a directory of files. The embedding document (Word, Quarto, custom static-site generator) handles figure numbering — melk's job is to render one diagram, not catalogue them.

### 6.5 Subtitle on its own row vs same row as title

v1 stacks subtitle below title. A future `subtitle-inline: true` option could put them on the same row with a separator (the way some doc systems render headers like "Title · Subtitle"). Not needed for the v1 catalogue.

### 6.6 Caption with markdown / inline formatting

`caption: "Source: **payments.melk** + downstream consumers"` — markdown bold/italic/links. v1 treats every string as plain text. Inline formatting requires text-fragment layout (tspan structuring, font runs), which is bigger than this feature's scope.

### 6.7 Author-visible link / source attribution

A `source:` directive separate from `caption:`, with conventional treatment (linkified, smaller, right-aligned). v1 says: just put it in the caption.

### 6.8 Title in the legend's "above-and-below" position

Above the legend (when legend is top-positioned) — i.e. title above legend, legend above diagram. v1 always renders title above the legend regardless of legend position. Matches reading order; no reason to invert.

---

## 7. Decisions locked

- **Two purpose-built slots: header (top) and footer (bottom).** No `title-position:` knob. The legend covers the configurable-axis pattern; titles need the conventional document-chrome shape.
- **Content in .melk, typography in the theme.** Strings are per-diagram; sizes/weights/colours are theme-wide. Consistent with the legend's split.
- **Single-line strict; canvas widens to fit.** Newlines rejected; empty strings rejected; over-width titles widen the canvas (not the title size). Determinism wins over auto-fit.
- **Left-aligned, document-chrome convention.** Not centred. Centred is title-card; left-aligned is workhorse.
- **All three directives are independent and optional.** Any combination of title / subtitle / caption is valid; absence of all three is the default.
- **Three new theme typography size slots + two new weight slots.** Closed vocabulary, every theme must fill them. Built-in catalogue updated accordingly.
- **No new colour tokens.** Title uses `ink-primary`; subtitle and caption use `ink-secondary`. The existing hierarchy already has the right shape.
- **No separator line between strips and body.** Typography weight ramp does the separation; a rule would be visual noise.
- **CLI flag empty string = disable.** `--title=""` overrides an in-source title to off, matching the legend flag's "anything that isn't an enable disables" pattern.
- **Layout never changes from titles.** Same discipline as theme spec's "layout is sacred". Titles are pure render-time canvas chrome.

## 8. Implementation order

A suggested cut order. Each step ends with passing tests.

1. **Theme schema: add `size.title|subtitle|caption` and `weight.title|subtitle`.** Extend the validator; built-in catalogue gets the new slots per §2.3. Existing tests stay green; +5 tests for new field presence and built-in coverage.
2. **Parser: `title:`, `subtitle:`, `caption:` directives.** Lexer/parser/AST additions. All three are quoted-string-valued. Errors: `E_TITLE_MULTILINE`, `E_TITLE_EMPTY`. +6 parser tests.
3. **Bind: populate `Model.title`, `Model.subtitle`, `Model.caption`.** Carry the directives through. Multiple of any kind is last-wins. +3 bind tests.
4. **Titles layout module ([src/render/titles.ts](src/render/titles.ts)).** Implement `buildHeader`, `buildFooter`, `renderTitleStrip`. Pure functions; tests cover all combinations of title/subtitle present and the width-estimation math.
5. **Renderer integration in [src/render/svg.ts](src/render/svg.ts).** Extend canvas height; widen canvas for title overflow; emit header strip above the diagram, footer strip below. Legend coexistence verified. +3 integration tests covering: title alone, caption alone, title + subtitle + caption + legend on all four sides.
6. **CLI flags `--title`, `--subtitle`, `--caption`.** Argument parsing + override logic. Empty string disables. +2 CLI tests.
7. **Add titles to an example.** Update [examples/04-spine.melk](examples/04-spine.melk) (already has legend) with `title:` + `subtitle:` + `caption:` to demonstrate the full chrome on a small diagram. Regenerate all 30 SVGs to confirm no regression on the untitled ones.
8. **Eyeball check.** Open the titled examples under all four built-in themes and confirm the typography ramp reads as a proper header hierarchy.

After step 8, the titles feature is shippable.
