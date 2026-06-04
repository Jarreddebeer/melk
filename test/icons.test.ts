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
import { reserveCorridors } from "../src/layout/corridors.js";
import { packTracks } from "../src/layout/tracks.js";
import { buildPolylines } from "../src/layout/polyline.js";
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
});

describe("end-to-end render with icons", () => {
  const fixtureDir = resolve(__dirname, "fixtures", "icons");

  function render(src: string, themeName = "document-light"): string {
    const m = bind(parse(tokenize(src)));
    const p = place(m);
    const r = reserveCorridors(m, p);
    const t = packTracks(m, p, r);
    const polys = buildPolylines(m, p, r, t);
    return renderSVG(m, p, r, polys, loadTheme(themeName), {
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
    const r = reserveCorridors(m, p);
    const t = packTracks(m, p, r);
    const polys = buildPolylines(m, p, r, t);
    const out = renderSVG(m, p, r, polys, theme, {
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
