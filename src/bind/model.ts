/**
 * Phase 4 model.
 *
 * The Model is the output of the bind step (DESIGN-PHASE4.md §7.1). It is
 * a normalised view of the parsed source:
 *
 *   - nodes carry their declared cell size and shape
 *   - edges include every line the renderer must draw, with provenance
 *     so later stages can distinguish explicit edges from edges implied
 *     by a structured-flow declaration
 *   - structured-flow declarations (pipelines / buses / fan-outs) are
 *     retained as placement constraints; the placer (Step 4) reads them
 *     directly rather than re-traversing the AST
 *   - back-edges (`a >- b`) are dissolved into edges with isBackEdge
 *     set; the block as a unit does not survive into the model
 *   - annotations (nodesets, paths) attach decoration metadata for the
 *     renderer (Step 8); they have no effect on placement or routing
 *
 * Every Model is fully self-contained: all node references resolve, all
 * path links correspond to an edge, no duplicate names within a kind.
 * The bind step raises a BindError before producing an inconsistent
 * Model.
 */
import type { BranchSide, LayoutMode, LegendPosition, ShapeName } from "../parser/ast.js";

/** The four cardinal sides of a box. Mirrors `layout/corridors.ts` Side. */
export type EdgeSide = "N" | "E" | "S" | "W";

export interface NodeSize {
  /** Width in grid cells. Positive integer. */
  width: number;
  /** Height in grid cells. Positive integer. */
  height: number;
}

/** Highway axis orientation (§11.11). Defaults to `layoutMode`-derived. */
export type HighwayOrient = "horizontal" | "vertical";

/** Highway render mode (§11.11). Defaults to "surface". */
export type HighwayRender = "surface" | "underground";

export interface ModelNode {
  id: string;
  label: string;
  shape: ShapeName;
  size: NodeSize;
  /**
   * Highway orientation override (§11.11). When set on a `shape: highway`
   * node, overrides the `layoutMode`-derived default. Two highways at
   * the same cell are allowed only if their resolved orientations are
   * perpendicular.
   */
  orient?: HighwayOrient;
  /**
   * Highway render mode (§11.11). `underground` makes every via-trace
   * through this highway dip below the surface, rendered with manholes
   * at the highway's perimeter and a lighter stroke in between.
   */
  render?: HighwayRender;
  /**
   * Per-node source-slot ordering override (§11.12). When set to
   * `declaration`, outgoing edges from this node take their source-face
   * slot indices in model-edge declaration order (first edge → slot 0)
   * instead of the default `oppositePerp` / `eventualPerp` sort.
   * Asymmetric: affects only the source face of outgoing edges. Target-
   * face slots on the same node continue to use the default sort.
   */
  slotOrder?: "declaration";
  /**
   * Theme tags attached to this node (DESIGN-PHASE5-THEMING.md §3.1).
   * Each name resolves to a tag rule in the active theme's `tags` table
   * at render time. Multiple tags compose in declaration order — later
   * tags' properties override earlier ones. Unknown tag names raise
   * E_UNKNOWN_TAG at render-resolve time (not at bind time, because
   * bind doesn't know which theme will be applied).
   */
  tags?: string[];
  /**
   * Icon reference (DESIGN-PHASE5-ICONS §2, §3). When `shape === "icon"`
   * the icon is the node body; otherwise it renders as a badge inside
   * the regular shape. Bind validates that the referenced alias exists
   * in `Model.iconPacks`.
   */
  icon?: IconNodeRef;
  /**
   * Badge placement (DESIGN-PHASE5-ICONS §3.3). Only meaningful when
   * `shape !== "icon"`. Defaults to "inline" at render time.
   */
  iconPosition?: "inline" | "corner";
  /**
   * For shapes that render the label OUTSIDE the glyph (circle, icon),
   * the text-fit pass grows `size` to contain both the glyph AND the
   * label-below. This records the original (pre-grow) cell footprint
   * that the glyph itself should occupy at render time. The renderer
   * uses it to draw the icon at the top of the now-taller cell, with
   * the label centred in the bottom portion.
   *
   * Undefined for nodes whose label fits inside the shape (rect,
   * roundrect, diamond, cylinder).
   */
  iconArea?: { width: number; height: number };
  /**
   * Author-controlled wrapped border (DESIGN-PHASE5-ICONS addendum).
   * Only meaningful on `shape: icon(...)` and `shape: circle` nodes —
   * the shapes whose label sits outside the glyph. When `true`, the
   * renderer draws a rect matching the regular `shape: rect` outline
   * around the entire node footprint (glyph + label). When `false`,
   * no border is drawn. When undefined, the renderer falls back to
   * the theme's `strokes.icon-border` setting (default "off").
   */
  border?: boolean;
  /**
   * Per-node author shift in (col, row) cells, applied after the
   * placer's anchor/flow/normalise passes. `dCol` shifts east (+) /
   * west (-) on the page grid; `dRow` shifts south (+) / north (-).
   * Use to nudge a node whose default placement leaves its slot
   * cluster out of pixel alignment with the trace bundle it feeds.
   * Bypasses the placer's reasoning, so it can cause overlaps if
   * misused — author's responsibility to verify.
   */
  offset?: { dCol: number; dRow: number };
}

/**
 * Provenance of an edge. Lets later stages distinguish edges the user
 * wrote literally from edges that were implied by a structured-flow
 * declaration, and lets diagnostics blame the right source construct.
 *
 *   - "explicit"    : user wrote `a -> b`
 *   - "back-edge"   : user wrote `a >- b`
 *   - "pipeline"    : implied by `pipeline NAME: a -> b -> ...`
 *   - "bus"         : implied by `bus NAME: [a, b, ...] -> shared`
 *   - "fan-out"     : implied by `fan-out NAME: shared -> [a, b, ...]`
 *
 * `sourceName` carries the name of the implying construct, when present.
 * It is undefined for "explicit" and "back-edge" edges (neither carries
 * an anonymous-construct name).
 */
export type EdgeSource =
  | "explicit"
  | "back-edge"
  | "pipeline"
  | "bus"
  | "fan-out"
  | "branch"
  | "via-half";

export interface ModelEdge {
  from: string;
  to: string;
  /**
   * When the source ref was a qualified module ref (`mod.foo`), `from`
   * carries the module alias (`"mod"` — the id of the synthetic module
   * node injected into the parent's node table) and `fromInternal`
   * carries the original internal name (`"foo"`). The parent edge
   * router (Cut 4) uses `fromInternal` to translate to the internal
   * node's pixel coordinates within the module's local frame.
   *
   * Plain (unqualified) source refs leave `fromInternal` undefined.
   * (DESIGN-PHASE5-MODULES.md §2, §3.1)
   */
  fromInternal?: string;
  /** Mirror of `fromInternal` for the target side of the edge. */
  toInternal?: string;
  /** Set for back-edges (declared with `>-` or inside a `back:` block). */
  isBackEdge?: boolean;
  fromPort?: string;
  toPort?: string;
  label?: string;
  source: EdgeSource;
  /** Name of the pipeline / bus / fan-out that implied this edge. */
  sourceName?: string;
  /**
   * Author-controlled pivot override for Z-shape routing
   * (DESIGN-PHASE4.md §11.7). When set, forces the corridor sequence to
   * pivot adjacent to either the source cell or the target cell. When
   * unset, the corridor reservation picker (demand-aware) chooses.
   *
   * Inert on same-row/same-col edges (no Z to choose).
   *
   * Rejected at bind time for structural edges (pipeline / bus /
   * fan-out / branch members) with E_PIVOT_ON_STRUCTURAL_EDGE — those
   * edges' geometry is implied by the primitive, not the corridor
   * sequence.
   */
  pivot?: "source" | "target";
  /**
   * Author-controlled obstacle avoidance (DESIGN-PHASE4.md §11.8). The
   * binder resolves the AST `avoid:` references (primitive names, edgeset
   * names, explicit edge refs, node names) to a set of edge indices into
   * `Model.edges`. The router blocks the corridors those edges traverse
   * when computing this edge's route.
   *
   * Indices are stable within a single bind — they refer to positions in
   * `Model.edges`. Downstream stages must not reorder edges.
   */
  avoidEdges?: number[];
  /**
   * Author-directed routing through one or more highway nodes
   * (DESIGN-PHASE4.md §11.9). Each name resolves to a `ModelNode` with
   * `shape: highway`. At bind time, an edge with `viaHighways` is
   * REPLACED with a pair of synthetic sub-edges (`a -> hwy`, `hwy -> b`)
   * whose `source: "via-half"`. The original via-edge index is preserved
   * on the second sub-edge via `viaOriginal` so the renderer can stitch
   * polylines back together and place the arrowhead/label.
   */
  viaHighways?: string[];
  /**
   * For `source: "via-half"` edges only — the original (user-written)
   * edge index in declaration order. Both halves of a via-pair share
   * the same `viaOriginal` value.
   *
   * The pair's renderer convention:
   *   - First half (hwy is `to`): no arrowhead, no label.
   *   - Second half (hwy is `from`): arrowhead, label.
   * The visible polyline is the concatenation of both halves.
   */
  viaOriginal?: number;
  /**
   * True if this synthetic sub-edge is the "first half" (source -> hwy)
   * of a via-pair. The polyline emitter draws this leg without an
   * arrowhead so the stitched edge looks like one continuous trace.
   */
  viaFirstHalf?: boolean;
  /**
   * Author-controlled source-face override (DESIGN-PHASE4.md §11.10).
   * When set, the trace exits the source node through this face instead
   * of the side §3.3 would derive from `edgeFwd`. The target side is
   * still derived from `edgeFwd` unless `entrySide` is also set.
   *
   * Rejected at bind time for back-edges (`E_EXIT_ON_BACK_EDGE`), via-
   * edges (`E_EXIT_ON_VIA_EDGE`), and structural-edge members
   * (`E_EXIT_ON_STRUCTURAL_EDGE` — currently unreachable syntactically).
   */
  exitSide?: EdgeSide;
  /**
   * Author-controlled target-face override (DESIGN-PHASE4.md §11.10).
   * Mirror of `exitSide` — overrides which face the trace enters at
   * the target. Independent of `exitSide`; either, both, or neither
   * may be set.
   */
  entrySide?: EdgeSide;
  /**
   * Theme tags attached to this edge (DESIGN-PHASE5-THEMING.md §3.1).
   * See `ModelNode.tags` for resolution semantics.
   */
  tags?: string[];
}

/**
 * A linear flow constraint. Members must be placed at consecutive cells
 * along the flow axis at the same row (DESIGN-PHASE4.md §2.2).
 *
 * The corresponding edges (member[i] -> member[i+1]) are also added to
 * `Model.edges` with source = "pipeline" so the renderer draws them.
 * The placer reads `Pipeline` to enforce the alignment constraint.
 */
export interface Pipeline {
  name: string;
  members: string[];
}

/**
 * A fan-in constraint. Producers must be placed at consecutive rows at
 * the same column; `shared` at the next column at the median row
 * (DESIGN-PHASE4.md §2.2).
 *
 * One edge per producer (producer -> shared) is added to `Model.edges`
 * with source = "bus".
 */
export interface Bus {
  name: string;
  producers: string[];
  shared: string;
}

/**
 * A fan-out constraint. Mirror of `Bus`: `shared` at one column,
 * consumers at consecutive rows at the next column.
 *
 * One edge per consumer (shared -> consumer) is added to `Model.edges`
 * with source = "fan-out".
 */
export interface FanOut {
  name: string;
  shared: string;
  consumers: string[];
}

/**
 * A direction-change anchor (DESIGN-PHASE4.md §6.4). Places `member`
 * one cell off `spine` on the 90°-rotated axis and gives `member` the
 * rotated local forward. Any further primitive rooted on `member`
 * inherits that forward, which is what makes a pipeline rooted on the
 * branched member run along the branched axis.
 *
 * `side` is `left` (default, CCW from parent's forward) or `right` (CW).
 *
 * Exactly one edge is added to `Model.edges`: `spine → member` with
 * source = "branch".
 */
export interface Branch {
  name: string;
  side?: BranchSide;
  spine: string;
  member: string;
}

/**
 * A node-set annotation. Renders as a dashed bounding rectangle around
 * the named members after routing (DESIGN-PHASE4.md §6.5). Has no
 * influence on placement or routing.
 */
export interface Nodeset {
  name: string;
  members: string[];
}

/**
 * A path annotation. Renders as a coloured highlight along the edges
 * connecting consecutive members in the chain (DESIGN-PHASE4.md §6.5).
 * Has no influence on placement or routing.
 *
 * The bind step guarantees that every consecutive pair `chain[i] ->
 * chain[i+1]` corresponds to an existing edge in `Model.edges` (either
 * forward or back); otherwise it raises E_PATH_MISSING_EDGE.
 */
export interface Path {
  name: string;
  chain: string[];
}

/**
 * A named bundle of edges (DESIGN-PHASE4.md §11.8). Pure annotation,
 * mirroring `Nodeset` for edges: it does not influence placement or
 * routing on its own, but `avoid:` (and future `prefer:` / `via:`) can
 * refer to an edgeset name to expand to its member edges.
 *
 * The bind step stores members as edge indices into `Model.edges` so
 * downstream resolution doesn't have to re-look-up by (from, to).
 */
export interface Edgeset {
  name: string;
  edgeIndices: number[];
}

/**
 * Via-anchor membership for a highway (DESIGN-PHASE4.md §11.9). Built
 * during bind: for each highway, the list of distinct nodes that appear
 * as the *source* of any `via: hwy` edge (on the highway's incoming-
 * short-face side) and the list that appear as the *target* (outgoing
 * side). Member order = declaration order of the via-edges; first
 * appearance fixes a node's rank on its side.
 *
 * The placer uses this to position via-members relative to the highway.
 * The router uses it to assign entry/exit tracks (one block of adjacent
 * tracks per source/target, sized by the number of via-edges from/to
 * that node).
 */
export interface HighwayMembership {
  /** Highway node id. */
  name: string;
  /** Source-side member node ids, in declaration order. Each appears once. */
  sources: string[];
  /** Target-side member node ids, in declaration order. Each appears once. */
  targets: string[];
}

/**
 * An anchor reference — a single entry in the declaration-order list of
 * placement constraints. The placer iterates `Model.anchors` rather
 * than the four typed arrays so that anchors are applied in source
 * order, which matters when a `branch` declared between two pipelines
 * needs the parent pipeline anchored before the branch, and the branch
 * anchored before any downstream pipeline rooted on its members
 * (DESIGN-PHASE4.md §2.5 isometry / §11.6).
 *
 * The kind+index pair points back into the typed arrays for full data.
 */
export type AnchorRef =
  | { kind: "pipeline"; index: number }
  | { kind: "bus"; index: number }
  | { kind: "fan-out"; index: number }
  | { kind: "branch"; index: number }
  | { kind: "highway-via"; index: number };

/**
 * A `+` intersection of two or more highways at a shared grid cell
 * (DESIGN-PHASE4.md §11.11). The placer pre-places each named highway
 * at the same cell so that the highway-via anchors snap to the shared
 * position. All members of an intersection must have perpendicular
 * orientations (cannot all be the same axis).
 */
export interface Intersection {
  highways: string[];
}

/**
 * Legend opt-in + position (DESIGN-PHASE5-LEGEND §2). Populated by bind
 * from the `legend:` and `legend-position:` directives. When the source
 * has no `legend: on`, this field is absent and the renderer emits no
 * legend strip.
 *
 * CLI `--legend=VALUE` can override this between bind and render.
 */
export interface LegendConfig {
  on: boolean;
  position: LegendPosition;
}

export interface Model {
  layoutMode: LayoutMode;
  crossingsBudget: number;
  /**
   * Theme name or path, as written in the .melk source `theme:` directive
   * (DESIGN-PHASE5-THEMING.md §2.1). Undefined when no directive was given;
   * the renderer falls back to the default theme in that case.
   * CLI `--theme=NAME` overrides this when supplied.
   */
  themeName?: string;
  /**
   * Legend configuration (DESIGN-PHASE5-LEGEND §2). Undefined when the
   * source has no `legend: on` (i.e. the legend is off). Present and
   * with `on: true` when an enabling directive was seen.
   */
  legend?: LegendConfig;
  /**
   * Diagram header title (DESIGN-PHASE5-TITLES §1.1). Renders above the
   * canvas in the header strip. Undefined when no `title:` directive
   * was given. Single-line, non-empty (parser enforces).
   */
  title?: string;
  /**
   * Diagram header subtitle (DESIGN-PHASE5-TITLES §1.1). Renders below
   * the title in the same header strip. Independent of `title` — a
   * subtitle without a title is legal.
   */
  subtitle?: string;
  /**
   * Diagram footer caption (DESIGN-PHASE5-TITLES §1.1). Renders in a
   * separate strip below the diagram body. Independent of title/subtitle.
   */
  caption?: string;
  /**
   * Icon packs registered via `icons:` directives
   * (DESIGN-PHASE5-ICONS §1.1). Order is declaration order; the
   * renderer's icon registry indexes by alias.
   */
  iconPacks: IconPackRef[];
  /**
   * Imported modules in declaration order (DESIGN-PHASE5-MODULES.md §1).
   * Each entry carries the alias used at the import site, the resolved
   * absolute path of the imported file, the imported file's bound
   * sub-Model, and (populated by the placer in Cut 3) a port table mapping
   * referenced internal node ids to their position in the module's local
   * coordinate space.
   */
  imports: ImportedModule[];
  nodes: ModelNode[];
  edges: ModelEdge[];
  pipelines: Pipeline[];
  buses: Bus[];
  fanOuts: FanOut[];
  branches: Branch[];
  /** Declaration order of all anchor primitives — the placer iterates this. */
  anchors: AnchorRef[];
  nodesets: Nodeset[];
  paths: Path[];
  edgesets: Edgeset[];
  /**
   * Per-highway via-membership, in highway declaration order. Indexed by
   * `AnchorRef { kind: "highway-via", index }`. See `HighwayMembership`.
   */
  highwayMemberships: HighwayMembership[];
  /** Highway co-placement groups (§11.11). */
  intersections: Intersection[];
  /**
   * IDs of nodes that were auto-declared (created because an edge or
   * primitive referenced a name with no explicit declaration). Used by
   * the typo-detection warning and a future strict mode. Not load-bearing
   * for layout.
   */
  autoDeclared: string[];
}

/**
 * One registered icon pack (DESIGN-PHASE5-ICONS.md §1.1). The source is
 * either a local filesystem path or an `https://` URL; the renderer
 * resolves it against the .melk file's directory at render time.
 */
export interface IconPackRef {
  alias: string;
  source: string;
}

/**
 * An imported module (DESIGN-PHASE5-MODULES.md §1). The imported file is
 * loaded, parsed, and bound recursively under any overrides supplied at
 * the import site; the resulting sub-Model is stored here for the placer
 * to consume.
 *
 * Cut 2 populates `alias`, `resolvedPath`, and `model`. The per-module
 * placement pass (Cut 3) populates `pixelWidth`, `pixelHeight`, `ports`,
 * and `body` (the placed-and-routed internals, kept around so the
 * renderer can emit them under the module's resolved theme without
 * re-running the layout pipeline).
 */
export interface ImportedModule {
  /** The alias used at the import site (the `as <alias>` token). */
  alias: string;
  /** Resolved absolute path of the imported file on disk. */
  resolvedPath: string;
  /** The bound sub-Model of the imported file, after override application. */
  model: Model;
  /**
   * The module's pixel-space footprint, populated by the per-module
   * placement pass (`placeModules` in src/layout/module-place.ts).
   * The footprint origin is (0, 0) local to the module; the parent
   * placer positions the synthetic node and the renderer translates by
   * the synthetic node's parent-frame position at emit time.
   */
  pixelWidth?: number;
  pixelHeight?: number;
  /**
   * Port table: maps a referenced internal node id (as seen in the
   * parent edge's `fromInternal` / `toInternal`) to its position in the
   * module's local pixel coordinate system. Populated by the per-module
   * placement pass.
   */
  ports?: Map<string, ModulePort>;
  /**
   * Face ports — inferred entry/exit positions for face-to-face module
   * edges (no qualified ref on the corresponding endpoint). For each
   * face N/S/E/W, the ordered list of every visible internal node's
   * matching face midpoint, sorted by position along the face axis.
   *
   * Single edge: slot 0 → first candidate (closest to the natural
   * starting end of the face — top for W/E, left for N/S).
   *
   * Multiple edges arriving at the same face: the slot allocator
   * orders them spatially by opposite-endpoint position; the polyline
   * builder uses each slot index to pick a different candidate, so
   * the edges spread across distinct internal nodes' face midpoints.
   * Overflow (more edges than candidates) cycles through with modulo.
   *
   * Empty face: the polyline builder falls back to the synthetic
   * cell's face slot pixel (current default behaviour for a module
   * with no visible internals on that side).
   */
  facePorts?: {
    N: { localX: number; localY: number }[];
    S: { localX: number; localY: number }[];
    E: { localX: number; localY: number }[];
    W: { localX: number; localY: number }[];
  };
  /**
   * The fully laid-out + routed sub-model body (Cut 3 populates; Cut 5
   * renders). Carries enough information for the renderer to emit the
   * module's internal SVG without re-running the layout pipeline. The
   * type is `unknown` here to avoid a cyclic dep on layout types from
   * model.ts; the renderer casts to `ModulePlacedBody` from
   * `src/layout/module-place.ts`.
   */
  body?: unknown;
  /**
   * Cross-flow alignment offset, in pixels, added to the module body's
   * local origin at render time and to every port/face-port lookup that
   * the polyline builder makes. Populated by `applyModuleAlignment`
   * after parent placement so the body shifts to line up flow-axis
   * ports with their connected counterparts. Defaults to 0 / 0.
   *
   * - LR parent layout: cross-flow axis is Y; `bodyOffsetY` is the
   *   active dimension, `bodyOffsetX` stays 0.
   * - TB parent layout: cross-flow axis is X; `bodyOffsetX` is active.
   *
   * The offset is clamped so the body stays inside the synthetic cell
   * the parent placer reserved for the module (i.e. the cell's row/col
   * extent isn't violated).
   */
  bodyOffsetX?: number;
  bodyOffsetY?: number;
}

/**
 * A module port — the connection point for an external edge entering or
 * leaving the module (DESIGN-PHASE5-MODULES.md §3.1, §4.3). The
 * coordinates are in the module's local pixel space; Cut 4 translates
 * them by the synthetic node's parent-frame position before handing them
 * to the edge router.
 *
 * `faceSide` is the side of the module's bounding box closest to the
 * referenced internal node — the parent edge router uses it as a hint
 * for the polyline's arrival direction.
 */
export interface ModulePort {
  internalNodeId: string;
  localX: number;
  localY: number;
  /** Internal node's pixel width (= size.width * CELL_PX). */
  localWidth: number;
  /** Internal node's pixel height (= size.height * CELL_PX). */
  localHeight: number;
  faceSide: "N" | "S" | "E" | "W";
}

/**
 * A resolved icon reference (DESIGN-PHASE5-ICONS.md §2.1, §3.1). The
 * `alias` matches a registered pack; the `name` is the slash-joined
 * path within the pack.
 */
export interface IconNodeRef {
  alias: string;
  name: string;
}
