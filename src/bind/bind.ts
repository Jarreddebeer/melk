/**
 * Phase 4 bind.
 *
 * Walks the parsed Program once and produces a Model (DESIGN-PHASE4.md
 * §7.1). Each AST statement projects into one or more Model entries:
 *
 *   - node decl              → ModelNode
 *   - edge (`a -> b`)        → ModelEdge { source: "explicit" }
 *   - back-edge (`a >- b`)   → ModelEdge { source: "back-block", isBackEdge }
 *   - back-block (`back: …`) → ModelEdge[] with source: "back-block"
 *   - pipeline               → Pipeline + N-1 ModelEdges (source: "pipeline")
 *   - bus                    → Bus + N ModelEdges (source: "bus")
 *   - fan-out                → FanOut + N ModelEdges (source: "fan-out")
 *   - nodeset                → Nodeset (annotation; no edges)
 *   - path                   → Path (annotation; validated against edges)
 *   - layout / crossings     → Model.{layoutMode, crossingsBudget}
 *   - deprecated lane/group/tag → BindError
 *
 * Edge endpoints that aren't explicitly declared as nodes get
 * auto-declared as 1x1 rects (matching the Phase 3 behaviour the user
 * is used to). Pipeline / bus / fan-out members get the same treatment.
 *
 * Validation done here:
 *   - duplicate node, pipeline, bus, fan-out, nodeset, path names
 *   - nodeset members must be declared nodes (E_NODESET_UNKNOWN_NODE)
 *   - path links must correspond to an existing edge (E_PATH_MISSING_EDGE)
 *   - deprecated keywords
 *
 * Connectivity (E_DISCONNECTED), cycle/back-edge checks (E_CYCLE_NO_BACK),
 * and topology errors land in the placer (Step 4), where the placement
 * passes can attribute them to specific failed constraints.
 */
import type {
  AvoidRef,
  BackBlockDecl,
  BackEdgeDecl,
  BranchDecl,
  BusDecl,
  EdgeDecl,
  EdgesetDecl,
  FanOutDecl,
  ImportDecl,
  ImportOverride,
  IntersectDecl,
  LegendPosition,
  NodeDecl,
  NodeRef,
  NodesetDecl,
  PathDecl,
  PipelineDecl,
  Program,
  Property,
  ShapeName,
  SourceSpan,
  ViaRef,
} from "../parser/ast.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { tokenize } from "../parser/lexer.js";
import { parse } from "../parser/parser.js";
import type {
  AnchorRef,
  Branch,
  Bus,
  Edgeset,
  FanOut,
  HighwayMembership,
  ImportedModule,
  Model,
  ModelEdge,
  ModelNode,
  Nodeset,
  NodeSize,
  Path,
  Pipeline,
} from "./model.js";

export class BindError extends Error {
  constructor(message: string, public span?: SourceSpan) {
    super(span
      ? `${message} at line ${span.start.line}, col ${span.start.col}`
      : message);
  }
}

/**
 * Resolves an `import "<rel>"` reference at bind time
 * (DESIGN-PHASE5-MODULES.md §1.2, §1.3). Given the path as written in the
 * source (`pathSpec`) and the importing file's absolute path
 * (`importerPath` — `undefined` for the in-memory root caller), the loader
 * returns the resolved absolute path of the imported file and its source
 * text. Throws if the file doesn't exist.
 *
 * The default loader uses Node's `fs` + `path`; tests can substitute an
 * in-memory map. The CLI calls `bind(program, { importerPath, loader })`.
 */
export interface ModuleLoader {
  load(pathSpec: string, importerPath: string | undefined): {
    resolvedPath: string;
    source: string;
  };
}

export interface BindOptions {
  /**
   * Absolute path of the file being bound, used as the base for resolving
   * relative `import` directives and for cycle detection. Undefined when
   * bind is called on in-memory source with no associated path (e.g. unit
   * tests of non-import behaviour).
   */
  importerPath?: string;
  /**
   * Loader for `import` directives. Required when the source contains any
   * `import` directive AND no in-memory module table covers them. Tests
   * pass a stub; the CLI passes a `fs`-backed default.
   */
  loader?: ModuleLoader;
  /**
   * Internal: stack of absolute paths currently being loaded, used for
   * cycle detection. Populated by recursive bind calls; callers don't
   * supply this directly. Public so the recursive call can build on it.
   */
  importStack?: string[];
}

interface BindCtx {
  nodes: Map<string, ModelNode>;
  /**
   * IDs of nodes that were auto-declared (created when an edge endpoint
   * or structured-flow member referenced an undeclared name). A
   * subsequent explicit `name { ... }` declaration is allowed to upgrade
   * such a node; a duplicate explicit declaration is an error.
   */
  autoDeclared: Set<string>;
  edges: ModelEdge[];
  pipelines: Map<string, Pipeline>;
  buses: Map<string, Bus>;
  fanOuts: Map<string, FanOut>;
  branches: Map<string, Branch>;
  /** Declaration order of every anchor primitive. */
  anchors: AnchorRef[];
  nodesets: Map<string, Nodeset>;
  paths: Map<string, Path>;
  edgesets: Map<string, Edgeset>;
  /** Per-highway via-membership, built during the deferred via pass. */
  highwayMemberships: Map<string, HighwayMembership>;
  /** Highway co-placement groups (§11.11). */
  intersections: { highways: string[] }[];
  layoutMode: "tb" | "lr";
  crossingsBudget: number;
  themeName?: string;
  /** Latest `legend: on` directive (last-wins). Undefined if never `on`. */
  legendOn: boolean;
  /** Latest `legend-position:` directive (last-wins). */
  legendPosition?: LegendPosition;
  /** Span of the most recent `legend-position:` directive (for error reporting). */
  legendPositionSpan?: SourceSpan;
  /** Latest `title:` directive value (last-wins). */
  title?: string;
  /** Latest `subtitle:` directive value (last-wins). */
  subtitle?: string;
  /** Latest `caption:` directive value (last-wins). */
  caption?: string;
  /**
   * Registered icon packs in declaration order
   * (DESIGN-PHASE5-ICONS §1.1). Aliases must be unique;
   * duplicate aliases raise E_ICON_PACK_DUPLICATE_ALIAS.
   * Sources starting with `http://` raise E_ICON_PACK_INSECURE.
   */
  iconPacks: { alias: string; source: string }[];
  /**
   * Imported modules in declaration order
   * (DESIGN-PHASE5-MODULES.md §1). Aliases must be unique within an
   * importing file; duplicates raise E_MODULE_ALIAS_DUPLICATE.
   */
  imports: ImportedModule[];
  /** Alias → imported module, for O(1) resolution of qualified refs. */
  moduleAliases: Map<string, ImportedModule>;
  /** Bind-time options propagated for recursive import resolution. */
  importerPath?: string;
  loader?: ModuleLoader;
  importStack: string[];
  /**
   * Pending `avoid:` references stashed during the first pass. Resolved
   * after every edge and primitive is in place (so that primitive names,
   * edgeset names, and edge refs all have something to resolve against).
   */
  pendingAvoids: {
    edgeIndex: number;
    items: AvoidRef[];
    declSpan: SourceSpan;
  }[];
  /**
   * Pending `via:` references stashed during the first pass. Resolved
   * after all nodes are declared, so highway-name resolution sees the
   * full node set including auto-declared highways.
   */
  pendingVias: {
    edgeIndex: number;
    items: ViaRef[];
    declSpan: SourceSpan;
  }[];
}

export function bind(program: Program, options: BindOptions = {}): Model {
  const ctx: BindCtx = {
    nodes: new Map(),
    autoDeclared: new Set(),
    edges: [],
    pipelines: new Map(),
    buses: new Map(),
    fanOuts: new Map(),
    branches: new Map(),
    anchors: [],
    nodesets: new Map(),
    paths: new Map(),
    edgesets: new Map(),
    highwayMemberships: new Map(),
    intersections: [],
    layoutMode: "lr",
    crossingsBudget: 0,
    legendOn: false,
    iconPacks: [],
    imports: [],
    moduleAliases: new Map(),
    importerPath: options.importerPath,
    loader: options.loader,
    importStack: options.importStack ?? [],
    pendingAvoids: [],
    pendingVias: [],
  };

  // Resolve imports first (DESIGN-PHASE5-MODULES.md §3.2). The module
  // alias table must be populated before any qualified ref (`mod.foo`)
  // gets bound, so we walk imports up-front.
  for (const stmt of program.statements) {
    if (stmt.kind === "import") {
      bindImport(stmt, ctx);
    }
  }

  // First pass: project everything except `path` and `edgeset`
  // annotations and `avoid:` references. Both need the full edge set in
  // place to resolve, so they run in a deferred pass.
  const deferredPaths: PathDecl[] = [];
  const deferredEdgesets: EdgesetDecl[] = [];
  const deferredIntersects: IntersectDecl[] = [];

  for (const stmt of program.statements) {
    switch (stmt.kind) {
      case "node":
        bindNode(stmt, ctx);
        break;
      case "edge":
        bindEdge(stmt, ctx, "explicit", false);
        break;
      case "back-edge":
        bindEdge(stmt, ctx, "back-block", true);
        break;
      case "back-block":
        bindBackBlock(stmt, ctx);
        break;
      case "layout":
        ctx.layoutMode = stmt.mode;
        break;
      case "crossings":
        ctx.crossingsBudget = stmt.budget;
        break;
      case "theme":
        // Multiple `theme:` directives: last one wins. Matches `layout:`
        // and `crossings:` precedent (no error for repetition).
        ctx.themeName = stmt.value;
        break;
      case "legend":
        // Last-wins, same as `theme:` / `layout:`. The directive is binary
        // by content match (DESIGN-PHASE5-LEGEND §2.1): `on` enables; any
        // other value silently disables. The parser already stamped that
        // boolean onto stmt.on, so a later `legend: off` (or typo) flips
        // back to off without error.
        ctx.legendOn = stmt.on;
        break;
      case "legend-position":
        ctx.legendPosition = stmt.position;
        ctx.legendPositionSpan = stmt.span;
        break;
      case "title":
        ctx.title = stmt.value;
        break;
      case "subtitle":
        ctx.subtitle = stmt.value;
        break;
      case "caption":
        ctx.caption = stmt.value;
        break;
      case "icons":
        bindIconsDirective(stmt, ctx);
        break;
      case "import":
        // Already processed in the pre-pass above.
        break;
      case "pipeline":
        bindPipeline(stmt, ctx);
        break;
      case "bus":
        bindBus(stmt, ctx);
        break;
      case "fan-out":
        bindFanOut(stmt, ctx);
        break;
      case "branch":
        bindBranch(stmt, ctx);
        break;
      case "nodeset":
        bindNodeset(stmt, ctx);
        break;
      case "path":
        deferredPaths.push(stmt);
        break;
      case "edgeset":
        deferredEdgesets.push(stmt);
        break;
      case "intersect":
        deferredIntersects.push(stmt);
        break;
      case "deprecated-lane":
        throw new BindError(
          "E_DEPRECATED_LANE: the `lane` keyword is removed in Phase 4. Use `nodeset` for visual grouping (see DESIGN-PHASE4.md §6.5).",
          stmt.span,
        );
      case "deprecated-group":
        throw new BindError(
          "E_DEPRECATED_GROUP: the `group` keyword is removed in Phase 4. Use `nodeset` for visual grouping (see DESIGN-PHASE4.md §6.5).",
          stmt.span,
        );
      case "deprecated-tag":
        throw new BindError(
          "E_DEPRECATED_TAG: the `tag` keyword has been split into `nodeset` (comma list) and `path` (arrow chain) in Phase 4 (see DESIGN-PHASE4.md §6.5).",
          stmt.span,
        );
    }
  }

  for (const stmt of deferredPaths) bindPath(stmt, ctx);
  // Edgesets must resolve before pending avoids, because an avoid: may
  // reference an edgeset by name.
  for (const stmt of deferredEdgesets) bindEdgeset(stmt, ctx);
  for (const pending of ctx.pendingAvoids) resolvePendingAvoid(pending, ctx);
  for (const pending of ctx.pendingVias) resolvePendingVia(pending, ctx);

  // Highway integrity + via-anchor registration (§11.9).
  // Order:
  //   1. reject highway-as-endpoint on USER-WRITTEN edges (before any
  //      synthetic via-half edges are added).
  //   2. build memberships (uses viaHighways on user-written edges).
  //   3. auto-size.
  //   4. validate orientation.
  //   5. expand via-edges into pairs of synthetic via-half sub-edges
  //      (`a -> hwy`, `hwy -> b`). After this point, downstream stages
  //      see no `viaHighways` — they see two regular edges per via.
  // DESIGN-PHASE5-LEGEND §2.2: legend-position: without legend: on is an
  // error. Catches the upstream typo case (e.g. `legend: onn`) silently
  // disabling the legend while the author still expects a positioned
  // strip. Fires at bind time so the offending source location is
  // pointed at; renderer doesn't have to re-check.
  if (ctx.legendPosition !== undefined && !ctx.legendOn) {
    throw new BindError(
      "E_LEGEND_POSITION_WITHOUT_LEGEND: `legend-position:` requires `legend: on`. " +
        "Either add `legend: on` or remove this directive.",
      ctx.legendPositionSpan!,
    );
  }

  // DESIGN-PHASE5-ICONS §4.1 — every node-level icon ref must resolve
  // against a registered alias. Runs after the first pass so that an
  // `icons:` directive declared AFTER a referencing node still
  // registers in time.
  validateIconRefs(ctx);

  rejectHighwayEndpoints(ctx);
  buildHighwayMemberships(ctx);
  // §11.13: bindIntersect must run BEFORE autoSizeHighways so the
  // sizer can see intersect partnerships and expand each highway's
  // flow-direction length to match the perpendicular partner's
  // breadth (which is what makes all-to-all trace crossings possible
  // in a `+` intersection).
  validateHighwayOrientation(ctx);
  for (const stmt of deferredIntersects) bindIntersect(stmt, ctx);
  autoSizeHighways(ctx);
  expandViaEdges(ctx);

  return {
    layoutMode: ctx.layoutMode,
    crossingsBudget: ctx.crossingsBudget,
    ...(ctx.themeName !== undefined ? { themeName: ctx.themeName } : {}),
    ...(ctx.legendOn
      ? { legend: { on: true, position: ctx.legendPosition ?? "bottom" } }
      : {}),
    ...(ctx.title !== undefined ? { title: ctx.title } : {}),
    ...(ctx.subtitle !== undefined ? { subtitle: ctx.subtitle } : {}),
    ...(ctx.caption !== undefined ? { caption: ctx.caption } : {}),
    iconPacks: ctx.iconPacks,
    imports: ctx.imports,
    nodes: [...ctx.nodes.values()],
    edges: ctx.edges,
    pipelines: [...ctx.pipelines.values()],
    buses: [...ctx.buses.values()],
    fanOuts: [...ctx.fanOuts.values()],
    branches: [...ctx.branches.values()],
    anchors: ctx.anchors,
    nodesets: [...ctx.nodesets.values()],
    paths: [...ctx.paths.values()],
    edgesets: [...ctx.edgesets.values()],
    highwayMemberships: [...ctx.highwayMemberships.values()],
    intersections: ctx.intersections,
  };
}

// --- nodes & edges --------------------------------------------------------

function bindNode(decl: NodeDecl, ctx: BindCtx): void {
  if (ctx.nodes.has(decl.name) && !ctx.autoDeclared.has(decl.name)) {
    // If the existing node is a synthetic module-shape node, the
    // collision is between an import alias and a parent-level node
    // declaration — report it as such so the user can rename one.
    if (ctx.moduleAliases.has(decl.name)) {
      throw new BindError(
        `E_MODULE_ALIAS_COLLIDES_WITH_NODE: node '${decl.name}' shares a name with ` +
          `the import alias on the same line. Rename one.`,
        decl.span,
      );
    }
    throw new BindError(
      `duplicate node declaration: '${decl.name}'`,
      decl.span,
    );
  }
  const shapeBox: { value: ShapeName } = { value: "rect" };
  let size: NodeSize = { width: 1, height: 1 };
  let label = decl.name;
  let orient: "horizontal" | "vertical" | undefined;
  let render: "surface" | "underground" | undefined;
  let slotOrder: "declaration" | undefined;
  let tags: string[] | undefined;
  let icon: { alias: string; name: string } | undefined;
  let iconPosition: "inline" | "corner" | undefined;
  let iconPositionSeen = false;
  let iconSeen = false;
  let border: boolean | undefined;
  let orientSpan: { line: number; col: number; offset: number } | undefined;
  let renderSpan: { line: number; col: number; offset: number } | undefined;
  for (const prop of decl.properties) {
    if (prop.key === "orient") orientSpan = prop.span.start;
    if (prop.key === "render") renderSpan = prop.span.start;
    if (prop.key === "icon") iconSeen = true;
    if (prop.key === "icon-position") iconPositionSeen = true;
    applyNodeProperty(
      prop,
      (s) => (shapeBox.value = s),
      (sz) => (size = sz),
      (l) => (label = l),
      (o) => (orient = o),
      (r) => (render = r),
      (so) => (slotOrder = so),
      (t) => (tags = t),
      (i) => (icon = i),
      (p) => (iconPosition = p),
      (bv) => (border = bv),
    );
  }
  // DESIGN-PHASE5-ICONS §3.2 — both shape: icon(...) and icon: on the
  // same node is rejected. The body form already names the icon; an
  // extra badge attr would compete for the same visual real estate.
  if (shapeBox.value === "icon" && iconSeen) {
    throw new BindError(
      "E_ICON_SHAPE_WITH_ICON_ATTR: a node cannot use both `shape: icon(...)` and `icon:`. " +
        "Pick one (DESIGN-PHASE5-ICONS §3.2).",
      decl.span,
    );
  }
  // DESIGN-PHASE5-ICONS §2.1 — `shape: icon` without a call-form
  // argument is meaningless: the shape needs to know WHICH icon. Either
  // the author wrote `shape: icon(alias/name)` (which sets `icon` via
  // the call-form path) or they typed `shape: icon` standalone — the
  // latter is a mistake.
  if (shapeBox.value === "icon" && icon === undefined) {
    throw new BindError(
      "E_ICON_BAD_REF: `shape: icon` requires a call-form argument like `shape: icon(alias/name)` " +
        "(DESIGN-PHASE5-ICONS §2.1).",
      decl.span,
    );
  }
  // DESIGN-PHASE5-ICONS §3.1 — icon-position: without icon: is meaningless.
  // Reject loudly so a typo'd icon attr (e.g. `icno:` instead of `icon:`)
  // doesn't silently leave a misleading orphan position.
  if (iconPositionSeen && !iconSeen && shapeBox.value !== "icon") {
    throw new BindError(
      "E_ICON_POSITION_WITHOUT_ICON: `icon-position:` requires `icon:` or `shape: icon(...)`. " +
        "Either add an `icon:` attribute or remove this directive.",
      decl.span,
    );
  }
  // §11.11: orient: and render: are highway-only.
  if (shapeBox.value !== "highway") {
    if (orient !== undefined) {
      throw new BindError(
        `E_HIGHWAY_ATTR_ON_NON_HIGHWAY: 'orient:' is only valid on \`shape: highway\` nodes (DESIGN-PHASE4.md §11.11)`,
        { start: orientSpan!, end: orientSpan! },
      );
    }
    if (render !== undefined) {
      throw new BindError(
        `E_HIGHWAY_ATTR_ON_NON_HIGHWAY: 'render:' is only valid on \`shape: highway\` nodes (DESIGN-PHASE4.md §11.11)`,
        { start: renderSpan!, end: renderSpan! },
      );
    }
  }
  const node: import("./model.js").ModelNode = { id: decl.name, label, shape: shapeBox.value, size };
  if (orient !== undefined) node.orient = orient;
  if (render !== undefined) node.render = render;
  if (slotOrder !== undefined) node.slotOrder = slotOrder;
  if (tags !== undefined && tags.length > 0) node.tags = tags;
  if (icon !== undefined) node.icon = icon;
  if (iconPosition !== undefined) node.iconPosition = iconPosition;
  if (border !== undefined) node.border = border;
  ctx.nodes.set(decl.name, node);
  ctx.autoDeclared.delete(decl.name);
}

function bindEdge(
  decl: EdgeDecl | BackEdgeDecl,
  ctx: BindCtx,
  source: ModelEdge["source"],
  isBack: boolean,
): void {
  const fromRes = resolveNodeRefId(decl.from, ctx);
  const toRes = resolveNodeRefId(decl.to, ctx);
  let label: string | undefined;
  let pivot: "source" | "target" | undefined;
  let avoidItems: AvoidRef[] | undefined;
  let viaItems: ViaRef[] | undefined;
  let exitSide: "N" | "E" | "S" | "W" | undefined;
  let entrySide: "N" | "E" | "S" | "W" | undefined;
  let tags: string[] | undefined;
  for (const prop of decl.properties) {
    if (prop.key === "label") {
      if (prop.value.kind !== "string") {
        throw new BindError("label must be a string", prop.value.span);
      }
      label = prop.value.value;
    } else if (prop.key === "pivot") {
      if (prop.value.kind !== "ident") {
        throw new BindError(
          "pivot must be `source` or `target`",
          prop.value.span,
        );
      }
      if (prop.value.value !== "source" && prop.value.value !== "target") {
        throw new BindError(
          `unknown pivot value: '${prop.value.value}'. Expected \`source\` or \`target\` (DESIGN-PHASE4.md §11.7).`,
          prop.value.span,
        );
      }
      pivot = prop.value.value;
    } else if (prop.key === "avoid") {
      if (prop.value.kind !== "avoid-list") {
        // Defensive: the parser always normalises avoid: to an avoid-list,
        // so this branch only fires if some future change forgets to.
        throw new BindError(
          "avoid expects a name, an edge reference, or a bracketed list",
          prop.value.span,
        );
      }
      avoidItems = prop.value.items;
    } else if (prop.key === "via") {
      if (prop.value.kind !== "via-list") {
        throw new BindError(
          "via expects a highway name or a bracketed list of highway names",
          prop.value.span,
        );
      }
      viaItems = prop.value.items;
    } else if (prop.key === "exit" || prop.key === "entry") {
      if (prop.value.kind !== "ident") {
        throw new BindError(
          `E_EXIT_INVALID_VALUE: ${prop.key} must be one of N, E, S, W (DESIGN-PHASE4.md §11.10)`,
          prop.value.span,
        );
      }
      const v = prop.value.value;
      if (v !== "N" && v !== "E" && v !== "S" && v !== "W") {
        throw new BindError(
          `E_EXIT_INVALID_VALUE: unknown ${prop.key} value: '${v}'. Expected one of N, E, S, W (DESIGN-PHASE4.md §11.10).`,
          prop.value.span,
        );
      }
      if (isBack) {
        throw new BindError(
          `E_EXIT_ON_BACK_EDGE: ${prop.key}: is not supported on back-edges (DESIGN-PHASE4.md §11.10).`,
          prop.span,
        );
      }
      if (prop.key === "exit") exitSide = v;
      else entrySide = v;
    } else if (prop.key === "tags") {
      if (prop.value.kind !== "tag-list") {
        throw new BindError(
          "tags must be a name or bracketed list of names",
          prop.value.span,
        );
      }
      tags = prop.value.items.map((it) => it.name);
    } else {
      throw new BindError(`unknown edge property: '${prop.key}'`, prop.span);
    }
  }
  if (viaItems !== undefined && (exitSide !== undefined || entrySide !== undefined)) {
    throw new BindError(
      `E_EXIT_ON_VIA_EDGE: exit:/entry: is not supported on edges with via: (DESIGN-PHASE4.md §11.10).`,
      decl.span,
    );
  }
  const edge: ModelEdge = {
    from: fromRes.id,
    to: toRes.id,
    source,
  };
  if (fromRes.internal !== undefined) edge.fromInternal = fromRes.internal;
  if (toRes.internal !== undefined) edge.toInternal = toRes.internal;
  if (decl.from.port !== undefined) edge.fromPort = decl.from.port;
  if (decl.to.port !== undefined) edge.toPort = decl.to.port;
  if (label !== undefined) edge.label = label;
  if (isBack) edge.isBackEdge = true;
  if (pivot !== undefined) edge.pivot = pivot;
  if (exitSide !== undefined) edge.exitSide = exitSide;
  if (entrySide !== undefined) edge.entrySide = entrySide;
  if (tags !== undefined && tags.length > 0) edge.tags = tags;
  const edgeIndex = ctx.edges.length;
  ctx.edges.push(edge);
  if (avoidItems !== undefined) {
    ctx.pendingAvoids.push({
      edgeIndex,
      items: avoidItems,
      declSpan: decl.span,
    });
  }
  if (viaItems !== undefined) {
    ctx.pendingVias.push({
      edgeIndex,
      items: viaItems,
      declSpan: decl.span,
    });
  }
}

function bindBackBlock(decl: BackBlockDecl, ctx: BindCtx): void {
  for (const e of decl.edges) {
    const fromRes = resolveNodeRefId(e.from, ctx);
    const toRes = resolveNodeRefId(e.to, ctx);
    const edge: ModelEdge = {
      from: fromRes.id,
      to: toRes.id,
      source: "back-block",
      isBackEdge: true,
    };
    if (fromRes.internal !== undefined) edge.fromInternal = fromRes.internal;
    if (toRes.internal !== undefined) edge.toInternal = toRes.internal;
    if (e.from.port !== undefined) edge.fromPort = e.from.port;
    if (e.to.port !== undefined) edge.toPort = e.to.port;
    ctx.edges.push(edge);
  }
}

// --- structured flow ------------------------------------------------------

function bindPipeline(decl: PipelineDecl, ctx: BindCtx): void {
  if (ctx.pipelines.has(decl.name)) {
    throw new BindError(
      `E_DUPLICATE_PIPELINE: pipeline '${decl.name}' is declared more than once. ` +
        `Hint: rename one of them (the name is used in error messages and as edge source attribution).`,
      decl.span,
    );
  }
  for (const m of decl.members) ensureNode(m, ctx);
  ctx.pipelines.set(decl.name, { name: decl.name, members: [...decl.members] });
  ctx.anchors.push({ kind: "pipeline", index: ctx.pipelines.size - 1 });
  for (let i = 0; i < decl.members.length - 1; i++) {
    ctx.edges.push({
      from: decl.members[i]!,
      to: decl.members[i + 1]!,
      source: "pipeline",
      sourceName: decl.name,
    });
  }
}

function bindBus(decl: BusDecl, ctx: BindCtx): void {
  if (ctx.buses.has(decl.name)) {
    throw new BindError(
      `E_DUPLICATE_BUS: bus '${decl.name}' is declared more than once. ` +
        `Hint: rename one of them.`,
      decl.span,
    );
  }
  for (const p of decl.producers) ensureNode(p, ctx);
  ensureNode(decl.shared, ctx);
  ctx.buses.set(decl.name, {
    name: decl.name,
    producers: [...decl.producers],
    shared: decl.shared,
  });
  ctx.anchors.push({ kind: "bus", index: ctx.buses.size - 1 });
  for (const p of decl.producers) {
    ctx.edges.push({
      from: p,
      to: decl.shared,
      source: "bus",
      sourceName: decl.name,
    });
  }
}

function bindFanOut(decl: FanOutDecl, ctx: BindCtx): void {
  if (ctx.fanOuts.has(decl.name)) {
    throw new BindError(
      `E_DUPLICATE_FAN_OUT: fan-out '${decl.name}' is declared more than once. ` +
        `Hint: rename one of them.`,
      decl.span,
    );
  }
  ensureNode(decl.shared, ctx);
  for (const c of decl.consumers) ensureNode(c, ctx);
  ctx.fanOuts.set(decl.name, {
    name: decl.name,
    shared: decl.shared,
    consumers: [...decl.consumers],
  });
  ctx.anchors.push({ kind: "fan-out", index: ctx.fanOuts.size - 1 });
  for (const c of decl.consumers) {
    ctx.edges.push({
      from: decl.shared,
      to: c,
      source: "fan-out",
      sourceName: decl.name,
    });
  }
}

function bindBranch(decl: BranchDecl, ctx: BindCtx): void {
  if (ctx.branches.has(decl.name)) {
    throw new BindError(
      `E_DUPLICATE_BRANCH: branch '${decl.name}' is declared more than once. ` +
        `Hint: rename one of them.`,
      decl.span,
    );
  }
  ensureNode(decl.spine, ctx);
  ensureNode(decl.member, ctx);
  ctx.branches.set(decl.name, {
    name: decl.name,
    ...(decl.side !== undefined ? { side: decl.side } : {}),
    spine: decl.spine,
    member: decl.member,
  });
  ctx.anchors.push({ kind: "branch", index: ctx.branches.size - 1 });
  ctx.edges.push({
    from: decl.spine,
    to: decl.member,
    source: "branch",
    sourceName: decl.name,
  });
}

// --- annotations ----------------------------------------------------------

function bindNodeset(decl: NodesetDecl, ctx: BindCtx): void {
  if (ctx.nodesets.has(decl.name)) {
    throw new BindError(
      `E_DUPLICATE_NODESET: nodeset '${decl.name}' is declared more than once. ` +
        `Hint: rename one of them.`,
      decl.span,
    );
  }
  for (const m of decl.members) {
    if (!ctx.nodes.has(m)) {
      throw new BindError(
        `E_NODESET_UNKNOWN_NODE: nodeset '${decl.name}' references undeclared node '${m}'`,
        decl.span,
      );
    }
  }
  ctx.nodesets.set(decl.name, { name: decl.name, members: [...decl.members] });
}

function bindEdgeset(decl: EdgesetDecl, ctx: BindCtx): void {
  if (ctx.edgesets.has(decl.name)) {
    throw new BindError(
      `E_DUPLICATE_EDGESET: edgeset '${decl.name}' is declared more than once. ` +
        `Hint: rename one of them.`,
      decl.span,
    );
  }
  // Conflict with primitive names — keeps resolution unambiguous when
  // `avoid:` looks up a bare name.
  if (
    ctx.pipelines.has(decl.name) ||
    ctx.buses.has(decl.name) ||
    ctx.fanOuts.has(decl.name) ||
    ctx.branches.has(decl.name) ||
    ctx.nodesets.has(decl.name) ||
    ctx.nodes.has(decl.name)
  ) {
    throw new BindError(
      `E_NAME_CONFLICT: edgeset '${decl.name}' shadows another declaration with the same name`,
      decl.span,
    );
  }
  const indices: number[] = [];
  for (const ref of decl.edges) {
    const found = findEdgeIndex(ctx, ref.from, ref.to);
    if (found === -1) {
      throw new BindError(
        `E_EDGESET_UNKNOWN_EDGE: edgeset '${decl.name}' references edge '${ref.from} -> ${ref.to}' but no such edge exists`,
        ref.span,
      );
    }
    indices.push(found);
  }
  ctx.edgesets.set(decl.name, { name: decl.name, edgeIndices: indices });
}

/**
 * §11.11 intersection: validate that each named entry is a declared
 * highway and that the group contains at least two distinct
 * orientations. Stores the resolved names in `ctx.intersections`.
 *
 * Resolved orientation is what the placer cares about — explicit
 * `orient:` if set, else the layoutMode-derived default. A group of
 * highways that all resolve to the same orientation would collide at
 * the same cell (same axis = same offset math), so we reject it here
 * rather than letting the placer raise E_AMBIGUOUS_PLACEMENT.
 */
function bindIntersect(decl: IntersectDecl, ctx: BindCtx): void {
  if (decl.highways.length < 2) {
    throw new BindError(
      "intersect requires at least two highways",
      decl.span,
    );
  }
  const names: string[] = [];
  const orientations = new Set<"horizontal" | "vertical">();
  const layoutHoriz = ctx.layoutMode === "lr";
  for (const ref of decl.highways) {
    const node = ctx.nodes.get(ref.name);
    if (!node) {
      throw new BindError(
        `E_INTERSECT_UNKNOWN_HIGHWAY: intersect references '${ref.name}' but no such node is declared`,
        ref.span,
      );
    }
    if (node.shape !== "highway") {
      throw new BindError(
        `E_INTERSECT_NOT_HIGHWAY: intersect references '${ref.name}' which is not a \`shape: highway\` node (DESIGN-PHASE4.md §11.11)`,
        ref.span,
      );
    }
    if (names.includes(ref.name)) {
      throw new BindError(
        `E_INTERSECT_DUPLICATE: intersect references '${ref.name}' more than once`,
        ref.span,
      );
    }
    names.push(ref.name);
    const orient = node.orient === "horizontal" ? "horizontal"
      : node.orient === "vertical" ? "vertical"
      : (layoutHoriz ? "horizontal" : "vertical");
    orientations.add(orient);
  }
  if (orientations.size < 2) {
    throw new BindError(
      `E_INTERSECT_SAME_ORIENTATION: all highways in 'intersect ${names.join(", ")}' resolve to the same orientation; two highways at the same cell with the same orientation collide. Mark one with \`orient: ${orientations.has("horizontal") ? "vertical" : "horizontal"}\` (DESIGN-PHASE4.md §11.11).`,
      decl.span,
    );
  }
  ctx.intersections.push({ highways: names });
}

function resolvePendingAvoid(
  pending: { edgeIndex: number; items: AvoidRef[]; declSpan: SourceSpan },
  ctx: BindCtx,
): void {
  // Resolution rules (DESIGN-PHASE4.md §11.8):
  //   - name:  try primitive (pipeline/bus/fan-out/branch), then edgeset,
  //            then node (= all edges incident to that node). Error if
  //            nothing matches.
  //   - edge:  look up the specific (from, to) edge. Error if not found.
  //
  // The resolved set is the *union* of indices contributed by every item,
  // deduplicated. The edge itself is excluded from its own avoid set
  // (self-reference is silently ignored — it would otherwise block the
  // route entirely).
  const collected = new Set<number>();
  for (const item of pending.items) {
    if (item.kind === "edge") {
      // Validate endpoint nodes first so the error names the offender.
      if (!ctx.nodes.has(item.from)) {
        throw new BindError(
          `E_AVOID_UNKNOWN_NODE: avoid references edge '${item.from} -> ${item.to}' but '${item.from}' is not a declared node`,
          item.span,
        );
      }
      if (!ctx.nodes.has(item.to)) {
        throw new BindError(
          `E_AVOID_UNKNOWN_NODE: avoid references edge '${item.from} -> ${item.to}' but '${item.to}' is not a declared node`,
          item.span,
        );
      }
      const found = findEdgeIndex(ctx, item.from, item.to);
      if (found === -1) {
        throw new BindError(
          `E_AVOID_UNKNOWN_REF: avoid references edge '${item.from} -> ${item.to}' but no such edge exists in the model`,
          item.span,
        );
      }
      collected.add(found);
      continue;
    }
    // Name kind — try the four resolution paths in order.
    const name = item.name;
    const pipeline = ctx.pipelines.get(name);
    if (pipeline !== undefined) {
      addIndicesFromPipeline(pipeline, ctx, collected);
      continue;
    }
    const bus = ctx.buses.get(name);
    if (bus !== undefined) {
      addIndicesFromBus(bus, ctx, collected);
      continue;
    }
    const fanOut = ctx.fanOuts.get(name);
    if (fanOut !== undefined) {
      addIndicesFromFanOut(fanOut, ctx, collected);
      continue;
    }
    const branch = ctx.branches.get(name);
    if (branch !== undefined) {
      addIndicesFromBranch(branch, ctx, collected);
      continue;
    }
    const edgeset = ctx.edgesets.get(name);
    if (edgeset !== undefined) {
      for (const i of edgeset.edgeIndices) collected.add(i);
      continue;
    }
    if (ctx.nodes.has(name)) {
      for (let i = 0; i < ctx.edges.length; i++) {
        const e = ctx.edges[i]!;
        if (e.from === name || e.to === name) collected.add(i);
      }
      continue;
    }
    throw new BindError(
      `E_AVOID_UNKNOWN_REF: avoid references '${name}' but no pipeline, bus, fan-out, branch, edgeset, or node by that name is declared`,
      item.span,
    );
  }
  // Drop self-reference (the route would be unroutable otherwise).
  collected.delete(pending.edgeIndex);
  const indices = [...collected].sort((a, b) => a - b);
  if (indices.length > 0) {
    ctx.edges[pending.edgeIndex]!.avoidEdges = indices;
  }
}

function addIndicesFromPipeline(
  pipeline: Pipeline,
  ctx: BindCtx,
  out: Set<number>,
): void {
  for (let i = 0; i < ctx.edges.length; i++) {
    const e = ctx.edges[i]!;
    if (e.source === "pipeline" && e.sourceName === pipeline.name) out.add(i);
  }
}

function addIndicesFromBus(
  bus: Bus,
  ctx: BindCtx,
  out: Set<number>,
): void {
  for (let i = 0; i < ctx.edges.length; i++) {
    const e = ctx.edges[i]!;
    if (e.source === "bus" && e.sourceName === bus.name) out.add(i);
  }
}

function addIndicesFromFanOut(
  fanOut: FanOut,
  ctx: BindCtx,
  out: Set<number>,
): void {
  for (let i = 0; i < ctx.edges.length; i++) {
    const e = ctx.edges[i]!;
    if (e.source === "fan-out" && e.sourceName === fanOut.name) out.add(i);
  }
}

function addIndicesFromBranch(
  branch: Branch,
  ctx: BindCtx,
  out: Set<number>,
): void {
  for (let i = 0; i < ctx.edges.length; i++) {
    const e = ctx.edges[i]!;
    if (e.source === "branch" && e.sourceName === branch.name) out.add(i);
  }
}

function resolvePendingVia(
  pending: { edgeIndex: number; items: ViaRef[]; declSpan: SourceSpan },
  ctx: BindCtx,
): void {
  // Each item must resolve to a declared node with shape === "highway".
  // Order is preserved (the router walks them in declaration order).
  const names: string[] = [];
  for (const item of pending.items) {
    const node = ctx.nodes.get(item.name);
    if (node === undefined) {
      throw new BindError(
        `E_VIA_UNKNOWN_HIGHWAY: via references '${item.name}' but no node by that name is declared`,
        item.span,
      );
    }
    if (node.shape !== "highway") {
      throw new BindError(
        `E_VIA_NOT_HIGHWAY: via references '${item.name}' but that node has shape '${node.shape}', not 'highway'`,
        item.span,
      );
    }
    names.push(item.name);
  }
  if (names.length > 0) {
    ctx.edges[pending.edgeIndex]!.viaHighways = names;
  }
}

/**
 * Reject explicit edges whose endpoints are highway nodes. Highways
 * are routed *through* (via `via:`), never *to* or *from* (DESIGN
 * §11.9). Runs before auto-sizing because this check is independent
 * of size.
 */
function rejectHighwayEndpoints(ctx: BindCtx): void {
  for (const e of ctx.edges) {
    const fromNode = ctx.nodes.get(e.from);
    const toNode = ctx.nodes.get(e.to);
    if (fromNode?.shape === "highway") {
      throw new BindError(
        `E_HIGHWAY_AS_ENDPOINT: edge '${e.from} -> ${e.to}' uses highway '${e.from}' as a source; highways can only be routed through (via:). ` +
          `Hint: rewrite as \`<real_source> -> ${e.to} { via: ${e.from} }\`. ` +
          `Highways are invisible bundling channels — every trace through them ` +
          `is declared as a regular edge between real nodes with \`via: <hwy>\`.`,
      );
    }
    if (toNode?.shape === "highway") {
      throw new BindError(
        `E_HIGHWAY_AS_ENDPOINT: edge '${e.from} -> ${e.to}' uses highway '${e.to}' as a target; highways can only be routed through (via:). ` +
          `Hint: rewrite as \`${e.from} -> <real_target> { via: ${e.to} }\`. ` +
          `Highways are invisible bundling channels — every trace through them ` +
          `is declared as a regular edge between real nodes with \`via: <hwy>\`.`,
      );
    }
  }
}

/**
 * Highway orientation is now driven by `layoutMode`, not by
 * `width > height`. Square highways are fine. This validator is a
 * no-op kept for the call site; future invariants can land here.
 */
function validateHighwayOrientation(_ctx: BindCtx): void {
  // No-op (orientation comes from layoutMode in §11.9 v2).
}

/**
 * Build `HighwayMembership` for each highway from the resolved
 * `viaHighways` on every edge (DESIGN §11.9). Source-side members are
 * the distinct `from` nodes of edges that route through the highway;
 * target-side members are the distinct `to` nodes. Member order is set
 * by first appearance in declaration order.
 *
 * Also registers a `highway-via` anchor for each highway that has any
 * via-membership, so the placer positions the members around it.
 */
function buildHighwayMemberships(ctx: BindCtx): void {
  // First pass: collect membership in declaration order. Use a Set to
  // dedupe while preserving first-occurrence order with a parallel
  // ordered array.
  type Builder = { sourcesSeen: Set<string>; sources: string[]; targetsSeen: Set<string>; targets: string[] };
  const builders = new Map<string, Builder>();
  // Ensure every highway has an entry (even if it has no via-edges yet),
  // so the anchor is registered consistently.
  for (const node of ctx.nodes.values()) {
    if (node.shape === "highway") {
      builders.set(node.id, {
        sourcesSeen: new Set(),
        sources: [],
        targetsSeen: new Set(),
        targets: [],
      });
    }
  }
  for (const e of ctx.edges) {
    if (e.viaHighways === undefined) continue;
    // Multi-via: the edge's source is a member of ONLY the first
    // highway; the edge's target is a member of ONLY the last highway.
    // Intermediate highways carry a phantom "through" trace that
    // doesn't add new members (the trace just transits between two
    // highway exits). For single-via, first == last and both endpoints
    // are members of that highway.
    const firstHwy = e.viaHighways[0]!;
    const lastHwy = e.viaHighways[e.viaHighways.length - 1]!;
    const firstBuilder = builders.get(firstHwy);
    const lastBuilder = builders.get(lastHwy);
    if (firstBuilder && !firstBuilder.sourcesSeen.has(e.from)) {
      firstBuilder.sourcesSeen.add(e.from);
      firstBuilder.sources.push(e.from);
    }
    if (lastBuilder && !lastBuilder.targetsSeen.has(e.to)) {
      lastBuilder.targetsSeen.add(e.to);
      lastBuilder.targets.push(e.to);
    }
  }
  // Materialize HighwayMembership in declaration order of the highway
  // nodes. Each gets an anchor entry only if it has any via-members.
  for (const node of ctx.nodes.values()) {
    if (node.shape !== "highway") continue;
    const b = builders.get(node.id)!;
    const membership: HighwayMembership = {
      name: node.id,
      sources: b.sources,
      targets: b.targets,
    };
    ctx.highwayMemberships.set(node.id, membership);
    if (b.sources.length > 0 || b.targets.length > 0) {
      const index = ctx.highwayMemberships.size - 1;
      ctx.anchors.push({ kind: "highway-via", index });
    }
  }
}

/**
 * Auto-size highways that weren't given an explicit `size:` (DESIGN
 * §11.9). Under `layout: lr`, the highway is horizontal (traces flow
 * east); under `layout: tb`, vertical.
 *
 * For a horizontal highway:
 *   - The PERPENDICULAR (short) axis = HEIGHT, which must span the
 *     stacked member rows. height = max(N_sources, N_targets) gives
 *     the W and E faces enough cell-units to fit one slot per member.
 *   - The PARALLEL (long) axis = WIDTH, which is the visual length
 *     the bundle traverses. Defaults to 1 (minimal); author can
 *     extend with explicit `size:` for more breathing room.
 *
 * For a vertical highway, swap axes.
 *
 * Note: the resulting `width < height` for a horizontal-with-many-
 * members highway is fine — the orientation is driven by `layoutMode`,
 * not the `width > height` heuristic.
 */
/**
 * Expand each via-edge (`a -> b { via: hwy }`) into a pair of synthetic
 * "via-half" sub-edges: `a -> hwy` (first half) and `hwy -> b` (second
 * half). Both halves get `source: "via-half"`, `viaOriginal` =
 * original-edge index, and the first half is marked `viaFirstHalf: true`.
 *
 * The original via-edge is REMOVED from `ctx.edges`; the two halves
 * are appended at the end. This means edge indices change — but since
 * `viaOriginal` carries the original index forward, the renderer can
 * still group halves by their origin.
 *
 * Why this approach (DESIGN-PHASE4.md §11.9 v2):
 *   The previous implementation used a custom `buildViaPolyline` that
 *   bypassed the corridor/slot/track pipeline. Result: the gutter cells
 *   between source nodes and the highway were not used as actual
 *   corridors with track packing — they just held custom polylines
 *   that didn't match the rest of the routing. By expanding to pairs
 *   of regular edges with highway endpoints, the highway's faces
 *   participate in slot allocation (so traces stack at COMB_PITCH on
 *   the W/E faces) and the gutter corridors get normal track packing
 *   (so the fan-in/fan-out comb-tooth shape emerges automatically).
 */
function expandViaEdges(ctx: BindCtx): void {
  const originals = ctx.edges.slice();
  const kept: ModelEdge[] = [];
  const synthesized: ModelEdge[] = [];
  for (let i = 0; i < originals.length; i++) {
    const e = originals[i]!;
    if (e.viaHighways === undefined || e.viaHighways.length === 0) {
      kept.push(e);
      continue;
    }
    if (e.viaHighways.length > 1) {
      throw new BindError(
        `E_VIA_MULTI_NOT_SUPPORTED: edge '${e.from} -> ${e.to}' lists ${e.viaHighways.length} highways; only single-highway via is supported in Phase 4.3`,
      );
    }
    const hwy = e.viaHighways[0]!;
    // First half: source -> hwy (no arrow at hwy end).
    const firstHalf: ModelEdge = {
      from: e.from,
      to: hwy,
      source: "via-half",
      viaOriginal: i,
      viaFirstHalf: true,
    };
    if (e.fromPort !== undefined) firstHalf.fromPort = e.fromPort;
    // Second half: hwy -> target (carries the arrow and label).
    const secondHalf: ModelEdge = {
      from: hwy,
      to: e.to,
      source: "via-half",
      viaOriginal: i,
    };
    if (e.toPort !== undefined) secondHalf.toPort = e.toPort;
    if (e.label !== undefined) secondHalf.label = e.label;
    // Preserve avoid: on the second half so the path search honors it.
    if (e.avoidEdges !== undefined) secondHalf.avoidEdges = e.avoidEdges;
    synthesized.push(firstHalf, secondHalf);
  }
  ctx.edges.length = 0;
  ctx.edges.push(...kept, ...synthesized);
}

function autoSizeHighways(ctx: BindCtx): void {
  // A highway is a node like any other. Its dimension in the flow
  // direction is whatever the author wrote (default 1). Its dimension
  // perpendicular to flow ("breadth") is auto-sized from the number of
  // via-edges passing through it — that face needs one slot per edge,
  // and `cells × 3 >= edgeCount` keeps slot pitch at COMB_PITCH.
  //
  // §11.11: an explicit `orient:` on the highway overrides the
  // `layoutMode`-derived default. orient: horizontal → breadth on the
  // vertical (height) axis; orient: vertical → breadth on the
  // horizontal (width) axis.
  //
  // §11.13: when a highway participates in an `intersect` group, its
  // FLOW-DIRECTION length is expanded to match the breadth of the
  // perpendicular highway it intersects. This makes the intersection
  // cell a proper N×M square (where N is one highway's trace count, M
  // is the other's) so every surface trace can cross every underground
  // trace. Without this expansion, only traces in the central 1-cell
  // overlap actually cross; outer traces fly past untouched.
  const layoutHoriz = ctx.layoutMode === "lr";
  const edgesPerHwy = new Map<string, number>();
  for (const e of ctx.edges) {
    if (!e.viaHighways) continue;
    for (const hwy of e.viaHighways) {
      edgesPerHwy.set(hwy, (edgesPerHwy.get(hwy) ?? 0) + 1);
    }
  }
  // Pre-compute the breadth (perpendicular to flow) each highway needs
  // for its own trace count. Used both for self-sizing AND for the
  // intersect-partner length expansion.
  const breadthOf = new Map<string, number>();
  for (const node of ctx.nodes.values()) {
    if (node.shape !== "highway") continue;
    const edgeCount = edgesPerHwy.get(node.id) ?? 0;
    breadthOf.set(node.id, Math.max(1, Math.ceil(edgeCount / 3)));
  }
  // Map each highway to its intersect-partner highways (mutual).
  const intersectPartners = new Map<string, string[]>();
  for (const group of ctx.intersections) {
    for (const a of group.highways) {
      for (const b of group.highways) {
        if (a === b) continue;
        if (!intersectPartners.has(a)) intersectPartners.set(a, []);
        intersectPartners.get(a)!.push(b);
      }
    }
  }
  for (const node of ctx.nodes.values()) {
    if (node.shape !== "highway") continue;
    const m = ctx.highwayMemberships.get(node.id);
    if (!m) continue;
    if (m.sources.length === 0 && m.targets.length === 0) continue;
    const breadthCells = breadthOf.get(node.id) ?? 1;
    const horiz = node.orient === "horizontal" ? true
      : node.orient === "vertical" ? false
      : layoutHoriz;
    // Flow-direction length expands to fit the LARGEST partner's
    // breadth (so all partner traces fit through the intersection).
    let lengthCells = 1;
    const partners = intersectPartners.get(node.id) ?? [];
    for (const p of partners) {
      const pb = breadthOf.get(p) ?? 1;
      if (pb > lengthCells) lengthCells = pb;
    }
    if (horiz) {
      node.size = {
        width: Math.max(node.size.width, lengthCells),
        height: Math.max(node.size.height, breadthCells),
      };
    } else {
      node.size = {
        width: Math.max(node.size.width, breadthCells),
        height: Math.max(node.size.height, lengthCells),
      };
    }
  }
}

function findEdgeIndex(ctx: BindCtx, from: string, to: string): number {
  for (let i = 0; i < ctx.edges.length; i++) {
    const e = ctx.edges[i]!;
    if (e.from === from && e.to === to) return i;
  }
  return -1;
}

function bindPath(decl: PathDecl, ctx: BindCtx): void {
  if (ctx.paths.has(decl.name)) {
    throw new BindError(
      `E_DUPLICATE_PATH: path '${decl.name}' is declared more than once. ` +
        `Hint: rename one of them.`,
      decl.span,
    );
  }
  for (const m of decl.chain) {
    if (!ctx.nodes.has(m)) {
      throw new BindError(
        `E_PATH_MISSING_EDGE: path '${decl.name}' references undeclared node '${m}'`,
        decl.span,
      );
    }
  }
  for (let i = 0; i < decl.chain.length - 1; i++) {
    const from = decl.chain[i]!;
    const to = decl.chain[i + 1]!;
    if (!hasEdge(ctx, from, to)) {
      throw new BindError(
        `E_PATH_MISSING_EDGE: path '${decl.name}' includes link '${from} -> ${to}' but no such edge exists. ` +
          `Hint: a \`path\` highlights existing edges — every consecutive pair in the chain ` +
          `must match a declared edge (forward or back). Declare the edge first, or remove ` +
          `the link from the path.`,
        decl.span,
      );
    }
  }
  ctx.paths.set(decl.name, { name: decl.name, chain: [...decl.chain] });
}

// --- helpers --------------------------------------------------------------

function ensureNode(id: string, ctx: BindCtx): void {
  if (ctx.nodes.has(id)) return;
  ctx.nodes.set(id, {
    id,
    label: id,
    shape: "rect",
    size: { width: 1, height: 1 },
  });
  ctx.autoDeclared.add(id);
}

/**
 * Resolve a possibly-qualified node ref (DESIGN-PHASE5-MODULES.md §2)
 * to the parent-level node id used by the placer and the internal name
 * (if any) used by the parent edge router. For a plain ref `foo`, this
 * is `{ id: "foo", internal: undefined }` and `foo` is auto-declared if
 * unknown. For a qualified ref `mod.foo`, this is
 * `{ id: "mod", internal: "foo" }` — the parent-level id is the
 * synthetic module node injected at bind time, and the internal name
 * lets Cut 4 translate to the actual internal node's pixel position.
 *
 * Errors raised:
 *   - E_MODULE_ALIAS_UNKNOWN — `mod` not in import alias table
 *   - E_MODULE_NODE_UNKNOWN  — `foo` not declared in the imported module
 */
function resolveNodeRefId(
  ref: NodeRef,
  ctx: BindCtx,
): { id: string; internal: string | undefined } {
  if (ref.module === undefined) {
    ensureNode(ref.node, ctx);
    return { id: ref.node, internal: undefined };
  }
  const imported = ctx.moduleAliases.get(ref.module);
  if (imported === undefined) {
    throw new BindError(
      `E_MODULE_ALIAS_UNKNOWN: qualified reference '${ref.module}.${ref.node}' uses ` +
        `module alias '${ref.module}' which is not imported. ` +
        `Add \`import "<path>" as ${ref.module}\` at the top of the file.`,
      ref.span,
    );
  }
  const innerExists = imported.model.nodes.some((n) => n.id === ref.node);
  if (!innerExists) {
    const known = imported.model.nodes
      .filter((n) => n.shape !== "module" && n.shape !== "highway")
      .map((n) => n.id);
    throw new BindError(
      `E_MODULE_NODE_UNKNOWN: module '${ref.module}' has no node '${ref.node}'. ` +
        `Check the imported file at '${imported.resolvedPath}'. ` +
        `Hint: nodes declared in that module are: ${
          known.length > 0 ? known.join(", ") : "(none visible — module may be empty or only contain highways)"
        }.`,
      ref.span,
    );
  }
  return { id: ref.module, internal: ref.node };
}

function hasEdge(ctx: BindCtx, from: string, to: string): boolean {
  for (const e of ctx.edges) {
    if (e.from === from && e.to === to) return true;
  }
  return false;
}

function applyNodeProperty(
  prop: Property,
  setShape: (s: ShapeName) => void,
  setSize: (s: NodeSize) => void,
  setLabel: (l: string) => void,
  setOrient: (o: "horizontal" | "vertical") => void,
  setRender: (r: "surface" | "underground") => void,
  setSlotOrder: (so: "declaration") => void,
  setTags: (t: string[]) => void,
  setIcon: (i: { alias: string; name: string }) => void,
  setIconPosition: (p: "inline" | "corner") => void,
  setBorder: (b: boolean) => void,
): void {
  switch (prop.key) {
    case "shape":
      // Bare ident → primitive shape (rect / roundrect / ... / highway).
      // Call form `icon(alias/name)` is parsed as an `icon-call` value.
      if (prop.value.kind === "icon-call") {
        setShape("icon");
        setIcon({
          alias: prop.value.iconRef.alias,
          name: prop.value.iconRef.name,
        });
        break;
      }
      if (prop.value.kind !== "ident") {
        throw new BindError("shape must be an identifier", prop.value.span);
      }
      if (!isShape(prop.value.value)) {
        throw new BindError(
          `unknown shape: '${prop.value.value}'`,
          prop.value.span,
        );
      }
      setShape(prop.value.value);
      break;
    case "icon":
      if (prop.value.kind !== "icon-ref") {
        throw new BindError(
          "E_ICON_BAD_REF: icon must be a reference of the form `alias/name`",
          prop.value.span,
        );
      }
      setIcon({
        alias: prop.value.iconRef.alias,
        name: prop.value.iconRef.name,
      });
      break;
    case "icon-position":
      if (prop.value.kind !== "ident") {
        throw new BindError(
          "E_INVALID_ICON_POSITION: icon-position must be `inline` or `corner` (DESIGN-PHASE5-ICONS §3.3)",
          prop.value.span,
        );
      }
      if (prop.value.value !== "inline" && prop.value.value !== "corner") {
        throw new BindError(
          `E_INVALID_ICON_POSITION: unknown icon-position value: '${prop.value.value}'. Expected \`inline\` or \`corner\`.`,
          prop.value.span,
        );
      }
      setIconPosition(prop.value.value);
      break;
    case "border":
      // Boolean-by-content match: `true` enables, `false` disables.
      // Only meaningful on shape: icon(...) and shape: circle nodes —
      // those whose label sits outside the glyph. Other shapes already
      // draw a border via nodeShape; the attr is silently no-op there
      // (kept to allow uniform authoring without per-shape gymnastics).
      if (prop.value.kind !== "ident") {
        throw new BindError(
          "E_INVALID_BORDER_VALUE: border must be `true` or `false`",
          prop.value.span,
        );
      }
      if (prop.value.value !== "true" && prop.value.value !== "false") {
        throw new BindError(
          `E_INVALID_BORDER_VALUE: unknown border value: '${prop.value.value}'. Expected \`true\` or \`false\`.`,
          prop.value.span,
        );
      }
      setBorder(prop.value.value === "true");
      break;
    case "size":
      if (prop.value.kind === "ident") {
        throw new BindError(
          `E_DEPRECATED_TSHIRT_SIZE: '${prop.value.value}' is no longer accepted; use cell sizing like '2x1' (DESIGN-PHASE4.md §6.0).`,
          prop.value.span,
        );
      }
      if (prop.value.kind !== "cells") {
        throw new BindError(
          "size must be in cells, e.g. `size: 2x1`",
          prop.value.span,
        );
      }
      if (prop.value.width < 1 || prop.value.height < 1) {
        throw new BindError(
          "cell size must be at least 1x1",
          prop.value.span,
        );
      }
      setSize({ width: prop.value.width, height: prop.value.height });
      break;
    case "label":
      if (prop.value.kind !== "string") {
        throw new BindError("label must be a string", prop.value.span);
      }
      setLabel(prop.value.value);
      break;
    case "orient":
      if (prop.value.kind !== "ident") {
        throw new BindError(
          "E_INVALID_ORIENT_VALUE: orient must be `horizontal` or `vertical` (DESIGN-PHASE4.md §11.11)",
          prop.value.span,
        );
      }
      if (prop.value.value !== "horizontal" && prop.value.value !== "vertical") {
        throw new BindError(
          `E_INVALID_ORIENT_VALUE: unknown orient value: '${prop.value.value}'. Expected \`horizontal\` or \`vertical\` (DESIGN-PHASE4.md §11.11).`,
          prop.value.span,
        );
      }
      setOrient(prop.value.value);
      break;
    case "render":
      if (prop.value.kind !== "ident") {
        throw new BindError(
          "E_INVALID_RENDER_VALUE: render must be `surface` or `underground` (DESIGN-PHASE4.md §11.11)",
          prop.value.span,
        );
      }
      if (prop.value.value !== "surface" && prop.value.value !== "underground") {
        throw new BindError(
          `E_INVALID_RENDER_VALUE: unknown render value: '${prop.value.value}'. Expected \`surface\` or \`underground\` (DESIGN-PHASE4.md §11.11).`,
          prop.value.span,
        );
      }
      setRender(prop.value.value);
      break;
    case "slot-order":
      if (prop.value.kind !== "ident") {
        throw new BindError(
          "E_INVALID_SLOT_ORDER_VALUE: slot-order must be `declaration` (DESIGN-PHASE4.md §11.12)",
          prop.value.span,
        );
      }
      if (prop.value.value !== "declaration") {
        throw new BindError(
          `E_INVALID_SLOT_ORDER_VALUE: unknown slot-order value: '${prop.value.value}'. Expected \`declaration\` (DESIGN-PHASE4.md §11.12).`,
          prop.value.span,
        );
      }
      setSlotOrder(prop.value.value);
      break;
    case "tags":
      // The parser normalises bare and bracketed forms to tag-list.
      if (prop.value.kind !== "tag-list") {
        throw new BindError(
          "tags must be a name or bracketed list of names",
          prop.value.span,
        );
      }
      setTags(prop.value.items.map((it) => it.name));
      break;
    default:
      throw new BindError(`unknown node property: '${prop.key}'`, prop.span);
  }
}

function isShape(v: string): v is ShapeName {
  return v === "rect" || v === "roundrect" || v === "circle" ||
    v === "diamond" || v === "cylinder" || v === "highway" || v === "icon";
}

/**
 * Register an `icons:` directive (DESIGN-PHASE5-ICONS §1.1). Duplicate
 * aliases raise E_ICON_PACK_DUPLICATE_ALIAS. `http://` URLs raise
 * E_ICON_PACK_INSECURE (security: prevent silent man-in-the-middle on
 * unauthenticated icon fetches).
 */
function bindIconsDirective(
  stmt: { alias: string; source: string; span: { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } } },
  ctx: BindCtx,
): void {
  if (stmt.source.startsWith("http://")) {
    throw new BindError(
      `E_ICON_PACK_INSECURE: icon pack source must be https:// (DESIGN-PHASE5-ICONS §1.3). ` +
        `Got '${stmt.source}'.`,
      stmt.span,
    );
  }
  if (ctx.iconPacks.some((p) => p.alias === stmt.alias)) {
    throw new BindError(
      `E_ICON_PACK_DUPLICATE_ALIAS: icon pack alias '${stmt.alias}' is already registered. ` +
        `Each \`icons:\` directive must use a unique alias.`,
      stmt.span,
    );
  }
  ctx.iconPacks.push({ alias: stmt.alias, source: stmt.source });
}

/**
 * Default `ModuleLoader` backed by Node's `fs` + `path`
 * (DESIGN-PHASE5-MODULES.md §1.3). Resolves relative paths against the
 * importer's directory and reads the file synchronously. Tests use a
 * stub loader to avoid touching the filesystem.
 */
export function createFsLoader(): ModuleLoader {
  return {
    load(pathSpec, importerPath) {
      const baseDir = importerPath !== undefined
        ? dirname(importerPath)
        : ".";
      const resolved = isAbsolute(pathSpec)
        ? pathSpec
        : resolvePath(baseDir, pathSpec);
      if (!existsSync(resolved)) {
        throw new BindError(
          `E_MODULE_FILE_NOT_FOUND: import path '${pathSpec}' did not resolve to an existing file ` +
            `(looked at '${resolved}')`,
        );
      }
      const source = readFileSync(resolved, "utf8");
      return { resolvedPath: resolved, source };
    },
  };
}

/**
 * Bind an `import` directive (DESIGN-PHASE5-MODULES.md §1, §3.2, §5).
 * Recursively loads the imported file, applies any override directives
 * from the import-site brace block, and registers the resulting
 * sub-Model under the import alias. Detects import cycles using the
 * shared import stack.
 */
function bindImport(stmt: ImportDecl, ctx: BindCtx): void {
  if (ctx.moduleAliases.has(stmt.alias)) {
    throw new BindError(
      `E_MODULE_ALIAS_DUPLICATE: import alias '${stmt.alias}' is already registered. ` +
        `Each \`import\` directive must use a unique alias.`,
      stmt.span,
    );
  }
  if (stmt.path.startsWith("http://") || stmt.path.startsWith("https://")) {
    throw new BindError(
      `E_MODULE_URL_UNSUPPORTED: \`import\` does not accept URLs at v1 ` +
        `(DESIGN-PHASE5-MODULES.md §1.3). Use a local file path.`,
      stmt.span,
    );
  }
  const loader = ctx.loader ?? createFsLoader();
  let resolvedPath: string;
  let source: string;
  try {
    const loaded = loader.load(stmt.path, ctx.importerPath);
    resolvedPath = loaded.resolvedPath;
    source = loaded.source;
  } catch (e) {
    if (e instanceof BindError) {
      // Attach the directive's span if the loader didn't.
      if (e.span === undefined) {
        throw new BindError(e.message, stmt.span);
      }
      throw e;
    }
    throw new BindError(
      `E_MODULE_FILE_NOT_FOUND: failed to load import '${stmt.path}': ${(e as Error).message}`,
      stmt.span,
    );
  }
  // Cycle detection (DESIGN-PHASE5-MODULES.md §5.2). The stack carries
  // resolved absolute paths so two different relative paths resolving to
  // the same file are correctly detected.
  if (ctx.importStack.includes(resolvedPath)) {
    const chain = [...ctx.importStack, resolvedPath]
      .map((p) => `  ${p}`)
      .join("\n");
    throw new BindError(
      `E_MODULE_CYCLE: import cycle detected:\n${chain}`,
      stmt.span,
    );
  }
  // Apply import-site overrides by injecting synthetic directive
  // statements at the front of the sub-program's statement list. The
  // module's own declarations come after, so on directives where
  // "last wins" semantics hold (theme, layout, legend, title, subtitle,
  // caption), the *module's* value would win over the override. To make
  // the override win, we inject the synthetic directives at the END
  // instead (DESIGN-PHASE5-MODULES.md §1.1: import-site overrides win).
  // Parse + bind the sub-module, decorating any error with the import
  // chain so the user can see WHICH module the error came from and the
  // sequence of `import` directives that led there
  // (DESIGN-PHASE5-MODULES.md §12.3). The original error code is
  // preserved at the head of the message so test matchers and CLI
  // post-processors can still detect specific errors.
  let subModel: Model;
  try {
    const subProgram = parse(tokenize(source));
    applyImportOverrides(subProgram, stmt.overrides);
    subModel = bind(subProgram, {
      importerPath: resolvedPath,
      loader,
      importStack: [...ctx.importStack, resolvedPath],
    });
  } catch (e) {
    // Re-throw E_MODULE_CYCLE / E_MODULE_FILE_NOT_FOUND unchanged —
    // those already include their own chain context, and double-
    // decorating would produce unreadable nested chains.
    if (e instanceof BindError && /E_MODULE_(CYCLE|FILE_NOT_FOUND)/.test(e.message)) {
      throw e;
    }
    // Already-decorated errors (e.g. an error in a 3-deep import that
    // bubbled up through 2 bindImport catch blocks) keep their original
    // decoration. Identify them by the "imported module chain" marker.
    if (e instanceof BindError && e.message.includes("imported module chain:")) {
      throw e;
    }
    if (e instanceof BindError || (e instanceof Error && e.name === "ParseError")) {
      // Build the chain from outermost (entry file) to innermost
      // (failing module). ctx.importerPath is the file currently being
      // bound; ctx.importStack is the chain of already-recursing
      // imports above it; resolvedPath is the new sub-module that
      // failed. Concat in that order.
      const fullChain: string[] = [];
      if (ctx.importerPath !== undefined) fullChain.push(ctx.importerPath);
      for (const p of ctx.importStack) {
        if (p !== ctx.importerPath) fullChain.push(p);
      }
      fullChain.push(resolvedPath);
      // Reverse so the innermost (failing) file is first, then walk
      // outward to the entry file. Each line names the file; the
      // first line is the actual error site, subsequent lines show
      // "imported by <next-outer>".
      const reversed = [...fullChain].reverse();
      const chain = reversed
        .map((p, i) => {
          if (i === 0) return `  in ${p}`;
          return `    imported by ${p}`;
        })
        .join("\n");
      const decorated = `${e.message}\n  (imported module chain:\n${chain})`;
      // Preserve the BindError type so callers can still instanceof-test it.
      throw new BindError(decorated, stmt.span);
    }
    throw e;
  }
  // DESIGN-PHASE5-MODULES.md §7 + §8 — when a file is loaded as a
  // module, its legend / title / subtitle / caption directives are
  // suppressed. The parent diagram owns its chrome; the module
  // contributes only its body. Strip them now so downstream stages
  // (renderer, legend tag-resolution) see a no-chrome sub-Model.
  delete subModel.legend;
  delete subModel.title;
  delete subModel.subtitle;
  delete subModel.caption;
  const imported: ImportedModule = {
    alias: stmt.alias,
    resolvedPath,
    model: subModel,
  };
  ctx.imports.push(imported);
  ctx.moduleAliases.set(stmt.alias, imported);

  // Inject a synthetic module-shape node into the parent's node table so
  // the parent placer can lay the module out as an opaque cell
  // (DESIGN-PHASE5-MODULES.md §3.1). The size is a 1x1 placeholder for
  // now; the per-module placement pass (Cut 3, runs after bind) replaces
  // it with the actual pixel-derived cell footprint. A parent-level
  // collision with the alias is an error — the alias becomes a node id
  // and a duplicate would silently override the synthetic node.
  if (ctx.nodes.has(stmt.alias) && !ctx.autoDeclared.has(stmt.alias)) {
    throw new BindError(
      `E_MODULE_ALIAS_COLLIDES_WITH_NODE: import alias '${stmt.alias}' collides with ` +
        `a parent-level node of the same name. Rename one.`,
      stmt.span,
    );
  }
  // If a forward edge auto-declared a node with the alias name before
  // the import, upgrade it to the module shape.
  ctx.nodes.set(stmt.alias, {
    id: stmt.alias,
    label: stmt.alias,
    shape: "module",
    size: { width: 1, height: 1 },
  });
  ctx.autoDeclared.delete(stmt.alias);
}

/**
 * Append synthetic directive statements to `program.statements` so that
 * import-site overrides take precedence over the module's own
 * directives. The set of override keys is intentionally narrow at v1
 * (DESIGN-PHASE5-MODULES.md §9.1): theme, layout, legend, title,
 * subtitle, caption. Unknown keys raise E_MODULE_OVERRIDE_UNKNOWN with
 * the offending key's span.
 *
 * The synthetic statements share the same AST shapes as the directives
 * authors would write inline, so downstream bind logic does not need to
 * distinguish them.
 */
function applyImportOverrides(
  program: Program,
  overrides: ImportOverride[],
): void {
  for (const ov of overrides) {
    switch (ov.key) {
      case "theme":
        program.statements.push({
          kind: "theme",
          value: ov.value,
          span: ov.span,
        });
        break;
      case "layout":
        if (ov.kind !== "ident" || (ov.value !== "lr" && ov.value !== "tb")) {
          throw new BindError(
            `E_MODULE_OVERRIDE_BAD_VALUE: layout override must be 'lr' or 'tb', got '${ov.value}'`,
            ov.span,
          );
        }
        program.statements.push({
          kind: "layout",
          mode: ov.value,
          span: ov.span,
        });
        break;
      case "legend":
        program.statements.push({
          kind: "legend",
          on: ov.value === "on",
          span: ov.span,
        });
        break;
      case "title":
      case "subtitle":
      case "caption":
        if (ov.kind !== "string") {
          throw new BindError(
            `E_MODULE_OVERRIDE_BAD_VALUE: ${ov.key} override must be a quoted string, got identifier '${ov.value}'`,
            ov.span,
          );
        }
        program.statements.push({
          kind: ov.key,
          value: ov.value,
          span: ov.span,
        });
        break;
      default:
        throw new BindError(
          `E_MODULE_OVERRIDE_UNKNOWN: unknown import override '${ov.key}'. ` +
            `Allowed keys: theme, layout, legend, title, subtitle, caption.`,
          ov.span,
        );
    }
  }
}

/**
 * Validate that every node-level icon reference targets a registered
 * pack alias (DESIGN-PHASE5-ICONS §4.1, E_ICON_PACK_UNKNOWN). Runs
 * after the first pass so that `icons:` directives appearing AFTER a
 * node that references them still resolve correctly.
 */
function validateIconRefs(ctx: BindCtx): void {
  const aliases = new Set(ctx.iconPacks.map((p) => p.alias));
  for (const node of ctx.nodes.values()) {
    if (node.icon === undefined) continue;
    if (!aliases.has(node.icon.alias)) {
      throw new BindError(
        `E_ICON_PACK_UNKNOWN: node '${node.id}' references icon pack '${node.icon.alias}' ` +
          `which is not registered. Add \`icons: ${node.icon.alias} from "..."\` at the top of the file.`,
        { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } },
      );
    }
  }
}
