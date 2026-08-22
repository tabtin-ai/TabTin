/**
 * /capabilities/* — 代理到 Django 后端的能力查询路由。
 */

import type { ServerResponse } from 'node:http';
import { errorResponse, sendDjangoResult, type SendJSON } from '@tabtin/cli-server-core';
import { djangoRequest } from '../host-bindings.js';

const LOG_TAG = '[CLI Capabilities]';

export async function handleCapabilitiesRoute(
  url: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/capabilities/, '');
  const routePath = route.split('?')[0];
  const queryString = url.includes('?') ? url.slice(url.indexOf('?')) : '';

  if ((routePath === '/tools' || routePath === '/tools/') && method === 'GET') {
    const result = await djangoRequest('GET', `/capabilities/tools${queryString}`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  const toolDetailMatch = routePath.match(/^\/tools\/([^/]+)$/);
  if (toolDetailMatch && method === 'GET') {
    const toolName = decodeURIComponent(toolDetailMatch[1]);
    const result = await djangoRequest('GET', `/capabilities/tools/${toolName}`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  const toolSkillsMatch = routePath.match(/^\/tools\/([^/]+)\/skills$/);
  if (toolSkillsMatch && method === 'GET') {
    const toolName = decodeURIComponent(toolSkillsMatch[1]);
    const result = await djangoRequest('GET', `/capabilities/tools/${toolName}/skills`, undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (routePath === '/categories' && method === 'GET') {
    const result = await djangoRequest('GET', '/capabilities/categories', undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (routePath === '/providers' && method === 'GET') {
    const result = await djangoRequest('GET', '/capabilities/providers', undefined, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (routePath === '/discover' && method === 'POST') {
    const result = await djangoRequest('POST', '/capabilities/discover', body, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  if (routePath === '/tools/search' && method === 'POST') {
    const result = await djangoRequest('POST', '/capabilities/tools/search', body, { logTag: LOG_TAG });
    sendDjangoResult(res, sendJSON, result);
    return;
  }

  sendJSON(res, 404, errorResponse(
    'UNKNOWN_ROUTE',
    `未知的 capabilities 路由: ${url}`,
    { suggestions: ['使用 tabtin capabilities --help 查看所有可用命令'] },
  ));
}
