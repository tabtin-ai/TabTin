/**
 * Stable surface class for TabDoc editor floating controls.
 *
 * The shared overlay token is still the visual source of truth. This local class
 * adds a plain-CSS fallback in prosemirror.css so Tippy/Radix floating layers do
 * not depend solely on Tailwind arbitrary-value generation or platform-specific
 * compositor behavior.
 */
export const TABDOC_FLOATING_MENU_SURFACE_CLASS = 'tabdoc-floating-menu-surface'
