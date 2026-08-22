/**
 * DOM 资源提取 — 从清洗后的 HTML DOM 中提取链接和图片
 *
 * 基于 extractMainContent 清洗后的 DOM 操作，已去除导航/页脚噪音。
 * 被 web-fetch-pipeline 的 format=links / format=images 使用。
 */

import type { CheerioAPI } from 'cheerio';

export interface ExtractedLink {
  url: string;
  text: string;
}

/**
 * 从 DOM 中提取所有有效链接（去重、绝对化、仅 http/https）。
 * 返回 { url, text } 数组，让 Agent 能基于锚文本决定读哪个链接。
 */
export function extractLinksFromDom($: CheerioAPI, baseUrl: string): ExtractedLink[] {
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return links;
  }

  $('a[href]').each(function () {
    const raw = $(this).attr('href');
    if (!raw) return;

    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('javascript:')) {
      return;
    }

    try {
      const resolved = new URL(trimmed, base).href;
      const parsed = new URL(resolved);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      if (!seen.has(resolved)) {
        seen.add(resolved);
        const text = ($(this).text() || '').trim().replace(/\s+/g, ' ');
        links.push({ url: resolved, text });
      }
    } catch { /* malformed URL, skip */ }
  });

  return links;
}

/**
 * 解析 srcset 属性中的所有图片候选 URL
 */
function parseSrcset(srcset: string): string[] {
  return srcset
    .split(',')
    .map(s => s.trim().split(/\s+/)[0] || '')
    .filter(Boolean);
}

/**
 * 从 DOM 中提取所有图片 URL（去重、绝对化、仅 http/https，排除 data: URI）
 */
export function extractImagesFromDom($: CheerioAPI, baseUrl: string): string[] {
  const seen = new Set<string>();
  const images: string[] = [];

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return images;
  }

  function addImage(raw: string | undefined) {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('data:')) return;

    try {
      const resolved = new URL(trimmed, base).href;
      const parsed = new URL(resolved);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      if (!seen.has(resolved)) {
        seen.add(resolved);
        images.push(resolved);
      }
    } catch { /* malformed URL, skip */ }
  }

  // img[src]
  $('img[src]').each(function () {
    addImage($(this).attr('src'));
  });

  // img[data-src] (lazy loading)
  $('img[data-src]').each(function () {
    addImage($(this).attr('data-src'));
  });

  // img[srcset] + source[srcset]
  $('img[srcset], source[srcset]').each(function () {
    const srcset = $(this).attr('srcset');
    if (srcset) {
      for (const url of parseSrcset(srcset)) {
        addImage(url);
      }
    }
  });

  // OpenGraph + Twitter meta
  $('meta[property="og:image"], meta[name="twitter:image"]').each(function () {
    addImage($(this).attr('content'));
  });

  return images;
}
