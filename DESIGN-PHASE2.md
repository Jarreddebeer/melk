# melk — Phase 2 design

**Status:** Phase 2 complete
**Adds to:** [DESIGN.md](DESIGN.md) (Phase 1 complete)

Phase 2 adds the three structural primitives that don't exist as first-class concepts in prior art: **spine**, **lane**, and **group**. These are not sugar over existing constructs; they each unlock a category of diagram that Phase 1 cannot express cleanly.

---

## 1. Goals

- **Spine** — A declared backbone with a direction. Members of the spine form a chain that the layout engine pins to a single axis. Peripheral nodes attach to spine members via `.branch <direction>:` and float to the sides.
- **Lane** — A named horizontal or vertical band. Nodes belong to a lane; the layout engine assigns lanes to parallel slots along the cross-axis. Lanes are renderable (subtle background fill + label) so they double as swimlanes.
- **Group** — A container with declared named ports. Children of the group lay out together; edges into the group route to a named input port; edges out route from a named output port. Visually, the group renders as a labeled rectangle around its children.

Out of scope for Phase 2: `import` (composition), radial layout, style file, atomic shape library, the bidirectional editor. Each gets its own future phase.

## 2. Grammar additions

The Phase 1 grammar is preserved unchanged. Phase 2 adds three top-level statement forms.

```
statement   := node_decl | edge_decl | layout_decl
             | spine_decl | lane_decl | group_decl   # new
```

### 2.1 Spine

```
spine pipeline: left-to-right {
  ingest -> transform -> validate -> publish
  transform .branch up:   enrich
  validate  .branch down: alert
}
```

Inside a spine block:
- Bare edge chains (`a -> b -> c`) declare the backbone. Members must form a single chain — no branching, no cycles.
- `.branch <up|down|left|right>: <node>` declares a peripheral node attached to the preceding spine member, with a hint about which side of the spine it sits on.
- Properties on spine, branch, or member declarations use the same `{ key: value }` blocks as Phase 1.

**Layout implication:** spine members get equality constraints on the cross-axis center (they all share a single line). Branches layer perpendicular to the spine axis, in the direction declared. The longest-path layering from Phase 1 already supports this — we just inject the spine chain as a "forced longest path."

### 2.2 Lane

```
lane "data plane": horizontal { ingest, transform, ods }
lane "control":    horizontal { auth, controller }
lane "egress":     horizontal { api, client }
```

A lane:
- Declares a list of node ids that belong to it.
- Has an orientation: `horizontal` (the lane runs left-to-right; nodes inside are placed left-to-right within the lane's band) or `vertical` (top-to-bottom).
- Renders as a subtle background band with a label at the lane's leading edge.

**Constraint:** lanes partition the cross-axis. For an LR diagram with three horizontal lanes, the diagram has three horizontal bands, top to bottom in declaration order. Each node MUST belong to exactly one lane *if* any lanes are declared; nodes without a lane assignment become an implicit "unassigned" lane at the end.

**Layout implication:** lane membership constrains the layered placer's cross-axis assignment. Within layer `k`, slots are partitioned by lane; lane membership wins over the barycenter ordering when they disagree. Lanes can be empty (visible band, no nodes).

### 2.3 Group

```
group AuthService {
  in:  request, token
  out: identity, error

  verify { shape: diamond }
  request -> verify
  token   -> verify
  verify  -> identity
  verify  -> error          { label: "fail" }
}

# Outside the group:
client -> AuthService.request
AuthService.identity -> dashboard
```

A group:
- Has a name (used as a prefix for external references).
- Declares `in:` and `out:` port lists. These are named connection points on the group's boundary.
- Contains child node and edge declarations using the same Phase 1 grammar.
- Renders as a labeled rectangle around its children, with the named ports rendered as small attachment points on the perimeter.

External edges connect to `GroupName.portName`. Internal edges to/from a port use just `portName`.

**Layout implication:** groups are recursive — they nest. Each group runs the placer on its children to produce an internal layout, then exposes a bounding box + port positions to the parent layout. Routing through a group goes: edge → outer routing → group boundary port → inner routing → child node.

For Phase 2, **groups cannot nest deeper than 2 levels**. Composition (`import`) will need full recursion, but Phase 2 keeps the layout impact bounded.

## 3. Layout architecture changes

Phase 1's pipeline assumed a flat node list. Phase 2 introduces *hierarchy*:

```
Phase 1 layout:    Model.nodes (flat) -> layered() -> placed nodes
Phase 2 layout:    Model (hierarchical) -> recursive layered() -> placed nodes + lane bands + group rects
```

The change is contained in `src/layout/`. The router and renderer barely change: they consume `PlacedNode[]` and `RoutedEdge[]` plus a new `LaneBand[]` and `GroupRect[]` collection.

### Specific layout changes

1. **Lane bands.** The cross-axis assignment in `layered.ts` gains a "lane partition" step: before barycenter ordering, each node is bucketed by lane; cross-axis position is determined by lane first, then slot within lane.
2. **Spine constraint.** A new pre-layering pass identifies spine chains and forces their layer assignments to be sequential (`layer[v_{i+1}] = layer[v_i] + 1`). Branches layer normally; the direction hint (up/down/left/right) influences which side of the spine they're placed on.
3. **Group recursion.** Groups are laid out depth-first: layout each group's interior independently to produce a bounding box + port positions, then treat the group as an "opaque" node (with the computed bbox as its size) when laying out the parent.

The visibility-graph router needs to know about groups so it routes edges around them, not through. This is a small change: groups added to the obstacle list during visgraph construction.

## 4. Module changes

```
src/
├── parser/
│   ├── ast.ts          + SpineDecl, LaneDecl, GroupDecl
│   ├── lexer.ts         (no changes — keywords are just identifiers)
│   └── parser.ts        + spineDecl(), laneDecl(), groupDecl()
├── bind/
│   ├── model.ts         + Spine, Lane, Group on Model
│   └── bind.ts          + buildSpine(), buildLane(), buildGroup()
├── layout/
│   ├── layered.ts        extended for spine pinning + lane partition
│   ├── groups.ts        NEW: recursive group layout
│   ├── cola.ts           extended: orchestrates groups, then top-level
│   └── geometry.ts      + LaneBand, GroupRect on Diagram
├── route/
│   └── visgraph.ts       extended: groups as obstacles + port routing
└── render/
    └── svg.ts            extended: lane bands (background), group rects
```

## 5. Milestones — all complete

1. **P2-M1 — Parser + AST + bind for spine/lane/group.** Hand-written grammar extension; spine chains support line continuation across newlines; group port refs (`Group.port`) get unified handling between external refs and bare port refs inside a group.
2. **P2-M2 — Spine layout.** Spine members pinned to consecutive layers sharing one cross-axis line. Branches placed perpendicular to the spine (left/right) at the parent's layer.
3. **P2-M3 — Lanes.** Lane bands partition cross-axis; nodes assigned to a lane sit in that lane's band. Implicit "unassigned" lane appended automatically.
4. **P2-M4 — Groups (single level).** Recursive group sub-layout; group rectangle rendered as a dashed container; named in/out ports distributed on west/east perimeter.
5. **P2-M5 — Group nesting + routing through ports.** 2-level nesting works (binder enforces the limit). Group ports become named port vertices in the visibility graph; external edges to `Group.port` route to that exact perimeter point. Group rect acts as the obstacle in the parent visibility graph; children inside the group are not duplicated as parent-layer obstacles.
6. **P2-M6 — Examples + goldens.** Five Phase 2 examples committed and locked: `04-spine`, `05-lanes`, `06-groups`, `07-nested-groups`, `08-spine-and-lanes`.

41 new tests added (20 bind + 16 layout + 5 golden). Final state: **103 tests, all passing.** Phase 1 backward compatibility preserved.

## 6. Settled decisions

- **Spine chain syntax:** compact (`a -> b -> c`). The chain members are also rendered edges. No separate "membership" declaration step.
- **Branch direction:** spine-relative — `.branch left:`, `.branch right:`, `.branch back:`, `.branch ahead:`. Unambiguous in both LR and TB orientations.
- **Group ports:** explicit `in:` / `out:` lists required. Referencing `Group.foo` where `foo` isn't in the port list is a bind error.
- **Lane + spine interaction:** orthogonal. A spine declares a backbone of *ordering*; lanes declare *cross-axis bands*. A spine traversing lanes appears as a line cutting through bands.
- **Group external edge routing:** edge polylines terminate at the group's perimeter port, not at the inner child. Routing handles the rest internally.
- **Checkpoint:** stop and review after P2-M2 (spine layout).
