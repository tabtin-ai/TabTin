/**
 * Lightweight MPD parser for Daemon mode.
 *
 * Focus:
 * - stream/info: provide DASH variants / duration / segment info
 * - stream/download: support direct video-only MPD download in degraded mode
 *
 * No Electron dependency; manifest fetch via safeFetchText.
 */

import { validateUrl } from '@tabtin/security-policy';
import { safeFetchText } from './safe-fetch.js';

export interface MPDSegment {
  uri: string;
  duration: number;
  sequence: number;
}

export interface MPDVariant {
  uri: string;
  bandwidth: number;
  resolution?: string;
  codecs?: string;
}

export interface MPDManifest {
  type: 'dash';
  variants: MPDVariant[];
  segments: MPDSegment[];
  totalDuration: number;
  isLive: boolean;
  isEncrypted: boolean;
  initSegmentUrl?: string;
  hasAudioTrack: boolean;
  variantSegments?: Array<{ segments: MPDSegment[]; initSegmentUrl?: string }>;
  audioSegments?: { segments: MPDSegment[]; initSegmentUrl?: string };
}

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function stripNs(name: string): string {
  const idx = name.indexOf(':');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseXmlAttrs(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

function parseXml(xml: string): XmlNode {
  xml = xml.replace(/<\?[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  xml = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  xml = xml.trim();

  const root: XmlNode = { tag: '__root__', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re = /<(\/?)([a-zA-Z][\w:.-]*)([^>]*)>/g;

  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(xml)) !== null) {
    const isClose = m[1] === '/';
    const tag = stripNs(m[2]);
    let rest = m[3].trim();
    const isSelfClose = !isClose && rest.endsWith('/');
    if (isSelfClose) rest = rest.slice(0, -1).trim();

    if (m.index > lastIdx) {
      const text = decodeXmlEntities(xml.slice(lastIdx, m.index).trim());
      if (text) {
        const parent = stack[stack.length - 1];
        parent.text = parent.text ? `${parent.text} ${text}` : text;
      }
    }
    lastIdx = m.index + m[0].length;

    if (isClose) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const node: XmlNode = {
      tag,
      attrs: parseXmlAttrs(rest),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!isSelfClose) {
      stack.push(node);
    }
  }

  if (root.children.length === 0) {
    throw new Error('Invalid MPD XML: missing root element');
  }
  return root.children[0];
}

function findChildren(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((child) => child.tag === tag);
}

function findChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((child) => child.tag === tag);
}

function hasDescendant(node: XmlNode, tag: string): boolean {
  for (const child of node.children) {
    if (child.tag === tag || hasDescendant(child, tag)) return true;
  }
  return false;
}

export function parseISO8601Duration(str: string | undefined): number {
  if (!str) return 0;
  const m = str.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/
  );
  if (!m) return 0;
  const days = parseInt(m[3] || '0', 10);
  const hours = parseInt(m[4] || '0', 10);
  const minutes = parseInt(m[5] || '0', 10);
  const seconds = parseFloat(m[6] || '0');
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function resolveBaseUrl(node: XmlNode, parentBaseUrl: string): string {
  const base = findChild(node, 'BaseURL');
  return base?.text ? resolveUrl(base.text, parentBaseUrl) : parentBaseUrl;
}

function expandTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (full, name, pad) => {
    const value = vars[name];
    if (value === undefined) return full;
    const text = String(value);
    return pad ? text.padStart(parseInt(pad, 10), '0') : text;
  });
}

function isMediaType(set: XmlNode, type: 'video' | 'audio'): boolean {
  const mime = set.attrs.mimeType || '';
  const contentType = set.attrs.contentType || '';
  if (mime.startsWith(`${type}/`) || contentType === type) return true;
  if (!mime && !contentType) {
    return findChildren(set, 'Representation').some((rep) =>
      (rep.attrs.mimeType || '').startsWith(`${type}/`)
    );
  }
  return false;
}

function resolvePeriodDurations(periods: XmlNode[], mpdDuration: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < periods.length; i += 1) {
    const start = parseISO8601Duration(periods[i].attrs.start);
    let duration = parseISO8601Duration(periods[i].attrs.duration);
    if (!duration) {
      if (i + 1 < periods.length && periods[i + 1].attrs.start) {
        duration = parseISO8601Duration(periods[i + 1].attrs.start) - start;
      } else if (mpdDuration > 0) {
        duration = mpdDuration - start;
      }
    }
    result.push(duration);
  }
  return result;
}

function parseTimeline(
  timeline: XmlNode,
  mediaTpl: string,
  tplVars: Record<string, string | number>,
  timescale: number,
  startNumber: number,
  totalDuration: number,
  baseUrl: string,
  segments: MPDSegment[],
): void {
  const entries = findChildren(timeline, 'S');
  let time = 0;
  let sequence = startNumber;

  for (let j = 0; j < entries.length; j += 1) {
    const entry = entries[j];
    const t = entry.attrs.t !== undefined ? parseInt(entry.attrs.t, 10) : undefined;
    const d = parseInt(entry.attrs.d || '0', 10);
    const r = parseInt(entry.attrs.r || '0', 10);
    if (t !== undefined) time = t;

    let count = 1;
    if (r >= 0) {
      count = r + 1;
    } else if (d > 0) {
      const nextT = entries[j + 1]?.attrs.t !== undefined
        ? parseInt(entries[j + 1].attrs.t, 10)
        : undefined;
      if (nextT !== undefined) {
        count = Math.ceil((nextT - time) / d);
      } else if (totalDuration > 0) {
        count = Math.ceil((totalDuration * timescale - time) / d);
      }
    }

    for (let i = 0; i < count; i += 1) {
      segments.push({
        uri: resolveUrl(
          expandTemplate(mediaTpl, { ...tplVars, Number: sequence, Time: time }),
          baseUrl
        ),
        duration: d / timescale,
        sequence,
      });
      time += d;
      sequence += 1;
    }
  }
}

function parseSegmentTemplate(
  tpl: XmlNode,
  rep: XmlNode,
  baseUrl: string,
  totalDuration: number,
): { segments: MPDSegment[]; initSegmentUrl?: string } {
  const mediaTpl = tpl.attrs.media || '';
  const initTpl = tpl.attrs.initialization || '';
  const timescale = parseInt(tpl.attrs.timescale || '1', 10);
  const startNumber = parseInt(tpl.attrs.startNumber || '1', 10);
  const segmentDuration = parseInt(tpl.attrs.duration || '0', 10);
  const repId = rep.attrs.id || '';
  const repBw = rep.attrs.bandwidth || '';
  const tplVars: Record<string, string | number> = {
    RepresentationID: repId,
    Bandwidth: repBw,
  };

  let initSegmentUrl: string | undefined;
  if (initTpl) {
    initSegmentUrl = resolveUrl(expandTemplate(initTpl, tplVars), baseUrl);
  }

  const segments: MPDSegment[] = [];
  const timeline = findChild(tpl, 'SegmentTimeline');
  if (timeline) {
    parseTimeline(timeline, mediaTpl, tplVars, timescale, startNumber, totalDuration, baseUrl, segments);
    return { segments, initSegmentUrl };
  }

  if (segmentDuration > 0 && totalDuration > 0) {
    const segmentSeconds = segmentDuration / timescale;
    const segmentCount = Math.ceil(totalDuration / segmentSeconds);
    for (let i = 0; i < segmentCount; i += 1) {
      const sequence = startNumber + i;
      const remaining = totalDuration - i * segmentSeconds;
      segments.push({
        uri: resolveUrl(expandTemplate(mediaTpl, { ...tplVars, Number: sequence }), baseUrl),
        duration: remaining < segmentSeconds ? remaining : segmentSeconds,
        sequence,
      });
    }
  }

  return { segments, initSegmentUrl };
}

function parseSegmentList(list: XmlNode, baseUrl: string): { segments: MPDSegment[]; initSegmentUrl?: string } {
  const duration = parseInt(list.attrs.duration || '0', 10);
  const timescale = parseInt(list.attrs.timescale || '1', 10);
  const segmentSeconds = timescale > 0 ? duration / timescale : 0;

  let initSegmentUrl: string | undefined;
  const initNode = findChild(list, 'Initialization');
  if (initNode?.attrs.sourceURL) {
    initSegmentUrl = resolveUrl(initNode.attrs.sourceURL, baseUrl);
  }

  const segments: MPDSegment[] = [];
  for (const [index, segmentUrl] of findChildren(list, 'SegmentURL').entries()) {
    const media = segmentUrl.attrs.media || segmentUrl.attrs.mediaURL || '';
    if (!media) continue;
    segments.push({
      uri: resolveUrl(media, baseUrl),
      duration: segmentSeconds,
      sequence: index,
    });
  }
  return { segments, initSegmentUrl };
}

function parseSegments(
  tpl: XmlNode | undefined,
  list: XmlNode | undefined,
  rep: XmlNode,
  baseUrl: string,
  totalDuration: number,
  adaptationSegBase?: XmlNode,
): { segments: MPDSegment[]; initSegmentUrl?: string } {
  const segBase = findChild(rep, 'SegmentBase') || adaptationSegBase;
  if (segBase) {
    return {
      segments: [{ uri: baseUrl, duration: totalDuration, sequence: 0 }],
      initSegmentUrl: undefined,
    };
  }
  if (tpl) return parseSegmentTemplate(tpl, rep, baseUrl, totalDuration);
  if (list) return parseSegmentList(list, baseUrl);
  return { segments: [] };
}

type ParsedVariant = { variant: MPDVariant; segments: MPDSegment[]; initSegmentUrl?: string };

function nonEmptyOrUndefined<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

function parseVideoVariants(period: XmlNode, periodBaseUrl: string, duration: number): ParsedVariant[] {
  const results: ParsedVariant[] = [];
  const sets = findChildren(period, 'AdaptationSet').filter((set) => isMediaType(set, 'video'));
  for (const set of sets) {
    const setBaseUrl = resolveBaseUrl(set, periodBaseUrl);
    const setTemplate = findChild(set, 'SegmentTemplate');
    const setList = findChild(set, 'SegmentList');
    const setSegBase = findChild(set, 'SegmentBase');
    for (const rep of findChildren(set, 'Representation')) {
      const repBaseUrl = resolveBaseUrl(rep, setBaseUrl);
      const parsed = parseSegments(findChild(rep, 'SegmentTemplate') || setTemplate, findChild(rep, 'SegmentList') || setList, rep, repBaseUrl, duration, setSegBase);
      results.push({ variant: { uri: repBaseUrl, bandwidth: parseInt(rep.attrs.bandwidth || '0', 10), resolution: rep.attrs.width && rep.attrs.height ? `${rep.attrs.width}x${rep.attrs.height}` : undefined, codecs: rep.attrs.codecs || set.attrs.codecs }, ...parsed });
    }
  }
  return results.sort((a, b) => b.variant.bandwidth - a.variant.bandwidth);
}

function parseBestAudio(period: XmlNode, periodBaseUrl: string, duration: number): { segments: MPDSegment[]; initSegmentUrl?: string } | undefined {
  const set = findChildren(period, 'AdaptationSet').find((candidate) => isMediaType(candidate, 'audio'));
  if (!set) return undefined;
  const rep = [...findChildren(set, 'Representation')].sort((a, b) => parseInt(b.attrs.bandwidth || '0', 10) - parseInt(a.attrs.bandwidth || '0', 10))[0];
  if (!rep) return undefined;
  const setBaseUrl = resolveBaseUrl(set, periodBaseUrl);
  const repBaseUrl = resolveBaseUrl(rep, setBaseUrl);
  return parseSegments(findChild(rep, 'SegmentTemplate') || findChild(set, 'SegmentTemplate'), findChild(rep, 'SegmentList') || findChild(set, 'SegmentList'), rep, repBaseUrl, duration, findChild(set, 'SegmentBase'));
}

export function parseMPD(content: string, baseUrl: string): MPDManifest {
  const root = parseXml(content);
  if (root.tag !== 'MPD') {
    throw new Error(`Invalid MPD: expected <MPD>, got <${root.tag}>`);
  }

  const isLive = root.attrs.type === 'dynamic';
  const isEncrypted = hasDescendant(root, 'ContentProtection');
  const mpdDuration = parseISO8601Duration(root.attrs.mediaPresentationDuration);
  const mpdBaseUrl = resolveBaseUrl(root, baseUrl);

  const periods = findChildren(root, 'Period');
  if (periods.length === 0) {
    throw new Error('Invalid MPD: no <Period> found');
  }

  const periodDurations = resolvePeriodDurations(periods, mpdDuration);
  let variants: MPDVariant[] = [];
  const allSegments: MPDSegment[] = [];
  let initSegmentUrl: string | undefined;
  let audioSegments: { segments: MPDSegment[]; initSegmentUrl?: string } | undefined;
  const variantSegments: Array<{ segments: MPDSegment[]; initSegmentUrl?: string }> = [];

  for (let periodIndex = 0; periodIndex < periods.length; periodIndex += 1) {
    const period = periods[periodIndex];
    const periodBaseUrl = resolveBaseUrl(period, mpdBaseUrl);
    const periodDuration = periodDurations[periodIndex];
    const currentVariants = parseVideoVariants(period, periodBaseUrl, periodDuration);

    if (periodIndex === 0) {
      variants = currentVariants.map((item) => item.variant);
      initSegmentUrl = currentVariants[0]?.initSegmentUrl;
      currentVariants.forEach((item, index) => {
        variantSegments[index] = {
          segments: [...item.segments],
          initSegmentUrl: item.initSegmentUrl,
        };
      });
    } else {
      currentVariants.forEach((item, index) => {
        if (!variantSegments[index]) return;
        variantSegments[index].segments.push(...item.segments);
      });
    }

    if (currentVariants[0]?.segments?.length) {
      allSegments.push(...currentVariants[0].segments);
    }

    if (periodIndex === 0) audioSegments = parseBestAudio(period, periodBaseUrl, periodDuration);
  }

  let totalDuration = mpdDuration || periodDurations.reduce((sum, item) => sum + item, 0);
  if (!totalDuration && allSegments.length > 0) {
    totalDuration = allSegments.reduce((sum, item) => sum + item.duration, 0);
  }

  return {
    type: 'dash',
    variants,
    segments: allSegments,
    totalDuration,
    isLive,
    isEncrypted,
    initSegmentUrl,
    hasAudioTrack: Boolean(audioSegments?.segments?.length),
    variantSegments: nonEmptyOrUndefined(variantSegments),
    audioSegments,
  };
}

export async function fetchAndParseMPD(
  url: string,
  headers?: Record<string, string>,
  opts?: { signal?: AbortSignal },
): Promise<MPDManifest> {
  validateUrl(url);
  const content = await safeFetchText(url, { headers, signal: opts?.signal });
  return parseMPD(content, url);
}
