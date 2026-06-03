# melk — Phase 3 design: uniform flux

**Status:** draft
**Adds to:** [DESIGN.md](DESIGN.md) (Phase 1), [DESIGN-PHASE2.md](DESIGN-PHASE2.md) (Phase 2)

Phase 3 rewrites the routing layer around a single mental model — **uniform flux** — that the prior phases failed to enforce. The earlier router treated "forward" as the only flow axis and crammed every edge through one canonical side per node. The result, exposed by the new stress examples ([09-fan-hub](examples/09-fan-hub.melk), [10-multi-port-group](examples/10-multi-port-group.melk), [11-backplane](examples/11-backplane.melk)), is visual chaos: edges enter nodes on the wrong sides, wrap around obstacles to reach nearby targets, and pile onto the same row.

This phase does not add grammar. It is a routing rewrite governed by the uniform-flux rule. The explicit `bus` primitive originally proposed at the end of Phase 2 is **deferred to Phase 3b** — until the router produces clean traces by default, a bus primitive would paint over the symptom.

---

## 1. The uniform-flux rule

Data flows in a consistent relative direction between source and target. **Forward, upward, and downward are equivalent first-class axes** — there is no privileged "layout direction" that overrides relative geometry. A node centered on the cross-axis with consumers above, beside, and below emits cleanly upward, rightward, and downward respectively.

The rule decomposes into five constraints. All five must hold for a routed edge to be valid.

### R1 — Side-by-relative-position

A node has up to three *active* sides per edge:

- The **flow-axis exit** (right in LR, bottom in TB) for any target whose center is forward of the source.
- The **upward perpendicular** for any target whose center is above the source by more than a threshold τ.
- The **downward perpendicular** for any target whose center is below the source by more than τ.

The mirror rule applies to entries: a node receives on the side facing the source, never on its forward-exit face.

τ is the half-height of the source plus the comb half-pitch (defined below) — i.e. a target is "above" only if its center is unambiguously above the source's body, not merely shifted by a comb's worth.

The fourth, **rear-facing side** (left in LR, top in TB) is reserved for back-edges and is never the default. Back-edges are an explicit topological category, not a routing fallback.

### R2 — Comb-tight pitch on every active side

Each active side carries N traces at uniform pitch P. The comb's total span (N − 1) × P must fit inside the side's length minus a small inset. P is fixed at **8 px** for now (tunable but global; replaces the per-group 18 px PORT_PITCH used by Phase 2 group ports).

If (N − 1) × P exceeds the side length minus inset, the diagram is **over-subscribed on that side** — see R5.

Labels do not influence comb placement. Labels render where they fit; if they don't fit, they are clipped or omitted.

### R3 — No shared stems

N edges produce N distinct polylines. There is no construct in melk where one polyline splits into many at a Y-junction. Bundling, when introduced in Phase 3b, is **corridor sharing** — N parallel traces running along a shared lane — never a single trunk that forks.

### R4 — No significant overlap

Two distinct edges may cross at a single point (one bend each, +90°) but may not share a segment longer than some small ε (say 4 px). Two parallel edges that would otherwise occupy the same row must be offset by at least P / 2 before they enter the shared corridor.

### R5 — No wraparound

A path from source S to target T may not pass through more than one half-plane boundary of S's bounding box. Concretely: if T is up-and-right of S, the path leaves S on the top or right side and reaches T directly. It does not leave the bottom, route around the underside of S, and approach T from below. Wraparound is the single largest cause of the chaos in 09 and 10.

---

## 2. Side selection algorithm

For each edge (S, T) the router computes:

1. **Source exit side** = the side of S whose outward normal best matches the unit vector from S.center to T.center.
   - If T.center.x ≥ S.right and |Δy| < threshold → right side (forward exit).
   - If T.center.y < S.top − τ → top side (upward exit).
   - If T.center.y > S.bottom + τ → bottom side (downward exit).
   - Diagonals: choose the side whose normal has the larger dot product with the S→T vector; ties broken in favour of the flow-axis side.
2. **Target entry side** = the mirror — the side of T whose inward normal best matches T.center → S.center.

The two sides are required to be **non-aligned facing pair** (e.g. S.right + T.left, or S.top + T.bottom). If the chosen pair would be aligned (S.top + T.top — happens when T is laterally offset but at similar y), apply the next-best mirror.

### 2.1 Per-side slot assignment

For each side of each node, count the edges that selected it. Order them by the position of the *other endpoint* along the side's secondary axis (e.g. on a right-side comb, order by target.center.y). Assign slot indices 0..N−1. Each slot gets an attachment point at side-midpoint + (slot − (N − 1) / 2) × P.

The slot is what the router treats as the edge's literal endpoint, not the side midpoint. Edges from different slots on the same side never share a column.

### 2.2 Side capacity

Side length L of a node admits ⌊(L − 2·inset) / P⌋ + 1 slots. inset is 6 px (keeps the outermost trace clear of corner rounding).

If demand exceeds capacity on any side, that's an over-subscription error — R5 territory.

---

## 3. Visgraph and A* changes

### 3.1 Visgraph

Previously: 4 ports per node, one per side midpoint. Replaced with **N ports per active side** where N is the side's slot count for the diagram. Ports are added to the lattice as named vertices; obstacle clearance treats them like the prior side-midpoint ports.

Group ports remain on the group rect's perimeter and follow the same slot rules, but with the group-port pitch now equal to P (not 18 px) for visual consistency.

### 3.2 A* cost function

Phase 2's cost: length + bend_penalty + crossing_penalty + overlap_penalty (δ).

Phase 3 adds:

- **wraparound_penalty (ω)** — large penalty applied to any path that exits S on a side and then traverses S's bounding-box silhouette by more than 50% before reaching T. Effectively makes wraparound paths infeasible.
- **wrong-side_penalty (γ)** — large penalty applied if the path enters T on a side other than the one R1/2.1 assigned. The slot system in §2.1 already pins entry; this is a safety net for the visgraph if the assigned slot was unreachable.

ω and γ are large enough that any path triggering them loses to any non-triggering alternative. They are not soft preferences; they are constraint-violation costs.

### 3.3 Removed: nudge for comb separation

The Phase 1 nudge pass spread parallel segments after the fact. With slot assignment at the source/target, parallel separation is now enforced **at the endpoints** — the nudge pass becomes a fallback for shared mid-route segments only, not a fix-up for shared origins.

---

## 4. Over-subscription as a compile error

The user raised: should the compiler refuse to render diagrams that force overlapping lines?

The answer is **yes, for specific failure modes only**, because some failure modes are topology-inherent and some are user-fixable.

### 4.1 Compile errors (user-fixable, refuse to render)

- **E_SIDE_OVERSUBSCRIBED:** more edges declared on one active side of a node than the side's slot capacity admits. The user can fix this by increasing the node's size, reducing fan-in/out, or grouping consumers behind an intermediate.
- **E_GROUP_PORT_OVERSUBSCRIBED:** a group port has more attached edges than the port comb can fit on the relevant side.
- **E_FORBIDDEN_BACK_EDGE:** an edge whose required side selection is the rear-facing side, but the edge is not declared as a back-edge. Forces the user to either reorder topology or mark the edge with explicit back-edge syntax.

### 4.2 Warnings (degraded render, not refusal)

- **W_CROSSING_UNAVOIDABLE:** two edges' slot assignments imply an unavoidable mid-route crossing. We render it as a single-point +90° crossing; the warning surfaces in the CLI so the user knows.
- **W_LABEL_CLIPPED:** an edge label didn't fit in its slot's available run.

### 4.3 Out of scope for errors

We do *not* error on diagrams whose topology has an inherent planarity violation (e.g. K₅ or K_{3,3} subgraphs). The router will produce crossings; warnings will note them. Diagnosing non-planarity is too expensive and rarely actionable.

---

## 5. Acceptance criteria

The three stress examples added at the start of Phase 3 are the acceptance set.

### 5.1 [examples/09-fan-hub.melk](examples/09-fan-hub.melk)

- Each `pN` whose center is above `switch.center` enters `switch.top` at its assigned slot. Each `pN` below enters `switch.bottom`. Producers at or near `switch`'s vertical center enter on `switch.left`.
- Same mirrored rule for consumers leaving `switch`.
- Zero edges enter `switch.right` from a producer or leave `switch.left` to a consumer.

### 5.2 [examples/10-multi-port-group.melk](examples/10-multi-port-group.melk)

- All edges leaving `router` exit `router.right` at comb-tight pitch.
- All edges arriving at each external consumer (prometheus, kafka, etc.) arrive on the consumer's `left` side, not top or bottom.
- The Bus group's output port comb has 6 ports stacked tight on the right edge; the comb height fits within the group's right side.
- No edge wraps around the Bus group's top or bottom to reach a consumer.

### 5.3 [examples/11-backplane.melk](examples/11-backplane.melk)

- Within-lane forward edges run straight.
- Cross-lane edges (e.g. `parse_a → enrich_b`) exit `parse_a.bottom`, run vertically to `enrich_b`'s row, then enter `enrich_b.left`. They do not overlap with the in-lane edges.
- No two cross-lane edges share the same vertical column without slot offset.

---

## 6. Decisions and open questions

### Decided

- **Slot ordering tie-break = declaration order.** When two edges have near-equal positional priority on the same side, the order they appear in the source `.melk` file wins. Reordering the source must reorder the rendered slots. (No "smart" reordering — explicitly *not* like ELK.)
- **Comb pitch P = 8 px, global.** Single value used for all node-side slot pitch and all group-port pitch. Replaces the 18 px PORT_PITCH from Phase 2. Revisitable if a future case demands per-layout tuning, but committed globally for now.
- **Back-edges become an explicit grammar category.** Since R5 forbids rear-side exits by default, the user must mark an edge as a back-edge for it to take the rear path. Proposed syntax: `a >- b` (mirror of `->`). The bind step produces a `backEdge: true` flag on the model edge; the router treats it as the only edge type allowed to exit the rear-facing side. Forward edges that the placer would otherwise need to reverse get rejected with E_FORBIDDEN_BACK_EDGE.

### Open

- **Cross-lane edges and Phase 2 lanes.** R1 says edges leaving downward exit the bottom side, but if the source is in a lane band and the lane sets a structural constraint, does the lane override the slot? Likely no — slots are about the node's own geometry, not the band's. Re-check against 11 once implemented.
- **Slot capacity when comb spans more than the node's side.** Current rule: error. Alternative considered: auto-resize the node. Sticking with error for now (opinionated, predictable); auto-resize would invite hidden layout drift.

---

## 7. Implementation plan

1. **R1 + R2 + side selection (§2)** — rewrite side picking in `src/route/router.ts`, change `src/route/visgraph.ts` to support N-ports-per-side. Goldens for 01–08 will all change.
2. **Slot assignment (§2.1)** — a new pass between layout and visgraph: `src/route/slots.ts` computes per-side slot indices and attachment points.
3. **A* penalties (§3.2)** — add ω and γ to `src/route/astar.ts`.
4. **Compile errors (§4.1)** — emit during the slot-assignment pass.
5. **Phase 2 group ports rebased on P** — change `PORT_PITCH` in `src/layout/groups.ts` from 18 to P.
6. **Regenerate goldens; re-eyeball 01–11.**

Phase 3b (bus primitive, corridor sharing) follows once §5 acceptance criteria pass.
