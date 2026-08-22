/**
 * /fetch — 轻量 HTTP fetch + 内容抽取。
 *
 * 委托 @tabtin/action-tools/headless 的 executeFetchPipeline。
 * Electron / Daemon 行为完全一致；不依赖宿主特有能力。
 */

import type { ServerResponse } from 'node:http';
import { errorResponse, okResponse, type SendJSON } from '@tabtin/cli-server-core';
import { executeFetchPipeline } from '@tabtin/action-tools/headless';

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface FetchRouteFailureInput {
  error?: string;
  quality?: {
    ok?: boolean;
    reason?: string;
    message?: string;
    suggestion?: string;
  };
}

export function buildFetchFailureEnvelope(targetUrl: string, result: FetchRouteFailureInput) {
  const suggestions = result.quality?.suggestion
    ? [result.quality.suggestion]
    : ['检查 URL 是否可访问', '使用 tabtin browser open <url> 打开后再提取'];
  return errorResponse('FETCH_FAILED', result.error || 'Fetch failed', {
    detail: { url: targetUrl, quality: result.quality },
    suggestions,
  });
}

export function buildFetchSuccessEnvelope(result: {
  content: string;
  title: string;
  url: string;
  quality: FetchRouteFailureInput['quality'];
  fallbackUsed: string;
  links?: unknown;
  images?: unknown;
  truncated?: boolean;
  contentLength?: number;
  fullContentPath?: string;
}) {
  return okResponse({
    content: result.content,
    title: result.title,
    url: result.url,
    wordCount: result.content.split(/\s+/).filter(Boolean).length,
    quality: result.quality,
    fallback_used: result.fallbackUsed,
    ...(result.truncated ? { truncated: true } : {}),
    ...(typeof result.contentLength === 'number' ? { content_length: result.contentLength } : {}),
    ...(result.fullContentPath ? { full_content_path: result.fullContentPath } : {}),
    ...(result.links ? { links: result.links } : {}),
    ...(result.images ? { images: result.images } : {}),
  });
}

export async function handleFetchRoute(
  _url: string,
  _method: string,
  body: Record<string, any> | undefined,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const targetUrl = body?.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 url 参数', {
      suggestions: ['tabtin fetch "https://example.com"'],
    }));
    return;
  }

  if (!isSafeUrl(targetUrl)) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `不允许的 URL 协议: ${targetUrl}。仅支持 http/https`, {
      suggestions: ['使用 https:// 或 http:// 开头的 URL'],
    }));
    return;
  }

  try {
    const result = await executeFetchPipeline({
      url: targetUrl,
      timeout: body?.timeout || 30_000,
      headers: body?.headers,
      format: body?.format || 'markdown',
      autoFallback: body?.auto_fallback !== false,
      maxLength: body?.max_length || 50_000,
    });

    if (!result.success) {
      sendJSON(res, 200, buildFetchFailureEnvelope(targetUrl, result));
      return;
    }

    sendJSON(res, 200, buildFetchSuccessEnvelope(result));
  } catch (error: any) {
    sendJSON(res, 500, errorResponse('FETCH_FAILED', error?.message || 'Fetch failed', {
      suggestions: ['检查 URL 是否可访问', '使用 tabtin browser open <url> 打开后再提取'],
    }));
  }
}
