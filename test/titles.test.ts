/**
 * Phase 5 titles + captions tests.
 *
 * Covers:
 *   - parser-level: directive syntax, multiline/empty rejection
 *   - bind-level: Model.title / .subtitle / .caption population, last-wins
 *   - layout: header / footer strip dimensions and placement
 *   - rendering: end-to-end SVG emission with chrome strips
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import { loadTheme } from "../src/theme/theme.js";
import { place } from "../src/layout/place.js";
import { assignSlots } from "../src/layout/slots.js";
import { routeChannels } from "../src/layout/channels.js";
import { renderSVG } from "../src/render/svg.js";
import { buildHeader, buildFooter } from "../src/render/titles.js";

function model(src: string) {
  return bind(parse(tokenize(src)));
}

function render(src: string, themeName = "document-light"): string {
  const m = bind(parse(tokenize(src)));
  const p = place(m);
  const slots = assignSlots(m, p);
  const routing = routeChannels(m, p, slots);
  return renderSVG(m, p, routing, loadTheme(themeName));
}

describe("title:/subtitle:/caption: parser directives (DESIGN-PHASE5-TITLES §1)", () => {
  it("accepts a title with a quoted string value", () => {
    const m = model('title: "Hello"\na -> b');
    expect(m.title).toBe("Hello");
  });

  it("accepts all three directives independently", () => {
    const m = model(
      [
        'title: "T"',
        'subtitle: "S"',
        'caption: "C"',
        "a -> b",
      ].join("\n"),
    );
    expect(m.title).toBe("T");
    expect(m.subtitle).toBe("S");
    expect(m.caption).toBe("C");
  });

  it("rejects bare-ident value (title must be a quoted string)", () => {
    expect(() => parse(tokenize("title: hello\na -> b"))).toThrow(/quoted string/);
  });

  it("rejects empty string with E_TITLE_EMPTY", () => {
    expect(() => parse(tokenize('title: ""\na -> b'))).toThrow(/E_TITLE_EMPTY/);
  });

  it("rejects multiline string with E_TITLE_MULTILINE", () => {
    // \n in the source string literal escapes to a newline character
    // inside the string token (the lexer supports \n escape).
    expect(() => parse(tokenize('title: "line1\\nline2"\na -> b'))).toThrow(
      /E_TITLE_MULTILINE/,
    );
  });

  it("subtitle empty / multiline same rejection rules", () => {
    expect(() => parse(tokenize('subtitle: ""\na -> b'))).toThrow(/E_TITLE_EMPTY/);
    expect(() => parse(tokenize('subtitle: "a\\nb"\na -> b'))).toThrow(/E_TITLE_MULTILINE/);
  });

  it("caption empty / multiline same rejection rules", () => {
    expect(() => parse(tokenize('caption: ""\na -> b'))).toThrow(/E_TITLE_EMPTY/);
    expect(() => parse(tokenize('caption: "a\\nb"\na -> b'))).toThrow(/E_TITLE_MULTILINE/);
  });
});

describe("title bind semantics", () => {
  it("absence yields undefined fields", () => {
    const m = model("a -> b");
    expect(m.title).toBeUndefined();
    expect(m.subtitle).toBeUndefined();
    expect(m.caption).toBeUndefined();
  });

  it("multiple title directives: last wins", () => {
    const m = model('title: "A"\ntitle: "B"\na -> b');
    expect(m.title).toBe("B");
  });

  it("title + subtitle + caption all coexist", () => {
    const m = model('title: "T"\nsubtitle: "S"\ncaption: "C"\na -> b');
    expect(m.title).toBe("T");
    expect(m.subtitle).toBe("S");
    expect(m.caption).toBe("C");
  });

  it("subtitle without title is legal (DESIGN §4.2)", () => {
    const m = model('subtitle: "S"\na -> b');
    expect(m.title).toBeUndefined();
    expect(m.subtitle).toBe("S");
  });
});

describe("buildHeader / buildFooter layout", () => {
  const theme = loadTheme("document-light");

  it("returns undefined when no title or subtitle is set", () => {
    expect(buildHeader(model("a -> b"), theme)).toBeUndefined();
  });

  it("returns undefined when no caption is set", () => {
    expect(buildFooter(model("a -> b"), theme)).toBeUndefined();
  });

  it("title-only header has one row, marked as title kind", () => {
    const layout = buildHeader(model('title: "Hello"\na -> b'), theme)!;
    expect(layout.rows.length).toBe(1);
    expect(layout.rows[0]!.kind).toBe("title");
    expect(layout.rows[0]!.text).toBe("Hello");
  });

  it("subtitle-only header has one subtitle row (no leading gap consumed)", () => {
    const layout = buildHeader(model('subtitle: "Sub"\na -> b'), theme)!;
    expect(layout.rows.length).toBe(1);
    expect(layout.rows[0]!.kind).toBe("subtitle");
  });

  it("title + subtitle yields two rows with subtitle below title", () => {
    const layout = buildHeader(model('title: "T"\nsubtitle: "S"\na -> b'), theme)!;
    expect(layout.rows.length).toBe(2);
    const titleRow = layout.rows.find((r) => r.kind === "title")!;
    const subtitleRow = layout.rows.find((r) => r.kind === "subtitle")!;
    expect(subtitleRow.y).toBeGreaterThan(titleRow.y);
  });

  it("title uses theme title size + title weight + ink-primary fill", () => {
    const layout = buildHeader(model('title: "T"\na -> b'), theme)!;
    const row = layout.rows[0]!;
    expect(row.fontSize).toBe(theme.typography.size.title);
    expect(row.fontWeight).toBe(theme.typography.weight.title);
    expect(row.fill).toBe(theme.tokens["ink-primary"]);
  });

  it("subtitle uses theme subtitle size + subtitle weight + ink-secondary fill", () => {
    const layout = buildHeader(model('subtitle: "S"\na -> b'), theme)!;
    const row = layout.rows[0]!;
    expect(row.fontSize).toBe(theme.typography.size.subtitle);
    expect(row.fontWeight).toBe(theme.typography.weight.subtitle);
    expect(row.fill).toBe(theme.tokens["ink-secondary"]);
  });

  it("caption uses theme caption size + ink-secondary fill", () => {
    const layout = buildFooter(model('caption: "C"\na -> b'), theme)!;
    const row = layout.rows[0]!;
    expect(row.fontSize).toBe(theme.typography.size.caption);
    expect(row.fill).toBe(theme.tokens["ink-secondary"]);
  });

  it("header minWidth grows for longer titles", () => {
    const shortL = buildHeader(model('title: "Hi"\na -> b'), theme)!;
    const longL = buildHeader(
      model('title: "This is a much longer title that should widen the strip"\na -> b'),
      theme,
    )!;
    expect(longL.minWidth).toBeGreaterThan(shortL.minWidth);
  });

  it("header height grows when both title and subtitle present", () => {
    const titleOnly = buildHeader(model('title: "T"\na -> b'), theme)!;
    const both = buildHeader(model('title: "T"\nsubtitle: "S"\na -> b'), theme)!;
    expect(both.height).toBeGreaterThan(titleOnly.height);
  });
});

describe("end-to-end render with titles", () => {
  it("no title directives → no title-strip markup", () => {
    const out = render("pipeline p: a -> b -> c");
    expect(out).not.toContain('data-title-strip');
  });

  it("title only emits a header strip with title text", () => {
    const out = render('title: "Hello World"\npipeline p: a -> b');
    expect(out).toContain('data-title-strip="1"');
    expect(out).toContain('data-row="title"');
    expect(out).toContain("Hello World");
    expect(out).not.toContain('data-row="subtitle"');
  });

  it("title + subtitle emits both rows", () => {
    const out = render('title: "T"\nsubtitle: "S"\npipeline p: a -> b');
    expect(out).toContain('data-row="title"');
    expect(out).toContain('data-row="subtitle"');
  });

  it("caption only emits a footer strip with caption text", () => {
    const out = render('caption: "Source: foo"\npipeline p: a -> b');
    expect(out).toContain('data-title-strip="1"');
    expect(out).toContain('data-row="caption"');
    expect(out).toContain("Source: foo");
  });

  it("title + caption together emit two strips", () => {
    const out = render('title: "T"\ncaption: "C"\npipeline p: a -> b');
    const matches = out.match(/data-title-strip="1"/g) || [];
    expect(matches.length).toBe(2);
  });

  it("HTML-special chars in title are escaped", () => {
    const out = render('title: "A & B < C"\npipeline p: a -> b');
    expect(out).toContain("A &amp; B &lt; C");
    expect(out).not.toContain("A & B < C");
  });

  it("title + legend coexist; legend group sits below header", () => {
    const src = [
      'title: "T"',
      "legend: on",
      "a { tags: [future] }",
      "a -> b",
    ].join("\n");
    const out = render(src);
    expect(out).toContain('data-title-strip="1"');
    expect(out).toContain('data-legend="1"');
  });

  it("a long title widens the canvas to fit", () => {
    const shortSrc = 'title: "Hi"\npipeline p: a -> b';
    const longSrc =
      'title: "This is a very long title that is wider than the short version"\npipeline p: a -> b';
    const shortOut = render(shortSrc);
    const longOut = render(longSrc);
    // Extract the SVG width from the root element.
    const shortW = Number(shortOut.match(/<svg[^>]*width="(\d+(?:\.\d+)?)"/)![1]);
    const longW = Number(longOut.match(/<svg[^>]*width="(\d+(?:\.\d+)?)"/)![1]);
    expect(longW).toBeGreaterThan(shortW);
  });

  it("title uses theme.typography.size.title for font-size", () => {
    const out = render('title: "T"\npipeline p: a -> b');
    const theme = loadTheme("document-light");
    expect(out).toContain(`font-size="${theme.typography.size.title}"`);
  });

  it("schematic theme uses a smaller title (theme-defined)", () => {
    const doc = render('title: "T"\npipeline p: a -> b', "document-light");
    const sch = render('title: "T"\npipeline p: a -> b', "schematic-dark");
    const docSize = loadTheme("document-light").typography.size.title;
    const schSize = loadTheme("schematic-dark").typography.size.title;
    expect(doc).toContain(`font-size="${docSize}"`);
    expect(sch).toContain(`font-size="${schSize}"`);
    expect(schSize).toBeLessThan(docSize);
  });
});

describe("CLI --title / --subtitle / --caption override (smoke, mutating model directly)", () => {
  // Same pattern as the legend CLI tests — the flag-resolution logic
  // lives in cli.ts; the model-mutation effect is what we verify here.
  function renderWith(src: string, overrides: Partial<Record<"title" | "subtitle" | "caption", string | null>>): string {
    const m = bind(parse(tokenize(src)));
    for (const field of ["title", "subtitle", "caption"] as const) {
      if (overrides[field] === null) delete m[field];
      else if (overrides[field] !== undefined) m[field] = overrides[field]!;
    }
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    return renderSVG(m, p, routing, loadTheme("document-light"));
  }

  it("override replaces in-source title", () => {
    const out = renderWith('title: "Original"\na -> b', { title: "Overridden" });
    expect(out).toContain("Overridden");
    expect(out).not.toContain("Original");
  });

  it("empty-string override (model-delete equivalent) hides title", () => {
    const out = renderWith('title: "Original"\na -> b', { title: null });
    expect(out).not.toContain('data-row="title"');
  });
});
