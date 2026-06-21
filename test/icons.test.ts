/**
 * Phase 5 icon-pack feature tests.
 *
 * Covers parser surface (icons: directive, shape: icon(...), icon:),
 * bind validation (alias registry, duplicate alias, insecure URL,
 * missing alias, body+badge conflict, icon-position without icon),
 * and rendering integration (icon-as-body, badge, placeholder for
 * missing icons).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { tokenize } from "../src/parser/lexer.js";
import { parse } from "../src/parser/parser.js";
import { bind } from "../src/bind/bind.js";
import {
  buildIconRegistry,
  loadIcon,
  renderIconPlaceholder,
  resetIconWarnings,
} from "../src/render/icons.js";
import { loadTheme, validateTheme } from "../src/theme/theme.js";
import { place } from "../src/layout/place.js";
import { assignSlots } from "../src/layout/slots.js";
import { routeChannels } from "../src/layout/channels.js";
import { renderSVG } from "../src/render/svg.js";

function model(src: string) {
  return bind(parse(tokenize(src)));
}

describe("icons: directive (DESIGN-PHASE5-ICONS §1.1)", () => {
  it("registers a local pack", () => {
    const m = model('icons: aws from "./icons/aws/"\na -> b');
    expect(m.iconPacks).toEqual([{ alias: "aws", source: "./icons/aws/" }]);
  });

  it("accepts multiple packs", () => {
    const m = model(
      [
        'icons: aws  from "./icons/aws/"',
        'icons: gcp  from "./icons/gcp/"',
        "a -> b",
      ].join("\n"),
    );
    expect(m.iconPacks.map((p) => p.alias)).toEqual(["aws", "gcp"]);
  });

  it("rejects duplicate alias with E_ICON_PACK_DUPLICATE_ALIAS", () => {
    expect(() =>
      model(
        [
          'icons: aws from "./icons/aws/"',
          'icons: aws from "./icons/aws-v2/"',
          "a -> b",
        ].join("\n"),
      ),
    ).toThrow(/E_ICON_PACK_DUPLICATE_ALIAS/);
  });

  it("rejects http:// source with E_ICON_PACK_INSECURE", () => {
    expect(() =>
      model('icons: aws from "http://example.com/icons/"\na -> b'),
    ).toThrow(/E_ICON_PACK_INSECURE/);
  });

  it("accepts https:// source", () => {
    const m = model('icons: aws from "https://cdn.example.com/aws/"\na -> b');
    expect(m.iconPacks[0]?.source).toMatch(/^https:\/\//);
  });

  it("requires `from` keyword between alias and source", () => {
    // Without `from`, the parser tries to consume an ident next and
    // fails on the quoted string.
    expect(() => parse(tokenize('icons: aws "./icons/aws/"\na -> b'))).toThrow(
      /expected ident, got string/,
    );
  });
});

describe("shape: icon(alias/name) — body form", () => {
  it("parses and sets node shape to 'icon' with icon ref", () => {
    const m = model(
      ['icons: aws from "./icons/aws/"', "s3 { shape: icon(aws/s3) }"].join("\n"),
    );
    const n = m.nodes.find((x) => x.id === "s3");
    expect(n?.shape).toBe("icon");
    expect(n?.icon).toEqual({ alias: "aws", name: "s3" });
  });

  it("supports nested icon paths (alias/cat/name)", () => {
    const m = model(
      [
        'icons: aws from "./icons/aws/"',
        "glacier { shape: icon(aws/storage/glacier) }",
      ].join("\n"),
    );
    expect(m.nodes.find((x) => x.id === "glacier")?.icon).toEqual({
      alias: "aws",
      name: "storage/glacier",
    });
  });

  it("rejects unknown alias with E_ICON_PACK_UNKNOWN", () => {
    expect(() => model("s3 { shape: icon(aws/s3) }")).toThrow(/E_ICON_PACK_UNKNOWN/);
  });

  it("rejects `shape: icon` standalone (must use call form)", () => {
    // `shape: icon` parses as the bare ident `icon`; bind rejects
    // because no icon ref was provided.
    expect(() =>
      model('icons: aws from "./icons/aws/"\na { shape: icon }'),
    ).toThrow(/E_ICON_BAD_REF/);
  });

  it("rejects bare name without alias prefix", () => {
    expect(() =>
      parse(tokenize('icons: aws from "./icons/aws/"\na { shape: icon(s3) }')),
    ).toThrow(/E_ICON_BAD_REF/);
  });
});

describe("icon: brace-attr — badge form", () => {
  it("attaches an icon ref without changing the shape", () => {
    const m = model(
      [
        'icons: aws from "./icons/aws/"',
        "svc { shape: rect, icon: aws/lambda }",
      ].join("\n"),
    );
    const n = m.nodes.find((x) => x.id === "svc");
    expect(n?.shape).toBe("rect");
    expect(n?.icon).toEqual({ alias: "aws", name: "lambda" });
  });

  it("icon-position: corner sets the badge placement", () => {
    const m = model(
      [
        'icons: aws from "./icons/aws/"',
        "svc { shape: rect, icon: aws/lambda, icon-position: corner }",
      ].join("\n"),
    );
    expect(m.nodes.find((x) => x.id === "svc")?.iconPosition).toBe("corner");
  });

  it("rejects bogus icon-position value", () => {
    expect(() =>
      model(
        [
          'icons: aws from "./icons/aws/"',
          "svc { shape: rect, icon: aws/lambda, icon-position: middle }",
        ].join("\n"),
      ),
    ).toThrow(/E_INVALID_ICON_POSITION/);
  });
});

describe("validation errors", () => {
  it("both shape: icon(...) and icon: attr → E_ICON_SHAPE_WITH_ICON_ATTR", () => {
    expect(() =>
      model(
        [
          'icons: aws from "./icons/aws/"',
          "x { shape: icon(aws/s3), icon: aws/lambda }",
        ].join("\n"),
      ),
    ).toThrow(/E_ICON_SHAPE_WITH_ICON_ATTR/);
  });

  it("icon-position: without icon: → E_ICON_POSITION_WITHOUT_ICON", () => {
    expect(() =>
      model(
        [
          'icons: aws from "./icons/aws/"',
          "x { shape: rect, icon-position: corner }",
        ].join("\n"),
      ),
    ).toThrow(/E_ICON_POSITION_WITHOUT_ICON/);
  });

  it("icon-position: with shape: icon(...) is fine", () => {
    const m = model(
      [
        'icons: aws from "./icons/aws/"',
        "x { shape: icon(aws/s3), icon-position: corner }",
      ].join("\n"),
    );
    // No error; position is recorded even though it's only meaningful
    // for badges.
    expect(m.nodes.find((x) => x.id === "x")?.iconPosition).toBe("corner");
  });
});

describe("icon loader (DESIGN-PHASE5-ICONS §5.1)", () => {
  const fixtureDir = resolve(__dirname, "fixtures", "icons");
  beforeEach(() => {
    resetIconWarnings();
  });

  function registryFor(src: string) {
    const m = bind(parse(tokenize(src)));
    return buildIconRegistry(m, fixtureDir, true);
  }

  it("loads a local SVG icon and extracts viewBox dimensions", () => {
    const registry = registryFor('icons: basic from "./basic/"\na -> b');
    const loaded = loadIcon(registry, { alias: "basic", name: "server" });
    expect(loaded).toBeDefined();
    expect(loaded!.width).toBe(24);
    expect(loaded!.height).toBe(24);
    expect(loaded!.innerSVG).toContain("<rect");
    // The <svg> root element is stripped.
    expect(loaded!.innerSVG).not.toContain("<svg");
  });

  it("loads a nested icon (alias/cat/name)", () => {
    const registry = registryFor('icons: basic from "./basic/"\na -> b');
    const loaded = loadIcon(registry, { alias: "basic", name: "cloud/sun" });
    expect(loaded).toBeDefined();
    expect(loaded!.innerSVG).toContain("<circle");
  });

  it("returns undefined when icon file is missing (W_ICON_NOT_FOUND)", () => {
    const registry = registryFor('icons: basic from "./basic/"\na -> b');
    const loaded = loadIcon(registry, { alias: "basic", name: "does-not-exist" });
    expect(loaded).toBeUndefined();
  });

  it("dedups identical missing-icon warnings", () => {
    const registry = registryFor('icons: basic from "./basic/"\na -> b');
    const stderrWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (s: string) => boolean) = (s: string) => {
      stderrWrites.push(s);
      return true;
    };
    try {
      loadIcon(registry, { alias: "basic", name: "missing" });
      loadIcon(registry, { alias: "basic", name: "missing" });
      loadIcon(registry, { alias: "basic", name: "missing" });
    } finally {
      (process.stderr.write as unknown as typeof orig) = orig;
    }
    const matches = stderrWrites.filter((s) => s.includes("W_ICON_NOT_FOUND"));
    expect(matches.length).toBe(1);
  });

  it("URL pack with --no-network returns undefined for uncached icons", () => {
    const m = bind(parse(tokenize('icons: remote from "https://example.com/icons/"\na -> b')));
    const registry = buildIconRegistry(m, fixtureDir, false);
    const loaded = loadIcon(registry, { alias: "remote", name: "x" });
    expect(loaded).toBeUndefined();
  });

  it("URL pack with cache hit loads from disk (no network)", () => {
    // Pre-populate the cache directory next to the .melk file.
    const m = bind(parse(tokenize('icons: remote from "https://example.com/icons/"\na -> b')));
    const registry = buildIconRegistry(m, fixtureDir, false);
    const cachedPath = resolve(registry.cacheDir, "remote", "preloaded.svg");
    const fakeIcon = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3"/></svg>';
    const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
    mkdirSync(resolve(registry.cacheDir, "remote"), { recursive: true });
    writeFileSync(cachedPath, fakeIcon, "utf8");
    try {
      const loaded = loadIcon(registry, { alias: "remote", name: "preloaded" });
      expect(loaded).toBeDefined();
      expect(loaded!.width).toBe(10);
      expect(loaded!.innerSVG).toContain("<circle");
    } finally {
      // Tidy: remove the cache directory so test runs are repeatable.
      try { rmSync(registry.cacheDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("renderIconPlaceholder emits a hatched square", () => {
    const theme = loadTheme("document-light");
    const out = renderIconPlaceholder(0, 0, 40, 40, theme);
    expect(out).toContain('data-icon-placeholder="1"');
    expect(out).toContain("<rect");
    expect(out).toContain("<line"); // hatching
    expect(out).toContain("stroke-dasharray");
  });

  it("renderIconPlaceholder honours an explicit tint over border-subtle", () => {
    const theme = loadTheme("document-light");
    const subtle = theme.tokens["border-subtle"];
    const tinted = renderIconPlaceholder(0, 0, 40, 40, theme, "#d97706");
    expect(tinted).toContain('stroke="#d97706"');
    expect(tinted).not.toContain(`stroke="${subtle}"`);
    // Default (no tint) still uses border-subtle.
    expect(renderIconPlaceholder(0, 0, 40, 40, theme)).toContain(
      `stroke="${subtle}"`,
    );
  });
});

describe("end-to-end render with icons", () => {
  const fixtureDir = resolve(__dirname, "fixtures", "icons");

  function render(src: string, themeName = "document-light"): string {
    const m = bind(parse(tokenize(src)));
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    return renderSVG(m, p, routing, loadTheme(themeName), {
      meltFileDir: fixtureDir,
      allowNetwork: false,
    });
  }

  beforeEach(() => {
    resetIconWarnings();
  });

  it("body-form node renders the icon SVG inlined", () => {
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server) }",
      "db  { shape: icon(basic/database) }",
      "srv -> db",
    ].join("\n");
    const out = render(src);
    expect(out).toContain('data-icon="1"');
    // Two icon nodes → two icon groups.
    const matches = out.match(/data-icon="1"/g) || [];
    expect(matches.length).toBe(2);
    // Inlined SVG contents from server.svg.
    expect(out).toContain("<rect"); // server icon has <rect>
    expect(out).toContain("<ellipse"); // database icon has <ellipse>
  });

  it("body-form node uses currentColor with ink-primary as the theme tint", () => {
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server) }",
      "srv -> b",
    ].join("\n");
    const out = render(src);
    const theme = loadTheme("document-light");
    expect(out).toContain(`color="${theme.tokens["ink-primary"]}"`);
  });

  it("body-form node renders the label below the icon (circle convention)", () => {
    const src = [
      'icons: basic from "./basic/"',
      'srv { shape: icon(basic/server), label: "API Server" }',
      "srv -> b",
    ].join("\n");
    const out = render(src);
    expect(out).toContain("API Server");
    expect(out).toMatch(/dominant-baseline="alphabetic"/); // below baseline
  });

  it("missing icon renders a placeholder + emits a stderr warning", () => {
    const stderrWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (s: string) => boolean) = (s: string) => {
      stderrWrites.push(s);
      return true;
    };
    try {
      const src = [
        'icons: basic from "./basic/"',
        "srv { shape: icon(basic/does-not-exist) }",
        "srv -> b",
      ].join("\n");
      const out = render(src);
      expect(out).toContain('data-icon-placeholder="1"');
      expect(stderrWrites.some((s) => s.includes("W_ICON_NOT_FOUND"))).toBe(true);
    } finally {
      (process.stderr.write as unknown as typeof orig) = orig;
    }
  });

  it("badge-form: icon: on a rect adds an icon group between shape and label", () => {
    const src = [
      'icons: basic from "./basic/"',
      "svc { shape: rect, icon: basic/server }",
      "svc -> b",
    ].join("\n");
    const out = render(src);
    expect(out).toContain('data-icon="1"');
    expect(out).toContain("<rect"); // rect shape still drawn
  });

  it("badge-form: icon-position: corner positions the badge differently from default", () => {
    const inline = render(
      [
        'icons: basic from "./basic/"',
        "a { shape: rect, icon: basic/server }",
        "a -> b",
      ].join("\n"),
    );
    const corner = render(
      [
        'icons: basic from "./basic/"',
        "a { shape: rect, icon: basic/server, icon-position: corner }",
        "a -> b",
      ].join("\n"),
    );
    // Both render badges but the transform translate should differ.
    const inlineTransform = inline.match(/data-icon="1"[^>]*transform="translate\(([^)]+)\)/);
    const cornerTransform = corner.match(/data-icon="1"[^>]*transform="translate\(([^)]+)\)/);
    expect(inlineTransform).toBeTruthy();
    expect(cornerTransform).toBeTruthy();
    expect(inlineTransform![1]).not.toBe(cornerTransform![1]);
  });

  it("default themes render icons outlined (fill=none, stroke=currentColor)", () => {
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server) }",
      "srv -> b",
    ].join("\n");
    const out = render(src);
    expect(out).toContain('data-icon-style="outlined"');
    expect(out).toContain('fill="none"');
    expect(out).toContain('stroke="currentColor"');
  });

  it("custom theme with icon-style: filled keeps fills", () => {
    // Build a theme via the validator to round-trip the field.
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.strokes["icon-style"] = "filled";
    const theme = validateTheme(raw, "<test>");
    const m = bind(
      parse(
        tokenize(
          [
            'icons: basic from "./basic/"',
            "srv { shape: icon(basic/server) }",
            "srv -> b",
          ].join("\n"),
        ),
      ),
    );
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    const out = renderSVG(m, p, routing, theme, {
      meltFileDir: fixtureDir,
      allowNetwork: false,
    });
    expect(out).toContain('data-icon-style="filled"');
    expect(out).not.toContain('fill="none" stroke="currentColor"');
  });

  it("schematic-dark theme tints icons with its ink-primary token", () => {
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server) }",
      "srv -> b",
    ].join("\n");
    const out = render(src, "schematic-dark");
    const theme = loadTheme("schematic-dark");
    expect(out).toContain(`color="${theme.tokens["ink-primary"]}"`);
  });
});

describe("icon node border (theme-default + per-node override)", () => {
  const fixtureDir = resolve(__dirname, "fixtures", "icons");

  function renderWith(src: string, theme = loadTheme("document-light")): string {
    const m = bind(parse(tokenize(src)));
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    return renderSVG(m, p, routing, theme, {
      meltFileDir: fixtureDir,
      allowNetwork: false,
    });
  }

  it("default theme draws no border around icon-as-body nodes", () => {
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server), label: \"API\" }",
      "srv -> b",
    ].join("\n");
    const out = renderWith(src);
    // The icon node group should not contain a wrapping <rect> outside
    // the icon glyph.
    const match = out.match(/<g data-id="srv">[\s\S]*?<\/g>/);
    expect(match).toBeTruthy();
    // The icon's inner SVG <rect>s belong to the glyph, not a border;
    // we filter by looking for a rect with stroke=border-strong, which
    // is what the border path emits.
    const theme = loadTheme("document-light");
    expect(match![0]).not.toContain(`stroke="${theme.tokens["border-strong"]}" stroke-width="${theme.strokes.outline}"/>`);
  });

  it("per-node border: true draws a wrapping rect", () => {
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server), border: true, label: \"API\" }",
      "srv -> b",
    ].join("\n");
    const out = renderWith(src);
    const theme = loadTheme("document-light");
    expect(out).toContain(
      `stroke="${theme.tokens["border-strong"]}" stroke-width="${theme.strokes.outline}"`,
    );
  });

  it("per-node border: false hides the border even when theme defaults to on", () => {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.strokes["icon-border"] = "on";
    const theme = validateTheme(raw, "<test>");

    const enabled = renderWith(
      [
        'icons: basic from "./basic/"',
        "srv { shape: icon(basic/server), label: \"API\" }",
        "srv -> b",
      ].join("\n"),
      theme,
    );
    expect(enabled).toContain(
      `stroke="${theme.tokens["border-strong"]}" stroke-width="${theme.strokes.outline}"`,
    );

    const overridden = renderWith(
      [
        'icons: basic from "./basic/"',
        "srv { shape: icon(basic/server), border: false, label: \"API\" }",
        "srv -> b",
      ].join("\n"),
      theme,
    );
    // The border-strong stroke should be absent on the icon node group.
    const srvGroup = overridden.match(/<g data-id="srv">[\s\S]*?<\/g>/)![0];
    expect(srvGroup).not.toContain(
      `stroke="${theme.tokens["border-strong"]}" stroke-width="${theme.strokes.outline}"/>`,
    );
  });

  it("theme strokes.icon-border: on draws borders on all icon-as-body nodes", () => {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.strokes["icon-border"] = "on";
    const theme = validateTheme(raw, "<test>");

    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server), label: \"A\" }",
      "db  { shape: icon(basic/database), label: \"B\" }",
      "srv -> db",
    ].join("\n");
    const out = renderWith(src, theme);
    const matches =
      out.match(
        new RegExp(
          `stroke="${theme.tokens["border-strong"].replace(/[#]/g, "\\#")}" stroke-width="${theme.strokes.outline}"`,
          "g",
        ),
      ) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects bogus border value", () => {
    expect(() =>
      bind(parse(tokenize('a { shape: circle, border: maybe }'))),
    ).toThrow(/E_INVALID_BORDER_VALUE/);
  });

  it("theme rejects bogus icon-border value", () => {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.strokes["icon-border"] = "yes";
    expect(() => validateTheme(raw, "<test>")).toThrow(
      /E_THEME_BAD_VALUE.*icon-border/,
    );
  });
});

describe("tag-rule icon-color (re-tint via theme tag)", () => {
  const fixtureDir = resolve(__dirname, "fixtures", "icons");

  function renderWith(src: string, theme = loadTheme("document-light")): string {
    const m = bind(parse(tokenize(src)));
    const p = place(m);
    const slots = assignSlots(m, p);
    const routing = routeChannels(m, p, slots);
    return renderSVG(m, p, routing, theme, {
      meltFileDir: fixtureDir,
      allowNetwork: false,
    });
  }

  it("untagged icon uses theme.tokens.ink-primary as the tint", () => {
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server), label: \"API\" }",
      "srv -> b",
    ].join("\n");
    const out = renderWith(src);
    const theme = loadTheme("document-light");
    // The icon group's `color` attribute carries the resolved tint.
    expect(out).toContain(`color="${theme.tokens["ink-primary"]}"`);
  });

  it("`critical` tag re-tints monochrome icon to status-error", () => {
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server), tags: [critical], label: \"API\" }",
      "srv -> b",
    ].join("\n");
    const out = renderWith(src);
    const theme = loadTheme("document-light");
    // The icon's <g> uses the tag's icon-color (status-error → red).
    const srvGroup = out.match(/<g data-id="srv">[\s\S]*?<\/g>/)![0];
    expect(srvGroup).toContain(`color="${theme.tokens["status-error"]}"`);
  });

  it("a missing icon's placeholder is tinted by icon-color", () => {
    // A deliberately-missing icon renders the hatched placeholder; the
    // tag's icon-color tints it so a broken/intentional gap can be
    // flagged (e.g. orange) instead of the muted border-subtle hatch.
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.tags["flag"] = { "icon-color": "#d97706", legend: "Flag" };
    const theme = validateTheme(raw, "<test>");
    const src = [
      'icons: basic from "./basic/"',
      "mystery { shape: icon(basic/does-not-exist), tags: [flag], label: \"x\" }",
      "mystery -> b",
    ].join("\n");
    const out = renderWith(src, theme);
    const grp = out.match(/<g data-id="mystery">[\s\S]*?<\/g>/)![0];
    expect(grp).toContain('data-icon-placeholder="1"');
    expect(grp).toContain('stroke="#d97706"'); // tinted, not border-subtle
  });

  it("custom tag with hex literal icon-color works", () => {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.tags["highlight"] = { "icon-color": "#ff00ff", legend: "Highlight" };
    const theme = validateTheme(raw, "<test>");

    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server), tags: [highlight], label: \"API\" }",
      "srv -> b",
    ].join("\n");
    const out = renderWith(src, theme);
    const srvGroup = out.match(/<g data-id="srv">[\s\S]*?<\/g>/)![0];
    expect(srvGroup).toContain(`color="#ff00ff"`);
  });

  it("badge form re-tints via icon-color too", () => {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.tags["badge-tint"] = { "icon-color": "status-warn", legend: "Badge tint" };
    const theme = validateTheme(raw, "<test>");

    const src = [
      'icons: basic from "./basic/"',
      "svc { shape: rect, icon: basic/server, tags: [badge-tint], label: \"S\" }",
      "svc -> b",
    ].join("\n");
    const out = renderWith(src, theme);
    const svcGroup = out.match(/<g data-id="svc">[\s\S]*?<\/g>/)![0];
    expect(svcGroup).toContain(`color="${theme.tokens["status-warn"]}"`);
  });

  it("later tag wins on icon-color (composition order)", () => {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.tags["tint-a"] = { "icon-color": "status-warn", legend: "A" };
    raw.tags["tint-b"] = { "icon-color": "status-error", legend: "B" };
    const theme = validateTheme(raw, "<test>");

    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server), tags: [tint-a, tint-b], label: \"X\" }",
      "srv -> b",
    ].join("\n");
    const out = renderWith(src, theme);
    const srvGroup = out.match(/<g data-id="srv">[\s\S]*?<\/g>/)![0];
    // tint-b (later) wins.
    expect(srvGroup).toContain(`color="${theme.tokens["status-error"]}"`);
    expect(srvGroup).not.toContain(`color="${theme.tokens["status-warn"]}"`);
  });

  it("rejects an icon-color value that isn't a colour", () => {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.tags["bad"] = { "icon-color": "not-a-colour", legend: "Bad" };
    expect(() => validateTheme(raw, "<test>")).toThrow(
      /E_THEME_BAD_COLOUR.*icon-color/,
    );
  });

  it("icon-color gradient substitutes currentColor → url() in icon inner SVG", () => {
    const baseLight = loadTheme("document-light");
    const raw = JSON.parse(JSON.stringify(baseLight));
    raw.tags["grad"] = {
      "icon-color": "linear 90deg, status-warn, status-error",
      legend: "Gradient icon",
    };
    const theme = validateTheme(raw, "<test>");
    const src = [
      'icons: basic from "./basic/"',
      "srv { shape: icon(basic/server), tags: [grad], label: \"A\" }",
      "srv -> b",
    ].join("\n");
    const out = renderWith(src, theme);
    // A <linearGradient> def should be present, and the icon's <g>
    // should use stroke="url(...)" (outlined style) rather than
    // stroke="currentColor". The wrapper's color= attr is dropped for
    // gradient tints since CSS color can't hold a paint URL.
    expect(out).toContain("<linearGradient");
    const srvGroup = out.match(/<g data-id="srv">[\s\S]*?<\/g>\s*<text/)![0];
    expect(srvGroup).toMatch(/stroke="url\(#tag-gradient-\d+\)"/);
    // currentColor in the icon's INNER content has been substituted
    // (Lucide server.svg uses fill="currentColor" on the root — we
    // strip the root but children may use it via inheritance; the
    // substitution covers any explicit references).
    const innerGroup = srvGroup.match(/<g data-icon="1"[\s\S]*?<\/g>/)![0];
    expect(innerGroup).not.toContain("currentColor");
  });
});

describe("Model.iconPacks lifecycle", () => {
  it("absence yields empty iconPacks array", () => {
    const m = model("a -> b");
    expect(m.iconPacks).toEqual([]);
  });

  it("ordering matches declaration order", () => {
    const m = model(
      [
        'icons: gcp from "./icons/gcp/"',
        'icons: aws from "./icons/aws/"',
        'icons: azure from "./icons/azure/"',
        "a -> b",
      ].join("\n"),
    );
    expect(m.iconPacks.map((p) => p.alias)).toEqual(["gcp", "aws", "azure"]);
  });
});
