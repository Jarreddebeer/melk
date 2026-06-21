/**
 * authoring-harness.js — NL → grammar-constrained .melk → validate → self-correct.
 *
 * The synthesis of the whole conversation, applied to melk:
 *   1. a small in-browser model (WebLLM/WebGPU) authors .melk,
 *   2. GBNF grammar constrains it to SYNTACTICALLY valid melk (form),
 *   3. melk's validateSource is a DETERMINISTIC verifier (meaning) — not a
 *      gameable proxy; it returns null or a structured {code, message, hint},
 *   4. on a semantic error the structured hint is fed back and the model
 *      regenerates — a self-correct loop with an exact, non-hallucinatable signal.
 *
 * grammar → output always parses           |  validateSource → catches the rest
 *                                           |  → hint → retry
 */

import { MELK_GRAMMAR, MELK_PROMPT_CARD } from "./melk-grammar.js";
import { IR_GRAMMAR, IR_PROMPT_CARD, planToMelk } from "./planner.js";

/** One grammar-constrained generation. Returns { text, ms, grammarApplied }. */
async function generateMelk(engine, messages, useGrammar, onEvent, temperature = 0.2) {
  // melk diagrams are short; a tight cap is a hard backstop against runaway
  // generation if grammar enforcement is unavailable. 220 tokens ≈ a sizeable
  // diagram, far below the thousands a runaway produces.
  const request = { messages, temperature, max_tokens: 220 };
  let grammarApplied = false;
  if (useGrammar) {
    request.response_format = { type: "grammar", grammar: MELK_GRAMMAR };
    grammarApplied = true;
  }
  const t0 = performance.now();
  let reply;
  try {
    reply = await engine.chat.completions.create(request);
  } catch (e) {
    // Grammar rejected/unsupported for this model → surface it (not silent!),
    // then retry unconstrained so the validate loop still has something to work
    // with. The runaway you saw was a SILENT fallback to unconstrained output.
    if (request.response_format) {
      grammarApplied = false;
      onEvent?.({ phase: "grammar-fallback", error: String(e?.message || e) });
      delete request.response_format;
      reply = await engine.chat.completions.create(request);
    } else throw e;
  }
  return { text: reply.choices[0].message.content ?? "", ms: performance.now() - t0, grammarApplied };
}

// The recurring runaway signature: an identifier fused from melk's OWN reserved
// vocabulary (`layout_tbtheme_document_light`, `layout_tb`, ...). The reliable
// signal is CONTENT, not length — these are never real component names. Shared by
// cleanMelk (strips the garbage line) and checkPlausibility (rejects + hints).
const MELK_KEYWORDS =
  "layout|tb|lr|theme|document|light|dark|schematic|title|crossings|directive|pipeline|fanout|fan_out|bus|branch|nodeset|intersect";
const FUSION_RE = new RegExp(`^(?:${MELK_KEYWORDS})(?:_?(?:${MELK_KEYWORDS})){1,}$`, "i");

/** True if `id` is a phantom node fused from reserved melk vocabulary. */
function isFusionPhantom(id) {
  return FUSION_RE.test(id);
}

/** Strip anything that isn't melk (defensive — grammar should prevent fences). */
function cleanMelk(text) {
  let s = text.trim();
  const fence = s.match(/```(?:melk)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Drop runaway/phantom garbage LINES before validation, so they don't block an
  // otherwise-recoverable diagram (distinct from salvageMelk, which trims to the
  // longest clean PREFIX — these compose). Signatures:
  //   1. an absurdly-long bare fused token (the classic length runaway), and
  //   2. a line whose SUBJECT identifier is a keyword-fusion phantom — e.g.
  //      `layout_tbtheme_document_light { label: "critical" }`. This is the form
  //      that slips past a length bound (28 chars) and past a bare-token check
  //      (it has a valid-looking `{ ... }` trailer), reaching bind as a phantom.
  //   3. an EXACT-duplicate line. melk rejects a node declared twice or an edge
  //      stated twice (E_DUPLICATE_NODE / dup edge); when the model emits the
  //      SAME line verbatim it's never intentional, so drop the repeat. (We only
  //      dedup IDENTICAL lines — merging two different-attribute decls of one node
  //      is a real decision we leave to the model, not a mechanical fix.)
  const seenLines = new Set();
  const lines = s.split("\n").filter((line) => {
    const t = line.trim();
    if (!t) return true;
    const subject = t.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\b/)?.[1];
    if (subject && isFusionPhantom(subject)) return false;     // phantom decl/edge
    if (/^[a-zA-Z_][a-zA-Z0-9_]{60,}$/.test(t)) return false;  // bare length runaway
    // repeated-unit runaway: a single unbroken token that is a short unit (2-40
    // chars) repeated 4+ times — `foofoofoofoo`, `ababababab`. Anchored to a
    // space-free token so it can't match a normal `a -> b ...` line; a real
    // identifier never repeats a short unit 4x.
    if (/^(\S{2,40}?)\1{3,}$/.test(t)) return false;
    if (seenLines.has(t)) return false;                        // exact-duplicate line
    seenLines.add(t);
    return true;
  });
  return lines.join("\n").trim();
}

/**
 * A SECOND verifier: plausibility, not compilability.
 *
 * validateSource guarantees the melk COMPILES — but melk auto-declares any
 * unknown name, so garbage like `MEMBER_GAP -> MEMEBER_GAP` or `A >- B` compiles
 * "valid" while being meaningless. The model invents these by parroting system
 * vocabulary (error-hint terms like MEMBER_GAP) or placeholder letters. A
 * compile-checker can't catch that; a plausibility-checker can. (This is the
 * "two instruments in agreement" lesson — one verifier isn't enough when its
 * guarantee, here compilability, doesn't cover the failure mode.)
 *
 * Returns a synthetic Diagnostic (or null) so it slots into the same loop.
 */
function checkPlausibility(melk) {
  // Only HIGH-CONFIDENCE signals — words that have no legitimate use as a melk
  // node name. We do NOT flag single letters (those are valid primitive names
  // like `pipeline p:`) — too blunt, causes false positives. We only catch:
  //   - ALL-CAPS multi-char tokens (MEMBER_GAP, NODE) — internal/system vocab,
  //   - explicit meta-words the model parrots for edges/labels/placeholders.
  // Words inside quoted labels are ignored (legitimate display text).
  const stripped = melk.replace(/"[^"]*"/g, '""'); // remove label text first
  const suspects = new Set();
  // Keyword-fusion signature: the recurring runaway isn't always LONG — the model
  // fuses melk's OWN directive/keyword vocabulary into a phantom node like
  // `layout_tbtheme_document_light` (28 chars — under any length bound) or even
  // `layout_tb`. The reliable signal is the CONTENT, not the length: an identifier
  // assembled from 2+ of these reserved words is never a real component name.
  // These guards form a deliberate hierarchy, NOT redundancy — each catches a
  // failure the others can't, ordered specific → general → orthogonal:
  //   - isFusionPhantom: the OBSERVED runaway (fused melk keywords). cleanMelk
  //     already strips these as whole LINES, so this branch only fires for a
  //     phantom used INLINE in an edge (`a -> layout_tb`) — kept for that case.
  //   - length > 40 / repeated: the GENERAL backstop for a runaway that ISN'T
  //     keyword-fusion (e.g. fused real words `databaseworkerledger`, or a short
  //     token repeated). Cheap, and insurance against the next runaway mutation —
  //     every prior "final" shape of this runaway turned out not to be final.
  //   - ALL-CAPS / meta-words: ORTHOGONAL failures (system-vocab parroting like
  //     MEMBER_GAP, edge-as-node like `labellededge`) — unrelated to runaways.
  for (const m of stripped.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)) {
    const w = m[0];
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(w)) suspects.add(w);                       // MEMBER_GAP, NODE
    if (/^(labellededge|labelededge|edge|link|placeholder|member_gap)$/i.test(w)) suspects.add(w);
    if (isFusionPhantom(w)) suspects.add(w.length > 30 ? w.slice(0, 28) + "…" : w); // layout_tbtheme_document_light
    if (w.length > 40) suspects.add(w.slice(0, 30) + "…");
  }
  const repeated = /(\b[a-z_]{4,}\b)(?:[^a-z]+\1){4,}/i.test(stripped);

  const real = [...suspects];
  if (real.length === 0 && !repeated) return null;
  const what = real.length ? real.join(", ") : "repeated runaway text";
  return {
    stage: "plausibility",
    code: "E_IMPLAUSIBLE_NODE",
    message: `output contains placeholder/system/runaway names, not real components: ${what}`,
    hint:
      `Every node must be a real component from the request, named simply (e.g. 'gateway'). ` +
      `Remove ${what}. Do not invent nodes from layout/theme terms or fuse words together. ` +
      `To set layout/theme use the directive form at the TOP: 'layout: tb', 'theme: document-light'. ` +
      `An edge is simply '<a> -> <b>'.`,
  };
}

/**
 * A THIRD verifier: structural connectivity, not compilability or plausibility.
 *
 * The failure this catches is well-formed AND plausible AND un-salvageable, so
 * all three earlier nets pass it through — yet it's wrong. Its signature: the
 * model misuses a CONSTRUCT NAME as a node. `pipeline main: scheduler -> worker`
 * then `fan-out cache: main -> [...]` wires the fan-out off `main` (the pipeline's
 * NAME) instead of `worker`. Result: a phantom `main` node and TWO disconnected
 * fragments — worker never reaches the stores. It compiles, the names look real,
 * there's no tail to trim. Only a structural check sees it.
 *
 * A single-system architecture diagram should be ONE connected component. Two+
 * islands ⇒ something was wired to the wrong source (almost always a construct
 * name used as a node). We flood-fill the undirected edge graph; if there's more
 * than one component, we report the smaller fragment(s) and the likely cause.
 *
 * @param {{nodes:{id:string}[], edges:{from:string,to:string}[]}|null} model
 */
function checkConnectivity(model) {
  if (!model || model.nodes.length < 3 || model.edges.length === 0) return null;
  const adj = new Map(model.nodes.map((n) => [n.id, new Set()]));
  for (const e of model.edges) { adj.get(e.from)?.add(e.to); adj.get(e.to)?.add(e.from); }
  const seen = new Set();
  const components = [];
  for (const n of model.nodes) {
    if (seen.has(n.id)) continue;
    const stack = [n.id], comp = [];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x); comp.push(x);
      for (const y of adj.get(x) || []) stack.push(y);
    }
    components.push(comp);
  }
  if (components.length <= 1) return null;

  // Largest component is presumed the intended diagram; the rest are orphans.
  components.sort((a, b) => b.length - a.length);
  const orphans = components.slice(1).flat();
  return {
    stage: "connectivity",
    code: "E_DISCONNECTED",
    message:
      `the diagram is in ${components.length} disconnected pieces; ` +
      `these nodes aren't connected to the main flow: ${orphans.join(", ")}`,
    hint:
      `A single system should be ONE connected diagram. The break is usually a ` +
      `CONSTRUCT NAME used as a node: in 'pipeline <name>: a -> b' and ` +
      `'fan-out <name>: src -> [...]', the <name> is just a label — it is NOT a node ` +
      `and must NEVER appear as a source or target. Use the real component (e.g. the ` +
      `last node of the pipeline) as the fan-out/edge source. Re-wire so ${orphans.join(", ")} ` +
      `connect to the rest, and remove any node that is actually a construct name.`,
  };
}

/**
 * Salvage a clean diagram from a runaway tail.
 *
 * The 3B's dominant failure mode is: emit a perfectly correct N-line diagram,
 * then append ONE runaway line (a 100-char fused identifier, or repeated junk).
 * The grammar permits it (it's one grammatically-valid statement whose ident ran
 * away) and the model can't recover (it regenerates the same tail every attempt).
 * But the correct diagram is sitting right there ABOVE the garbage.
 *
 * So: strip trailing lines one at a time and re-check. The longest leading prefix
 * that both COMPILES and is PLAUSIBLE is the salvaged diagram. This is the cheap,
 * zero-grammar-cost place to bound the runaway — far better than a pathological
 * grammar rule (which hung xgrammar) or hoping the model self-corrects (it can't).
 *
 * CONSERVATIVE BY DESIGN: salvage is only for a runaway TAIL — a few junk lines at
 * the END of an otherwise-good diagram. It must NOT amputate a diagram down to a
 * stub. If the clean prefix drops more than a couple of trailing lines, the break
 * is NOT a tail runaway — it's a real, fixable error mid-diagram (e.g. a node
 * declared before the construct that uses it). Masking that with a 2-line stub is
 * worse than failing: it hides a diagram the model could self-correct. So we only
 * accept a salvage that keeps MOST of the original — otherwise return null and let
 * the real diagnostic feed back. Returns the salvaged melk, or null.
 */
function salvageMelk(melk, validateSource) {
  const lines = melk.split("\n");
  const contentLines = lines.filter((l) => l.trim()).length;
  for (let n = lines.length - 1; n >= 2; n--) {
    const candidate = lines.slice(0, n).join("\n").trim();
    if (!candidate) continue;
    const compiles = validateSource(candidate, { theme: "document-light" });
    if (compiles !== null || checkPlausibility(candidate) !== null) continue;
    // Found the longest clean prefix. Only accept it if it's a TAIL trim, not an
    // amputation: keep it only when it retains most of the diagram. A prefix that
    // throws away half the content isn't a recovered diagram — it's a stub hiding
    // a correctable error, which belongs in the feedback loop instead.
    const keptContent = candidate.split("\n").filter((l) => l.trim()).length;
    const droppedTooMuch = keptContent < Math.max(3, Math.ceil(contentLines * 0.6));
    return droppedTooMuch ? null : candidate;
  }
  return null;
}

/**
 * Auto-size boxes whose labels overflow.
 *
 * melk deliberately never grows a box to fit its label — text-fit is a no-op by
 * design; the W_LABEL_OVERFLOW warning is the only feedback, and the author is
 * expected to add `{ size: NxM }`. That's a fine contract for a human, but a poor
 * one for a small model (it would have to reason about pixel widths). The warning
 * already CARRIES the exact fix (`<id> { size: NxM }`), so the harness can apply
 * it mechanically — the same philosophy as salvage: do in code what the model
 * shouldn't have to reason about.
 *
 * Strategy: render once to collect overflow warnings, parse the suggested size for
 * each node, and merge `size:` into that node's declaration (adding a decl line if
 * the node has none). Re-render to catch any second-order overflow (rare). Returns
 * the resized melk, or the original if nothing overflowed.
 *
 * @param {string} melk
 * @param {(src:string)=>string[]} collectWarnings  render `src`, return W_* lines
 */
function autoSizeMelk(melk, collectWarnings) {
  // W_LABEL_OVERFLOW: label of 'gateway' (38px) ... Grow it: `gateway { size: 6x5 }`
  const SIZE_RE = /Grow it: `(\w+) \{ size: (\d+x\d+) \}`/;

  for (let pass = 0; pass < 2; pass++) {
    const sizes = new Map(); // id -> "NxM"
    for (const line of collectWarnings(melk)) {
      const m = line.match(SIZE_RE);
      if (m) sizes.set(m[1], m[2]);
    }
    if (sizes.size === 0) return melk;
    melk = mergeSizes(melk, sizes);
  }
  return melk;
}

/** Merge `size: NxM` into each named node's declaration, adding a decl if needed. */
function mergeSizes(melk, sizes) {
  const lines = melk.split("\n");
  const handled = new Set();
  // 1. Update existing declarations: `<id> { ... }` → add/replace size attr.
  for (let i = 0; i < lines.length; i++) {
    const decl = lines[i].match(/^(\w+) \{ (.*) \}\s*$/);
    if (!decl || !sizes.has(decl[1])) continue;
    const id = decl[1];
    let attrs = decl[2];
    if (/\bsize:/.test(attrs)) attrs = attrs.replace(/size: \d+x\d+/, `size: ${sizes.get(id)}`);
    else attrs = `${attrs}, size: ${sizes.get(id)}`;
    lines[i] = `${id} { ${attrs} }`;
    handled.add(id);
  }
  // 2. For overflowing nodes with no declaration line, append one.
  for (const [id, size] of sizes) {
    if (handled.has(id)) continue;
    lines.push(`${id} { size: ${size} }`);
  }
  return lines.join("\n");
}

/**
 * Author a melk diagram from a natural-language description, self-correcting
 * from validateSource's structured diagnostics.
 *
 * @param {object} deps
 * @param {object} deps.engine        WebLLM engine (chat.completions API)
 * @param {(src:string, opts?:object)=>(object|null)} deps.validateSource  melk verifier
 * @param {(src:string)=>string[]} [deps.collectWarnings]  render src, return W_* lines (enables auto-size)
 * @param {(src:string)=>(object|null)} [deps.compileModel]  src → bound Model (enables connectivity check)
 * @param {(s:string)=>void} [deps.onEvent]  progress callback {phase, ...}
 * @param {string} description         the user's NL request
 * @param {object} [opts] { maxAttempts=4, useGrammar=true }
 * @returns {Promise<{ ok:boolean, melk:string, attempts:object[] }>}
 */
export async function authorMelk({ engine, validateSource, collectWarnings, compileModel, onEvent = () => {} }, description, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const useGrammar = opts.useGrammar ?? true;

  // Apply the mechanical post-processing the model shouldn't have to reason about
  // (auto-size overflowing boxes), emit the valid event, and return success.
  const finalize = (attempt, melk) => {
    if (collectWarnings) {
      const sized = autoSizeMelk(melk, collectWarnings);
      if (sized !== melk) { onEvent({ phase: "autosized", attempt, melk: sized, original: melk }); melk = sized; }
    }
    onEvent({ phase: "valid", attempt, melk });
    return { ok: true, melk, attempts };
  };

  const messages = [
    { role: "system", content: MELK_PROMPT_CARD },
    { role: "user", content: `Draw this as a melk diagram:\n${description}` },
  ];

  const attempts = [];
  let prevMelk = null;     // detect fixed points (the model re-emitting the same thing)
  let stuckCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onEvent({ phase: "generating", attempt });
    // Escalate temperature when stuck so the model breaks out of a fixed point
    // instead of deterministically reproducing the same failing output.
    const temperature = 0.2 + stuckCount * 0.3;
    const { text, ms, grammarApplied } = await generateMelk(engine, messages, useGrammar, onEvent, temperature);
    const melk = cleanMelk(text);
    onEvent({ phase: "generated", attempt, melk, ms, grammarApplied });

    // Three verifiers, each catching what the others can't: (1) does it COMPILE
    // (validateSource), (2) is it PLAUSIBLE (no placeholder/system-vocab names),
    // (3) is it CONNECTED (one graph, no orphan fragments from a construct-name-
    // as-node mistake). Compilable, plausible, fragmented garbage is still garbage.
    const diag =
      validateSource(melk, { theme: "document-light" }) ||
      checkPlausibility(melk) ||
      (compileModel ? checkConnectivity(compileModel(melk)) : null);

    if (diag === null) {
      attempts.push({ attempt, melk, ms, ok: true });
      return finalize(attempt, melk);
    }

    // Before treating this as a failure, try to SALVAGE a clean diagram from a
    // runaway tail. The model's commonest failure is a correct diagram + one
    // junk trailing line; the leading prefix is a perfectly good diagram. If we
    // can recover it, accept it — no need to spend an attempt the model would
    // only fail again identically (it can't self-correct a tokenizer runaway).
    // Salvage only counts if the recovered prefix is itself CONNECTED — trimming
    // a runaway tail mustn't leave a disconnected fragment as the "diagram".
    const salvaged = salvageMelk(melk, validateSource);
    const salvagedDisconnected = salvaged && compileModel && checkConnectivity(compileModel(salvaged));
    if (salvaged && !salvagedDisconnected) {
      attempts.push({ attempt, melk: salvaged, ms, ok: true, salvaged: true });
      onEvent({ phase: "salvaged", attempt, melk: salvaged, original: melk });
      return finalize(attempt, salvaged);
    }

    // Semantic error the grammar can't prevent. Feed the structured hint back.
    const isRepeat = melk === prevMelk;
    if (isRepeat) stuckCount++; else stuckCount = 0;
    prevMelk = melk;
    attempts.push({ attempt, melk, ms, ok: false, diag, repeat: isRepeat });
    onEvent({ phase: "invalid", attempt, melk, diag, repeat: isRepeat });

    if (attempt === maxAttempts) break;

    // Append the failed attempt + the exact, actionable diagnostic. This is the
    // self-correct signal — precise (names the nodes, gives the fix), not a vibe.
    messages.push({ role: "assistant", content: melk });
    if (isRepeat) {
      // Fixed point: the model reproduced the same failing output. A repeated
      // identical hint won't help — push it toward a STRUCTURALLY different
      // approach and drop the extraneous constructs the conflict comes from.
      messages.push({
        role: "user",
        content:
          `You produced the EXACT SAME melk again and it still fails with ${diag.code}.\n` +
          `Stop making small edits. Start over with the SIMPLEST possible diagram:\n` +
          `- ONE pipeline for the main flow.\n` +
          `- For each side/branch node, use exactly ONE 'branch <name>:right: <spine> -> <node>' line.\n` +
          `- Do NOT also add a separate edge to that same node, and do NOT add a 'bus' for it.\n` +
          `- Remove any node whose name isn't a real component from the request.\n` +
          `Output the full, simpler melk now.`,
      });
    } else {
      // Format robustly: some melk errors lack an E_* code; don't emit a noisy
      // "undefined". The message is the signal either way.
      const codePart = diag.code ? `${diag.code}: ` : "";
      messages.push({
        role: "user",
        content:
          `That melk failed to compile:\n` +
          `[${diag.stage}] ${codePart}${diag.message}` +
          (diag.hint ? `\nHint: ${diag.hint}` : "") +
          `\nFix exactly that and output the full corrected melk.`,
      });
    }
  }

  // Exhausted attempts — return the last try so the UI can show how close it got.
  const last = attempts[attempts.length - 1];
  return { ok: false, melk: last?.melk ?? "", attempts };
}

/**
 * Author a diagram via the PLANNER→RENDER split — the architectural alternative
 * to raw-melk authoring. The model emits a structured IR ({nodes, edges} JSON)
 * under a JSON grammar; CODE compiles that IR to guaranteed-valid melk. This
 * removes every surface-syntax failure class the self-correct loop fights (the
 * model never writes a melk token), so it typically succeeds in ONE generation.
 *
 * The validate/plausibility nets still run on the generated melk as a backstop,
 * but irToMelk is valid-by-construction, so a failure here means a genuine
 * placement ambiguity in the model's GRAPH, not a syntax slip.
 *
 * @param {object} deps { engine, validateSource, collectWarnings, onEvent }
 * @param {string} description
 * @param {object} [opts] { maxAttempts=3 }
 */
export async function authorMelkViaPlanner(
  { engine, validateSource, collectWarnings, onEvent = () => {} },
  description,
  opts = {},
) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const messages = [
    { role: "system", content: IR_PROMPT_CARD },
    { role: "user", content: `Describe this system as a diagram plan (JSON):\n${description}` },
  ];
  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onEvent({ phase: "generating", attempt });
    // Constrained IR generation. The IR grammar is flat JSON (cheap for xgrammar).
    const request = {
      messages,
      temperature: 0.1,
      max_tokens: 512,
      response_format: { type: "grammar", grammar: IR_GRAMMAR },
    };
    const t0 = performance.now();
    let reply;
    try {
      reply = await engine.chat.completions.create(request);
    } catch (e) {
      onEvent({ phase: "grammar-fallback", error: String(e?.message || e) });
      delete request.response_format;
      reply = await engine.chat.completions.create(request);
    }
    const ms = performance.now() - t0;
    const raw = reply.choices[0].message.content ?? "";

    // Code compiles IR → melk. This step can't produce a syntax error.
    const plan = planToMelk(raw);
    onEvent({ phase: "planned", attempt, ir: plan.ir, melk: plan.melk, ms, ok: plan.ok });

    if (!plan.ok) {
      // The IR itself was malformed (bad JSON / empty). Feed that back.
      attempts.push({ attempt, melk: "", ms, ok: false, diag: { stage: "planner", code: "E_BAD_IR", message: plan.error } });
      onEvent({ phase: "invalid", attempt, melk: raw, diag: { stage: "planner", message: plan.error } });
      if (attempt === maxAttempts) break;
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: `That wasn't a valid plan: ${plan.error}\nOutput ONLY the JSON object with title, nodes, edges.` });
      continue;
    }

    let melk = plan.melk;
    // Backstop: the generated melk should always compile, but if the GRAPH has a
    // genuine placement ambiguity, surface it (rare — most resolve via the
    // fan-out/bus/branch structuring irToMelk applies).
    const diag = validateSource(melk, { theme: "document-light" });
    if (diag === null) {
      if (collectWarnings) {
        const sized = autoSizeMelk(melk, collectWarnings);
        if (sized !== melk) { onEvent({ phase: "autosized", attempt, melk: sized, original: melk }); melk = sized; }
      }
      attempts.push({ attempt, melk, ms, ok: true });
      onEvent({ phase: "valid", attempt, melk });
      return { ok: true, melk, ir: plan.ir, attempts };
    }

    attempts.push({ attempt, melk, ms, ok: false, diag });
    onEvent({ phase: "invalid", attempt, melk, diag });
    if (attempt === maxAttempts) break;
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `The plan rendered but the layout has a conflict: ${diag.message}\nAdjust the nodes/edges to resolve it and output ONLY the corrected JSON.`,
    });
  }

  const last = attempts[attempts.length - 1];
  return { ok: false, melk: last?.melk ?? "", attempts };
}

// Exported for the regression fixture (test/authoring-guards.test.ts) so the pure
// guard functions can be exercised directly against every failure shape we've hit.
// These are the deterministic nets; keeping them tested lets us refactor/relax the
// guards safely and proves the runaway/phantom classes stay dead.
export { cleanMelk, checkPlausibility, isFusionPhantom, checkConnectivity, salvageMelk };
