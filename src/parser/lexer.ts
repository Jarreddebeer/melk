import type { SourcePos, SourceSpan } from "./ast.js";

export type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "cells"
  | "arrow"
  | "back-arrow"
  | "colon"
  | "comma"
  | "dot"
  | "lbrace"
  | "rbrace"
  | "lbracket"
  | "rbracket"
  | "newline"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  span: SourceSpan;
}

export class LexError extends Error {
  constructor(message: string, public pos: SourcePos) {
    super(`${message} at line ${pos.line}, col ${pos.col}`);
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let col = 1;

  const here = (): SourcePos => ({ line, col, offset });

  const advance = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      const ch = source[offset];
      if (ch === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      offset++;
    }
  };

  const peek = (n = 0): string | undefined => source[offset + n];

  const span = (start: SourcePos): SourceSpan => ({ start, end: here() });

  while (offset < source.length) {
    const ch = peek();

    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }

    if (ch === "\n") {
      const start = here();
      advance();
      const last = tokens[tokens.length - 1];
      if (last && last.kind !== "newline") {
        tokens.push({ kind: "newline", value: "\n", span: span(start) });
      }
      continue;
    }

    if (ch === "#") {
      while (offset < source.length && peek() !== "\n") advance();
      continue;
    }

    if (ch === "-" && peek(1) === ">") {
      const start = here();
      advance(2);
      tokens.push({ kind: "arrow", value: "->", span: span(start) });
      continue;
    }

    if (ch === ">" && peek(1) === "-") {
      const start = here();
      advance(2);
      tokens.push({ kind: "back-arrow", value: ">-", span: span(start) });
      continue;
    }

    if (ch === "[") {
      const start = here();
      advance();
      tokens.push({ kind: "lbracket", value: "[", span: span(start) });
      continue;
    }

    if (ch === "]") {
      const start = here();
      advance();
      tokens.push({ kind: "rbracket", value: "]", span: span(start) });
      continue;
    }

    if (ch === ":") {
      const start = here();
      advance();
      tokens.push({ kind: "colon", value: ":", span: span(start) });
      continue;
    }

    if (ch === ",") {
      const start = here();
      advance();
      tokens.push({ kind: "comma", value: ",", span: span(start) });
      continue;
    }

    if (ch === ".") {
      const start = here();
      advance();
      tokens.push({ kind: "dot", value: ".", span: span(start) });
      continue;
    }

    if (ch === "{") {
      const start = here();
      advance();
      tokens.push({ kind: "lbrace", value: "{", span: span(start) });
      continue;
    }

    if (ch === "}") {
      const start = here();
      advance();
      tokens.push({ kind: "rbrace", value: "}", span: span(start) });
      continue;
    }

    if (ch === '"') {
      const start = here();
      advance();
      let value = "";
      while (offset < source.length && peek() !== '"') {
        const c = peek();
        if (c === "\\") {
          advance();
          const esc = peek();
          if (esc === "n") value += "\n";
          else if (esc === "t") value += "\t";
          else if (esc === '"') value += '"';
          else if (esc === "\\") value += "\\";
          else throw new LexError(`unknown escape \\${esc}`, here());
          advance();
        } else if (c === "\n") {
          throw new LexError("unterminated string", here());
        } else {
          value += c;
          advance();
        }
      }
      if (offset >= source.length) throw new LexError("unterminated string", here());
      advance();
      tokens.push({ kind: "string", value, span: span(start) });
      continue;
    }

    if (ch !== undefined && /[0-9]/.test(ch)) {
      const start = here();
      let raw = "";
      while (offset < source.length) {
        const c = peek();
        if (c !== undefined && /[0-9]/.test(c)) {
          raw += c;
          advance();
        } else break;
      }
      // Cell-size syntax: <digits>x<digits>, e.g. "2x1". Recognise as a
      // single `cells` token. Note that "x" appearing after digits is
      // ALWAYS the cells syntax — `<digits>` followed by anything else is
      // just `number`. Identifiers cannot start with a digit so there's
      // no ambiguity with a node id like `1x1`.
      if (peek() === "x" && peek(1) !== undefined && /[0-9]/.test(peek(1)!)) {
        advance(); // consume 'x'
        let hPart = "";
        while (offset < source.length) {
          const c = peek();
          if (c !== undefined && /[0-9]/.test(c)) {
            hPart += c;
            advance();
          } else break;
        }
        tokens.push({
          kind: "cells",
          value: `${raw}x${hPart}`,
          span: span(start),
        });
        continue;
      }
      // Allow decimal numbers (e.g. font sizes). Decimal must not be
      // adjacent to 'x' because `2.5x1` is nonsense — cells are integer.
      while (offset < source.length) {
        const c = peek();
        if (c === "." && peek(1) !== undefined && /[0-9]/.test(peek(1)!)) {
          raw += c;
          advance();
          while (offset < source.length) {
            const c2 = peek();
            if (c2 !== undefined && /[0-9]/.test(c2)) {
              raw += c2;
              advance();
            } else break;
          }
          break;
        } else break;
      }
      tokens.push({ kind: "number", value: raw, span: span(start) });
      continue;
    }

    if (ch !== undefined && /[a-zA-Z_]/.test(ch)) {
      const start = here();
      let raw = "";
      while (offset < source.length) {
        const c = peek();
        if (c !== undefined && /[a-zA-Z0-9_-]/.test(c)) {
          raw += c;
          advance();
        } else break;
      }
      tokens.push({ kind: "ident", value: raw, span: span(start) });
      continue;
    }

    throw new LexError(`unexpected character '${ch}'`, here());
  }

  tokens.push({ kind: "eof", value: "", span: span(here()) });
  return tokens;
}
