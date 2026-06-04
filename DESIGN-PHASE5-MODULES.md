# melk — Phase 5 design: composable modules

**Status:** spec (not yet implemented)
**Builds on:** [DESIGN-PHASE4.md](DESIGN-PHASE4.md), [DESIGN-PHASE5-THEMING.md](DESIGN-PHASE5-THEMING.md), [DESIGN-PHASE5-LEGEND.md](DESIGN-PHASE5-LEGEND.md).
**Touches:** parser (one new top-level directive, qualified node refs), bind (recursive load + per-module bind/place + namespace + cycle detection), placer (module-as-opaque-cell with port table), renderer (`<g transform>` wrapping per module, parent edges through the frame), CLI (multi-file load).

melk diagrams have so far been single-file. Real architectures decompose: a `payments` subsystem, an `auth` subsystem, an `ingest` pipeline — each is its own diagram on its own merits, and the top-level picture is *how they connect*. This feature adds **module imports**: one `.melk` file imports another and treats it as a self-contained unit on the parent canvas, with parent-level edges connecting the two.

The design has five pillars:

1. **Modules render independently up to placement.** Each imported module runs through parse→bind→place under its own theme and layout. The parent placer sees the result as a single opaque cell with a known pixel footprint and a known port table. No layout cross-talk between inside-the-module and outside-the-module — the boundary is hard. This is the same separation the user previously achieved by rendering Mermaid diagrams to SVG and post-processing them together, lifted into the language so cross-module edges become first-class.
2. **Theming follows the same isolation rule.** Each module carries its own resolved theme through to render time. Module internals emit under the module's theme; parent chrome and parent-level nodes/edges emit under the parent's theme. The renderer never has to reconcile two themes inside the same `<g>` — it switches context at the module boundary.
3. **No port declaration.** Any node inside a module is reachable from outside as `module_alias.node_name`. If a parent-level edge references it, it becomes a "port" on that module; otherwise it stays purely internal. There is no `exposes:` directive. This keeps the grammar small and means a `.melk` file is importable without modification.
4. **Edges pass through the frame.** A parent edge targeting `payments.charge_api` terminates at the actual internal node's translated coordinates, not at a perimeter dock. The frame line (if drawn) is purely visual chrome — edges cross it as a straight pass-through. The parent edge router knows where internal nodes live (via the module's port table) but does not know or care about anything else inside the module.
5. **Per-import overrides at the call site.** The importer can override the module's theme, layout, legend, or any other top-level directive at the `import` site with a brace block. Without overrides, the module renders under its own declared theme and layout. With overrides, the import-site values win.

The user-facing surface is one new top-level directive (`import`), one new node-reference form (`module_alias.node_name`), and one optional theme block (`modules: {...}`) for the frame.

---

## 1. The import directive

### 1.1 Grammar

One top-level directive per imported module, alongside `theme:`, `icons:`, `legend:`, etc.:

```
import "./payments.melk" as payments
import "./auth.melk"     as auth     { theme: dark }
import "./ingest.melk"   as ingest   { theme: light, layout: tb }
```

Grammar:

```
import <quoted-path> as <module-alias> [ { <override-list> } ]

<override-list> ::= <override> ( "," <override> )*
<override>      ::= <key> ":" <value>
```

- **Path** is a quoted string. Relative paths resolve relative to the importing file's directory (matches the existing `theme:` and `icons: from` resolution behaviour). Absolute paths are accepted but discouraged.
- **Module alias** is a bare identifier — the name authors use to reference the module's internal nodes later (`payments.charge_api`). Must be a valid melk identifier and unique within the importing file. Re-using an alias is `E_MODULE_ALIAS_DUPLICATE`.
- **Override block** is optional. Inside braces, any directive that would normally appear at the top of a `.melk` file (currently: `theme`, `layout`, `legend`, `title`, `subtitle`, `caption`) can override the module's own value. Keys not listed take the module's declared value (or its default). Unknown keys in the override block are `E_MODULE_OVERRIDE_UNKNOWN`.

Multiple `import` directives in one file are legal and additive. The order doesn't affect rendering.

### 1.2 What gets resolved when

Imports resolve **during bind**, not during parse. The parser emits an `ImportDecl` AST node carrying the quoted path, alias, and raw override list; the binder is responsible for opening the file, recursively running parse→bind→place, and incorporating the resulting placed sub-model.

This boundary matters: parser stays pure (no I/O); bind is the layer that already does I/O (it loads themes and icon packs by relative path). Module loading slots in there naturally.

### 1.3 Path resolution

Path resolution rules (identical to `theme:` and `icons: from`):

- Relative path: resolve against `dirname(importing_file_path)`.
- Absolute path: use as-is.
- URL: **not supported at v1.** `https://` paths in `import` are `E_MODULE_URL_UNSUPPORTED`. (Theme and icon URLs are static assets; module URLs would entangle the bind pipeline with network I/O and are deferred.)

If the resolved path doesn't exist, `E_MODULE_FILE_NOT_FOUND` with the resolved absolute path in the error message.

---

## 2. Qualified node references

### 2.1 Grammar

A node reference that crosses module boundaries uses dot-syntax: `<module_alias>.<node_name>`.

```
# main.melk
import "./payments.melk" as payments

frontend          -> payments.charge_api
payments.receipt  -> email_dispatcher
payments.payout   -> bank
```

- Both sides of an edge can be qualified (`payments.receipt -> auth.session_check`).
- Qualified refs are allowed anywhere a node id is allowed: edges, pipelines, fan-outs, nodesets, paths, branches, buses, `via:` highways.

### 2.2 Resolution

At bind time, when the binder encounters `payments.charge_api`:

1. Look up `payments` in the importing file's module-alias table. Unknown alias is `E_MODULE_ALIAS_UNKNOWN`.
2. The module has by now been recursively bound + placed, so its internal node table is available. Look up `charge_api` in that table. Unknown internal node is `E_MODULE_NODE_UNKNOWN` with the module alias in the error message.
3. The resolved node carries: the internal node id (scoped to the module), its placed pixel coordinates within the module's local SVG, and a back-pointer to the module instance for the renderer.

Internal nodes that are referenced from outside automatically join the module's **port table** — a map from internal node name → local pixel position. The port table is computed once per module at place-time and consulted by the parent edge router.

### 2.3 Unqualified names stay local

Within a module file, unqualified node ids (`api`, `auth_check`) refer to nodes declared in that file. There is no implicit name leakage between files — a `node api` in main.melk and a `node api` in payments.melk are different nodes with no relationship. Cross-module reference is always explicit via the alias.

This means a `.melk` file is importable without modification: nothing about its contents changes when it's loaded as a module versus rendered directly.

---

## 3. The pre-render pipeline

### 3.1 Per-module pipeline

When the binder encounters an `import` directive for `./payments.melk as payments { theme: dark }`:

1. **Load** `./payments.melk` from disk.
2. **Parse** it. (Recursively — if it contains its own `import` directives, they'll surface as `ImportDecl` AST nodes for the next step.)
3. **Bind** it. The bind pass for the module receives an *override context* built from the import-site brace block: theme=dark wins over whatever payments.melk declared. The resulting `Model` carries `themeName: "dark"` regardless of what payments.melk said.
4. **Place** it. The placer runs against the module's `Model` under its overridden theme, producing a `PlacedModel`: pixel-accurate node boxes, polyline geometry for internal edges, and a bounding box for the whole module.
5. **Build the port table.** Walk all *parent-level* qualified refs that target this module (already known because all imports are resolved before any cross-module edge resolution — see §3.2 for the topological order). For each referenced internal node, record `{ nodeName, localX, localY, faceX, faceY, faceSide }` where `face*` is the nearest perimeter point (used by the parent edge router as the entry direction hint).
6. **Wrap as opaque cell.** The placed module gets attached to the importing file's `Model` as a synthetic node with `shape: "module"`, `size: { width: ceil(pixelWidth / 8), height: ceil(pixelHeight / 8) }`, and a hidden `port-table` field. From the parent placer's perspective, it's a sized rect.

The fractional-cell mechanism already in use for icon/circle nodes (per `feedback-icons-and-circles-grow-cells`) handles non-integer footprints cleanly. The pixel pipeline already supports fractional row units.

### 3.2 Resolution order

The binder processes the importing file in this order:

1. Parse the file.
2. Resolve **all** `import` directives first (recursively, depth-first). Each import yields a fully-placed sub-model and a port table stub (empty at this point).
3. Bind the importer's own nodes, edges, tags, etc. — this is when qualified refs like `payments.receipt` get resolved. Each successful resolution populates the relevant module's port table.
4. Place the importer's own nodes (with the synthetic module-shape nodes already injected from step 2).
5. Route the importer's own edges, including those that target ports on module nodes.

The port table is populated *between* steps 3 and 4, so by the time the parent placer runs, every module knows which of its internal nodes are public.

### 3.3 Why this isn't render-to-SVG-then-embed

The user's prior workflow (render each Mermaid diagram to SVG, post-process embed them into a canonical SVG) achieves layout isolation by going all the way through render before composing. melk can achieve the same isolation more efficiently by stopping at *place*: the placer's output is the layout — pixel positions, sizes, polylines — and that's everything the parent placer needs to position the module as an opaque cell.

The render step (turning a placed model into SVG strings) happens **once at the end**, after the parent placer has positioned every module. The renderer walks the parent's placed tree depth-first: for each module-shape node, it emits a `<g transform="translate(modX_px, modY_px)">` containing the module's render output, computed by recursively rendering the module's placed sub-model under its own theme. Themes don't mix because they're switched at the `<g>` boundary.

This is more efficient than render-then-reparse (no SVG round-trip) and equally isolated (the placer is the layout-decision step, so isolation there equals isolation overall).

---

## 4. Parent edge routing

### 4.1 Edge attachment

A parent edge `frontend -> payments.charge_api`:

- Source: `frontend`, a parent-level node with a known box.
- Target: `payments.charge_api`, an internal node of the `payments` module.

The target's coordinates in the *parent's* pixel space are:

```
targetX_parent = payments.placedX + chargeApi.localX
targetY_parent = payments.placedY + chargeApi.localY
```

where `payments.placedX/Y` come from the parent placer's positioning of the synthetic module-shape node, and `chargeApi.localX/Y` come from the module's port table.

The parent edge router treats this exactly like any other edge with a known source and target: it builds a polyline from `frontend` to `(targetX_parent, targetY_parent)` using the same `assignSlots → packTracks → polyline` pipeline as every other edge (per `feedback-no-parallel-routing` — modules MUST use the existing routing pipeline, not a parallel one).

### 4.2 Pass-through frame crossing

The parent edge polyline runs from `frontend` straight to the internal node. If the module has a visible frame (see §6), the frame line is drawn behind the edge; the edge passes through with no visual treatment at the crossing. No break, no chamfer, no port stub.

The frame's z-order is below parent-level edges (so edges appear to cross over the frame) but above the module's internal `<g>` body (so the frame draws around the module visually).

### 4.3 Entry direction for the router

The router needs an entry direction to choose an appropriate side for the polyline's final segment. The port table records `faceSide ∈ {N, S, E, W}` for each port — the side of the module's bounding box that's closest to the internal node. The parent router uses this as the *suggested* arrival side, the same way it uses node anchors today.

If the parent edge's geometric direction conflicts with the port's `faceSide` (e.g. port says "approach from W" but the source is to the east), the router can override based on actual geometry — the port hint is a default, not a constraint. (This matches how slot allocation already handles direction-aware assignment.)

### 4.4 No edges between module internals across modules through layout

Edges between two internal-only nodes that happen to be in different modules — e.g. `payments.ledger -> auth.session_log` — work the same way: both endpoints translate through their module's `(placedX, placedY) + (localX, localY)` and become entries in their respective port tables. The parent router builds the polyline. No special path.

### 4.5 Where the translation happens (implementation note)

The translation lives inside `buildOrthogonalPolyline`. When the
polyline builder needs the start/end pixel for an edge, it calls
`portPointFor(edge.from, edge.fromInternal, side, fallback, modulePortIndex)`. Three cases:

1. **Qualified ref** (`fromInternal`/`toInternal` set): returns the named internal node's translated centroid.
2. **Face-to-face module edge** (endpoint is a module-shape node with no internal qualifier): returns the module's *implicit face port* for the corresponding face (N/S/E/W). The face port is the closest internal node's matching face midpoint, computed once at place time.
3. **Non-module endpoint** (or fallback when no port info exists): returns `fallback()` — the normal `slotPixel(side, slot, cell, size, layout)` computation.

This is significant because the corridor sequence is planned BEFORE the polyline builder runs (in `reserveCorridors`, using cell coordinates). The corridor reservation treats the synthetic module cell as an opaque box and chooses entry/exit faces based on the cell geometry. The polyline builder then materialises the corridor sequence into pixel waypoints — and at THAT point, the source/target pixel is the actual internal port, not the cell face slot. The result is a clean L-bend inside the module body: the trace runs along the planned corridor at the corridor's track perp coord, then bends perpendicular at the corridor's exit to reach the internal node.

An earlier implementation pass translated the endpoints AFTER the polyline was built, which left the trunk planned for face-to-face routing and produced visibly weird inner-module zigzags. That post-pass (`applyModulePortEndpoints` in `src/layout/module-route.ts`) is retained as a no-op shim for back compat but does nothing in practice — the router lands the trace correctly on its own.

### 4.6.0 Qualified-ref side override

The corridor reservation picks each edge's source/target side from the cell-delta direction (or a tie-break on equal magnitudes). That works well for regular nodes — they're small, so the picked face is close to the node's centroid. For modules, the synthetic cell is much larger than any internal node, so a tie-break that picks (say) `sourceSide = W` can force a trace that started at a centrally-located internal node to detour west across most of the module body before turning toward the target.

Concrete: in the platform demo, `compute.aggregator -> observability.signals` connects aggregator (in the middle of compute) to signals (in obs which sits diagonally SW of compute). The cell delta is `(1, -1)` — equal magnitudes, tie-break to compute's local forward axis E, then dCol=-1 picks W. The trace exited aggregator westward, ran across compute's body next to dispatch, exited compute's W face, then routed south to obs. Visually: a spurious trace right next to dispatch.

Fix: when an edge has `fromInternal` (or `toInternal`), override the corresponding side using `pickModuleFaceForInternal`. The picker scores each face by:

```
score(face) = perpendicular_distance(internal_node, face)
            − DIR_BONUS × (face matches cell-delta direction)
```

The minimum-score face wins. The directional bonus (a large constant) ensures direction-correct faces beat "closer but wrong direction" faces. Within direction-correct faces, the closer one to the internal node wins.

For aggregator (compute-local x=368, y=64) → obs (south-west cell delta): score N=64, S=64−DIR=very-low, E=144, W=368−DIR=less-low. Min = S. Exit through compute's S face — clean L-bend from aggregator down to obs.

For `frontend → m.api` where api is on m's W face: cell delta is east (frontend west of m), so the source side for frontend's E face matches direction. Target side: the trace approaches m from the west, so the picker for m's target side flips the cell delta (`-(dRow, dCol)` = west). Picker scores W as direction-correct AND api is right there (distance 0). Min = W. Clean entry through api's W face.

Non-qualified module edges (face-to-face) keep the standard `assignSides(edgeFwd)` result — the face port system (§4.6) then handles the slot pixel by snapping to the closest visible internal node's face midpoint.

### 4.6 Implicit face ports — why and how

Before the face port refinement, a face-to-face module edge (no qualified ref) entered/exited at the synthetic cell's geometric face center. Two failure modes:

- **Confused trace origin.** The cell face center often happened to align with an internal node's matching face by geometric coincidence (because the module's content centroid tends to sit near the cell centroid). The trace then *looked* like it was leaving that internal node, even though the author didn't name it. A reader couldn't tell from the diagram whether the edge was "from the module as a whole" or "from this specific internal node".
- **Dangling traces.** When the closest internal node DIDN'T align with the face center, the trace looked like it dove into empty space — terminating in a gap between two internal nodes.

Both modes are aesthetic, not correctness — the routing was geometrically consistent. But they made cross-module diagrams hard to read.

The fix: for each module at place time, compute implicit face ports — for each cardinal direction, a list of candidate ports, one per visible internal node. The polyline builder computes the slot's intended pixel via the standard `slotPixel` (the synthetic cell's face slot) and snaps it to the closest candidate by perpendicular-axis distance. Net behaviour:

- **Single incoming edge:** the slot is centered on the face; snaps to the candidate closest to the face center.
- **Multiple incoming edges:** the slot allocator orders them spatially by opposite-endpoint perp coord, placing each at a distinct physical position along the face. Each then snaps to the candidate closest to its own slot pixel — so the edges naturally distribute across distinct internal nodes' face midpoints in spatial order.
- **Stacking** (multiple edges close together): edges that get nearby slots snap to the same candidate. Predictable; no crash.

Definitions of the candidate list:
- **W face candidates:** every visible internal node's west face midpoint, sorted by `(distance to W boundary asc, y asc)`.
- **E face candidates:** every visible internal node's east face midpoint, sorted by `(distance to E boundary asc, y asc)`.
- **N face candidates:** every visible internal node's north face midpoint, sorted by `(distance to N boundary asc, x asc)`.
- **S face candidates:** every visible internal node's south face midpoint, sorted by `(distance to S boundary asc, x asc)`.

"Distance to face" is the perpendicular distance from the node's bounding box edge to the module's outer edge on that side. Nodes that touch the face (distance 0) come first; then nodes one row inward; and so on. Within a tied distance bucket, nodes are sorted by their position along the face axis so the spatial order matches the eye's reading order on that face.

Excluded: highway nodes (routing-only, no visible mark) and nested module-shape nodes (would need their own face port resolution, deferred). When a module has zero visible internals (e.g. only highways), the candidate lists are empty and the polyline builder falls back to the synthetic cell's face slot — same as before.

For a module placed in the parent canvas, face ports give the author a strong cue: "the edge `frontend → payments` enters payments at its westmost spine node" — even though the author never named that node. If three edges all enter payments' west face, they distribute across the three westernmost internal nodes. The router does the right thing automatically, and the diagram tells a consistent story.

---

## 5. Recursion and cycle detection

### 5.1 Recursive imports allowed

A module can itself contain `import` directives. A imports B imports C is the normal case; the binder handles it via depth-first recursion. Each level of import is independently bound and placed, then handed up to its importer as an opaque cell.

### 5.2 Cycle detection

A imports B imports A is a cycle. The binder maintains a **load stack** during recursive import resolution: when entering a file, push its absolute path; when leaving, pop. If a path being pushed is already on the stack, emit `E_MODULE_CYCLE` with the full cycle in the message:

```
E_MODULE_CYCLE: import cycle detected
  /path/to/a.melk
    imports /path/to/b.melk
    imports /path/to/a.melk   <- cycle here
```

The cycle is reported as soon as it's detected; no partial render. This is a build-stop error, not a warning.

Self-imports (A imports A) are the trivial cycle and report the same error.

### 5.3 Identity, not just paths

Cycle detection compares **resolved absolute paths**, so `import "./x.melk"` and `import "../foo/x.melk"` from different locations resolving to the same file count as the same module. (This also means a diamond — main imports A imports common, main imports B imports common — works correctly: `common.melk` is loaded twice as two independent placed instances, since each importer's overrides may differ. See §5.4.)

### 5.4 Two imports of the same file = two independent instances

If `main.melk` does:

```
import "./component.melk" as foo
import "./component.melk" as bar { theme: dark }
```

…the binder loads `component.melk` twice. Each import is a fresh parse + bind + place under its own override context. They are positioned independently on the parent canvas and have separate port tables. The parser/binder does not attempt to deduplicate — overrides could differ, and even if they didn't, the placed copies are still independent visual entities.

(A future caching pass could skip re-parsing for identical override sets if performance matters; deferred.)

---

## 6. Module frame visual

### 6.1 No frame by default

A placed module renders as just its internal SVG inside the `<g transform>`. There is no border, label, or other chrome by default. The author sees the same visual they'd get if they rendered the module standalone, just positioned within the parent canvas.

This matches the "modules render independently" mental model: a parent canvas with two modules and a connecting edge should visually read as two diagrams with a connector, not as two boxed sub-diagrams.

### 6.2 Theme opt-in: `modules` theme block

A theme can opt into a frame via a new top-level `modules` block:

```json
{
  "modules": {
    "border": "ink-secondary",
    "border-width": 1.0,
    "dash": [4, 3],
    "label-position": "top-left",
    "label-weight": 500,
    "padding": 8
  }
}
```

Slots:

- `border` — colour token or hex; absent or `null` means no border drawn.
- `border-width` — px number; default 1.0.
- `dash` — array of px or `null`; default `null` (solid).
- `label-position` — `"top-left" | "top-center" | "top-right" | null`; the import alias (`payments`) is drawn here. `null` means no label even if border is set.
- `label-weight` — 100–900 int for the label text weight; defaults to theme's default text weight.
- `padding` — extra pixel space inside the frame around the module's internal content; default 0. Useful when the frame border would otherwise touch internal nodes.

When `border` is set, the renderer draws a rect of the module's pixel size (plus `padding` on all four sides) at z-order between internal body and parent edges. The label, if positioned, draws on the same z-layer as the border.

### 6.3 Per-import frame override

A theme-level `modules` block applies to all imported modules. To opt one module out of the frame, an import-site override:

```
import "./payments.melk" as payments { modules: { border: null } }
```

Override merge semantics: the import-site `modules` block is shallow-merged into the parent theme's `modules` block. So `{ modules: { border: null } }` removes the border while keeping the dash/label settings from the theme (though they're moot without a border).

### 6.4 Frame is purely visual; layout is unaware

The frame is drawn at render time only. The placer's grid does not include the frame in any sizing calculation — module size is the module's content footprint plus optional `padding` (which IS in the placer's footprint). The frame border draws on the padding boundary, so it doesn't add further size beyond what `padding` already contributed.

---

## 7. Legend

### 7.1 Parent-level only

A `legend: on` directive in a module file is **suppressed when that module is imported**. The legend is rendered only when the file is the entry point — i.e. when its own `Model.legend === "on"` and it isn't being treated as an imported module.

This matches the "modules render independently up to place" philosophy: legend is a render-time chrome feature (it's drawn on the canvas extension), so suppressing it during the imported-render is consistent with treating the module as an opaque cell on the parent.

### 7.2 Parent legend covers parent-level tags only

If `main.melk` has `legend: on`, the legend it draws covers the tags used by **parent-level** nodes/edges only. Tags used inside imported modules don't appear in the parent legend, even if the module is using the same theme. Two reasons:

1. Modules can be under different themes. A tag named `critical` might mean two different things visually in `payments` (red, gradient) and `auth` (orange, solid). A unified legend can't honestly represent both.
2. The legend is a key to the *parent's* visual vocabulary. Tags that appear only inside a sealed module are part of that module's vocabulary, not the parent's.

### 7.3 No suppression error

If a module is loaded standalone (run directly through `melk render module.melk`), its `legend: on` directive works as it always has. Suppression only kicks in when the module is being imported. No error is raised — the directive is silently ignored in the imported context. (Authors should expect this; documented in the design and the spec.)

### 7.4 v2 idea: unified legend with theme reconciliation

If real usage demands it, a future iteration could add `legend: unified` at the parent level, pulling captions from all module themes and visibly disambiguating colliding tag names. Deferred until requested.

---

## 8. Titles, subtitles, captions

Same rule as legend: title/subtitle/caption in a module file are suppressed when imported. The parent renders only its own title/subtitle/caption strips.

This is consistent because titles are also canvas-extension chrome — they're not part of the module's "placed content", they're metadata about the rendered output. When a module becomes part of a larger output, its metadata gives way to the parent's.

---

## 9. Layout and theme override semantics

### 9.1 Override scope

The brace block on an `import` directive accepts the same top-level directives that a `.melk` file accepts at its root. Specifically v1:

- `theme: <name>` — picks a different theme for the module.
- `layout: lr | tb` — overrides the module's layout direction.
- `legend: on | off` — moot (always suppressed on import per §7), but accepted for clarity. Has no effect.
- `title: "..."` / `subtitle: "..."` / `caption: "..."` — moot (always suppressed on import per §8), but accepted. No effect.
- `modules: { ... }` — overrides theme frame settings for this specific module (see §6.3).

Unknown keys in the override block are `E_MODULE_OVERRIDE_UNKNOWN`. This is strict to prevent typos from silently doing nothing.

### 9.2 Theme override resolution

When the import-site says `theme: dark`, the binder resolves the theme name the same way the module would have if it were rendered standalone — relative to the module's directory, not the importer's. This means `theme: corporate` in an import will load `module_dir/corporate.json` if it exists, not `importer_dir/corporate.json`.

Rationale: themes are typically co-located with the files that use them, and the import is asking "render this module as if it had been told to use the `corporate` theme on its own".

(Edge case: if the theme name doesn't resolve in the module's directory, fall back to the importer's directory. This handles the case of a shared theme dir in the parent's tree. If neither resolves, `E_THEME_NOT_FOUND` as usual.)

### 9.3 Layout override is straightforward rotation

The isometric-primitives rule (per `feedback-isometric-primitives`) guarantees that swapping `layout: lr ↔ tb` rotates the diagram with no other edits. So overriding the module's layout is just: pass the overridden layout direction into the module's bind context. The placer takes over from there.

The rotation happens at module-place time, so the resulting opaque cell has dimensions that match the chosen layout. A module that's "wide" in LR becomes "tall" in TB; the parent placer sizes the synthetic node accordingly.

---

## 10. Model shape (types)

### 10.1 New AST node

```ts
type ImportDecl = {
  kind: "ImportDecl";
  path: string;        // raw quoted path from source
  alias: string;       // module alias identifier
  overrides: Map<string, RawDirective>;  // raw override block, key → directive
  span: Span;
};
```

`RawDirective` is the existing AST type for top-level directives, kept un-bound so the binder can apply it to the module's bind context at the right moment.

### 10.2 New model fields on importer

```ts
type Model = {
  // ... existing fields
  modules: Map<string, ImportedModule>;  // alias → loaded module
};

type ImportedModule = {
  alias: string;
  resolvedPath: string;  // absolute path on disk
  placedModel: PlacedModel;  // the module's place output
  resolvedTheme: ResolvedTheme;  // theme used at module's render time
  ports: Map<string, ModulePort>;  // populated during parent bind
  // The synthetic placeholder node injected into the importer's Model.nodes:
  syntheticNodeId: string;
};

type ModulePort = {
  internalNodeId: string;
  localX: number;       // px, within the module's local frame
  localY: number;
  faceSide: "N" | "S" | "E" | "W";
};
```

### 10.3 New shape kind

`ModelNode.shape` gains a new variant `"module"`. The placer treats it as a sized rect for layout purposes (it has known `size.width × size.height` in grid cells). The renderer dispatches on `shape: "module"` to the new module-emission path (§11).

The shape kind itself is internal — authors don't write `shape: module`. It's set by the binder when injecting the synthetic node for an `ImportDecl`.

---

## 11. Renderer

### 11.1 Pipeline

1. Render parent's canvas chrome (legend, title, etc.) into a base SVG document.
2. Walk parent's placed nodes:
   - For non-module nodes: emit as today.
   - For module nodes: emit `<g transform="translate(modX_px, modY_px)">`, recursively render the module's placed sub-model under the module's resolved theme into a child SVG fragment, append the fragment inside the `<g>`.
3. Render module frame (if `modules.border` is set) inside the `<g>`, at z-order above the body but below the closing `</g>`.
4. Render parent edges last (highest z-layer among non-chrome elements) so they draw over any frame lines.

### 11.2 Theme switching at the `<g>` boundary

The renderer holds a "current theme" through its walk. On entering a `<g>` for a module, it pushes the module's resolved theme; on leaving, it pops. All paint resolution (fills, borders, icon tints, gradients) inside the `<g>` consults the pushed theme.

Gradient `<defs>` are still pre-walked into a single root-level `<defs>` block (per the existing pre-walk rule from `next-session.md`). Definitions from module renders are namespaced with the module alias as a prefix on the gradient id, so two modules can use the same gradient definition without id collisions.

### 11.3 Internal SVG offset

The module's placed sub-model has its own coordinate system starting at (0, 0). The `<g transform="translate(modX_px, modY_px)">` does the offset; internal coordinates inside the `<g>` don't need to be rewritten.

### 11.4 Internal edges don't cross modules

Edges that are internal to a module (both endpoints inside the same module) are part of the module's placed sub-model. They render inside the module's `<g>` and never touch the parent's edge list.

Parent edges (at least one endpoint outside the module, or endpoints in different modules) render at the parent level, in the parent's coordinate system, using translated coordinates.

The clean split: a placed module owns its own internal edges; the parent owns inter-module edges and edges between modules and parent-level nodes.

---

## 12. CLI

### 12.1 Loading

`melk render main.melk` loads `main.melk` as the entry point. Any `import` directives in `main.melk` recursively load their files via the binder. No CLI changes for the basic case.

### 12.2 `--no-network` and other flags

`--no-network` continues to apply to icon packs only (since module imports don't accept URLs). `--theme=` at the CLI applies to the entry-point file only — it overrides the entry file's `theme:` directive but does NOT propagate as an override to imported modules. (Modules' themes are governed by their own `theme:` directive and the import-site brace overrides; CLI-level theme is a parent-only knob.)

If real usage wants CLI propagation to all modules, a future `--theme-all=...` flag could do that; deferred.

### 12.3 Error reporting with file paths

All bind errors that occur inside an imported module are decorated with the import chain in the error message:

```
E_NODE_UNDECLARED: node 'foo' is referenced but not declared
  in /path/to/payments.melk:42
  imported by /path/to/main.melk:3
```

This is critical for debugging multi-file diagrams. The bind layer maintains an import stack (the same one used for cycle detection) and prepends it to every error originating below the entry file.

---

## 13. Error codes (new)

- `E_MODULE_FILE_NOT_FOUND` — import path doesn't resolve to an existing file.
- `E_MODULE_ALIAS_DUPLICATE` — same alias used in two `import` directives in one file.
- `E_MODULE_ALIAS_UNKNOWN` — qualified ref uses an alias that wasn't imported.
- `E_MODULE_NODE_UNKNOWN` — qualified ref names a node that doesn't exist in the imported module.
- `E_MODULE_OVERRIDE_UNKNOWN` — override block contains a key not in the allowed-override set.
- `E_MODULE_CYCLE` — import cycle detected; message includes the full cycle.
- `E_MODULE_URL_UNSUPPORTED` — `import "https://..."` attempted; URL imports are not supported at v1.

All existing bind errors (E_NODE_UNDECLARED, E_THEME_NOT_FOUND, etc.) propagate up through the import chain with decoration (§12.3).

---

## 14. Out of scope for v1

Explicit non-goals so the next iteration knows what's deferred, not forgotten:

- **URL-based module imports.** Modules are local-file only at v1. URLs add a dependency on the bind pipeline for network I/O which we haven't paid for elsewhere; defer.
- **`exposes:` declarations.** Any internal node is reachable. No public/private distinction at v1. If real usage finds that too leaky, a future `exposes:` directive can add a public/private split.
- **Collapsed-vs-expanded import modes.** Modules always render their internals (expanded). If a black-box look is wanted, the author writes a module file containing a single node — the result is visually equivalent to a "collapsed" module.
- **Per-port dock customisation.** Internal nodes don't get author-controlled face hints. Ports dock at the internal node's actual position; the parent edge router uses the `faceSide` heuristic for entry direction.
- **Frame edge crossing breaks / chamfers / notches.** Frame line is a straight pass-through; edges draw over it. If clarity becomes a problem, frame-break logic can be added later as a theme opt-in.
- **Unified parent legend across modules.** Parent legend covers parent tags only; module tags don't bleed up. If wanted later, `legend: unified` with theme reconciliation is the v2 path.
- **CLI `--theme` propagation to all modules.** CLI theme applies to the entry file only at v1.
- **Module-level caching during repeat imports.** Each import is a fresh parse + bind + place. If two imports of the same file with identical overrides becomes a measurable cost, add a cache later.
- **Module imports inside library / "shape pack" style use.** A module is a diagram fragment; it's not yet a way to define reusable shape kinds. The shape-pack idea remains a separate future direction.

---

## 15. Implementation cuts

Numbered cuts with tests between (per `feedback-shape-of-feature-questions-first`):

**Cut 1 — Parser + AST.** Add the `import` directive grammar, the `ImportDecl` AST node, and qualified node-ref support (`alias.name`) wherever node refs are accepted. Tests: parse a file with imports + qualified refs, check the AST shape; bad grammar gives parse errors.

**Cut 2 — Binder load + cycle detection.** Implement recursive file loading in the binder. Add the import-load stack, cycle detection (`E_MODULE_CYCLE`), and basic alias-resolution (`E_MODULE_ALIAS_DUPLICATE`, `E_MODULE_ALIAS_UNKNOWN`). At this cut, qualified refs resolve to placeholder nodes — no per-module place yet. Tests: cycle detection, alias duplication, missing alias, file-not-found.

**Cut 3 — Per-module place + port table.** Run parse→bind→place per imported module under override context; build the port table from parent's qualified refs; inject synthetic module-shape nodes into the parent's Model. Tests: a parent with one module imports correctly; the synthetic node has the right size; port table has the right entries.

**Cut 4 — Parent edges to module internals.** Extend the parent edge router to translate qualified-ref targets through the port table to parent pixel coordinates. Tests: edge endpoint coordinates match `(modPlaced + portLocal)`; edge polyline crosses frame correctly.

**Cut 5 — Renderer module emission.** Emit `<g transform>` for each module; render internals under module theme; theme stack push/pop on entry/exit. Gradient defs namespaced. Tests: golden SVG for a two-module diagram; theme isolation (different themes per module render with their own colours).

**Cut 6 — Frame visual (theme `modules` block).** Add the `modules` theme block and frame emission. Tests: frame draws when border set; no frame when not; per-import frame override merges correctly.

**Cut 7 — Suppression of chrome on import.** Legend, title, subtitle, caption directives are silently ignored when a file is loaded as a module. Tests: a module that declares `legend: on` doesn't emit a legend when imported; same module emits legend when rendered standalone.

**Cut 8 — Error decoration with import chain.** All bind errors originating inside an imported module are decorated with the import chain. Tests: error message includes both the inner file and the importer chain.

**Cut 9 — Demo + docs.** Add `examples/33-modules-basic.melk` (two-module composition under one theme) and `examples/34-modules-themed.melk` (two modules under different themes). Regenerate goldens. Update CLAUDE.md and next-session.md.

Each cut leaves the tree in a passing state. Between cuts, run `npx vitest run` to confirm; only proceed to the next cut once green.

---

## 16. Open questions deferred to implementation

These are questions where the design says "decide during implementation based on what the code wants":

- **Where exactly the synthetic module-shape node sits in the parent's bind order.** It needs to be visible to the parent's tag resolution (a tag could theoretically apply to a module-shape node) but probably shouldn't be tag-able at v1. Likely answer: inject after parent-level node declaration, before tag application, and skip tag resolution for `shape: module`.
- **Whether the placer needs a new "fixed-size cell" path** for module-shape nodes, or whether the existing `size:` directive handling already covers fractional fixed sizes. Most likely the existing path covers it (icons and circles already use fractional sizes).
- **Z-ordering of frame vs gradients on parent-level nodes overlapping the frame area.** Frame is between module body and parent edges, so it draws below parent nodes if any happen to be placed inside the frame's bbox. That shouldn't happen by construction (the module is an opaque cell to the parent placer), but worth a guard test.
- **Whether `modules: { ... }` belongs in the theme JSON top level or nested under `chrome:` / `frames:`.** Will follow the existing theme JSON conventions; check where `legend:` and `titles:` sit and match.

These are noted, not blockers — the cut sequence will surface what the right choice is.
