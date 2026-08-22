/**
 * @tabtin/media-core
 *
 * Shared media primitives used by TabVideo and TabSlide.
 * Import specific pipelines via subpath exports for tree-shaking:
 *
 *   import { ... } from '@tabtin/media-core/fonts'
 *   import { ... } from '@tabtin/media-core/assets'
 *   import { ... } from '@tabtin/media-core/svg'
 *   import { ... } from '@tabtin/media-core/effects'
 */

// Re-export all pipelines for convenience (prefer subpath imports for tree-shaking)
export * from './fonts/index.js'
export * from './assets/index.js'
export * from './svg/index.js'
export * from './effects/index.js'
