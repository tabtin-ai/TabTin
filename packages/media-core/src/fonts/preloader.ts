/**
 * Font Preloader — batch download + register fonts via an injected FontLoader
 *
 * Orchestrates the full font loading pipeline:
 *   1. Scan scene → collect FontSpecs via font-scanner
 *   2. Load CJK default font (Noto Sans SC) if any CJK text is detected
 *   3. Load Latin default font (Inter) as fallback
 *   4. Batch download + register custom fonts from scene shapes
 *
 * The actual font-manager backend is injected via `setFontLoader()`.
 * design-engine injects the Skia implementation; other consumers
 * (tabvideo worker, tests) can supply stubs or alternative backends.
 */

import type { SceneObjects, FontLoader } from './types.js';
import { NOTO_SANS_SC_URL } from './registry.js';
import { scanFonts, containsCjk } from './scanner.js';
import type { FontSpec, ScanResult } from './scanner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreloadOptions {
  /** Pre-downloaded CJK font data (avoids re-download in workers). */
  cjkFontData?: ArrayBuffer;
  /** Extra font URLs to load (from export options etc). */
  extraFontUrls?: string[];
  /** Skip CJK font loading even if CJK text is detected. */
  skipCjk?: boolean;
  /** Skip default Latin font (Inter) loading. */
  skipDefault?: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface PreloadResult {
  /** Number of fonts successfully loaded. */
  loadedCount: number;
  /** Font families that failed to load. */
  failedFamilies: string[];
  /** Whether CJK font was loaded. */
  cjkLoaded: boolean;
  /** All text collected from the scene (useful for subsetting). */
  allText: string;
}

// ---------------------------------------------------------------------------
// Font loader injection — replaces the hard-coded dynamic import
// ---------------------------------------------------------------------------

let _fontLoader: FontLoader | null = null;

/**
 * Register the font-manager backend.
 *
 * Must be called before `preloadFontsForScene` / `preloadFromScanResult`.
 * design-engine calls this once at Skia init time.
 */
export function setFontLoader(loader: FontLoader): void {
  _fontLoader = loader;
}

/**
 * Get the currently registered font loader (or null).
 */
export function getFontLoader(): FontLoader | null {
  return _fontLoader;
}

function requireLoader(): FontLoader {
  if (!_fontLoader) {
    throw new Error(
      '[FontPreloader] No FontLoader registered. ' +
      'Call setFontLoader() before using the preloader.',
    );
  }
  return _fontLoader;
}

// ---------------------------------------------------------------------------
// Font Family LRU — caps registered families at MAX_FONT_FAMILIES (H3-05)
// ---------------------------------------------------------------------------

const MAX_FONT_FAMILIES = 50;

const _familyAccessOrder: string[] = [];
const _registeredFamilies = new Set<string>();

function touchFontFamily(family: string): void {
  const idx = _familyAccessOrder.indexOf(family);
  if (idx !== -1) _familyAccessOrder.splice(idx, 1);
  _familyAccessOrder.push(family);
  _registeredFamilies.add(family);
  evictExcessFamilies();
}

const PROTECTED_FAMILIES = new Set(['Inter', 'Noto Sans SC']);

function evictExcessFamilies(): void {
  while (_familyAccessOrder.length > MAX_FONT_FAMILIES) {
    const oldest = _familyAccessOrder.shift()!;
    if (PROTECTED_FAMILIES.has(oldest)) {
      _familyAccessOrder.push(oldest);
      if (_familyAccessOrder.every((f) => PROTECTED_FAMILIES.has(f))) break;
      continue;
    }
    _registeredFamilies.delete(oldest);
    if (_fontLoader) {
      try { _fontLoader.unloadFontFamily(oldest); } catch { /* best effort */ }
    }
    console.log(`[FontPreloader] Evicted font family "${oldest}" (LRU limit ${MAX_FONT_FAMILIES})`);
  }
}

/** Exposed for testing. */
export function _getFontFamilyLRUState() {
  return { accessOrder: [..._familyAccessOrder], registered: new Set(_registeredFamilies), max: MAX_FONT_FAMILIES };
}

export function _resetFontFamilyLRU(): void {
  _familyAccessOrder.length = 0;
  _registeredFamilies.clear();
}

// ---------------------------------------------------------------------------
// Download failure blacklist (H3-06) — avoids retrying permanently-failed fonts
// ---------------------------------------------------------------------------

interface FailureRecord { count: number; lastAttempt: number; }

const _failedDownloads = new Map<string, FailureRecord>();
const MAX_RETRY_COUNT = 3;
const RETRY_BACKOFF_MS = 60_000; // 1 min before first retry, doubles each time

function markDownloadFailed(family: string): void {
  const existing = _failedDownloads.get(family);
  if (existing) {
    existing.count++;
    existing.lastAttempt = Date.now();
  } else {
    _failedDownloads.set(family, { count: 1, lastAttempt: Date.now() });
  }
}

function isBlacklisted(family: string): boolean {
  const record = _failedDownloads.get(family);
  if (!record) return false;
  if (record.count >= MAX_RETRY_COUNT) return true;
  const backoff = RETRY_BACKOFF_MS * Math.pow(2, record.count - 1);
  return Date.now() - record.lastAttempt < backoff;
}

/** Exposed for testing. */
export function _getFailedDownloads() {
  return new Map(_failedDownloads);
}

export function _resetFailedDownloads(): void {
  _failedDownloads.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Preload all fonts needed to render a design scene.
 * Scans the objects tree, resolves font families, and batch downloads them.
 */
export async function preloadFontsForScene(
  objects: SceneObjects | Record<string, unknown>,
  options: PreloadOptions = {},
): Promise<PreloadResult> {
  requireLoader();

  const scan = scanFonts(objects);
  return preloadFromScanResult(scan, options);
}

/**
 * Preload fonts from a pre-computed scan result.
 * Useful when the caller has already scanned the scene.
 */
export async function preloadFromScanResult(
  scan: ScanResult,
  options: PreloadOptions = {},
): Promise<PreloadResult> {
  const loader = requireLoader();

  const { skipCjk = false, skipDefault = false, signal } = options;
  let loadedCount = 0;
  const failedFamilies: string[] = [];
  let cjkLoaded = false;

  // --- 1. Load CJK font if needed ---
  if (!skipCjk && (scan.hasCjk || containsCjk(scan.allText))) {
    cjkLoaded = await loadCjkFont(options.cjkFontData, signal);
    if (cjkLoaded) loadedCount++;
  }

  // --- 2. Load default Latin font ---
  if (!skipDefault) {
    const ok = await loader.loadDefaultFont();
    if (ok) loadedCount++;
  }

  // --- 3. Extra font URLs ---
  if (options.extraFontUrls) {
    for (const url of options.extraFontUrls) {
      if (signal?.aborted) break;
      const name = url.split('/').pop()?.replace(/\.\w+$/, '') ?? 'custom';
      if (!scan.fonts.has(url)) {
        scan.fonts.set(url, {
          url,
          family: name,
          weights: new Set([400]),
          styles: new Set(['normal' as const]),
          cjk: false,
        });
      }
    }
  }

  // --- 4. Batch download custom fonts (parallel) ---
  // Snapshot the to-load list before allSettled so result indices stay aligned.
  const specsToLoad = Array.from(scan.fonts.values()).filter((spec) => !isAlreadyLoaded(spec));
  const results = await Promise.allSettled(
    specsToLoad.map((spec) => downloadAndRegister(spec, signal)),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value) {
      loadedCount++;
    } else {
      failedFamilies.push(specsToLoad[i].family);
    }
  }

  console.log(
    `[FontPreloader] Loaded ${loadedCount} font(s)` +
    (failedFamilies.length > 0 ? `, ${failedFamilies.length} failed: ${failedFamilies.join(', ')}` : ''),
  );

  return {
    loadedCount,
    failedFamilies,
    cjkLoaded,
    allText: scan.allText,
  };
}

/**
 * Load just the CJK default font (Noto Sans SC).
 * Can accept pre-downloaded data to avoid re-downloading.
 */
export async function loadCjkFont(
  preDownloadedData?: ArrayBuffer,
  signal?: AbortSignal,
): Promise<boolean> {
  const loader = requireLoader();

  if (loader.isFontLoaded('Noto Sans SC', 400, 'normal')) return true;

  try {
    let data: ArrayBuffer;
    if (preDownloadedData) {
      data = preDownloadedData;
    } else {
      console.log('[FontPreloader] Downloading CJK font (Noto Sans SC)...');
      const resp = await fetch(NOTO_SANS_SC_URL, { signal });
      if (!resp.ok) {
        console.warn(`[FontPreloader] CJK font download failed: ${resp.status}`);
        return false;
      }
      data = await resp.arrayBuffer();
    }

    loader.loadFontFromData('Noto Sans SC', data, 400, 'normal');
    console.log(`[FontPreloader] CJK font loaded (${(data.byteLength / 1024).toFixed(0)} KB)`);
    return true;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return false;
    console.warn('[FontPreloader] CJK font load failed:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function isAlreadyLoaded(spec: FontSpec): boolean {
  if (isBlacklisted(spec.family)) return true;
  if (!_fontLoader) return false;
  for (const w of spec.weights) {
    for (const s of spec.styles) {
      if (!_fontLoader.isFontLoaded(spec.family, w, s)) return false;
    }
  }
  touchFontFamily(spec.family);
  return true;
}

async function downloadAndRegister(
  spec: FontSpec,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!_fontLoader) return false;
  if (isBlacklisted(spec.family)) return false;

  try {
    const resp = await fetch(spec.url, { signal });
    if (!resp.ok) {
      console.warn(`[FontPreloader] Failed to download "${spec.family}": ${resp.status}`);
      markDownloadFailed(spec.family);
      return false;
    }
    const data = await resp.arrayBuffer();

    for (const w of spec.weights) {
      for (const s of spec.styles) {
        _fontLoader.loadFontFromData(spec.family, data, w, s);
      }
    }

    touchFontFamily(spec.family);

    console.log(
      `[FontPreloader] Loaded "${spec.family}" w=[${[...spec.weights]}] s=[${[...spec.styles]}] (${(data.byteLength / 1024).toFixed(0)} KB)`,
    );
    return true;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return false;
    markDownloadFailed(spec.family);
    console.warn(`[FontPreloader] Failed to load "${spec.family}":`, err);
    return false;
  }
}
