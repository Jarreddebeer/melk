/**
 * Phase 5 icon-pack loader and renderer (DESIGN-PHASE5-ICONS.md).
 *
 * Loads SVG icons from registered packs (local directories or HTTPS
 * URLs, the latter cached on disk). Renders them either as the
 * complete node body (`shape: icon(...)`) or as a small badge inside
 * a regular shape (`icon:` attr).
 *
 * Missing icons (file not found, parse error, network failure) render
 * a hatched-square placeholder + emit a stderr warning, rather than
 * failing the render — DESIGN-PHASE5-ICONS §4.2. Icons are content,
 * not structure; an in-progress pack shouldn't block layout iteration.
 *
 * The module is mostly pure. The two impure surfaces:
 *   - `buildIconRegistry` reads pack directories from disk
 *   - `loadIcon` reads / fetches / caches individual SVG files
 *
 * Both centralise side effects so the rest of the render pipeline
 * stays referentially transparent.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Model } from "../bind/model.js";
import type { Theme } from "../theme/theme.js";
import { escapeAttr, fmt } from "./svg.js";

// --- public types --------------------------------------------------------

export interface IconPack {
  alias: string;
  /** "local" or "url" — drives loadIcon's resolution path. */
  kind: "local" | "url";
  /**
   * For local packs: absolute filesystem directory containing the
   * pack's .svg files. For URL packs: the URL prefix (e.g.
   * "https://cdn.example.com/aws/"). Cache lookup uses the alias + name
   * regardless of pack kind.
   */
  resolvedRoot: string;
}

export interface IconRegistry {
  packs: Map<string, IconPack>;
  /** Absolute path to .melk-cache/, used for URL pack caches. */
  cacheDir: string;
  /** When false, URL packs are cache-only (no network fetches). */
  allowNetwork: boolean;
}

export interface LoadedIcon {
  /**
   * The icon's inner SVG content — children of the root `<svg>` with
   * the root element stripped. Pre-parsed at load time; the renderer
   * substitutes this string verbatim into the emitted SVG.
   */
  innerSVG: string;
  /** Intrinsic dimensions from the icon's viewBox. */
  width: number;
  height: number;
}

// --- registry building ---------------------------------------------------

/**
 * Build the icon registry from a Model. Resolves local paths relative
 * to the .melk file's directory; URL packs keep their URL prefix. The
 * registry doesn't actually LOAD icons here — that's deferred to
 * loadIcon — so a pack with bad contents doesn't fail render until an
 * icon from it is actually referenced.
 *
 * `cacheDir` is `<meltFileDir>/.melk-cache/`; created lazily on the
 * first URL fetch.
 */
export function buildIconRegistry(
  model: Model,
  meltFileDir: string,
  allowNetwork: boolean,
): IconRegistry {
  const packs = new Map<string, IconPack>();
  for (const ref of model.iconPacks) {
    if (ref.source.startsWith("https://")) {
      // URL packs: keep the prefix as-is.
      const prefix = ref.source.endsWith("/") ? ref.source : ref.source + "/";
      packs.set(ref.alias, {
        alias: ref.alias,
        kind: "url",
        resolvedRoot: prefix,
      });
    } else {
      // Local: resolve relative to the .melk file's dir.
      const root = isAbsolute(ref.source)
        ? ref.source
        : resolve(meltFileDir, ref.source);
      packs.set(ref.alias, {
        alias: ref.alias,
        kind: "local",
        resolvedRoot: root,
      });
    }
  }
  return {
    packs,
    cacheDir: resolve(meltFileDir, ".melk-cache"),
    allowNetwork,
  };
}

// --- icon loading --------------------------------------------------------

/**
 * Resolve and load a single icon. Returns undefined when the icon
 * can't be found / parsed / fetched — caller renders the placeholder.
 *
 * All side effects (disk reads, HTTPS fetches, cache writes, stderr
 * warnings) live in this function. The renderer's `renderNode` flow
 * just sees `LoadedIcon | undefined`.
 */
export function loadIcon(
  registry: IconRegistry,
  ref: { alias: string; name: string },
): LoadedIcon | undefined {
  const pack = registry.packs.get(ref.alias);
  if (!pack) {
    // Bind should have caught this; defensive only.
    warn(`W_ICON_PACK_UNKNOWN: pack '${ref.alias}' is not registered`);
    return undefined;
  }
  const cacheKey = `${ref.alias}/${ref.name}`;
  // Try the disk cache first for URL packs. Local packs read directly.
  if (pack.kind === "url") {
    const cached = readFromCache(registry.cacheDir, cacheKey);
    if (cached !== undefined) return parseIconSVG(cached, cacheKey);
    if (!registry.allowNetwork) {
      warn(
        `W_ICON_NOT_CACHED: icon '${cacheKey}' is not in the local cache and --no-network is set`,
      );
      return undefined;
    }
    // Fetch from URL, cache on success, return loaded icon. Synchronous
    // via curl (DESIGN-PHASE5-ICONS §5.1 locks sync at v1; an async
    // render mode is deferred). The first reference to a fresh pack
    // blocks the CLI; subsequent renders read from the cache.
    const url = pack.resolvedRoot + ref.name + ".svg";
    const fetched = fetchURLSync(url);
    if (fetched === undefined) {
      warn(`W_ICON_FETCH_FAILED: '${cacheKey}' from ${url}`);
      return undefined;
    }
    try {
      writeToCache(registry.cacheDir, cacheKey, fetched);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`W_ICON_CACHE_WRITE_FAILED: '${cacheKey}': ${msg}`);
      // Continue with the fetched body even if cache write failed.
    }
    return parseIconSVG(fetched, cacheKey);
  }
  // Local pack.
  const path = resolve(pack.resolvedRoot, `${ref.name}.svg`);
  if (!existsSync(path)) {
    warn(`W_ICON_NOT_FOUND: icon '${cacheKey}' (looked at '${path}')`);
    return undefined;
  }
  try {
    const text = readFileSync(path, "utf8");
    return parseIconSVG(text, cacheKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`W_ICON_PARSE_FAILED: icon '${cacheKey}': ${msg}`);
    return undefined;
  }
}

/**
 * Parse a raw SVG document, strip the root `<svg>` element, and
 * extract the viewBox dimensions. Returns undefined on malformed input.
 * Simple text-based extraction (avoiding an XML parser dep) — robust
 * to the SVG dialects icon packs typically ship.
 */
function parseIconSVG(text: string, hint: string): LoadedIcon | undefined {
  // Strip XML prolog / DOCTYPE / comments.
  let body = text
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const openMatch = body.match(/<svg\b([^>]*)>/i);
  if (!openMatch) {
    warn(`W_ICON_PARSE_FAILED: '${hint}' has no <svg> root`);
    return undefined;
  }
  const openTag = openMatch[0];
  const attrsStr = openMatch[1] ?? "";
  const closeIdx = body.lastIndexOf("</svg>");
  if (closeIdx < 0) {
    warn(`W_ICON_PARSE_FAILED: '${hint}' missing closing </svg>`);
    return undefined;
  }
  const innerSVG = body.slice(openMatch.index! + openTag.length, closeIdx).trim();
  // Pull width / height — first try viewBox; fall back to width/height attrs.
  const vbMatch = attrsStr.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  let width = 24;
  let height = 24;
  if (vbMatch) {
    const parts = vbMatch[1]!.split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      width = parts[2]!;
      height = parts[3]!;
    }
  } else {
    const w = attrsStr.match(/\bwidth\s*=\s*["']([\d.]+)/i);
    const h = attrsStr.match(/\bheight\s*=\s*["']([\d.]+)/i);
    if (w) width = Number(w[1]);
    if (h) height = Number(h[1]);
  }
  return { innerSVG, width, height };
}

// --- cache helpers -------------------------------------------------------

/**
 * Synchronous HTTPS GET via curl. Returns undefined on any failure
 * (network unreachable, non-2xx status, curl missing). 30-second
 * timeout keeps a misconfigured URL from hanging the CLI indefinitely.
 *
 * Curl is the pragmatic choice: it's present on every modern dev
 * machine (macOS/Linux ship it; Windows 10+ ships curl.exe), and
 * Node has no built-in sync HTTPS API. A future async render mode
 * (deferred per §7.7) would lift this dependency.
 */
function fetchURLSync(url: string): string | undefined {
  try {
    const result = execSync(
      `curl --silent --fail --max-time 30 --location ${JSON.stringify(url)}`,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024, // 16 MB cap; icons are kilobytes
      },
    );
    return result;
  } catch {
    return undefined;
  }
}

function readFromCache(cacheDir: string, key: string): string | undefined {
  const path = resolve(cacheDir, `${key}.svg`);
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function writeToCache(cacheDir: string, key: string, content: string): void {
  const path = resolve(cacheDir, `${key}.svg`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

// --- warnings ------------------------------------------------------------

const warningsSeen = new Set<string>();

function warn(message: string): void {
  // De-dupe identical warnings within one render pass — a single
  // missing icon used on multiple nodes shouldn't produce N copies.
  if (warningsSeen.has(message)) return;
  warningsSeen.add(message);
  process.stderr.write(message + "\n");
}

/** Reset the dedup table; called from tests. */
export function resetIconWarnings(): void {
  warningsSeen.clear();
}

// --- rendering -----------------------------------------------------------

/**
 * Render an icon-as-body node (shape: icon(...)). The icon scales to
 * fit the cell, with the box's full pixel bounds as the target. Label
 * placement (below the icon, circle convention) is the caller's
 * responsibility. The optional `tint` overrides the default
 * theme.tokens["ink-primary"] colour applied via SVG's currentColor
 * cascade — see DESIGN-PHASE5-ICONS §2.5 for how tags re-tint
 * monochrome icons via their `text` property.
 */
export function renderIconBody(
  loaded: LoadedIcon,
  x: number,
  y: number,
  width: number,
  height: number,
  theme: Theme,
  tint?: string,
): string {
  return wrapIconSVG(loaded, x, y, width, height, theme, tint);
}

/**
 * Render a badge icon at a node's corner or inline with its label.
 *
 *   - `inline`: the badge sits to the left of the label. Caller has
 *     already computed the label's left edge accounting for badge
 *     width; we just draw at (badgeX, badgeY) sized to the label's
 *     cap-height.
 *   - `corner`: top-left corner of the cell, ~30% of the cell's
 *     shorter side, capped at 24px.
 */
export function renderIconBadge(
  loaded: LoadedIcon,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
  position: "inline" | "corner",
  label: { centreX: number; centreY: number; capHeight: number } | undefined,
  theme: Theme,
  tint?: string,
): string {
  if (position === "corner") {
    const size = Math.min(24, Math.min(boxWidth, boxHeight) * 0.3);
    const padding = 4;
    return wrapIconSVG(
      loaded,
      boxX + padding,
      boxY + padding,
      size,
      size,
      theme,
      tint,
    );
  }
  // Inline: vertically centre against the label baseline. Width sized
  // to icon's natural aspect at the cap-height.
  if (!label) {
    // No label to align against — fall back to box-centre.
    const size = Math.min(16, Math.min(boxWidth, boxHeight) * 0.3);
    return wrapIconSVG(
      loaded,
      boxX + (boxWidth - size) / 2,
      boxY + (boxHeight - size) / 2,
      size,
      size,
      theme,
      tint,
    );
  }
  const size = label.capHeight;
  // Inline icon sits to the left of label.centreX with a 4px gap; the
  // renderer arranged label.centreX to leave room. Y is centred on the
  // label's baseline.
  const x = label.centreX - size - 4;
  const y = label.centreY - size / 2;
  return wrapIconSVG(loaded, x, y, size, size, theme, tint);
}

function wrapIconSVG(
  loaded: LoadedIcon,
  x: number,
  y: number,
  targetW: number,
  targetH: number,
  theme: Theme,
  tintOverride?: string,
): string {
  // Scale to fit the target box while preserving aspect.
  const sx = targetW / loaded.width;
  const sy = targetH / loaded.height;
  const s = Math.min(sx, sy);
  // Centre the scaled icon within the target box.
  const dx = x + (targetW - loaded.width * s) / 2;
  const dy = y + (targetH - loaded.height * s) / 2;
  const tint = tintOverride ?? theme.tokens["ink-primary"];
  // `currentColor` cascades from the wrapping <g>'s `color` attribute;
  // monochrome icons that use `fill="currentColor"` pick it up.
  // Multi-colour icons keep their literal colours.
  //
  // When the theme requests outlined rendering, we set fill="none" and
  // stroke="currentColor" on the wrapper. SVG inheritance flips any
  // child whose fill resolves via the cascade (i.e. fill="currentColor"
  // or no explicit fill at all). Icons that hardcode fill="#hex" on
  // inner elements stay filled — consistent with the "brand icons keep
  // their literal colours" rule.
  //
  // Gradient tints (DESIGN-PHASE5 gradient stroke addendum) are
  // url(#id) references. CSS `color: url(...)` isn't a valid value, so
  // `currentColor` won't propagate the gradient via the cascade.
  // Workaround: textually substitute `currentColor` → url(#id) in the
  // icon's inner SVG, so every fill/stroke that referenced
  // currentColor now references the gradient directly.
  const isGradientTint = tint.startsWith("url(");
  const innerSVG = isGradientTint
    ? loaded.innerSVG.replace(/currentColor/g, tint)
    : loaded.innerSVG;
  const wrapperStroke = isGradientTint ? tint : "currentColor";
  const iconStyle = theme.strokes["icon-style"] ?? "filled";
  const styleAttrs =
    iconStyle === "outlined"
      ? ` fill="none" stroke="${wrapperStroke}" stroke-width="${fmt(theme.strokes.outline / s)}" stroke-linejoin="round" stroke-linecap="round"`
      : "";
  // For solid tints, set `color=` on the wrapper so currentColor
  // cascades work. For gradient tints, `color=` is meaningless (CSS
  // color can't be a paint URL) so omit it to avoid confusion in the
  // rendered SVG.
  const colorAttr = isGradientTint ? "" : ` color="${escapeAttr(tint)}"`;
  return (
    `<g data-icon="1" data-icon-style="${iconStyle}"${colorAttr}${styleAttrs} ` +
    `transform="translate(${fmt(dx)} ${fmt(dy)}) scale(${fmt(s)})">` +
    innerSVG +
    `</g>`
  );
}

/**
 * Hatched-square placeholder for a missing icon. Dashed border-subtle
 * outline + diagonal hatching. Sized to the same box the icon would
 * have occupied so the layout stays stable.
 */
export function renderIconPlaceholder(
  x: number,
  y: number,
  width: number,
  height: number,
  theme: Theme,
  tint?: string,
): string {
  // A tag-rule `icon-color` tints the placeholder too, so a missing
  // icon can be flagged (e.g. orange) instead of always reading as the
  // muted border-subtle hatch.
  const stroke = tint ?? theme.tokens["border-subtle"];
  const sw = theme.strokes.frame;
  // Diagonal hatch lines, 4px apart, NW→SE.
  const lines: string[] = [];
  const spacing = 4;
  // Generate enough diagonals to cover the box; offset along the top
  // edge then again along the left edge.
  const maxDim = Math.max(width, height);
  for (let off = -maxDim; off < width + height; off += spacing) {
    const x1 = Math.max(0, off);
    const y1 = Math.max(0, -off);
    const x2 = Math.min(width, off + height);
    const y2 = Math.min(height, x2 - off);
    if (x2 <= x1 || y2 <= y1) continue;
    lines.push(
      `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" ` +
        `stroke="${stroke}" stroke-width="${sw}" stroke-opacity="0.5"/>`,
    );
  }
  return (
    `<g data-icon-placeholder="1" transform="translate(${fmt(x)} ${fmt(y)})">` +
    `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" ` +
    `fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="4 3"/>` +
    lines.join("") +
    `</g>`
  );
}
