/**
 * melk-browser.js — browser entry for melk.
 *
 * Re-exports melk's real agent-loop API from the PUBLISHED dist/ — unmodified.
 * Works in the browser because an import map (see index.html) maps the
 * node:fs / node:path / node:child_process specifiers that dist/ imports onto
 * ./node-shim.js. The core compile path (inline source + built-in theme) never
 * calls the fs/child_process shims, so it runs purely.
 *
 * The point: prove melk-as-shipped runs in a browser tab with no fork and no
 * build step — just an import map + a tiny node shim.
 */
export {
  compileToSVG,      // throws on error; returns { model, svg }
  tryCompileToSVG,   // { ok:true, svg, model } | { ok:false, diagnostic } — the agent-loop form
  validateSource,    // null on success | Diagnostic — the deterministic verifier
  resolveTheme,
  parseDiagnostic,
} from "../dist/compile.js";

export { BUILTIN_THEME_NAMES } from "../dist/theme/theme.js";

// W_LABEL_OVERFLOW warnings are deduped per-process; reset between renders when
// capturing them (the authoring harness's auto-size pass relies on this).
export { resetLabelOverflowWarnings } from "../dist/render/svg.js";
