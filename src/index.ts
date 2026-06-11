// High-level entry points — the recommended way to embed melk.
// `compileToSVG(source, { filePath? })` runs the exact pipeline the CLI
// runs; `tryCompileToSVG` / `validateSource` return structured
// diagnostics instead of throwing.
export {
  compileToSVG,
  tryCompileToSVG,
  validateSource,
  resolveTheme,
  parseDiagnostic,
} from "./compile.js";
export type {
  CompileOptions,
  CompileResult,
  Diagnostic,
  Stage,
} from "./compile.js";

// Low-level pipeline stages — for advanced consumers assembling a
// custom pipeline. Most callers want compileToSVG above instead; these
// must be composed in the exact order compile.ts uses or module bodies
// and text-fit growth will be missing.
export { tokenize } from "./parser/lexer.js";
export { parse } from "./parser/parser.js";
export { bind } from "./bind/bind.js";
export { place } from "./layout/place.js";
export { applyTextFit, applyTextFitToSizes } from "./layout/text-fit.js";
export { assignSlots } from "./layout/slots.js";
export { routeChannels } from "./layout/channels.js";
export { applyModulePortEndpoints } from "./layout/module-route.js";
export { applyModuleAlignment, placeModules } from "./layout/module-place.js";
export { autoAlignViaShims } from "./layout/via-shim.js";
export { renderSVG } from "./render/svg.js";
export {
  BUILTIN_THEME_NAMES,
  COLOUR_TOKEN_NAMES,
  DEFAULT_THEME_NAME,
  loadTheme,
  loadThemeFromPath,
  resolveColour,
  resolveTags,
  TAG_PROPERTY_NAMES,
  ThemeError,
  validateTheme,
} from "./theme/theme.js";
export type { Model, ModelNode, ModelEdge } from "./bind/model.js";
export type { Program } from "./parser/ast.js";
export type {
  ArrowHeadShape,
  ColourTokenName,
  TagPropertyName,
  TagRule,
  Theme,
  ThemeStrokes,
  ThemeTokens,
  ThemeTypography,
} from "./theme/theme.js";
