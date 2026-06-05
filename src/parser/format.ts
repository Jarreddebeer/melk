/**
 * Canonical-form emitter for melk source (Phase B, v1.0 polish).
 *
 * Walks a parsed AST and emits a normalized `.melk` text. The output:
 *
 *   - groups statements in a stable category order (directives first,
 *     then icons / imports / nodes / primitives / edges / annotations);
 *   - preserves declaration order *within* each category, because
 *     source order is load-bearing for slot/lane allocation (the
 *     `feedback-declaration-order-respected` rule);
 *   - uses a single-space convention everywhere (`key: value`,
 *     `,` then space, `->` with single spaces);
 *   - drops all comments (no source trivia preserved at v1).
 *
 * Idempotence: `format(format(s)) === format(s)`. We do NOT guarantee
 * byte-stable output across formatter versions; the layout of
 * whitespace and category groupings may evolve.
 *
 * Use case: an LLM author edits a `.melk`; the user runs `melk format`
 * before review so the diff focuses on meaningful change instead of
 * incidental whitespace or directive ordering.
 */
import type {
  AvoidRef,
  BackBlockDecl,
  BranchDecl,
  BusDecl,
  CaptionDirective,
  CrossingsDirective,
  EdgeDecl,
  EdgesetDecl,
  FanOutDecl,
  IconsDirective,
  ImportDecl,
  ImportOverride,
  IntersectDecl,
  LayoutDecl,
  LegendDirective,
  LegendPositionDirective,
  NodeDecl,
  NodeRef,
  NodesetDecl,
  PathDecl,
  PipelineDecl,
  Program,
  Property,
  PropertyValue,
  Statement,
  SubtitleDirective,
  ThemeDirective,
  TitleDirective,
  ViaRef,
  BackEdgeDecl,
} from "./ast.js";

/**
 * Category ordering. Lower index renders first. Statements within a
 * category keep their source order.
 */
const CATEGORY: Record<Statement["kind"], number> = {
  layout: 0,
  crossings: 0,
  theme: 0,
  legend: 0,
  "legend-position": 0,
  title: 0,
  subtitle: 0,
  caption: 0,
  icons: 1,
  import: 2,
  node: 3,
  pipeline: 4,
  bus: 4,
  "fan-out": 4,
  branch: 4,
  intersect: 4,
  edge: 5,
  "back-edge": 5,
  "back-block": 5,
  nodeset: 6,
  path: 6,
  edgeset: 6,
  // Deprecated forms — should never appear in well-formed source, but
  // emit at the very end so the rest of the file is readable while the
  // user fixes them.
  "deprecated-lane": 9,
  "deprecated-group": 9,
  "deprecated-tag": 9,
};

export function formatProgram(program: Program): string {
  // Group by category, preserving order within.
  const byCategory = new Map<number, Statement[]>();
  for (const stmt of program.statements) {
    const cat = CATEGORY[stmt.kind];
    const bucket = byCategory.get(cat) ?? [];
    bucket.push(stmt);
    byCategory.set(cat, bucket);
  }
  const categories = [...byCategory.keys()].sort((a, b) => a - b);
  const blocks: string[] = [];
  for (const cat of categories) {
    const lines = byCategory.get(cat)!.map(formatStatement);
    blocks.push(lines.join("\n"));
  }
  // One blank line between non-empty category blocks; trailing newline.
  return blocks.filter((b) => b.length > 0).join("\n\n") + "\n";
}

function formatStatement(stmt: Statement): string {
  switch (stmt.kind) {
    case "layout":
      return formatLayout(stmt);
    case "crossings":
      return formatCrossings(stmt);
    case "theme":
      return formatTheme(stmt);
    case "legend":
      return formatLegend(stmt);
    case "legend-position":
      return formatLegendPosition(stmt);
    case "title":
      return formatTitle(stmt);
    case "subtitle":
      return formatSubtitle(stmt);
    case "caption":
      return formatCaption(stmt);
    case "icons":
      return formatIcons(stmt);
    case "import":
      return formatImport(stmt);
    case "node":
      return formatNode(stmt);
    case "pipeline":
      return formatPipeline(stmt);
    case "bus":
      return formatBus(stmt);
    case "fan-out":
      return formatFanOut(stmt);
    case "branch":
      return formatBranch(stmt);
    case "intersect":
      return formatIntersect(stmt);
    case "edge":
      return formatEdge(stmt);
    case "back-edge":
      return formatBackEdge(stmt);
    case "back-block":
      return formatBackBlock(stmt);
    case "nodeset":
      return formatNodeset(stmt);
    case "path":
      return formatPath(stmt);
    case "edgeset":
      return formatEdgeset(stmt);
    case "deprecated-lane":
      return "# deprecated: 'lane:' is no longer accepted (split into nodeset/path)";
    case "deprecated-group":
      return "# deprecated: 'group:' is no longer accepted (use nodeset)";
    case "deprecated-tag":
      return "# deprecated: 'tag:' is no longer accepted (split into nodeset/path)";
  }
}

// --- directives ---------------------------------------------------

function formatLayout(s: LayoutDecl): string {
  return `layout: ${s.mode}`;
}

function formatCrossings(s: CrossingsDirective): string {
  return `crossings: ${s.budget}`;
}

function formatTheme(s: ThemeDirective): string {
  // Themes can be a bare identifier (built-in name) or a quoted path.
  // We treat anything containing `/`, `.`, or `\` as a path.
  const isPath = /[/\\.]/.test(s.value);
  return `theme: ${isPath ? quote(s.value) : s.value}`;
}

function formatLegend(s: LegendDirective): string {
  return `legend: ${s.on ? "on" : "off"}`;
}

function formatLegendPosition(s: LegendPositionDirective): string {
  return `legend-position: ${s.position}`;
}

function formatTitle(s: TitleDirective): string {
  return `title: ${quote(s.value)}`;
}

function formatSubtitle(s: SubtitleDirective): string {
  return `subtitle: ${quote(s.value)}`;
}

function formatCaption(s: CaptionDirective): string {
  return `caption: ${quote(s.value)}`;
}

function formatIcons(s: IconsDirective): string {
  return `icons: ${s.alias} from ${quote(s.source)}`;
}

function formatImport(s: ImportDecl): string {
  let out = `import ${quote(s.path)} as ${s.alias}`;
  if (s.overrides.length > 0) {
    out += " { " + s.overrides.map(formatOverride).join(", ") + " }";
  }
  return out;
}

function formatOverride(o: ImportOverride): string {
  if (o.kind === "string") return `${o.key}: ${quote(o.value)}`;
  return `${o.key}: ${o.value}`;
}

// --- declarations -------------------------------------------------

function formatNode(s: NodeDecl): string {
  if (s.properties.length === 0) return s.name;
  return `${s.name} { ${s.properties.map(formatProperty).join(", ")} }`;
}

function formatEdge(s: EdgeDecl): string {
  let out = `${formatNodeRef(s.from)} -> ${formatNodeRef(s.to)}`;
  if (s.properties.length > 0) {
    out += ` { ${s.properties.map(formatProperty).join(", ")} }`;
  }
  return out;
}

function formatBackEdge(s: BackEdgeDecl): string {
  let out = `${formatNodeRef(s.from)} >- ${formatNodeRef(s.to)}`;
  if (s.properties.length > 0) {
    out += ` { ${s.properties.map(formatProperty).join(", ")} }`;
  }
  return out;
}

function formatBackBlock(s: BackBlockDecl): string {
  if (s.edges.length === 0) return "back: {}";
  if (s.edges.length === 1) {
    const e = s.edges[0]!;
    return `back: ${formatNodeRef(e.from)} -> ${formatNodeRef(e.to)}`;
  }
  const lines = s.edges.map(
    (e) => `  ${formatNodeRef(e.from)} -> ${formatNodeRef(e.to)}`,
  );
  return `back: {\n${lines.join("\n")}\n}`;
}

// --- primitives ---------------------------------------------------

function formatPipeline(s: PipelineDecl): string {
  return `pipeline ${s.name}: ${s.members.join(" -> ")}`;
}

function formatBus(s: BusDecl): string {
  return `bus ${s.name}: [${s.producers.join(", ")}] -> ${s.shared}`;
}

function formatFanOut(s: FanOutDecl): string {
  return `fan-out ${s.name}: ${s.shared} -> [${s.consumers.join(", ")}]`;
}

function formatBranch(s: BranchDecl): string {
  const sideTok = s.side === undefined ? "" : `:${s.side}`;
  return `branch ${s.name}${sideTok}: ${s.spine} -> ${s.member}`;
}

function formatIntersect(s: IntersectDecl): string {
  return `intersect ${s.highways.map((h) => h.name).join(", ")}`;
}

// --- annotations --------------------------------------------------

function formatNodeset(s: NodesetDecl): string {
  return `nodeset ${s.name}: ${s.members.join(", ")}`;
}

function formatPath(s: PathDecl): string {
  return `path ${s.name}: ${s.chain.join(" -> ")}`;
}

function formatEdgeset(s: EdgesetDecl): string {
  const items = s.edges.map((e) => `${e.from} -> ${e.to}`).join(", ");
  return `edgeset ${s.name}: ${items}`;
}

// --- properties & values ------------------------------------------

function formatProperty(p: Property): string {
  return `${p.key}: ${formatValue(p.value)}`;
}

function formatValue(v: PropertyValue): string {
  switch (v.kind) {
    case "ident":
      return v.value;
    case "string":
      return quote(v.value);
    case "number":
      return String(v.value);
    case "cells":
      return `${v.width}x${v.height}`;
    case "avoid-list":
      if (v.items.length === 1) return formatAvoidRef(v.items[0]!);
      return `[${v.items.map(formatAvoidRef).join(", ")}]`;
    case "via-list":
      if (v.items.length === 1) return v.items[0]!.name;
      return `[${v.items.map((i: ViaRef) => i.name).join(", ")}]`;
    case "tag-list":
      if (v.items.length === 1) return v.items[0]!.name;
      return `[${v.items.map((i) => i.name).join(", ")}]`;
    case "icon-call":
      return `icon(${v.iconRef.alias}/${v.iconRef.name})`;
    case "icon-ref":
      return `${v.iconRef.alias}/${v.iconRef.name}`;
  }
}

function formatAvoidRef(r: AvoidRef): string {
  if (r.kind === "edge") return `${r.from} -> ${r.to}`;
  return r.name;
}

function formatNodeRef(r: NodeRef): string {
  const base = r.module === undefined ? r.node : `${r.module}.${r.node}`;
  return r.port === undefined ? base : `${base}:${r.port}`;
}

// --- helpers ------------------------------------------------------

function quote(s: string): string {
  // Re-emit a string literal. The parser already accepted it, so we
  // know it's representable in the same form. Escape only `"` and `\`.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
