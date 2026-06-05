# melk examples cookbook

34 worked examples in [examples/](examples/), indexed two ways:

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

- [01-simple.melk](examples/01-simple.melk) — inline `A >- B` back arrow.
- [02-back-edge.melk](examples/02-back-edge.melk) — fan-out plus a
  retry back-edge.
- [23-highway-with-backedge.melk](examples/23-highway-with-backedge.melk)
  — back-edge alongside a highway bundle.
- For a multi-edge back block (`back: { ... }`), grep examples for
  `back:`.

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
  — `render: underground` with faded outline + manhole exits.
- [28-highway-intersect.melk](examples/28-highway-intersect.melk) —
  two highways crossing at a `+` with one underground.
- [29-highway-intersect-large.melk](examples/29-highway-intersect-large.melk)
  — all-to-all 3x3 highway intersection (circuit-board feel).

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

---

## §2 — All 34 examples

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

### Composed modules

```melk
# parent.melk
layout: lr
title: "Platform overview"

import "./modules/edge.melk"          as edge
import "./modules/ingest.melk"        as ingest
import "./modules/observability.melk" as observability

pipeline data_plane: client -> edge -> ingest -> consumer

# Cross-module tap to a specific internal node:
ingest.audit -> observability.signals { tags: [critical] }
```

Each imported file is a complete `.melk` with its own theme + layout.
Parent-level edges land on the nearest internal node on the facing
side automatically (or the qualified ref's exact internal node).

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
