/**
 * Font Utilities — local file loading, subsetting, and preloading pipeline
 *
 * Complements design-engine's font manager with Node.js-specific capabilities:
 *   - loadFontFromFile(): read .ttf/.otf/.woff2 from local filesystem
 *   - subsetFont(): HarfBuzz WASM-based glyph extraction (30 MB CJK → ~500 KB)
 *   - collectTextForSubsetting(): scan SceneScript to gather all rendered text
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

// ---------------------------------------------------------------------------
// Local font file loading
// ---------------------------------------------------------------------------

type LoadFontFromDataFn = (
  family: string,
  data: ArrayBuffer,
  weight?: number,
  style?: 'normal' | 'italic',
) => void;

let _loadFontFromData: LoadFontFromDataFn | null = null;

export function setLoadFontFromData(fn: LoadFontFromDataFn): void {
  _loadFontFromData = fn;
}

/**
 * Load a font from a local file path (Node.js only).
 * Supports .ttf, .otf, .woff, .woff2
 */
export async function loadFontFromFile(
  filePath: string,
  family: string,
  weight = 400,
  style: 'normal' | 'italic' = 'normal',
): Promise<void> {
  if (!_loadFontFromData) {
    throw new Error('[FontUtils] loadFontFromData bridge not initialized — call setLoadFontFromData() first');
  }

  const ext = extname(filePath).toLowerCase();
  const supportedExts = new Set(['.ttf', '.otf', '.woff', '.woff2']);
  if (!supportedExts.has(ext)) {
    throw new Error(`[FontUtils] Unsupported font format: ${ext}. Supported: .ttf, .otf, .woff, .woff2`);
  }

  const buffer = await readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  _loadFontFromData(family, arrayBuffer, weight, style);
  console.log(`[FontUtils] Loaded font "${family}" from ${filePath} (${(buffer.byteLength / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// Font subsetting via subset-font (HarfBuzz WASM)
// ---------------------------------------------------------------------------

/**
 * Subset a font to only include glyphs needed for the given text.
 *
 * Dramatically reduces CJK font sizes:
 *   Full Noto Sans SC: ~10 MB TTF
 *   Subset for 200 unique chars: ~200-500 KB TTF
 *
 * @param fontData  Full font file as ArrayBuffer
 * @param text      All text that will be rendered (duplicates are fine)
 * @param options   Target format and extra settings
 * @returns Subsetted font as Buffer
 */
export async function subsetFont(
  fontData: ArrayBuffer | Buffer,
  text: string,
  options: { targetFormat?: 'sfnt' | 'woff2'; preserveNameIds?: number[] } = {},
): Promise<Buffer> {
  const { targetFormat = 'sfnt' } = options;

  let subsetFontFn: (buf: Buffer, text: string, opts: Record<string, unknown>) => Promise<Buffer>;
  try {
    const mod = await import('subset-font');
    subsetFontFn = (mod.default ?? mod) as typeof subsetFontFn;
  } catch {
    throw new Error(
      '[FontUtils] subset-font package not installed. Run: pnpm add subset-font',
    );
  }

  const inputBuf = Buffer.isBuffer(fontData) ? fontData : Buffer.from(fontData);
  const uniqueChars = new Set(text);
  const uniqueText = Array.from(uniqueChars).join('');

  const result = await subsetFontFn(inputBuf, uniqueText, { targetFormat });

  const ratio = ((1 - result.byteLength / inputBuf.byteLength) * 100).toFixed(1);
  console.log(
    `[FontUtils] Subset: ${(inputBuf.byteLength / 1024).toFixed(0)} KB → ${(result.byteLength / 1024).toFixed(0)} KB ` +
    `(${uniqueChars.size} unique chars, -${ratio}%)`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Text collectors for subsetting
// ---------------------------------------------------------------------------

/**
 * Scan a SceneScript and extract all text that will be rendered.
 */
export function collectTextForSubsetting(
  scenes: Array<{ elements?: Array<{ text?: string; richText?: Array<{ text: string }> }> }>,
  subtitles?: Array<{ text?: string }>,
): string {
  const parts: string[] = [];

  for (const scene of scenes) {
    for (const el of scene.elements ?? []) {
      if (el.text) parts.push(el.text);
      if (el.richText) {
        for (const run of el.richText) parts.push(run.text);
      }
    }
  }

  if (subtitles) {
    for (const sub of subtitles) {
      if (sub.text) parts.push(sub.text);
    }
  }

  return parts.join('');
}

/**
 * Extract all text from a design-engine Objects tree (post-build).
 * Walks shape names, plain text content, and TextContent tree leaf nodes.
 */
export function collectTextFromObjects(objects: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const shape of Object.values(objects)) {
    const s = shape as Record<string, unknown>;
    if (s.type !== 'text') continue;

    if (typeof s.name === 'string') parts.push(s.name);

    const content = s.content;
    if (typeof content === 'string') {
      parts.push(content);
    } else if (content && typeof content === 'object') {
      walkTextContent(content as Record<string, unknown>, parts);
    }
  }

  return parts.join('');
}

function walkTextContent(node: Record<string, unknown>, out: string[]): void {
  if (typeof node.text === 'string') {
    out.push(node.text);
    return;
  }
  const children = Array.isArray(node.children) ? node.children : undefined;
  if (children) {
    for (const child of children) {
      if (child && typeof child === 'object') {
        walkTextContent(child as Record<string, unknown>, out);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Integrated preloading: subset + register in one call
// ---------------------------------------------------------------------------

/**
 * Download a CJK font, subset it for the given text, and register with design-engine.
 * This is the recommended way to load CJK fonts in production.
 *
 * @param fontUrl    URL to download the full font
 * @param family     Font family name to register
 * @param allText    All text that will be rendered (for subsetting)
 * @returns Object with original size, subset size, and the subset buffer
 */
export async function loadSubsettedFont(
  fontUrl: string,
  family: string,
  allText: string,
): Promise<{ originalKB: number; subsetKB: number; subsetBuffer: Buffer }> {
  if (!_loadFontFromData) {
    throw new Error('[FontUtils] loadFontFromData bridge not initialized');
  }

  console.log(`[FontUtils] Downloading font "${family}" from ${fontUrl.slice(0, 60)}...`);
  const resp = await fetch(fontUrl);
  if (!resp.ok) throw new Error(`[FontUtils] Font download failed: ${resp.status}`);
  const fullData = await resp.arrayBuffer();
  const originalKB = Math.round(fullData.byteLength / 1024);

  const subsetBuffer = await subsetFont(fullData, allText);
  const subsetKB = Math.round(subsetBuffer.byteLength / 1024);

  const ab = subsetBuffer.buffer.slice(
    subsetBuffer.byteOffset,
    subsetBuffer.byteOffset + subsetBuffer.byteLength,
  ) as ArrayBuffer;
  _loadFontFromData(family, ab, 400, 'normal');

  return { originalKB, subsetKB, subsetBuffer };
}
