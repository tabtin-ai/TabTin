/**
 * Unified Search route — TabTin 统一搜索。
 *
 * 路由：GET /search?q=xxx&organization_id=yyy&types=...
 * 行为：直接转发到 Django GET /api/search，1:1 透传 query 参数。
 *
 * 设计取舍：
 *   1. 不重复实现 fts-api 客户端：CLI 走 cli-server，转发到 Django 同一个 /api/search，
 *      上行的鉴权 / 降级 / ACL / RRF 全部由后端统一处理。
 *   2. 不在路由层格式化为人类可读：人类可读输出由 Go CLI（cmd/search.go）负责，
 *      本层只是中继；这样保留 jq 管道友好（HTTP body 始终是 JSON）。
 *   3. 降级语义透传：本端点不把 degraded=true 当成错误，HTTP 仍 200，
 *      让上层 CLI 根据 degraded_reason 决定 stderr 警告。
 */

import type { ServerResponse } from 'node:http';
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core';
import { djangoRequest } from '../host-bindings.js';

const LOG_TAG = '[CLI Search]';

const ALLOWED_QUERY_PARAMS = new Set([
  'q',
  'organization_id',
  'types',
  'item_type',
  'space_id',
  'agent_id',
  'creator_type',
  'role',
  'created_after',
  'created_before',
  'limit',
  'offset',
  'mode',
]);

export async function handleSearchRoute(
  url: string,
  method: string,
  _body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  if (method !== 'GET') {
    sendJSON(
      res,
      405,
      errorResponse('VALIDATION_ERROR', `不支持的方法: ${method}（搜索仅支持 GET）`, {
        suggestions: ['使用 GET 方法调用 /search'],
      }),
    );
    return;
  }

  const queryStart = url.indexOf('?');
  if (queryStart < 0) {
    sendJSON(
      res,
      400,
      errorResponse('VALIDATION_ERROR', '搜索 query 缺失：必须传 q', {
        suggestions: ['示例：tabtin search "Python 性能优化" --organization=<id>'],
      }),
    );
    return;
  }

  const incomingParams = new URLSearchParams(url.slice(queryStart + 1));
  const sanitized = new URLSearchParams();

  // 每个 key 只取第一个值，丢弃多值，防止后端 ninja 收到多值 422
  const seenKeys = new Set<string>();
  for (const key of incomingParams.keys()) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (!ALLOWED_QUERY_PARAMS.has(key)) continue;
    const all = incomingParams.getAll(key);
    const value = (all[0] ?? '').trim();
    if (value === '') continue;
    sanitized.set(key, value);
  }

  const q = sanitized.get('q');
  if (!q || !q.trim()) {
    sendJSON(
      res,
      400,
      errorResponse('VALIDATION_ERROR', '搜索 q 不能为空', {
        suggestions: ['示例：tabtin search "Python 性能优化" --organization=<id>'],
      }),
    );
    return;
  }

  // organization_id 兜底：fts API 从 SearchParams.organization_id 读取（query 参数）
  if (!sanitized.get('organization_id')) {
    const fallback = process.env.TABTIN_ORGANIZATION_ID;
    if (fallback && fallback.trim()) {
      sanitized.set('organization_id', fallback.trim());
    }
  }
  if (!sanitized.get('organization_id')) {
    sendJSON(
      res,
      400,
      errorResponse('VALIDATION_ERROR', 'organization_id 缺失：CLI 无法推断当前 Organization', {
        suggestions: [
          '显式传 --organization=<id>',
          '或先 tabtin auth login 让 CLI 拿到登录态默认 organization',
        ],
      }),
    );
    return;
  }

  const targetPath = `/search?${sanitized.toString()}`;
  const result = await djangoRequest('GET', targetPath, undefined, { logTag: LOG_TAG });

  // 透传 Django 响应体（含降级元数据）
  sendJSON(res, result.status, result.data);
}
