/**
 * Phase 4 parser + bind tests.
 *
 * Covers the new grammar: cell sizing (`WxH`), back-edges (`>-`),
 * structured flow (`pipeline`, `bus`, `fan-out`), tags, the
 * `crossings:` directive, and deprecation errors for the removed
 * `lane` and `group` keywords.
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";

function run(src: string) {
  return bind(parse(tokenize(src)));
}

function ast(src: string) {
  return parse(tokenize(src));
}

describe("lexer", () => {
  it("tokenizes a simple edge", () => {
    const tokens = tokenize("a -> b").map((t) => t.kind);
    expect(tokens).toEqual(["ident", "arrow", "ident", "eof"]);
  });

  it("tokenizes a back-edge with `>-`", () => {
    const tokens = tokenize("sink >- source").map((t) => t.kind);
    expect(tokens).toEqual(["ident", "back-arrow", "ident", "eof"]);
  });

  it("recognises the cell-size token", () => {
    const tokens = tokenize("2x1");
    expect(tokens[0]!.kind).toBe("cells");
    expect(tokens[0]!.value).toBe("2x1");
  });

  it("does NOT confuse `1` with cells", () => {
    const tokens = tokenize("crossings: 1").map((t) => t.kind);
    expect(tokens).toEqual(["ident", "colon", "number", "eof"]);
  });

  it("tokenizes brackets", () => {
    const tokens = tokenize("[a, b]").map((t) => t.kind);
    expect(tokens).toEqual(["lbracket", "ident", "comma", "ident", "rbracket", "eof"]);
  });

  it("skips comments", () => {
    const tokens = tokenize("# hello\na").map((t) => t.kind);
    expect(tokens).toEqual(["ident", "eof"]);
  });

  it("handles strings with escapes", () => {
    const tokens = tokenize('"a\\nb"');
    expect(tokens[0]!.value).toBe("a\nb");
  });

  it("collapses repeated newlines", () => {
    const tokens = tokenize("a\n\n\nb").map((t) => t.kind);
    expect(tokens).toEqual(["ident", "newline", "ident", "eof"]);
  });
});

describe("parser — nodes and edges", () => {
  it("parses bare node declarations with cell sizing", () => {
    const model = run("foo { shape: rect, size: 5x3 }");
    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0]!.id).toBe("foo");
    expect(model.nodes[0]!.shape).toBe("rect");
    expect(model.nodes[0]!.size).toEqual({ width: 5, height: 3 });
  });

  it("defaults node size to 5x5 when omitted", () => {
    const model = run("foo");
    expect(model.nodes[0]!.size).toEqual({ width: 5, height: 5 });
  });

  it("parses forward edges", () => {
    const model = run("a -> b");
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]!.from).toBe("a");
    expect(model.edges[0]!.to).toBe("b");
    expect(model.edges[0]!.isBackEdge).toBeUndefined();
  });

  it("parses inline back-edges", () => {
    const model = run("sink >- source");
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]!.from).toBe("sink");
    expect(model.edges[0]!.to).toBe("source");
    expect(model.edges[0]!.isBackEdge).toBe(true);
  });

  it("parses edge labels", () => {
    const model = run('a -> b { label: "hi" }');
    expect(model.edges[0]!.label).toBe("hi");
  });

  it("parses ports", () => {
    const model = run("a:north -> b:west");
    expect(model.edges[0]!.fromPort).toBe("north");
    expect(model.edges[0]!.toPort).toBe("west");
  });
});

describe("parser — directives", () => {
  it("parses the layout directive", () => {
    const model = run("layout: tb\na -> b");
    expect(model.layoutMode).toBe("tb");
  });

  it("defaults layout to lr", () => {
    const model = run("a -> b");
    expect(model.layoutMode).toBe("lr");
  });

  it("parses the crossings directive", () => {
    const model = run("crossings: 4\na -> b");
    expect(model.crossingsBudget).toBe(4);
  });

  it("defaults crossings budget to 0", () => {
    const model = run("a -> b");
    expect(model.crossingsBudget).toBe(0);
  });

  it("rejects negative crossings budgets", () => {
    // `-1` doesn't tokenise as a number (no signed-literal support); the
    // lexer chokes on the leading `-` before the parser gets the chance
    // to enforce the non-negative rule.
    expect(() => run("crossings: -1\na -> b")).toThrow();
  });
});

describe("parser — structured flow", () => {
  it("parses a pipeline declaration", () => {
    const tree = ast("pipeline ingest: a -> b -> c");
    const stmt = tree.statements[0]!;
    expect(stmt.kind).toBe("pipeline");
    if (stmt.kind === "pipeline") {
      expect(stmt.name).toBe("ingest");
      expect(stmt.members).toEqual(["a", "b", "c"]);
    }
  });

  it("rejects a single-member pipeline", () => {
    expect(() => ast("pipeline x: a")).toThrow();
  });

  it("parses a bus declaration", () => {
    const tree = ast("bus power: [a, b, c] -> shared");
    const stmt = tree.statements[0]!;
    expect(stmt.kind).toBe("bus");
    if (stmt.kind === "bus") {
      expect(stmt.producers).toEqual(["a", "b", "c"]);
      expect(stmt.shared).toBe("shared");
    }
  });

  it("rejects a bus with only one producer", () => {
    expect(() => ast("bus x: [a] -> shared")).toThrow();
  });

  it("rejects a bus without brackets", () => {
    expect(() => ast("bus x: a, b -> shared")).toThrow();
  });

  it("parses a fan-out declaration", () => {
    const tree = ast("fan-out broadcast: shared -> [a, b, c]");
    const stmt = tree.statements[0]!;
    expect(stmt.kind).toBe("fan-out");
    if (stmt.kind === "fan-out") {
      expect(stmt.shared).toBe("shared");
      expect(stmt.consumers).toEqual(["a", "b", "c"]);
    }
  });

  it("rejects a single-target fan-out with an actionable E_FANOUT_TOO_FEW hint", () => {
    // The common LLM mistake: fan-out with one target. The error must name the
    // target and steer to a plain edge / branch, not just restate the 2+ rule.
    expect(() => ast("fan-out cache: worker -> [ fast_store ]")).toThrow(
      /E_FANOUT_TOO_FEW.*Hint:.*SINGLE target 'fast_store'.*worker -> fast_store/s,
    );
  });

  it("parses a branch declaration", () => {
    const tree = ast("branch hangers: spine -> enrich");
    const stmt = tree.statements[0]!;
    expect(stmt.kind).toBe("branch");
    if (stmt.kind === "branch") {
      expect(stmt.spine).toBe("spine");
      expect(stmt.member).toBe("enrich");
      expect(stmt.side).toBeUndefined();
    }
  });

  it("rejects bracketed multi-member branch (use composition instead)", () => {
    // Multi-member was dropped in the isometric refactor — branch is a
    // direction change, not a spine. The error message points at how to
    // express what the user probably wants.
    expect(() => ast("branch alerts: validate -> [alert, page]"))
      .toThrow(/branch takes a single member/);
  });

  it("parses an explicit :right side suffix", () => {
    const stmt = ast("branch under:right: middle -> below").statements[0]!;
    if (stmt.kind === "branch") {
      expect(stmt.side).toBe("right");
      expect(stmt.spine).toBe("middle");
      expect(stmt.member).toBe("below");
    } else {
      throw new Error("expected branch");
    }
  });

  it("parses `back` as a regular node id (no longer reserved)", () => {
    const tree = ast("back -> next");
    const stmt = tree.statements[0]!;
    expect(stmt.kind).toBe("edge");
    if (stmt.kind === "edge") {
      expect(stmt.from.node).toBe("back");
      expect(stmt.to.node).toBe("next");
    }
  });
});

describe("parser — annotations", () => {
  it("parses a nodeset declaration", () => {
    const tree = ast("nodeset dataPlane: a, b, c");
    const stmt = tree.statements[0]!;
    expect(stmt.kind).toBe("nodeset");
    if (stmt.kind === "nodeset") {
      expect(stmt.name).toBe("dataPlane");
      expect(stmt.members).toEqual(["a", "b", "c"]);
    }
  });

  it("parses a path declaration", () => {
    const tree = ast("path fastPath: a -> b -> c");
    const stmt = tree.statements[0]!;
    expect(stmt.kind).toBe("path");
    if (stmt.kind === "path") {
      expect(stmt.name).toBe("fastPath");
      expect(stmt.chain).toEqual(["a", "b", "c"]);
    }
  });
});

describe("bind — node + edge property errors", () => {
  it("rejects duplicate node declarations", () => {
    expect(() => run("a\na")).toThrow(/E_DUPLICATE_NODE/);
  });

  it("rejects unknown shape", () => {
    expect(() => run("a { shape: parallelogram }"))
      .toThrow(/unknown shape/);
  });

  it("rejects T-shirt size as a deprecated form", () => {
    expect(() => run("a { size: M }"))
      .toThrow(/E_DEPRECATED_TSHIRT_SIZE/);
  });

  it("rejects unknown node property", () => {
    expect(() => run("a { color: red }"))
      .toThrow(/unknown node property/);
  });

  it("rejects size < 1x1", () => {
    expect(() => run("a { size: 0x1 }"))
      .toThrow(/at least 1x1/);
  });
});

describe("bind — pipeline projection", () => {
  it("creates an edge between each consecutive pair", () => {
    const model = run("pipeline ingest: a -> b -> c");
    expect(model.edges).toHaveLength(2);
    expect(model.edges[0]).toMatchObject({
      from: "a",
      to: "b",
      source: "pipeline",
      sourceName: "ingest",
    });
    expect(model.edges[1]).toMatchObject({
      from: "b",
      to: "c",
      source: "pipeline",
      sourceName: "ingest",
    });
  });

  it("retains the pipeline as a placement constraint", () => {
    const model = run("pipeline ingest: a -> b -> c");
    expect(model.pipelines).toHaveLength(1);
    expect(model.pipelines[0]!.name).toBe("ingest");
    expect(model.pipelines[0]!.members).toEqual(["a", "b", "c"]);
  });

  it("auto-declares pipeline members as 5x5 rects", () => {
    const model = run("pipeline x: a -> b");
    expect(model.nodes).toHaveLength(2);
    expect(model.nodes[0]!.size).toEqual({ width: 5, height: 5 });
    expect(model.nodes[0]!.shape).toBe("rect");
  });

  it("lets an explicit declaration upgrade an auto-declared pipeline member", () => {
    const model = run(
      "pipeline x: a -> b\nb { shape: cylinder, size: 5x3, label: \"B\" }",
    );
    const b = model.nodes.find((n) => n.id === "b")!;
    expect(b.shape).toBe("cylinder");
    expect(b.size).toEqual({ width: 5, height: 3 });
    expect(b.label).toBe("B");
  });

  it("rejects duplicate pipeline names", () => {
    expect(() => run("pipeline p: a -> b\npipeline p: c -> d"))
      .toThrow(/E_DUPLICATE_PIPELINE/);
  });
});

describe("bind — bus projection", () => {
  it("creates one edge per producer into shared", () => {
    const model = run("bus power: [a, b, c] -> shared");
    expect(model.edges).toHaveLength(3);
    expect(model.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "a->shared",
      "b->shared",
      "c->shared",
    ]);
    for (const e of model.edges) {
      expect(e.source).toBe("bus");
      expect(e.sourceName).toBe("power");
    }
  });

  it("retains the bus as a placement constraint", () => {
    const model = run("bus power: [a, b] -> s");
    expect(model.buses).toHaveLength(1);
    expect(model.buses[0]!.producers).toEqual(["a", "b"]);
    expect(model.buses[0]!.shared).toBe("s");
  });

  it("rejects duplicate bus names", () => {
    expect(() => run("bus p: [a, b] -> s\nbus p: [c, d] -> t"))
      .toThrow(/E_DUPLICATE_BUS/);
  });
});

describe("bind — fan-out projection", () => {
  it("creates one edge from shared to each consumer", () => {
    const model = run("fan-out broadcast: shared -> [a, b, c]");
    expect(model.edges).toHaveLength(3);
    expect(model.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "shared->a",
      "shared->b",
      "shared->c",
    ]);
    for (const e of model.edges) {
      expect(e.source).toBe("fan-out");
      expect(e.sourceName).toBe("broadcast");
    }
  });

  it("retains the fan-out as a placement constraint", () => {
    const model = run("fan-out f: s -> [a, b]");
    expect(model.fanOuts).toHaveLength(1);
    expect(model.fanOuts[0]!.shared).toBe("s");
    expect(model.fanOuts[0]!.consumers).toEqual(["a", "b"]);
  });

  it("rejects duplicate fan-out names", () => {
    expect(() => run("fan-out f: s -> [a, b]\nfan-out f: s -> [c, d]"))
      .toThrow(/E_DUPLICATE_FAN_OUT/);
  });
});

describe("bind — branch projection", () => {
  it("creates exactly one edge spine -> member, source = 'branch'", () => {
    const model = run("branch enrich-step: spine -> enrich");
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({
      from: "spine",
      to: "enrich",
      source: "branch",
      sourceName: "enrich-step",
    });
  });

  it("retains the branch as a placement constraint with side", () => {
    const model = run("branch under:right: middle -> below");
    expect(model.branches).toHaveLength(1);
    expect(model.branches[0]!.side).toBe("right");
    expect(model.branches[0]!.spine).toBe("middle");
    expect(model.branches[0]!.member).toBe("below");
  });

  it("rejects duplicate branch names", () => {
    expect(() => run("branch b: s -> a\nbranch b: s -> c"))
      .toThrow(/E_DUPLICATE_BRANCH/);
  });
});

describe("bind — back-edge projection", () => {
  it("tags `>-` back-edges as source 'back-edge'", () => {
    const model = run("sink >- source");
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({
      from: "sink",
      to: "source",
      source: "back-edge",
      isBackEdge: true,
    });
  });

  it("supports multiple `>-` edges in one source", () => {
    const model = run("a >- b\nc >- d");
    expect(model.edges).toHaveLength(2);
    expect(model.edges.every((e) => e.isBackEdge && e.source === "back-edge"))
      .toBe(true);
  });
});

describe("bind — nodeset projection", () => {
  it("retains the nodeset annotation", () => {
    const model = run("a\nb\nc\nnodeset data: a, b, c");
    expect(model.nodesets).toHaveLength(1);
    expect(model.nodesets[0]!.members).toEqual(["a", "b", "c"]);
  });

  it("does not create any edges", () => {
    const model = run("a\nb\nnodeset s: a, b");
    expect(model.edges).toHaveLength(0);
  });

  it("rejects a nodeset referencing an undeclared node", () => {
    expect(() => run("a\nb\nnodeset s: a, b, missing"))
      .toThrow(/E_NODESET_UNKNOWN_NODE/);
  });

  it("rejects duplicate nodeset names", () => {
    expect(() => run("a\nb\nnodeset s: a, b\nnodeset s: a"))
      .toThrow(/E_DUPLICATE_NODESET/);
  });
});

describe("bind — path projection", () => {
  it("retains the path annotation when every link has a real edge", () => {
    const model = run("a -> b\nb -> c\npath p: a -> b -> c");
    expect(model.paths).toHaveLength(1);
    expect(model.paths[0]!.chain).toEqual(["a", "b", "c"]);
  });

  it("resolves against pipeline-implied edges", () => {
    const model = run("pipeline pi: a -> b -> c\npath p: a -> b -> c");
    expect(model.paths).toHaveLength(1);
  });

  it("resolves against back-edges (same direction match)", () => {
    const model = run("a -> b\nb >- c\npath p: a -> b");
    expect(model.paths).toHaveLength(1);
  });

  it("rejects a path link with no matching edge", () => {
    expect(() => run("a -> b\npath p: a -> b -> c"))
      .toThrow(/E_PATH_MISSING_EDGE/);
  });

  it("rejects duplicate path names", () => {
    expect(() => run("a -> b\npath p: a -> b\npath p: a -> b"))
      .toThrow(/E_DUPLICATE_PATH/);
  });
});

describe("parser — import directive (Phase 5 modules)", () => {
  it("parses a bare `import` directive", () => {
    const prog = ast('import "./payments.melk" as payments');
    expect(prog.statements).toHaveLength(1);
    const stmt = prog.statements[0]!;
    expect(stmt.kind).toBe("import");
    if (stmt.kind !== "import") throw new Error("unreachable");
    expect(stmt.path).toBe("./payments.melk");
    expect(stmt.alias).toBe("payments");
    expect(stmt.overrides).toEqual([]);
  });

  it("parses an import with theme override (ident)", () => {
    const prog = ast('import "./auth.melk" as auth { theme: dark }');
    const stmt = prog.statements[0]!;
    if (stmt.kind !== "import") throw new Error("expected import");
    expect(stmt.alias).toBe("auth");
    expect(stmt.overrides).toHaveLength(1);
    expect(stmt.overrides[0]!.kind).toBe("ident");
    expect(stmt.overrides[0]!.key).toBe("theme");
    expect(stmt.overrides[0]!.value).toBe("dark");
  });

  it("parses an import with multiple overrides", () => {
    const prog = ast('import "./ingest.melk" as ingest { theme: light, layout: tb }');
    const stmt = prog.statements[0]!;
    if (stmt.kind !== "import") throw new Error("expected import");
    expect(stmt.overrides).toHaveLength(2);
    expect(stmt.overrides.map((o) => [o.key, o.value])).toEqual([
      ["theme", "light"],
      ["layout", "tb"],
    ]);
  });

  it("parses an import with a quoted-string override value", () => {
    const prog = ast('import "./x.melk" as x { theme: "./themes/acme.json" }');
    const stmt = prog.statements[0]!;
    if (stmt.kind !== "import") throw new Error("expected import");
    expect(stmt.overrides).toHaveLength(1);
    expect(stmt.overrides[0]!.kind).toBe("string");
    expect(stmt.overrides[0]!.value).toBe("./themes/acme.json");
  });

  it("parses an import with overrides on separate lines", () => {
    const prog = ast(
      [
        'import "./payments.melk" as payments {',
        "  theme: dark",
        "  layout: tb",
        "}",
      ].join("\n"),
    );
    const stmt = prog.statements[0]!;
    if (stmt.kind !== "import") throw new Error("expected import");
    expect(stmt.overrides).toHaveLength(2);
  });

  it("rejects an `import` without `as`", () => {
    expect(() => ast('import "./x.melk" payments'))
      .toThrow(/expects `as`/);
  });

  it("rejects an empty import path", () => {
    expect(() => ast('import "" as foo'))
      .toThrow(/E_MODULE_PATH_EMPTY/);
  });

  it("rejects an override value that isn't ident or string", () => {
    expect(() => ast('import "./x.melk" as foo { layout: 3 }'))
      .toThrow(/import override value must be/);
  });
});

describe("parser — qualified node refs (Phase 5 modules)", () => {
  it("parses `mod.foo -> bar` with module qualifier on the source", () => {
    const prog = ast('import "./m.melk" as m\nm.foo -> bar');
    const edge = prog.statements[1]!;
    if (edge.kind !== "edge") throw new Error("expected edge");
    expect(edge.from.module).toBe("m");
    expect(edge.from.node).toBe("foo");
    expect(edge.to.module).toBeUndefined();
    expect(edge.to.node).toBe("bar");
  });

  it("parses `bar -> mod.foo` with module qualifier on the target", () => {
    const prog = ast('import "./m.melk" as m\nbar -> m.foo');
    const edge = prog.statements[1]!;
    if (edge.kind !== "edge") throw new Error("expected edge");
    expect(edge.from.module).toBeUndefined();
    expect(edge.from.node).toBe("bar");
    expect(edge.to.module).toBe("m");
    expect(edge.to.node).toBe("foo");
  });

  it("parses qualifiers on both sides (`a.x -> b.y`)", () => {
    const prog = ast('import "./a.melk" as a\nimport "./b.melk" as b\na.x -> b.y');
    const edge = prog.statements[2]!;
    if (edge.kind !== "edge") throw new Error("expected edge");
    expect(edge.from.module).toBe("a");
    expect(edge.from.node).toBe("x");
    expect(edge.to.module).toBe("b");
    expect(edge.to.node).toBe("y");
  });

  it("plain (unqualified) refs have undefined module", () => {
    const prog = ast("a -> b");
    const edge = prog.statements[0]!;
    if (edge.kind !== "edge") throw new Error("expected edge");
    expect(edge.from.module).toBeUndefined();
    expect(edge.to.module).toBeUndefined();
  });
});

describe("bind — deprecation errors", () => {
  it("rejects deprecated `lane` blocks", () => {
    expect(() => run('lane "data": horizontal { a, b }'))
      .toThrow(/E_DEPRECATED_LANE/);
  });

  it("rejects deprecated `group` blocks", () => {
    expect(() => run("group g { a -> b }"))
      .toThrow(/E_DEPRECATED_GROUP/);
  });

  it("rejects deprecated `tag` declarations", () => {
    expect(() => run("tag dataPlane: a, b, c"))
      .toThrow(/E_DEPRECATED_TAG/);
  });
});
