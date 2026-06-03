/**
 * Phase 4 parser.
 *
 * Recursive-descent over the lexer's token stream. Produces a Program
 * (sequence of Statements) per DESIGN-PHASE4.md §6. Each statement is
 * one of:
 *
 *   - node declaration:           `foo { shape: rect, size: 2x1 }`
 *   - forward edge:               `a -> b { label: "x" }`
 *   - back-edge (inline):         `a >- b`
 *   - back-edge block:            `back: a -> b`
 *   - layout directive:           `layout: lr`
 *   - crossings directive:        `crossings: 0`
 *   - pipeline:                   `pipeline name: a -> b -> c`
 *   - bus:                        `bus name: [a, b, c] -> shared`
 *   - fan-out:                    `fan-out name: shared -> [a, b, c]`
 *   - nodeset (annotation):       `nodeset name: a, b, c`
 *   - path    (annotation):       `path name: a -> b -> c`
 *   - deprecated lane:            `lane "name": ...`  (binder rejects)
 *   - deprecated group:           `group name { ... }` (binder rejects)
 *   - deprecated tag:             `tag name: ...`     (binder rejects)
 */
import type {
  AvoidRef,
  BackBlockDecl,
  BackEdgeDecl,
  BranchDecl,
  BranchSide,
  BusDecl,
  CrossingsDirective,
  DeprecatedGroupDecl,
  DeprecatedLaneDecl,
  DeprecatedTagDecl,
  EdgeDecl,
  EdgesetDecl,
  FanOutDecl,
  LayoutDecl,
  LayoutMode,
  NodeDecl,
  NodeRef,
  NodesetDecl,
  PathDecl,
  PipelineDecl,
  Program,
  Property,
  PropertyValue,
  SourceSpan,
  Statement,
  ViaRef,
} from "./ast.js";
import type { Token, TokenKind } from "./lexer.js";

export class ParseError extends Error {
  constructor(message: string, public span: SourceSpan) {
    super(`${message} at line ${span.start.line}, col ${span.start.col}`);
  }
}

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  parse(): Program {
    const statements: Statement[] = [];
    this.skipNewlines();
    while (!this.isAtEnd()) {
      statements.push(this.statement());
      this.skipNewlines();
    }
    return { statements };
  }

  private statement(): Statement {
    const tok = this.peek();

    if (tok.kind === "ident") {
      const next = this.peekAhead(1);
      // Keyword: `layout: <mode>`
      if (tok.value === "layout" && next.kind === "colon") {
        return this.layoutDecl();
      }
      // Keyword: `crossings: <n>`
      if (tok.value === "crossings" && next.kind === "colon") {
        return this.crossingsDirective();
      }
      // Keyword: `pipeline <name>: ...`
      if (tok.value === "pipeline" && next.kind === "ident") {
        return this.pipelineDecl();
      }
      // Keyword: `bus <name>: ...`
      if (tok.value === "bus" && next.kind === "ident") {
        return this.busDecl();
      }
      // Keyword: `fan-out <name>: ...`
      if (tok.value === "fan-out" && next.kind === "ident") {
        return this.fanOutDecl();
      }
      // Keyword: `branch <name>[:side]: spine -> member | [m1, m2, ...]`
      if (tok.value === "branch" && next.kind === "ident") {
        return this.branchDecl();
      }
      // Keyword: `back: ...`
      if (tok.value === "back" && next.kind === "colon") {
        return this.backBlockDecl();
      }
      // Keyword: `nodeset <name>: a, b, c`
      if (tok.value === "nodeset" && next.kind === "ident") {
        return this.nodesetDecl();
      }
      // Keyword: `path <name>: a -> b -> c`
      if (tok.value === "path" && next.kind === "ident") {
        return this.pathDecl();
      }
      // Keyword: `edgeset <name>: a -> b, c -> d, ...`
      if (tok.value === "edgeset" && next.kind === "ident") {
        return this.edgesetDecl();
      }
      // Keyword: `intersect hwy_a, hwy_b` — §11.11 highway co-placement.
      if (tok.value === "intersect" && next.kind === "ident") {
        return this.intersectDecl();
      }
      // Deprecated: `tag <name>: ...` — split into nodeset/path in Phase 4.
      if (tok.value === "tag" && next.kind === "ident") {
        return this.deprecatedTagDecl();
      }
      // Deprecated: `lane "name": ...` — preserved for migration warnings.
      if (tok.value === "lane" && next.kind === "string") {
        return this.deprecatedLaneDecl();
      }
      // Deprecated: `group <name> { ... }`.
      if (
        tok.value === "group" &&
        next.kind === "ident" &&
        this.peekAhead(2).kind === "lbrace"
      ) {
        return this.deprecatedGroupDecl();
      }
    }

    return this.nodeOrEdge();
  }

  // --- directives -----------------------------------------------------

  private layoutDecl(): LayoutDecl {
    const start = this.expect("ident");
    this.expect("colon");
    const modeTok = this.expect("ident");
    if (modeTok.value !== "tb" && modeTok.value !== "lr") {
      throw new ParseError(
        `layout mode must be 'tb' or 'lr', got '${modeTok.value}'`,
        modeTok.span,
      );
    }
    return {
      kind: "layout",
      mode: modeTok.value as LayoutMode,
      span: { start: start.span.start, end: modeTok.span.end },
    };
  }

  private crossingsDirective(): CrossingsDirective {
    const start = this.expect("ident");
    this.expect("colon");
    const numTok = this.expect("number");
    const n = Number(numTok.value);
    if (!Number.isInteger(n) || n < 0) {
      throw new ParseError(
        `crossings budget must be a non-negative integer, got '${numTok.value}'`,
        numTok.span,
      );
    }
    return {
      kind: "crossings",
      budget: n,
      span: { start: start.span.start, end: numTok.span.end },
    };
  }

  // --- structured flow ------------------------------------------------

  private pipelineDecl(): PipelineDecl {
    const start = this.expect("ident"); // 'pipeline'
    const nameTok = this.expect("ident");
    this.expect("colon");
    const members = this.identChainWithArrows("pipeline");
    return {
      kind: "pipeline",
      name: nameTok.value,
      members,
      span: {
        start: start.span.start,
        end: this.peekAhead(-1).span.end,
      },
    };
  }

  private busDecl(): BusDecl {
    const start = this.expect("ident"); // 'bus'
    const nameTok = this.expect("ident");
    this.expect("colon");
    this.expect("lbracket");
    const producers = this.identCommaList();
    this.expect("rbracket");
    if (producers.length < 2) {
      throw new ParseError(
        "bus requires at least two producers (use `bus name: [a, b, ...] -> shared`)",
        start.span,
      );
    }
    this.expect("arrow");
    const sharedTok = this.expect("ident");
    return {
      kind: "bus",
      name: nameTok.value,
      producers,
      shared: sharedTok.value,
      span: { start: start.span.start, end: sharedTok.span.end },
    };
  }

  private fanOutDecl(): FanOutDecl {
    const start = this.expect("ident"); // 'fan-out'
    const nameTok = this.expect("ident");
    this.expect("colon");
    const sharedTok = this.expect("ident");
    this.expect("arrow");
    this.expect("lbracket");
    const consumers = this.identCommaList();
    const end = this.expect("rbracket");
    if (consumers.length < 2) {
      throw new ParseError(
        "fan-out requires at least two consumers (use `fan-out name: shared -> [a, b, ...]`)",
        start.span,
      );
    }
    return {
      kind: "fan-out",
      name: nameTok.value,
      shared: sharedTok.value,
      consumers,
      span: { start: start.span.start, end: end.span.end },
    };
  }

  private branchDecl(): BranchDecl {
    // Forms (DESIGN §6.4):
    //   branch <name>:         spine -> member
    //   branch <name>:<side>:  spine -> member
    //
    // The bracketed multi-member form was dropped during the isometric
    // refactor — a branch is a single-member direction change. For a
    // chain, fan, or further turn off the branched member, the user
    // composes with `pipeline`, `fan-out`, `bus`, or another `branch`
    // rooted on the member (DESIGN §11.6).
    const start = this.expect("ident"); // 'branch'
    const nameTok = this.expect("ident");
    this.expect("colon");

    // Optional `:side:` suffix. We're past the first colon now; if the
    // next tokens are `<ident> <colon>` AND the ident is `left` or
    // `right`, treat it as the side. Otherwise the ident is the spine.
    let side: BranchSide | undefined;
    const maybeSide = this.peek();
    const afterMaybeSide = this.peekAhead(1);
    if (
      maybeSide.kind === "ident" &&
      afterMaybeSide.kind === "colon" &&
      (maybeSide.value === "left" || maybeSide.value === "right")
    ) {
      side = maybeSide.value as BranchSide;
      this.advance(); // side ident
      this.advance(); // colon
    }

    const spineTok = this.expect("ident");
    this.expect("arrow");
    if (this.peek().kind === "lbracket") {
      throw new ParseError(
        "branch takes a single member (no brackets). For a chain off the branched node use `pipeline` rooted on it; for a fan use `fan-out`. See DESIGN-PHASE4.md §6.4.",
        this.peek().span,
      );
    }
    const memberTok = this.expect("ident");

    return {
      kind: "branch",
      name: nameTok.value,
      ...(side !== undefined ? { side } : {}),
      spine: spineTok.value,
      member: memberTok.value,
      span: { start: start.span.start, end: memberTok.span.end },
    };
  }

  // --- back-edges -----------------------------------------------------

  private backBlockDecl(): BackBlockDecl {
    // Two forms inside `back:`:
    //   single-line:  back: a -> b
    //   block:        back: { a -> b; c -> d }
    const start = this.expect("ident"); // 'back'
    this.expect("colon");
    const edges: { from: NodeRef; to: NodeRef; span: SourceSpan }[] = [];

    if (this.peek().kind === "lbrace") {
      this.advance();
      this.skipNewlines();
      while (this.peek().kind !== "rbrace" && !this.isAtEnd()) {
        const from = this.nodeRef();
        this.expect("arrow");
        const to = this.nodeRef();
        edges.push({
          from,
          to,
          span: { start: from.span.start, end: to.span.end },
        });
        this.skipSeparators();
      }
      const end = this.expect("rbrace");
      return {
        kind: "back-block",
        edges,
        span: { start: start.span.start, end: end.span.end },
      };
    }

    const from = this.nodeRef();
    this.expect("arrow");
    const to = this.nodeRef();
    edges.push({
      from,
      to,
      span: { start: from.span.start, end: to.span.end },
    });
    return {
      kind: "back-block",
      edges,
      span: { start: start.span.start, end: to.span.end },
    };
  }

  // --- annotations ----------------------------------------------------

  private intersectDecl(): import("./ast.js").IntersectDecl {
    const start = this.expect("ident"); // 'intersect'
    const first = this.expect("ident");
    const highways: { name: string; span: SourceSpan }[] = [
      { name: first.value, span: first.span },
    ];
    while (this.peek().kind === "comma") {
      this.advance();
      const next = this.expect("ident");
      highways.push({ name: next.value, span: next.span });
    }
    return {
      kind: "intersect",
      highways,
      span: { start: start.span.start, end: this.peekAhead(-1).span.end },
    };
  }

  private nodesetDecl(): NodesetDecl {
    const start = this.expect("ident"); // 'nodeset'
    const nameTok = this.expect("ident");
    this.expect("colon");
    const members = this.identCommaList();
    return {
      kind: "nodeset",
      name: nameTok.value,
      members,
      span: { start: start.span.start, end: this.peekAhead(-1).span.end },
    };
  }

  private pathDecl(): PathDecl {
    const start = this.expect("ident"); // 'path'
    const nameTok = this.expect("ident");
    this.expect("colon");
    const chain = this.identChainWithArrows("path");
    return {
      kind: "path",
      name: nameTok.value,
      chain,
      span: { start: start.span.start, end: this.peekAhead(-1).span.end },
    };
  }

  private edgesetDecl(): EdgesetDecl {
    const start = this.expect("ident"); // 'edgeset'
    const nameTok = this.expect("ident");
    this.expect("colon");
    // Comma-separated edge references: `a -> b, c -> d, ...`
    const edges: { from: string; to: string; span: SourceSpan }[] = [];
    const firstFrom = this.expect("ident");
    this.expect("arrow");
    const firstTo = this.expect("ident");
    edges.push({
      from: firstFrom.value,
      to: firstTo.value,
      span: { start: firstFrom.span.start, end: firstTo.span.end },
    });
    while (this.peek().kind === "comma") {
      this.advance();
      const from = this.expect("ident");
      this.expect("arrow");
      const to = this.expect("ident");
      edges.push({
        from: from.value,
        to: to.value,
        span: { start: from.span.start, end: to.span.end },
      });
    }
    return {
      kind: "edgeset",
      name: nameTok.value,
      edges,
      span: { start: start.span.start, end: this.peekAhead(-1).span.end },
    };
  }

  // --- deprecated -----------------------------------------------------

  private deprecatedTagDecl(): DeprecatedTagDecl {
    const start = this.expect("ident"); // 'tag'
    this.expect("ident"); // name
    this.expect("colon");
    // Consume the body greedily — comma list or arrow chain. We don't
    // need the contents; the bind step rejects the statement.
    this.expect("ident");
    let end = this.peekAhead(-1).span;
    while (
      this.peek().kind === "comma" ||
      this.peek().kind === "arrow"
    ) {
      this.advance();
      end = this.expect("ident").span;
    }
    return {
      kind: "deprecated-tag",
      span: { start: start.span.start, end: end.end },
    };
  }


  private deprecatedLaneDecl(): DeprecatedLaneDecl {
    const start = this.expect("ident"); // 'lane'
    // Consume the rest of the line crudely — we don't care about the
    // contents; the bind step rejects the statement with a deprecation
    // error pointing at the source.
    this.expect("string"); // name
    this.expect("colon");
    this.expect("ident"); // orientation
    this.expect("lbrace");
    let end = this.peek().span;
    while (this.peek().kind !== "rbrace" && !this.isAtEnd()) {
      end = this.advance().span;
    }
    end = this.expect("rbrace").span;
    return {
      kind: "deprecated-lane",
      span: { start: start.span.start, end: end.end },
    };
  }

  private deprecatedGroupDecl(): DeprecatedGroupDecl {
    const start = this.expect("ident"); // 'group'
    this.expect("ident"); // name
    this.expect("lbrace");
    let depth = 1;
    let end = start.span;
    while (depth > 0 && !this.isAtEnd()) {
      const t = this.peek();
      if (t.kind === "lbrace") depth++;
      if (t.kind === "rbrace") depth--;
      end = this.advance().span;
    }
    return {
      kind: "deprecated-group",
      span: { start: start.span.start, end: end.end },
    };
  }

  // --- nodes and edges -----------------------------------------------

  private nodeOrEdge(): NodeDecl | EdgeDecl | BackEdgeDecl {
    const from = this.nodeRef();

    if (this.peek().kind === "arrow") {
      this.advance();
      const to = this.nodeRef();
      const properties = this.optionalPropertyBlock();
      const end = properties.length > 0
        ? properties[properties.length - 1]!.span.end
        : to.span.end;
      return {
        kind: "edge",
        from,
        to,
        properties,
        span: { start: from.span.start, end },
      };
    }

    if (this.peek().kind === "back-arrow") {
      this.advance();
      const to = this.nodeRef();
      const properties = this.optionalPropertyBlock();
      const end = properties.length > 0
        ? properties[properties.length - 1]!.span.end
        : to.span.end;
      return {
        kind: "back-edge",
        from,
        to,
        properties,
        span: { start: from.span.start, end },
      };
    }

    if (from.port !== undefined) {
      throw new ParseError("node declaration cannot have a port", from.span);
    }

    const properties = this.optionalPropertyBlock();
    const end = properties.length > 0
      ? properties[properties.length - 1]!.span.end
      : from.span.end;
    return {
      kind: "node",
      name: from.node,
      properties,
      span: { start: from.span.start, end },
    };
  }

  private nodeRef(): NodeRef {
    const name = this.expect("ident");
    let node = name.value;
    let port: string | undefined;
    let endSpan = name.span;

    if (this.peek().kind === "dot" && this.peekAhead(1).kind === "ident") {
      this.advance();
      const portTok = this.expect("ident");
      node = `${name.value}.${portTok.value}`;
      endSpan = portTok.span;
    }

    if (this.peek().kind === "colon" && this.peekAhead(1).kind === "ident") {
      this.advance();
      const portTok = this.expect("ident");
      port = portTok.value;
      endSpan = portTok.span;
    }
    const ref: NodeRef = {
      node,
      span: { start: name.span.start, end: endSpan.end },
    };
    if (port !== undefined) ref.port = port;
    return ref;
  }

  // --- property blocks -----------------------------------------------

  private optionalPropertyBlock(): Property[] {
    if (this.peek().kind !== "lbrace") return [];
    this.advance();
    const props: Property[] = [];
    this.skipNewlines();
    while (this.peek().kind !== "rbrace" && !this.isAtEnd()) {
      props.push(this.property());
      this.skipSeparators();
    }
    this.expect("rbrace");
    return props;
  }

  private property(): Property {
    const key = this.expect("ident");
    this.expect("colon");
    // `avoid:` and `via:` accept richer value shapes than the other keys —
    // bare ident or bracketed list (plus edge refs for avoid). Special-
    // cased here because the rest of the keys (label, pivot, shape, size)
    // take a simple PropertyValue.
    let value: PropertyValue;
    if (key.value === "avoid") {
      value = this.avoidValue(key.span);
    } else if (key.value === "via") {
      value = this.viaValue(key.span);
    } else {
      value = this.propertyValue();
    }
    return {
      key: key.value,
      value,
      span: { start: key.span.start, end: value.span.end },
    };
  }

  private propertyValue(): PropertyValue {
    const tok = this.peek();
    if (tok.kind === "string") {
      this.advance();
      return { kind: "string", value: tok.value, span: tok.span };
    }
    if (tok.kind === "number") {
      this.advance();
      return { kind: "number", value: Number(tok.value), span: tok.span };
    }
    if (tok.kind === "cells") {
      this.advance();
      const [w, h] = tok.value.split("x").map((s) => Number(s));
      return { kind: "cells", width: w!, height: h!, span: tok.span };
    }
    if (tok.kind === "ident") {
      this.advance();
      return { kind: "ident", value: tok.value, span: tok.span };
    }
    throw new ParseError(`expected value, got ${tok.kind}`, tok.span);
  }

  /**
   * Parse the value of an `avoid:` brace-attr (DESIGN-PHASE4.md §11.8).
   * Three surface forms:
   *
   *   avoid: <ident>                # single name (primitive/edgeset/node)
   *   avoid: <ident> -> <ident>     # single edge reference
   *   avoid: [ <item>, <item>, ... ] # bracketed list of items
   *
   * Items inside the bracketed list are either bare idents or edge refs.
   * The list form normalises to an `avoid-list` PropertyValue; the
   * single-value forms also normalise to a 1-element `avoid-list` so
   * downstream code only sees one shape.
   */
  private avoidValue(keySpan: SourceSpan): PropertyValue {
    if (this.peek().kind === "lbracket") {
      this.advance();
      const items: AvoidRef[] = [];
      items.push(this.avoidItem());
      while (this.peek().kind === "comma") {
        this.advance();
        items.push(this.avoidItem());
      }
      const end = this.expect("rbracket");
      return {
        kind: "avoid-list",
        items,
        span: { start: keySpan.start, end: end.span.end },
      };
    }
    const item = this.avoidItem();
    return {
      kind: "avoid-list",
      items: [item],
      span: { start: keySpan.start, end: item.span.end },
    };
  }

  private avoidItem(): AvoidRef {
    const first = this.expect("ident");
    if (this.peek().kind === "arrow") {
      this.advance();
      const to = this.expect("ident");
      return {
        kind: "edge",
        from: first.value,
        to: to.value,
        span: { start: first.span.start, end: to.span.end },
      };
    }
    return {
      kind: "name",
      name: first.value,
      span: first.span,
    };
  }

  /**
   * Parse the value of a `via:` brace-attr (DESIGN-PHASE4.md §11.9). Two
   * surface forms — a single name or a bracketed list:
   *
   *   via: <ident>
   *   via: [ <ident>, <ident>, ... ]
   *
   * Each value must resolve to a node declared as `shape: highway`
   * (validated at bind time). Edge refs are NOT accepted here — a
   * highway is a node, not an edge.
   */
  private viaValue(keySpan: SourceSpan): PropertyValue {
    if (this.peek().kind === "lbracket") {
      this.advance();
      const items: ViaRef[] = [];
      const first = this.expect("ident");
      items.push({ name: first.value, span: first.span });
      while (this.peek().kind === "comma") {
        this.advance();
        const next = this.expect("ident");
        items.push({ name: next.value, span: next.span });
      }
      const end = this.expect("rbracket");
      return {
        kind: "via-list",
        items,
        span: { start: keySpan.start, end: end.span.end },
      };
    }
    const only = this.expect("ident");
    return {
      kind: "via-list",
      items: [{ name: only.value, span: only.span }],
      span: { start: keySpan.start, end: only.span.end },
    };
  }

  // --- helpers --------------------------------------------------------

  /**
   * Parse a chain of identifiers separated by arrows: `a -> b -> c`.
   * Used by `pipeline:` declarations. Requires at least two members.
   */
  private identChainWithArrows(forContext: string): string[] {
    const first = this.expect("ident");
    const chain = [first.value];
    while (this.peek().kind === "arrow") {
      this.advance();
      const next = this.expect("ident");
      chain.push(next.value);
    }
    if (chain.length < 2) {
      throw new ParseError(
        `${forContext} requires at least two members joined by '->'`,
        first.span,
      );
    }
    return chain;
  }

  /**
   * Parse a comma-separated list of identifiers. Stops when the next
   * token isn't a comma. Returns the list (at least one element).
   */
  private identCommaList(): string[] {
    const first = this.expect("ident");
    const list = [first.value];
    while (this.peek().kind === "comma") {
      this.advance();
      const next = this.expect("ident");
      list.push(next.value);
    }
    return list;
  }

  private skipNewlines(): void {
    while (this.peek().kind === "newline") this.advance();
  }

  private skipSeparators(): void {
    while (
      this.peek().kind === "newline" ||
      this.peek().kind === "comma"
    ) {
      this.advance();
    }
  }

  private expect(kind: TokenKind): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new ParseError(
        `expected ${kind}, got ${tok.kind} ('${tok.value}')`,
        tok.span,
      );
    }
    this.advance();
    return tok;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private peekAhead(n: number): Token {
    const idx = this.pos + n;
    if (idx < 0) return this.tokens[0]!;
    return this.tokens[idx] ?? this.tokens[this.tokens.length - 1]!;
  }

  private advance(): Token {
    const t = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private isAtEnd(): boolean {
    return this.peek().kind === "eof";
  }
}

export function parse(tokens: Token[]): Program {
  return new Parser(tokens).parse();
}
