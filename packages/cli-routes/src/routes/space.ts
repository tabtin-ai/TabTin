/**
 * /space/* — 兼容入口；宿主列表/详情与 workspace.ts 对齐走 Django
 * `/context/workspaces`（个人域 SSoT）。db-* 数据查询仍走 Open API
 * `/open/v1/spaces/.../data/...`。
 */

import type { ServerResponse } from 'node:http';
import { errorResponse, sendDjangoResult, type SendJSON } from '@tabtin/cli-server-core';
import { djangoRequest, requireSpaceId, resolveSpaceId } from '../host-bindings.js';

const LOG_TAG = '[CLI Space]';

export async function handleSpaceRoute(
  url: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/space/, '');

  if (route === '/list' && method === 'POST') {
    const result = await djangoRequest('GET', '/context/workspaces', undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  // MT-006: GET/POST /space/info/:id — 获取单个 Workspace 详情（个人域 SSoT）
  const infoMatch = route.match(/^\/info\/([^/]+)$/);
  if (infoMatch && (method === 'GET' || method === 'POST')) {
    const spaceId = infoMatch[1];
    const result = await djangoRequest(
      'GET',
      `/context/workspaces/${encodeURIComponent(spaceId)}`,
      undefined,
      { logTag: LOG_TAG },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/db-info' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON, errorResponse);
    if (!spaceId) return;
    const result = await djangoRequest('GET', `/open/v1/spaces/${spaceId}/data/db-info`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/tables' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON, errorResponse);
    if (!spaceId) return;
    const result = await djangoRequest('GET', `/open/v1/spaces/${spaceId}/data/tables`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/db-connection' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON, errorResponse);
    if (!spaceId) return;
    const result = await djangoRequest('GET', `/open/v1/spaces/${spaceId}/data/db-connection`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/create-db-connection' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON, errorResponse);
    if (!spaceId) return;
    const result = await djangoRequest('POST', `/open/v1/spaces/${spaceId}/data/db-connection`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/delete-db-connection' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON, errorResponse);
    if (!spaceId) return;
    const result = await djangoRequest('DELETE', `/open/v1/spaces/${spaceId}/data/db-connection`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  // 兼容只传 space_id 的简单查询场景
  void resolveSpaceId(body);

  console.warn(`${LOG_TAG} Unknown route: ${route}`);
  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `Unknown route: ${url}`));
}
