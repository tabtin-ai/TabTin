/**
 * 共享路由 handler 的类型定义。
 *
 * 这些类型抽象了 Electron 和 Daemon 之间的差异，
 * 让路由 handler 可以在两端复用。
 */

import type http from 'node:http';

export type SendJSON = (res: http.ServerResponse, status: number, data: unknown) => void;

export type RouteHandler = (
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
) => Promise<void>;

/**
 * Django HTTP 请求代理 — 由宿主运行时注入认证逻辑。
 *
 * Electron 通过 JWT（TokenManager）认证；
 * Daemon 通过设备凭证（configureDjangoProxy）认证。
 * 路由 handler 不感知具体认证方式。
 */
export type DjangoRequestFn = (
  method: string,
  path: string,
  body?: any,
  opts?: { logTag?: string; timeout?: number },
) => Promise<{ status: number; data: any }>;

/** WS 事件发布器 — 用于推送异步任务进度到客户端 */
export type EventPublisher = (type: string, payload: Record<string, unknown>) => void;
