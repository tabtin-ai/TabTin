/**
 * /workspace/* — 代理到 Django 的 Workspace 路由（ 终态）。
 *
 * 语义与老 `/space/*` 对齐但改写终态口径：`workspace list` 走 Django
 * `/api/context/workspaces`（个人域 SSoT），非 Open API `/open/v1/spaces`。
 * 数据查询相关路径（db-info / tables / db-connection）在 backend 迁移完成前
 * 仍走 Open API `spaces` 前缀，通过参数 `workspace_id`（读 body 时同时兼容
 * `space_id`）承接调用。
 */

import type { ServerResponse } from 'node:http';
import { errorResponse, sendDjangoResult, type SendJSON } from '@tabtin/cli-server-core';
import { djangoRequest, requireSpaceId, resolveSpaceId } from '../host-bindings.js';

const LOG_TAG = '[CLI Workspace]';

/**
 * body 里同时接受 `workspace_id` 与 `space_id`（ 过渡期）。
 * `workspace_id` 优先；等 backend 完成迁移、Electron / Daemon 全部改口径后
 * 可移除 `space_id` 分支。
 */
function readWorkspaceIdFromBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  if (body.workspace_id && !body.space_id) {
    return { ...body, space_id: body.workspace_id };
  }
  return body;
}

export async function handleWorkspaceRoute(
  url: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/workspace/, '');
  const normalizedBody = readWorkspaceIdFromBody(body);

  if (route === '/list' && method === 'POST') {
    // 个人域列表 SSoT：直连 Django `/api/context/workspaces`。
    const result = await djangoRequest('GET', '/context/workspaces', undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  // GET/POST /workspace/info/:id — 单个 Workspace 详情（走 Django Workspace API）
  const infoMatch = route.match(/^\/info\/([^/]+)$/);
  if (infoMatch && (method === 'GET' || method === 'POST')) {
    const workspaceId = infoMatch[1];
    const result = await djangoRequest(
      'GET',
      `/context/workspaces/${encodeURIComponent(workspaceId)}`,
      undefined,
      { logTag: LOG_TAG },
    );
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/db-info' && method === 'POST') {
    const workspaceId = requireSpaceId(normalizedBody, res, sendJSON, errorResponse);
    if (!workspaceId) return;
    const result = await djangoRequest('GET', `/open/v1/spaces/${workspaceId}/data/db-info`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/tables' && method === 'POST') {
    const workspaceId = requireSpaceId(normalizedBody, res, sendJSON, errorResponse);
    if (!workspaceId) return;
    const result = await djangoRequest('GET', `/open/v1/spaces/${workspaceId}/data/tables`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/db-connection' && method === 'POST') {
    const workspaceId = requireSpaceId(normalizedBody, res, sendJSON, errorResponse);
    if (!workspaceId) return;
    const result = await djangoRequest('GET', `/open/v1/spaces/${workspaceId}/data/db-connection`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/create-db-connection' && method === 'POST') {
    const workspaceId = requireSpaceId(normalizedBody, res, sendJSON, errorResponse);
    if (!workspaceId) return;
    const result = await djangoRequest('POST', `/open/v1/spaces/${workspaceId}/data/db-connection`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (route === '/delete-db-connection' && method === 'POST') {
    const workspaceId = requireSpaceId(normalizedBody, res, sendJSON, errorResponse);
    if (!workspaceId) return;
    const result = await djangoRequest('DELETE', `/open/v1/spaces/${workspaceId}/data/db-connection`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  // 兼容只传 workspace_id/space_id 的简单查询场景
  void resolveSpaceId(normalizedBody);

  console.warn(`${LOG_TAG} Unknown route: ${route}`);
  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `Unknown route: ${url}`));
}
