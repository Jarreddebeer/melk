# melk — Phase 3b design: channel-track routing

**Status:** draft
**Adds to:** [DESIGN.md](DESIGN.md), [DESIGN-PHASE2.md](DESIGN-PHASE2.md), [DESIGN-PHASE3-FLUX.md](DESIGN-PHASE3-FLUX.md)
**Replaces:** the A\*-with-cost-knobs router in `src/route/astar.ts` and its post-passes (`ripup.ts`, `nudge.ts`).

Phase 3 enforced the uniform-flux rule (R1–R5) and the global grid through slot assignment. Routing inside those constraints is still done by A\* searching the visibility graph, with cost knobs (β bend, γ crossing, δ overlap, ω overshoot). Three failure modes have proven irreducible under that model:

1. **Pencil convergence** — when N edges leave a node and head for N different targets, A\* funnels them through whichever vertical column is cheapest, producing a converge-then-fan shape instead of N parallel traces.
2. **U-turn detours** — when an edge could pass over an obstacle directly, A\* may instead leave the bounding box, run east, and come back ([examples/06-groups.svg](examples/06-groups.svg) `verify→dashboard` has three pointless bends going around the audit log).
3. **Crossing-avoidance overdetour** — when a sibling edge has already claimed a column, the next edge takes a 4-bend detour rather than cross with one bend ([examples/11-backplane.svg](examples/11-backplane.svg) `parse_c→enrich_a`).

These all share one root cause: **A\* searches one edge at a time without a model of what looks right.** Cost knobs encode local preferences but cannot express "these six edges should form a parallel bus" or "two crossings is fine; a U-turn is not."

Phase 3b replaces A\* with a domain-aware algorithm rooted in the PCB autorouter tradition: **channels and tracks**.

---

## 1. Core concepts

### 1.1 Channel

A **channel** is a rectangular strip of free space between two parallel obstacle edges (or between an obstacle and the diagram boundary). Channels are either **horizontal** (long axis = x, short axis = y, between two rows of obstacles) or **vertical** (between two columns).

Channels are *induced* by box placement — they aren't declared. The channel graph is computed once after layout.

For melk's box-on-grid layout, a "row of obstacles" is a set of boxes sharing the same layered-placer rank. The horizontal channel between rank `k` and rank `k+1` is the strip whose y-extent is [bottom of rank `k`, top of rank `k+1`], and whose x-extent is the full diagram width (minus any boxes in either rank that intrude).

### 1.2 Track

A **track** is a single grid-aligned row or column inside a channel. A horizontal channel of height H px has ⌊H / COMB_PITCH⌋ tracks. A vertical channel of width W has ⌊W / COMB_PITCH⌋ tracks.

Each track can carry **at most one edge segment per x-range** (for a horizontal channel) or per y-range (for a vertical channel). Two edges may share a track only if their x-ranges (or y-ranges) are disjoint.

### 1.3 Route

A **route** for an edge is a sequence of (channel, track) assignments connected by **turns** at channel-channel intersections. The polyline is generated from the channel/track sequence at the end.

Example: `parse_c → enrich_a` in [11-backplane](examples/11-backplane.melk).

- Channel sequence: vertical-channel-between-parse-and-enrich → horizontal-channel-above-lane-A.
- Track in vertical channel: track 2 (chosen so it doesn't collide with parse_a→enrich_a's vertical).
- Track in horizontal channel: not needed; the path connects directly to enrich_a.west.
- Polyline: `(parse_c.east.slot) → (vchannel.track2 entry) → (vchannel.track2 exit) → (enrich_a.west)`.

This is **2 bends** by construction.

---

## 2. Algorithm overview

Pipeline:

```
layout → slots → channel graph → pass 1: channel assignment → pass 2: track packing → polyline emission
```

### 2.1 Channel graph

After layout, compute the channel graph:

1. **Identify rows.** A *row* is a maximal set of boxes whose y-extents overlap. Rows are ordered by their top y.
2. **Identify columns.** A *column* is a maximal set of boxes whose x-extents overlap. Columns ordered by left x.
3. **Horizontal channels.** Between every adjacent pair of rows there's one horizontal channel; also one above the topmost row and one below the bottommost row (the "ambient" channels).
4. **Vertical channels.** Same logic with columns. Vertical channels are the spaces between adjacent columns.
5. **Channel-channel intersections.** A horizontal channel and a vertical channel intersect at their geometric crossing. Each intersection is a node in the channel graph.
6. **Slot-port edges.** Each box's slot ports attach to the adjacent channel of the appropriate side (e.g. a north-side slot attaches to the horizontal channel above the box).

The channel graph is small (O(boxes²) nodes in the worst case, usually much smaller) and computed once per diagram.

### 2.2 Pass 1: channel assignment

For each edge:

1. Find the source slot's adjacent channel and the target slot's adjacent channel.
2. Compute the shortest path in the channel graph from source channel to target channel.
3. Emit a sequence of (channel) records for the edge.

This pass does NOT pick tracks. It only decides which channels each edge passes through. Shortest path in the channel graph is cheap (small graph, simple Dijkstra).

Why "shortest path" not A\*? Because the channel graph has tens of nodes, not thousands. We can afford an exact metric (number-of-channels + length). And we want bend minimization, which is naturally expressed as "channels traversed" — each channel transition is one bend.

### 2.3 Pass 2: track packing

For each channel, collect all edges that pass through it. Pack them into tracks subject to:

- **Hard constraint:** two edges sharing a track must have disjoint extents along the channel's long axis.
- **Soft preference:** edges that enter and exit the channel at similar offsets should sit on similar tracks (avoids unnecessary crossings inside the channel).
- **Soft preference:** edges should keep approximately the same track across consecutive channels in their route (avoids crossing-channel jogs).

Track packing within a single channel is a 1D interval-coloring problem (well known, linear time given sorted intervals). Cross-channel track consistency is a second-pass optimization (greedy is fine; we can defer to a refinement phase if needed).

### 2.4 Polyline emission

For each edge:

1. Start at the source slot port.
2. For each (channel, track) in the route, emit a turn point at the channel's entry and a segment along the track.
3. End at the target slot port.

Polylines are orthogonal by construction (channels are axis-aligned, tracks are axis-aligned, turns are at channel-channel intersections).

---

## 3. How the three failures get fixed

### 3.1 Pencil convergence ([10-multi-port-group](examples/10-multi-port-group.svg))

Six edges leave `router` heading east toward different consumers. Under A\*, they all funnel through one column.

Under channel-track:

- All six edges enter the same vertical channel (between Bus.right and consumers.left).
- Track packing assigns each edge to its own track (6 edges → 6 different tracks).
- Each edge runs straight east on its slot's y-row to its assigned track, then turns north or south to its target.

No funnel: each trace has its own column-equivalent (= its track).

### 3.2 U-turn detour ([06-groups](examples/06-groups.svg))

`verify→dashboard` currently routes: east, NORTH (avoiding audit log), east, SOUTH back, east. Three bends to no purpose because both verify and dashboard sit at y=88.

Under channel-track:

- verify.east attaches to the same channel as dashboard.west (the horizontal channel containing both).
- The edge stays in that channel; track packing places it adjacent to log's row.
- Polyline: `verify.east → (track at y=88) → dashboard.west`. **0 bends** (it's collinear).

Actually `log` is between them on y=88, so the polyline can't go straight — but it doesn't need a U-turn. It needs ONE bend up to a track above log, run east, ONE bend back down. 2 bends total, not 3.

### 3.3 Crossing-avoidance overdetour ([11-backplane](examples/11-backplane.svg))

`parse_c→enrich_a` currently has 4 bends going around enrich_a's bottom.

Under channel-track:

- parse_c.east attaches to the vertical channel between parses and enriches.
- enrich_a.west attaches to the same vertical channel.
- The edge stays in that one channel; track packing assigns it a track that may share-y-range with other edges crossing the channel.
- Crossings inside a channel are fine (each edge has its own track).
- Polyline: `parse_c.east → (vchannel.track_N entry y=248) → (vchannel.track_N exit y=80) → enrich_a.west`. **2 bends.**

---

## 4. Comparison with alternatives

I considered three options before committing to channel-track:

### 4.1 A\* with shape penalties

Add a "U-turn detection" cost to A\*: penalize paths that exit and re-enter the same y-band. Tractable to implement but adds another cost knob and doesn't address the core "no shared corridor" problem. Doesn't fix pencil convergence.

**Verdict:** band-aid; ceiling is too low.

### 4.2 Channel-track (this proposal)

Replace A\* entirely with channel assignment + track packing.

**Verdict:** matches PCB autorouter tradition; addresses all three failure modes structurally; biggest implementation cost.

### 4.3 Hybrid — A\* for channel-skeleton + nudge for tracks

Use A\* on a simplified visgraph (channel graph) to pick channel sequence, then track-pack within channels. This is essentially Phase 3b but keeps A\* as the skeleton-picker.

**Verdict:** functionally identical to 4.2 because channel-graph A\* is just Dijkstra on a small graph. No reason to keep A\* machinery around just to use it on the small case.

---

## 5. Acceptance criteria

The three stress examples ([09-fan-hub](examples/09-fan-hub.melk), [10-multi-port-group](examples/10-multi-port-group.melk), [11-backplane](examples/11-backplane.melk)) plus the 8 original examples must all produce:

- **Orthogonal polylines** (already enforced by construction in the new algorithm).
- **No "pencil convergence"** — fan-out from a single node into N targets uses N distinct tracks in the immediate-outward channel.
- **No U-turns** — no path leaves a y-band and returns to the same y-band when an in-band route exists.
- **2-bend routes wherever topologically possible.** `parse_c→enrich_a` and `enrich_a→sink_c` must have the same number of bends (currently 2 vs 4).
- **Global grid** invariant preserved (verified by the existing probe script).

Tests:

- Unit tests for channel graph construction (rows/columns/channels for fixture box layouts).
- Unit tests for channel assignment (per-edge Dijkstra correctness).
- Unit tests for track packing (1D interval coloring on a known set).
- Golden regression for all 11 examples after the rewrite.

---

## 6. Decisions

- **Internal group routing uses the same algorithm.** A group's interior is treated as a sub-diagram and gets its own channel-track plan. Gateway-merge stays as in Phase 3. No special case.
- **Old code is deleted, no fallbacks.** Once channel-track passes the acceptance set, `astar.ts`, `ripup.ts`, `nudge.ts` and the slot-port lattice extensions in `visgraph.ts` are removed in the same commit that wires channel-track in. No feature flag, no fallback path. If a future diagram regresses, we fix it in channel-track.
- **Back-edges.** Back-edges (Phase 3 grammar `a >- b`) take the rear-facing channel. The channel graph treats rear-side slot attachments as legal terminals; the back-edge constraint is enforced by the source-side selection already in slots.ts. No change here.
- **Edge labels.** Labels use the longest horizontal-or-vertical segment of the polyline for placement. With channel-track that's still well-defined. No changes needed in `render/svg.ts`.

---

## 7. Implementation plan

1. **`src/route/channels.ts`** — channel graph construction. Compute rows, columns, channels, intersections, slot-channel attachments. Output a `ChannelGraph` structure.
2. **`src/route/channel-assignment.ts`** — Pass 1. For each edge, run Dijkstra in the channel graph from source-slot's channel to target-slot's channel. Output a list of `EdgeChannelPlan`.
3. **`src/route/track-packing.ts`** — Pass 2. For each channel, collect crossing edges; assign tracks. Output a list of `EdgeTrackPlan`.
4. **`src/route/polyline.ts`** — emission. Combine channel + track plans into orthogonal polylines.
5. **Wire into `routeAll`** — replace the call to A\* + ripup + nudge with the new pipeline.
6. **Test parity.** Run golden regressions; regenerate expected goldens after eyeball-check.
7. **Cleanup.** Delete `astar.ts`, `ripup.ts`, `nudge.ts`, simplify `router.ts`, drop `visgraph.ts`'s slot-port lattice extensions (channel graph supersedes them).

Step 1 is the biggest; once channel graph construction is right, steps 2-4 are mechanical.

Estimated effort: ~1 week with eyeball checkpoints after each step.
