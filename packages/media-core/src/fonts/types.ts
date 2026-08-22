/**
 * Minimal font-pipeline interfaces
 *
 * These types abstract the concrete Shape / Objects / TextContent types used
 * by design-engine so that the scanner & preloader can live in media-core
 * without pulling in the full design type system.
 *
 * Consumers (design-engine, tabslide, tabvideo) pass their own shapes —
 * as long as the objects conform to Record<string, unknown> the scanner
 * traverses them generically.
 */

// ---------------------------------------------------------------------------
// Scene objects — what the scanner iterates over
// ---------------------------------------------------------------------------

/**
 * A map of shape-id → shape data.  The scanner only reads:
 *   - `type`        (string — looks for "text")
 *   - `fontUrl`     (string | undefined)
 *   - `fontFamily`  (string | undefined)
 *   - `fontWeight`  (string | number | undefined)
 *   - `fontStyle`   (string | undefined)
 *   - `content`     (text content tree | string | undefined)
 *   - `name`        (string | undefined)
 *
 * Anything that satisfies Record<string, unknown> works.
 */
export type SceneObjects = Record<string, Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Text-node attributes consumed by the leaf-font extractor
// ---------------------------------------------------------------------------

/**
 * Minimal text-run attributes the scanner reads from rich-text leaf nodes.
 */
export interface TextRunFontAttrs {
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
}

// ---------------------------------------------------------------------------
// Font-loader bridge — injected by the rendering runtime (Skia, etc.)
// ---------------------------------------------------------------------------

/**
 * Abstraction over the font-manager backend.
 *
 * design-engine injects the Skia implementation at init time;
 * other consumers (server-side, worker, test) can supply stubs.
 */
export interface FontLoader {
  /**
   * Register a font from raw binary data.
   */
  loadFontFromData(
    family: string,
    data: ArrayBuffer,
    weight?: number,
    style?: 'normal' | 'italic',
  ): void;

  /**
   * Load the platform default font (e.g. Inter).
   * Returns true if the font was loaded / already available.
   */
  loadDefaultFont(url?: string, family?: string): Promise<boolean>;

  /**
   * Check whether a specific font variant is already registered.
   */
  isFontLoaded(family: string, weight?: number, style?: 'normal' | 'italic'): boolean;

  /**
   * Unload / unregister all variants of a font family (for LRU eviction).
   */
  unloadFontFamily(family: string): void;
}
