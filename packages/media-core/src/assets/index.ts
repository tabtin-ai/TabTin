// Asset pipeline — image cache, resolution, preloading

// Types
export type { AssetFill, AssetShape, AssetObjects } from './types.js'

// Image cache
export { ImageCache, imageCache, guessMimeType } from './image-cache.js'
export type { CachedImage, ImageCacheOptions } from './image-cache.js'

// Asset resolver (Phase 2)
export { collectSceneAssets, resolveAssets } from './resolver.js'
export type { AssetType, AssetReference, MediaResolver } from './resolver.js'

// Preloader (Phase 2)
export { preloadSceneAssets } from './preloader.js'
export type { FontPreloadFn, PreloadSceneOptions, PreloadSceneResult } from './preloader.js'
