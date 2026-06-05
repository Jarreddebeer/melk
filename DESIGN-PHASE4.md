# melk — Phase 4 design: grid-native circuit-board IR

**Status:** active (steps 1–8 complete; Step 9 in flight — added `branch` primitive + isometric refactor in progress)
**Replaces:** the channel-track router from [DESIGN-PHASE3B-CHANNEL.md](DESIGN-PHASE3B-CHANNEL.md), the slot system from [DESIGN-PHASE3-FLUX.md](DESIGN-PHASE3-FLUX.md), the group/lane structural semantics from [DESIGN-PHASE2.md](DESIGN-PHASE2.md), and the layered placer from [DESIGN.md](DESIGN.md).
**Keeps:** the lexer, parser AST shape (with grammar additions), the SVG renderer's emission primitives.

Phase 4 is a from-the-grammar-up rewrite. Phases 1–3b iteratively patched a model whose foundations were wrong: groups were treated as structural elements, the grid was an afterthought enforced by snap-calls, routing tried to *accommodate* bad input rather than reject it. Phase 4 inverts each of those choices.

The five inversions:

1. **Groups (and lanes) become tags** — pure annotations, no layout influence.
2. **The grid is the layout IR** — node positions are `(row, col)`, not pixels.
3. **45° routing is allowed** — the router uses diagonals freely when they help.
4. **The compiler is strict** — circuit-board violations are hard errors, day one.
5. **One coherent algorithm** — parse → bind → place → route channels → render. No patches.

This document is the specification.

---

## 1. The grid

### 1.1 Cell coordinates

Every node sits in a **grid cell**, addressed by `(row, col)` where row and col are integers. The cell at `(0, 0)` is the top-left.

Cell coordinates are the canonical placement IR. Pixels appear only at render time. The render-time conversion is:

```
pixel_x = col * CELL_PX + col_offset
pixel_y = row * CELL_PX + row_offset
```

where `CELL_PX` is the global render pitch — set to **8 px**, equal to `COMB_PITCH`. **Cells are slots.** Moving a node from row `r` to row `r+1` shifts it by exactly one slot pitch, so slot positions on adjacent boxes line up by construction. `col_offset` and `row_offset` are per-column/row pixel offsets that accommodate gutter widths (see §2.4).

### 1.2 Grid neighbours and routing axes

A cell `(r, c)` has eight neighbours: `(r-1, c)`, `(r+1, c)`, `(r, c-1)`, `(r, c+1)` (the four cardinals) and `(r-1, c-1)`, `(r-1, c+1)`, `(r+1, c-1)`, `(r+1, c+1)` (the four diagonals).

The router moves along the eight directions. A single segment of a routed polyline is one of:

- **Horizontal** — same row, different cols.
- **Vertical** — same col, different rows.
- **Diagonal NE/NW/SE/SW** — one cell of row change per cell of col change.

Diagonal segments produce 45° lines at render time. The diagonal is at exactly 45°; "shallow" or "steep" diagonals are not allowed.

### 1.3 Slot ports stay horizontal/vertical

Boxes remain axis-aligned rectangles with comb-tooth slot ports on their four sides. A slot port emits or receives a *perpendicular* segment that's always horizontal (for east/west slots) or vertical (for north/south slots). The first segment of a trace leaving a slot is never diagonal.

Diagonals are used in the *middle* of a route, not at endpoints. This keeps boxes looking like clean rectangles while allowing graceful 45° corridors between them.

### 1.4 The grid is the contract

Two diagrams that bind to the same grid are visually equivalent up to render-time scaling. The user can resize `CELL_PX`, change box dimensions within their grid cells, or re-skin colours, and the diagram's *topology* doesn't move. This is the property that makes a circuit-board IR: the abstract structure is stable.

---

## 2. Placement

### 2.1 The placer's inputs and outputs

**Input:** the bound model — nodes, edges, structured flow declarations (`pipeline`, `bus`, `fan-out`, `back`), declaration order.

**Output:** a `Placement`:

- For each node: a `(row, col)` cell.
- For each row: a height in "row-units" (1, 2, 3, ...).
- For each col: a width in "col-units".
- A list of `PlacementError`s if any were detected.

Row and col units translate to pixels at render time using `CELL_PX` and the per-row/col size.

### 2.2 The placer's job

For each edge `a -> b`:

- If both endpoints have explicit cells (from a `pipeline` or `bus` declaration), respect them.
- Otherwise, place `b` "forward" of `a` along the flow axis (default east).

For each `pipeline name: a -> b -> c`:

- Members occupy consecutive cells along the flow axis at the same row.

For each `bus name: a, b, c -> shared`:

- The fan-in members occupy consecutive rows at the same column.
- `shared` occupies the next column at the median row.

For each `fan-out name: shared -> [a, b, c]`:

- Mirror of bus.

For each `branch name: spine -> [a, b, c]` (or `branch name: spine -> a`):

- Members are placed **perpendicular** to the flow axis, one cell off `spine`'s row/col. Under LR (flow = east), branches stack northward; under TB (flow = south), branches stack westward. Multiple members on the same branch occupy consecutive perpendicular cells outward from the spine. A second `branch` on the same spine node may declare side `south` / `east` to put its members on the opposite face — see §6.4 for the syntax.
- Unlike `fan-out`, `branch` does not advance along the flow axis: each branch member sits at `spine.col` (LR) or `spine.row` (TB), one row/col away from the spine. This is what makes `branch` the right primitive for "side-branch off a pipeline" rather than "next stage downstream."

For each `back: a -> b`:

- `a` and `b` may be in any cells; the back-edge is routed through the rear-facing channel.

### 2.3 Constraints and resolution

Placement is a constraint satisfaction problem:

- Flow constraints (`pipeline` enforces ordering).
- Symmetry preferences (a bus's fan-in members are equidistant from `shared`).
- Declaration-order tiebreak (when two nodes have equal-priority placement candidates, the one declared first wins).
- Adjacency penalty (connected nodes should sit close; unconnected nodes can be far).

The placer runs in three passes:

1. **Anchor pass** — place nodes mentioned in structured declarations (`pipeline`, `bus`, `fan-out`). These have hard positions.
2. **Flow pass** — for each remaining edge, place the target one cell forward of the source, choosing the row that minimises adjacency penalty.
3. **Conflict resolution** — if two nodes claim the same cell, raise `E_AMBIGUOUS_PLACEMENT`.

There is no force-directed or barycentric reordering. The placer is **deterministic** — same input always produces same output, byte-for-byte.

### 2.4 Cell-based box sizing

A box's size is declared in **grid cells**, not pixels. A node declaration carries `size: WxH` meaning W cells wide and H cells tall. Both W and H are positive integers. There are no T-shirt names; the user writes `size: 5x5` or `size: 7x3`.

A box that needs more slot ports than its declared size accommodates raises **E_SIDE_OVERSUBSCRIBED** (see §5). The user fixes the source by increasing the size, splitting the node, or reducing fan-in/out. The placer does not silently grow the box for capacity reasons. Highways and hub-rects (any rect that's the shared of a bus or fan-out) do receive a small `+1` cell parity bump at bind time when their face length and trace count disagree on parity — this is what makes slot positions land on cell centres rather than half-cell offsets.

**Multi-cell occupancy.** A node with `size: WxH` claims a W×H block of cells starting at its anchor cell. Every `rowUnits[r]` and `colUnits[c]` is **always 1**. A taller-than-default node expresses its height via footprint span (its anchor is the top-left of a multi-row block), not by inflating one row's unit count. Two nodes whose footprints overlap collide with E_AMBIGUOUS_PLACEMENT.

Default size when omitted: `5x5` (40×40 px at `CELL_PX = 8`). A 5x5 box renders with comb capacity = 5 slots per side (face length 5 × TRACES_PER_CELL_UNIT = 1 trace per cell-unit). The default is odd so a single-trace face produces a slot at the middle cell's centre — a clean cell-centre coord.

### 2.5 Local forward direction (isometry)

Every primitive (`pipeline`, `bus`, `fan-out`, `branch`, back-edge) has a **forward direction** — one of `N | E | S | W` — that says which way the primitive extends from its anchor. This direction is *local* to the primitive, not the page: it is **not** simply `layout: lr|tb`.

Downstream stages (corridors, slots, tracks, polylines) read forward from the relevant primitive or edge, never from a global flow-axis. This is the **isometry principle**: a `bus` rooted on a south-pointing branch behaves identically to a `bus` rooted on an east-pointing pipeline, modulo a 90° rotation of every coord. Reorienting the whole diagram from LR to TB rotates the entire output without changing any local geometry.

**Propagation rule.** A primitive's forward direction is determined by what anchored its root node:

- A top-level primitive inherits forward from `layout:` — E for LR (default), S for TB.
- A primitive rooted at a node placed by another primitive inherits *that* primitive's forward (recursive).
- A `branch` is a single-member direction change: it anchors one node off the spine on a 90°-rotated axis and gives that node the rotated forward. The `:left`/`:right` suffix picks the rotation (default `:left` = CCW from parent's forward; `:right` = CW). Under LR (parent forward = E), `:left` = N (above the spine); under TB (parent forward = S), `:left` = E (to the right of the spine — the *same* rotation applied to a rotated frame). This is what makes the diagram isometric: swap `layout: lr` → `layout: tb` and every branch rotates with the page, no edits required. Whatever the user wants downstream of the branch — a chain, a fan, another turn — they express using `pipeline`/`bus`/`fan-out`/`branch` composed on the branched member (§6.4).
- A back-edge's forward is `opposite(forward at its source node)`.

Because anchoring forms a DAG (each node is placed by exactly one primitive), the propagation always terminates.

**Storage.** The placer caches forward per node in `Placement.forwardAt: Map<NodeId, Direction>`, populated during the anchor pass. Subsequent stages query the cache; they do not re-derive forward from layout mode or cell deltas. Edges carry their *own* forward — for a forward edge, this is `direction(src.cell → tgt.cell)` after placement; for a back-edge, it's `opposite(forwardAt[src])`.

**Why local-relative side names.** `branch x:left` and `branch x:right` mean "90° from the parent's forward". Absolute cardinal names (north/south/east/west) were rejected: they break isometry under inheritance — a user reading `branch x:south:` on a node sitting on a north-pointing branch would have to compute whether "south" meant page-south or local-south. `left`/`right` are unambiguous relative to the parent's flow. See §11.6.

---

## 3. Channels

Steps 5+6 in the implementation plan, collapsed. Inputs: bound `Model` and the `Placement` from §2. Output: a `Routing` carrying, per edge, a polyline of cell-anchored segments — the cell-path the renderer will draw.

The legacy model (corridors-in-gutters + track packing) is replaced. There are no gutter rows or cols in the layout. Cells are either occupied by a node footprint or empty, and **traces hop through empty cells**.

### 3.1 Cells

The grid is the same `(row, col)` grid the placer produced (§2). After placement, the grid partitions into:

- **Occupied cells**: cells inside some node's footprint.
- **Empty cells**: everything else. These are where traces live.

There are no "gutters" between rows or cols. Spacing between unrelated nodes shows up as empty cell rows/cols the placer left between them (e.g. `MEMBER_GAP = 1` cell between consecutive bus producers). Empty cells are first-class layout citizens — they exist to carry traces.

### 3.2 Channels

A **V-channel** is a maximal vertical run of empty cells in a single column. An **H-channel** is a maximal horizontal run of empty cells in a single row. A column may have multiple V-channel segments separated by node footprints; same for rows.

A channel is 1 cell wide along its perpendicular axis at minimum. It **grows lazily** when multiple traces want to share it: a channel carrying `k` parallel traces along its long axis at the same long-axis range occupies `k` adjacent cells perpendicular. Growth never enters an occupied cell — if the adjacent perpendicular cell is filled, the trace reroutes through a different channel.

### 3.3 Bend cells

A V-channel and an H-channel meet at an empty cell that belongs to both. That cell is a **bend cell** — a trace flowing through one channel can turn into the other there.

**One trace per bend cell.** If two traces both want to bend at the same `(row, col)`, the second-comer reroutes to a different bend cell — even if that means a longer path. Two traces never share a bend.

### 3.4 Routing a single edge

For each non-back edge with placed source `A` at cell `(rA, cA)` and target `B` at cell `(rB, cB)`:

1. **Side assignment** (unchanged from legacy edge-forward rule, see §6.4): the trace exits side `S_A` on `A` and enters side `S_B` on `B`.
2. **Slot assignment** (unchanged from legacy slot allocator): the trace gets a slot index on each face.
3. **Greedy/closest channel routing**:
   - Exit `A`'s face at the slot's pixel position. The first empty cell immediately outside that slot is the trace's **entry cell**.
   - Walk forward through the entry cell's channel. For a face exit on E/W, the channel is the V-channel of the column immediately east/west of `A`; for N/S, it's the H-channel of the row immediately north/south.
   - When the channel reaches `B`'s row (for H-target) or col (for V-target), turn at the **nearest available bend cell** — the bend cell with the smallest forward distance from the entry. "Available" = no other trace has claimed it.
   - Walk the perpendicular channel to `B`'s entry cell (immediately outside `S_B`'s slot). Enter `S_B`'s slot.

Common shapes:

- **Straight** (same row or same col): entry == exit, no bend.
- **L-shape** (different row AND different col): one bend cell.
- **Z-shape or detour**: two or more bend cells, taken when the greedy bend cell is already claimed.

### 3.5 Lazy channel growth

When the router places the first trace in a channel, the trace occupies the 1-cell-wide channel strip. When a second trace wants the same channel:

- If the second trace's segment doesn't overlap the first's along the channel's long axis, both share the 1-cell strip at different long-axis positions. Done.
- If they overlap, the channel **grows by 1 cell** on the perpendicular axis, and the second trace runs in the new sub-strip beside the first.

Growth requires that the adjacent column/row of empty cells exists and is itself unoccupied at the overlapping long-axis range. If not, the trace reroutes through the next-best channel.

### 3.6 Determinism

Trace routing is fully deterministic given the placement:

1. Edges are routed in declaration order.
2. Within each edge, bends are chosen greedily by minimal forward distance from the entry.
3. Channel growth proceeds in declaration order of the traces; trace `k+1` always grows into the cell adjacent to trace `k`.

The same `Model` always produces the same `Routing`.

### 3.7 Pixel layout

The grid is laid out at pixel `CELL_PX` per cell, with no gutter widening:

```
colX[c] = sum(colUnits[0..c-1]) * CELL_PX
rowY[r] = sum(rowUnits[0..r-1]) * CELL_PX
```

For a node at `(r, c)` of size `W × H`:
- left   = `colX[c]`
- top    = `rowY[r]`
- right  = `colX[c] + W * CELL_PX`
- bottom = `rowY[r] + H * CELL_PX`

Slot positions on each face:
- **W face** at slot `s` of a box of height `H`: `(left, top + s * COMB_PITCH + COMB_PITCH/2)` for `s ∈ [0, H)`.
- **E face** mirrors W.
- **N face** at slot `s` of a box of width `W`: `(left + s * COMB_PITCH + COMB_PITCH/2, top)` for `s ∈ [0, W)`.
- **S face** mirrors N.

Trace polylines are emitted by walking the per-edge cell-path: each segment is a straight run through one channel (a V-channel emits a vertical segment, an H-channel emits a horizontal segment). Bends at bend cells become 45° chamfers at render time, radius `COMB_PITCH / 2`.

### 3.8 Errors

| Code | Trigger | What the user does |
|---|---|---|
| `E_NO_CHANNEL` | The cell immediately outside a slot is occupied (slot exits into a wall — node placed flush against another node, no empty cell to enter). | Insert an empty row/col between the nodes (grow `MEMBER_GAP`, resize a neighbour, restructure). |
| `E_UNROUTABLE` | A channel needs more parallel traces than the available adjacent empty cells can host, OR every viable bend cell along a channel is already claimed. | Restructure: split the source/target, grow node sizes so more slots fit on different rows, or rearrange the placement to free up a channel. |

---

## 5. The strict compiler

The compiler refuses to render diagrams that violate circuit-board principles. There are no warnings. Every violation is a hard error with a precise message pointing at the source line.

### 5.1 Errors

| Code | Trigger | What the user does |
|---|---|---|
| `E_NO_CHANNEL` | The cell immediately outside a slot is occupied (no empty cell for the trace to enter). | Insert an empty row/col between the nodes (grow `MEMBER_GAP`, resize a neighbour, restructure). |
| `E_UNROUTABLE` | A channel needs more parallel traces than the adjacent empty cells can host, or every viable bend cell along a channel is already claimed. | Restructure: split source/target, grow node sizes so slots distribute, or rearrange placement to free up a channel. |
| `E_UNDECLARED_BACK_EDGE` | An edge whose source is forward of its target along the flow axis, but isn't marked with `>-` or under a `back:` declaration. | Mark the edge as a back-edge or reverse the declared flow. |
| `E_SIDE_OVERSUBSCRIBED` | A node has more incident edges on one side than fit at the comb pitch within the side's length. | Use a larger T-shirt size, split the node, or rearrange so edges distribute to other sides. |
| `E_AMBIGUOUS_PLACEMENT` | Two nodes are placed in the same grid cell after all passes. | Add an explicit position constraint or restructure the connections. |
| `E_ANCHOR_CONFLICT` | A node is named by two structured-flow declarations that try to place it in different cells (e.g. a pipeline puts it at row 0 col 3, a bus puts it at row 2 col 0). | Pick one role for the node — drop it from one of the constructs, or split into two nodes. |
| `E_DISCONNECTED` | A declared node has no incident edges. | Remove the node or connect it. |
| `E_CYCLE_NO_BACK` | A cycle in the flow graph has no edge marked as a back-edge. | Mark one of the cycle's edges as a back-edge or break the cycle. |
| `E_CROSSINGS_OVER_BUDGET` | The total number of materialised crossings exceeds the configured budget. | Restructure topology to reduce crossings, or raise the budget explicitly. |
| `E_DEPRECATED_TSHIRT_SIZE` | A node declaration uses `size: S` / `M` / `L` / `XL` instead of `size: WxH`. | Convert to cell-based sizing (e.g. `M` → `2x1`, `L` → `3x2`, `XL` → `4x3`). |
| `E_DEPRECATED_LANE` / `E_DEPRECATED_GROUP` / `E_DEPRECATED_TAG` | Source uses a removed keyword (`lane`, `group`, `tag`). | Migrate per §6.7. |
| `E_NODESET_UNKNOWN_NODE` | A `nodeset` references an identifier that is not a declared node. | Declare the node, or remove it from the nodeset. |
| `E_PATH_MISSING_EDGE` | A `path` references a consecutive pair `a -> b` for which no edge exists in the model. | Add the missing edge, or remove the link from the path. |
| `E_PIPELINE_UNKNOWN_NODE` / `E_BUS_UNKNOWN_NODE` / `E_FAN_OUT_UNKNOWN_NODE` | A structured flow declaration names an identifier that is not declared elsewhere. **Note:** the bind step *does* auto-declare structured-flow members the same way it auto-declares edge endpoints; this error fires only if an identifier is later re-used in a way that contradicts the auto-declared shape (currently impossible). Kept reserved for future strict modes. | — |
| `E_DUPLICATE_PIPELINE` / `E_DUPLICATE_BUS` / `E_DUPLICATE_FAN_OUT` / `E_DUPLICATE_NODESET` / `E_DUPLICATE_PATH` | Two declarations of the same kind share a name. | Rename one. |

### 5.2 Crossing budget

By default the crossing budget is **0** — the compiler refuses any diagram requiring a crossing. This is the strictest possible setting and forces the user to produce planar topologies.

The user can raise the budget with a top-level directive:

```
crossings: 4
```

Allowing up to 4 crossings. This is an explicit "I know my topology isn't planar; render it anyway" opt-in.

### 5.3 Why hard errors

The user explicitly said: *"exceptions that violate the principles of the circuit board layout so that the user is forced to fix the source code."* The renderer's job is not to hide topology problems behind clever routing. If a diagram looks wrong, the source is wrong. The compiler's job is to point at the line.

This also kills the entire class of "render produced something ugly; tune cost knobs" debugging loops we hit in Phase 3. There are no cost knobs.

---

## 6. Grammar additions

The Phase 3 grammar is largely preserved. Phase 4 changes the node-size syntax, adds five top-level statement forms, and adds one directive.

### 6.0 Cell-based node sizing

Node declarations replace `size: M` (T-shirt) with `size: WxH` (cells):

```
ingest    { shape: rect, size: 2x1 }
transform { shape: rect, size: 4x2, label: "ETL pipeline" }
ods       { shape: cylinder, size: 3x2 }
```

W and H are positive integers. Omitted size defaults to `1x1`. T-shirt names (S/M/L/XL) are no longer accepted; the parser emits `E_DEPRECATED_TSHIRT_SIZE` pointing the user at the cell form.

### 6.1 `pipeline`

```
pipeline ingest_path: ingest -> transform -> validate -> publish
```

Members occupy consecutive cells along the flow axis at the same row. Members must form a single chain — no branching, no cycles.

### 6.2 `bus` (fan-in)

```
bus power: [producer_a, producer_b, producer_c] -> shared
```

Producers occupy consecutive rows at the same column; `shared` occupies the next column at the median row. The router guarantees parallel traces from each producer to `shared`.

The producer list is bracketed so that bus and fan-out are mirror images at the source level — `bus` brackets the many side on the left, `fan-out` brackets the many side on the right. A bus emits one edge per producer into `shared`.

### 6.3 `fan-out`

```
fan-out broadcast: shared -> [a, b, c]
```

Mirror of bus. Consumers occupy consecutive rows.

### 6.4 `branch`

```
branch enrich-step:       transform -> enrich
branch audit-step:right:  validate  -> audit
```

A `branch` is a **direction change**: it anchors a single member one cell off the spine on a perpendicular axis, and gives that member a rotated local forward. It is not a spine, not a fan, and not a pipeline — it does exactly one thing (turn 90°) and composes with the other primitives for everything else.

The `:side` suffix is either `left` (the default, 90° counter-clockwise from the parent's forward) or `right` (90° clockwise). These names are **local-relative** to the parent's flow direction, not to the page — a `branch x:left:` rooted on an east-flowing pipeline points north, but a `branch x:left:` rooted on a south-flowing pipeline points east. This preserves isometry across reorientations (§2.5, §11.6).

The branch member inherits the rotated forward. Any further primitive rooted at the member — `pipeline`, `bus`, `fan-out`, another `branch` — runs along the branched axis. This is what makes the entire downstream geometry rotate when you swap `layout: lr` ↔ `layout: tb`.

The branch implies exactly one edge: `spine → member`, source `"branch"`. The edge's forward is the branch's forward. Inline `>-` on the member converts it to a back-edge from member to spine.

**No bracketed member list.** Earlier drafts allowed `branch x: spine -> [a, b, c]`, but the geometry that fell out ("members extend outward in a straight line from the spine") was just *a pipeline rotated 90°* — and the spine→a, spine→b, spine→c edge fanning didn't match that geometry, which sent the trace to `c` looping around `a` and `b`. The single-member form forces the user to be explicit about what comes after: if you want a chain, write `pipeline tail: a -> b -> c` rooted on the branched node; if you want a fan, write `fan-out subs: a -> [b, c, d]`; if you want each consumer on its own perpendicular line, write multiple branches off `spine`. The primitives compose.

**Why a separate keyword (not `fan-out` with one consumer).** `fan-out` anchors its consumers *along* its forward axis (the next col under east-forward), at the median row of the consumers — which collides with whatever the parent pipeline puts at the next col. `branch` anchors perpendicular to the parent's forward and consumes no forward cells, so it composes with `pipeline` without conflict. Overloading `fan-out` would dilute the keyword's meaning; see §11.5.

### 6.5 `back`

```
back: sink -> source
```

Declares an explicit back-edge. The router uses the rear-facing channel.

The inline form `a >- b` is equivalent.

### 6.6 Annotations: `nodeset` and `path`

Annotations are pure render-time decoration. They do not influence placement or routing.

```
nodeset dataPlane: ingest, transform, validate, publish
path    fastPath:  ingest -> transform -> publish
```

A `nodeset` is a comma-separated list of node names. It renders as a dashed bounding rectangle drawn around the named members after routing. Members must already exist as declared nodes (bound elsewhere); otherwise the binder raises `E_NODESET_UNKNOWN_NODE`.

A `path` is an arrow-chained list of node names. It renders as a coloured highlight along the edges connecting consecutive members. Every consecutive pair in the chain must correspond to an existing edge in the model (forward or back); otherwise the binder raises `E_PATH_MISSING_EDGE`. `path` does not create edges — it decorates them.

The split into two keywords (rather than a single `tag` with two body shapes) is deliberate: it lets the reader tell at a glance which form an annotation takes, and lets the parser dispatch off the keyword rather than scanning forward to find a `,` or `->`.

### 6.7 `crossings` directive

```
crossings: N
```

Top-level directive setting the crossing budget. Default 0.

### 6.8 Deprecated keywords

`lane`, `group`, and `tag` are removed. The parser accepts each shape for one phase as a deprecation hatch: the parse step records the statement, the bind step raises an error that points at the source line.

- `lane "name": orientation { ... }` → `E_DEPRECATED_LANE`. Migrate by removing the lane (it had no structural role under Phase 4 even before the rename); decorate with `nodeset` if a visual grouping is wanted.
- `group name { ... }` → `E_DEPRECATED_GROUP`. Migrate by lifting the inner statements to the top level and (optionally) wrapping the members in a `nodeset`.
- `tag name: ...` → `E_DEPRECATED_TAG`. Migrate by renaming to `nodeset` (if the body is a comma list) or `path` (if the body is an arrow chain).

Phase 5 removes the deprecation handling.

---

## 7. The algorithm

The full pipeline:

```
source → lexer → parser → bind → place → route channels → render SVG
        ↓        ↓        ↓       ↓         ↓                ↓
       AST      Tags    Model   Placement Routing         SVG string
```

No back-tracking. No iterative refinement. Each stage's output is the next stage's input.

### 7.1 Stage outputs

- **AST** — the parsed source, with nodes, edges, declarations.
- **Model** — bound AST: nodes (with cell size), edges (with provenance: explicit, back-edge, pipeline-implied, bus-implied, fan-out-implied), structured-flow constraints (pipelines / buses / fanOuts as placement directives), and annotations (nodesets / paths) attached for later rendering. Deprecation errors and reference-validation errors (`E_NODESET_UNKNOWN_NODE`, `E_PATH_MISSING_EDGE`) fire here.
- **Placement** — `Map<NodeId, (row, col)>`, row/col unit sizes, lists of placement errors.
- **Routing** — per edge, a polyline of cell-anchored segments produced by the channel router (§3). The renderer translates segments into pixel polylines at SVG-emit time.

### 7.2 Determinism

Every stage is a pure function. Same input → same output, byte-for-byte. Goldens become exact reproductions.

### 7.3 Errors propagate

If placement raises an error, subsequent stages are skipped and the compiler reports the error with the source line and a suggested fix. The renderer does not "best-effort" partial output.

---

## 8. Migration

### 8.1 Existing examples

The 11 Phase 3 examples (`01-simple.melk` through `11-backplane.melk`) stay as-is initially. When the Phase 4 implementation breaks them — which it will, since `lane` and `group` are deprecated and `bus`/`fan-out`/`pipeline` are new — they are edited in-place to use the new primitives. The edited versions become the new goldens.

Example edits:

- `04-spine.melk` becomes a `pipeline:` declaration.
- `05-lanes.melk` uses `nodeset` for lane annotations (which now have no structural role).
- `06-groups.melk` becomes a `nodeset` for the AuthService grouping plus explicit `bus` for fan-in into `verify`.
- `09-fan-hub.melk` becomes a `bus` for the producers + a `fan-out` for the consumers.
- `11-backplane.melk` becomes three pipelines with cross-pipeline edges.

### 8.2 New examples

Phase 4 ships with new examples designed around the new primitives:

- A multi-bus diagram showing how `bus` and `fan-out` compose.
- A diagonal-routing diagram showing where 45° helps.
- A "this would fail under crossings: 0" example showing the strict-compiler errors with a fix.
- An annotations diagram showing `nodeset` for visual grouping and `path` for highlighted routes.

### 8.3 Phase 3 goldens become history

The existing SVG goldens in `examples/*.svg` will be replaced by Phase 4 output. Phase 3 history is preserved in git; not in the working tree.

---

## 9. Out of scope (and deferred to Phase 5)

- **Composition / import.** `import "./auth.melk" as Auth` is deferred. A single file is enough for the rewrite.
- **The bidirectional editor.** Deferred.
- **Radial layouts.** Deferred. Phase 4 is grid-only.
- **Style file separation.** Deferred.
- **Atomic shape library.** Deferred.
- **Variable comb pitch.** Phase 4 uses a single global pitch.

---

## 10. Implementation plan

Approximate work order. Each step is a session of focused work with eyeball checkpoints.

1. **Delete Phase 3 routing code.** `channels.ts`, `channel-assignment.ts`, `track-packing.ts`, `polyline.ts`, `slots.ts`, `merge.ts`, `group-router.ts`, `layered.ts`, `cola.ts`, `groups.ts` all go. Keep parser, AST, bind (with edits), SVG render.
2. **Grammar additions.** `pipeline`, `bus`, `fan-out`, `back`, `nodeset`, `path`, `crossings` directives in the lexer/parser/AST.
3. **Bind to Phase 4 model.** Convert AST into the new Model with placement directives and annotations.
4. **The placer.** Grid placement with anchor → flow → conflict-resolution passes. Emits Placement + errors.
5. **Channel routing.** For each edge, find an empty-cell entry, walk the V/H channels greedily, pick a bend cell, exit at the target slot. Lazy channel growth on collision; deterministic by declaration order.
6. **Polyline emission.** Translate each edge's cell-path into a pixel polyline. Bends at bend cells become 45° chamfers radius `COMB_PITCH / 2`.
7. **Render integration.** SVG renderer takes the polyline list. Annotations (nodeset rectangles, path highlights) render last on top of the routed edges.
9. **Migrate existing examples.** Edit `examples/*.melk` to use new primitives. Regenerate goldens. (During Step 9 the `branch` anchor primitive was added to handle perpendicular side-shoots that `pipeline + fan-out` cannot express — see §6.4 and §11.5. The first eyeball checkpoint on a branched example surfaced an axis-bias bug in `corridorSequence`, which triggered a deeper refactor: primitives now use **local forward direction** rather than the global flow axis, restoring isometry under inheritance — see §2.5, §3.3 rewrite, and §11.6.)
10. **Phase 4 example set.** Author new examples that exercise `bus`, `fan-out`, diagonals, tags, error paths.

Estimated effort: ~3 weeks of focused work with eyeball checkpoints after steps 4, 6, 8, and 10.

---

## 11. Decisions

### 11.1 Locked

- **Diagonal control.** The router uses diagonals freely when they help; no per-edge user opt-in.
- **Strict mode.** Hard errors from day one; no warnings, no opt-in strict mode.
- **Migration.** Existing examples (a) initially, fix on break (b), plus new Phase 4 examples (c).
- **Crossing budget default.** **0** at start. Forces planar topologies; the user opts in with the `crossings: N` directive when they accept non-planarity.
- **Box size expressed in cells.** T-shirt sizes are replaced by **"N cells wide × M cells tall"**. The grammar shifts: a node declaration carries `size: 2x1` (2 cells wide, 1 cell tall) rather than `size: M`. Cell-based sizing is grid-native and removes the pixel/grid translation step at parse time. Pixel rendering remains a render-time scaling factor (`CELL_PX`).
- **Annotations are two keywords, not one.** What was originally drafted as `tag` (with the body shape disambiguated by `,` vs `->`) became two keywords during Step 3 design review: `nodeset` for the comma-list form and `path` for the arrow-chain form. The two forms have meaningfully different semantics (one decorates *nodes*, one decorates *edges*) and the parser benefits from dispatching off the keyword. Both render the same way as the original tag forms.
- **Back-edges may use diagonals.** Back-edges take the rear face of source and target, and the rear-facing corridor may carry diagonal segments like any other corridor. The router decides on a per-route basis.
- **Cartesian grid, not hex.** Considered a hex grid for symmetry of the 8-neighbour distance metric, but rejected because: boxes are rectangles (they don't fit hex cells), hex grids have 6 directions not 8 (no straight north/south), SVG and most tooling assume Cartesian. The asymmetry of cardinal-vs-diagonal distance is handled in the router's cost function (diagonals charge √2 length units).

### 11.2 Resolved during Step 5

- **Slot-index assignment lives in Step 5.** Step 5 owns side + slot-index per edge endpoint; Step 6 (track packing) only assigns track positions within corridors and materialises crossings. Slot demand drives `E_SIDE_OVERSUBSCRIBED`, which is detectable before any track packing — earlier is better for diagnostics.
- **Strict cardinal side rule.** Source/target sides are decided by the relative cell positions per §3.3. Corner exits are not used — diagonal segments live *inside* corridors (§3.4), never at slot ports. Keeps box rendering rectangles-with-comb-teeth (§1.3) regardless of corridor choice.
- **Diagonals off by default in Step 5.** The corridor graph contains diagonal corridors and the cost function checks them, but the cutover threshold defaults so high that Step 5 always picks the orthogonal route. Lets us land deterministic Manhattan routing and use diagonals as a separate eyeball checkpoint after the orthogonal pass is observed correct.
- **Crossings live in Step 6.** Step 5 counts corridor demand only. Two traces sharing a corridor with non-monotone perp orderings are crossings the track packer will materialise; Step 5 records demand so the gutter is wide enough.

### 11.3 Resolved during Step 6

- **Demand counting stays union-count, intentionally generous.** Step 5's per-corridor demand is the number of distinct traces that include the corridor in their sequence, even when those traces don't all overlap geometrically. This over-widens the gutter relative to the strict max-cross-section but produces visually clean fans (the typical bus / fan-out cluster). Step 6 does precise interval-scheduling for *track assignment* within corridors, but does NOT re-derive demand. See `feedback-generous-gutters.md`.
- **Track index is ordinal.** Step 6 emits track ∈ {1, 2, 3, …} per corridor. Pixel translation lives in Step 7/8 via `COMB_PITCH`. Keeps Step 6 pixel-free, easy to test, and uncoupled from render-time pitch changes.
- **Crossings = per-corridor inversion count.** Sort traces in a corridor by entryPerp; count inversions in the exitPerp sequence. Materialise each at the corridor's long-axis midpoint. Total compared against `model.crossingsBudget`. Matches §3.3's "non-monotone endpoint orderings" definition directly.
- **Diagonals stay off in Step 6.** Same as Step 5: the type carries the variant, the algorithm doesn't exercise it. Step 7 (polyline emission) is where diagonal upgrades land.

### 11.4 Resolved during Step 7

- **Pixel coords throughout Step 7.** The polyline emitter multiplies cell-coords / ordinal tracks by `CELL_PX` and `COMB_PITCH` at construction time. Output `Polyline.points` are `{ x, y }` in pixels. Alternative (cell-coords + render-time multiply) was rejected as decoupling overhead with no practical benefit at this point.
- **45° chamfered bends.** Every 90° bend at a corridor intersection is replaced by a 45° chamfer with radius `COMB_PITCH / 2` (= 4 px at defaults), clamped to half the shorter adjacent segment to prevent overlap on tight zigzags. Produces the "graceful 45° corridors" the Phase 4 spec calls for. Sharp 90° bends were rejected as visually un-circuit-board-like.
- **Diagonals stay off in Step 7.** The diagonal upgrade rule (§4.2) stays unexercised. Reason: Manhattan polylines come first; the user can eyeball them in Step 7's preview, then we add diagonals as a follow-up checkpoint. Less risk of conflating the "polyline emitter is wrong" diagnosis with the "diagonal cost function is wrong" diagnosis.
- **Crossing markers are coords, not widgets.** Each `Crossing` from Step 6 becomes a `CrossingMarker { x, y, edgeIndexA, edgeIndexB }` at the corridor midpoint. The renderer (Step 8) decides whether to draw any extra visual at that point.

### 11.5 Resolved during Step 9

- **`branch` is its own primitive, not a single-consumer `fan-out`.** Step 9 began migrating the Phase 3 examples and hit the spine-with-side-branches pattern (`04-spine`, `08-spine-and-lanes`) immediately. `fan-out` cannot model this: its anchor places consumers *along* the flow axis at the median row, which collides with whatever the spine pipeline puts at the next column. A free edge from a pipeline member has the same problem (the flow pass walks the target east, into the next spine cell). The fix is a new anchor primitive whose semantics are perpendicular-to-flow rather than along-flow. Overloading `fan-out` would dilute its meaning ("downstream consumers" vs. "side-shoots") and silently change the geometry users get from existing examples; a separate keyword keeps each anchor's geometry obvious from the keyword alone. See §6.4.
- **Branch direction defaults from flow axis.** Under LR, branches default to north; under TB, west. The `:side` suffix flips to the opposite face. North/south for LR (and west/east for TB) are the only valid sides — diagonals are router business, not anchor business. Reason: forcing the user to declare a side on every branch would clutter every spec; defaulting to one face and allowing the flip-suffix when both faces are needed is the lighter weight choice.

  **(Superseded by §11.6 during the isometric refactor.** The four absolute cardinal sides were replaced with `:left`/`:right` so branches compose under propagated forward; `:left` remains the default. The "rooted on a north-pointing branch" case made absolute sides ambiguous.)

### 11.6 Resolved during the isometric refactor

- **Local forward, not global flow axis.** Every primitive (pipeline / bus / fan-out / branch / back-edge) has a *local* forward direction. Corridors, slot ordering, track packing, and polyline emission read forward per edge or per primitive, never `model.layoutMode`. This makes geometry isometric under inheritance: a fan-out rooted on a south-pointing branch fans along east-west (perpendicular to local forward), not along north-south (perpendicular to page). Without this, branches force every downstream rule to special-case its axis assumption.
- **Forward propagates along the anchor DAG.** A node's forward is the forward of the primitive that placed it. Top-level primitives inherit from `layout:`. Branches rotate 90° from their parent's forward (`:left` = CCW, `:right` = CW). The placer caches forward per node in `Placement.forwardAt`. Downstream stages query the cache; they do not re-derive forward from cell deltas or layout mode. (Edges still carry their own forward — for a forward edge, derived from cell delta after placement; for a back-edge, opposite of the source's forward.)
- **`branch:left`/`branch:right` instead of `:north`/`:south`/`:east`/`:west`.** Absolute cardinal side names break isometry: under inheritance, a user reading `branch x:south:` on a node sitting on a north-pointing branch has to mentally compute whether "south" is page-south or local-south. `left`/`right` are unambiguous relative to the parent's forward. Hard-cut migration (no parser back-compat for the old names) because nothing in the example tree had landed on absolute names yet — only one in-flight smoke test.
- **`branch` is a single-member direction change, not a spine.** Originally `branch x: spine -> [a, b, c]` was supported with members extending outward in a straight line, and three edges spine→a, spine→b, spine→c. But the geometry the placer produced was *just a pipeline rotated 90°* — and the fanned edges didn't match it, so spine→c had to route around a and b (an actual visual bug surfaced in the first eyeball checkpoint). Narrowing `branch` to do one thing — turn the local forward 90° and anchor a single member — keeps it semantically distinct from the other primitives and forces the user to be explicit about what runs along the branched axis. If they want a chain, they write `pipeline tail: a -> b -> c` rooted on the branched member; a fan is `fan-out`; another turn is another `branch`. The primitives compose; `branch` doesn't try to be them.
- **Back-edge forward = opposite of source's local forward.** A back-edge `c >- a` under an east-flowing parent has back-forward W (source's W face exits, target's E face enters, wrap corridor on the rear face). Equivalent rotations apply when the parent is rooted on a south-pointing branch. Confirmed in design review before the refactor.
- **Why now and not a later phase.** The visible bug that triggered the refactor (a same-col upward edge took H corridors in the wrong direction) was a special-case of the broader axis-bias problem. Patching it locally would leave every downstream stage carrying implicit assumptions about "south below, east right" that would fail every time we composed primitives along non-page-aligned axes. The isometric refactor is a focused architectural fix; deferring it would force every subsequent step to plant more axis-bias.

### 11.7 Author-controlled edge routing (Phase 4.1)

The "10% issues" follow-up surfaced an edge in `examples/10-multi-port-group.melk` (`ingest -> router`) that took a two-bend Z-shape pivoting *just above the source* and consequently crossed the fan-out's forward edges twice. The alternative Z-shape — pivoting *just below the target* — would have routed through empty corridors with zero crossings. Both shapes have the same bend count, so a bend-count-only metric can't distinguish them.

The fix has two parts: a **demand-aware default picker** that auto-selects the lower-congestion pivot, and an **author override** in the grammar so that a single-token edit in the `.meld` file can force a specific pivot when the picker gets it wrong or when the author prefers a particular topology for reasons the router can't see.

#### Why an override is in scope

The eyeball-iteration workflow (`feedback-eyeball-cadence`) is: render → critique → tweak source → re-render. For that loop to work — for a human or an LLM — the `.meld` text has to be expressive enough to encode the critique. "Make this edge avoid those edges" cannot become "rewrite the heuristic"; it has to become a minimal source edit. The grammar therefore has to surface routing hints that the author (or an LLM holding the rendered SVG and the source) can mutate deterministically.

A better one-shot picker is still worth having — most edges should route correctly without annotation — but it's the **floor**, not the ceiling. The override is what makes the language **robust to iteration**.

#### Grammar

Edges already accept trailing brace attributes (`->  target { label: "..." }`). The new `pivot` key joins `label`:

```
ingest -> router { pivot: target }
ingest -> router { label: "submit", pivot: target }
```

Values:

| Value      | Meaning                                                                   |
|------------|---------------------------------------------------------------------------|
| `source`   | Pivot at the row/col immediately adjacent to the **source** cell.         |
| `target`   | Pivot at the row/col immediately adjacent to the **target** cell.         |
| _(unset)_  | Picker decides (see §11.7 *Default picker* below).                        |

Unknown values are a hard error (consistent with the strict-compiler lock in §11.1). Only `source` and `target` are accepted at Phase 4.1.

#### Semantics

`pivot:` applies only to edges whose corridor sequence has a **choice of pivot** under the current Manhattan-only router. At Phase 4.1 that is:

- **Diagonal-cell forward edges** (`src.row !== tgt.row && src.col !== tgt.col`) — both Z orientations are valid; `pivot:` picks.

For same-row / same-col edges (no Z to pick), `pivot:` is silently inert. (Reason: requiring authors to know whether an edge happens to land in a diagonal-cell configuration before they're allowed to write `pivot:` would couple the source to current placement. Inert-when-N/A keeps the source robust under topology tweaks.)

For back-edges, `pivot:` is inert at Phase 4.1. Back-edges have an "above-bounding-box vs below-bounding-box" wrap choice that doesn't map cleanly onto the same `source` / `target` framing (because the source can be on either side of the target perpendicularly); they get a dedicated pass in a later phase. Authoring a `pivot:` on a back-edge is *accepted but inert* rather than an error — keeps the syntax forward-compatible without breaking files written today if the semantic lands later.

`pivot: target` means: the pivot corridor is the gutter immediately on the **source's side of the target** — i.e. the H corridor at `tgt.row + 1` if `src.row > tgt.row`, else `tgt.row`. (Mirror for the V case under TB layout.) `pivot: source` is the existing default behavior: pivot at the gutter immediately on the **target's side of the source**.

#### Default picker (demand-aware)

When no `pivot:` is specified, the router uses a two-pass demand calculation:

1. **Pass A — provisional sequences.** Compute each edge's corridor sequence using the current source-adjacent default. Count demand per corridor as today.
2. **Re-pivot pass.** For each pickable edge (diagonal-cell forward or perpendicular-wrap back), evaluate both pivot options. The candidate score is `sum(provisional_demand[c] for c in candidate_sequence)` **minus** the edge's own contribution to the current sequence (so the comparison is between "demand other edges put here" not "demand including me"). Pick the lower-score option. Ties go to `source` (preserves current behavior on diagrams where the choice is irrelevant).
3. **Pass B — final sequences and demand.** Recompute corridor sequences using the chosen pivots, then re-count demand, assign slots, widen gutters.

The picker is one-pass-deterministic — it does **not** iterate to a fixpoint. Two iterations of demand counting (provisional + final) are sufficient because the only thing that changes between them is which pivot corridor each diagonal edge picks; the *cell* placement is unchanged, so slot ordering by `oppositePerp` (§11.6) doesn't shift in ways that would alter the picker's input.

If a future picker becomes more aggressive (e.g. weighting crossings or shifting slot orders), it must be re-spec'd here and the determinism guarantee re-checked.

#### Determinism

- Author `pivot:` always beats the picker. Picker only runs on unspecified edges.
- Picker ties resolve to `source` (the pre-§11.7 behavior).
- Iteration order: edges are scored in `Model.edges` declaration order. With ties broken by `source`, the picker is a pure function of `(Model, Placement)` — same input, same output, byte-for-byte (lock from §7.2).

#### Errors

- Unknown `pivot:` value → parser error, suggesting `source | target`.
- `pivot:` on a structural edge (pipeline / bus / fan-out / branch member): impossible by construction — the grammar for `pipeline | bus | fan-out | branch` does not accept brace-attributes on the member edges. The user can only attach `pivot:` to free edges (`a -> b { pivot: target }`) and inline back-edges (`a >- b { pivot: target }`). If a later phase lifts brace-attrs onto primitive members, that phase must add an `E_PIVOT_ON_STRUCTURAL_EDGE` check at bind time — for now there's no syntactic path to violate the rule.
- `pivot:` on a back-edge: accepted by the parser/binder but inert at Phase 4.1 (see *Semantics* above). A later phase that wires the back-edge picker should remove this caveat.

#### Implementation sketch

Five small touches:

1. **AST.** Extend `EdgeAttrs` (or the inline brace-attr parsing) to recognise the `pivot:` key alongside `label:`. Token-level: the parser already handles `{ key: value, ... }` for edges.
2. **`bind/model.ts`.** Add `pivot?: "source" | "target"` to `ModelEdge`. Plumb it through the bind functions that synthesise free edges from the brace-attr form.
3. **`bind/bind.ts`.** Reject `pivot:` on edges whose `source` field is one of `pipeline | bus | fan-out | branch` (raise `E_PIVOT_ON_STRUCTURAL_EDGE`).
4. **`layout/corridors.ts`.** Refactor `reserveCorridors` into two demand passes. Extract the pivot-decision logic from `corridorSequence` into a small helper `choosePivot(edge, src, tgt, edgeFwd, isBackEdge, provisionalDemand) → "source" | "target"` that consults `edge.pivot` first, then the demand score, then falls back to `"source"`. `corridorSequence` takes a `pivot` argument and uses it instead of the hardcoded source-adjacent expression at line ~398 / ~417.
5. **Tests.** Add to `test/corridors.test.ts`:
    - Picker prefers low-demand corridor on a contrived two-edge diagram.
    - Author override beats picker even when picker would pick the other way.
    - Inert on same-row edges (assert no change vs. baseline).
    - Tie-break to `source` is stable.
    - `E_PIVOT_ON_STRUCTURAL_EDGE` fires on `pipeline foo: a -> b { pivot: target }`.
   And one example: edit `examples/10-multi-port-group.melk` to add `{ pivot: target }` on `ingest -> router`, regenerate the golden, eyeball-check.

#### What this does not cover (deferred)

These are extension points kept open by the chosen syntax; they are **not** in Phase 4.1's scope:

- **Symbolic landmarks.** A later extension could allow `pivot: near router` or `pivot: above snapshots` so the override doesn't depend on which end is the "source" in declaration order. The brace-attr syntax accommodates this trivially — `pivot:` just accepts more values.
- **Multi-pivot waypoints (`via:`).** When routes get more than two bends, a single `pivot:` won't be enough. A `via: <node>` or `via: <corridor>` attribute would join the brace block alongside `pivot:`.
- **Hint at corridor identity (`via: H3`).** Useful for debugging but couples the source to grid indices that shift under topology edits. If we add it, it's a debug-mode-only hint, not a general grammar feature.

#### Why this scope

The minimum that establishes the iteration-robustness principle is: one new attribute, two valid values, plus a one-pass-deterministic auto-picker for the default case. Anything broader (symbolic landmarks, multi-pivot routes) waits for a real example that exercises it. The grammar is designed so those extensions don't break files written today.

#### Caveat: example 10 (`ingest -> router`) is unaffected

The eyeball complaint that motivated this section — `ingest -> router` in `examples/10-multi-port-group.melk` crossing the fan-out edges — does *not* yield to `pivot:`. Reason: router sits at col 0, ingest at col 1, so both pivot candidates (source-adjacent and target-adjacent) produce the same vertical-pivot column (V1, the only gutter between the two cells on the col axis). The Z is constrained to the same V corridor regardless of pivot choice. To route around the fan-out edges, the trace needs the **V0** corridor (west of router), which is a longer route — outside the current `corridorSequence` shape, which only emits one pivot.

This is what motivates §11.8 (`avoid:` and a path-search router). `pivot:` lands here because it generalizes cleanly to other diagrams and establishes the brace-attribute pattern; example 10 specifically waits for §11.8.

### 11.8 Author-directed obstacle avoidance (Phase 4.2)

§11.7 introduced the eyeball-iteration principle and added `pivot:` as the first knob. The eyeball check on `examples/10-multi-port-group.melk` then surfaced a route that no `pivot:` value can fix — the trace needs to climb a different *V corridor entirely* (V0 west of router instead of V1 east), which is outside the two-Z-shape catalogue the corridor-sequence generator emits. The route the user sketched has the same bend count as the auto-generated route but threads through empty corridors — a path the router has no way to find because it doesn't *search*, it picks from a fixed shape table.

§11.8 fixes the root cause by replacing the fixed corridor-sequence generator with a **path-search router** over the corridor graph, plus an `avoid:` brace-attribute that names the **edges** an author wants the new edge's route to skirt. Names a thing once, refers to it everywhere.

#### Why edges, not nodes

An early draft of §11.8 had `avoid:` name nodes and block the four corridors bordering each node's rectangle. That doesn't match how authors actually critique a diagram. When the author looks at `ingest -> router` crossing the fan-out, they're not saying "avoid these consumer nodes" (the trace doesn't go near them); they're saying "don't run along the corridor where those *edges* live." The obstacle is the edges' geometry, not the nodes' rectangles.

Concretely, in example 10 the fan-out `channels: router -> [metrics, events, audit, alerts, traces, snapshots]` produces six edges, all of which traverse the V1 corridor on their way east from router's E face. The author's intent is "don't put `ingest -> router` in V1." Naming the fan-out by its name (`channels`) packages all six edges in one token. Naming the consumer nodes makes the author re-list things the language already knows about (and forces re-listing every time the fan-out grows).

`avoid:` is therefore **edge-based**: the value names edges (directly, or by naming a primitive / edgeset / node whose edges to include), and the router blocks the corridors those edges traverse.

#### Why this is a router upgrade, not another attribute

Authoring "avoid this thing" can't be implemented as a tweak to a fixed shape table — the very point of `avoid:` is that the route may need an arbitrary number of bends to satisfy the constraint, and the canned `V_exit → H_pivot → V_entry` shape can't bend more than twice. The router has to be able to **find** a route, not pick one. Once it can search, the canned shapes become a special case (the shortest path through an uncongested graph happens to be the same Z); the search subsumes them.

The Phase 4.1 `pivot:` picker stays in place during the upgrade. Path search is a strictly more general operation: when no `avoid:` is set and no edges have demand differences, the search returns the same Z as the canned generator. When `avoid:` is set, the search honors it. When demand differs, the search can be weighted by demand and subsume the `choosePivotByDemand` logic too.

#### Grammar

`avoid:` takes a single value or a bracketed list. Each value is one of four kinds:

| Kind | Example | Expands to |
|---|---|---|
| **Primitive name** | `channels` (a `fan-out`), `power` (a `bus`), `lane-a` (a `pipeline`), `enrichers` (a `branch`) | All edges the primitive declares. |
| **Edge-set name** | `hot-channels` (an `edgeset`) | The edges listed in the `edgeset` declaration. |
| **Explicit edge** | `router->alerts`, `traces -> jaeger` | That one edge. (Whitespace around `->` allowed.) |
| **Node name** | `router` | All edges incident to that node (both `from` and `to`). |

```
# Single value
ingest -> router { avoid: channels }
ingest -> router { avoid: hot-channels }
ingest -> router { avoid: router->alerts }
ingest -> router { avoid: router }

# List — union of the elements' expansions
ingest -> router { avoid: [channels, traces->jaeger] }
```

`avoid:` composes with `pivot:` and `label:`. Order within the brace block is free:

```
ingest -> router { label: "submit", avoid: channels, pivot: source }
```

When `avoid:` and `pivot:` are both set, `avoid:` is the harder constraint (it can rule out a route entirely), and `pivot:` becomes a hint honored only if the path search has a free choice consistent with the avoidance. If the route is fully determined by the avoidance, `pivot:` is silently inert.

The new annotation **`edgeset`** parallels `nodeset`:

```
edgeset hot-channels: router -> alerts, router -> traces, router -> snapshots, traces -> jaeger
```

Comma-separated list of edge references (`from -> to`). Each reference must match an edge that exists in the model — `E_EDGESET_UNKNOWN_EDGE` otherwise. Like `nodeset`, an `edgeset` is a pure annotation; it does not influence placement or routing on its own. It exists so that `avoid:` (and future `prefer:` / `via:`) can refer to a named bundle declared in one place.

#### Semantics — what "avoid" blocks

For each value in the `avoid:` list, the bind step expands it to a set of edges (per the table above). The union across all values is the **avoided edge set**.

For each edge in the avoided edge set, the router computes the **provisional corridor sequence** that edge would take in isolation (using the same path-search infrastructure, with no avoidance set), and adds all the *traversed* corridors to the **blocked corridor set** for the new edge's route.

The path search for the new edge then runs over the corridor graph with the blocked set excluded. Where the avoided edges go, the new edge can't.

Two refinements that fall out:

1. **Touching vs traversing.** A trace exiting source-N enters its source-row gutter only to step off the source face — it doesn't traverse that gutter along its length. The blocking semantics has to apply only when a corridor is *traversed* (entered and exited on its long axis), not when it's *touched* (entered on one axis, exited on the perpendicular axis at the same crossing). See "Router algorithm" below for how this is modeled.

2. **Self-exemption.** The source-exit corridor and the target-entry corridor for the new edge are never blocked — if they were, an `avoid:` that names any edge sharing the new edge's exit/entry face would be unroutable. (For the canonical example: `ingest -> router { avoid: channels }` would otherwise fail because `channels` includes `router -> metrics` whose source is router's E face on V1 — but the new edge's target-entry is router's S face on H5, which is fine.)

If the avoidance blocks every route between source and target, the router raises `E_AVOID_UNROUTABLE` naming the source, target, and the avoided set. Author resolves by dropping or loosening the avoidance.

#### Router algorithm (path search)

The corridor sequence is no longer hardcoded — it's the result of a **Dijkstra search** over a graph whose nodes are corridor-axis-half-IDs and whose edges encode the touching-vs-traversing distinction:

- **Graph nodes.** For each corridor `C`, two nodes: `C-fwd` and `C-bwd` (the two long-axis directions). For an H corridor, fwd = east, bwd = west; for a V corridor, fwd = south, bwd = north.
- **Internal edges (traversal).** Each `C-fwd` and `C-bwd` is connected via internal edges representing motion along the corridor's length. Weight: 1 per unit of cell-length traversed (so longer runs cost more — but the dominant cost term is *bends*, see below). If `C` is in the blocked set, the internal edges are removed; the corridor can be touched at a crossing but not traversed.
- **Cross edges (touching).** At each grid intersection where corridor `Ci` (horizontal) meets `Cj` (vertical), four cross-edges connect the half-nodes such that a trace entering `Ci` from the west can leave `Cj` going north (or south), and so on. Each cross-edge costs **B** (a bend penalty large enough that the search prefers a straight run to a zigzag of equivalent length).
- **Source and target virtual nodes.** `src-exit` connects with weight 0 into the corridor immediately outside the source's chosen exit face, on the half-direction matching that face. `tgt-entry` mirrored.
- **Self-exemption.** The source-exit corridor and target-entry corridor get their internal edges *restored* even if blocked. This guarantees the trace can leave the source and enter the target regardless of what `avoid:` names.

**Edge weights:**
- Internal traversal: `1 * length-in-cells`. A blocked corridor removes the internal edge entirely.
- Cross (bend): `B = some large constant, e.g. 100`. Makes the search bend-count-minimizing.
- src/tgt virtual edges: 0.

**Search.** Dijkstra from `src-exit` to `tgt-entry`. Returns the corridor sequence as the ordered list of corridor IDs visited along the way (de-duplicating consecutive visits within a single corridor's two halves).

**Determinism.** Dijkstra ties broken by lexicographic graph-node ID order (corridor kind H < V; then index; then half-direction fwd < bwd). Same input → same path, byte-for-byte (lock from §7.2).

**Demand-aware picker integration.** The Phase 4.1 picker (`choosePivotByDemand`) is replaced by adding a small **demand-weight term** to corridor internal-edge cost — `cost(c) = 1 + demandWeight * provisionalDemand[c]`. Two-pass demand model unchanged: Pass A runs the search with `demandWeight = 0` to get a provisional sequence and demand baseline; Pass B uses `demandWeight = ε` (small enough that bend count still dominates ties; large enough that congested corridors get bumped). This subsumes both Phase 4.1's "flip to less-loaded pivot" behavior and Phase 4.2's `avoid:` behavior under one mechanism.

When the user has no `avoid:` and no congestion, the shortest-path search yields the same Z as the §11.7 canned generator (the Z has the fewest bends for a diagonal-cell forward edge). Phase 4.2 therefore subsumes Phase 4.1's `corridorSequence` function — `corridorSequence` becomes a thin wrapper that builds the corridor graph (with blocks) and runs the search.

#### How example 10 resolves

`ingest -> router { avoid: channels }`:

- Side assignment: ingest at (6,1), router at (2,0). Long-axis delta is N → exit N, enter S. (Unchanged from before.)
- Avoided edge set: the six `channels` fan-out edges (router → {metrics, events, audit, alerts, traces, snapshots}).
- Each of those six provisional routes traverses the V1 corridor (east of router, west of consumer column). V1 → blocked.
- Self-exemption applies: H6 (ingest's exit corridor) and H5 (router's entry corridor) remain traversable even if any avoided edge touched them.
- Path search finds: src-exit → H6 (touched) → cross to V0 → V0 traversed north from H6 to H5 → cross to H5 → H5 (entry corridor, exempt) → tgt-entry.

That matches the user's sketched route: out ingest N, west along H6, north along V0 (west of router), east along H5 to enter router's S face. One traversal in V0, two bends at H6/V0 and V0/H5. Same bend count as the old (broken) route through V1, but routes through empty corridors instead of congested ones.

#### Errors

- `avoid:` value isn't a recognized primitive / edgeset / edge ref / node name → `E_AVOID_UNKNOWN_REF` at bind time, naming the unresolved value and listing what kinds were tried.
- `edgeset` member doesn't match any edge in the model → `E_EDGESET_UNKNOWN_EDGE` at bind time.
- Explicit edge ref `a->b` where `a` or `b` isn't a declared node → `E_AVOID_UNKNOWN_NODE`.
- `avoid:` blocks the only available route between source and target → `E_AVOID_UNROUTABLE` at reservation time, naming source, target, and the avoided edge set.
- `avoid:` on a structural edge → impossible by construction (same as `pivot:`, §11.7).

#### Implementation sketch

1. **AST / Parser.**
    - Extend `PropertyValue` to add a `node-list` variant and an `edge-ref` variant (or a generic `ident-or-list` recognizer for `avoid:` specifically). The brace-attr parser learns to recognize `avoid: <value>` and `avoid: [<value>, ...]`.
    - Add `edgeset` as a top-level statement, parsing as `edgeset <name>: <edge-ref>, <edge-ref>, ...`.
    - Parse `a->b` (with optional whitespace) as an edge reference token.
2. **`bind/model.ts`.**
    - Add `avoid?: AvoidRef[]` to `ModelEdge`, where `AvoidRef` is `{ kind: "primitive" | "edgeset" | "edge" | "node", name: string } | { kind: "edge", from: string, to: string }`. (Or keep it as raw strings and resolve in `bind.ts`; resolution-at-bind has the advantage that downstream stages just see edge indices.)
    - Add `Edgeset { name: string, edges: { from: string, to: string }[] }` and `Model.edgesets: Edgeset[]`.
3. **`bind/bind.ts`.**
    - Bind `edgeset` declarations; validate each member matches an existing edge.
    - For each edge with `avoid:`, resolve every value to the underlying edge set (by primitive name, by edgeset name, by explicit reference, or by node name → incident edges). Store the resolved set as a `Set<number>` of edge indices on `ModelEdge.avoidEdges`.
    - Raise `E_AVOID_UNKNOWN_REF` / `E_EDGESET_UNKNOWN_EDGE` / `E_AVOID_UNKNOWN_NODE` on failures.
4. **`layout/corridors.ts`.**
    - Replace `corridorSequence` with a path search:
        - `buildCorridorGraph(placement)` — corridor half-node graph, internal + cross edges as described above.
        - `routeOneEdge(graph, src, tgt, edgeFwd, blocked: Set<string>) → Corridor[]` — Dijkstra.
    - Three-pass reservation:
        - **Pass A:** for each edge, run `routeOneEdge` with `blocked = ∅` and `demandWeight = 0`. This gives every edge a provisional route. Use these provisional routes to compute *per-edge* corridor-touched sets — i.e., for each edge index, the set of corridors its provisional route traverses.
        - **Block computation:** for each edge with an `avoidEdges` set, take the union of those edges' provisional corridor sets. That's its blocked set.
        - **Pass B:** re-route every edge with `routeOneEdge(blocked = its block set, demandWeight = ε * provisional demand)`. Edges without `avoidEdges` get `blocked = ∅` but still see the demand weighting. This is the final route.
    - Determinism: Pass A is order-independent because no edge sees any other's avoid set yet. Pass B uses Pass A's provisional demand and avoid sets — no fixpoint.
5. **Tests in `test/corridors.test.ts`.**
    - Path search returns the same Z as the legacy generator on an uncongested diagonal (regression test for §11.7 picker behavior).
    - `avoid: <primitive>` reroutes around the primitive's edges.
    - `avoid: <edgeset>` honors a named edgeset.
    - `avoid: <node>` reroutes around all edges incident to that node.
    - `avoid: a->b` reroutes around a single explicit edge.
    - `avoid: [<mixed list>]` honors the union of expansions.
    - Self-exemption: `avoid: <list containing an edge whose corridor includes src-exit or tgt-entry>` still routes successfully.
    - `E_AVOID_UNKNOWN_REF`, `E_EDGESET_UNKNOWN_EDGE`, `E_AVOID_UNROUTABLE` error paths.
    - Example 10: edit `examples/10-multi-port-group.melk` to add `{ avoid: channels }` on `ingest -> router`. Regenerate the SVG; eyeball-check.

#### What this does not cover (deferred to a later phase)

- **Soft avoidance / cost-tuning knobs.** `avoid:` is a hard block in §11.8. A future `prefer:` or `avoid-cost:` would tune cost rather than block. The path search infrastructure makes this trivial to add once needed.
- **Symbolic landmarks (`above router`, `below snapshots`).** Future sugar that translates to an avoidance set. The grammar slot accepts new value kinds without re-spec.
- **`via:` waypoints (positive routing hints).** The mirror of `avoid:` — force a route *through* a named edge's corridor. Same path-search infrastructure; adds a required corridor to the search instead of blocking corridors. Deferred until a real example needs it.
- **Diagonal corridors in the path graph.** Diagonals remain off (§11.4 lock). Once they're on, they join the corridor graph as additional nodes with the same Dijkstra mechanism — no algorithm change needed.
- **Interior-column / interior-row corridors.** The path-search graph contains only **gutter** corridors (between columns/rows). It cannot route a trace vertically through the interior of a column even when that column is empty between two cells. Surfaced as a visible "overshoot" in example 10: when the only available northbound gutter is V0 (page-west margin), `ingest -> router` runs in V0 at x≈8 even though router's S face is at x=32 — forcing a 24px cut-back east. The user reviewed this and accepted it; interior corridors stay deferred. The fix when it's needed: add a per-column "centerline" V corridor available only in row ranges where the column has no occupant (and same per-row H corridors). Same Dijkstra search, just a richer graph.

#### Why this scope

`avoid:` plus a path-search router is the smallest change that (a) solves example 10, (b) generalizes to every "don't cross those edges" complaint we expect in future eyeball checks, and (c) gives Phase 5+ a real router cost function to extend (diagonals, demand-weighting, soft preferences). Smaller alternatives (a `U-shape` canned form, a `via:` waypoint without `avoid:`, node-bordering-corridor blocking) were considered and rejected:

- Adding more canned shapes is a dead-end — every new eyeball complaint demands shape N+1.
- `via:` alone is the wrong polarity for the iteration workflow — authors critique what they see going wrong (an obstacle), not the absence of a corridor they're imagining.
- Node-bordering blocking is the wrong unit — the obstacle is edge geometry, not node rectangles, and forcing authors to re-list nodes duplicates what primitives already name.

The router-as-search inverts the canned-shape problem: one mechanism, infinite shapes, declarative author input. The `edgeset` annotation closes the language under "name a thing, refer to it" — adding a new way to refer to edges (instead of forcing the same node list to be repeated at every `avoid:` site).

### 11.9 Highways (Phase 4.3)

§11.7 and §11.8 gave the author negative routing controls — "avoid this", "use that pivot". The next eyeball-iteration knob the user identified is **positive routing through a named region with parallel-bundle semantics**: an invisible node that edges can be routed *through* as an ordered bundle of parallel tracks, like a ribbon cable. The node has both a **placement role** (it anchors its via-source nodes on one side and its via-target nodes on the other, so the author doesn't need to write scaffolding declarations) and a **routing role** (its interior is competition-free — every trace through it gets a dedicated parallel track at uniform pitch).

#### Learning record — what the first cut got wrong

The initial §11.9 implementation (committed and then revised) had two flaws that surfaced on first eyeball:

1. **No placer integration.** `via:` only affected routing, not placement. Authors had to write `bus`/`fan-out` scaffolding declarations purely to position the surrounding nodes, then duplicate the edge list as `via:` edges. The scaffolding edges then *also* rendered, producing visual chaos. The fix is to make `via:` a placement constraint too — the highway acts as an anchor that positions its via-members.
2. **No bundle coherence inside the highway.** The path search treated the highway as just two gutter corridors (W-entry, E-exit) to land at. Same-row through-traces bypassed the highway entirely (a horizontal trace at row 2 going W→E happens to traverse V_w, V_e at row 2 — and never visits the highway's row even though the corridor sequence "names" the highway). The fix is to special-case the highway's interior: traces routed via the highway get assigned a track inside it and the trace literally runs along that track at its assigned perp coord, regardless of what the corridor graph thinks.

The §11.9 below is the second-cut design that fixes both.

#### What a highway is

A **highway** is a node declared with `shape: highway`. Like any node, it has a `size:` (overridable; auto-derived if omitted) and is placed on the grid by the placer. Unlike other nodes:

- It **renders nothing** (no rect, no label, no outline).
- It **acts as an anchor primitive** when via-edges name it: source-side via-members stack on its incoming short face; target-side via-members on its outgoing short face. The author does not need to declare a parallel structural primitive (bus / fan-out / pipeline) just to position the via-members.
- Its **interior is competition-free**: every via-edge gets a dedicated parallel track at the standard COMB_PITCH inside the highway, ordered by the via-edge's source perpendicular position. Traces inside the highway don't fight for corridor channels with each other or with other edges that happen to cross the highway's row/col.

A highway is **not** an edge endpoint. Writing `a -> hwy` (or `hwy -> b`) as an explicit edge is a parse error. The highway is something edges route *through*, never *to*. (If we ever need that, it's a future addition.)

#### Orientation

A horizontal highway has `size: NxM` with `N > M` (long axis = E-W). A vertical highway has `M > N` (long axis = N-S). The short axis is the one perpendicular to the long axis. Highway entry/exit always happens on the **short faces** (W/E for horizontal, N/S for vertical), so traces traverse the highway's *length*, not turn inside it.

Square highways (`N == M`) are rejected at bind time — they have no determinate direction. If a 1x1 "junction" is ever wanted, that's a different primitive (deferred).

#### Auto-sizing

By default, the highway's long-axis size auto-extends to fit the larger of `count(distinct source-side via-members)` and `count(distinct target-side via-members)`. With 3 sources and 4 targets, a horizontal highway auto-sizes to `4x1`. The author can override with explicit `size:` for a longer highway (extra space allowed; extra time/perp slots wasted are harmless).

Implementation: auto-sizing happens at bind time after `via:` references are resolved, since both endpoints' membership is needed to count members.

#### Grammar

**Declaration:**

```
hwy { shape: highway }                # auto-sized to fit via-member count
hwy { shape: highway, size: 6x1 }     # author-specified length
```

**Routing through a highway:**

```
a -> b { via: hwy }
a -> b { via: [hwy1, hwy2] }
```

`via:` is a brace-attr alongside `label:`, `pivot:`, `avoid:`. Value: a single highway name or a bracketed list. The list form means "route through these highways in this order" — intermediate highways carry both an entering and an exiting trace face.

`via:` composes with `avoid:`. `pivot:` is silently inert when `via:` is set (the route geometry is fully determined by the highway sequence).

`via:` on a structural edge (pipeline / bus / fan-out / branch member) is impossible by construction — those edge sources don't accept brace-attrs.

#### Placer integration — `via:` as anchor

When an edge `a -> b { via: hwy }` is bound, both endpoints register as members of `hwy`'s via-anchor:

- `a` joins the **source-side member list** of `hwy`.
- `b` joins the **target-side member list** of `hwy`.

Each node appears at most once on each side, regardless of how many via-edges it participates in. If `a -> dst_x` and `a -> dst_y` both go `via: hwy`, `a` appears once on the source side. The two outbound traces from `a` enter the highway at adjacent tracks (slot allocation handles this).

Side member order: declaration order of the via-edges (first occurrence wins). When the same node appears in multiple via-edges with the same highway, its position is set by its first appearance.

The placer treats the highway as a new anchor kind in `Model.anchors`. The anchor pass places:

- The highway itself at some `(row, col)` (chosen the same way other anchors choose — by the surrounding constraints, with fallback to the layout-axis flow).
- Source-side members at consecutive perpendicular positions on the highway's incoming-short-face side. For a horizontal highway in `layout: lr`, sources stack at rows `hwy.row - K/2 .. hwy.row + K/2` (centered on the highway), in col `hwy.col - 1`.
- Target-side members analogously on the opposite side.

This makes via-edges fully self-sufficient for placement: the author writes only via-edges; no scaffolding bus/fan-out needed.

#### Routing through a highway

For each via-edge `a -> b { via: hwy }`:

1. **Source-to-highway leg.** Standard path search (§11.8 machinery) from `a`'s exit face to the highway's incoming-short-face at `a`'s assigned **entry track** on that face. The entry track is decided by the slot allocator: ordered by `a`'s perpendicular position on the source-side member list.
2. **Through-highway leg.** The trace runs **straight** along the highway's long axis at the entry track's perp coord. No corridor competition: the highway's interior is reserved space and the through-segment is just a straight line at the assigned perp coord. The trace exits the highway at the **same perp coord** on the outgoing short face (i.e., the assigned **exit track** mirrors the entry track for through-only traces).
3. **Highway-to-target leg.** Standard path search from the highway's outgoing-short-face exit track to `b`'s entry face.

**Entry/exit track assignment.** Each via-edge gets one entry track (on the incoming short face) and one exit track (on the outgoing short face):

- Entry track on the incoming face: indexed by the trace's source-node position in the source-side member list. All traces from the same source share an adjacent block of entry tracks (one track per outgoing via-edge from that source, in declaration order). This is the "bundle coherence" rule — traces from the same source stay adjacent inside the highway.
- Exit track on the outgoing face: indexed by the trace's target-node position in the target-side member list. Adjacent block per target.
- Inside the highway, entry and exit tracks are connected by the straight through-segment. If entry and exit tracks have *different* perp coords (because the source and target sit at different ranks on their respective sides), the through-segment has to step from one perp to the other. Per the user's "preserve spacing through corners" rule, we resolve this by giving each trace its **own** dedicated perp coord through the highway, equal to its **entry-track perp** for the first half and stepping to the **exit-track perp** at the midpoint of the highway.

(That last rule is the simplest geometry that satisfies "each trace gets its own track and they don't intersect". A more elaborate rule — e.g., minimum-bend crossings inside the highway — can come later if needed. For now the rule produces an orderly bundle and any "track-switch" inside the highway is a single step at the midpoint.)

**For multi-highway `via: [h1, h2]`:** the route is leg₁ (a → h1 entry) + through(h1) + inter₁(h1 exit → h2 entry) + through(h2) + leg₂ (h2 exit → b). The inter-highway leg is a standard path search.

#### Rendering

Plain polylines, one per via-edge — same as any other edge. Inside the highway, the polyline is a straight (or one-bend, for the midpoint track-switch) segment at the assigned perp coord. The highway box itself renders as nothing (the renderer already skips `shape: highway` nodes).

A second rendering mode ("underground" — stubs ending at small circles, faint through-section between them) was discussed during design as a future visual variant. It's not in scope for Phase 4.3; Mode 1 (straight parallel) is the default and only mode. The renderer's `nodeShape` dispatcher leaves a hook for adding mode variants later (e.g., a `render:` brace-attr on the highway node).

#### Errors

- `via:` value isn't a known highway → `E_VIA_UNKNOWN_HIGHWAY` at bind time.
- `via:` value names a node whose `shape` isn't `"highway"` → `E_VIA_NOT_HIGHWAY` at bind time.
- Explicit edge `a -> hwy` where `hwy` has shape `highway` → `E_HIGHWAY_AS_ENDPOINT` at bind time.
- Square highway (`size:` where N == M) → `E_HIGHWAY_AMBIGUOUS_ORIENTATION` at bind time.
- `via:` on a structural edge → impossible by construction.
- Via-anchor placement failure (e.g. conflict with another anchor's claim on the highway's neighboring cells) → standard `PlacementError` from the placer.

#### Implementation sketch

1. **AST.** `ShapeName` already includes `"highway"` (added in the first-cut implementation). No further changes needed here.
2. **Parser.** `via:` brace-attr handling is in place (first-cut implementation). No changes.
3. **Bind (`bind/model.ts` + `bind.ts`).**
    - Keep `ModelEdge.viaHighways?: string[]`.
    - Add a new field to `ModelNode` or a separate map for highway via-anchor membership: `Model.highwayMembers: Map<string, { sources: string[]; targets: string[] }>`. Populated in a deferred pass after via references are resolved.
    - Auto-size highways with no explicit `size:` based on `max(sources.length, targets.length)`.
    - Add `Model.anchors` entry of new kind `"highway-via"` so the placer treats highways like other anchor primitives.
    - Validation: `a -> hwy` (where hwy is a highway) raises `E_HIGHWAY_AS_ENDPOINT`. Square highway raises `E_HIGHWAY_AMBIGUOUS_ORIENTATION`.
4. **Placer (`layout/place.ts`).** Add a `highway-via` anchor handler:
    - Place the highway cell at an inherited position from its anchor parent (or fallback flow-axis position if free-standing).
    - For each source-side member, claim a cell on the highway's incoming-short-face side at the appropriate perpendicular rank.
    - For each target-side member, claim a cell on the outgoing-short-face side.
    - If a member is already placed by another anchor, defer to the existing placement (the via-anchor is non-exclusive). If multiple via-anchors claim the same node at conflicting positions, raise `E_VIA_PLACEMENT_CONFLICT`.
5. **Router (`layout/corridors.ts`).** Revise `reserveCorridors` to handle highways properly:
    - For each via-edge, the through-highway segment is **not** a path search — it's a fixed straight segment at the assigned track. Implement as a new corridor kind `Interior(hwyId, entryTrack, exitTrack)` or just as pre-computed pixel coords stashed in the route.
    - Track assignment: compute per highway: for each source-side member, allocate a block of `K` adjacent tracks where `K` = number of outgoing via-edges from that source; similarly for target-side. Match entry/exit tracks within each block in declaration order.
    - The first and last legs (source→entry, exit→target) use the existing path search.
    - Highway interior is removed from the corridor graph for non-via traffic (it's reserved space).
6. **Polyline emitter (`layout/polyline.ts`).** Recognize the interior segment and emit it as a straight line (or one-bend if entry and exit tracks differ). The midpoint track-switch produces at most one extra bend.
7. **Renderer (`render/svg.ts`).** Already skips highway nodes (first-cut implementation). No further changes.
8. **Tests.**
    - Highway with no scaffolding declarations places its via-members correctly.
    - Source/target side member ordering matches declaration order.
    - Two via-edges from the same source enter the highway at adjacent tracks and stay adjacent through any corner.
    - Through-highway segment is a straight line (no corridor competition).
    - `E_HIGHWAY_AS_ENDPOINT` / `E_HIGHWAY_AMBIGUOUS_ORIENTATION` error paths.
    - Auto-sizing: `shape: highway` with no `size:` produces a highway sized to fit its via-members.
9. **Examples.** Rewrite `examples/16-highway-bundle.melk` and `examples/17-highway-inlet.melk` without scaffolding. Eyeball-check.

#### What this does not cover (deferred)

- **Mode 2 rendering ("underground" with manhole circles).** Future visual mode. Hook left in the renderer for a `render:` brace-attr.
- **Crossings inside the highway.** If source rank and target rank for a trace differ, the trace switches tracks at the midpoint — that's a deliberate single intersection per mismatched trace. A future "track ordering optimizer" could re-rank members on both sides to minimize crossings inside the highway. Not in scope.
- **Highway-to-highway adjacency.** Two highways flush against each other could stitch traces without an explicit `via: [h1, h2]` list. Not in scope.
- **Highway as endpoint.** `a -> hwy` is rejected.
- **Square highway / junction primitive.** Rejected at bind time. A separate "junction" primitive may come later.

#### Why this scope

Highways close the loop on §11.7+§11.8's "author-controlled routing knobs" by adding the *positive* counterpart: route *through* this thing. The placer integration (`via:` as anchor) is what makes them ergonomic — the author writes only via-edges, no scaffolding. The reserved-interior semantics is what makes them *visually* what the metaphor promises: a tidy parallel bundle instead of competing corridor traffic.

The implementation reuses the path search from §11.8 for the source→highway and highway→target legs, adds a small amount of "fixed-track interior" logic for the through-segment, and extends the placer with one new anchor kind. The new infrastructure is concentrated in the placer; the router and renderer changes are small.

### 11.10 Author-controlled exit/entry face (Phase 4.4)

Surfaced by `examples/21-highway-mixed.melk`: a free edge `svc_c -> log` between cells (2, 2) and (0, 3) had displacement (−2, +1). Per §3.3, the edge-forward direction is the long-axis component of the cell delta → `edgeFwd = N` → source exits N face, target enters S face. The trace consequently exits svc_c's top, then wraps east through three gutters and up V3 to enter log from below — a nine-segment zigzag where a three-segment L-shape (exit E, north up V3, enter S) was visually obvious.

The §3.3 rule is correct under its own terms: it's symmetric in row/col, which is what makes layout-rotation isometric (§11.6). But "the long axis wins" is the *router's* call; for a one-shot diagram, the author can see at a glance that the short-axis exit produces a cleaner picture, and the language should let them say so.

#### Grammar

Two new brace-attr keys join `label:`, `pivot:`, `avoid:`, `via:`:

```
svc_c -> log { exit: E }
svc_c -> log { exit: E, entry: S }
svc_c -> log { exit: E, label: "audit" }
```

Values: one of `N | E | S | W`. Cardinal, not relative — see *Isometry* below for why. Either key may appear alone; both may appear together; both are optional.

#### Semantics

`exit:` overrides the **source face** the trace uses. `entry:` overrides the **target face**. Both fields plug into the existing §3.3 pipeline at exactly one point each:

- Default (no override): `sourceSide = sideOf(edgeFwd)`, `targetSide = sideOf(opposite(edgeFwd))`. Unchanged from today.
- With `{ exit: E }`: `sourceSide = E`. `targetSide` still derives from `edgeFwd` (i.e. `sideOf(opposite(edgeFwd))`) — *not* `opposite(exit)`. Author intent: "I picked the exit; let the router pick the entry to match the implied forward."
- With `{ entry: S }`: mirror — `targetSide = S`, `sourceSide` derives from `edgeFwd`.
- With both: both sides are author-set; `edgeFwd` is no longer consulted for side assignment.

The corridor sequence then runs as normal, taking the (possibly overridden) sides as inputs. **No parallel routing path** — `assignSlots` → `packTracks` → `buildOrthogonalPolyline` is the only pipeline. This is the binding constraint that fell out of §11.9 ([feedback-no-parallel-routing](../memory/feedback-no-parallel-routing.md)).

Worked example — `svc_c -> log` with displacement (−2, +1) and `edgeFwd = N`:

| Brace                       | sourceSide                         | targetSide                                       | Resulting shape                       |
|-----------------------------|------------------------------------|--------------------------------------------------|---------------------------------------|
| (none — current behavior)   | `sideOf(N)` = N                    | `sideOf(opposite(N))` = `sideOf(S)` = S          | exit N, wrap E around top, enter S — the zigzag |
| `{ exit: E }`               | E (override)                       | S (still from `edgeFwd`)                         | exit E, north up V3, enter S — clean L |
| `{ entry: W }`              | N (still from `edgeFwd`)           | W (override)                                     | exit N, wrap east, enter W            |
| `{ exit: E, entry: W }`     | E (override)                       | W (override)                                     | exit E, two corridor bends to enter W |

The clean L the eyeball complaint described is what `{ exit: E }` alone produces — the implied target side (`sideOf(opposite(edgeFwd))` = S) happens to already point the right way. `entry:` is needed only when the author also disagrees with §3.3's target choice. The two knobs are independent precisely because that's not always the case.

#### Isometry

§11.6 promises that swapping `layout: lr` ↔ `tb` rotates the entire diagram with no other edits. Cardinal-valued `exit:` / `entry:` **break that promise on the affected edge** — `exit: E` under LR points page-east, under TB it still points page-east (which is now perpendicular to the page's forward axis). That's a deliberate trade-off: the override is a manual hint for a specific layout, not a primitive that participates in rotation.

The relative-direction alternative (`exit: forward`, `exit: left`, etc.) was considered and rejected for two reasons:

1. The use case is "the router picked badly *for this layout*". If the author wanted the router-derived choice, they wouldn't be overriding. Cardinal values match the author's mental model when they're looking at a single rendered SVG and saying "no, exit *that* way."
2. Relative values bring forward the question "left of what?" — local forward of the source node, the global flow axis, or the page's forward — which is exactly the question §11.6 spent a refactor disambiguating. Re-litigating it here would land us back in pre-isometric soup.

If the diagram is rotation-critical, the author can simply not use `exit:` / `entry:` and accept whatever §3.3 picks. The knob is opt-in friction.

#### Validation

Three bind-time errors:

- **`E_EXIT_INVALID_VALUE`** — the value isn't `N | E | S | W`. (Or `entry:`, same parser pathway.)
- **`E_EXIT_ON_STRUCTURAL_EDGE`** — `exit:` / `entry:` on a structured-edge member (pipeline / bus / fan-out / branch / via-half). Mirrors §11.7's `E_PIVOT_ON_STRUCTURAL_EDGE`: those edges' geometry is implied by the primitive, not by free-edge routing. Source rejection only — the user can't write `exit:` on a structural edge syntactically today; the gate is for forward-compatibility when (if) primitives gain brace-attrs.
- **`E_EXIT_ON_BACK_EDGE`** — `exit:` / `entry:` on a back-edge. Deferred at v1; back-edges have their own face semantics (rear-of-forward) that interact with the wrap geometry in ways that need a separate pass. Accepted-but-inert was considered (mirroring §11.7's back-edge handling) but rejected because authors hitting "the exit is wrong" on a back-edge would silently get no fix; better to fail loud.

Note: no `E_EXIT_UNREACHABLE`. Every face *is* reachable from every target by Manhattan paths (wrap around if necessary). If the author picks an awkward face, they get an ugly wrap and re-edit — that's the iteration workflow. No way to define "unreachable" precisely without picking an aesthetic threshold, and an aesthetic threshold isn't a hard error.

Permissive routing is the implementation: trust the author, route as requested. The strictness in Phase 4 grammar (§11.1) is about *grammar* errors — typos, unknown keys, deprecated forms. Aesthetic outcomes aren't grammar.

#### Determinism

`exit:` and `entry:` are pure overrides on already-deterministic values. The picker from §11.7 (pivot demand) runs *after* side assignment; an overridden source/target side just changes which corridors the picker sees as candidates. No new tiebreak rule; iteration order unchanged.

#### Implementation sketch

Five touches:

1. **Bind ([src/bind/bind.ts](src/bind/bind.ts), [src/bind/model.ts](src/bind/model.ts)).** Extend `ModelEdge` with `exitSide?: Side` and `entrySide?: Side`. In `bindEdge`, accept `exit:` / `entry:` brace-attrs; values must be cardinal `ident`s (`N | E | S | W`). Reject on back-edges with `E_EXIT_ON_BACK_EDGE` and on `via:` edges with `E_EXIT_ON_VIA_EDGE` (the via-half synthesis would need to decide which half carries the override — out of scope at v1).
2. **Corridor side assignment ([src/layout/corridors.ts](src/layout/corridors.ts)).** After `const sides = assignSides(edgeFwd);`, apply overrides:
   ```ts
   if (edge.exitSide !== undefined) sides.sourceSide = edge.exitSide;
   if (edge.entrySide !== undefined) sides.targetSide = edge.entrySide;
   ```
3. **Corridor sequence ([src/layout/corridors.ts](src/layout/corridors.ts) `corridorSequence`).** This is the real surgery. Today `corridorSequence` derives the source-exit and target-entry corridors from `edgeFwd` (`srcExitGI = gutterIndex(src, edgeFwd)`, etc.). That's correct only when sides are locked to `edgeFwd`. With overrides, `srcExitGI = gutterIndex(src, sourceSide)` and `tgtEntryGI = gutterIndex(tgt, oppositeOfEntry)` where `oppositeOfEntry` is the direction the trace travels *into* the target through its entry face — i.e., `opposite(targetSide)` (entering S means traveling N into the target).

   New signature: `corridorSequence(src, tgt, sourceSide, targetSide, isBackEdge, pivot)`. Internal logic dispatches by the corridor *kinds* (H or V) of source-exit and target-entry:
   - Both V (vertical corridors): legacy diagonal-LR case. Same-V → strip; different-V → V→H→V pivot.
   - Both H: legacy diagonal-TB case. Mirror.
   - V→H or H→V: single L. Source walks one corridor, target walks the perpendicular one, with one bend at their intersection.

   Pivot semantics (§11.7) applies only to V→V and H→H cases. The L cases have nothing to pivot — one bend, fixed by the cell positions.
4. **Pickability ([src/layout/corridors.ts](src/layout/corridors.ts)).** Pickable means "the Z has two valid orientations". Today that's "diagonal-cell forward edge". With sides decoupled, pickability = "source-exit and target-entry corridors are both V (or both H) AND they differ" — i.e., the V→H/H→V L cases are *not* pickable (no Z exists; only one bend). Update the `pickable` flag computation.
5. **Tests + example.** In `test/corridors.test.ts`:
    - `{ exit: E }` on a (−2, +1) edge: source side = E, target side = S (per implied `edgeFwd = N`), corridor sequence is `[V, H]` not `[H, V, H]`.
    - `{ entry: W }` alone flips target side; source side stays per `edgeFwd`.
    - Both together; `edgeFwd` is not consulted for sides.
    - `E_EXIT_ON_BACK_EDGE`, `E_EXIT_ON_VIA_EDGE`, `E_EXIT_INVALID_VALUE`.
    - `exit:` composes with `pivot:` only when the override leaves a V→V or H→H sequence (else `pivot:` is inert, matching same-row case).
    - `exit:` composes with `avoid:` (path search starts from the overridden face).
   And one example: re-render `examples/21-highway-mixed.melk` with `svc_c -> log { exit: E }`; eyeball-confirm the clean L-shape.

#### What this does not cover (deferred)

- **Per-side slot index override.** "Exit on E face, slot 2" — couples source to comb-tooth count, which shifts under demand changes. Out of scope.
- **Relative-direction values** (`exit: forward`). See *Isometry* — deliberately not in scope.
- **Permissive mode.** Strict only at Phase 4.4.
- **Structural-edge overrides.** Disallowed; if a future need arises, the gate is a single removed line.

#### Why this scope

The minimum that lets the author say "exit *that* way" for a single edge without introducing a parallel routing pipeline. Two narrow override slots; no new corridor logic; no new placer behavior. The §3.3 rule still runs by default — the override is opt-in friction the author pays only when they disagree with the router. Consistent with the §11.7 / §11.8 / §11.9 pattern: routing decisions are auto by default, author-overridable per-edge through brace attributes.

### 11.11 Underground highways and intersections (Phase 4.5)

A highway today renders as a dashed bounding rect with through-traces drawn at full weight. That works for a single bundle but two highways can't visually coexist: if their bounding rects overlap, the traces stack on top of each other and the diagram reads as a mess. Real-world wiring diagrams solve this with the **underground / surface metaphor**: one bundle runs at "ground level," the other dips below it through manholes, drawn lighter to imply depth.

§11.11 introduces:

1. A per-highway render mode: `render: underground` makes every via-trace through this highway dip underground.
2. An orientation knob: `orient: horizontal | vertical` on a highway overrides the `layoutMode`-derived default, so two highways can share a cell with perpendicular axes — a `+` intersection.
3. Manhole rendering: each underground via-trace gets a small filled circle at the highway's perimeter where it dips down, and another where it surfaces. Inside the box, the trace renders lighter and thinner to imply depth.

Bridges (overpasses where the bundle visibly arches over the ground-level trace) are reserved for Phase 4.6+ — see *Deferred*.

#### Grammar

Two new highway brace-attrs:

```
hwy_h { shape: highway }                               # default: horizontal under lr, vertical under tb
hwy_v { shape: highway, orient: vertical }             # perpendicular to the lr default
hwy_u { shape: highway, render: underground }          # surface remains horizontal; via-traces dip
hwy_x { shape: highway, orient: vertical,
        render: underground }                          # vertical highway, dipping
```

Values:

| Key       | Valid values                       | Default                                        |
|-----------|------------------------------------|------------------------------------------------|
| `orient`  | `horizontal`, `vertical`            | `horizontal` under `layout: lr`, `vertical` under `layout: tb` |
| `render`  | `surface` (default), `underground` | `surface`                                      |

Both keys are highway-only. Applied to a non-highway node, raise `E_HIGHWAY_ATTR_ON_NON_HIGHWAY` at bind time.

#### Two highways at the same cell

§11.9 placer-side member overlap raises `E_AMBIGUOUS_PLACEMENT` because two highway via-anchors pin their members to the same cells. §11.11 relaxes this *only when both highways are at the same cell AND have perpendicular orientations*. The new rule:

- Two via-anchors at the same cell with **same orientation** → still `E_AMBIGUOUS_PLACEMENT`. The two bundles overlap; the diagram is ambiguous.
- Two via-anchors at the same cell with **perpendicular orientations** → allowed. The placer treats them as a `+` intersection. Each highway retains its own via-member positions (sources west / east of a horizontal hwy, north / south of a vertical hwy).
- Two via-anchors that share **any member node** (source or target) → still rejected. The shared-member case (`ext_2 → metric_x { via: hwy_a }` and `ext_2 → metric_x { via: hwy_b }`) is independent of orientation; the offset math still pins both highways to the same anchor.

Cell-sharing without member-sharing is the genuine `+` case: hwy_h's members all sit in hwy_h's row band; hwy_v's members all sit in hwy_v's column band; the two cross only at one cell. The placer detects this geometry and skips the collision check for the intersecting cell.

The two highways' cells are forced to coincide via an `intersect` top-level declaration:

```
intersect hwy_h, hwy_v
```

The placer processes the intersection list after the main anchor pass: the first highway's already-placed cell becomes the anchor; each subsequent highway (plus all its via-anchor members) is shifted so it lands on the anchor cell. Bind validates that every name in an `intersect` group is a `shape: highway` node and that the group contains at least two distinct resolved orientations (else the two would still collide along their shared axis).

Member collision after the shift is detected naturally by the existing collision pass: if the shifted highway's members overlap nodes belonging to the other highway's via-anchor (or any other already-placed node), `E_AMBIGUOUS_PLACEMENT` fires. The cleanest topologies are 1-source / 1-target per highway, or 1-source / N-targets where N is small — the existing offset math centers via-anchor members around the highway cell, and dense member counts will collide between the two perpendicular axes.

Errors added by `intersect`:

- **`E_INTERSECT_UNKNOWN_HIGHWAY`** — a name doesn't resolve to any declared node.
- **`E_INTERSECT_NOT_HIGHWAY`** — the named node isn't a highway.
- **`E_INTERSECT_DUPLICATE`** — a name appears twice in the same `intersect`.
- **`E_INTERSECT_SAME_ORIENTATION`** — all named highways resolve to the same orientation.

#### Manhole semantics

For a highway with `render: underground`, every via-trace through it becomes an underground trace. The polyline for an underground trace renders in three segments:

1. **Surface entry** — from source's exit slot to the highway's entry face (the W face for a horizontal highway, the N face for a vertical one). Same as today.
2. **Underground stretch** — from the entry-face manhole to the exit-face manhole, drawn lighter (50% alpha) and thinner (1 px instead of 1.5 px). The line passes inside the highway box.
3. **Surface exit** — from the exit-face manhole to the target's entry slot. Same as today.

Manholes are filled circles, radius 3 px, drawn at the perimeter point where each via-trace would cross the highway box boundary. Same fill colour as the trace stroke (so they read as the trace pinching into a darker point at the dive).

Pseudo-code for the renderer:

```
for each via-trace t through highway H:
  if H.render == underground:
    entryPt = polyline(t).first_intersection_with(H.box_perimeter, side: H.entry_face)
    exitPt  = polyline(t).first_intersection_with(H.box_perimeter, side: H.exit_face)
    draw_manhole(entryPt)
    draw_manhole(exitPt)
    split polyline(t) into [surface_entry, underground, surface_exit]
    surface segments: render normal weight
    underground segment: render lighter + thinner
```

The polyline emitter doesn't change. The renderer's per-edge draw routine gains the split + style logic.

#### Mixed underground / surface at an intersection

For two highways crossing at a cell, one of which has `render: underground`:

- The surface highway's traces render normally — full weight, drawn ABOVE the underground highway's interior.
- The underground highway's traces render with manholes and lighter strokes — drawn BELOW the surface highway's traces visually (z-order: underground first, then surface).

The author must mark exactly one of the two crossing highways as `render: underground` for the metaphor to work. Two surface highways at the same cell will render their traces on top of each other (ambiguous, but not rejected — author error). Two underground highways at the same cell is structurally fine but visually unhelpful; not rejected.

A future warning (Phase 5+) could detect "two surface highways intersect" and suggest marking one underground.

#### Errors

- **`E_HIGHWAY_ATTR_ON_NON_HIGHWAY`** — `orient:` or `render:` on a non-highway node.
- **`E_INVALID_ORIENT_VALUE`** — `orient:` value not in `{horizontal, vertical}`.
- **`E_INVALID_RENDER_VALUE`** — `render:` value not in `{surface, underground}`.
- **`E_AMBIGUOUS_PLACEMENT`** still fires when two highways share a member or share a cell with same orientation.

#### Determinism

- Manhole positions are derived from polyline geometry, which is already byte-deterministic.
- Render order: surface traces drawn after underground traces. Within each layer, declaration order. The current renderer already uses declaration order; the only change is partitioning into two passes.

#### Implementation sketch

1. **AST + grammar.** `Property` is already kind-agnostic; the lexer accepts `horizontal | vertical | surface | underground` as bare idents. Parser changes: none.
2. **`bind/model.ts`.** Extend `ModelNode` with `orient?: "horizontal" | "vertical"` and `render?: "surface" | "underground"`. Reject on non-highway shapes (`E_HIGHWAY_ATTR_ON_NON_HIGHWAY`).
3. **`bind/bind.ts`.** In `bindNode`, accept `orient:` / `render:` properties only when `shape === "highway"`. Default both to undefined; downstream defaults to layoutMode-derived orientation and surface render.
4. **`layout/place.ts`.** In `anchorHighwayVia`, when applying offsets, use the highway's resolved orientation (explicit or layoutMode-derived). The current code already keys on horizontal-vs-vertical highway via `layoutMode`; rewire to read `node.orient ?? layoutModeDefault`.
5. **`layout/place.ts` (collision detection).** Add the `+`-intersection exception: when two highway nodes are placed at the same cell, check their resolved orientations. If perpendicular, allow; if same, raise `E_AMBIGUOUS_PLACEMENT` as today. The orientation check goes in `detectCollisions`, the function that raised the error in our recent test runs.
6. **`bind/bind.ts` (auto-sizing).** `autoSizeHighways` reads orientation to decide which axis is breadth. Already keyed off layoutMode; rewire to read explicit `orient` first.
7. **`render/svg.ts`.** Three additions:
    - When drawing a via-half polyline for an edge whose highway has `render: underground`, compute the manhole entry/exit points by intersecting the polyline against the highway's perimeter (the same `boxBounds(hwy)` rect). Split the polyline at those points.
    - Render the underground segment with `stroke-opacity="0.5"` and `stroke-width="1"`. The surface segments render at full weight.
    - Draw a `<circle>` of radius 3 at each manhole point, fill = stroke colour.
    - Z-order: in the layered render (background → nodesets → polylines → ...), insert a sub-order: underground polylines first, then surface polylines, within the polylines layer. The current layer ordering doesn't need to change; only the within-layer order.
8. **Tests.** In `test/parser.test.ts` and `test/corridors.test.ts`:
    - `render:` and `orient:` accepted on highway nodes; values typed correctly.
    - `render:` on a non-highway raises `E_HIGHWAY_ATTR_ON_NON_HIGHWAY`.
    - Invalid `orient:` / `render:` values raise the typed errors.
    - Two perpendicular highways at the same cell: no error.
    - Two same-orientation highways at the same cell: `E_AMBIGUOUS_PLACEMENT` still fires.
    - Two highways at the same cell with shared member: `E_AMBIGUOUS_PLACEMENT` still fires (orthogonal to the `+` case).
   And one example: a `+` intersection with one underground and one surface highway, traces routed through each.

#### What this does not cover (deferred)

- **Bridges (Mode 3).** A highway that visibly arches over the ground-level trace. Same "lighter or alternate-styled stretch" pattern but the dip-points are *humps* and the stretch is drawn ABOVE the surface line, not below. Reserve `render: bridge` for Phase 4.6+. The renderer's via-half draw routine already has the structure: switch on `render` mode.
- **Multi-trace manhole consolidation.** When many via-traces enter on the same face slot, the manholes may visually merge. No special handling at v1.
- **Auto-mode resolution.** When two highways intersect, the second one auto-dipping (so the author doesn't need `render: underground`). Considered and rejected for v1 because the author may want both to surface (and accept the visual mess) for a specific layout reason. Explicit beats clever.
- **Manhole labels / colour.** No per-manhole styling at v1; they're all the trace's stroke colour, fixed radius 3 px.
- **`+` intersection with via-edge passing THROUGH both highways.** `via: [hwy_h, hwy_v]` was already deferred at §11.9 (`E_VIA_MULTI_NOT_SUPPORTED`). The intersection case here is structurally different: each trace uses exactly one highway, but two highways share a cell. Multi-via stays out of scope.

#### Why this scope

Underground rendering is the smallest visual change that lets two highways visually coexist. The author marks one highway `render: underground`, declares the second highway with perpendicular `orient:`, and the placer's existing collision check learns one exception (perpendicular same-cell allowed). The renderer gains a split-and-restyle pass on a small set of edges. No new routing logic; no new corridor primitives; no new graph search. The bridge metaphor reuses the same hook with a different style — left as a Phase 4.6+ deferred item.

### 11.12 Per-node source-slot ordering override (Phase 4.6)

The default slot allocator sorts outgoing edges on a source node's exit face by `oppositePerp` (spatial order of the opposite endpoint), then `eventualPerp` for via-half siblings, then declaration order. Combined with the track packer's interval-reuse rule (locked per [feedback-highway-invariants](../memory/feedback-highway-invariants.md)), this produces visually-clean fans in most cases but tangles when a single source has multiple via-half traces to widely-separated targets (e.g. ext_1 in `examples/19-highway-with-pipeline.melk` fans out to svc_a and svc_b via the same highway, and the short-reach trace squeezes into a low track ordinal while the long-reach trace gets pushed to a higher ordinal).

No tunable for the default algorithm catches every case — the geometric tradeoff between fan-out comb-tooth stagger and chamfer-zone overlap is inherently topology-dependent. The §11.12 solution: give the author a per-node escape hatch to **force declaration order** on outgoing slots, untangling by hand when the algorithm produces unwanted output.

#### Grammar

A new property `slot-order:` on any node:

```
ext_1 { slot-order: declaration }
```

Values:

| Value         | Meaning                                                                                       |
|---------------|-----------------------------------------------------------------------------------------------|
| `declaration` | Outgoing edges from this node take face slots in declaration order (first edge → slot 0).    |
| _(unset)_     | Default: oppositePerp / eventualPerp sort.                                                    |

Cardinal value only. Unknown value raises `E_INVALID_SLOT_ORDER_VALUE`. Future values (e.g. `by-target`, `reverse-declaration`) extend cleanly without breaking files written today.

#### Semantics

**Asymmetric:** the override affects only **outgoing** edges' source-face slots. Incoming edges' target-face slots on the same node continue to use the default oppositePerp sort. Reasoning: most tangles surface as fan-out crossings near the source; symmetric overrides would also reorder *incoming* traces in ways the author rarely wants.

For each face of the marked node:
- Collect every edge whose source endpoint is this node and whose source-side face is the face in question (via the existing side-assignment).
- Assign source slots in `model.edges[]` declaration order: first edge → slot 0, second → slot 1, etc.
- Skip face capacity check changes — the existing E_SIDE_OVERSUBSCRIBED error path is unaffected.

**Composition with `via:`**: works the same way. A via-edge `ext_1 -> svc_a { via: hwy }` synthesizes into `ext_1 -> hwy` (first half) + `hwy -> svc_a` (second half) at bind time. The first-half edge is the one whose source is `ext_1`, so its source-face slot is what `slot-order: declaration` controls. Second halves (originating at the highway) are unaffected unless the highway itself carries `slot-order: declaration`.

**Composition with `pivot:` / `exit:` / `avoid:`**: orthogonal. `slot-order:` controls only the source-face slot index; the corridor sequence, pivot choice, and avoid path search all run normally on the resulting routes.

**No interaction with track packing**: `slot-order:` changes what slot each trace claims on its source face, which feeds the `entry` coordinate of the track allocator. The track allocator's interval-reuse rule and comb-tooth stagger are unchanged — `slot-order: declaration` just shifts which intervals it sees.

#### Errors

- **`E_INVALID_SLOT_ORDER_VALUE`** — value is not `declaration` (the only valid value at v1).

#### Determinism

`slot-order: declaration` reads from `model.edges[]` index, which is set by bind-time declaration order and stable. Same input, same output.

#### Implementation sketch

Four touches:

1. **Model** ([src/bind/model.ts](src/bind/model.ts)): add `slotOrder?: "declaration"` to `ModelNode`.
2. **Bind** ([src/bind/bind.ts](src/bind/bind.ts) `applyNodeProperty`): accept `slot-order:` on any node; validate value; thread into `ModelNode.slotOrder`.
3. **Corridors** ([src/layout/corridors.ts](src/layout/corridors.ts) `assignSlots`): when sorting the `bySide` pending list for a (node, side) key where `endpoint === "from"`, if `node.slotOrder === "declaration"`, use a pure `edgeIndex`-ascending sort instead of the `oppositePerp / eventualPerp / pivotCoord / edgeIndex` chain. Target-side (`endpoint === "to"`) keeps default sort.
4. **Tests** (`test/corridors.test.ts`): outgoing edges with `slot-order: declaration` slot in declaration order; incoming edges sort default; invalid value raises typed error; via-half edges honor the override on their source-face slot. And convert `it.skip` tangle test `ext_1 → svc_a/svc_b traces should not tangle on the fan-out side` to use `slot-order: declaration` and pass.

#### What this does not cover (deferred)

- **Reverse-declaration order** (`slot-order: reverse-declaration`). Easy to add later; same machinery.
- **By-target order** (`slot-order: by-target`). Approximately what the default does already via `oppositePerp`. Not worth a separate value at v1.
- **Per-face override.** `slot-order: { E: declaration, S: default }` — possible if needed, but the asymmetric "outgoing only" rule already implicitly per-face for free-edge sources.
- **Symmetric incoming override.** Could come later as `inbound-slot-order:` or similar. Not in v1.
- **Mixing tagged and untagged edges from the same source.** The override applies to ALL outgoing edges; no opt-in/opt-out per edge.

#### Why this scope

The minimum that gives the author a guaranteed way to untangle a bad render by hand: re-order the .meld text, add one attribute on the offending source, re-render. No algorithm change; no risk to other examples; no new routing infrastructure. Consistent with the [feedback-declaration-order-respected](../memory/feedback-declaration-order-respected.md) principle that source order should be load-bearing when the author asks for it.

