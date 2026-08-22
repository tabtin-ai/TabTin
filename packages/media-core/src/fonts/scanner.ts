/**
 * Font Scanner — extract all font references from a design scene
 *
 * Traverses all text shapes in a scene objects map and collects unique
 * font family + weight + style + URL combinations. This enables the
 * preloader to batch-download exactly the fonts needed for export.
 *
 * Handles:
 *   - Shape-level fontFamily / fontUrl / fontWeight / fontStyle
 *   - Rich text content tree (root → paragraph-set → paragraph → leaf)
 *   - Per-run inline font overrides in leaf nodes
 *   - Deduplication by (url, family, weight, style) tuple
 */

import type { SceneObjects, TextRunFontAttrs } from './types.js';
import { resolveFontFamily } from './registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FontSpec {
  /** Download URL (from shape.fontUrl or registry resolution). */
  url: string;
  /** Canonical font family name. */
  family: string;
  weights: Set<number>;
  styles: Set<'normal' | 'italic'>;
  /** Whether this is a CJK font. */
  cjk: boolean;
}

export interface ScanResult {
  /** Unique fonts to load, keyed by URL. */
  fonts: Map<string, FontSpec>;
  /** All rendered text collected from text shapes (for CJK subsetting). */
  allText: string;
  /** Whether any CJK text was detected. */
  hasCjk: boolean;
}

// ---------------------------------------------------------------------------
// CJK detection
// ---------------------------------------------------------------------------

const CJK_RANGES = /[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2CEB0}-\u{2EBEF}\u{30000}-\u{3134F}\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF]/u;

export function containsCjk(text: string): boolean {
  return CJK_RANGES.test(text);
}

// ---------------------------------------------------------------------------
// Built-in families (already loaded by default during Skia init)
// ---------------------------------------------------------------------------

const BUILTIN_FAMILIES = new Set(['Inter', 'sans-serif']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a scene objects map and collect all font references from text shapes.
 *
 * Accepts any `Record<string, Record<string, unknown>>` — the concrete
 * design-engine `Objects` type satisfies this constraint.
 */
export function scanFonts(objects: SceneObjects | Record<string, unknown>): ScanResult {
  const fonts = new Map<string, FontSpec>();
  const textParts: string[] = [];
  let hasCjk = false;

  const addSpec = (
    url: string,
    family: string,
    weight: number,
    style: 'normal' | 'italic',
    cjk: boolean,
  ) => {
    let spec = fonts.get(url);
    if (!spec) {
      spec = { url, family, weights: new Set(), styles: new Set(), cjk };
      fonts.set(url, spec);
    }
    spec.weights.add(weight);
    spec.styles.add(style);
  };

  for (const shape of Object.values(objects)) {
    const s = shape as Record<string, unknown>;
    if (s.type !== 'text') continue;

    // Collect shape-level font
    const fontUrl = s.fontUrl as string | undefined;
    const fontFamily = s.fontFamily as string | undefined;
    const rawWeight = s.fontWeight as string | number | undefined;
    const rawStyle = s.fontStyle as string | undefined;
    const weight = rawWeight === 'bold' ? 700 : Number(rawWeight) || 400;
    const style: 'normal' | 'italic' = rawStyle === 'italic' ? 'italic' : 'normal';

    if (fontUrl) {
      addSpec(fontUrl, fontFamily ?? extractFamilyFromUrl(fontUrl), weight, style, false);
    } else if (fontFamily && !BUILTIN_FAMILIES.has(fontFamily)) {
      const resolved = resolveFontFamily(fontFamily);
      if (resolved) {
        addSpec(resolved.url, resolved.resolvedFamily, weight, style, resolved.cjk);
      }
    }

    // Walk rich text content tree
    const content = s.content;
    if (content && typeof content === 'object') {
      walkContentForFonts(content as Record<string, unknown>, (url, fam, w, st, cjk) => {
        if (url) {
          addSpec(url, fam, w, st, cjk);
        } else if (fam && !BUILTIN_FAMILIES.has(fam)) {
          const resolved = resolveFontFamily(fam);
          if (resolved) addSpec(resolved.url, resolved.resolvedFamily, w, st, resolved.cjk);
        }
      });
      walkContentForText(content as Record<string, unknown>, textParts);
    }

    // Also collect shape.name as potential rendered text
    if (typeof s.name === 'string') textParts.push(s.name);
  }

  const allText = textParts.join('');
  if (!hasCjk && containsCjk(allText)) hasCjk = true;

  return { fonts, allText, hasCjk };
}

/**
 * Collect all rendered text from a scene objects map (for font subsetting).
 */
export function collectAllText(objects: SceneObjects | Record<string, unknown>): string {
  const parts: string[] = [];

  for (const shape of Object.values(objects)) {
    const s = shape as Record<string, unknown>;
    if (s.type !== 'text') continue;

    if (typeof s.name === 'string') parts.push(s.name);

    const content = s.content;
    if (typeof content === 'string') {
      parts.push(content);
    } else if (content && typeof content === 'object') {
      walkContentForText(content as Record<string, unknown>, parts);
    }
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// Internal — content tree walkers
// ---------------------------------------------------------------------------

type FontSpecCallback = (
  url: string,
  family: string,
  weight: number,
  style: 'normal' | 'italic',
  cjk: boolean,
) => void;

function walkContentForFonts(
  node: Record<string, unknown>,
  addSpec: FontSpecCallback,
): void {
  if (typeof node.text === 'string') {
    extractLeafFonts(node as unknown as TextRunFontAttrs & { fontUrl?: string }, addSpec);
    return;
  }
  const children = node.children as unknown[] | undefined;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === 'object') {
        walkContentForFonts(child as Record<string, unknown>, addSpec);
      }
    }
  }
}

function extractLeafFonts(
  leaf: TextRunFontAttrs & { fontUrl?: string },
  addSpec: FontSpecCallback,
): void {
  const fontUrl = leaf.fontUrl;
  const fontFamily = leaf.fontFamily;
  const weight = leaf.fontWeight === 'bold' ? 700 : Number(leaf.fontWeight) || 400;
  const style: 'normal' | 'italic' = leaf.fontStyle === 'italic' ? 'italic' : 'normal';

  if (fontUrl) {
    addSpec(fontUrl, fontFamily ?? extractFamilyFromUrl(fontUrl), weight, style, false);
  } else if (fontFamily && !BUILTIN_FAMILIES.has(fontFamily)) {
    const resolved = resolveFontFamily(fontFamily);
    if (resolved) {
      addSpec(resolved.url, resolved.resolvedFamily, weight, style, resolved.cjk);
    }
  }
}

function walkContentForText(node: Record<string, unknown>, out: string[]): void {
  if (typeof node.text === 'string') {
    out.push(node.text);
    return;
  }
  const children = node.children as unknown[] | undefined;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === 'object') {
        walkContentForText(child as Record<string, unknown>, out);
      }
    }
  }
}

function extractFamilyFromUrl(url: string): string {
  return url.split('/').pop()?.replace(/\.\w+$/, '') ?? 'custom';
}
