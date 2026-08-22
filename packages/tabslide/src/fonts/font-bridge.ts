/**
 * Font bridge — connects TabSlide's browser font system to
 * media-core's shared font registry.
 *
 * Benefits:
 * - Shared CDN font catalog (15+ fonts including CJK)
 * - Consistent font resolution across TabSlide and TabVideo
 * - CJK detection and auto-loading
 * - Font URL resolution for headless/export scenarios
 * - Font scanning for PPTElement via scanSlideFonts adapter
 */

import type { FontDef } from './font-list'

// Re-export font scan adapter for PPTElement → SceneObjects conversion
export { scanSlideFonts, adaptElementsToSceneObjects } from './font-scan-adapter'
export type { ScanResult } from '@tabtin/media-core/fonts'

export interface SharedFontEntry {
  family: string
  category: string
  weights: number[]
  url: string
  cjk: boolean
}

let _cachedEntries: SharedFontEntry[] | undefined

/**
 * Get the full shared font catalog from media-core's registry.
 * Lazy-loaded to avoid bundling media-core upfront.
 */
export async function getSharedFontCatalog(): Promise<SharedFontEntry[]> {
  if (_cachedEntries) return _cachedEntries

  const registry = await import('@tabtin/media-core/fonts')
  const entries = registry.getAvailableFonts()
  _cachedEntries = entries.map((entry: { family: string; category: string; weights: number[]; urlPattern: string; cjk?: boolean }) => ({
    family: entry.family,
    category: entry.category,
    weights: entry.weights,
    url: entry.urlPattern,
    cjk: entry.cjk ?? false,
  }))
  return _cachedEntries
}

/**
 * Convert shared font catalog entries to TabSlide FontDef format.
 */
export async function getSharedFontsAsFontDefs(): Promise<FontDef[]> {
  const catalog = await getSharedFontCatalog()
  const categoryMap: Record<string, string> = {
    'sans-serif': 'font.sansSerif',
    'serif': 'font.serif',
    'monospace': 'font.monospace',
    'display': 'font.sansSerif',
    'handwriting': 'font.sansSerif',
  }
  return catalog.map(entry => ({
    label: entry.family,
    value: entry.family,
    group: entry.cjk ? 'font.chinese' : (categoryMap[entry.category] ?? 'font.sansSerif'),
  }))
}

/**
 * Resolve a font family name to a CDN URL.
 * Returns null if the font is not in the shared catalog.
 */
export async function resolveFontUrl(family: string): Promise<string | null> {
  const registry = await import('@tabtin/media-core/fonts')
  const resolved = registry.findFont(family)
  return resolved?.urlPattern ?? null
}

/**
 * Check if text contains CJK characters (shared with media-core).
 */
export async function containsCjk(text: string): Promise<boolean> {
  const registry = await import('@tabtin/media-core/fonts')
  return registry.containsCjk(text)
}

/**
 * Load a web font via @font-face from the shared catalog.
 * This is the browser-side font loading via @font-face from the shared catalog.
 */
export async function loadSharedFont(family: string, weight: number = 400): Promise<boolean> {
  const url = await resolveFontUrl(family)
  if (!url) return false

  if (document.fonts) {
    const existing = [...document.fonts].find(
      f => f.family.replace(/['"]/g, '').toLowerCase() === family.toLowerCase()
    )
    if (existing && existing.status === 'loaded') return true
  }

  try {
    const resolvedUrl = url.includes('{weight}') ? url.replace('{weight}', String(weight)) : url
    const font = new FontFace(family, `url(${resolvedUrl})`, {
      display: 'swap',
      weight: String(weight),
    })
    await font.load()
    document.fonts.add(font)
    return true
  } catch (err) {
    console.warn(`[tabslide] Failed to load shared font "${family}":`, err)
    return false
  }
}

/**
 * Preload all CJK fonts from the shared catalog.
 * Useful when importing PPTX with Chinese text.
 */
export async function preloadCjkFonts(): Promise<string[]> {
  const catalog = await getSharedFontCatalog()
  const cjkFonts = catalog.filter(f => f.cjk)
  const loaded: string[] = []
  for (const font of cjkFonts) {
    if (await loadSharedFont(font.family)) {
      loaded.push(font.family)
    }
  }
  return loaded
}
