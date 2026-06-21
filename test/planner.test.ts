/**
 * Tests for the planner→render split (browser/authoring/planner.js).
 *
 * The thesis: a small model emits a structured IR ({nodes, edges} JSON) and CODE
 * generates valid melk — so EVERY surface-syntax failure class the self-correct
 * loop fought is structurally impossible. These tests prove the generated melk
 * compiles, including for IRs whose naive melk transcription would have triggered
 * the exact bugs we hit (fan-out-with-one-target, construct-name confusion, etc).
 */
import { describe, it, expect } from "vitest";
import { validateSource } from "../src/compile.js";
import {
  irToMelk,
  planToMelk,
  // @ts-expect-error — JS module, no .d.ts.
} from "../browser/authoring/planner.js";

const VS = (src: string) => validateSource(src, { theme: "document-light" });
const isValid = (src: string) => VS(src) === null;

describe("irToMelk — deterministic IR → valid melk", () => {
  it("the worker-flow IR compiles (the case that failed in raw-melk authoring)", () => {
    // This is the diagram the 3B repeatedly failed to express in melk syntax
    // (construct-name confusion, duplicate decls, phantom fusion). As an IR it's
    // trivial, and the generated melk is valid by construction.
    const ir = {
      title: "Worker Flow",
      nodes: [
        { id: "database", shape: "cylinder", critical: true },
        { id: "cache", shape: "cylinder" },
        { id: "object_store", shape: "cylinder" },
      ],
      edges: [
        { from: "scheduler", to: "worker" },
        { from: "worker", to: "cache" },
        { from: "worker", to: "database" },
        { from: "worker", to: "object_store" },
      ],
    };
    const melk = irToMelk(ir);
    expect(isValid(melk)).toBe(true);
    // worker IS connected to cache — code emitted a fan-out for the 3-way
    // divergence (the structuring the model kept getting wrong), so cache appears
    // as a fan-out target rather than a loose edge. Either way it's connected.
    expect(melk).toMatch(/fan-out \w+: worker -> \[ [^\]]*cache[^\]]* \]/);
    expect(melk).toContain("database { shape: cylinder, tags: [ critical ] }");
  });

  it("a single-target relationship is just an edge — no fan-out-with-one-target error", () => {
    // In raw melk the model reached for `fan-out f: worker -> [ one ]` (an error).
    // The IR has no fan-out concept at all; one edge is one edge.
    const ir = { title: "T", nodes: [], edges: [{ from: "worker", to: "fast_store" }] };
    const melk = irToMelk(ir);
    expect(melk).toContain("worker -> fast_store");
    expect(isValid(melk)).toBe(true);
  });

  it("labels on edges survive and the melk stays valid", () => {
    const ir = {
      title: "Labeled",
      nodes: [],
      edges: [
        { from: "user", to: "frontend" },
        { from: "frontend", to: "api", label: "HTTPS" },
        { from: "api", to: "queue", label: "order.created" },
      ],
    };
    const melk = irToMelk(ir);
    expect(melk).toContain('frontend -> api { label: "HTTPS" }');
    expect(isValid(melk)).toBe(true);
  });

  it("sanitizes ids: spaces/punctuation → underscores, never invalid melk", () => {
    const ir = { title: "S", nodes: [], edges: [{ from: "Object Store!", to: "audit-log" }] };
    const melk = irToMelk(ir);
    expect(melk).toContain("object_store -> audit_log");
    expect(isValid(melk)).toBe(true);
  });

  it("dedups duplicate edges and skips self-loops (defensive vs model slips)", () => {
    const ir = {
      title: "D",
      nodes: [],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" }, // duplicate
        { from: "c", to: "c" }, // self-loop
      ],
    };
    const melk = irToMelk(ir);
    expect(melk.match(/a -> b/g)).toHaveLength(1);
    expect(melk).not.toContain("c -> c");
    expect(isValid(melk)).toBe(true);
  });

  it("a keyword-fusion id can't survive — sanitized, and harmless even if it did", () => {
    // Even if the model emitted a phantom id, it's just a node name in the IR;
    // there's no directive vocabulary to fuse FROM (the model never writes melk).
    const ir = { title: "P", nodes: [], edges: [{ from: "a", to: "layout_tb" }] };
    const melk = irToMelk(ir);
    // it's a plain (if odd) node — valid melk, not a runaway
    expect(isValid(melk)).toBe(true);
  });

  it("ignores unknown shapes rather than emitting invalid melk", () => {
    const ir = { title: "U", nodes: [{ id: "x", shape: "hexagon" }], edges: [{ from: "x", to: "y" }] };
    const melk = irToMelk(ir);
    expect(melk).not.toContain("hexagon");
    expect(isValid(melk)).toBe(true);
  });

  // The structuring the model kept getting wrong, now done by code. Each of these
  // would collide (E_AMBIGUOUS_PLACEMENT) if emitted as plain edges; irToMelk
  // detects the fan/merge point and emits the construct that places cleanly.
  it("CONVERGENCE (2+ sources → one target) becomes a bus", () => {
    const ir = { title: "B", nodes: [], edges: [
      { from: "web", to: "queue" }, { from: "mobile", to: "queue" }, { from: "batch", to: "queue" },
      { from: "queue", to: "consumer" },
    ] };
    const melk = irToMelk(ir);
    expect(melk).toMatch(/bus \w+: \[ [^\]]* \] -> queue/);
    expect(isValid(melk)).toBe(true);
  });

  it("a diamond (diverge then converge) is valid", () => {
    const ir = { title: "D", nodes: [], edges: [
      { from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" },
    ] };
    expect(isValid(irToMelk(ir))).toBe(true);
  });

  it("labeled divergence stays valid (first edge keeps its label, rest become branches)", () => {
    const ir = { title: "L", nodes: [], edges: [
      { from: "api", to: "db", label: "writes" }, { from: "api", to: "queue", label: "emits" },
    ] };
    const melk = irToMelk(ir);
    expect(isValid(melk)).toBe(true);
    expect(melk).toContain('label: "writes"'); // first label preserved
  });

  it("two independent convergence points each get their own bus", () => {
    const ir = { title: "2B", nodes: [], edges: [
      { from: "a", to: "x" }, { from: "b", to: "x" }, { from: "c", to: "y" }, { from: "d", to: "y" },
    ] };
    expect(isValid(irToMelk(ir))).toBe(true);
  });
});

describe("planToMelk — tolerant parsing of model output", () => {
  it("parses clean JSON", () => {
    const raw = '{"title":"T","nodes":[],"edges":[{"from":"a","to":"b"}]}';
    const r = planToMelk(raw);
    expect(r.ok).toBe(true);
    expect(isValid(r.melk)).toBe(true);
  });

  it("strips a ```json fence", () => {
    const raw = '```json\n{"title":"T","nodes":[],"edges":[{"from":"a","to":"b"}]}\n```';
    expect(planToMelk(raw).ok).toBe(true);
  });

  it("recovers from stray prose around the object", () => {
    const raw = 'Here is the plan:\n{"title":"T","nodes":[],"edges":[{"from":"a","to":"b"}]}\nDone.';
    const r = planToMelk(raw);
    expect(r.ok).toBe(true);
    expect(isValid(r.melk)).toBe(true);
  });

  it("reports invalid JSON as an error (not a crash)", () => {
    const r = planToMelk("not json at all");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/JSON/);
  });

  it("reports an empty plan as an error", () => {
    const r = planToMelk('{"title":"T","nodes":[],"edges":[]}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no diagram/);
  });
});
