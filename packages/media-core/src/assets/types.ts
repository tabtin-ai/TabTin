/**
 * Minimal shape interfaces for the asset pipeline.
 *
 * These decouple image/font preloading from the full design-engine type
 * system.  Callers (design-engine, tabvideo-engine, etc.) satisfy these
 * interfaces by passing their concrete Shape / Objects types which are
 * structural super-sets of what is defined here.
 */

// ---------------------------------------------------------------------------
// Shape subset needed by asset-resolver & preloader
// ---------------------------------------------------------------------------

/**
 * Minimal fill descriptor.  The resolver only inspects `fillImage.id`.
 */
export interface AssetFill {
  fillImage?: { id?: string }
}

/**
 * Minimal shape descriptor consumed by the asset resolver.
 *
 * This is intentionally loose so that any shape type system (design-engine
 * Shape, tabvideo-engine ShapeSnapshot, etc.) satisfies it structurally.
 */
export interface AssetShape {
  id: string
  type: string
  hidden?: boolean
  fills?: AssetFill[]
  /** Image metadata — only present on image shapes */
  metadata?: { id?: string; src?: string; [key: string]: unknown }
  /** Child shape IDs — present on container shapes (frame/group/bool) */
  shapes?: string[]
}

/**
 * A map of shape-id to shape.  Structural equivalent of design-engine's
 * `Objects` (`Record<string, Shape>`).
 */
export type AssetObjects = Record<string, AssetShape>
