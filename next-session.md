# melk — next session handoff

**Test count: 536 passing + 3 skipped. 35 examples. master is clean.**

## ⚠️ UNSOLVED at session end — start here

The platform demo (`examples/35-modules-platform.svg`) still has
visible cross-module routing artifacts. User reported (at session end,
after Cut 12 landed):

> there are still traces that overlap between modules and that enter
> at the same port, like in the screenshot

The screenshot showed the `dispatch` area inside the compute module
with TWO traces visibly entering it. Spent the session chasing this:

- **Cut 11 (face ports)** improved the visual — face-to-face module
  edges now land on a visible internal node's face midpoint rather
  than at the synthetic cell's geometric center. Good.
- **Cut 12 (qualified-ref side override)** fixed a specific bug
  where `compute.aggregator -> obs.signals` was routing W out of
  compute (through dispatch's area) before turning south. After
  Cut 12 it routes S directly. Tests pass.
- **But the user says it's still not solved.** I did not get a fresh
  screenshot after Cut 12 to verify which specific artifact remained.
  Best guess: there are still overlapping traces near dispatch
  caused by some combination of:
  - `ingest -> compute` (the legitimate W-face entry at dispatch)
  - `compute -> observability` running south near dispatch (after
    Cut 12 it exits aggregator south but the path still passes by
    dispatch on its way west to obs)
  - the routing of multiple edges sharing nearby corridors

**First thing to do next session:** ask the user for a fresh
screenshot of the dispatch area in the current
`examples/35-modules-platform.svg` and identify which traces are
visually problematic NOW. Do not assume the Cut 12 fix was wrong —
verify against actual output.

**Possible directions if the residual issue is real:**

1. The qualified-ref side override only fires when `fromInternal` /
   `toInternal` is set. If the issue is a face-to-face edge whose
   slot still picks a bad face, that's a separate problem — extend
   the side override to face-to-face module edges too (use the
   `assignSides(edgeFwd)` result but score against the candidate
   ports' positions).

2. The face port "snap to closest" mechanism (in
   `polyline.ts: portPointFor`) snaps the slot pixel to the nearest
   candidate by axis-distance. Multiple edges arriving at the same
   face can snap to the same candidate (if their slot pixels are
   close). Consider a "no double-booking" assignment: greedily
   assign slots to candidates in order, never repeating until all
   candidates used.

3. The `compute -> observability` and `storage -> observability`
   traces both end at `signals` (same internal node, both
   qualified). They share corridor space and visually overlap as
   they converge. Possible fix: spread the entry slot on signals
   itself — but signals is a single internal node, so they really
   do converge. May be unavoidable without a `bus` or topology
   change.

4. Worth re-rendering with a CLEAN slate (delete the .svg outputs
   and re-run) to make sure stale frames aren't showing.

## What landed this session (Phase 5 composable modules)

A full Phase 5 module-imports arc landed this session. One file imports
another with `import "<path>" as <alias> { overrides }`. The imported
module is parsed, bound, placed under its own theme/layout, and treated
as an opaque cell on the parent canvas. Internal nodes are addressable
as `alias.node_name`; parent-level edges connect through the module
frame to the actual internal node's pixel position.

Design: [DESIGN-PHASE5-MODULES.md](DESIGN-PHASE5-MODULES.md) — full
spec with 16 sections + 9-cut implementation plan + 9 deferred items.

Read the design doc cover-to-cover before touching modules code. The
mental model is locked: "modules render independently up to placement;
parent placer sees opaque cells with port tables; renderer walks the
tree depth-first switching themes at the `<g>` boundary; edges pass
through frames to internal-node-translated coordinates".

### Implementation (9 cuts, all landed)

- **Cut 1**: parser + AST. `ImportDecl` + qualified node refs
  (`NodeRef.module`). [src/parser/ast.ts](src/parser/ast.ts) +
  [src/parser/parser.ts](src/parser/parser.ts).
- **Cut 2**: bind layer. Recursive file load (sync, via
  `ModuleLoader`), cycle detection, alias resolution. Override
  application (`theme`, `layout`, `legend`, `title`, `subtitle`,
  `caption`).
- **Cut 3**: per-module placement pass
  ([src/layout/module-place.ts](src/layout/module-place.ts)). Runs the
  full layout pipeline on each imported module's sub-Model up through
  `buildPolylines`, computes a port table for each referenced internal
  node, updates the synthetic module-shape node's `size` on the parent.
- **Cut 4**: parent edge endpoint translation (initial implementation
  via a post-pass; superseded by Cut 10 — see below).
- **Cut 5**: renderer module emission. New `renderModuleBody` helper
  in [src/render/svg.ts](src/render/svg.ts) emits `<g
  data-module="alias" transform="translate(x y)">…internal SVG…</g>`
  under the module's resolved theme.
- **Cut 6**: theme `modules` block. New `Theme.modules: ThemeModules`
  field. Strict-validated. Renders a dashed/solid frame + optional
  alias label around each imported module.
- **Cut 7**: chrome suppression. `legend`, `title`, `subtitle`,
  `caption` directives in imported modules are silently stripped at
  bind time so only parent chrome surfaces.
- **Cut 8**: error decoration. Bind errors raised inside an imported
  module are wrapped with the import chain
  (`E_MODULE_CYCLE` and `E_MODULE_FILE_NOT_FOUND` pass through; other
  errors are decorated with `"  (imported module chain: …)"` and the
  original error code stays at the head of the message).
- **Cut 10** (mid-session refinement): router-side port lookup
  replaces the Cut 4 post-pass. `buildOrthogonalPolyline` now calls
  `portPointFor` for each endpoint, returning the translated internal
  node pixel when `edge.fromInternal` / `edge.toInternal` is set. The
  corridor trunk routes around the *real* endpoints so the polyline is
  axis-aligned all the way through — no more yanked endpoints with
  bezier-jump artifacts inside module bodies. The Cut 4
  `applyModulePortEndpoints` is retained as a no-op shim
  ([src/layout/module-route.ts](src/layout/module-route.ts)) for back
  compat; the CLI no longer calls it.

- **Cut 11** (further refinement): implicit face ports for
  face-to-face module edges. Before this change, parent edges between
  two modules (no qualified ref) entered/exited at the synthetic
  cell's geometric face center — which often landed at random
  internal-node faces (looking like a trace was originating from that
  unrelated node) or in empty gaps between internal nodes (looking
  like a dangling trace). Now each module computes implicit face
  ports (`facePorts: { N, S, E, W }` on `ImportedModule`) where each
  face holds an *ordered list of candidate ports* — one per visible
  internal node, sorted closest-to-face first then by axis position.
  The polyline builder takes the slot index assigned by the slot
  allocator (already ordered spatially by opposite-endpoint position)
  and picks `candidates[slot % candidates.length]`. Net effect:

  - **Single incoming edge:** lands on the closest internal node's
    matching face midpoint (clean read).
  - **Multiple incoming edges:** spread across distinct internal
    nodes' face midpoints, in spatial order matching the slot
    allocator. No more piling on a single face point.
  - **Overflow (more edges than candidates):** cycles via modulo so
    nothing crashes; same-port stacking is still possible but at
    least predictable.

  Qualified refs (`mod.foo`) still take priority — they always land
  at the internal node's centroid. Non-module edges are unaffected.

  The most visible win: in `35-modules-platform.svg`, the data spine
  edges (`client→edge`, `edge→ingest`, etc.) now land on each
  module's actual leftmost/rightmost spine node, not at random
  vertical gaps. Combined with the storage simplification (next
  bullet), the platform demo's routing reads cleanly.

- **Cut 12** (further refinement): qualified-ref side override in
  the corridor reservation. When an edge has `fromInternal` or
  `toInternal`, the cell-level corridor reservation was picking
  source/target side based on the synthetic cell's geometry and
  cell-delta tie-breaks. For modules whose internal node sits far
  from the picked face, this produced ugly detours: the polyline
  would head from the internal node toward the picked cell face,
  exit the module on that face, then route around to the target.

  Most visible on the platform demo's `compute.aggregator ->
  observability.signals` tap: compute is at cell (0,3) and obs is at
  cell (1,2) (one row down, one col west). The cell-delta tie-break
  picked `sourceSide=W` (because absRow=absCol and compute's local
  forward is E). The trace exited aggregator going west across most
  of compute's body, passed right next to dispatch on its way out,
  then went south. Two visible traces near dispatch (the
  `ingest -> compute` arrow entering AND the `compute.aggregator
  -> observability.signals` arrow leaving westward).

  The fix: `pickModuleFaceForInternal` in `corridors.ts` overrides
  the side for any edge with a qualified module endpoint. Per face,
  score = perpendicular distance from the internal node's position
  minus a large bonus if the face matches the cell-delta direction
  toward the other endpoint. The minimum-score face wins. For
  aggregator → obs, this picks S (south points toward obs AND is
  closest to aggregator). The polyline now exits aggregator
  cleanly through compute's S face — no detour, no near-dispatch
  artifacts.

  Also generalized the face port mapping in the polyline builder:
  instead of `slot % candidates.length` (which didn't work because
  slot numbers are physical positions, not edge ranks), the builder
  now computes the slot's intended pixel and snaps to the closest
  face port candidate by axis-distance. This produces the same
  spread effect for multiple incoming edges but without the modulo
  artifact.

- **Module library tweaks for cleaner routing:**
  - `storage.melk` simplified: removed the `bus` highway and the
    via-edges (`writes -> primary { via: bus }`). The standalone
    storage rendering had wild routing because the highway was
    over-constraining. Now a plain `pipeline main: writes -> primary
    -> replica` with a `branch reads-out:right: primary -> reads`.
  - `observability.melk` switched to `layout: tb`. Signals → collector
    → fan-out (dashboards / alerting / archive) now flows top-to-
    bottom. This puts `signals` on the N face — natural for a module
    placed below the data spine that receives taps from above. The
    old LR layout made the parent edges enter from the east and
    cross the entire body to reach signals on the west.

- **Cut 9**: demo examples + docs.
  [examples/33-modules-basic.melk](examples/33-modules-basic.melk) and
  [examples/34-modules-framed.melk](examples/34-modules-framed.melk)
  exercise the basic case and the frame-visible case.
  [examples/35-modules-platform.melk](examples/35-modules-platform.melk)
  is the larger composition: a five-plane platform overview
  (edge, ingest, compute, storage, observability) built from five
  module files in [examples/modules/](examples/modules/). Each module
  carries its own pipeline / fan-out / highway structure; the parent
  wires them with qualified refs only (no `pipeline` at the parent
  level — the qualified edges drive both adjacency and routing).

### New error codes

- `E_MODULE_FILE_NOT_FOUND` — import path doesn't resolve.
- `E_MODULE_ALIAS_DUPLICATE` — same alias used twice.
- `E_MODULE_ALIAS_UNKNOWN` — qualified ref uses an unknown alias.
- `E_MODULE_NODE_UNKNOWN` — qualified ref names an unknown internal node.
- `E_MODULE_ALIAS_COLLIDES_WITH_NODE` — alias clashes with a parent
  node id.
- `E_MODULE_OVERRIDE_UNKNOWN` / `E_MODULE_OVERRIDE_BAD_VALUE` — bad
  brace-block override.
- `E_MODULE_CYCLE` — import cycle (full chain in message).
- `E_MODULE_URL_UNSUPPORTED` — `import "https://…"` (v1 local-only).
- `E_MODULE_PATH_EMPTY` — empty import path string.
- `E_THEME_UNKNOWN_MODULES_KEY` / `E_THEME_BAD_MODULES` — bad
  `modules:` block in theme JSON.

### Bind API change

`bind(program, options?)` — accepts `BindOptions { importerPath?,
loader?, importStack? }`. CLI passes `importerPath: filePath` so
relative imports resolve correctly. Tests pass a stub `ModuleLoader`
to avoid filesystem.

## What's in the tree

Examples now at **35** (added `33-modules-basic.melk`,
`34-modules-framed.melk`, `35-modules-platform.melk`). Demo theme at
[examples/themes/document-light-with-frames.json](examples/themes/document-light-with-frames.json).
Module library at [examples/modules/](examples/modules/) with seven
modules: `payments`, `notifier` (for 33/34) and `edge`, `ingest`,
`compute`, `storage`, `observability` (for 35).

Source modules added in this session:
- [src/layout/module-place.ts](src/layout/module-place.ts) — per-module
  placement + port table builder.
- [src/layout/module-route.ts](src/layout/module-route.ts) — exports
  `buildModulePortIndex` (used by the polyline builder to translate
  qualified endpoints) and a no-op back-compat shim
  `applyModulePortEndpoints`.

Test file added: [test/modules.test.ts](test/modules.test.ts) — 65
tests across the 8 functional cuts + the Cut 10 router refinement.

Design doc added: [DESIGN-PHASE5-MODULES.md](DESIGN-PHASE5-MODULES.md).

## What's NOT in v1 (deferred items from §14 of the design doc)

These are documented non-goals so the next iteration knows what's
deferred, not forgotten:

- **URL-based module imports.** `import "https://…"` raises
  E_MODULE_URL_UNSUPPORTED.
- **`exposes:` declarations.** Every internal node is addressable; no
  public/private distinction yet.
- **Collapsed-vs-expanded modes.** Modules always render their
  internals.
- **Per-port dock customisation.** `faceSide` is computed from each
  internal node's centroid relative to the module bbox; not author-
  controllable.
- **Frame edge crossing breaks/chamfers.** Edges draw over the frame
  line.
- **Unified parent legend across modules.** Parent legend covers
  parent tags only.
- **CLI `--theme` propagation to modules.** Only the entry file's
  theme.
- **Per-import-site `{ modules: { … } }` frame override.** Theme is
  the only knob.
- **Inside-module advanced renders.** `renderModuleBody` ships a
  subset: regular shapes + internal edges. Skipped at v1: nodesets,
  bend-intersection gradients, via-pair through-segments, path
  highlights, icon shapes inside modules. If a module needs these,
  Cut 9 follow-up is to lift `renderSVG`'s body-emission into a
  reusable function the module renderer can call too.

## What's open right now

Functionally complete and signed off:
- Phase 4 + 4.1–4.6 + 5.0–5.5 (theming, legend, titles, icons, tag
  driven per-node theming, gradients, modules). 521 passing + 3
  skipped.

**3 still-skipped track tests** in
[test/tracks.test.ts](test/tracks.test.ts) — legacy forced-crossing
topologies. Carried over from earlier sessions.

**Pre-existing tsc warnings** (3 errors in `svg.ts` + `theme.ts` —
unrelated to module work, present at session start).

## How to start the next session

1. Read this file (you're doing it).
2. If touching modules code, read
   [DESIGN-PHASE5-MODULES.md](DESIGN-PHASE5-MODULES.md) cover to
   cover.
3. Check feedback memories in
   `C:\Users\jarr2\.claude\projects\c--Users-jarr2-projects-melk\memory\`.
4. `npx vitest run` — should show 521 passing + 3 skipped.
5. `git log --oneline` — module commits are after `8669381` (previous
   handoff).
6. Read [IDEAS.md](IDEAS.md) for remaining ideas. The biggest items
   from the previous session (composable modules, titles, icons) have
   all landed.

## Quick gotchas

- **Layout is sacred.** Theme/tags never change geometry. The
  `modules` theme block adds visual chrome only — frame border and
  optional label. Module footprint is fixed by the per-module
  placement pass.
- **Modules render independently up to placement.** Each module gets
  its own theme, its own layout, its own placer. The parent sees
  opaque cells. Themes don't mix across the `<g>` boundary.
- **Qualified refs `mod.foo` resolve at bind time.** `edge.from` is
  the synthetic module-shape node id (the alias); `edge.fromInternal`
  carries the internal node name for the router.
- **Recursive imports are allowed.** Cycle detection compares
  resolved absolute paths. Diamond imports (two paths to the same
  file) load it twice — each as a fresh placed instance.
- **`importerPath` matters.** The CLI passes `filePath`; tests with
  imports need to pass `importerPath` too (or the loader stub).
- **Chrome suppression is bind-time strip.** A module's `title:`,
  `legend: on`, etc. directives are silently deleted from the
  sub-Model when it's loaded as an import.
- **`buildPolylines` runs twice for modules.** Once during
  `placeModules` (for the module body + port positions), once during
  the parent pipeline (for parent edges). Currently this is
  deliberate — the module body's polylines live on
  `imported.body.polylines`, the parent's live on the top-level
  `polylines` return. They render independently.
- **Module endpoints are resolved by the router.**
  `buildPolylines` now internally calls `buildModulePortIndex` (in
  module-route.ts) and the polyline builder lands directly on the
  internal-node pixel for edges with `fromInternal` / `toInternal`.
  `applyModulePortEndpoints` is kept as a no-op shim for back compat;
  new code does NOT need to call it.
- **Cut 4 → Cut 10 history.** Cut 4 first implemented the endpoint
  translation as a post-pass over polylines, which left the corridor
  trunk planned for face-to-face routing — visible as wild paths
  inside module bodies (especially on the platform demo's
  observability taps). Cut 10 moved the translation into the
  polyline builder so the trunk routes around the *real* endpoints.
  Same data flow, no API break.
