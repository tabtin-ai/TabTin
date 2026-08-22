/**
 * HTML 内容提取工具 — 从原始 HTML 中提取可读正文
 *
 * 核心能力：
 * 1. extractMainContent: Cheerio DOM 清洗 + 正文区域提取
 * 2. extractReadableContent: 编排入口（提取 → Markdown 转换 → 后处理）
 * 3. resolveRelativeUrls: 将相对链接转为绝对链接（独立工具函数）
 * 4. extractTitle: 提取 <title> 并解码 HTML 实体
 * 5. stripHtmlTags: 简单的 HTML → 纯文本（零依赖 fallback）
 *
 * 被 CLI /fetch 路由和历史页面抓取管线共同使用，不要在各端重复实现。
 */

import * as cheerio from 'cheerio';
import { REMOVE_TAGS } from './html-cleaner';
import { htmlToMarkdown, postProcessMarkdown } from './html-to-markdown';

// ── HTML → 纯文本（零依赖 fallback）──────────────────────────

export function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ── <title> 提取 ────────────────────────────────────────────

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#8212;': '—', '&mdash;': '—', '&ndash;': '–',
  '&nbsp;': ' ', '&#39;': "'",
};

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!match) return '';
  return match[1].trim().replace(/&[^;]+;/g, (m) => HTML_ENTITY_MAP[m] ?? m);
}

// ── Firecrawl 噪音排除选择器 ────────────────────────────────

const FIRECRAWL_NOISE_SELECTORS = [
  // 语义化结构标签
  'header', 'footer', 'nav', 'aside',
  // class 噪音
  '.sidebar', '.side-bar', '.sideBar',
  '.header', '.footer', '.nav', '.navbar', '.navigation',
  '.menu', '.main-menu',
  '.ad', '.ads', '.advert', '.advertisement',
  '.ad-container', '.ad-wrapper', '.ad-banner',
  '.social', '.social-share', '.social-links', '.share', '.sharing',
  '.comment', '.comments', '.comment-section',
  '.cookie', '.cookie-banner', '.cookie-consent',
  '.popup', '.modal',
  '.banner', '.alert-banner',
  '.breadcrumb', '.breadcrumbs',
  '.pagination', '.pager',
  '.toc', '.table-of-contents',
  '.related', '.related-posts', '.related-articles',
  '.sponsor', '.sponsored',
  '.newsletter', '.subscribe',
  '.search-form',
  '.widget', '.widgets',
  // id 噪音
  '#sidebar', '#comments', '#cookie-consent',
];

const NOISE_ROLES = ['navigation', 'banner', 'complementary', 'contentinfo', 'search'];

const MAIN_CONTENT_SELECTORS = [
  '[role="main"]',
  'main',
  'article',
  '.main-content', '.page-content', '.entry-content',
  '.post-content', '.article-body', '.markdown-body',
  '#content', '#main-content', '#main',
];

const MAIN_CONTENT_PROTECTION = '[role="main"], main, article, #main, #content';

const HTML_SIZE_LIMIT = 5 * 1024 * 1024;

// ── 不可见元素统一过滤 ────────────────────────────────────────

function removeHiddenElements($: import('cheerio').CheerioAPI): void {
  $('[style]').each(function () {
    const style = $(this).attr('style') || '';
    const isHidden =
      /display\s*:\s*none/i.test(style) ||
      /visibility\s*:\s*hidden/i.test(style) ||
      /opacity\s*:\s*(0(\.0+)?)\s*(;|$)/i.test(style) ||
      /opacity\s*:\s*0\.\d\s*(;|$)/i.test(style) ||
      /font-size\s*:\s*0/i.test(style) ||
      /(?:left|top)\s*:\s*-\d{4,}px/i.test(style) ||
      /clip\s*:\s*rect\s*\(\s*0/i.test(style) ||
      /clip-path\s*:\s*inset\s*\(\s*100/i.test(style);
    if (isHidden) $(this).remove();
  });
}

// ── 正文区域提取（Cheerio DOM）────────────────────────────────

export function extractMainContent(rawHtml: string, sourceUrl?: string): string {
  if (rawHtml.length > HTML_SIZE_LIMIT) {
    return stripHtmlTags(rawHtml);
  }

  const $ = cheerio.load(rawHtml);

  // 移除基础噪音标签（复用 html-cleaner 的 REMOVE_TAGS）
  for (const tag of REMOVE_TAGS) {
    $(tag).remove();
  }

  // 移除 HTML 注释
  $('*').contents().each(function () {
    if (this.type === 'comment') $(this).remove();
  });

  // 移除 aria-hidden 元素
  $('[aria-hidden="true"]').remove();

  // 移除不可见元素（统一处理所有 CSS 隐藏手段 + Prompt Injection 防护）
  removeHiddenElements($);

  // 移除 NOISE_ROLES（保护包含主内容的容器）
  for (const role of NOISE_ROLES) {
    $(`[role="${role}"]`).each(function () {
      if ($(this).find(MAIN_CONTENT_PROTECTION).length === 0) {
        $(this).remove();
      }
    });
  }

  // Firecrawl 噪音选择器移除（保护包含主内容的容器）
  const hasMainContent = $(MAIN_CONTENT_PROTECTION).length > 0;
  for (const selector of FIRECRAWL_NOISE_SELECTORS) {
    $(selector).each(function () {
      if (hasMainContent && $(this).find(MAIN_CONTENT_PROTECTION).length > 0) return;
      $(this).remove();
    });
  }

  // img[srcset] → 解析最大尺寸写回 src
  $('img[srcset]').each(function () {
    const srcset = $(this).attr('srcset');
    if (!srcset) return;
    const candidates = srcset.split(',').map(s => {
      const parts = s.trim().split(/\s+/);
      const url = parts[0] || '';
      const descriptor = parts[1] || '0w';
      const size = parseInt(descriptor) || 0;
      return { url, size };
    }).filter(c => c.url);
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => b.size > a.size ? b : a);
      $(this).attr('src', best.url);
    }
    $(this).removeAttr('srcset');
  });

  // URL 绝对化（src / href）
  if (sourceUrl) {
    try {
      const base = new URL(sourceUrl);
      $('[src]').each(function () {
        const val = $(this).attr('src');
        if (val && !/^(?:https?:|data:|javascript:|#)/i.test(val)) {
          try { $(this).attr('src', new URL(val, base).href); } catch { /* skip */ }
        }
      });
      $('[href]').each(function () {
        const val = $(this).attr('href');
        if (val && !/^(?:https?:|data:|javascript:|mailto:|#)/i.test(val)) {
          try { $(this).attr('href', new URL(val, base).href); } catch { /* skip */ }
        }
      });
    } catch { /* invalid sourceUrl, skip */ }
  }

  // 优先级提取正文区域
  for (const selector of MAIN_CONTENT_SELECTORS) {
    const el = $(selector);
    if (el.length > 0) {
      const html = el.first().html();
      if (html && html.trim().length > 200) {
        return html;
      }
    }
  }

  // Fallback: body 内容
  const body = $('body');
  const result = body.length > 0 ? body.html() ?? '' : $.html();

  // 空内容降级：回退全页，仅移除基础标签
  if (result.trim().length === 0) {
    const $fb = cheerio.load(rawHtml);
    for (const tag of REMOVE_TAGS) {
      $fb(tag).remove();
    }
    const fbBody = $fb('body');
    return fbBody.length > 0 ? fbBody.html() ?? '' : $fb.html();
  }

  return result;
}

// ── 相对链接 → 绝对链接（独立工具函数，供外部直接使用）───────

export function resolveRelativeUrls(html: string, baseUrl: string): string {
  try {
    const base = new URL(baseUrl);
    return html
      .replace(
        /(?:href|src)\s*=\s*"(?!https?:\/\/|#|mailto:|javascript:|data:)([^"]+)"/gi,
        (match, path) => {
          try { return match.replace(path, new URL(path, base).href); }
          catch { return match; }
        },
      )
      .replace(
        /(?:href|src)\s*=\s*'(?!https?:\/\/|#|mailto:|javascript:|data:)([^']+)'/gi,
        (match, path) => {
          try { return match.replace(path, new URL(path, base).href); }
          catch { return match; }
        },
      );
  } catch {
    return html;
  }
}

// ── 一站式：URL 的原始 HTML → 干净的可读 Markdown ────────────

export interface ExtractedContent {
  title: string;
  content: string;
}

/**
 * 从原始 HTML 提取可读内容（Markdown 格式）。
 *
 * 调用链：extractTitle → extractMainContent（DOM 清洗）→ htmlToMarkdown → postProcessMarkdown
 *
 * Turndown 由内部 Promise 单例自动管理，调用方无需注入。
 */
export async function extractReadableContent(
  rawHtml: string,
  sourceUrl: string,
): Promise<ExtractedContent> {
  const title = extractTitle(rawHtml);
  const cleaned = extractMainContent(rawHtml, sourceUrl);
  const markdown = await htmlToMarkdown(cleaned);
  const content = postProcessMarkdown(markdown);
  return { title, content };
}
