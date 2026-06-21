/**
 * node-shim.js — browser stand-ins for the Node built-ins melk's dist/ imports.
 *
 * melk's core compile path (inline source + a BUILT-IN theme + no icons) never
 * calls fs/child_process — but three modules (bind.js, theme.js, render/icons.js)
 * `import` them at module top level, so the browser's module loader must resolve
 * those specifiers. An import map points node:fs / node:path / node:child_process
 * here.
 *
 * - `path` functions are implemented for real (pure string ops) because
 *   resolveTheme() calls isAbsolute()/etc. even for inline diagrams.
 * - `fs` / `child_process` functions THROW a clear browser-unavailable error.
 *   They are only reached by the optional file/network features (file themes,
 *   `import` of other .melk files, icon packs) — using those in the browser
 *   surfaces a clean message instead of a cryptic crash.
 *
 * This lets melk's PUBLISHED dist/ run unmodified in the browser — the
 * experiment proves melk-as-shipped works, no fork.
 */

/* ── node:path (real, pure implementations) ───────────────────────────────── */
export function isAbsolute(p) {
  return /^([/\\]|[A-Za-z]:[/\\])/.test(p); // POSIX /… or Windows C:\…
}
export function dirname(p) {
  const s = String(p).replace(/[/\\]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i <= 0 ? (i === 0 ? "/" : ".") : s.slice(0, i);
}
export function resolve(...segs) {
  // Minimal browser resolve: join non-empty segments with "/", collapse "." / "..".
  // Sufficient for melk's synthetic "<string>.melk" base — no real cwd in a tab.
  const joined = segs.filter(Boolean).join("/");
  const parts = [];
  for (const part of joined.split(/[/\\]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}
export const sep = "/";

/* ── node:fs (unavailable in browser — only optional features reach these) ── */
const fsUnavailable = (fn) => () => {
  throw new Error(
    `melk(browser): fs.${fn} is unavailable. File-based features (file themes, ` +
      `module imports, local icon packs) are not supported in the browser build. ` +
      `Use inline source with a built-in theme.`,
  );
};
export const readFileSync = fsUnavailable("readFileSync");
export const existsSync = () => false; // "file doesn't exist" — lets theme/icon code take its not-found branch cleanly
export const writeFileSync = fsUnavailable("writeFileSync");
export const mkdirSync = fsUnavailable("mkdirSync");

/* ── node:child_process (icon URL fetch uses execSync(curl) — N/A here) ───── */
export const execSync = () => {
  throw new Error(
    "melk(browser): child_process.execSync is unavailable (used only for remote " +
      "icon-pack fetches). Render without icon packs in the browser.",
  );
};

/* default export so `import fs from "node:fs"` style also resolves */
export default {
  isAbsolute, dirname, resolve, sep,
  readFileSync, existsSync, writeFileSync, mkdirSync, execSync,
};
