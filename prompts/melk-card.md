# melk authoring card

A self-contained quick reference for authoring `.melk` (text-first
architecture diagrams → SVG, deterministic layout, orthogonal routing).
This card alone is enough for most diagrams; reach for SYNTAX.md /
EXAMPLES.md only for details it doesn't cover. After writing, run
`melk validate <file>` and fix what it reports until it prints `OK`.

## Grammar cheat-sheet (one line per form)

```
# directives (each at most once; defaults shown)
layout: lr            # or tb. DEFAULT lr. Swapping lr<->tb rotates everything.
crossings: 0          # DEFAULT 0 — ANY crossing fails until you raise this.
theme: document-light # or document-dark | schematic-light | schematic-dark | "./x.json"
title: "..."   subtitle: "..."   caption: "..."
legend: on            # needs ≥1 tagged node (tags: future|critical|deprecated)
icons: aws from "./icons/aws/"
import "./mod.melk" as m

# nodes (block optional; undeclared refs auto-declare as 5x5 rect)
id { shape: rect, size: 9x5, label: "Text", tags: [critical], icon: aws/lambda }
#   shape: rect|roundrect|circle|diamond|cylinder|highway|icon(alias/name)
#   size:  WxH in 8px cells. DECLARED SIZE IS AUTHORITATIVE — nothing grows to fit a label.

# edges
a -> b                      # forward
a -> b { label: "x" }       # labelled
sink >- source              # back-edge (perimeter-routed). canonical form.
a -> b { via: trunk }       # route through a highway (highways are via:-only)
a -> b { exit: S }          # leave a's south face; entry: forces target face

# composition primitives (these CREATE edges AND constrain placement)
pipeline name: a -> b -> c          # linear chain
bus name: [p1, p2, p3] -> sink      # many producers → one sink (sink anchored here)
fan-out name: src -> [t1, t2, t3]   # one source → many targets
branch name:right: spine -> member  # ONE side-channel (:right or :left). a direction change.
intersect hwy_a, hwy_b              # cross two highways (highways only)

# annotations (style/highlight only, never move things)
nodeset name: a, b, c               # draw a box around a group; renders a visible name
path name: a -> b -> c              # highlight an existing edge chain
edgeset name: a -> b, c -> d
```

## Picking `size:` from the label (count chars in the LONGEST line)

| Longest line | rect/roundrect | cylinder | diamond | circle |
|--------------|----------------|----------|---------|--------|
| 1–4          | 5x5  | 5x5  | 5x5   | 5x5   |
| 5–6          | 7x5  | 7x5  | 7x7   | 7x7   |
| 7–9          | 9x5  | 9x7  | 9x9   | 9x9   |
| 10–12        | 11x5 | 11x7 | 11x11 | 11x11 |
| 13–15        | 13x5 | 13x9 | 13x13 | 13x13 |

+2 height per extra `\n` line. All-caps/wide labels: bump one row.
`validate`/`render` warn `W_LABEL_OVERFLOW` with the exact size if you
get it wrong — so iterate, don't agonise.

## The five recipes that cover most briefs

```
# 1. Linear flow
pipeline main: ingest -> transform -> load

# 2. Fan-out then rejoin
fan-out split: lb -> [web1, web2, web3]
bus join: [web1, web2, web3] -> gateway

# 3. Shared backing service: ONE anchor, plain edges for the rest
bus enqueue: [web1, web2] -> queue
fan-out workers: queue -> [worker1, worker2]
bus writes: [worker1, worker2] -> db
branch warm:right: worker2 -> cache

# 4. Fan-in to a mid-pipeline stage: split the spine at the merge node
bus feeds: [ingest, ext_a, ext_b] -> merge
pipeline tail: merge -> publish

# 5. Tree (chained fan-outs): size mid nodes to ~2k cells for k leaves
crossings: 20
fan-out root: r -> [mid_a, mid_b]
fan-out la: mid_a -> [leaf_a1, leaf_a2]
fan-out lb: mid_b -> [leaf_b1, leaf_b2]
mid_a { size: 5x11 }
mid_b { size: 5x11 }
```

## Rules LLM authors reliably break

- **`branch` is single-member.** Two side-channels = one `:right` + one
  `:left`, or a `fan-out`.
- **Bare edge off a spine collides** (`E_AMBIGUOUS_PLACEMENT`). Wrap it
  in `branch`/`fan-out`/`bus`. The error's hint is shape-aware — read it.
- **Highways are `via:`-only.** Never `producer -> highway`. Use
  `producer -> sink { via: highway }`.
- **A node feeding two shared sinks**: one `bus`/`fan-out` anchors, the
  rest are plain edges. Two anchoring busses to one sink collide.
- **No self-edges.** `a -> a` is rejected (`E_SELF_EDGE`); model a
  feedback loop as a back-edge `a >- upstream`.
- **Chained bare edges are illegal.** `a -> b -> c` must be
  `pipeline name: a -> b -> c`.
- **Crossing topologies need `crossings: N`.** The error names N.

## Error → fix quick map

| code | fix |
|------|-----|
| `E_AMBIGUOUS_PLACEMENT` | wrap colliding edge in branch/fan-out/bus; read the shape-aware hint |
| `E_ANCHOR_CONFLICT` | a node is anchored twice; drop it from one construct |
| `E_SIDE_OVERSUBSCRIBED` | grow the hub: `size: 5x9` (7+ edges per face) |
| `E_CROSSINGS_OVER_BUDGET` | add `crossings: N` (N is in the message) |
| `E_UNROUTABLE` | feedback edge? use `c >- a`. else `crossings:` / `exit:` / `offset:` |
| `E_LANE_FULL` / `E_AXIAL_OVERLAP` | too dense — resize/offset neighbours, split a bundle, or `exit:`/`entry:` |
| `E_TRACE_THROUGH_NODE` | endpoints are in separate parked constructs; chain them in one primitive |
| `E_HIGHWAY_AS_ENDPOINT` | use `via:`, not a direct edge to the highway |
| `E_SELF_EDGE` | model the loop as a back-edge to an upstream node |
| `W_SUSPECTED_TYPO` | an endpoint auto-declared a near-miss of a declared node — check the spelling |
```
