# melk — ideas

Forward-looking features not yet designed. Each entry is a sketch, not a
spec. When one graduates, it becomes a `DESIGN-PHASE5-*.md` (or whichever
phase is current) and the sketch here is replaced by a one-line pointer.

The point of this file is to keep the shape of the next thinking visible
without committing to scope or order. Reorder freely.

---

## Diagram titles

A first-class `title:` directive (and maybe `subtitle:`) that the renderer
draws above the canvas in its own labeled strip. Aligns with the legend
feature's "first-class theme-driven chrome" pattern — same kind of strip,
same canvas-extension model.

Open questions:

- Theme-owned typography, but caption text is .melk-owned (the *content*
  is per-diagram, unlike legend captions which describe a theme-wide
  vocabulary). Probably:
  - `title: "My Architecture"` in the source.
  - Theme defines size / weight / colour / margin via a new
    `typography.size.title` slot + matching `weight`.
- Strip position: top by default; a `title-position:` (or just couple it
  to `legend-position:`?) may be unnecessary v1 polish.
- Subtitle: simpler to ship `title:` alone and revisit subtitle if real
  usage demands it.
- Auto-numbering / per-figure prefixes ("Figure 1: ...") — out of scope;
  the embedding document handles that.
- Multi-line titles — probably yes (titles are display text, unlike
  legend captions where single-line was a layout simplification). Wrap
  at canvas width.

Touches: parser (one new directive), bind (`Model.title?`), theme
(typography additions), renderer (one more strip on the canvas-extension
flow already built for the legend).

---

## Icon packs

Two distinct use cases, probably want to support both:

1. **Icon as the node body** — instead of `shape: rect`, `shape:
   icon(aws/s3)` (or similar). The icon IS the node mark; label sits
   below the way it does for circles.
2. **Icon inside a node** — a small badge in a corner, or to the left of
   the label, while the regular shape outline still draws. Useful for
   tagging a generic rect with a vendor logo without losing the box.

Sketch:

- Icon packs are directories of named SVG files (`icons/aws/s3.svg`,
  `icons/azure/blob.svg`, …). melk loads a pack via a top-level
  directive: `icons: aws from "./icons/aws/"`.
- Per-node usage: `node my_bucket { icon: aws/s3 }` for the badge form,
  `node my_bucket { shape: icon, icon: aws/s3 }` for the icon-as-shape
  form. Or pick a single grammar that handles both via attribute
  presence.
- The renderer inlines the icon SVG (referenced or embedded) inside a
  `<g>` with the right transform. Pack the icon's viewBox to a fixed
  inner size; let it inherit `currentColor` so the theme's tint applies.
- Theme integration: icons take `ink-primary` (or a new `icon-fill`
  token) for monochrome icons; multi-colour brand icons stay
  literal-coloured.
- Built-in pack? Probably not v1 — the user supplies their own. ship
  one generic pack (devicons?) if friction is high.

Open questions:

- Licensing: SVG icons have licences. We don't redistribute; users
  install packs themselves. Document.
- Sizing — should an icon-as-shape node have a default 1×1 cell, or
  should the pack declare a preferred aspect? Probably 1×1 by default;
  user overrides with `size:` if they want.
- Caching — large packs shouldn't slow render. Lazy-load only icons
  actually referenced.
- Tag interaction — does a tag's `fill:` override apply to a monochrome
  icon? Probably yes (it's just inheriting currentColor).

Touches: parser (`icons:` directive + `icon:` attr), bind (icon
references stored on `ModelNode`), placer (icon-shape nodes might want
non-rect cell footprint?), renderer (new shape branch + svg injection).

Related: this is a sibling of "shape kinds" but plug-in rather than
hard-coded. Worth thinking about whether `shape: highway` /
`shape: cylinder` etc. could eventually be defined in user-supplied
"shape packs" too — i.e. the long-term architecture is shape registry,
and icons are the first reason to need one.

---

## Composable diagrams (module imports) — LANDED

Shipped as Phase 5 modules. See
[DESIGN-PHASE5-MODULES.md](DESIGN-PHASE5-MODULES.md) for the spec and
the 9-cut implementation arc.

---

## How to use this file

- When picking up a new direction, look here first. The sketches name
  the open questions to nail down before any code lands.
- Promoting an entry: write a `DESIGN-PHASE5-X.md` (or current phase),
  link it from CLAUDE.md and `next-session.md`, replace the sketch here
  with a one-liner pointer.
- Demoting / removing: if real usage proves the idea unnecessary or
  shows the open questions can't be answered, delete the entry with a
  short note in a commit message. Don't let stale ideas accumulate.
