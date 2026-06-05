# melk — next session handoff

**Test count: 536 passing + 3 skipped. 35 examples. master is clean.**

## Last session: module body alignment + outer gutters landed

Picked up the prior session's UNSOLVED: imported modules on a parent
spine (e.g. `client -> edge -> ingest -> compute -> storage ->
consumer` in `35-modules-platform.melk`) showed dogleg traces between
modules because each module body was centered inside its synthetic
cell, and "centered" doesn't align the data-row of internals across
modules with different body shapes. Screenshot from the user showed
`edge -> ingest` as an S-curve where it should be a straight line.

### Cut 14 — face-to-face snap stability

`portPointFor` in [src/layout/polyline.ts](src/layout/polyline.ts) now
defaults to `facePorts[side][0]` (the closest-to-face candidate) when
exactly one face-to-face edge lands on a `(parentId, side)` pair. The
candidate list is sorted by internal-node local position, which is
stable under module body shifts — the alignment pass (Cut 16) can
shift a module without the snap suddenly picking a different internal
node. Multi-edge faces still use the existing axis-snap to spread.

A new `faceToFaceCount` map keyed by `(parentId|side)` is built
alongside the qualified-ref `internalFanoutRank` map; the polyline
builder threads it into `portPointFor` so the resolver knows when to
prefer `[0]` vs spread.

### Cut 15 — body offset wired through port index + renderer

New `ImportedModule.bodyOffsetX / bodyOffsetY` fields on the model
([src/bind/model.ts](src/bind/model.ts)).

Both the polyline builder (via `buildModulePortIndex` in
[src/layout/module-route.ts](src/layout/module-route.ts)) and the
renderer (`renderModuleBody` in [src/render/svg.ts](src/render/svg.ts))
add the offset to the body origin. Critically, both now center the
body inside the **full cell pixel rect** rather than the synthetic
node's smaller centered rect — the cell allocation is what owns the
body's slack, so alignment can use the full `(cellPx - body) / 2`
range on each axis.

The change is transparent when offset is 0 (centering in cell rect ≡
centering in synthetic node rect when the body fits exactly).

### Cut 16 — applyModuleAlignment

New `applyModuleAlignment(model, placement, reservation)` in
[src/layout/module-place.ts](src/layout/module-place.ts) runs in the
CLI between `reserveCorridors` and `packTracks`. Algorithm:

1. For each face-to-face flow-axis edge that touches at least one
   module (qualified-ref edges are out of scope — they pin specific
   internal nodes), compute the cross-flow delta each end implies.
   LR parent → align Y; TB parent → align X.
2. For each module, prefer **module-side** constraints (other end is
   another module) over **regular-side** constraints (other end is a
   plain node). Mental model: "module-to-module chains should be
   straight; a regular endpoint y is fine to dogleg." Mean of the
   selected category; clamp to `(cell - body) / 2` slack.
3. Iterate to convergence (cap at 24 passes, abort when no module
   moves more than 0.5 px). Snap final offsets to integer pixels.

Qualified-ref taps (`compute.aggregator -> obs.signals`) are
deliberately ignored by the constraint solver — their endpoints sit
on specific internal nodes that could be anywhere on any face, so
aligning a body to satisfy them would conflict with face-to-face
alignment. They route as-is.

### Cut 17 — module outer gutter

Every imported module's synthetic node `size` grows by
`MODULE_GUTTER_ROWS = 2 / MODULE_GUTTER_COLS = 2`
([src/layout/module-place.ts](src/layout/module-place.ts)), beyond
what `ceil(pixelSize / CELL_PX)` strictly needs. This:

- Visually separates neighbouring modules so trace channels between
  them have room to breathe (user feedback during this session:
  "trace lines do seem very tight between modules").
- Gives the alignment pass cross-flow slack to work with on modules
  that would otherwise be zero-slack (`pixelHeight == size.height *
  CELL_PX` exactly).

The platform demo `35-modules-platform.svg` shows the full effect:
all five data-spine edges (`client -> edge -> ingest -> compute ->
storage -> consumer`) now render as a single straight horizontal line
at y=96. Before this session: every transition was a dogleg.

`33-modules-basic.svg` and `34-modules-framed.svg` are also straight
end-to-end at y=48.

### Verification

- All 536 tests pass (3 still skipped — pre-existing legacy
  forced-crossing topologies in `test/tracks.test.ts`).
- Manual re-render of 33, 34, 35: spine is dead-straight; observability
  taps still land at three distinct x positions (Cut 13 fan-out spread
  still active); frame chrome unchanged.
- Pre-existing tsc warnings in `svg.ts` and `theme.ts` unchanged.

## What's in the tree

Examples unchanged at **35**. Demo theme at
[examples/themes/document-light-with-frames.json](examples/themes/document-light-with-frames.json).
Module library at [examples/modules/](examples/modules/) unchanged.

Source files touched this session:
- [src/bind/model.ts](src/bind/model.ts) — `ImportedModule.bodyOffsetX
  / bodyOffsetY` added.
- [src/layout/module-place.ts](src/layout/module-place.ts) — new
  `applyModuleAlignment`; `MODULE_GUTTER_ROWS / COLS` constants; the
  synthetic node size now pads by gutter.
- [src/layout/module-route.ts](src/layout/module-route.ts) — port
  index uses cell rect + offset.
- [src/layout/polyline.ts](src/layout/polyline.ts) — face-to-face
  snap default-to-`[0]` for single edges; `faceToFaceCount` map.
- [src/render/svg.ts](src/render/svg.ts) — `renderModuleBody` uses
  cell rect + offset (top-level and nested-module callsites).
- [src/cli.ts](src/cli.ts) — calls `applyModuleAlignment` between
  `reserveCorridors` and `packTracks`.

No test additions this session — the alignment pass is exercised by
the existing 35-modules-platform render and visual verification.

## What's NOT in v1 (deferred items from §14 of the design doc)

Unchanged from the prior handoff. The alignment pass still doesn't
handle:

- **Qualified-ref endpoint alignment.** A `mod.foo -> mod2.bar` edge
  pins both ends to specific internal nodes; the alignment pass
  ignores these entirely. If a future demo wants `compute.aggregator`
  and `observability.signals` to line up vertically, that needs a
  separate mechanism (or hand-tuning the modules' internal layouts).
- **Cross-flow edges in the constraint set.** `applyModuleAlignment`
  filters to edges using the parent's flow-axis faces (E/W for LR;
  N/S for TB). The `ingest -> observability` branch (S/N face) isn't
  considered — observability is the only module that wants to align
  vertically below ingest, and there's nothing to align it WITH on
  the cross-flow axis.
- **Per-module gutter override.** `MODULE_GUTTER_ROWS / COLS = 2` is
  hardcoded. A theme- or import-site-level override is plausible but
  not requested.

## What's open right now

Functionally complete and signed off:
- Phase 4 + 4.1–4.6 + 5.0–5.6 (theming, legend, titles, icons, tag
  driven per-node theming, gradients, modules, alignment + gutter).
  536 passing + 3 skipped.

**3 still-skipped track tests** in
[test/tracks.test.ts](test/tracks.test.ts) — legacy forced-crossing
topologies. Carried over.

**Pre-existing tsc warnings** in `svg.ts` and `theme.ts`. Unchanged.

## How to start the next session

1. Read this file (you're doing it).
2. If touching modules code, read
   [DESIGN-PHASE5-MODULES.md](DESIGN-PHASE5-MODULES.md) cover to
   cover.
3. Check feedback memories in
   `C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\`.
4. `npx vitest run` — should show 536 passing + 3 skipped.
5. `git log --oneline` — module alignment commit is after the
   `Add Phase 5 module imports + routing polish` commit from the
   prior handoff.
6. Read [IDEAS.md](IDEAS.md) for remaining ideas.

## Quick gotchas

- **Layout is sacred.** Theme/tags never change geometry. The module
  alignment pass shifts bodies inside cells but never resizes nodes;
  the outer gutter resizes the synthetic node only (the body is
  unchanged), so cell allocations get bigger but routing topology
  stays the same.
- **Module-to-module wins over module-to-regular.** When a module
  has both kinds of cross-flow constraint, the algorithm prefers the
  module-side one. This sacrifices regular-endpoint straightness
  (e.g. `client -> edge` doglegs) to keep the module chain straight.
  If a future demo wants the regular endpoints aligned too, the
  weighting needs revisiting.
- **Cell rect ≠ synthetic node rect.** Renderer and port index both
  now read the *cell* pixel rect (`layout.colWidthPx[cell.col]` etc.)
  rather than the synthetic node's centered rect. Code that resolves
  module port positions should follow suit — using `boxBounds` for a
  module-shape node returns the synthetic node rect, which is
  smaller than the cell.
- **`buildPolylines` still runs twice for modules.** Module bodies'
  polylines are built during `placeModules`; parent polylines are
  built during the main pipeline. Alignment runs between them, so
  body polylines are unaffected — only the parent's body offset
  shifts where the body's `<g>` gets translated to.
- **Outer gutter eats canvas width.** `MODULE_GUTTER_COLS = 2`
  means every module's parent cell is 64 px wider than strictly
  needed. For demos with 5+ horizontally-chained modules this adds
  up; if canvas width becomes a complaint, lower the gutter or make
  it asymmetric (only inter-module gaps, not start/end of row).
