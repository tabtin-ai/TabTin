/**
 * Asset preloader — batch preload images and fonts for rendering/export.
 *
 * Combines font preloading with image preloading from the asset resolver
 * into a single pipeline.
 *
 * Font preloading is injected via `fontPreloadFn` to avoid hard coupling
 * to any specific font module.  Callers (design-engine, tabvideo-engine)
 * pass their own font bridge when available.
 *
 * Usage:
 *   const result = await preloadSceneAssets(objects, shapeIds, options);
 *   // All images cached in imageCache, all fonts registered in Skia font manager
 */

import type { AssetObjects } from './types.js'
import { collectSceneAssets, resolveAssets } from './resolver.js'
import type { MediaResolver } from './resolver.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Signature for an externally-provided font preload function.
 * The caller is responsible for supplying a concrete implementation
 * (e.g. design-engine's fonts/font-preloader).
 */
export type FontPreloadFn = (
  objects: AssetObjects | Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<{ loadedCount: number; failedFamilies: string[] }>

export interface PreloadSceneOptions {
  /** Resolve media IDs to URLs */
  mediaResolver?: MediaResolver
  /** Skip font preloading */
  skipFonts?: boolean
  /** Skip image preloading */
  skipImages?: boolean
  /** Abort signal */
  signal?: AbortSignal
  /**
   * Optional font preload function.  When omitted, font preloading is
   * silently skipped.  In design-engine this is wired to
   * fonts/font-preloader.preloadFontsForScene.
   */
  fontPreloadFn?: FontPreloadFn
}

export interface PreloadSceneResult {
  /** Number of images successfully preloaded */
  imagesLoaded: number
  /** Number of fonts successfully preloaded */
  fontsLoaded: number
  /** Failed asset URLs */
  failures: string[]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Preload all assets (images + fonts) needed to render a set of shapes.
 * Images are cached in the global imageCache. Fonts are registered in
 * the Skia font manager (if available and a fontPreloadFn is provided).
 */
export async function preloadSceneAssets(
  objects: AssetObjects,
  shapeIds: string[],
  options: PreloadSceneOptions = {},
): Promise<PreloadSceneResult> {
  const { skipFonts = false, skipImages = false, signal, fontPreloadFn } = options
  let imagesLoaded = 0
  let fontsLoaded = 0
  const failures: string[] = []

  const promises: Promise<void>[] = []

  // Image preloading
  if (!skipImages) {
    const imageRefs = collectSceneAssets(objects, shapeIds, options.mediaResolver)
    promises.push(
      resolveAssets(imageRefs, signal).then((resolved) => {
        imagesLoaded = resolved.size
        for (const ref of imageRefs) {
          const key = ref.key ?? ref.url
          if (!resolved.has(key)) failures.push(ref.url)
        }
      }),
    )
  }

  // Font preloading (only when a font bridge is provided)
  if (!skipFonts && fontPreloadFn) {
    promises.push(
      (async () => {
        if (signal?.aborted) return
        try {
          const result = await fontPreloadFn(objects, { signal })
          fontsLoaded = result.loadedCount
          failures.push(...result.failedFamilies.map((f) => `font:${f}`))
        } catch {
          // Non-fatal: rendering proceeds with available fonts
        }
      })(),
    )
  }

  await Promise.allSettled(promises)

  return { imagesLoaded, fontsLoaded, failures }
}
