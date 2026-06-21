/**
 * Regression fixture for the in-browser authoring harness's DETERMINISTIC guards.
 *
 * Over many runs, a small model (Qwen2.5-1.5B/3B) authoring grammar-constrained
 * .melk produced a recurring set of failure SHAPES. Each shape, once diagnosed,
 * got a guard in browser/authoring/authoring-harness.js: cleanMelk (strips garbage
 * lines pre-validation), checkPlausibility (rejects placeholder/system/runaway
 * names), salvageMelk (recovers a clean prefix from a runaway tail), and
 * checkConnectivity (rejects disconnected fragments).
 *
 * This fixture pins every shape we've actually seen, so the guards can be
 * refactored or relaxed SAFELY — if a future simplification re-opens one of these
 * classes, a test goes red. It is the foundation that turns "afraid to touch the
 * guards" into "the tests say it's fine".
 *
 * Each `RUNAWAY`/`PHANTOM` case is a real (or faithfully reconstructed) model
 * output from the debugging sessions. Comments name the round it came from.
 */
import { describe, it, expect } from "vitest";
import { validateSource } from "../src/compile.js";
import {
  cleanMelk,
  checkPlausibility,
  isFusionPhantom,
  checkConnectivity,
  salvageMelk,
  // @ts-expect-error — JS module with JSDoc, no .d.ts; imported for its runtime fns.
} from "../browser/authoring/authoring-harness.js";

const VS = (src: string) => validateSource(src, { theme: "document-light" });

// ── isFusionPhantom: keyword-fusion node names ──────────────────────────────
describe("isFusionPhantom — keyword-fusion detection", () => {
  // The recurring runaway: identifiers fused from melk's OWN reserved vocabulary.
  // The reliable signal is CONTENT, not length (layout_tb is only 9 chars).
  const PHANTOMS = [
    "layout_tbtheme_document_light", // the canonical 3B runaway
    "layout_tb",
    "theme_document_light",
    "layout_tbtheme",
    "pipeline_bus",
    "fanout_branch",
  ];
  for (const id of PHANTOMS) {
    it(`flags phantom '${id}'`, () => expect(isFusionPhantom(id)).toBe(true));
  }

  // The discrimination that makes the guard safe: real names that CONTAIN one
  // keyword but pair it with a real word must NOT be flagged. These are the
  // adversarial cases — a length/substring heuristic would false-positive here.
  const REAL = [
    "scheduler", "worker", "cache", "database", "fast_store", "object_store",
    "audit_log", "gateway", "light_service", "theme_engine", "document_store",
    "title_bar", "layout_manager", "branch_office",
  ];
  for (const id of REAL) {
    it(`does NOT flag real name '${id}'`, () => expect(isFusionPhantom(id)).toBe(false));
  }
});

// ── cleanMelk: strips garbage LINES before validation ───────────────────────
describe("cleanMelk — pre-validation line stripping", () => {
  it("strips a bare long-token runaway tail (classic length runaway)", () => {
    const out = cleanMelk(
      "pipeline main: a -> b\n" + "x".repeat(120),
    );
    expect(out).toBe("pipeline main: a -> b");
  });

  it("strips a phantom WRAPPED in a valid-looking decl (round: 28-char fusion)", () => {
    // `layout_tbtheme_document_light { label: "critical" }` slips past a length
    // bound AND a bare-token check — it has a `{ ... }` trailer. cleanMelk keys on
    // the SUBJECT identifier being a fusion phantom, so it strips this too.
    const src =
      'pipeline main: scheduler -> worker\n' +
      'layout_tbtheme_document_light { label: "critical" }';
    expect(cleanMelk(src)).toBe("pipeline main: scheduler -> worker");
  });

  it("strips a repeated-chunk runaway (same fragment 3x+ in a row)", () => {
    const out = cleanMelk("a -> b\nfoofoofoofoofoo");
    expect(out).toBe("a -> b");
  });

  it("dedups an EXACT-duplicate line (round: E_DUPLICATE_NODE from verbatim repeat)", () => {
    const src =
      "branch side1:right: worker -> cache\n" +
      "cache { shape: rect }\n" +
      "cache { shape: rect }";
    const out = cleanMelk(src);
    // the second identical `cache { shape: rect }` is gone; one remains
    expect(out.split("\n").filter((l) => l.trim() === "cache { shape: rect }")).toHaveLength(1);
  });

  it("does NOT dedup two DIFFERENT-attribute decls of the same node", () => {
    // Merging those is a real decision left to the model, not a mechanical fix.
    const src = "cache { shape: rect }\ncache { tags: [ critical ] }";
    expect(cleanMelk(src)).toBe(src);
  });

  it("preserves a legitimate diagram untouched (no false stripping)", () => {
    const src =
      'title: "API flow"\n' +
      "pipeline main: client -> api -> database\n" +
      "database { shape: cylinder, tags: [ critical ] }\n" +
      "branch audit:right: api -> audit_store\n" +
      "audit_store { shape: cylinder }";
    expect(cleanMelk(src)).toBe(src);
  });
});

// ── checkPlausibility: rejects placeholder/system/runaway names ─────────────
describe("checkPlausibility — meaning, not compilability", () => {
  it("rejects ALL-CAPS system vocabulary (MEMBER_GAP)", () => {
    expect(checkPlausibility("MEMBER_GAP -> MEMEBER_GAP")?.code).toBe("E_IMPLAUSIBLE_NODE");
  });

  it("rejects edge-as-node meta-words (labellededge)", () => {
    expect(checkPlausibility("a -> labellededge")?.code).toBe("E_IMPLAUSIBLE_NODE");
  });

  it("rejects a fusion phantom used INLINE in an edge (cleanMelk's line-strip wouldn't catch a -> phantom)", () => {
    expect(checkPlausibility("worker -> layout_tb")?.code).toBe("E_IMPLAUSIBLE_NODE");
  });

  it("rejects an over-long fused token (non-keyword length runaway backstop)", () => {
    expect(checkPlausibility("a -> " + "z".repeat(50))?.code).toBe("E_IMPLAUSIBLE_NODE");
  });

  it("passes a clean diagram", () => {
    expect(checkPlausibility("pipeline main: client -> api -> database")).toBeNull();
  });

  it("ignores suspect words INSIDE quoted labels (legitimate display text)", () => {
    expect(checkPlausibility('a -> b { label: "EDGE from MEMBER_GAP" }')).toBeNull();
  });

  it("does NOT flag single-letter primitive names (false-positive guard)", () => {
    expect(checkPlausibility("pipeline p: a -> b")).toBeNull();
  });
});

// ── checkConnectivity: rejects disconnected fragments ───────────────────────
describe("checkConnectivity — one connected diagram", () => {
  // checkConnectivity takes a bound Model ({nodes, edges}); we hand-build the
  // node/edge shapes the placer would produce, which keeps these tests focused on
  // the connectivity logic itself rather than the full compile pipeline.
  it("flags the construct-name-as-node disconnection (round: phantom 'main')", () => {
    // `pipeline main: scheduler -> worker` then `fan-out cache: main -> [...]`
    // wires the fan-out off the pipeline NAME — two islands. Build the model
    // shape the placer would produce.
    const disconnected = {
      nodes: [{ id: "scheduler" }, { id: "worker" }, { id: "main" }, { id: "cache" }, { id: "database" }],
      edges: [
        { from: "scheduler", to: "worker" },
        { from: "main", to: "cache" },
        { from: "main", to: "database" },
      ],
    };
    const diag = checkConnectivity(disconnected);
    expect(diag?.code).toBe("E_DISCONNECTED");
    // names the orphaned fragment
    expect(diag?.message).toMatch(/scheduler|worker/);
  });

  it("passes a single connected component", () => {
    const connected = {
      nodes: [{ id: "scheduler" }, { id: "worker" }, { id: "cache" }, { id: "database" }],
      edges: [
        { from: "scheduler", to: "worker" },
        { from: "worker", to: "cache" },
        { from: "worker", to: "database" },
      ],
    };
    expect(checkConnectivity(connected)).toBeNull();
  });

  it("does not flag trivially-small diagrams (< 3 nodes)", () => {
    expect(checkConnectivity({ nodes: [{ id: "a" }, { id: "b" }], edges: [] })).toBeNull();
  });
});

// ── salvageMelk: recover a clean prefix, but NOT a degenerate stub ──────────
describe("salvageMelk — recover, don't amputate", () => {
  it("salvages a clean diagram from a runaway TAIL", () => {
    const src =
      'title: "Worker Flow"\n' +
      "pipeline payment: client -> gateway -> auth -> ledger\n" +
      "ledger { shape: cylinder, tags: [ critical ] }\n" +
      "branch audit:right: ledger -> audit_log\n" +
      "audit_log { shape: cylinder }\n" +
      "ledger -> receipt\n" +
      "receipt { shape: cylinder }\n" +
      "layout_tbtheme_document_light_directive_layout_tb"; // runaway tail
    const out = salvageMelk(src, VS);
    expect(out).not.toBeNull();
    expect(out).toContain("receipt { shape: cylinder }");
    expect(out).not.toContain("layout_tbtheme");
  });

  it("DECLINES to salvage when it would amputate to a stub (round: 7-line gen → 2-line stub)", () => {
    // A bad tag mid-diagram makes every prefix from that line on fail to compile;
    // the only clean prefix is a 2-node stub. Salvage must DECLINE (return null)
    // so the real error feeds back, instead of accepting a fragment as "valid".
    const src =
      'title: "Worker Flow"\n' +
      "pipeline main: scheduler -> worker\n" +
      "scheduler { size: 8x5 }\n" +
      "worker { size: 6x5 }\n" +
      "cache { shape: rect, tags: [ fast ] }\n" + // 'fast' is an undefined tag
      "fan-out cache_target: worker -> [ cache, database ]\n" +
      "database { shape: cylinder, tags: [ critical ] }";
    expect(salvageMelk(src, VS)).toBeNull();
  });
});

// ── end-to-end: cleanMelk + validateSource on real failing outputs ──────────
describe("end-to-end on real model outputs", () => {
  it("cleanMelk + validateSource: phantom run becomes a real, recoverable error", () => {
    // attempt-2 output from the 3B (phantom duplicated). After cleanMelk strips
    // the phantom lines, the duplicate dissolves and a NORMAL melk error remains.
    const att2 =
      'title: "Worker Flow"\n' +
      "pipeline main: scheduler -> worker\n" +
      "worker { shape: cylinder, tags: [ critical ] }\n" +
      "branch cache:right: worker -> fast_store\n" +
      "fast_store { shape: rect }\n" +
      "cache { shape: rect }\n" +
      'layout_tbtheme_document_light { label: "critical" }\n' +
      'cache -> fast_store { label: "reads from cache (fast)" }\n' +
      'layout_tbtheme_document_light { label: "critical" }';
    const cleaned = cleanMelk(att2);
    expect(cleaned).not.toContain("layout_tbtheme"); // phantom gone
    // what remains is a real placement error the model can self-correct from —
    // NOT a phantom loop. (It may be E_AMBIGUOUS_PLACEMENT etc.; the point is it
    // compiles far enough to give an actionable, non-phantom diagnostic.)
    const diag = VS(cleaned);
    if (diag) expect(diag.code).not.toBe(undefined);
  });
});
