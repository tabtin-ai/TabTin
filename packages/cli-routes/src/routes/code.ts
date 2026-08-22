/**
 * /code/* — 文件 / 代码操作路由。
 *
 * 通过 host bindings 注入的 actionExecutor 派发到 action-tools。
 * Electron 注入 FrontendActionBridge.executeAction，Daemon 注入
 * createHeadlessAdapter().executeAction。
 */

import type { ServerResponse } from 'node:http';
import { errorResponse, okResponse, type SendJSON } from '@tabtin/cli-server-core';
import { getBindings } from '../host-bindings.js';
import type { CodeWorktreeAgentContext, CodeWorktreeControllerResult } from '../host-bindings.js';

let taskCounter = 0;

function makeTaskId(sub: string): string {
  return `cli-code-${sub}-${++taskCounter}`;
}

// W1（2026-05）：`git_status` / `git_diff` 已从 action-tools 移除——
// LLM 应改用 `run_terminal_command(command="git status")` /
// `run_terminal_command(command="git diff")` 直接运行 git 命令。本路由不再暴露 git 子路由。
const TOOL_MAP: Record<string, string> = {
  '/read': 'read_file',
  '/write': 'write_file',
  '/edit': 'edit_file',
  '/delete': 'delete_file',
  // W2a：`rename` 是 `mv` 的别名——两条路由都派发到同一 action-tool
  // `move_file`（rename 强调同目录改名，mv 强调跨目录搬移，底层语义相同）。
  '/mkdir': 'mkdir',
  '/mv': 'move_file',
  '/rename': 'move_file',
  '/glob': 'glob_search',
  '/grep': 'grep_search',
  '/diagnostics': 'read_lints',
};

const WORKTREE_ROUTES = new Set([
  '/worktree/current',
  '/worktree/list',
  '/worktree/switch',
  '/worktree/create',
]);

function readWorktreeAgentContext(body: any): CodeWorktreeAgentContext | null {
  const raw = body?._agent_context;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id.trim() : '';
  const runId = typeof raw.run_id === 'string' ? raw.run_id.trim() : '';
  const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id.trim() : '';
  return sessionId && runId && toolUseId ? { sessionId, runId, toolUseId } : null;
}

function sendWorktreeResult(
  result: CodeWorktreeControllerResult,
  res: ServerResponse,
  sendJSON: SendJSON,
): void {
  if (result.ok) {
    sendJSON(res, 200, okResponse(result.data));
    return;
  }
  sendJSON(res, result.status, errorResponse(result.code, result.message, {
    detail: result.detail,
  }));
}

async function handleWorktreeRoute(
  route: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const controller = getBindings().getCodeWorktreeController?.();
  if (!controller) {
    sendJSON(res, 503, errorResponse(
      'SERVICE_UNAVAILABLE',
      'Agent worktree controller 尚未初始化或当前宿主不支持',
      { retryable: true },
    ));
    return;
  }
  const context = readWorktreeAgentContext(body);
  if (!context) {
    sendJSON(res, 403, errorResponse(
      'AGENT_CONTEXT_REQUIRED',
      '此命令只能由当前顶层 Agent run 调用',
    ));
    return;
  }

  let result: CodeWorktreeControllerResult;
  if (route === '/worktree/current') result = await controller.current(context);
  else if (route === '/worktree/list') result = await controller.list(context);
  else if (route === '/worktree/switch') result = await controller.switch(context, body || {});
  else result = await controller.create(context, body || {});
  sendWorktreeResult(result, res, sendJSON);
}

export async function handleCodeRoute(
  url: string,
  _method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/code/, '');
  if (WORKTREE_ROUTES.has(route)) {
    try {
      await handleWorktreeRoute(route, body, res, sendJSON);
    } catch (err: any) {
      sendJSON(res, 500, errorResponse(
        'INTERNAL_ERROR',
        err?.message || String(err),
        { retryable: true },
      ));
    }
    return;
  }

  if (route === '/search') {
    sendJSON(res, 410, errorResponse(
      'FEATURE_RETIRED',
      '代码语义搜索已退役，请使用 /code/grep 进行内容搜索或 /code/glob 进行文件搜索',
    ));
    return;
  }

  const toolName = TOOL_MAP[route];

  if (!toolName) {
    sendJSON(res, 404, errorResponse(
      'UNKNOWN_ROUTE',
      `未知的 code 路由: ${url}`,
      {
        suggestions: [
          '可用路由: /code/read, /code/write, /code/edit, /code/delete, /code/mkdir, /code/mv, /code/rename, ' +
            '/code/glob, /code/grep, /code/search, /code/diagnostics, /code/worktree/*',
          '使用 tabtin code --help 查看所有可用命令',
        ],
      },
    ));
    return;
  }

  const bindings = getBindings();
  const executor = bindings.getActionExecutor?.();
  if (!executor) {
    sendJSON(res, 503, errorResponse(
      'SERVICE_UNAVAILABLE',
      'Action executor 尚未初始化',
      { retryable: true, suggestions: ['确保宿主已完全启动'] },
    ));
    return;
  }

  try {
    const params = { ...(body || {}) };
    const agentContext = readWorktreeAgentContext(params);
    delete params._agent_context;
    // W2a：`workspaceRootForCode` 此前已在 host-bindings 配置但未被
    // 本路由消费——非 Agent CLI 保留显式 `_workspace_root`；Agent CLI 则必须
    // 由 Host 按可信 run 覆盖，避免切换后仍写向 body 中的旧根。
    if (agentContext) {
      const workspaceRoot = bindings.workspaceRootForCode?.(agentContext);
      if (!workspaceRoot) {
        sendJSON(res, 403, errorResponse(
          'UNTRUSTED_AGENT_RUN',
          '当前 Agent run 无法解析会话代码根',
        ));
        return;
      }
      // Agent 运行根只认 Host 解析值，不能让 CLI body 覆盖回旧目录。
      params._workspace_root = workspaceRoot;
    } else if (!params._workspace_root) {
      const workspaceRoot = bindings.workspaceRootForCode?.();
      if (workspaceRoot) params._workspace_root = workspaceRoot;
    }
    const result = await executor({
      task_id: makeTaskId(toolName),
      type: toolName,
      params,
      thread_id: agentContext?.sessionId ?? '',
    });

    if (result.success) {
      sendJSON(res, 200, okResponse(result.data));
    } else {
      sendJSON(res, 500, errorResponse('TASK_FAILED', result.error || 'Action execution failed', {
        detail: result.data,
      }));
    }
  } catch (err: any) {
    sendJSON(res, 500, errorResponse(
      'INTERNAL_ERROR',
      err?.message || String(err),
      { retryable: true },
    ));
  }
}
