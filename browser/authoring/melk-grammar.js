/**
 * melk-grammar.js — a GBNF grammar constraining a model to a SAFE SUBSET of melk.
 *
 * Design principle (the crux of the whole approach): the grammar guarantees
 * SYNTACTIC validity — every output parses. It does NOT try to guarantee
 * SEMANTIC validity (no spine collisions, crossings within budget, no ambiguous
 * placement) — those are placement-time properties a context-free grammar can't
 * express. Those are caught by melk's `validateSource` (a deterministic verifier)
 * and fed back as structured `E_*` + `Hint:` for the model to self-correct.
 *
 *   grammar  → output always parses          (form)
 *   validateSource → catches semantic errors  (meaning) → hints → retry
 *
 * The subset: layout/title/theme/crossings directives, node declarations with
 * shape+tags, forward/back edges, and the pipeline/fan-out/bus/branch primitives.
 * Enough to express most single-file architecture diagrams; everything in it is
 * lexically valid melk by construction.
 *
 * GBNF (llama.cpp / xgrammar dialect), same as the webllm-agent tool grammar.
 */

export const MELK_GRAMMAR = String.raw`
# root is BOUNDED: up to 3 directives then 1..8 statements. The cap matters —
# an unbounded "stmt+" gives the model no grammatical pressure to STOP, so a
# small model keeps emitting valid-but-pointless nodes until max_tokens cuts it
# mid-token. A TIGHT cap (8, not 14) also removes the "budget" a small model
# fills with placeholder edges (A -> B, C -> D). A real single-file diagram is
# 4-8 statements; if more is genuinely needed, that's a separate concern.
root        ::= dirs stmt stmt? stmt? stmt? stmt? stmt? stmt? stmt?
dirs        ::= directive? directive? directive?

# ── directives (each optional) ──
directive   ::= ( layout | theme | title | crossings ) nl
layout      ::= "layout: " ( "lr" | "tb" )
theme       ::= "theme: " ( "document-light" | "document-dark" | "schematic-light" | "schematic-dark" )
title       ::= "title: " qstr
crossings   ::= "crossings: " int

# ── statements ──
stmt        ::= ( pipeline | fanout | bus | branch | edge | backedge | nodedecl ) nl

pipeline    ::= "pipeline " ident ": " ident " -> " ident ( " -> " ident )*
fanout      ::= "fan-out " ident ": " ident " -> [ " identlist " ]"
bus         ::= "bus " ident ": [ " identlist " ] -> " ident
branch      ::= "branch " ident branchside? ": " ident " -> " ident
branchside  ::= ":" ( "left" | "right" )

edge        ::= ident " -> " ident edgeattrs?
backedge    ::= ident " >- " ident edgeattrs?
edgeattrs   ::= " { " ( "label: " qstr | "tags: [ " identlist " ]" ) " }"

nodedecl    ::= ident " { " nodeattr ( ", " nodeattr )* " }"
nodeattr    ::= "shape: " shape | "tags: [ " identlist " ]" | "label: " qstr
shape       ::= "rect" | "roundrect" | "circle" | "diamond" | "cylinder"

identlist   ::= ident ( ", " ident )*

# ── lexical ──
# Simple, CHEAP rules. (A previous version length-bounded these with long chains
# of optionals — ident ::= L idchar? idchar? ...×32 — which made xgrammar's
# per-token mask computation pathologically slow: generation hung for minutes
# with the GPU pegged. The bound matters less than the COST of enforcing it.)
# The runaway TAIL (layout_tbtheme_document_light_... 100+ chars) is bounded
# OUTSIDE the grammar instead — and crucially, it's RECOVERED, not just rejected:
# the harness salvages the clean leading lines from a runaway (see salvageMelk).
# So keep the lexical rules trivial here and let the harness do the cheap work.
ident       ::= [a-zA-Z_] [a-zA-Z0-9_]*
qstr        ::= "\"" [^"\n]* "\""
int         ::= [0-9]+
nl          ::= "\n"
`.trim();

/**
 * The catalogue we put in the system prompt so the model knows the subset it can
 * use. Kept in sync with the grammar above by hand (small + stable). For the real
 * thing, melk's SYNTAX.md is the canonical reference — this is the condensed card.
 */
export const MELK_PROMPT_CARD = `You write melk diagrams. melk is a text DSL for architecture diagrams.
Output ONLY melk source for the user's specific system — no prose, no code fences, no commentary.

In the forms below, ALL-CAPS words in <ANGLE BRACKETS> are placeholders: replace them
with real names from the user's request. NEVER output the literal words NAME, SOURCE,
SPINE, NODE, etc. — those are slots, not node names.

Directives (optional, at top, each at most once):
  layout: lr                 (or tb)
  title: "<TITLE>"
  theme: document-light      (or document-dark, schematic-light, schematic-dark)

Statements (use the user's real component names):
  pipeline <NAME>: <A> -> <B> -> <C>          a chain in a row (2+ members)
  fan-out <NAME>: <SOURCE> -> [ <A>, <B> ]    one source to many (2+ targets)
  bus <NAME>: [ <A>, <B> ] -> <TARGET>        many to one (2+ producers — never one)
  branch <NAME>:right: <SPINE> -> <SIDE>      ONE off-spine node (side: left or right)
  <A> -> <B>                                  a forward edge
  <B> >- <A>                                  a back edge (A <- B)
  <A> -> <B> { label: "<TEXT>" }              edge with a label
  <NODE> { shape: cylinder, tags: [critical] }   set a node's look
                                              shapes: rect, roundrect, circle, diamond, cylinder
                                              tags (FIXED set): critical, future, deprecated

A complete example — for "client calls an API, which writes to a database (critical),
and logs to an audit store off to the side":
title: "API flow"
pipeline main: client -> api -> database
database { shape: cylinder, tags: [critical] }
branch audit:right: api -> audit_store
audit_store { shape: cylinder }

Rules:
- Use the user's real component names as node ids (lowercase, words joined by _).
- Put a whole sequential chain in ONE pipeline: pipeline flow: a -> b -> c -> d -> e
  (not a 2-node pipeline plus loose nodes).
- CRITICAL: in 'pipeline <name>:', 'fan-out <name>:', 'bus <name>:', 'branch <name>:',
  the <name> is a throwaway construct LABEL — it is NOT a node. Give it a GENERIC name
  like flow, side1, grp — NEVER a real component name. If you write
  'branch cache:right: worker -> fast_store', you've wasted the name 'cache' on a label
  AND still owe a real edge to the actual cache node — that causes duplicate/disconnected
  errors. Instead: name the off-spine NODE itself, e.g. 'branch side1:right: worker -> cache'
  (then 'cache' is the real node). NEVER use the <name> as a source or target either:
  to continue a pipeline use its LAST node ('fan-out grp: worker -> [...]', not the
  pipeline's name).
- An edge is just '<a> -> <b>'. To label it, add { label: "..." }. NEVER create a node
  to represent an edge or a label (no nodes named 'labellededge', 'edge', 'link', etc.).
- "X writes to Y" / "X sends to Y" is just an edge: 'x -> y' (or branch if y is off-spine).
  Do NOT add an extra connector node between them.
- A node used anywhere is auto-created; declare it { ... } only to set shape/tags/label.
- For a node off the side of a pipeline, use 'branch' — and use ONLY the branch line for
  it. Do NOT also add a separate '<x> -> <that_node>' edge; that double-links and collides.
- 'bus' needs 2+ producers; 'fan-out' needs 2+ targets; 'pipeline' needs 2+ members.
- COUNT before choosing a construct. For a SINGLE target off a node, use a plain edge
  '<src> -> <target>' or 'branch <name>:right: <src> -> <target>' — NEVER 'fan-out' with
  one item like 'fan-out f: src -> [ one ]' (that is an error). fan-out is ONLY for 2+.
- tags are a FIXED vocabulary: only 'critical', 'future', 'deprecated'. NEVER invent a
  tag like 'fast', 'hot', 'primary'. To convey such a property, put it in the label:
  '<node> { label: "cache (fast)" }'. Use 'critical' only for genuinely critical nodes.
- NEVER use these as node names (they are keywords): layout, title, theme, pipeline,
  fan-out, bus, branch, label, shape, tags, legend, import, intersect, nodeset, path.
- To set layout or theme, use the DIRECTIVE form at the TOP only: 'layout: tb' and
  'theme: document-light'. NEVER write 'layout -> tb' or 'theme -> ...' — those are wrong.
- Every node name must be a REAL component from the user's request. NEVER invent
  placeholder nodes like A, B, C, x, y, foo. If you have nothing real left to add, STOP.
- Output ONLY the lines for THIS diagram, then STOP. A typical diagram is 4-8 lines total.`;
