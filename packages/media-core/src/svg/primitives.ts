/**
 * SVG Primitives — zero-dependency utility functions for SVG generation.
 *
 * Shared SVG primitives used by TabSlide and TabVideo.
 * These are pure functions with no external dependencies.
 */

// ---------------------------------------------------------------------------
// Numeric formatting
// ---------------------------------------------------------------------------

/** Format number for SVG attributes: avoid trailing zeros, ≤4 decimal places. */
export function n(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Number(v.toFixed(4)).toString();
}

// ---------------------------------------------------------------------------
// XML / SVG escaping
// ---------------------------------------------------------------------------

/** Escape XML special characters for safe embedding in SVG attributes/content. */
export function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Color conversion
// ---------------------------------------------------------------------------

/** Convert hex color (#rgb or #rrggbb) + opacity to rgba() string. */
export function hexToRgba(hex: string, opacity: number): string {
  const h = hex.replace('#', '');
  let r: number, g: number, b: number;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else {
    r = parseInt(h.substring(0, 2), 16);
    g = parseInt(h.substring(2, 4), 16);
    b = parseInt(h.substring(4, 6), 16);
  }
  return `rgba(${r},${g},${b},${opacity})`;
}

// ---------------------------------------------------------------------------
// Path generation
// ---------------------------------------------------------------------------

/** Build SVG path `d` attribute for a rounded rectangle with 4 independent corner radii. */
export function roundedRectPath(
  x: number, y: number, w: number, h: number,
  r1: number, r2: number, r3: number, r4: number,
): string {
  const maxR = Math.min(w, h) / 2;
  r1 = Math.min(r1, maxR);
  r2 = Math.min(r2, maxR);
  r3 = Math.min(r3, maxR);
  r4 = Math.min(r4, maxR);

  return [
    `M ${n(x + r1)} ${n(y)}`,
    `L ${n(x + w - r2)} ${n(y)}`,
    r2 > 0 ? `A ${n(r2)} ${n(r2)} 0 0 1 ${n(x + w)} ${n(y + r2)}` : '',
    `L ${n(x + w)} ${n(y + h - r3)}`,
    r3 > 0 ? `A ${n(r3)} ${n(r3)} 0 0 1 ${n(x + w - r3)} ${n(y + h)}` : '',
    `L ${n(x + r4)} ${n(y + h)}`,
    r4 > 0 ? `A ${n(r4)} ${n(r4)} 0 0 1 ${n(x)} ${n(y + h - r4)}` : '',
    `L ${n(x)} ${n(y + r1)}`,
    r1 > 0 ? `A ${n(r1)} ${n(r1)} 0 0 1 ${n(x + r1)} ${n(y)}` : '',
    'Z',
  ].filter(Boolean).join(' ');
}

/** Generate an empty SVG element with given dimensions and scale. */
export function emptySvg(w: number, h: number, scale: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" />`;
}

// ---------------------------------------------------------------------------
// SVG sanitization (security)
// ---------------------------------------------------------------------------

/** Strip dangerous tags: script, iframe, object, embed, applet, form, meta, link, base */
const DANGEROUS_TAG_RE = /<\s*\/?\s*(script|iframe|object|embed|applet|form|meta|link|base)\b[^>]*>/gi;

/** Strip external <use> references (href/xlink:href not starting with #) */
const USE_EXTERNAL_RE = /<use\b[^>]*(?:xlink:href|href)\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*')[^>]*\/?>/gi;

/** Strip event handler attributes (onclick, onload, etc.) */
const EVENT_HANDLER_RE = /(?:^|(?<=[\s>"']))on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gim;

/** Strip dangerous protocols: javascript:, vbscript:, data:text/html */
const HREF_DANGEROUS_RE = /\s+(?:href|xlink:href)\s*=\s*["']?\s*(?:javascript:|vbscript:|data:text\/html)[^"'\s>]*/gi;

/**
 * Sanitize raw SVG content by stripping dangerous elements:
 *   - <script>, <iframe>, <object>, <embed>, <applet>, <form>, <meta>, <link>, <base>
 *   - <use> with external references
 *   - Event handler attributes (onclick, onload, etc.)
 *   - Dangerous protocols (javascript:, vbscript:, data:text/html)
 */
export function sanitizeSvgContent(raw: string): string {
  let safe = raw.replace(DANGEROUS_TAG_RE, '');
  safe = safe.replace(USE_EXTERNAL_RE, '');
  safe = safe.replace(EVENT_HANDLER_RE, '');
  safe = safe.replace(HREF_DANGEROUS_RE, '');
  return safe;
}
