# melk — design document

**Status:** Phase 1 complete
**Date:** 2026-05-27

A text-first architectural diagramming system. Output looks engineered, not knotted — Manhattan routing through proper channels, deterministic layout, clean back-edges. Built around three structural primitives (`spine`, `lane`, `group`) that don't exist as first-class concepts in prior art.

---

## 1. Goals (Phase 1 scope)

A CLI that reads a `.melk` file and writes an `.svg`. Top-to-bottom and left-to-right layouts only. No editor, no lanes, no groups, no radial, no composition.

The bar for Phase 1 is **aesthetic, not feature-count**: a small `.melk` file with ~10 nodes and a couple of back-edges should render to an SVG that visibly beats ELK on the things that frustrate the user — back-edges that route backwards, edges that leave appropriate sides, channels that read as engineered.

Out of scope for Phase 1, but the design must not preclude them: lanes, groups with named ports, radial layout, composition/imports, the bidirectional editor, PNG/WebGPU backends, style files, the atomic shape library.

## 2. Pipeline

```
┌──────────┐   ┌──────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌─────────┐
│  parse   │──▶│ bind │──▶│  layout  │──▶│ visgraph  │──▶│  route   │──▶│ render  │
│  .melk   │   │      │   │ (WebCola)│   │  (build)  │   │  (A*)    │   │  (SVG)  │
└──────────┘   └──────┘   └──────────┘   └───────────┘   └──────────┘   └─────────┘
   AST          Model       Node              Visibility    Edge          Document
                            geometry          graph         polylines
```

Stages are pure functions of the previous stage's output. Each is independently testable. No stage knows about rendering except the last one; no stage knows about parsing except the first two.

### 2.1 parse → AST

Hand-written recursive-descent parser. The grammar is small enough to not warrant a generator, and hand-written parsers give better error messages, which matter for a DSL meant to be authored by humans.

### 2.2 bind → Model

Resolve names, check references, expand the spine's `.branch` shorthand into explicit edges. Output is an immutable graph: `{ nodes: Node[], edges: Edge[], spine?: SpineConstraint, layoutMode: "tb" | "lr" }`.

### 2.3 layout → Node geometry

**Layered (Sugiyama-style) placement.** Four steps:

1. **Cycle break** — DFS in declaration order; mark edges to nodes currently on the recursion stack as back-edges. Remaining graph is a DAG.
2. **Layer assignment** — longest-path layering on the DAG.
3. **Within-layer ordering** — barycenter sweep (up/down passes) to reduce crossings. Declaration order is the tiebreaker.
4. **Coordinate assignment** — layer `k` sits at a cross-axis position derived from the cumulative max extent of layers `0..k-1` plus `k * layerGap`. Within a layer, slots are placed sequentially with `slotGap` between them, then the row is centered against the longest row.

The result is deterministic — same input always produces the same coords — and rank-aligned: every node in the same layer shares its cross-axis center.

**Why not WebCola.** Tried in an earlier draft; force-directed layouts (even constraint-augmented ones) produce diagonal staircase outputs on linear chains because nothing pins nodes to a row. For the circuit-board aesthetic, rank alignment is non-negotiable, and that's exactly what layered placement gives.

**The spine concept (Phase 2)** maps cleanly onto this model: the spine becomes a designated longest path that drives layer assignment (`weight` on spine edges, à la `dot`), and peripheral nodes layer relative to their spine attachment point.

T-shirt sizing is resolved here. `size: M` looks up `{ width: 120, height: 60 }` from a sizing table; explicit dimensions override. Shape determines hit geometry for the visibility graph (circles inset their bounding box; rectangles use it directly).

### 2.4 visgraph → Visibility graph

The libavoid construction (Wybrow, Marriott, Stuckey, GD 2009). For each obstacle (node) corner, project rays in the four cardinal directions until they hit another obstacle or a boundary. The intersection lattice of those rays plus the corner points forms an **orthogonal visibility graph**: vertices are intersections, edges are unobstructed orthogonal segments.

Per-side ports (`api:north`, `verify:west`) are attached as named vertices on the obstacle's perimeter. An edge in the diagram can be routed to any port; if no port is specified, the router picks one (Wybrow calls this a "pin class").

### 2.5 route → Edge polylines

A* on the visibility graph, once per diagram edge, with cost function:

```
cost(path) = α·length + β·bends + γ·crossings + δ·channel_congestion
```

`crossings` and `channel_congestion` are updated as each edge is routed (later edges see earlier edges' segments). After the initial pass, run **rip-up-and-reroute**: identify the N worst edges by detour ratio, remove them from the channel-occupancy map, route them again in a new order. 3-5 passes is sufficient for diagrams under ~200 edges.

**Back-edges are not special-cased.** They route through whatever channel is cheapest, which is by construction outside the forward-flow band once that band is congested. This is the entire reason we're using a visibility graph instead of a Sugiyama pipeline.

After routing, run a **nudging post-pass**: parallel segments sharing a channel are separated by a small gap so they don't visually merge. Algorithm: for each channel, collect segments, sort by some stable key (e.g., source x-coordinate), distribute across the channel width. This is also from Wybrow's thesis (ch. 4).

### 2.6 render → SVG

Direct emit. Nodes are `<g>` elements with `<rect>`/`<circle>`/`<path>` plus a centered `<text>`. Edges are `<path d="M ... L ... L ...">` polylines with `marker-end` for arrowheads. Edge labels are `<text>` placed **above** the longest horizontal segment of the polyline (perpendicular offset proportional to font size, never overlapping the path).

No CSS classes in Phase 1 — inline attributes only. Keeps the SVG portable (works when embedded in markdown without a stylesheet).

## 3. Grammar (Phase 1 subset)

```
program     := statement*
statement   := node_decl | edge_decl | layout_decl
layout_decl := "layout" ":" ("tb" | "lr")
node_decl   := ident ("{" property* "}")?
edge_decl   := node_ref "->" node_ref ("{" property* "}")?
node_ref    := ident (":" ident)?           # "api" or "api:north"
property    := ident ":" value
value       := ident | string | number
```

Identifiers are `[a-zA-Z_][a-zA-Z0-9_]*`. Strings are double-quoted. No statement terminators — newlines separate. Comments are `#` to end of line.

Phase 1 properties:
- on nodes: `shape` (`rect` | `roundrect` | `circle` | `diamond` | `cylinder`), `size` (`S`|`M`|`L`|`XL` | `{w, h}`), `label`
- on edges: `label`

Example:

```
layout: lr

ingest    { shape: rect,     size: M }
transform { shape: rect,     size: L, label: "ETL pipeline" }
ods       { shape: cylinder, size: L, label: "ODS" }
api       { shape: rect,     size: M }
client    { shape: circle,   size: S }

ingest    -> transform
transform -> ods         { label: "write" }
ods       -> api         { label: "read"  }
api       -> client
client    -> api         { label: "retry" }   # back-edge
```

That last `client -> api` should route as a clean horizontal-then-vertical-then-horizontal channel above or below the main flow, **not** loop forward and wrap.

### 3.1 Grammar shape beyond Phase 1 (for forward compatibility)

Locked in by this design — implementation deferred:

- `spine name: direction { ... }` — top-level container; members are an ordered chain that becomes a chain of equality constraints on the spine axis. `.branch up:`/`.branch down:`/`.branch left:`/`.branch right:` shorthand for peripheral nodes.
- `lane "name": direction { ... }` — separation constraint plus a rendered swimlane.
- `group Name { in: ..., out: ..., ... }` — declares named external ports; the group's bounding rectangle is rendered around its children; internal edges connect through ports.
- `import "./x.melk" as Alias` — composition.
- `layout: radial` with `lane "x": sector 0deg..90deg` — Phase 3.

Nothing in the Phase 1 pipeline must contradict these. Specifically: the visibility graph and A* router are layout-agnostic; the layout stage is the only one that needs to grow for lanes/groups/radial.

## 4. Module layout

```
melk/
├── DESIGN.md                  this file
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts                 entry point: melk render <file>
│   ├── parser/
│   │   ├── lexer.ts
│   │   ├── parser.ts
│   │   └── ast.ts             AST types
│   ├── bind/
│   │   ├── model.ts           Model types (Node, Edge, ...)
│   │   └── bind.ts            AST -> Model
│   ├── layout/
│   │   ├── sizing.ts          T-shirt -> {w, h}
│   │   ├── layered.ts         Sugiyama-style node placer
│   │   ├── cola.ts            layered() -> Diagram (thin wrapper)
│   │   └── geometry.ts        Geometry types
│   ├── route/
│   │   ├── visgraph.ts        orthogonal visibility graph
│   │   ├── astar.ts           A* with pluggable cost
│   │   ├── router.ts          per-edge routing + rip-up-and-reroute
│   │   └── nudge.ts           parallel segment separation
│   ├── render/
│   │   └── svg.ts             Document -> SVG string
│   └── shared/
│       └── types.ts
├── examples/
│   ├── 01-simple.melk
│   ├── 02-back-edge.melk
│   └── 03-mixed-shapes.melk
└── test/
    ├── parser.test.ts
    ├── visgraph.test.ts
    ├── router.test.ts         golden-file tests on .melk -> .svg
    └── e2e.test.ts
```

Dependencies: zero runtime deps. `vitest` and `tsx` for dev only. No parser library, no SVG library, no layout library. Keep the dep surface small — this is a tool, not a framework.

## 5. Phase 1 milestones — all complete

1. **M1 — Parser + AST + bind.** Hand-written recursive-descent parser; binder validates shapes/sizes and auto-defaults edge-only nodes.
2. **M2 — Layout.** Originally specced as WebCola; replaced with a layered (Sugiyama-style) placer after WebCola produced diagonal staircases on linear chains. Deterministic, rank-aligned output.
3. **M3 — Visibility graph.** Non-uniform grid sweep; per-node N/S/E/W ports attached via outward edges. Structural invariants tested (no internal vertices, no piercing edges, reachability).
4. **M4 — A* router.** State carries arrival axis for proper bend cost. Cost = α·length + β·bends + γ·crossings + δ·overlap. The δ overlap term was pulled forward from M5 because back-edges otherwise route directly on top of forward edges.
5. **M5 — Rip-up-and-reroute + nudging.** Worst-detour-first rip-up; nudging distributes parallel segments sharing a lattice line across a small perpendicular spread.
6. **M6 — Edge labels + arrowheads + polish.** Labels above the longest segment, with white halo; arrowheads land exactly at the port (polyline tail trimmed by arrow length).
7. **M7 — Golden-file tests.** Three example diagrams (`01-simple`, `02-back-edge`, `03-mixed-shapes`) render byte-identical against committed SVG goldens. Regenerate via `npx tsx scripts/regen-goldens.ts`.

62 tests across 7 files. Zero runtime deps. Clean strict typecheck (`noUncheckedIndexedAccess`, `noImplicitOverride`).

## 6. Decisions log

- **Routing algorithm:** libavoid-style orthogonal visibility graph + A*. Rejected: Lee's algorithm (too slow with rip-up at scale), TSM/Tamassia (max-degree-4 limit, embedding step too heavy), channel routing (requires pre-assigned sides), Sugiyama edge routing (back-edge wrap is the bug).
- **Node layout:** Layered (Sugiyama-style) — cycle-break + longest-path layering + barycenter ordering + deterministic coordinate assignment. Originally specced as WebCola; replaced after M2 because force-directed layouts produced diagonal staircases on linear chains. Sugiyama's back-edge problem is real but lives in *its edge router*, not the node placer — we keep the placer and use a visibility-graph router for edges. This is also HOLA's approach (Kieffer et al., TVCG 2016).
- **Parser:** hand-written. Rejected: nearley/pegjs/chevrotain (overkill for this grammar, worse error messages).
- **Render target:** SVG-direct, no virtual DOM, no React. Rejected: D3 (we don't need its data-binding model; the polylines are already computed).
- **Bidirectional editor model (future):** Sketch-n-Sketch-style structured manipulation. Drags must express through grammar primitives. `offset: [dx, dy]` only when non-zero. Engine-chosen placements stay implicit; deterministic tiebreaker (declaration order).
- **DSL inspiration:** D2's `key: value` / `a -> b` regularity, Structurizr's model/view split (Phase 2+), Penrose's style separation (Phase 2+). Rejected: Mermaid's per-diagram dialects, Graphviz's attribute soup, PlantUML's keyword-per-shape.

## 7. Primary reading list

For the implementer (in priority order):

1. Wybrow, Marriott, Stuckey, *"Orthogonal Connector Routing"*, Graph Drawing 2009 (LNCS 5849) — the routing algorithm.
2. Kieffer, Dwyer, Marriott, Wybrow, *"HOLA: Human-like Orthogonal Network Layout"*, IEEE TVCG 2016 — the aesthetic target, with measurements.
3. Wybrow PhD thesis, Monash 2008, chapter 4 — full algorithm details + nudging.
4. Dwyer, Koren, Marriott, *"IPSep-CoLa: An Incremental Procedure for Separation Constraint Layout of Graphs"*, IEEE TVCG 2006 — the WebCola foundation.
5. Chugh et al., *"Sketch-n-Sketch"* papers — for the future bidirectional editor.
6. Di Battista, Eades, Tamassia, Tollis, *Graph Drawing: Algorithms for the Visualization of Graphs* (Prentice Hall, 1999) — field grounding.

## 8. Open questions for Phase 2+

- Style file format: separate `.melk.style` file with selectors, or inline `style { ... }` block per diagram?
- Atomic shape library: pure data (SVG path + port positions) or scriptable (function that produces geometry given size)?
- Composition: do imported diagrams render in-place or as a single collapsed group with their declared ports? Probably configurable per-import-site.
- Radial layout: separate router (polar visibility graph) or reuse orthogonal router on a rectified annulus? The latter is a real research question; defer.
