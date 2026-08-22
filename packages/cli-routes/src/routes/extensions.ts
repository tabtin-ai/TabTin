/**
 * /extensions/* — 代理到 Django 后端的扩展路由。
 *
 * Wave 7 扩展：/cli-commands 响应合并 marketplace App 声明的 CLI 命令。
 * marketplace 命令通过 handleExtensionsRoute 的 opts.marketplaceCommands 注入，
 * 由 Electron / Daemon CLI Server 在调用时提供（从本地 manifest 扫描得到）。
 * 参见 D-8：marketplace 不进 PlatformSurface registry，走 extension 机制。
 *
 * MT-001：双重路径解码以防 URL 编码绕过路径遍历检查。
 */

import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { errorResponse, sendDjangoResult, type SendJSON } from '@tabtin/cli-server-core';
import { djangoRequest } from '../host-bindings.js';

const LOG_TAG = '[CLI Extensions]';

/** handleExtensionsRoute 的可选参数 */
export interface ExtensionsRouteOptions {
  /** 本地 marketplace App 扫描结果，合并到 /cli-commands 响应 */
  marketplaceCommands?: unknown[]
}

/**
 * 反复解码 URI 组件直到稳定，防止双重编码绕过路径安全检查。
 */
function fullyDecodeURIComponent(str: string): string {
  let prev = str;
  for (;;) {
    try {
      const decoded = decodeURIComponent(prev);
      if (decoded === prev) return decoded;
      prev = decoded;
    } catch {
      return prev;
    }
  }
}

export async function handleExtensionsRoute(
  url: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
  opts?: ExtensionsRouteOptions,
): Promise<void> {
  const route = url.replace(/^\/extensions/, '');
  const routePath = route.split('?')[0];

  if (routePath === '/cli-commands' && method === 'GET') {
    const result = await djangoRequest('GET', '/extensions/cli-commands/', undefined, { logTag: LOG_TAG });

    // ── W7：合并 marketplace CLI 命令 ──────────────────────────
    // Django 返回的是后端扩展命令；本地扫描到的 marketplace 命令
    // 追加到 commands 数组里一起返回给 Go CLI。
    if (opts?.marketplaceCommands?.length && result.status < 400 && result.data) {
      try {
        const parsed = typeof result.data === 'string'
          ? JSON.parse(result.data as string) as Record<string, unknown>
          : result.data as Record<string, unknown>

        const inner = (parsed.data ?? parsed) as Record<string, unknown>
        const existingCmds = Array.isArray(inner.commands) ? inner.commands : []
        inner.commands = [...existingCmds, ...opts.marketplaceCommands]

        result.data = parsed
      } catch {
        // 解析失败不影响 Django 原始响应
      }
    }

    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (routePath.startsWith('/run/')) {
    const queryIndex = route.indexOf('?');
    const pathPart = queryIndex >= 0 ? route.substring(0, queryIndex) : route;
    const queryPart = queryIndex >= 0 ? route.substring(queryIndex) : '';

    // 双重路径安全检查：防止 URL 编码绕过路径遍历（MT-001）
    const fullyDecoded = fullyDecodeURIComponent(pathPart);
    if (fullyDecoded.includes('..') || fullyDecoded.includes('//')) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '非法路由路径'));
      return;
    }
    const normalized = path.posix.normalize(fullyDecoded);
    if (normalized !== fullyDecoded || normalized.includes('..')) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '非法路由路径'));
      return;
    }

    const djangoPath = `/extensions${pathPart}${queryPart}`;
    const result = await djangoRequest(method, djangoPath, body, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  sendJSON(res, 404, errorResponse(
    'UNKNOWN_ROUTE',
    `未知的 extensions 路由: ${url}`,
    { suggestions: ['使用 tabtin extensions --help 查看所有可用命令'] },
  ));
}
