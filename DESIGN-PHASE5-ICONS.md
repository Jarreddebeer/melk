# melk — Phase 5 design: icon packs

**Status:** spec (not yet implemented)
**Builds on:** [DESIGN-PHASE4.md](DESIGN-PHASE4.md), [DESIGN-PHASE5-THEMING.md](DESIGN-PHASE5-THEMING.md). Adds plug-in icon shape support plus an in-node badge variant.
**Touches:** parser (one new top-level directive, two new attrs), bind (`Model.iconPacks`, `ModelNode.icon`, `ModelNode.iconPosition`), renderer (icon loader + new shape branch + badge layer), CLI (pack-cache directory).

melk's shape kinds — rect, roundrect, circle, diamond, cylinder, highway — are hardcoded. Real architecture diagrams need vendor / service / domain glyphs (S3, Kafka, a CPU, a database vendor's logo) to read at a glance. This feature adds **icon packs** as a first-class plug-in shape source. Authors register a pack (local directory or URL); icons in that pack are usable either as the node's body (`shape: icon(name)`) or as a badge inside a regular shape (`icon: name` brace-attr). Either way the icon flows through the renderer's existing shape pipeline — no parallel emitter, no layout exception.

The design has five pillars:

1. **Plug-in not built-in.** melk ships zero icons; the author supplies the pack. Licensing stays the author's problem. Reduces the maintenance footprint and avoids the bundled-asset version-skew trap.
2. **Local OR URL, disk-cached.** URL packs work the same way as local once cached; the first reference downloads, subsequent renders read from `.melk-cache/`. Network is opt-out per pack, not opt-in for the whole tool.
3. **Two forms from v1.** Body form (`shape: icon(name)`) replaces the box silhouette. Badge form (`icon: name` on any shape) overlays a small mark. Authors get both without revisiting the spec when the second use case emerges.
4. **Theme-aware monochrome via currentColor.** Icons that use `fill="currentColor"` pick up the theme's `ink-primary` token automatically. Brand multi-colour icons stay literal. No new theme tokens — the existing ink hierarchy already says what monochrome icons should look like.
5. **Strict-but-tolerant on missing icons.** Bind-time checks warn (so authoring against an incomplete pack works); render-time emits a hatched placeholder + stderr warning rather than failing. Different from the rest of melk's strict-from-day-one rule because icons are *content*, not structure — a missing glyph shouldn't block the layout from being eyeballed.

The user-facing surface is one new top-level directive (`icons:`), one new shape form (`shape: icon(name)`), and one new brace-attr (`icon: name`, with optional `icon-position:`).

---

## 1. Pack registration

### 1.1 The `icons:` directive

One top-level directive per pack, alongside `theme:`, `legend:`, etc.:

```
icons: aws   from "./icons/aws/"
icons: gcp   from "./icons/gcp/"
icons: azure from "https://cdn.example.com/azure-icons/v3/"
```

Grammar:

```
icons: <pack-alias> from <quoted-path-or-url>
```

- **Pack alias** is a bare identifier — the name authors use to reference the pack later (`shape: icon(aws/s3)` uses the `aws` alias).
- **Source** is a quoted string: either a relative/absolute filesystem path, or an `http://` / `https://` URL. Paths resolve relative to the .melk file's directory.

Multiple `icons:` directives in one file are legal and additive — each registers a pack. Re-registering the same alias is `E_ICON_PACK_DUPLICATE_ALIAS`.

### 1.2 Pack contents

A pack is a directory of SVG files. Each file's basename (without `.svg`) is the icon name within the pack. So `./icons/aws/s3.svg` registers as icon `aws/s3`; `./icons/aws/lambda.svg` registers as `aws/lambda`.

Subdirectories inside a pack are treated as a path separator: `./icons/aws/storage/glacier.svg` registers as `aws/storage/glacier`. Authors reference the full path: `shape: icon(aws/storage/glacier)`.

No manifest file is required at v1 — directory contents are the manifest. (A future `icons.json` could declare default dimensions per icon; deferred to §7.)

### 1.3 URL packs

For an `https://` source:

1. On first reference (`shape: icon(azure/blob)`), melk fetches `<source>/blob.svg` over HTTPS.
2. The fetched bytes are written to a disk cache at `.melk-cache/<pack-alias>/<icon-name>.svg`. The cache directory sits next to the .melk file being rendered.
3. Subsequent renders read from the cache — no further network.

Cache invalidation at v1 is **manual**: delete the cache directory to force a re-fetch. (A future `--refresh-icons` CLI flag or version-pinned URL syntax can address invalidation if real usage demands it; deferred.)

URLs must be `https://`. Plain `http://` is `E_ICON_PACK_INSECURE`. Local file paths through `file://` are not accepted — use a relative path instead.

### 1.4 CLI `--no-network`

A `melk render --no-network foo.melk` flag forces all URL packs to be **cache-only**. If a referenced icon isn't already cached, render falls back to the missing-icon placeholder (§4.2). Useful for CI runs that must be deterministic and offline.

The default is network-on (mirroring `--theme=` and `--legend=` which work without explicit flags). Authors who want strict offline behaviour add the flag.

---

## 2. Icon as the node body

### 2.1 Grammar

`shape: icon(<icon-ref>)` on any node:

```
s3       { shape: icon(aws/s3) }
glacier  { shape: icon(aws/storage/glacier), label: "Cold storage" }
producer { shape: icon(devicons/kafka), size: 2x1 }
```

The argument inside the parentheses is `<pack-alias>/<icon-name>`. The icon name may contain `/` for subdirectories (§1.2).

Both forms of `shape:` value — bare ident (`rect`) and call form (`icon(...)`) — are accepted by the parser. This is the only call-form shape; everything else stays bare-ident.

Errors:
- `E_ICON_PACK_UNKNOWN` — the alias doesn't match any registered `icons:` directive.
- `E_ICON_BAD_REF` — the argument isn't `alias/name` form (e.g. `shape: icon(s3)` with no alias prefix).

### 2.2 Default cell size

An icon-as-body node defaults to **1×1**, identical to the other primitive shapes. Authors override per-node with `size:` if they need a larger glyph:

```
big_db { shape: icon(devicons/postgres), size: 2x2 }
```

No aspect-ratio enforcement at v1. If the icon's intrinsic SVG aspect doesn't match the cell aspect, it's centred and scaled to fit (preserving the icon's aspect; whitespace fills the gap). Pack-declared default dimensions are out of scope (§7).

### 2.3 Label placement

Icon-as-body nodes follow the **circle convention**: label sits **below** the icon, like the existing `circle` shape. Rationale: an icon's visual centre is the icon itself, not a text label — placing the label inside (e.g. centred over the glyph) overlaps it. Below mirrors flowchart / BPMN convention for sources, sinks, and event markers.

The renderer extends its existing circle-label headroom-reservation logic to cover icon-as-body nodes (the canvas expands vertically to fit the label). Code path identical except for the shape branch.

### 2.4 Rendering: inline SVG

For each `shape: icon(...)` node, the renderer inlines the icon's SVG content inside a `<g>` group with:

- A `transform="translate(x, y) scale(s)"` placing the icon at the cell's pixel origin and scaling it to fit the cell.
- `fill="currentColor"` and `color="<theme.ink-primary>"` on the wrapping `<g>`, so monochrome icons inherit the theme's ink colour.
- The icon's own `<svg>` root element is stripped; its children become children of the wrapping `<g>`.

For multi-colour icons that use explicit `fill="#hex"` attributes, those literal colours win — `currentColor` only applies where the icon's SVG actually references it. Brand icons stay on-brand.

### 2.5 Tag-rule interaction

Tags **cannot** change a node's icon (§7.5 locks this). They can re-tint a monochrome icon via the existing `text` property:

```json
"tags": {
  "external": {
    "text": "status-info",
    "legend": "External system"
  }
}
```

Rationale: `text` already controls the node's primary text colour, which is the same `currentColor` that monochrome icons inherit. Re-purposing `text` for the icon-as-body tint keeps the tag-rule vocabulary closed and avoids inventing an `icon-fill` property.

For multi-colour brand icons, tag re-tint has no effect (the icon's literal hex values win). This is correct: tagging an AWS logo `critical` shouldn't recolour it; AWS is AWS.

---

## 3. Icon as an in-node badge

### 3.1 Grammar

The `icon:` brace-attr on any non-`icon` shape:

```
my_service { shape: rect, icon: aws/lambda, label: "Process Order" }
event_hub  { shape: roundrect, icon: azure/event-hub, label: "Events" }
```

`icon:` is a bare property like `label:` and `size:`. The value is `<pack-alias>/<icon-name>` (same format as the body form).

An optional `icon-position:` brace-attr controls badge placement:

```
my_service {
  shape: rect,
  icon: aws/lambda,
  icon-position: inline,
  label: "Process Order"
}
```

Values: `inline` (default) and `corner`. §3.3 describes the visual difference.

If `icon-position:` is present without `icon:`, parser raises `E_ICON_POSITION_WITHOUT_ICON`. (Analogous to legend-position without legend.)

### 3.2 Combining `shape: icon(...)` and `icon:`

Both on the same node is `E_ICON_SHAPE_WITH_ICON_ATTR`. The body form already names the icon; an extra badge attr would compete for the same visual real estate. Pick one.

### 3.3 Badge placement: inline vs corner

**Inline (default)**: the icon sits **to the left** of the label text, on the same baseline. Icon height = label cap-height; icon width auto-scales to match. The label centres in the cell as before, but the icon+label group as a whole centres rather than the label alone. Think: GitHub repo list, where the language dot precedes the text.

**Corner**: the icon pins to the **top-left** of the node's bounding box, sized to ~30% of the cell's shorter dimension (capped at 24px). The label still centres in the cell. Think: architecture diagrams where small vendor logos sit in each corner of named service boxes.

The two options exist because both conventions are widely-used and visually distinct. Defaulting to inline matches the more common modern style; corner is the classic AWS-architecture look.

### 3.4 Rendering: badge layer

Badges render as a new layer in the SVG output, between the node's primary shape and its label:

```
boxes → badge icons → labels
```

Each badge is its own inlined SVG with `fill="currentColor"` and the same theme-aware tint as body icons. The badge layer is drawn AFTER the box (so it sits on top of the box fill) but BEFORE the label (so a long label doesn't get clipped by the badge).

The renderer reuses the icon-loader code path from the body form; only the placement/sizing math differs. No parallel pipeline.

### 3.5 Tag-rule interaction

Same as body icons (§2.5): tag-rule `text` property re-tints monochrome badges; multi-colour badges ignore tints. Tags cannot swap the badge for a different icon.

---

## 4. Errors and warnings

### 4.1 New error codes

- `E_ICON_PACK_DUPLICATE_ALIAS` — two `icons:` directives use the same alias.
- `E_ICON_PACK_INSECURE` — pack source starts with `http://` instead of `https://`.
- `E_ICON_PACK_UNKNOWN` — `icon(<alias>/<name>)` references an alias with no `icons:` directive.
- `E_ICON_BAD_REF` — icon reference doesn't have an `alias/name` shape.
- `E_ICON_SHAPE_WITH_ICON_ATTR` — node sets both `shape: icon(...)` and `icon:`.
- `E_ICON_POSITION_WITHOUT_ICON` — `icon-position:` without an `icon:` attr.
- `E_ICON_PACK_LOAD_FAILED` — local directory doesn't exist / is unreadable.

All bind-time except `E_ICON_PACK_LOAD_FAILED`, which is render-time (the pack directory is read when the first icon is referenced).

### 4.2 Missing-icon behaviour: warn, don't fail

When a specific icon file is missing (e.g. `icon(aws/s4)` where `s4.svg` doesn't exist in the `aws` pack), the renderer:

1. Emits a stderr warning: `W_ICON_NOT_FOUND: icon 'aws/s4' (node 'mystery_bucket') not found in pack`.
2. Draws a **hatched-square placeholder** at the icon's position, sized to match what the real icon would have occupied. The placeholder is a 1px dashed `border-subtle` outline with diagonal hatching (`border-subtle` strokes at 45°, 4px apart).
3. Continues the render — no exit code, no partial-output bailout.

Rationale: icons are *content*, not *structure*. An author iterating on a diagram (before all icons are downloaded; or against an in-progress pack) should still get a renderable result. The placeholder is visible enough that they know something's missing; the warning tells them what.

URL fetch failures (network unreachable, 404, TLS handshake failure) follow the same path: placeholder + warning, render continues. With `--no-network`, fetch is skipped entirely and missing-from-cache icons go straight to the placeholder.

### 4.3 What's NOT a warning

- A pack with **no usable icons** (e.g. empty directory) is fine. Only icons that are actually referenced and missing trigger warnings.
- An icon SVG file that fails to parse (malformed XML) → placeholder + warning with `W_ICON_PARSE_FAILED`. Same path; just a different sub-message.

---

## 5. Renderer integration

### 5.1 New module: `src/render/icons.ts`

Owns icon loading, caching, and placeholder rendering. Exports:

```typescript
export interface IconPack {
  alias: string;
  source: string;            // "local" | "url"
  // For local packs: absolute directory path. For url packs: the
  // remote URL prefix (cache lookups use the same alias/name path).
  resolvedRoot: string;
}

export interface IconRegistry {
  packs: Map<string, IconPack>;
  cacheDir: string;          // absolute path to .melk-cache/
  allowNetwork: boolean;     // CLI --no-network flips this
}

export function buildIconRegistry(
  model: Model,
  meltFileDir: string,
  allowNetwork: boolean,
): IconRegistry;

export interface LoadedIcon {
  /**
   * The icon's inner SVG content (children of the root `<svg>`, with
   * the root stripped). Pre-parsed; downstream code substitutes this
   * into the renderer's emitted SVG.
   */
  innerSVG: string;
  /** Intrinsic width / height from the icon's viewBox. */
  width: number;
  height: number;
}

export function loadIcon(
  registry: IconRegistry,
  ref: { alias: string; name: string },
): LoadedIcon | undefined;  // undefined = missing → placeholder

export function renderIconPlaceholder(
  x: number,
  y: number,
  width: number,
  height: number,
  theme: Theme,
): string;

export function renderIconBody(
  loaded: LoadedIcon,
  x: number,
  y: number,
  width: number,
  height: number,
  theme: Theme,
): string;

export function renderIconBadge(
  loaded: LoadedIcon,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
  position: "inline" | "corner",
  labelMetrics: { x: number; y: number; height: number } | undefined,
  theme: Theme,
): string;
```

`loadIcon` synchronously returns `undefined` for any missing icon (whether the file is absent locally or the URL fetch failed). It triggers the stderr warning as a side effect. URL fetches are blocking HTTPS GETs — synchronous to keep the rest of the render pipeline pure / non-async. (A future async render mode could lift this.)

### 5.2 Model fields

```typescript
export interface IconPackRef {
  alias: string;
  source: string;     // raw value from the `icons:` directive
}

export interface IconRef {
  alias: string;
  name: string;
}

export interface Model {
  // ... existing fields ...
  iconPacks: IconPackRef[];
}

export interface ModelNode {
  // ... existing fields ...
  /**
   * Icon reference for either body form (when `shape === "icon"`) or
   * badge form (when `shape` is any other value and `icon` is set).
   */
  icon?: IconRef;
  /** Badge placement. Only meaningful when shape !== "icon". */
  iconPosition?: "inline" | "corner";
}
```

`ShapeName` gains a new variant `"icon"`. The parser produces `shape: "icon"` plus `icon: { alias, name }` from `shape: icon(alias/name)`. Downstream stages (placer, corridors, polyline emitter) treat `"icon"` the same as `"rect"` for geometry purposes — only the renderer cares about the difference.

### 5.3 Renderer dispatch

In `renderNode`:

```typescript
if (n.shape === "icon") {
  // Body form: load icon, inline-render at box bounds. Label below.
  const loaded = n.icon ? loadIcon(registry, n.icon) : undefined;
  if (loaded) {
    parts.push(renderIconBody(loaded, b.x, b.y, b.width, b.height, theme));
  } else {
    parts.push(renderIconPlaceholder(b.x, b.y, b.width, b.height, theme));
  }
  // Label below (circle convention).
  parts.push(renderLabelBelow(n, b, theme, overrides));
} else {
  // Standard shape.
  parts.push(nodeShape(n.shape, b, theme, overrides));
  // Badge form: if icon attr set, draw badge over the shape.
  if (n.icon) {
    const loaded = loadIcon(registry, n.icon);
    if (loaded) {
      parts.push(renderIconBadge(loaded, b.x, b.y, b.width, b.height, n.iconPosition ?? "inline", labelMetrics, theme));
    } else {
      // Placeholder sized to typical badge dimensions (~16px square)
      parts.push(renderIconPlaceholder(badgeX, badgeY, 16, 16, theme));
    }
  }
  // Normal label.
  parts.push(renderLabel(n, b, theme, overrides));
}
```

The icon registry is built once at the start of `renderSVG` and threaded through the node-render loop. No global state.

### 5.4 CLI changes

[src/cli.ts](src/cli.ts) parses the `--no-network` flag and threads it into the registry build. Default is network-allowed.

```
melk render foo.melk --no-network -o foo.svg
```

When `--no-network` is set, URL packs become cache-only. Local packs are unaffected.

---

## 6. Theme integration

### 6.1 No new theme tokens

The existing `ink-primary` token covers monochrome icon tint. No `icon-fill` token is added. Rationale: a separate token implies "icons should be a different colour from text", which is the opposite of what most architecture diagrams do. If real usage shows demand, add later.

### 6.2 No new tag-rule properties

Tags continue to be visual overrides via the existing closed property table (DESIGN-PHASE5-THEMING §1.5). Tag's `text` property re-tints monochrome icons because both inherit `currentColor`. No `icon` property in the tag-rule table; tags cannot swap icons (§2.5).

### 6.3 Brand-icon coexistence

Multi-colour brand icons (e.g. official AWS service icons) carry their own `fill="#hex"` attributes. The currentColor cascade doesn't reach them — they render at their literal brand colours regardless of theme. This is correct: brand fidelity matters, and a theme switch shouldn't desaturate the AWS S3 logo.

Theme authors targeting brand icons can document this in their pack: "this pack uses literal brand colours; theme tints don't apply." No mechanism required at the language level.

---

## 7. Out of scope for v1

These are intentionally deferred.

### 7.1 Pack manifest with per-icon metadata

`./icons/aws/icons.json` declaring default sizes, default aspects, multi-colour mode markers. Useful for packs where some icons are landscape (e.g. service-bus shapes) but adds a per-pack file the author must hand-author. v1 treats every icon as 1×1 cell with auto-fit; users `size:` per-node.

### 7.2 Pack version pinning + cache invalidation

`icons: aws@v3 from "https://cdn.x/aws/v3/"` with `@v3` baked into the cache key. v1 caches by alias only; manual cache invalidation (`rm -rf .melk-cache/aws`) is the workaround.

### 7.3 Per-icon colour override at the node level

`mybox { shape: icon(aws/s3), color: "#ff0000" }` — author re-tints a single icon without involving theme or tags. v1 says: invent a tag and define it in your theme. Same friction the legend feature already imposes.

### 7.4 Bundled built-in pack

A `icons: builtin` shortcut to a stdlib pack (devicons, simple-icons, or similar). v1 ships no icons. If the friction of "where do I get a pack" becomes the dominant complaint, ship one.

### 7.5 Tag-driven icon swap

`tags.failed.icon = "warning/alert-triangle"` to swap a node's glyph based on state. v1 explicitly forbids this — icons are content, tags are paint. If state-driven swap is a real use case, the v2 path is a new top-level construct, not a tag extension.

### 7.6 Icon sizing per pack

Some packs (e.g. Cisco-style network shapes) are inherently landscape. v1 forces square 1×1 default; the author writes `size: 2x1` per node. A pack manifest could fix this (§7.1).

### 7.7 Async icon loading

URL fetches are synchronous (blocking HTTPS GET) at v1. A future async render mode would batch them. v1 ships sync; cache-after-first-fetch means real workflows hit network once.

### 7.8 Icon-as-edge-decoration

Adding a small icon mid-edge (e.g. a lock glyph on a TLS-encrypted edge). Distinct shape problem; defer.

---

## 8. Decisions locked

- **Plug-in only at v1; melk ships no icons.** Author supplies packs; licensing is the author's responsibility.
- **Local + URL pack sources; disk-cached on first URL fetch.** Cache invalidation is manual. `https://` required.
- **One `icons:` directive per pack.** Top-level, alias + source. Multiple legal; duplicate alias errors.
- **Two forms: `shape: icon(alias/name)` body + `icon: alias/name` badge.** Mutually exclusive on the same node.
- **Default cell size 1×1.** No aspect enforcement; auto-fit with whitespace.
- **Label below for body form (circle convention); normal label position for badge form.**
- **Badge position configurable: `inline` (default) or `corner`.**
- **Monochrome icons inherit `currentColor` → `ink-primary`.** Brand icons stay as-authored.
- **No new theme tokens. No new tag-rule properties.** Tags re-tint monochrome via the existing `text` property; can't swap icons.
- **Missing icon → placeholder + warn, render continues.** Different from the rest of melk's strict-from-day-one rule because icons are content.
- **`--no-network` CLI flag for offline/CI runs.** URL packs become cache-only.
- **Layout never changes from an icon.** Same sacred-layout rule as every other Phase 5 feature.

## 9. Implementation order

A suggested cut order. Each step ends with passing tests.

1. **Parser: `icons:` directive, `shape: icon(...)` call form, `icon:` + `icon-position:` brace-attrs.** Lexer/parser/AST additions. Errors: `E_ICON_PACK_INSECURE`, `E_ICON_BAD_REF`, `E_ICON_POSITION_WITHOUT_ICON` (parse), `E_ICON_SHAPE_WITH_ICON_ATTR` (parse). +8 parser tests.
2. **Bind: populate `Model.iconPacks`, `ModelNode.icon`, `ModelNode.iconPosition`.** Errors: `E_ICON_PACK_DUPLICATE_ALIAS`, `E_ICON_PACK_UNKNOWN` (validation that referenced aliases exist). +5 bind tests.
3. **Shape name extension.** Add `"icon"` to `ShapeName`. Existing placer / corridors / polyline tests stay green (icon shape geometrically identical to rect). +2 tests confirming geometry.
4. **Icon loader module ([src/render/icons.ts](src/render/icons.ts)).** Local-file loading, SVG parsing, currentColor wrapping, placeholder rendering. URL fetch deferred to step 5. +6 tests using a tiny in-repo test pack at `test/fixtures/icons/`.
5. **URL fetch + disk cache.** HTTPS GET, write to `.melk-cache/<alias>/<name>.svg`. `--no-network` skips network. `E_ICON_PACK_INSECURE` for `http://`. +4 tests — one using a mock server (or skipping if too fragile), the rest covering cache-hit / cache-miss / `--no-network`.
6. **Renderer body-form integration.** `shape: icon(...)` node renders the icon at box bounds with label below; circle-label headroom logic extended. Placeholder on missing icon. +5 tests.
7. **Renderer badge-form integration.** Inline + corner positions. Badge layer between shape and label. +4 tests.
8. **CLI `--no-network` flag.** +1 CLI smoke test.
9. **Author a tiny test pack + example.** `examples/icons/` with a few hand-drawn SVGs (a server, a database, a cloud) and a new `examples/31-icons.melk` demonstrating both forms. Regenerate all SVGs.
10. **Eyeball check.** Open the icons example under all four built-in themes and confirm monochrome icons follow the ink hierarchy, badge positions are readable, placeholder works for a deliberately-missing reference.

After step 10, the icons feature is shippable.
