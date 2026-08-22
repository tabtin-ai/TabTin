/**
 * WebFetchPipeline — HTTP 抓取 → 内容提取 → 质量校验 → 浏览器降级 → format 路由
 *
 * 核心编排层，供 CLI（tabtin fetch）和历史 batch 抓取链路共用。
 * 职责：网络 I/O 编排、降级策略、格式路由，不关心调用方的 ToolError 体系。
 */

import * as cheerio from 'cheerio';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHttpCrawlAPI } from '../utils/runtime-bridge';
import {
  extractReadableContent,
  extractMainContent,
  stripHtmlTags,
} from '../utils/html-content-extractor';
import { validateContentQuality, type ContentQuality } from '../utils/content-quality';
import { getCrawlToolRunnerFactory } from './crawl-runner';
import { extractLinksFromDom, extractImagesFromDom, type ExtractedLink } from '../utils/dom-resource-extractor';

// ── 接口定义 ─────────────────────────────────────────────────

export interface FetchPipelineOptions {
  url: string;
  timeout?: number;
  headers?: Record<string, string>;
  format?: 'markdown' | 'html' | 'text' | 'links' | 'images';
  selector?: string;
  autoFallback?: boolean;
  maxLength?: number;
}

export interface FetchPipelineResult {
  success: boolean;
  url: string;
  title: string;
  content: string;
  contentType: string;
  statusCode: number;
  responseTimeMs: number;
  truncated: boolean;
  quality: ContentQuality;
  fallbackUsed: 'none' | 'browser';
  links?: ExtractedLink[];
  images?: string[];
  error?: string;
  /** 正文被截断时的完整字符数（截断前）；未截断时不设置。 */
  contentLength?: number;
  /** 正文超过 maxLength 被截断时，完整正文落盘的路径，供 read_file 分段读回。 */
  fullContentPath?: string;
}

// ── 内部类型 ─────────────────────────────────────────────────

interface HttpFetchResult {
  rawContent: string;
  contentType: string;
  statusCode: number;
  responseTimeMs: number;
  finalUrl: string;
  title: string;
}

// ── 网络重试（简单 1 次重试，不强行适配 withRetry 的 ToolError 泛型）─────

const NON_RETRIABLE_STATUS = new Set([400, 401, 403, 404, 405, 410, 422]);

function isRetriableFailure(statusCode?: number): boolean {
  if (!statusCode) return true;
  return !NON_RETRIABLE_STATUS.has(statusCode);
}

async function fetchWithRetry(
  fetcher: NonNullable<NonNullable<ReturnType<typeof resolveHttpCrawlAPI>>['fetch']>,
  params: { url: string; timeout?: number; headers?: Record<string, string> },
): Promise<HttpFetchResult> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fetcher(params);
      if (result.success && result.data) {
        return {
          rawContent: result.data.content ?? '',
          contentType: result.data.content_type ?? 'text/html',
          statusCode: result.data.status_code ?? 200,
          responseTimeMs: result.data.response_time_ms ?? 0,
          finalUrl: result.data.url ?? params.url,
          title: result.data.title ?? '',
        };
      }
      lastError = result.error || 'HTTP fetch failed';
      const statusCode = result.data?.status_code;
      if (attempt === 0 && isRetriableFailure(statusCode)) {
        console.warn(`[fetch_pipeline] HTTP attempt 1 failed (${statusCode ?? 'no status'}): ${lastError}, retrying in 500ms...`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 0) {
        console.warn(`[fetch_pipeline] HTTP attempt 1 threw: ${lastError}, retrying in 500ms...`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      break;
    }
  }

  throw new Error(lastError || 'HTTP fetch failed after retry');
}

// ── 浏览器降级 ───────────────────────────────────────────────

interface FallbackResult {
  rawHtml: string;
  title: string;
}

async function tryBrowserFallback(
  url: string,
  remainingMs: number,
): Promise<FallbackResult | null> {
  const factory = getCrawlToolRunnerFactory();
  if (!factory) return null;

  try {
    const runner = factory();
    const result = await runner.crawlCleanHtml({
      url,
      timeout: remainingMs,
    });

    const html = result.data?.clean_html || result.clean_html;
    if (!html) return null;

    return {
      rawHtml: html,
      title: result.data?.title || result.title || '',
    };
  } catch (err) {
    console.warn('[fetch_pipeline] browser fallback failed:', err);
    return null;
  }
}

// ── format 路由 ──────────────────────────────────────────────

async function applyFormat(
  rawHtml: string,
  sourceUrl: string,
  format: FetchPipelineOptions['format'],
): Promise<{ content: string; links?: ExtractedLink[]; images?: string[] }> {
  switch (format) {
    case 'html': {
      const html = extractMainContent(rawHtml, sourceUrl);
      return { content: html };
    }
    case 'text': {
      const cleaned = extractMainContent(rawHtml, sourceUrl);
      return { content: stripHtmlTags(cleaned) };
    }
    case 'links': {
      const cleaned = extractMainContent(rawHtml, sourceUrl);
      const $ = cheerio.load(cleaned);
      const extracted = extractLinksFromDom($, sourceUrl);
      const content = extracted.map(l => l.text ? `- [${l.text}](${l.url})` : `- ${l.url}`).join('\n');
      return { content: content || 'No links found', links: extracted };
    }
    case 'images': {
      const cleaned = extractMainContent(rawHtml, sourceUrl);
      const $ = cheerio.load(cleaned);
      const images = extractImagesFromDom($, sourceUrl);
      return { content: `Found ${images.length} images`, images };
    }
    case 'markdown':
    default: {
      const extracted = await extractReadableContent(rawHtml, sourceUrl);
      return { content: extracted.content };
    }
  }
}

// ── 完整正文落盘（截断续读）─────────────────────────────────
//
// 正文超 maxLength 被头部截断后，给 LLM 的只是前 N 字符——抓 JSON 等结构化
// 内容时中间切断会直接损坏数据（jq 报 Unfinished string）。这里把**完整**正文
// 落到临时目录，响应回传路径，Agent 用 read_file（支持 offset/limit）无损分段读。
// read_file 的 workspace 边界只对写生效、读放行，故 tmpdir 路径可直接读回。
//
// tmpdir 对宿主进程天然可写；写盘失败只可能是磁盘满 / 只读 FS 等极端 I/O 错误，
// 属真实故障——不吞不兜底，直接抛给上层 route 返回 FETCH_FAILED。
const FETCH_FULL_CONTENT_DIR = 'tabtin-fetch-results';

async function persistFullContent(content: string): Promise<string> {
  const dir = join(tmpdir(), FETCH_FULL_CONTENT_DIR);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `fetch-${randomUUID()}.txt`);
  await writeFile(file, content, 'utf8');
  return file;
}

// ── Pipeline 主入口 ──────────────────────────────────────────

export async function executeFetchPipeline(
  opts: FetchPipelineOptions,
): Promise<FetchPipelineResult> {
  const {
    url,
    timeout = 30_000,
    headers,
    format = 'markdown',
    selector,
    autoFallback = true,
    maxLength,
  } = opts;

  const overallTimeout = Math.min(timeout * 1.5, 60_000);
  const startTime = Date.now();

  // ── 1. HTTP 抓取（含 1 次重试）──────────────────────────

  const api = resolveHttpCrawlAPI();
  if (!api?.fetch) {
    return {
      success: false,
      url,
      title: '',
      content: '',
      contentType: '',
      statusCode: 0,
      responseTimeMs: 0,
      truncated: false,
      quality: { ok: false, reason: 'empty', message: 'HTTP crawl API not available' },
      fallbackUsed: 'none',
      error: 'HTTP crawl API not available',
    };
  }

  let httpResult: HttpFetchResult;
  try {
    httpResult = await fetchWithRetry(api.fetch, { url, timeout, headers });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      url,
      title: '',
      content: '',
      contentType: '',
      statusCode: 0,
      responseTimeMs: Date.now() - startTime,
      truncated: false,
      quality: { ok: false, reason: 'empty', message: errMsg },
      fallbackUsed: 'none',
      error: errMsg,
    };
  }

  // ── 2. CSS 选择器过滤 ──────────────────────────────────

  let rawHtml = httpResult.rawContent;

  let selectorMatched: boolean | undefined;
  if (selector && httpResult.contentType.includes('text/html')) {
    try {
      const $ = cheerio.load(rawHtml);
      const matched = $(selector);
      selectorMatched = matched.length > 0;
      if (selectorMatched) {
        rawHtml = matched.map((_, el) => $.html(el)).get().join('\n');
      } else {
        console.warn(`[fetch_pipeline] CSS selector "${selector}" matched 0 elements, using full document`);
      }
    } catch {
      selectorMatched = false;
    }
  }

  // ── 3. 内容提取 + 质量校验 ─────────────────────────────
  let title = httpResult.title;
  let fallbackUsed: 'none' | 'browser' = 'none';

  const isHtml = httpResult.contentType.includes('text/html');

  let markdownContent = '';
  if (isHtml) {
    const extracted = await extractReadableContent(rawHtml, httpResult.finalUrl);
    markdownContent = extracted.content;
    title = extracted.title || title;
  } else {
    markdownContent = rawHtml;
  }

  let quality = validateContentQuality(markdownContent, rawHtml, httpResult.statusCode);

  // ── 4. 浏览器降级 ─────────────────────────────────────

  if (autoFallback && !quality.ok && isHtml) {
    const elapsed = Date.now() - startTime;
    const remaining = overallTimeout - elapsed;

    if (remaining > 2000) {
      const fallback = await tryBrowserFallback(httpResult.finalUrl, remaining);

      if (fallback) {
        const fbExtracted = await extractReadableContent(fallback.rawHtml, httpResult.finalUrl);
        const fbQuality = validateContentQuality(
          fbExtracted.content,
          fallback.rawHtml,
          httpResult.statusCode,
        );

        const shouldUseFallback =
          fbQuality.ok ||
          (!quality.ok && fbExtracted.content.length > markdownContent.length);

        if (shouldUseFallback) {
          rawHtml = fallback.rawHtml;
          markdownContent = fbExtracted.content;
          title = fbExtracted.title || fallback.title || title;
          quality = fbQuality;
          fallbackUsed = 'browser';
        }
      }
    }
  }

  // ── 5. format 路由 ────────────────────────────────────

  let content: string;
  let links: ExtractedLink[] | undefined;
  let images: string[] | undefined;

  if (!isHtml || format === 'markdown') {
    content = isHtml ? markdownContent : rawHtml;
  } else {
    const formatted = await applyFormat(rawHtml, httpResult.finalUrl, format);
    content = formatted.content;
    links = formatted.links;
    images = formatted.images;
  }

  // ── 6. 质量提示 ────────────────────────────────────────
  // 质量信息通过结构化 quality 字段传递，不嵌入正文。
  // 调用方（Django / CLI）可根据 quality.ok 和 quality.suggestion 自行决定展示方式。

  // ── 7. 截断 ───────────────────────────────────────────

  let truncated = false;
  let fullContentPath: string | undefined;
  let contentLength: number | undefined;
  if (maxLength && content.length > maxLength) {
    contentLength = content.length;
    fullContentPath = await persistFullContent(content);
    truncated = true;
    if (!isHtml) {
      // 结构化原始内容（application/json 等）从中间截断会损坏、无法解析，inline 一大坨
      // 截断体既没用又会把 envelope 撑大触发上游 run_terminal_command 二次摘要，把
      // truncated / full_content_path 字段折叠掉。故不 inline 截断体，只放简短指针，
      // 让 envelope 保持小、结构化字段直接可见，Agent 一步直达完整文件。
      content =
        `[Structured content not inlined: ${contentLength} chars would be corrupted by mid-string truncation. `
        + `Full content saved to ${fullContentPath} — read it with read_file (offset/limit) or filter with jq.]`;
    } else {
      // HTML / markdown 正文：前 N 字符对 LLM 阅读仍有价值，保留 inline 头部。
      content = content.slice(0, maxLength)
        + `\n\n[... truncated at ${maxLength} of ${contentLength} chars. `
        + `Full ${contentLength} chars saved to ${fullContentPath} — use read_file (with offset/limit) to read the untruncated content in sections.]`;
    }
  }

  if (!quality.ok) {
    const errorParts: string[] = [];
    if (quality.reason) errorParts.push(`[${quality.reason}]`);
    if (quality.message) errorParts.push(quality.message);
    if (quality.suggestion) errorParts.push(quality.suggestion);
    return {
      success: false,
      url: httpResult.finalUrl,
      title,
      content: '',
      contentType: httpResult.contentType,
      statusCode: httpResult.statusCode,
      responseTimeMs: Date.now() - startTime,
      truncated: false,
      quality,
      fallbackUsed,
      error: errorParts.join(' — ') || 'Content quality check failed',
    };
  }

  return {
    success: true,
    url: httpResult.finalUrl,
    title,
    content,
    contentType: httpResult.contentType,
    statusCode: httpResult.statusCode,
    responseTimeMs: Date.now() - startTime,
    truncated,
    quality,
    fallbackUsed,
    links,
    images,
    contentLength,
    fullContentPath,
  };
}
