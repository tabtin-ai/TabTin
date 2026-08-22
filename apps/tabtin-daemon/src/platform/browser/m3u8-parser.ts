/**
 * M3U8 Parser — lightweight HLS manifest parser.
 *
 * Supports both master playlists (multi-quality) and media playlists (segment lists).
 * No external dependencies.
 */

import { safeFetchText } from './safe-fetch.js';

import { validateUrl } from '@tabtin/security-policy';

export interface M3U8Segment {
  uri: string;
  duration: number;
  title?: string;
  byteRange?: { length: number; offset?: number };
}

export interface M3U8Variant {
  uri: string;
  bandwidth: number;
  resolution?: string;
  codecs?: string;
  name?: string;
}

export interface M3U8Manifest {
  type: 'master' | 'media';
  version?: number;
  targetDuration?: number;
  variants: M3U8Variant[];
  segments: M3U8Segment[];
  totalDuration: number;
  isLive: boolean;
  isEncrypted?: boolean;
  encryptionMethod?: string;
  initSegmentUrl?: string;
}

interface ParserState {
  segmentDuration: number;
  segmentTitle?: string;
  variant: Partial<M3U8Variant> | null;
}

function applyDirective(line: string, manifest: M3U8Manifest, state: ParserState, baseUrl: string): boolean {
  const [prefix] = line.split(':', 1);
  if (prefix === '#EXT-X-VERSION') manifest.version = parseInt(line.split(':')[1], 10);
  else if (prefix === '#EXT-X-TARGETDURATION') manifest.targetDuration = parseInt(line.split(':')[1], 10);
  else if (prefix === '#EXT-X-ENDLIST') manifest.isLive = false;
  else if (prefix === '#EXT-X-STREAM-INF') {
    manifest.type = 'master';
    const attrs = parseAttributes(line.substring('#EXT-X-STREAM-INF:'.length));
    state.variant = { bandwidth: parseInt(attrs.BANDWIDTH || '0', 10), resolution: attrs.RESOLUTION, codecs: attrs.CODECS, name: attrs.NAME };
  } else if (prefix === '#EXTINF') {
    const duration = line.match(/#EXTINF:([\d.]+)/)?.[1];
    if (duration) state.segmentDuration = parseFloat(duration);
    const comma = line.indexOf(',');
    if (comma >= 0) state.segmentTitle = line.substring(comma + 1).trim() || undefined;
  } else if (prefix === '#EXT-X-KEY' || prefix === '#EXT-X-MAP') {
    applyResourceDirective(prefix, line, manifest, baseUrl);
  } else return line.startsWith('#');
  return true;
}

function applyResourceDirective(prefix: string, line: string, manifest: M3U8Manifest, baseUrl: string): void {
  const attrs = parseAttributes(line.substring(prefix.length + 1));
  if (prefix === '#EXT-X-KEY') {
    if (attrs.METHOD && attrs.METHOD !== 'NONE') { manifest.isEncrypted = true; manifest.encryptionMethod = attrs.METHOD; }
    return;
  }
  if (attrs.URI) manifest.initSegmentUrl = resolveUrl(attrs.URI, baseUrl);
}

function applyUri(line: string, manifest: M3U8Manifest, state: ParserState, baseUrl: string): void {
  const uri = resolveUrl(line, baseUrl);
  if (state.variant) {
    manifest.variants.push({ uri, bandwidth: state.variant.bandwidth || 0, resolution: state.variant.resolution, codecs: state.variant.codecs, name: state.variant.name });
    state.variant = null;
    return;
  }
  manifest.segments.push({ uri, duration: state.segmentDuration, title: state.segmentTitle });
  manifest.totalDuration += state.segmentDuration;
  state.segmentDuration = 0;
  state.segmentTitle = undefined;
}

export function parseM3U8(content: string, baseUrl: string): M3U8Manifest {
  content = content.replace(/^\uFEFF/, '');

  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

  if (!lines[0]?.startsWith('#EXTM3U')) {
    throw new Error('Not a valid M3U8 file: missing #EXTM3U header');
  }

  const manifest: M3U8Manifest = {
    type: 'media',
    variants: [],
    segments: [],
    totalDuration: 0,
    isLive: true,
  };

  const state: ParserState = { segmentDuration: 0, variant: null };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (!applyDirective(line, manifest, state, baseUrl)) applyUri(line, manifest, state, baseUrl);
  }

  if (manifest.type === 'master' && manifest.variants.length > 1) {
    manifest.variants.sort((a, b) => b.bandwidth - a.bandwidth);
  }

  return manifest;
}

function parseAttributes(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([\w.\/:+-]+))/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    attrs[match[1]] = match[2] ?? match[3];
  }
  return attrs;
}

function resolveUrl(uri: string, baseUrl: string): string {
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return uri;
  }
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

export async function fetchAndParseM3U8(
  url: string,
  headers?: Record<string, string>,
  opts?: { signal?: AbortSignal },
): Promise<M3U8Manifest> {
  validateUrl(url);
  const content = await safeFetchText(url, { headers, signal: opts?.signal });
  return parseM3U8(content, url);
}
