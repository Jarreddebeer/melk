# melk examples cookbook

43 worked examples in [examples/](examples/), indexed two ways:

- **§1 — By feature**: "I want to demonstrate X, which example shows it?"
- **§2 — By number**: the canonical numbered list with one-line summaries.

If you're authoring `.melk` with an LLM, point it at this file AND
[SYNTAX.md](SYNTAX.md). The examples are the most efficient way to
absorb the language's *feel* — terse, composition-primitive-driven,
deterministic.

Every `.melk` file in [examples/](examples/) has a paired `.svg` of
its current rendered output. Open the SVG to see what the source
produces.

---

## §1 — By feature

### Basic shapes & layout

- [01-simple.melk](examples/01-simple.melk) — minimal LR flow,
  mixed shape kinds (rect, roundrect, cylinder, diamond, circle).
- [03-mixed-shapes.melk](examples/03-mixed-shapes.melk) — TB fan-out
  with mixed shapes and back-edges.
- [15a-isometric-lr.melk](examples/15a-isometric-lr.melk),
  [15b-isometric-tb.melk](examples/15b-isometric-tb.melk) — same
  topology under LR vs. TB. Demonstrates the "swap `lr` ↔ `tb` and the
  diagram rotates" property.

### Back edges

Use the inline `>-` form. Every example below uses it.

- [01-simple.melk](examples/01-simple.melk) — inline `A >- B` back arrow.
- [02-back-edge.melk](examples/02-back-edge.melk) — fan-out plus a
  retry back-edge.
- [23-highway-with-backedge.melk](examples/23-highway-with-backedge.melk)
  — back-edge alongside a highway bundle.
- [36-fix-order-lifecycle.melk](examples/36-fix-order-lifecycle.melk)
  — multiple back-edges (amend, cancel) sharing one source/target,
  showing how declaration order pins their slot stagger.

### Composition primitives

| primitive | first example | further |
|-----------|---------------|---------|
| `pipeline` | [04-spine.melk](examples/04-spine.melk) | 05, 07, 08, 11, 13, 14, 30, 31, 32 |
| `branch`   | [04-spine.melk](examples/04-spine.melk) | 08, 30, 31, 32 |
| `fan-out`  | [02-back-edge.melk](examples/02-back-edge.melk) | 03, 06, 09, 10, 12, 15a/b |
| `bus`      | [02-back-edge.melk](examples/02-back-edge.melk) | 06, 09, 12, 15a/b |
| `intersect`| [28-highway-intersect.melk](examples/28-highway-intersect.melk) | 29 |

### Annotation primitives

- `nodeset` — [05-lanes.melk](examples/05-lanes.melk),
  [06-groups.melk](examples/06-groups.melk),
  [07-nested-groups.melk](examples/07-nested-groups.melk),
  [08-spine-and-lanes.melk](examples/08-spine-and-lanes.melk),
  [13-annotations.melk](examples/13-annotations.melk).
- `path` (highlighted edge chain) —
  [13-annotations.melk](examples/13-annotations.melk).
- `edgeset` (named set of edges, used with `avoid:`) — grep examples
  for `edgeset`.

### Highways and via-routing

- [16-highway-bundle.melk](examples/16-highway-bundle.melk) — six flows
  packed into one highway bundle.
- [17-highway-inlet.melk](examples/17-highway-inlet.melk) — highway as
  an inlet to a service cluster.
- [18-highway-tb.melk](examples/18-highway-tb.melk) — same as 16/17
  rotated TB.
- [19-highway-with-pipeline.melk](examples/19-highway-with-pipeline.melk)
  — highway inlet feeding downstream pipeline tails.
- [20-two-highways.melk](examples/20-two-highways.melk) — ingress and
  egress highways flanking a cluster.
- [21-highway-mixed.melk](examples/21-highway-mixed.melk) — highway
  bundle alongside direct side-edges.
- [22-highway-with-bypass.melk](examples/22-highway-with-bypass.melk)
  — producers can bypass the highway and route direct.
- [23-highway-with-backedge.melk](examples/23-highway-with-backedge.melk)
  — bundle + back-edge + bypass mixed.
- [24-mixed-bundle-bypass.melk](examples/24-mixed-bundle-bypass.melk)
  — two disjoint highways in one diagram.
- [25-exit-override.melk](examples/25-exit-override.melk) — explicit
  `exit:` face override on a highway-bound edge.
- [27-highway-underground.melk](examples/27-highway-underground.melk)
  — `render: underground` with faded outline + manhole exits. Also
  the canonical example of auto via-shim: 6-tall hwy + 5-tall via
  sources/sinks, slot clusters auto-aligned by the placer with no
  `offset:` directives needed.
- [28-highway-intersect.melk](examples/28-highway-intersect.melk) —
  two highways crossing at a `+` with one underground.
- [29-highway-intersect-large.melk](examples/29-highway-intersect-large.melk)
  — all-to-all 3x3 highway intersection (circuit-board feel).

### Per-edge face overrides (`exit:` / `entry:`) and U-routing

- [25-exit-override.melk](examples/25-exit-override.melk) — `exit:`
  forces the highway entry face.
- [41-cqrs-event-sourcing.melk](examples/41-cqrs-event-sourcing.melk)
  — `entry: S` triggers an auto-built perimeter U-shape so the query
  trace wraps under the read-models instead of cutting through them.

### Crossings

- [14-crossings.melk](examples/14-crossings.melk) — two parallel
  pipelines that have to cross.
- [05-lanes.melk](examples/05-lanes.melk),
  [10-multi-port-group.melk](examples/10-multi-port-group.melk),
  [11-backplane.melk](examples/11-backplane.melk),
  [28-highway-intersect.melk](examples/28-highway-intersect.melk),
  [29-highway-intersect-large.melk](examples/29-highway-intersect-large.melk)
  — denser-crossing topologies.

### Titles, captions, legend

- [04-spine.melk](examples/04-spine.melk) — `title:` + `legend:`.
- [30-legend.melk](examples/30-legend.melk) — focused demo of legend
  rendering with tagged nodes.

### Theming and tags

- [04-spine.melk](examples/04-spine.melk) — `tags:` on nodes plus a
  legend caption per tag.
- [30-legend.melk](examples/30-legend.melk) — `future`, `critical`,
  `deprecated` tag rules from the built-in theme.
- [32-architecture-icons.melk](examples/32-architecture-icons.melk)
  — gradient fills via a custom tag (`linear 135deg, ...`).
- [examples/themes/](examples/themes/) — full theme JSON files used
  by some examples; copy one and edit colours to build your own.

### Icons

- [31-icons.melk](examples/31-icons.melk) — both icon-as-body
  (`shape: icon(...)`) and icon-as-badge (`icon: ...`) on the same
  page.
- [32-architecture-icons.melk](examples/32-architecture-icons.melk) —
  a 32-icon arch pack composed into a typical web-service diagram.

### Module imports

- [33-modules-basic.melk](examples/33-modules-basic.melk) — three
  imported `.melk` modules wired together; smallest module demo.
- [34-modules-framed.melk](examples/34-modules-framed.melk) — same
  topology with the dashed module-frame chrome enabled in the theme.
- [35-modules-platform.melk](examples/35-modules-platform.melk) —
  five-plane platform overview, qualified cross-module edges
  (`compute.aggregator -> observability.signals`), per-module theme
  overrides, per-edge and per-node tag overrides. The most complete
  Phase 5 demo.

Imported module bodies live in
[examples/modules/](examples/modules/).

### Real-world architectures

Examples drawn from well-known domains. Read these for the *shape*
of how real diagrams compose, not just the language surface.

- [36-fix-order-lifecycle.melk](examples/36-fix-order-lifecycle.melk)
  — FIX 4.x order flow (`NewOrderSingle` → execution reports), with
  a rejected branch off pre-trade risk and amend/cancel back-edges.
- [37-otc-swap-lifecycle.melk](examples/37-otc-swap-lifecycle.melk)
  — FpML-shaped OTC interest-rate swap (execution → confirm →
  clearing → CCP → settlement) with regulatory-reporting and
  UMR-bilateral branches.
- [38-twelve-factor-web.melk](examples/38-twelve-factor-web.melk)
  — Heroku-style Twelve-Factor topology: LB → web tier → queue →
  workers → Postgres / Redis. Demonstrates the "shared backing
  service" pattern.
- [39-kubernetes-request-path.melk](examples/39-kubernetes-request-path.melk)
  — `kubectl apply` becoming a running pod: API server → auth →
  kubelet → runtime → pod, with etcd up and scheduler down.

---

## §2 — All 43 examples

Numbered list. Each row: filename → one-line description → primary
features demonstrated.

| #   | file                                                                                            | what it shows                                                          | features |
|-----|-------------------------------------------------------------------------------------------------|------------------------------------------------------------------------|----------|
| 01  | [01-simple.melk](examples/01-simple.melk)                                                       | Linear LR flow with mixed shapes and a back-edge.                      | basics, back-edges |
| 02  | [02-back-edge.melk](examples/02-back-edge.melk)                                                 | Fan-out to three workers, join, and retry back-edge.                   | fan-out, bus, back-edges |
| 03  | [03-mixed-shapes.melk](examples/03-mixed-shapes.melk)                                           | TB fan-out with diamond/circle/cylinder and back-edges.                | shapes, layout-tb, fan-out, back-edges |
| 04  | [04-spine.melk](examples/04-spine.melk)                                                         | Horizontal spine with side branches; first `tags:` + `legend:`/`title:`. | pipeline, branch, tags, legend, title |
| 05  | [05-lanes.melk](examples/05-lanes.melk)                                                         | Three horizontal lanes with cross-lane edges.                          | pipeline, nodeset, crossings |
| 06  | [06-groups.melk](examples/06-groups.melk)                                                       | Service group with bus input and fan-out output.                       | bus, fan-out, nodeset |
| 07  | [07-nested-groups.melk](examples/07-nested-groups.melk)                                         | Linear chain with overlapping nodeset rectangles.                      | pipeline, nodeset (nested) |
| 08  | [08-spine-and-lanes.melk](examples/08-spine-and-lanes.melk)                                     | Spine with side branches plus lane nodesets.                           | pipeline, branch, nodeset |
| 09  | [09-fan-hub.melk](examples/09-fan-hub.melk)                                                     | 8-producer hub with 8-consumer fan-out.                                | bus, fan-out |
| 10  | [10-multi-port-group.melk](examples/10-multi-port-group.melk)                                   | Router with 6 output channels to multiple sinks.                       | fan-out, nodeset, crossings |
| 11  | [11-backplane.melk](examples/11-backplane.melk)                                                 | Three parallel pipelines with cross-lane edges.                        | pipeline, nodeset, crossings |
| 12  | [12-multi-bus.melk](examples/12-multi-bus.melk)                                                 | Many-source bus into hub with many-target fan-out.                     | bus, fan-out |
| 13  | [13-annotations.melk](examples/13-annotations.melk)                                             | Pipeline with `path` highlight and overlapping nodesets.               | pipeline, path-highlight, nodeset |
| 14  | [14-crossings.melk](examples/14-crossings.melk)                                                 | Two parallel pipelines with crossing edges.                            | pipeline, crossings |
| 15a | [15a-isometric-lr.melk](examples/15a-isometric-lr.melk)                                         | Hub with bus + fan-out under LR layout.                                | bus, fan-out, isometric |
| 15b | [15b-isometric-tb.melk](examples/15b-isometric-tb.melk)                                         | Same diagram rotated to TB (paired with 15a).                          | bus, fan-out, isometric |
| 16  | [16-highway-bundle.melk](examples/16-highway-bundle.melk)                                       | Highway as a parallel trace bundle for 6 flows.                        | highway, via-routing |
| 17  | [17-highway-inlet.melk](examples/17-highway-inlet.melk)                                         | Highway as inlet to a service cluster.                                 | highway, nodeset |
| 18  | [18-highway-tb.melk](examples/18-highway-tb.melk)                                               | Highway bundle rotated to TB.                                          | highway, isometric |
| 19  | [19-highway-with-pipeline.melk](examples/19-highway-with-pipeline.melk)                         | Highway inlet feeding downstream pipeline tails.                       | highway, pipeline |
| 20  | [20-two-highways.melk](examples/20-two-highways.melk)                                           | Ingress + egress highways flanking a cluster.                          | highway, nodeset |
| 21  | [21-highway-mixed.melk](examples/21-highway-mixed.melk)                                         | Highway bundle with direct side-edges.                                 | highway |
| 22  | [22-highway-with-bypass.melk](examples/22-highway-with-bypass.melk)                             | Highway with some producers bypassing directly.                        | highway |
| 23  | [23-highway-with-backedge.melk](examples/23-highway-with-backedge.melk)                         | Highway bundle plus back-edge plus bypass.                             | highway, back-edges |
| 24  | [24-mixed-bundle-bypass.melk](examples/24-mixed-bundle-bypass.melk)                             | Two disjoint highways in one diagram.                                  | highway |
| 25  | [25-exit-override.melk](examples/25-exit-override.melk)                                         | Highway with explicit `exit:` face override.                           | highway, exit override |
| 27  | [27-highway-underground.melk](examples/27-highway-underground.melk)                             | Highway as subsurface with manhole exits.                              | highway, underground render |
| 28  | [28-highway-intersect.melk](examples/28-highway-intersect.melk)                                 | Two highways crossing at a `+`; one underground.                       | highway, intersect, underground render |
| 29  | [29-highway-intersect-large.melk](examples/29-highway-intersect-large.melk)                     | All-to-all 3x3 highway crossings (circuit-board look).                 | highway, intersect, crossings, schematic theme |
| 30  | [30-legend.melk](examples/30-legend.melk)                                                       | Pipeline with tagged nodes and a legend strip.                         | legend, tags, title |
| 31  | [31-icons.melk](examples/31-icons.melk)                                                         | Body-form and badge-form icon usage on the same page.                  | icons, pipeline, branch |
| 32  | [32-architecture-icons.melk](examples/32-architecture-icons.melk)                               | Web-service architecture using a 32-icon pack with gradient tags.      | icons, gradients, tags, pipeline |
| 33  | [33-modules-basic.melk](examples/33-modules-basic.melk)                                         | Three imported `.melk` modules wired together.                         | modules |
| 34  | [34-modules-framed.melk](examples/34-modules-framed.melk)                                       | Module imports with dashed frame chrome enabled.                       | modules, theming |
| 35  | [35-modules-platform.melk](examples/35-modules-platform.melk)                                   | Five-plane platform: per-module themes, qualified refs, tagged edges.  | modules, qualified refs, per-module theme, tags |
| 36  | [36-fix-order-lifecycle.melk](examples/36-fix-order-lifecycle.melk)                             | FIX 4.x order lifecycle with reject branch and amend/cancel back-edges. | pipeline, branch, back-edges, tags, legend |
| 37  | [37-otc-swap-lifecycle.melk](examples/37-otc-swap-lifecycle.melk)                               | FpML-shaped OTC IRS lifecycle with regulatory + UMR branches.          | pipeline, branch (both sides), tags, legend |
| 38  | [38-twelve-factor-web.melk](examples/38-twelve-factor-web.melk)                                 | Twelve-Factor web app: LB → web → queue → workers → DB + cache.        | fan-out, bus, branch, shared-backing |
| 39  | [39-kubernetes-request-path.melk](examples/39-kubernetes-request-path.melk)                     | `kubectl apply` flow: API server → kubelet → pod, with etcd + scheduler. | pipeline, branch (both sides), tags, legend |
| 40  | [40-saga-choreography.melk](examples/40-saga-choreography.melk)                                 | Order-fulfilment saga with compensating transactions.                  | pipeline, branch, back-edges, tags |
| 41  | [41-cqrs-event-sourcing.melk](examples/41-cqrs-event-sourcing.melk)                             | CQRS + event sourcing; query path enters read-model from south.        | pipeline, branch, fan-out, `entry:` U-route |
| 42  | [42-card-auth.melk](examples/42-card-auth.melk)                                                 | Four-party card authorisation with full return path.                   | pipeline, branch, back-edges |
| 43  | [43-netflix-microservices.melk](examples/43-netflix-microservices.melk)                         | Netflix OSS topology: gateway → service mesh + Eureka discovery.       | pipeline, fan-out, tags, legend |

(Number 26 was removed mid-project; the numbering is sparse on purpose.)

---

## §3 — Common patterns for LLM authoring

A few recipes covering 80% of real diagrams.

### Linear flow

```melk
layout: lr

pipeline main: ingest -> parse -> validate -> publish

ingest    { shape: rect, label: "Ingest" }
parse     { shape: rect, label: "Parse" }
validate  { shape: rect, label: "Validate" }
publish   { shape: roundrect, label: "Publish" }
```

### Spine with side branches

```melk
layout: lr

pipeline main: ingest -> transform -> publish

# branch is one-member-only and is a direction change. Put the
# left-side direction change on `transform`, the right-side on
# `publish` so they don't both land at the same cell.
branch audit-out:right: transform -> audit_log
branch error-out:right: publish   -> dead_letter

audit_log   { shape: cylinder, label: "Audit log" }
dead_letter { shape: roundrect, label: "DLQ" }
```

To put more than one member on the same side off a single spine node,
root a `fan-out` on the branched node — see the next recipe.

### Fan-out → bus rejoin

```melk
layout: lr

dispatch -> scheduler
fan-out work: scheduler -> [worker_a, worker_b, worker_c]
bus     join: [worker_a, worker_b, worker_c] -> aggregator
aggregator -> results
```

### Shared backing service (DB, cache, queue) reached from many producers

This is the pattern that catches almost everyone. The instinct is
to write *two* busses — one per backing service — but only one of
them can anchor the consumer's position.

**Wrong** — two anchoring busses fight over the column past the
producers:

```melk
bus cache-reads: [web1, web2, web3] -> cache    # cache lands at col N+1
bus db-writes:   [web1, web2, web3] -> db       # db wants col N+1 too — collision!
```

Triggers `E_AMBIGUOUS_PLACEMENT` (the shared producers `web1..web3`
collide before either sink is anchored).

**Right** — pick *one* anchoring construct, let plain edges reach
the other shared targets:

```melk
# `queue` is the structural sink — the async backbone — so the bus
# anchors it. cache and db hang off the worker tier as ordinary
# edges from already-placed nodes.
bus enqueue: [web1, web2, web3] -> queue

fan-out workers:   queue -> [worker1, worker2]
bus db-writes:     [worker1, worker2] -> db
branch cache-warm:right: worker2 -> cache
```

The rule: **at most one anchoring primitive per shared target.**
Other connections to the same target use plain edges, which find
the already-placed node instead of trying to position it again.
See [38-twelve-factor-web.melk](examples/38-twelve-factor-web.melk)
for a complete worked example.

### Side-channel off a spine — bare edges collide

The single most common collision. A bare `spine_node -> side_node`
extends the spine, so the side-node lands at the next spine
column — and collides with whatever the pipeline is already
placing there.

**Wrong**:

```melk
pipeline main: ingest -> transform -> publish
transform -> audit_log    # audit_log lands at (row_of_transform, col_of_publish)
                          # → collides with publish: E_AMBIGUOUS_PLACEMENT
```

**Right** — wrap in a `branch` so the placer puts the side-node
*perpendicular* to the spine:

```melk
pipeline main: ingest -> transform -> publish
branch audit-out:right: transform -> audit_log    # one row below `transform` in LR
```

If you have two side-channels off the same spine node, put one
`:right` and one `:left`. If you have three or more, root a
`fan-out` on the spine node instead of declaring multiple
branches.

### Fan-in to a mid-pipeline stage (the merge / aggregator shape)

A pipeline whose middle stage *also* receives feeds from outside the
spine — a merge node, a shared queue, an aggregator. The instinct is
to keep the pipeline whole and add a `bus` (or plain edges) into the
middle node, but that collides: the spine already anchors the middle
node, and the bus parks its producers in the same column as the spine
head.

**Wrong**:

```melk
pipeline main: ingest -> merge -> publish
bus feeds: [ext_a, ext_b] -> merge    # ext_a collides with ingest at (0,0)
```

**Right** — make the merge node the *head* of the tail pipeline and let
one `bus` absorb the upstream spine member alongside the external
feeds:

```melk
bus feeds: [ingest, ext_a, ext_b] -> merge    # one anchor for the merge
pipeline tail: merge -> publish               # tail starts at merge
```

The merge node now has a single owner (the bus), and the tail pipeline
hangs off it cleanly. (For a single external feed you can instead use
`branch fa:right: ext_a -> merge`.)

### Trees (chained fan-outs, depth ≥ 2)

A fan-out whose targets each fan out again — an org chart, a routing
tier, a decision tree. The leaves of adjacent subtrees collide because
each mid node only reserves one row.

**Wrong**:

```melk
fan-out root: r -> [mid_a, mid_b]
fan-out la: mid_a -> [leaf_a1, leaf_a2]
fan-out lb: mid_b -> [leaf_b1, leaf_b2]    # leaf_a2 and leaf_b1 collide
```

**Right** — size each mid node to its **subtree breadth** so its leaves
get distinct rows. A mid node with *k* leaves needs roughly `2k` cells
on the breadth axis (height in `lr`, width in `tb`):

```melk
crossings: 20
fan-out root: r -> [mid_a, mid_b]
fan-out la: mid_a -> [leaf_a1, leaf_a2]
fan-out lb: mid_b -> [leaf_b1, leaf_b2]
mid_a { size: 5x11 }    # 2 leaves → ~11 cells tall in lr
mid_b { size: 5x11 }
```

### Lanes (parallel pipelines)

```melk
layout: lr
crossings: 10

# Each lane is its own pipeline (parks on its own row). They don't
# share a starting node — sharing would force a single placement and
# the lanes would collide on the next column. Cross-lane edges are
# written explicitly.
pipeline data:    ingest -> transform -> store
pipeline control: auth   -> controller
pipeline egress:  api    -> client

# Cross-lane wiring:
transform  -> auth
controller -> api
store      -> api

nodeset data-plane: ingest, transform, store
nodeset control:    auth, controller
nodeset egress:     api, client
```

### Highway-routed many-to-many

A `highway` node is **never** an edge endpoint. Use `via:` on a
regular source-to-sink edge — the trace bundles through the highway
on its way.

```melk
layout: lr

hwy { shape: highway }

src_a -> dst_x { via: hwy }
src_a -> dst_y { via: hwy }
src_b -> dst_y { via: hwy }
src_b -> dst_z { via: hwy }
src_c -> dst_x { via: hwy }
src_c -> dst_z { via: hwy }
```

The placer treats the highway as the bundle anchor: it positions
sources on one side, sinks on the other, and packs the six traces
into the same channel. Writing `source -> trunk` raises
`E_HIGHWAY_AS_ENDPOINT`.

### Highlighted critical path

```melk
layout: lr

pipeline main: cart -> payment -> ledger -> receipt

path checkout_flow: cart -> payment -> ledger -> receipt
```

The `path` directive highlights every edge in the chain in an accent
colour from the theme.

### Tagged nodes + legend

```melk
layout: lr
legend: on

pipeline main: ingest -> transform -> publish

# Side-channel destinations need a `branch` to anchor them off the spine
# (a bare `transform -> audit` edge tries to place `audit` next to
# `publish` and collides). One `:right` plus one `:left` keeps the
# placer happy when both side-nodes hang off the same spine member.
branch audit-out:right: transform -> audit
branch dlq-out:left:    transform -> dlq

audit { tags: [future] }
dlq   { tags: [critical] }
```

`future` and `critical` are built-in tags; their colours and legend
captions come from the resolved theme.

### Nudging a node with `offset:`

Most layouts don't need this — the placer handles position, and
highway via members are auto-aligned to the trace bundle's pixel
grid. Reach for `offset:` when you want a node to sit at a specific
relative cell or sub-cell, e.g. to straighten a trace the placer
left with a 4-px kink in a topology the auto-shim doesn't cover.

```melk
# Format: 'WxH' (quoted). Integer parts move grid cells; fractional
# parts (0.5, -0.5, …) become sub-cell pixel shifts.
src_b { size: 7x5, offset: "0x0.5"  }   # +4 px down
dst_y { size: 7x5, offset: "0x-0.5" }   # 4 px up
m     { size: 5x5, offset: "1x1.5"  }   # +1 col, +1 row, +4 px down
```

The author owns collision risk — the placer doesn't re-check
footprints after the offset applies. See SYNTAX.md §3.10 for the
full attribute reference and caveats.

### Forcing a face with `entry:` / `exit:`

When the natural L-route would cut through another box, force the
target face with `entry:`. The router auto-builds a perimeter U-shape
so the trace exits perpendicular to the source face, wraps around the
target's outer edge, and approaches perpendicular to the target face
(arrow points into the face).

```melk
# Three read-models sit east of the query handler. A plain
# `query -> orders_rm` would route west-into-east through the
# inventory model. Force entry on the south face — the router
# loops the trace under the read-models and approaches from below.
query -> orders_rm { entry: S }
```

`exit:` mirrors it for the source side. Both are rejected on
back-edges (which already use perimeter routing) and on via-edges.
The placer reserves a 2-cell perimeter pad whenever any edge uses
either — without it, there's no row/col "outside" the diagram for
the U to wrap through. See [41-cqrs-event-sourcing.melk](examples/41-cqrs-event-sourcing.melk).

### Composed modules

```melk
# parent.melk
layout: lr
title: "Platform overview"

import "./modules/edge.melk"          as edge
import "./modules/ingest.melk"        as ingest
import "./modules/observability.melk" as observability

pipeline data_plane: client -> edge -> ingest -> consumer

# Cross-module tap to a specific internal node. `entry: N` makes the
# trace approach observability's `signals` node from the north (the
# module is laid out tb precisely so `signals` sits on its north face).
# Without it the tap has no free channel between the two dense modules
# and routing fails with E_LANE_FULL.
ingest.audit -> observability.signals { tags: [critical], entry: N }
```

Each imported file is a complete `.melk` with its own theme + layout.
Parent-level edges land on the nearest internal node on the facing
side automatically (or the qualified ref's exact internal node).

When a tap between two dense modules can't find a channel
(`E_LANE_FULL`), steer it onto an outer face with `entry:`/`exit:`
(here `entry: N`), or pull the modules apart by giving the imported
nodes more breathing room — see §4.3 and the module-gutter note.

---

## §4 — Anti-patterns to avoid

- **Don't list every edge by hand if a primitive fits.** A 5-node
  pipeline written as 4 standalone edges is harder to read and gives
  the placer less to work with. `pipeline main: a -> b -> c -> d -> e`
  is the right form.

- **Don't use `branch` for multi-member fans.** `branch` is a
  *direction change* (single member only). For multi-member fans off
  a spine, root a `fan-out` on the branched node.

- **Don't use tags to move things.** Tags drive visual style; they
  never affect placement. Use composition primitives for layout.

- **Don't import a sub-diagram just to reuse it once and ignore it.**
  Modules add visual chrome and a `<g>` boundary. Use them when the
  sub-diagram has its own *theme* or genuinely warrants encapsulation,
  not for raw line count.

- **Don't hand-write `shape: module`.** That's reserved for the
  parser-injected synthetic node behind `import "..."`. Use `import`
  instead.

---

## §5 — Placement errors and what they mean

The placer is strict — it refuses to guess which constraint to
honour when two compete, and it refuses to silently grow a node
when its face overflows. Most errors below are structural
("your source is ambiguous; pick one shape"); the last two
(`E_SIDE_OVERSUBSCRIBED`, `E_CROSSINGS_OVER_BUDGET`) are capacity
limits that need a one-line tweak rather than a topology change.
See also SYNTAX.md §3.11 for the underlying model.

### `E_AMBIGUOUS_PLACEMENT`

Two nodes resolved to the same `(row, col)`. The error message
names both. Five common shapes trigger it:

**Shape A — bare edge from a spine to a side-channel.**

```melk
pipeline main: a -> b -> c
b -> side          # side lands at (row_of_b, col_of_c) — collides with c
```

Fix: wrap in a `branch`. `branch s:right: b -> side` places `side`
perpendicular to the spine instead of extending it.

**Shape B — two branches on the same side of one spine node.**

```melk
branch x:right: b -> side1
branch y:right: b -> side2    # both want the same perpendicular cell
```

Fix: one `:right` plus one `:left`, or replace with a single
`fan-out` rooted on `b`.

**Shape C — fan-out collides with the next pipeline node.**

```melk
pipeline main: a -> b -> c
fan-out f: b -> [x, y]    # x and y land in col_of_c — collides
```

Fix: shorten the pipeline (let `b` be the terminus), or move the
fan-out's source.

**Shape D — two anchoring primitives to the same shared sink.**

```melk
bus reads:  [w1, w2, w3] -> cache    # cache wants col N+1
bus writes: [w1, w2, w3] -> db       # db wants col N+1 too
```

Fix: pick *one* anchoring construct; reach the other shared sink
via plain edges. See §3 "Shared backing service".

**Shape E — branch member colliding with a fan-out target.**

```melk
fan-out workers: queue -> [worker1, worker2]
branch cache-warm:right: worker1 -> cache    # cache lands at row_of_worker2
```

Fix: branch off the *other* member (`worker2` here), or use a
plain edge from whichever worker is structurally appropriate.

### `E_ANCHOR_CONFLICT`

A node that one construct has *already placed* is re-anchored to a
*different* cell by a second construct. The placer can't put it in two
cells at once, so it names the node, both constructs, and both cells.

```melk
pipeline main: a -> b -> c    # places b at (row 0, col 10)
branch x:right: a -> b        # branch wants b at (row 10, col 0)
```

Fix: drop the node from one of the constructs, or split it in two.

> Note: two anchoring constructs aimed at the *same shared sink*
> (`bus a: [..] -> db` / `bus b: [..] -> db`) do **not** reach this
> error — their *producers* collide first and you get
> `E_AMBIGUOUS_PLACEMENT` (Shape D above). The fix is the same: one
> anchoring construct, plain edges for the rest.

### `E_SIDE_OVERSUBSCRIBED`

A node's face holds 1 trace per cell-unit at default pitch
(`CELL_PX = COMB_PITCH = 8`). A `5x5` face is 5 cell-units, so it holds
5 traces — but a hub (any bus/fan-out shared node) auto-parity-bumps its
breadth by +1 when the trace count needs it, so a default hub absorbs
**6** edges before overflowing. The **7th** is the first that needs
explicit sizing. Hub patterns trigger it:

- A `bus` aggregating 7+ producers into one sink.
- A `fan-out` spraying 7+ targets from one source.
- A node reached by a highway that has 7+ via-edges.

Fix: grow the hub on the axis perpendicular to flow.

```melk
hub { shape: rect, label: "hub", size: 5x7 }   # layout: lr — 7 W/E slots
hub { shape: rect, label: "hub", size: 7x5 }   # layout: tb — 7 N/S slots
```

Each extra cell-unit adds 1 slot; the error names the exact recipe.
The bind pass auto-bumps highway and hub-rect breadth by +1 when its
parity disagrees with the trace count (so slots land on cell centres);
you may see a 5x7 hub render as 5x8 in that case. See SYNTAX.md §3.11
for why explicit sizing is the author's call (determinism — silent
growth on edge-count changes would shift the whole grid).

### `E_CROSSINGS_OVER_BUDGET`

The router needs more orthogonal crossings than the default budget
allows. Common in spines with multiple branches that cross
back-edges.

Fix: raise the budget at the top of the file:

```melk
crossings: 6
```

This isn't a topology problem; it's a routing budget. The default
budget is **`0`** — *any* crossing is rejected until you opt in. The
error names the exact number required; set it at or above that
(`crossings: 6`). Set it generously and the compiler still fails loudly
only if a later re-layout introduces *more* crossings than you allowed.

### `E_HIGHWAY_AS_ENDPOINT`

A highway node was used as an edge endpoint directly. Highways are
*invisible bundlers* — sources and sinks are real nodes; the
highway appears via `via:`.

```melk
hwy { shape: highway }
src -> hwy           # WRONG — E_HIGHWAY_AS_ENDPOINT
src -> sink { via: hwy }   # right
```

### Why these errors exist

melk's layout is deterministic — the same source always produces
the same diagram. Auto-resolving collisions would mean guessing
which constraint to honour, and the guess would silently change
when surrounding code changed. The placer makes the ambiguity loud
once instead.
