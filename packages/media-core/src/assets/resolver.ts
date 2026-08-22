/**
 * Asset resolver — URI -> data resolution for image assets.
 *
 * Provides a single API for resolving image asset references (URLs, media IDs,
 * local paths) into raw data, abstracting the fetch/cache/decode pipeline.
 * Font preloading is handled separately by preloader.ts -> fonts/font-preloader.ts.
 */

import type { AssetObjects, AssetShape } from './types.js'
import type { CachedImage } from './image-cache.js'
import { imageCache } from './image-cache.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Only 'image' is handled by this module.
 * Font assets are resolved by the font-preloader bridge (preloader.ts -> fonts/font-preloader.ts).
 * SVG shape assets are not currently collected as standalone references.
 */
export type AssetType = 'image'

export interface AssetReference {
  type: AssetType
  url: string
  /** Cache key (defaults to url) */
  key?: string
  /** Source shape ID (for tracing) */
  shapeId?: string
}

export interface MediaResolver {
  (id: string): string
}

// ---------------------------------------------------------------------------
// Scene asset collection
// ---------------------------------------------------------------------------

/**
 * Collect all asset references from a set of shapes.
 * Scans image shapes and fill images.
 * Recursively descends into frame/group/bool children.
 * Note: font assets are collected and preloaded separately via preloader.ts.
 */
export function collectSceneAssets(
  objects: AssetObjects,
  shapeIds: string[],
  mediaResolver?: MediaResolver,
): AssetReference[] {
  const assets: AssetReference[] = []
  const seenUrls = new Set<string>()
  const resolve = mediaResolver ?? ((id: string) => id)

  for (const id of shapeIds) {
    const shape = objects[id]
    if (!shape || shape.hidden) continue
    collectShapeAssets(shape, objects, resolve, assets, seenUrls)
  }

  return assets
}

function collectShapeAssets(
  shape: AssetShape,
  objects: AssetObjects,
  mediaResolver: MediaResolver,
  assets: AssetReference[],
  seenUrls: Set<string>,
): void {
  if (shape.type === 'image') {
    const meta = shape.metadata
    if (meta) {
      let url: string | undefined
      if (typeof meta.src === 'string') {
        url = meta.src
      } else if (typeof meta.id === 'string') {
        url = mediaResolver(meta.id)
      }
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url)
        assets.push({ type: 'image', url, key: `img:${shape.id}`, shapeId: shape.id })
      }
    }
  }

  for (const fill of shape.fills ?? []) {
    const fillImage = fill.fillImage
    if (fillImage?.id) {
      const url = mediaResolver(fillImage.id)
      if (!seenUrls.has(url)) {
        seenUrls.add(url)
        assets.push({ type: 'image', url, key: `fill:${fillImage.id}`, shapeId: shape.id })
      }
    }
  }

  // Recurse into container shapes (frame / group / bool).
  const childIds = shape.shapes
  if (Array.isArray(childIds)) {
    for (const childId of childIds) {
      const child = objects[childId]
      if (!child || child.hidden) continue
      collectShapeAssets(child, objects, mediaResolver, assets, seenUrls)
    }
  }
}

// ---------------------------------------------------------------------------
// Batch resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a batch of image asset references, fetching and caching as needed.
 * Returns a map of key -> CachedImage for successfully resolved assets.
 * Font assets must be preloaded separately via preloadSceneAssets() in preloader.ts.
 */
export async function resolveAssets(
  refs: AssetReference[],
  signal?: AbortSignal,
): Promise<Map<string, CachedImage>> {
  return imageCache.fetchBatch(
    refs.map((r) => ({ url: r.url, key: r.key })),
    signal,
  )
}
