/**
 * Shared error handling utilities and Django HTTP proxy for Daemon CLI routes.
 *
 * Uses @tabtin/cli-server-core for common error types and response builders.
 * The Django proxy uses Daemon's config (server_url + credential) injected
 * via `configureDjangoProxy`.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { okResponse } from '@tabtin/agent-wire';
import { deriveApiBaseUrl, joinApiPath } from '@tabtin/config';
import {
  type ErrorCode,
  type SendJSON,
  type DjangoProxyResult,
  decodeDjangoProxyBody,
  errorResponse,
  sendDjangoResult,
} from '@tabtin/cli-server-core';

export { okResponse };
export { errorResponse, sendDjangoResult };
export type { ErrorCode, SendJSON, DjangoProxyResult };

// ── Django HTTP proxy ────────────────────────────────────────────

export interface ProxyConfig {
  serverUrl: string;
  credential: string;
  organizationId: string;
}

export class DjangoProxy {
  private config: ProxyConfig | null = null;

  configure(config: ProxyConfig): void {
    this.config = { ...config };
  }

  updateCredential(credential: string): void {
    if (this.config) this.config.credential = credential;
  }

  dispose(): void {
    this.config = null;
  }

  request(
    method: string,
    path: string,
    body?: any,
    opts?: DjangoRequestOptions,
  ): Promise<DjangoProxyResult> {
    return executeDjangoRequest(this.config, method, path, body, opts);
  }
}

const defaultDjangoProxy = new DjangoProxy();

export function configureDjangoProxy(config: ProxyConfig): void {
  defaultDjangoProxy.configure(config);
}

export function updateDjangoProxyCredential(credential: string): void {
  defaultDjangoProxy.updateCredential(credential);
}

export function clearDjangoProxy(): void {
  defaultDjangoProxy.dispose();
}

const DEFAULT_TIMEOUT = 30_000;
const ABSOLUTE_TIMEOUT_MULTIPLIER = 3;
const ABSOLUTE_TIMEOUT_MAX_MS = 300_000;

export interface DjangoRequestOptions {
  logTag?: string;
  timeout?: number;
  extraHeaders?: Record<string, string>;
}

export function djangoRequest(
  method: string,
  path: string,
  body?: any,
  opts?: DjangoRequestOptions,
): Promise<DjangoProxyResult> {
  return defaultDjangoProxy.request(method, path, body, opts);
}

async function executeDjangoRequest(
  proxyConfig: ProxyConfig | null,
  method: string,
  path: string,
  body?: any,
  opts?: DjangoRequestOptions,
): Promise<DjangoProxyResult> {
  const logTag = opts?.logTag ?? '[CLI]';
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

  if (!proxyConfig) {
    return {
      status: 503,
      data: errorResponse('INTERNAL_ERROR', 'Django proxy 尚未配置'),
    };
  }

  const { serverUrl, credential, organizationId } = proxyConfig;

  if (!credential) {
    return {
      status: 401,
      data: errorResponse('UNAUTHORIZED', '未配置认证凭据'),
    };
  }

  // 把原始 server_url（约定不带 /api 后缀，譬如 https://api.example.com）归一成
  // canonical apiBaseUrl（带 /api 结尾），与 Electron 端一致。path 契约要求不带
  // /api 前缀；joinApiPath 会兜底处理误带前缀的情况并在 dev 环境告警，详见
  // @tabtin/config 与 packages/cli-routes/src/bootstrap-bindings.ts 的 djangoRequest export 注释。
  const apiBaseUrl = deriveApiBaseUrl(serverUrl);
  const fullUrl = joinApiPath(apiBaseUrl, path);

  const url = new URL(fullUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const bodyStr = body ? JSON.stringify(body) : undefined;

  const absoluteTimeout = Math.min(timeout * ABSOLUTE_TIMEOUT_MULTIPLIER, ABSOLUTE_TIMEOUT_MAX_MS);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: DjangoProxyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      resolve(value);
    };

    const absoluteTimer = setTimeout(() => {
      req.destroy();
      settle({
        status: 504,
        data: errorResponse('CONNECTION_TIMEOUT', `后端请求绝对超时 (${absoluteTimeout / 1000}s): ${method} ${path}`, {
          detail: { method, path, timeout_ms: absoluteTimeout, type: 'absolute' },
        }),
      });
    }, absoluteTimeout);

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential}`,
          ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
          // TD-1/H-2：透传 CLI 带来的 Agent run/session 上下文头给 Django。
          ...(opts?.extraHeaders ?? {}),
          ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (err) => {
          console.error(`${logTag} Response stream error:`, err.message);
          settle({
            status: 502,
            data: errorResponse('UNAVAILABLE', `响应流传输失败: ${err.message}`, {
              detail: { system_error: (err as NodeJS.ErrnoException).code, path },
            }),
          });
        });
        res.on('end', () => {
          const contentType = res.headers['content-type'] || '';
          const raw = Buffer.concat(chunks);
          const statusCode = res.statusCode ?? 500;

          if (statusCode === 401) {
            settle({
              status: 401,
              data: errorResponse('AUTH_EXPIRED', '认证已过期，请重新初始化 Daemon', {
                detail: { method, path },
                suggestions: ['运行 tabtin-daemon init 重新配置认证'],
              }),
            });
            return;
          }

          // : 与 Electron 共用 decodeDjangoProxyBody，避免宿主分叉再丢二进制分支。
          settle({
            status: statusCode,
            data: decodeDjangoProxyBody(contentType, raw),
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      settle({
        status: 504,
        data: errorResponse('CONNECTION_TIMEOUT', `后端请求超时 (${timeout / 1000}s): ${method} ${path}`, {
          detail: { method, path, timeout_ms: timeout },
        }),
      });
    });

    req.on('error', (err) => {
      console.error(`${logTag} Django request error:`, err.message);
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ECONNREFUSED') {
        settle({
          status: 502,
          data: errorResponse('CONNECTION_REFUSED', '无法连接到 Django 后端，请确保后端服务正在运行', {
            detail: { system_error: errCode, path },
          }),
        });
      } else {
        settle({
          status: 502,
          data: errorResponse('UNAVAILABLE', `后端连接失败: ${err.message}`, {
            detail: { system_error: errCode, path },
          }),
        });
      }
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
