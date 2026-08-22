/**
 * Shared guardrails for the embedded browser viewport.
 *
 * The native WebContentsView is positioned outside the React tree, so keeping
 * these values central prevents renderer bounds, auto-fit zoom, and manual zoom
 * from drifting apart.
 */
export const MIN_BROWSER_VIEWPORT_CSS_WIDTH = 640
export const MIN_BROWSER_VIEWPORT_CSS_HEIGHT = 360

/** Native WebContentsView radius for the browser content surface. */
export const BROWSER_VIEW_BORDER_RADIUS_PX = 12

/** Electron zoom level near 50% (1.2 ** -4 ~= 0.48). */
export const MIN_BROWSER_ZOOM_LEVEL = -4
export const MAX_BROWSER_ZOOM_LEVEL = 5

/** Lowest automatic fit-to-width zoom factor; keeps text readable. */
export const MIN_BROWSER_AUTO_FIT_ZOOM_FACTOR = 0.5
export const MAX_BROWSER_AUTO_FIT_ZOOM_FACTOR = 1
