/**
 * planner.js — the planner→render approach to model-authored melk.
 *
 * The lesson from many self-correct rounds: a small model authoring melk SYNTAX
 * directly keeps failing on the SURFACE — construct names used as nodes, fan-out
 * with one target, double-linked branches, keyword-fusion phantoms. Those are all
 * failures of *expressing* a correct intent in melk's grammar, not failures of the
 * intent itself. The 3B almost always UNDERSTANDS the system; it fumbles the DSL.
 *
 * So: don't let the model write melk at all. Have it emit a structured
 * INTERMEDIATE REPRESENTATION — a flat list of nodes and edges as JSON, under a
 * JSON grammar — and let CODE mechanically generate guaranteed-valid melk from it.
 *
 *   model → {nodes, edges} JSON   (constrained, structurally trivial to get right)
 *   code  → valid melk            (deterministic; can't produce a syntax error)
 *
 * This removes EVERY surface-syntax failure class at once, because the model never
 * writes a melk token. It can still get the GRAPH wrong (a missing edge, a wrong
 * shape) — but that's a content error a human reviews, not a syntax error that
 * traps a self-correct loop. The grammar/verify nets still apply to the generated
 * melk as a backstop, but in practice the IR→melk output is valid by construction.
 */

/**
 * GBNF grammar for the IR. A flat JSON object: title, nodes[], edges[]. Kept
 * deliberately SHALLOW — no nesting beyond the two arrays — so xgrammar's mask
 * computation stays cheap (the lesson from the lexical-rule hang: chain depth and
 * nesting are what blow up; flat structures are fine). String bodies are bounded
 * by a modest character class, not a long optional chain.
 */
export const IR_GRAMMAR = String.raw`
root        ::= "{" ws "\"title\"" ws ":" ws qstr ws "," ws
                    "\"nodes\"" ws ":" ws nodes ws "," ws
                    "\"edges\"" ws ":" ws edges ws "}"

nodes       ::= "[" ws ( node ( ws "," ws node )* )? ws "]"
node        ::= "{" ws "\"id\"" ws ":" ws qstr
                ( ws "," ws "\"shape\"" ws ":" ws shape )?
                ( ws "," ws "\"critical\"" ws ":" ws bool )?
                ws "}"
shape       ::= "\"rect\"" | "\"roundrect\"" | "\"circle\"" | "\"diamond\"" | "\"cylinder\""

edges       ::= "[" ws ( edge ( ws "," ws edge )* )? ws "]"
edge        ::= "{" ws "\"from\"" ws ":" ws qstr ws "," ws "\"to\"" ws ":" ws qstr
                ( ws "," ws "\"label\"" ws ":" ws qstr )?
                ws "}"

bool        ::= "true" | "false"
qstr        ::= "\"" char* "\""
char        ::= [^"\\\n]
ws          ::= [ \t\n]*
`.trim();

/** System prompt for the planner. The model only ever produces this JSON. */
export const IR_PROMPT_CARD = `You convert a system description into a STRUCTURED diagram plan as JSON.
Output ONLY the JSON object — no prose, no code fences, no melk.

The JSON has exactly three keys:
  "title":  a short title string for the diagram
  "nodes":  an array of components. Each: { "id": "<name>", "shape": "<shape>", "critical": <bool> }
            - id: the component's real name, lowercase, words joined by _ (e.g. "audit_log")
            - shape (optional): one of rect, roundrect, circle, diamond, cylinder
                     use "cylinder" for datastores/databases/queues; default "rect" otherwise
            - critical (optional): true ONLY if the description calls the component critical
            - You only need to LIST a node here if it has a non-default shape or is critical.
              A node mentioned only in an edge is created automatically.
  "edges":  an array of connections. Each: { "from": "<id>", "to": "<id>", "label": "<text>" }
            - one entry per "A connects/sends/writes to B" relationship
            - label (optional): short text for the connection

RULES:
- Every id is a REAL component from the description. Never invent placeholders (a, b, x).
- Model each relationship as ONE edge. "X reads from Y" → { "from": "x", "to": "y" }.
- Do NOT think about layout, pipelines, branches, or fan-out — just LIST nodes and edges.
  The renderer arranges them. Your only job is to capture the components and how they connect.
- Mark a datastore/database/queue with "shape": "cylinder".

Example — for "A scheduler triggers a worker. The worker reads from a cache and a
database (critical), then writes to an object store":
{
  "title": "Worker Flow",
  "nodes": [
    { "id": "database", "shape": "cylinder", "critical": true },
    { "id": "cache", "shape": "cylinder" },
    { "id": "object_store", "shape": "cylinder" }
  ],
  "edges": [
    { "from": "scheduler", "to": "worker" },
    { "from": "worker", "to": "cache" },
    { "from": "worker", "to": "database" },
    { "from": "worker", "to": "object_store" }
  ]
}`;

/**
 * Compile the IR to valid melk. DETERMINISTIC — given a well-formed IR this can
 * only produce syntactically valid melk (it emits directives, node decls, and
 * plain edges; never a construct that needs ≥2 members, so no "fan-out with one
 * target" class of error). The placer then arranges everything; if there's a
 * genuine placement ambiguity the verify nets catch it, but the SYNTAX is sound
 * by construction.
 *
 * Strategy:
 *   - title → `title: "..."` directive.
 *   - Each listed node with a shape/critical → a `<id> { shape: ..., tags: [...] }`
 *     declaration. (We translate `critical:true` to the `critical` theme tag.)
 *   - Each edge → a plain `<from> -> <to>` (with `{ label: "..." }` if present).
 *
 * We DON'T try to be clever and synthesize pipelines/branches/fan-outs — plain
 * edges always place correctly for a connected DAG, and avoiding the structured
 * constructs avoids their member-count and placement constraints entirely. The
 * result reads as a clean edge list, which melk lays out fine.
 *
 * @param {{title?:string, nodes?:Array, edges?:Array}} ir
 * @returns {string} valid melk source
 */
export function irToMelk(ir) {
  const lines = [];
  const seen = new Set();

  const id = (s) => sanitizeId(s);

  if (ir.title && String(ir.title).trim()) {
    lines.push(`title: "${escapeLabel(ir.title)}"`);
  }

  // Node declarations (only those with a shape or critical flag need one).
  for (const n of ir.nodes ?? []) {
    if (!n || !n.id) continue;
    const nid = id(n.id);
    if (!nid || seen.has(nid)) continue;        // skip blanks + duplicate decls
    const attrs = [];
    if (n.shape && SHAPES.has(n.shape)) attrs.push(`shape: ${n.shape}`);
    if (n.critical === true) attrs.push(`tags: [ critical ]`);
    if (attrs.length === 0) continue;            // nothing to declare → let edge auto-create
    lines.push(`${nid} { ${attrs.join(", ")} }`);
    seen.add(nid);
  }

  // Edges. Plain `a -> b` works for a linear chain, but melk's placer collides on
  // DIVERGENCE (one source → 2+ targets) and CONVERGENCE (2+ sources → one target)
  // — the E_AMBIGUOUS_PLACEMENT cases. The structuring the model kept getting
  // wrong, code does RELIABLY here: detect those fan/merge points and emit the
  // melk construct that places cleanly (`fan-out` for divergence, `bus` for
  // convergence). This is the heart of the planner approach — the IR carries
  // intent (a flat edge list); code computes the valid melk constructs.
  const edgeSeen = new Set();
  /** @type {{from:string,to:string,label:string}[]} */
  const edges = [];
  for (const e of ir.edges ?? []) {
    if (!e || !e.from || !e.to) continue;
    const from = id(e.from), to = id(e.to);
    if (!from || !to || from === to) continue;   // skip blanks + self-loops
    const key = `${from}->${to}`;
    if (edgeSeen.has(key)) continue;             // dedup
    edgeSeen.add(key);
    edges.push({ from, to, label: e.label && String(e.label).trim() ? escapeLabel(e.label) : "" });
  }

  // Degree counts over ALL edges (a labeled edge still occupies a placement slot).
  const outDeg = new Map(), inDeg = new Map();
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  }

  let grp = 0;
  const claimed = new Set();

  // 1. CONVERGENCE → bus. A target with 2+ incoming UNLABELED edges merges via a
  // bus (which places cleanly). Labeled incoming edges can't join a bus (no label
  // slot), so they're left for the plain/branch pass.
  const busGroups = new Map(); // target -> [sources]
  for (const e of edges) {
    if (e.label || (inDeg.get(e.to) || 0) < 2) continue;
    if (!busGroups.has(e.to)) busGroups.set(e.to, []);
    busGroups.get(e.to).push(e.from);
    claimed.add(`${e.from}->${e.to}`);
  }
  for (const [target, sources] of busGroups) {
    if (sources.length >= 2) lines.push(`bus grp${++grp}: [ ${sources.join(", ")} ] -> ${target}`);
    else sources.forEach((s) => claimed.delete(`${s}->${target}`)); // undo if only 1 survived
  }

  // 2. DIVERGENCE → fan-out (all unlabeled) or first-edge + branches (if any
  // labeled). A source with 2+ outgoing edges collides if emitted as plain edges.
  //   - all unlabeled  → one fan-out.
  //   - some labeled   → emit the FIRST edge plainly (keeping its label) and push
  //                      each remaining target off-spine via `branch` (alternating
  //                      sides). Branches don't carry labels, so labels on the
  //                      branched edges are dropped — a rare, acceptable tradeoff
  //                      that guarantees a valid placement.
  const bySource = new Map();
  for (const e of edges) {
    if (claimed.has(`${e.from}->${e.to}`)) continue;
    if (!bySource.has(e.from)) bySource.set(e.from, []);
    bySource.get(e.from).push(e);
  }
  for (const [source, group] of bySource) {
    if (group.length < 2) continue; // not a divergence; handled in the plain pass
    const anyLabeled = group.some((e) => e.label);
    if (!anyLabeled) {
      lines.push(`fan-out grp${++grp}: ${source} -> [ ${group.map((e) => e.to).join(", ")} ]`);
      group.forEach((e) => claimed.add(`${e.from}->${e.to}`));
    } else {
      const [first, ...rest] = group;
      const lbl = first.label ? ` { label: "${first.label}" }` : "";
      lines.push(`${source} -> ${first.to}${lbl}`);
      claimed.add(`${source}->${first.to}`);
      rest.forEach((e, i) => {
        lines.push(`branch grp${++grp}:${i % 2 ? "left" : "right"}: ${source} -> ${e.to}`);
        claimed.add(`${source}->${e.to}`);
      });
    }
  }

  // 3. Everything else: a plain edge (with label if present).
  for (const e of edges) {
    if (claimed.has(`${e.from}->${e.to}`)) continue;
    const label = e.label ? ` { label: "${e.label}" }` : "";
    lines.push(`${e.from} -> ${e.to}${label}`);
  }

  return lines.join("\n");
}

const SHAPES = new Set(["rect", "roundrect", "circle", "diamond", "cylinder"]);

/** Coerce an arbitrary string into a safe melk identifier (lowercase, _-joined). */
function sanitizeId(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")   // non-id chars → underscore
    .replace(/^_+|_+$/g, "")         // trim leading/trailing underscores
    .slice(0, 40);                   // hard length cap (defensive vs any runaway)
}

/** Escape a string for use inside a melk "..." label. */
function escapeLabel(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ").slice(0, 80);
}

/**
 * Parse the model's IR output (tolerant of stray prose/fences) and compile to
 * melk. Returns { ok, melk, ir, error }.
 *
 * @param {string} raw  the model's raw text output
 */
export function planToMelk(raw) {
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Grab the outermost {...} in case the model added stray text around it.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);

  let ir;
  try {
    ir = JSON.parse(text);
  } catch (e) {
    return { ok: false, melk: "", ir: null, error: `IR is not valid JSON: ${e.message}` };
  }
  if (!ir || typeof ir !== "object") {
    return { ok: false, melk: "", ir: null, error: "IR is not an object" };
  }
  // A diagram needs at least one edge or one declarable node — a title alone is
  // not a diagram.
  const hasContent =
    (Array.isArray(ir.edges) && ir.edges.some((e) => e && e.from && e.to)) ||
    (Array.isArray(ir.nodes) && ir.nodes.some((n) => n && n.id && (n.shape || n.critical)));
  const melk = irToMelk(ir);
  if (!hasContent || !melk.trim()) {
    return { ok: false, melk: "", ir, error: "IR produced no diagram (no nodes/edges)" };
  }
  return { ok: true, melk, ir, error: null };
}
