/**
 * Host bindings — 宿主特有能力的依赖注入点。
 *
 * Electron 和 Daemon 两个 cli-server 宿主共享 routes 实现，但下列能力
 * 由各自宿主在启动时一次性注入：
 *   - djangoRequest：Django HTTP 代理（Electron 走 TokenManager / Daemon 走 proxyConfig）
 *   - getSpaceId：当前 Space 的 ID（Electron / Daemon 各自维护一份缓存）
 *   - getActionAdapter：ActionExecutor adapter（Electron: FrontendActionBridge wrapper /
 *     Daemon: createHeadlessAdapter()），用于 /code/* 路由
 *
 * 用法：宿主 cli-server.ts 在 startup 时调一次 `configureCLIRoutes({...})`，
 * 之后所有共享路由通过 module-level config 引用宿主能力，无需在每个 handler
 * 显式传递。这与 Daemon `configureDjangoProxy` / Electron `setCLIActionExecutor`
 * 等已有 setter 模式一致，迁移成本低。
 */

import type { ServerResponse } from 'node:http';
import type {
  DjangoProxyResult,
  DjangoRequestFn,
  DjangoRequestOptions,
  SendJSON,
} from '@tabtin/cli-server-core';

export type { DjangoProxyResult, DjangoRequestFn, DjangoRequestOptions };

export interface ActionExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface ActionExecutorAdapter {
  executeAction(action: { task_id: string; type: string; params: any; thread_id: string }): Promise<ActionExecutionResult>;
}

export interface CodeWorktreeAgentContext {
  sessionId: string;
  runId: string;
  toolUseId: string;
}

export type CodeWorktreeControllerResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      detail?: unknown;
    };

export interface CodeWorktreeController {
  /** 为普通 `/code/*` 命令解析当前可信 run 的会话代码根；不可信时返回 null。 */
  resolveRoot?(context: CodeWorktreeAgentContext): string | null;
  current(context: CodeWorktreeAgentContext): Promise<CodeWorktreeControllerResult>;
  list(context: CodeWorktreeAgentContext): Promise<CodeWorktreeControllerResult>;
  switch(
    context: CodeWorktreeAgentContext,
    input: { path?: unknown },
  ): Promise<CodeWorktreeControllerResult>;
  create(
    context: CodeWorktreeAgentContext,
    input: {
      path?: unknown;
      new_branch?: unknown;
      existing_branch?: unknown;
      base?: unknown;
    },
  ): Promise<CodeWorktreeControllerResult>;
}

/** Action executor 函数式接口（Electron 端 FrontendActionBridge.executeAction 实现） */
export type ActionExecutorFn = (action: {
  task_id: string;
  type: string;
  params: any;
  thread_id: string;
}) => Promise<ActionExecutionResult>;

export interface CLIRoutesHostBindings {
  /** Django HTTP 代理；用于所有 /api/* /table/* /space/* /capabilities/* /extensions/* /search 等代理路由 */
  djangoRequest: DjangoRequestFn;
  /** 当前 Space ID 取值器（fallback 链：body.space_id → body.project_id → host context） */
  getSpaceId: () => string | null;
  /**
   * /code/* 路由用。Electron 端注入 FrontendActionBridge.executeAction，
   * Daemon 端注入 createHeadlessAdapter().executeAction.bind(adapter)。
   * 缺省时 /code/* 路由会返回 SERVICE_UNAVAILABLE。
   */
  getActionExecutor?: () => ActionExecutorFn | null;
  /** 注入 _workspace_root；Electron 的 Agent 请求按可信 run 解析会话根。 */
  workspaceRootForCode?: (context?: CodeWorktreeAgentContext) => string | null;
  /** Electron-only Agent worktree orchestration. Daemon intentionally omits it. */
  getCodeWorktreeController?: () => CodeWorktreeController | null;
}

let bindings: CLIRoutesHostBindings | null = null;

export function configureCLIRoutes(b: CLIRoutesHostBindings): void {
  bindings = b;
}

export function getBindings(): CLIRoutesHostBindings {
  if (!bindings) {
    throw new Error(
      '[@tabtin/cli-routes] configureCLIRoutes() must be called before any route handler runs',
    );
  }
  return bindings;
}

/**
 * 用于 routes 内部对 djangoRequest 的便捷调用。
 *
 * **path 契约**：必须**不带** `/api` 前缀（譬如 `/tabdata/tables` 而非
 * `/api/tabdata/tables`）。Electron / Daemon 两端 djangoRequest 实现都会
 * 把 baseUrl 归一化成带 `/api` 结尾再用 `joinApiPath` 拼接，path 自带
 * `/api` 会触发 dev 告警（被自动剥前缀；详见 `@tabtin/config:joinApiPath`）。
 * 由 ESLint 规则 `tabtin/no-api-prefix-in-cli-routes` 在 PR 阶段拦截。
 */
export const djangoRequest: DjangoRequestFn = (method, path, body, opts) =>
  getBindings().djangoRequest(method, path, body, opts);

/** 用于 routes 内部读取当前 SpaceId（含 body fallback） */
export function resolveSpaceId(body?: any): string | null {
  if (body?.space_id) return body.space_id;
  if (body?.project_id) return body.project_id;
  return getBindings().getSpaceId() ?? null;
}

export function requireSpaceId(
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
  errorResponse: (code: string, message: string, opts?: any) => any,
): string | null {
  const id = resolveSpaceId(body);
  if (!id) {
    sendJSON(
      res,
      400,
      errorResponse(
        'VALIDATION_ERROR',
        '缺少 space_id。请设置 TABTIN_SPACE_ID 环境变量，或在请求中传入 space_id / project_id',
      ),
    );
  }
  return id;
}

export function requireTableId(
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
  errorResponse: (code: string, message: string, opts?: any) => any,
): string | null {
  const id = body?.table_id;
  if (!id) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 table_id 参数'));
  }
  return id;
}
