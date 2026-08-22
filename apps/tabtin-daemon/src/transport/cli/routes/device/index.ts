/**
 * Device route handler for Daemon CLI Server.
 *
 * Proxies device capability queries to Django backend.
 */

import http from 'node:http';
import type { CliRequestContext } from '../../cli-context.js';
import { djangoRequest, errorResponse, okResponse, type SendJSON } from '../shared/error-handler.js';

function getSpaceId(body: any, context: CliRequestContext): string | null {
  if (body?.space_id) return body.space_id;
  return context.getSpaceId();
}

const ACTION_MAP: Record<string, string> = {
  '/info': 'get_device_info',
  '/battery': 'get_battery_info',
  '/network': 'get_network_info',
};

function mapBackendErrorCode(status: number, backendCode?: string): string {
  if (backendCode === 'VALIDATION_ERROR') return 'VALIDATION_ERROR';
  if (backendCode === 'NOT_FOUND') return 'NOT_FOUND';
  if (backendCode === 'TASK_TIMEOUT') return 'TASK_TIMEOUT';
  if (backendCode === 'PERMISSION_DENIED') return 'PERMISSION_DENIED';
  if (backendCode?.startsWith('DEVICE_RUNTIME_')) return 'TASK_FAILED';
  if (backendCode === 'DEVICE_ACTION_DELIVERY_FAILED') return 'UNAVAILABLE';
  if (status === 400 || status === 422) return 'VALIDATION_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 504) return 'TASK_TIMEOUT';
  if (status === 409) return 'TASK_FAILED';
  return 'UNAVAILABLE';
}

function buildSuggestions(status: number, backendCode?: string): string[] {
  if (backendCode === 'VALIDATION_ERROR' || status === 400 || status === 422) {
    return [
      '请在 Space 终端中执行该命令，或显式传入 --space-id',
      '可先运行 tabtin capabilities discover "device battery" 查看相关能力入口',
    ];
  }
  if (backendCode === 'NOT_FOUND' || status === 404) {
    return ['请确认 --space-id 对应的 Space 仍存在且属于当前工作空间'];
  }
  if (backendCode === 'PERMISSION_DENIED') {
    return ['请确认当前账号对该 Space 具有访问权限'];
  }
  if (backendCode?.startsWith('DEVICE_RUNTIME_')) {
    return [
      '确保当前 Space 所在工作空间里有在线的能力设备',
      '确认移动端已完成 device_runtime 登录并订阅当前工作空间',
    ];
  }
  return [];
}

export async function handleDeviceRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  const route = url.replace(/^\/device/, '');
  const action = ACTION_MAP[route];

  if (method !== 'POST' || !action) {
    sendJSON(res, 404, errorResponse('NOT_FOUND', `Unknown device route: ${url}`));
    return;
  }

  const spaceId = getSpaceId(body, cliContext);
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id', {
      suggestions: ['请在 Space 终端中执行该命令，或显式传入 --space-id'],
    }));
    return;
  }

  const MAX_TIMEOUT_SECONDS = 300;
  const rawTimeoutSeconds = Number(body?.timeout_seconds ?? 30);
  const requestedTimeoutSeconds = Number.isFinite(rawTimeoutSeconds)
    ? Math.min(rawTimeoutSeconds, MAX_TIMEOUT_SECONDS)
    : 30;
  const requestTimeoutMs = Math.max(30_000, requestedTimeoutSeconds * 1000 + 5_000);

  const result = await djangoRequest('POST', '/api/tabtinspace/devices/query', {
    space_id: spaceId,
    action,
    timeout_seconds: requestedTimeoutSeconds,
  }, {
    timeout: requestTimeoutMs,
  });

  if (result.status >= 400 || result.data?.success === false) {
    sendDeviceError(res, sendJSON, result);
    return;
  }

  // Wave 4b 复核修复：Django `/api/tabtinspace/devices/query` 通过 success_response
  // 包一层，HTTP body 形如 `{success, data: {success, data: 真实数据}}`；
  // 这里解一层（与 Electron `device.ts` 对齐）让客户端拿到的是
  // service 层 dispatch_space_action 的 dict，后续 result.data?.data 即真实结果。
  sendJSON(res, 200, okResponse(result.data?.data ?? result.data));
}

function sendDeviceError(
  res: http.ServerResponse,
  sendJSON: SendJSON,
  result: Awaited<ReturnType<typeof djangoRequest>>,
): void {
  if (result.data?.error?.code && typeof result.data.error.code === 'string') {
    sendJSON(res, result.status, result.data);
    return;
  }
  const detail = result.data?.data;
  const backendCode = result.data?.code;
  const suggestions = buildSuggestions(result.status, backendCode);
  sendJSON(res, result.status, errorResponse(
    mapBackendErrorCode(result.status, backendCode),
    result.data?.message || '设备能力查询失败',
    {
      detail,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    },
  ));
}
