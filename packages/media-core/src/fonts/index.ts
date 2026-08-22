// Font pipeline — types, registry, scanning, preloading, subsetting

// ─── Types ──────────────────────────────────────────────────────────
export type {
  SceneObjects,
  TextRunFontAttrs,
  FontLoader,
} from './types.js';

// ─── Registry ───────────────────────────────────────────────────────
export {
  getAvailableFonts,
  findFont,
  getFontUrl,
  getClosestWeight,
  resolveFontFamily,
  getCjkFonts,
  getFontsByCategory,
  registerFont,
  registerFonts,
  unregisterFont,
  resetRegistry,
  NOTO_SANS_SC_URL,
  INTER_URL,
} from './registry.js';
export type {
  FontRegistryEntry,
  ResolvedFont,
} from './registry.js';

// ─── Scanner ────────────────────────────────────────────────────────
export {
  scanFonts,
  collectAllText,
  containsCjk,
} from './scanner.js';
export type {
  FontSpec,
  ScanResult,
} from './scanner.js';

// ─── Preloader ──────────────────────────────────────────────────────
export {
  setFontLoader,
  getFontLoader,
  preloadFontsForScene,
  preloadFromScanResult,
  loadCjkFont,
} from './preloader.js';
export type {
  PreloadOptions,
  PreloadResult,
} from './preloader.js';

// ─── Local Fonts ────────────────────────────────────────────────────
export {
  queryLocalFonts,
  isFontAvailable,
  clearLocalFontCache,
  SYSTEM_FONT_CANDIDATES,
} from './local-fonts.js';
export type { LocalFontInfo } from './local-fonts.js';
