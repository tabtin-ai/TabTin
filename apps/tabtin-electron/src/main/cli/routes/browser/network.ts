import http from 'node:http';
import type { SendJSON, ActionExecutor } from './_helpers';
import {
  buildBrowserRequestScope,
  resolveTabId,
  makeTaskId,
  sendExecutorResult,
  errorResponse,
} from './_helpers';
import {
  analyzeBrowserNetworkToOpenApi,
  normalizeBrowserNetworkEntries,
} from '@tabtin/browser-core';
import { okResponse } from '@tabtin/agent-wire';

function flag(body: any, camel: string, snake: string): boolean | undefined {
  if (typeof body?.[camel] === 'boolean') return body[camel];
  if (typeof body?.[snake] === 'boolean') return body[snake];
  return undefined;
}

// CLI 经 kebabToSnake 发 snake_case（url_pattern / rule_id / tab_id / run_id），
// FC / 旧调用方发 camelCase；两种都收，取第一个非空字符串。
function str(body: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = body?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export async function handleNetworkRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<boolean> {
  const requestScope = buildBrowserRequestScope(body);
  if (route === '/route') {
    const urlPattern = str(body, 'urlPattern', 'url_pattern');
    if (!urlPattern) {
      sendJSON(
        res,
        400,
        errorResponse('VALIDATION_ERROR', '缺少 urlPattern 参数', {
          suggestions: [
            '示例: tabtin browser route --url-pattern "**/*.png" --status 403',
          ],
        }),
      );
      return true;
    }
    const runId = str(body, 'runId', 'run_id');
    const tabId = await resolveTabId(str(body, 'tabId', 'tab_id'), requestScope);
    const result = await executor({
      task_id: makeTaskId('route'),
      type: 'browser_route',
      params: {
        urlPattern,
        status: body?.status,
        body: body?.body,
        headers: body?.headers,
        crawlTabId: tabId,
        ...(runId ? { runId } : {}),
      },
      thread_id: '',
    });
    sendExecutorResult(result, res, sendJSON);
    return true;
  }

  if (route === '/route-list') {
    const runId = str(body, 'runId', 'run_id');
    const tabId = await resolveTabId(str(body, 'tabId', 'tab_id'), requestScope);
    const result = await executor({
      task_id: makeTaskId('route-list'),
      type: 'browser_route_list',
      params: { crawlTabId: tabId, ...(runId ? { runId } : {}) },
      thread_id: '',
    });
    sendExecutorResult(result, res, sendJSON);
    return true;
  }

  if (route === '/unroute') {
    const ruleId = str(body, 'ruleId', 'rule_id');
    const urlPattern = str(body, 'urlPattern', 'url_pattern');
    const routeKey = ruleId ?? urlPattern;
    if (!routeKey) {
      sendJSON(
        res,
        400,
        errorResponse('VALIDATION_ERROR', '缺少 ruleId 或 urlPattern 参数', {
          suggestions: [
            '使用 tabtin browser route-list 查看已添加的拦截规则，再用 --rule-id 取消',
            '或使用注册时的模式取消: tabtin browser unroute --url-pattern "**/*.png"',
          ],
        }),
      );
      return true;
    }
    const runId = str(body, 'runId', 'run_id');
    const tabId = await resolveTabId(str(body, 'tabId', 'tab_id'), requestScope);
    const result = await executor({
      task_id: makeTaskId('unroute'),
      type: 'browser_unroute',
      params: {
        ...(ruleId ? { ruleId } : {}),
        ...(urlPattern ? { urlPattern } : {}),
        crawlTabId: tabId,
        ...(runId ? { runId } : {}),
      },
      thread_id: '',
    });
    sendExecutorResult(result, res, sendJSON);
    return true;
  }

  if (route === '/network') {
    const tabId = await resolveTabId(body?.tabId ?? body?.tab_id, requestScope);
    const result = await executor({
      task_id: makeTaskId('network'),
      type: 'browser_network',
      params: {
        filter: body?.filter,
        crawlTabId: tabId,
        ...(body?.runId || body?.run_id
          ? { runId: body.runId ?? body.run_id }
          : {}),
        ...(flag(body, 'includeRequestHeaders', 'include_request_headers') !==
        undefined
          ? {
              includeRequestHeaders: flag(
                body,
                'includeRequestHeaders',
                'include_request_headers',
              ),
            }
          : {}),
        ...(flag(body, 'includeRequestBody', 'include_request_body') !==
        undefined
          ? {
              includeRequestBody: flag(
                body,
                'includeRequestBody',
                'include_request_body',
              ),
            }
          : {}),
        ...(flag(body, 'includeResponseHeaders', 'include_response_headers') !==
        undefined
          ? {
              includeResponseHeaders: flag(
                body,
                'includeResponseHeaders',
                'include_response_headers',
              ),
            }
          : {}),
        ...(flag(body, 'includeResponseBody', 'include_response_body') !==
        undefined
          ? {
              includeResponseBody: flag(
                body,
                'includeResponseBody',
                'include_response_body',
              ),
            }
          : {}),
      },
      thread_id: '',
    });
    sendExecutorResult(result, res, sendJSON);
    return true;
  }

  if (route === '/network/to-api') {
    const title = str(body, 'title');
    const version = str(body, 'version');
    const rawInput = body?.input ?? body?.entries ?? body?.network;

    let entriesInput: unknown = rawInput;
    if (typeof rawInput === 'string' && rawInput.trim()) {
      try {
        entriesInput = JSON.parse(rawInput);
      } catch {
        sendJSON(
          res,
          400,
          errorResponse(
            'VALIDATION_ERROR',
            'input 必须是 JSON 字符串或 network JSON 文件内容',
            {
              suggestions: [
                '示例: tabtin browser network --format json > network.json',
                '再运行: tabtin browser network to-api --input @network.json',
              ],
            },
          ),
        );
        return true;
      }
    }

    if (
      entriesInput === undefined ||
      entriesInput === null ||
      (typeof entriesInput === 'string' && entriesInput.trim() === '')
    ) {
      const tabId = await resolveTabId(body?.tabId ?? body?.tab_id, requestScope);
      const result = await executor({
        task_id: makeTaskId('network-to-api'),
        type: 'browser_network',
        params: {
          filter: body?.filter,
          crawlTabId: tabId,
          ...(body?.runId || body?.run_id
            ? { runId: body.runId ?? body.run_id }
            : {}),
          includeRequestHeaders: false,
          includeResponseHeaders: false,
          includeRequestBody: true,
          includeResponseBody: true,
        },
        thread_id: '',
      });
      if (result.success === false) {
        sendExecutorResult(result, res, sendJSON);
        return true;
      }
      entriesInput = result.data ?? [];
    }

    const entries = normalizeBrowserNetworkEntries(entriesInput);
    const spec = analyzeBrowserNetworkToOpenApi(entries, { title, version });
    sendJSON(res, 200, okResponse(spec));
    return true;
  }

  if (route === '/console') {
    const tabId = await resolveTabId(body?.tabId, requestScope);
    const result = await executor({
      task_id: makeTaskId('console'),
      type: 'browser_console',
      params: {
        level: body?.level,
        crawlTabId: tabId,
        ...(body?.runId ? { runId: body.runId } : {}),
      },
      thread_id: '',
    });
    sendExecutorResult(result, res, sendJSON);
    return true;
  }

  return false;
}
