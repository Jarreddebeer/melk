/**
 * Phase 4 AST.
 *
 * The grammar is grid-native: node sizes are in cells (`WxH`), structured
 * flow declarations (`pipeline`, `bus`, `fan-out`) capture intent, tags
 * replace lanes and groups as pure annotations, and back-edges are
 * marked explicitly.
 *
 * See DESIGN-PHASE4.md for the full specification.
 */

export interface SourcePos {
  line: number;
  col: number;
  offset: number;
}

export interface SourceSpan {
  start: SourcePos;
  end: SourcePos;
}

export type ShapeName = "rect" | "roundrect" | "circle" | "diamond" | "cylinder" | "highway";
export type LayoutMode = "tb" | "lr";

/**
 * A node size. Phase 4 expresses sizes in grid cells exclusively; the
 * Phase 3 T-shirt names (S/M/L/XL) and explicit pixel sizes are removed.
 */
export interface CellSize {
  kind: "cells";
  /** Width in grid cells. Positive integer. */
  width: number;
  /** Height in grid cells. Positive integer. */
  height: number;
  span: SourceSpan;
}

/**
 * One element of an `avoid:` value (DESIGN-PHASE4.md §11.8). The parser
 * produces these from either bare identifiers (primitive / edgeset /
 * node names — disambiguated at bind time) or explicit edge refs (`a -> b`).
 */
export type AvoidRef =
  | { kind: "name"; name: string; span: SourceSpan }
  | { kind: "edge"; from: string; to: string; span: SourceSpan };

/**
 * One element of a `via:` value (DESIGN-PHASE4.md §11.9). Always a bare
 * name resolving to a highway node — edge refs are not accepted here
 * (a highway is a node, not an edge). Carries its span for error
 * messages.
 */
export interface ViaRef {
  name: string;
  span: SourceSpan;
}

/**
 * Property values: identifiers, strings, numbers, a cell size, an
 * `avoid:` list, a `via:` list, or a `tags:` list. The previous
 * "size-object" variant is removed; size is expressed via `size: WxH` only.
 */
export type PropertyValue =
  | { kind: "ident"; value: string; span: SourceSpan }
  | { kind: "string"; value: string; span: SourceSpan }
  | { kind: "number"; value: number; span: SourceSpan }
  | { kind: "cells"; width: number; height: number; span: SourceSpan }
  | { kind: "avoid-list"; items: AvoidRef[]; span: SourceSpan }
  | { kind: "via-list"; items: ViaRef[]; span: SourceSpan }
  | { kind: "tag-list"; items: { name: string; span: SourceSpan }[]; span: SourceSpan };

export interface Property {
  key: string;
  value: PropertyValue;
  span: SourceSpan;
}

/**
 * Reference to a node, optionally qualified by a port name.
 * Form: `foo` or `foo:port`.
 */
export interface NodeRef {
  node: string;
  port?: string;
  span: SourceSpan;
}

/**
 * A bare node declaration with optional property block.
 *
 *     ingest { shape: rect, size: 2x1 }
 */
export interface NodeDecl {
  kind: "node";
  name: string;
  properties: Property[];
  span: SourceSpan;
}

/**
 * A forward edge. Form: `a -> b` with optional property block.
 *
 *     ingest -> transform { label: "raw" }
 */
export interface EdgeDecl {
  kind: "edge";
  from: NodeRef;
  to: NodeRef;
  properties: Property[];
  span: SourceSpan;
}

/**
 * An explicit back-edge declared inline with the `>-` operator.
 *
 *     sink >- source
 *
 * The semantics are identical to wrapping the edge in a `back:` block;
 * the inline form is offered for ergonomics on single edges.
 */
export interface BackEdgeDecl {
  kind: "back-edge";
  from: NodeRef;
  to: NodeRef;
  properties: Property[];
  span: SourceSpan;
}

/**
 * Top-level layout directive. Sets the default flow axis.
 *
 *     layout: lr
 */
export interface LayoutDecl {
  kind: "layout";
  mode: LayoutMode;
  span: SourceSpan;
}

/**
 * Top-level crossing budget directive. Determines how many edge crossings
 * the strict compiler will permit before raising E_CROSSINGS_OVER_BUDGET.
 *
 *     crossings: 0
 *
 * Defaults to 0 if absent.
 */
export interface CrossingsDirective {
  kind: "crossings";
  budget: number;
  span: SourceSpan;
}

/**
 * Top-level theme directive (DESIGN-PHASE5-THEMING.md §2.1). Names the
 * theme used to render this diagram. The value is either a built-in
 * theme name (resolved from the catalogue) or a path to a JSON theme
 * file (resolved relative to the .melk file's directory at render time).
 *
 *     theme: schematic-dark
 *     theme: "./themes/acme.json"
 *
 * Defaults to "document-light" when absent. A CLI `--theme=NAME` flag
 * overrides this value.
 */
export interface ThemeDirective {
  kind: "theme";
  /** The raw value as written (built-in name or path). */
  value: string;
  span: SourceSpan;
}

/**
 * Top-level legend on/off directive (DESIGN-PHASE5-LEGEND §2.1).
 *
 *     legend: on
 *
 * The value `on` enables the legend. Any other value (including `off`,
 * typos like `onn`, or a missing directive entirely) leaves the legend
 * disabled. Rationale: the worst case (missing legend) is visible to the
 * author at eyeball time, so making typos noisy would be friction without
 * payoff for an opt-in feature.
 */
export interface LegendDirective {
  kind: "legend";
  /** True when the value was exactly `on`; false otherwise. */
  on: boolean;
  span: SourceSpan;
}

/**
 * Top-level legend position directive (DESIGN-PHASE5-LEGEND §2.2).
 *
 *     legend-position: right
 *
 * Values: `bottom` (default), `right`, `top`, `left`. Strict — typos
 * raise `E_LEGEND_BAD_POSITION`. The bind step enforces that this
 * directive only appears alongside an enabling `legend: on`; an orphan
 * raises `E_LEGEND_POSITION_WITHOUT_LEGEND`.
 */
export type LegendPosition = "bottom" | "right" | "top" | "left";

export interface LegendPositionDirective {
  kind: "legend-position";
  position: LegendPosition;
  span: SourceSpan;
}

/**
 * Top-level title directive (DESIGN-PHASE5-TITLES.md §1.1).
 *
 *     title: "Order Service Architecture"
 *
 * Value must be a quoted string. Embedded newlines and the empty string
 * are rejected at parse time (E_TITLE_MULTILINE / E_TITLE_EMPTY).
 * Multiple `title:` directives are last-wins.
 */
export interface TitleDirective {
  kind: "title";
  value: string;
  span: SourceSpan;
}

/**
 * Top-level subtitle directive (DESIGN-PHASE5-TITLES.md §1.1).
 * Renders as a smaller second row in the header strip below the title.
 * Same single-line rule as `title:`.
 */
export interface SubtitleDirective {
  kind: "subtitle";
  value: string;
  span: SourceSpan;
}

/**
 * Top-level caption directive (DESIGN-PHASE5-TITLES.md §1.1).
 * Renders in the footer strip below the diagram. Same single-line rule
 * as `title:`.
 */
export interface CaptionDirective {
  kind: "caption";
  value: string;
  span: SourceSpan;
}

/**
 * A linear flow declaration. Members occupy consecutive grid cells along
 * the flow axis at the same row.
 *
 *     pipeline ingest_path: ingest -> transform -> validate -> publish
 */
export interface PipelineDecl {
  kind: "pipeline";
  name: string;
  members: string[];
  span: SourceSpan;
}

/**
 * Fan-in: N producers all targeting one shared consumer with guaranteed
 * parallel traces.
 *
 *     bus power: producer_a, producer_b, producer_c -> shared
 */
export interface BusDecl {
  kind: "bus";
  name: string;
  producers: string[];
  shared: string;
  span: SourceSpan;
}

/**
 * Fan-out: one shared source distributing to N consumers as parallel
 * traces.
 *
 *     fan-out broadcast: shared -> [a, b, c]
 */
export interface FanOutDecl {
  kind: "fan-out";
  name: string;
  shared: string;
  consumers: string[];
  span: SourceSpan;
}

/**
 * Branch sides are local-relative to the parent primitive's forward
 * direction (DESIGN-PHASE4.md §6.4, §11.6):
 *   - `left`  = 90° counter-clockwise from parent forward (default)
 *   - `right` = 90° clockwise from parent forward
 *
 * Absolute cardinal names (north/south/east/west) were rejected: they
 * break isometry under inheritance — a `branch x:south:` rooted on a
 * north-pointing branch is ambiguous between page-south and local-south.
 */
export type BranchSide = "left" | "right";

/**
 * A perpendicular side-shoot off a primitive member. Anchors a single
 * member one cell off the spine on a 90°-rotated axis and gives that
 * member the rotated local forward (DESIGN-PHASE4.md §6.4). It is a
 * direction change — not a spine, fan, or pipeline. Whatever the user
 * wants downstream composes from the other primitives rooted on the
 * branched member.
 *
 *     branch enrichers:        transform -> enrich
 *     branch audit-step:right: validate  -> audit
 *
 * The `:side` suffix is `left` (default) or `right`, local-relative to
 * the parent's forward.
 */
export interface BranchDecl {
  kind: "branch";
  name: string;
  /** Undefined means default = `left` (CCW from parent's forward). */
  side?: BranchSide;
  spine: string;
  member: string;
  span: SourceSpan;
}

/**
 * Explicit back-edge block. Inside, the contained edge declarations are
 * routed through the rear-facing corridor.
 *
 *     back: sink -> source
 */
export interface BackBlockDecl {
  kind: "back-block";
  edges: { from: NodeRef; to: NodeRef; span: SourceSpan }[];
  span: SourceSpan;
}

/**
 * A nodeset — pure annotation, comma-separated members. Renders as a
 * dashed bounding rectangle around the named members after routing.
 *
 *     nodeset dataPlane: ingest, transform, validate, publish
 *
 * Nodesets do not influence placement or routing.
 */
export interface NodesetDecl {
  kind: "nodeset";
  name: string;
  members: string[];
  span: SourceSpan;
}

/**
 * A path — pure annotation, arrow-chained members. Renders as a coloured
 * highlight along the named edges. Every consecutive pair in the chain
 * must correspond to an existing edge; the binder raises
 * E_PATH_MISSING_EDGE otherwise.
 *
 *     path fastPath: ingest -> transform -> publish
 *
 * Paths do not influence placement or routing.
 */
export interface PathDecl {
  kind: "path";
  name: string;
  chain: string[];
  span: SourceSpan;
}

/**
 * An intersection declaration (DESIGN-PHASE4.md §11.11). Pre-places the
 * listed highway nodes at the same grid cell so that downstream
 * highway-via anchors all resolve relative to that shared cell. Used to
 * express a `+` intersection of two perpendicular highways.
 *
 *     intersect hwy_h, hwy_v
 *
 * Each named entry must be a `shape: highway` node. The pair must have
 * perpendicular resolved orientations (one horizontal, one vertical).
 * No-op when only one highway is named.
 */
export interface IntersectDecl {
  kind: "intersect";
  highways: { name: string; span: SourceSpan }[];
  span: SourceSpan;
}

/**
 * An edgeset — pure annotation, comma-separated edge references. Names
 * an arbitrary bundle of edges so that `avoid:` (and future `prefer:` /
 * `via:`) can refer to it by a single token instead of repeating the
 * member list at every reference site (DESIGN-PHASE4.md §11.8).
 *
 *     edgeset hot-channels: router -> alerts, router -> traces, router -> snapshots
 *
 * Each member must match an edge that exists in the model; the binder
 * raises E_EDGESET_UNKNOWN_EDGE otherwise. Edgesets do not influence
 * placement or routing on their own.
 */
export interface EdgesetDecl {
  kind: "edgeset";
  name: string;
  edges: { from: string; to: string; span: SourceSpan }[];
  span: SourceSpan;
}

/**
 * Deprecated Phase 2/3 keywords. The parser still accepts them but emits
 * E_DEPRECATED_LANE / E_DEPRECATED_GROUP / E_DEPRECATED_TAG errors via
 * the binder.
 *
 * `tag` was the Phase 4 working spelling for annotations; it split into
 * `nodeset` (comma list) and `path` (arrow chain) once the question of
 * which form a `tag` body was had to be answered by scanning ahead.
 *
 * For now the AST shape is intentionally minimal: just the keyword and
 * the body span so the error message can point at the source line.
 */
export interface DeprecatedLaneDecl {
  kind: "deprecated-lane";
  span: SourceSpan;
}

export interface DeprecatedGroupDecl {
  kind: "deprecated-group";
  span: SourceSpan;
}

export interface DeprecatedTagDecl {
  kind: "deprecated-tag";
  span: SourceSpan;
}

export type Statement =
  | NodeDecl
  | EdgeDecl
  | BackEdgeDecl
  | LayoutDecl
  | CrossingsDirective
  | ThemeDirective
  | LegendDirective
  | LegendPositionDirective
  | TitleDirective
  | SubtitleDirective
  | CaptionDirective
  | PipelineDecl
  | BusDecl
  | FanOutDecl
  | BranchDecl
  | BackBlockDecl
  | NodesetDecl
  | PathDecl
  | EdgesetDecl
  | IntersectDecl
  | DeprecatedLaneDecl
  | DeprecatedGroupDecl
  | DeprecatedTagDecl;

export interface Program {
  statements: Statement[];
}
