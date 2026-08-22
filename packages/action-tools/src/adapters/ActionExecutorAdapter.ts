/**
 * ActionExecutorAdapter - 与后端 SSE/HTTP 协议的适配器
 *
 * 将 Agent 工具接入 Electron 的 ActionExecutor 架构
 * 参考: packages/tabtin-chat-client/docs/ELECTRON_INTEGRATION_GUIDE.md
 */

import type { AgentTool } from '../types';
import { t } from '../i18n';
import { withFileLock } from '../utils/file-lock';

/**
 * Wave 1.5（2026-05-13）：识别需文件锁的 action types。
 *
 * 跟 daemon `action-bridge.ts:60` / FAB.ts:238 现有 `FILE_POLICY_ACTIONS`
 * 集合对齐：write_file / edit_file / delete_file。
 *
 * **delete_file 也包**：虽然 PRD §九 单独 PRD 处理 delete 加同款保护，
 * 但 ActionExecutorAdapter 一侧顺手包是零成本兜底——delete 跟 write/edit
 * 并发同样会撞 ENOENT 半成功 / 误删（先 delete 后 edit 拿到的是旧 snapshot
 * 跟一片虚空文件之间的尴尬态）。本期把 delete 纳入只为「跨入口语义对齐」，
 * 不为 delete 安全做 Round 2 强校验（那是单独 PRD 的事）。
 *
 * **adapter 一侧的 LOCK_REQUIRED_TOOLS 不含 delete_file**：因为 adapter 一侧
 * 是 LLM Agent chat 链路，PRD §A.5 + §九 决策延迟 delete 到单独 PRD。本集合
 * 是 ActionExecutorAdapter 一侧的「跨入口防御兜底」，语义略宽是设计取舍。
 *
 * **W2a（2026-07-26，）新增 `mkdir` / `move_file`**：CLI `tabtin code
 * mkdir|mv|rename` 经 cli-routes → 本 adapter 派发，同款跨入口防御兜底。
 * `move_file` 的锁键取 `to`（目标路径）——下方 executeAction 对
 * FILE_LOCK_ACTIONS 里没有 `path`/`file_path` 字段的 action 会额外尝试
 * `to`/`from`，`to` 优先（写冲突风险集中在目标路径；`from` 在此期间只被
 * delete，读者若并发读到 ENOENT 是可接受的最终一致性窗口，不在本期治理）。
 */
const FILE_LOCK_ACTIONS = new Set(['write_file', 'edit_file', 'delete_file', 'mkdir', 'move_file']);

/**
 * 后端 SSE 推送的动作格式
 */
export interface FrontendAction {
  task_id: string;
  type: string;
  params: Record<string, any>;
  thread_id: string;
  run_id?: string; // 🆕 对齐主进程 run 概念，便于事件/资源归集
}

/**
 * 上报给后端的结果格式
 */
export interface ActionResult {
  success: boolean;
  trace_id?: string;
  clean_html?: string;
  skeleton_html?: string;
  title?: string;
  url?: string;
  content_length?: number;
  executed_actions?: Array<Record<string, any>>;
  frontend_execution_time_ms?: number;
  page_url?: string;
  page_title?: string;
  snapshot?: Record<string, any>;
  diff?: Record<string, any>;
  screenshot_base64?: string;
  observed_elements?: Array<Record<string, any>>;
  error?: string;
  data?: Record<string, any>;
  [key: string]: any;
}

/**
 * 工具注册表
 */
type ToolRegistry = Map<string, AgentTool<any, any>>;

/**
 * ActionExecutor 适配器
 *
 * 使用方法：
 * ```typescript
 * const adapter = new ActionExecutorAdapter();
 * adapter.registerTools(executeInTerminalTool, ...otherTools);
 *
 * // 在 ActionExecutor 中：
 * const result = await adapter.executeAction(action);
 * ```
 */
export interface AdapterLogger {
  debug: (...args: any[]) => void;
}

function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Action cancelled'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        reject(new Error('Action cancelled'));
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { if (!settled) { settled = true; signal.removeEventListener('abort', onAbort); resolve(v); } },
      (e) => { if (!settled) { settled = true; signal.removeEventListener('abort', onAbort); reject(e); } },
    );
  });
}

export class ActionExecutorAdapter {
  private tools: ToolRegistry = new Map();
  private logger?: AdapterLogger;

  constructor(options?: { logger?: AdapterLogger }) {
    this.logger = options?.logger;
  }

  /**
   * 注册工具
   */
  registerTool<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * 批量注册工具
   */
  registerTools(tools: AgentTool<any, any>[]): void {
    tools.forEach(tool => this.registerTool(tool));
  }

  /**
   * 执行动作
   *
   * @param action - 后端推送的动作
   * @returns 符合后端协议的结果
   */
  async executeAction(action: FrontendAction, signal?: AbortSignal): Promise<ActionResult> {
    if (signal?.aborted) {
      return { success: false, error: 'Action cancelled before execution' };
    }

    const { task_id, type, params, thread_id, run_id } = action;

    this.logger?.debug(`[ActionExecutorAdapter] 执行动作:`, {
      task_id,
      type,
      thread_id,
      run_id,
      params
    });

    try {
      const toolName = this.mapActionTypeToTool(type);
      const tool = this.tools.get(toolName);

      if (!tool) {
        throw new Error(t('errors.unregisteredTool', { toolName, actionType: type }));
      }

      const resolvedRunId = params.runId || params.trace_id || run_id;
      const enrichedParams = {
        ...params,
        ...(resolvedRunId ? { runId: resolvedRunId } : {}),
        ...(thread_id ? { thread_id } : {})
      };

      // Wave 1.5（2026-05-13）：FILE_LOCK_ACTIONS 经此 adapter 进入时统一加锁，
      // 跟 agent-runtime tabcode-adapter 共享同一个 `lockMap` 单例（实现下沉到
      // `@tabtin/action-tools/utils/file-lock`，agent-runtime 一侧 re-export）。
      //
      // 锁键 = `canonicalizePath(params.path / file_path, baseDir=_workspace_root || cwd)`
      // —— 必须跟 agent-runtime adapter 用同一份 canonicalize（macOS symlink /
      // 大小写不敏感都收敛），才能让 LLM Agent 持锁时 server push action
      // 经本 adapter 改同一文件必然 FIFO 串行（L-11 升级核心 H 不变量）。
      //
      // path 字段缺失时不锁（不抛错，让 tool.execute 走原路径返 INVALID_PARAMETER
      // 或 not-found，跟未加锁前行为一致）—— 锁是「写入安全」的保护层，不是
      // 「参数校验」入口，缺路径不该撞锁层。
      //
      // **Round 1 review 共识 SEV-1 自修复（2026-05-13）**：abortSignal 透传给
      // withFileLock —— 跟 agent-runtime tabcode-adapter 一侧
      // （`withFileLock(..., { abortSignal: ctx.abortSignal, baseDir })`）完全对称。
      // PRD §A.5 / §七决策明确要求 abort 三档语义（进锁前 / 等锁期间 / 持锁运行
      // 期间）在单调用粒度透传；缺这条 透传会导致「用户取消会话时正在等锁的
      // ActionExecutorAdapter 调用会跑空（文件被改但结果被丢弃，用户看到取消
      // 成功但文件实际已修改）」。`signal` 在 raceAbortSignal 外层也用到了，
      // 双重防御不会破——withFileLock 内 `options.abortSignal?.throwIfAborted()`
      // 是 optional chain 兼容 undefined。
      const executeCore = async (): Promise<any> => tool.execute(enrichedParams);

      let toolPromise: Promise<any>;
      if (FILE_LOCK_ACTIONS.has(type)) {
        // W2a：`move_file` 用 `to`/`from` 而非 `path`/`file_path`——
        // 优先取 `to`（目标路径，写冲突风险集中处），缺失时退到 `from`。
        const rawPath =
          typeof (enrichedParams as any).path === 'string' && (enrichedParams as any).path.length > 0
            ? (enrichedParams as any).path
            : typeof (enrichedParams as any).file_path === 'string' && (enrichedParams as any).file_path.length > 0
              ? (enrichedParams as any).file_path
              : typeof (enrichedParams as any).to === 'string' && (enrichedParams as any).to.length > 0
                ? (enrichedParams as any).to
                : typeof (enrichedParams as any).from === 'string' && (enrichedParams as any).from.length > 0
                  ? (enrichedParams as any).from
                  : undefined;
        if (rawPath !== undefined) {
          const wsRoot = typeof (enrichedParams as any)._workspace_root === 'string'
            ? (enrichedParams as any)._workspace_root
            : process.cwd();
          // **Wave 3 整体收尾 L-19 修复**：旧实现外层算了一次 `canonicalizePath(rawPath, wsRoot)`
          // 得到 lockKey，传给 withFileLock 后内部又会 `canonicalizePath(filePath, baseDir)`
          // 算一次（行为幂等但冗余 —— canonicalize 含 realpathSync 是 OS syscall）。
          // 直接传 rawPath，让 withFileLock 内部归一一次。
          toolPromise = withFileLock(rawPath, executeCore, {
            baseDir: wsRoot,
            abortSignal: signal,
          });
        } else {
          toolPromise = executeCore();
        }
      } else {
        toolPromise = executeCore();
      }

      if (signal) {
        const result = await raceAbortSignal(toolPromise, signal);
        return this.transformResult(result, type);
      }

      const result = await toolPromise;
      return this.transformResult(result, type);

    } catch (error) {
      this.logger?.debug(`[ActionExecutorAdapter] 执行失败:`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 映射后端动作类型到工具名称
   *
   * 后端约定的动作类型可能与工具名称不同，这里做转换
   */
  private mapActionTypeToTool(actionType: string): string {
    const mapping: Record<string, string> = {
      // 旧短名 → 规范名（向后兼容）
      'act': 'execute_act',
      'observe': 'execute_observe',
      'snapshot': 'request_snapshot',
      'browser_snapshot': 'request_snapshot',

      // 通用工具
      // Wave 4b L20 (2026-05-01)：crawl_clean_html / capture_webpage 工具已下架。
      // Electron `cli/routes/browser/extraction.ts` 直调 `CrawlToolImpl.crawlCleanHtml`，
      // Daemon `cli/routes/browser.ts /extract` 走 `DaemonBrowserService.getPageContent`，
      // 都不再通过 ActionExecutor 派发 `crawl_clean_html` / `capture_webpage` action type。
      // 对应 mapping + transformResult 分支已删除（fall-through 到 actionType passthrough）。
      'crawl_http_fetch': 'crawl_http_fetch',

      // Tab 管理
      'open_tab': 'open_tab',
      'switch_tab': 'switch_tab',
      'close_tab': 'close_tab',
      'get_tabs': 'get_tabs',
      'tab_state': 'tab_state',
      'nav_tab': 'nav_tab',
      'load_tab_url': 'load_tab_url',
      'wait_for': 'wait_for',

      // Eval
      'eval': 'eval',

      // Anti-detect
      'get_random_ua': 'get_random_ua',
      'check_proxy_health': 'check_proxy_health',

      // Terminal
      'read_terminal_output': 'read_terminal_output',
      'list_terminal_sessions': 'list_terminal_sessions',
      'execute_in_terminal': 'execute_in_terminal',
      'write_to_terminal': 'write_to_terminal',

      // TabCode tools
      'read_file': 'read_file',
      'write_file': 'write_file',
      'edit_file': 'edit_file',
      'delete_file': 'delete_file',
      'mkdir': 'mkdir',
      'move_file': 'move_file',
      'glob_search': 'glob_search',
      'grep_search': 'grep_search',

      // Context-space tools
      'list_context_space': 'list_context_space',
      'close_context_tab': 'close_context_tab',
      'set_active_context_tab': 'set_active_context_tab',
      'restore_context_group': 'restore_context_group',
      'assign_pane_content': 'assign_pane_content',
      'split_pane_with_tab': 'split_pane_with_tab',
      'move_pane': 'move_pane',
      'dock_pane': 'dock_pane',

      // Network Intelligence
      'browser_route': 'browser_route',
      'browser_route_list': 'browser_route_list',
      'browser_unroute': 'browser_unroute',
      'browser_network': 'browser_network',
      'browser_console': 'browser_console',

      // Resource Detection（旧名称保留兼容）
      'get_detected_resources': 'get_detected_resources',
      'list_resources': 'list_resources',
      'inspect_resource': 'inspect_resource',
      'capture_resource': 'capture_resource',
      'download_resource': 'download_resource',
      'download_batch': 'download_batch',
      'parse_m3u8': 'parse_m3u8',
      'parse_stream': 'parse_stream',
      'download_stream': 'download_stream',

      // Screenshot（旧名称保留兼容）
      'capture_screenshot': 'capture_screenshot',

      // PDF & Markdown（旧名称保留兼容）
      'generate_pdf': 'generate_pdf',
      'page_to_markdown': 'page_to_markdown',

      // Skills：W7 (2026-05-05) skills_read FC 已下架（迁至 agent-runtime
      // SkillsCap）。skills_read / skills.read mapping 一并删除——
      // 无已注册工具可路由，fallthrough 到 actionType passthrough 即 no-op。

      // TabData：Wave 4a (2026-05-01) 按 D4 全删 FC 删除 7 + 5 个 tabdata
      // FC + admin computed FC，对应 mapping 一并删除（lookup 自动 fall-
      // through 到原 actionType，行为不变）。Agent 走 `tabtin table *` CLI。

      // TabSlide：W6 (2026-05-04) tabslide AgentTool group + identity mapping
      // both retired together with the action-tools tabslide directory. Any
      // historical `tabslide_*` SSE action becomes a no-op fallthrough (no
      // tool registered), and slide CLI traffic now hits Django REST directly.

      // Session
      'manage_cookies': 'manage_cookies',
      'clear_session': 'clear_session',

      // Web Fetch / Extract：Wave 4a 按 D4 全删网页抓取 FC，对应
      // mapping 一并删除（fall-through）。Agent 抓页走 `tabtin browser *`
      // CLI。Wave 4b L20 进一步删除 `crawl_clean_html` / `capture_webpage`
      // mapping——cli-server `/browser/extract` 路由现直调 impl，不再走
      // ActionExecutor 派发。
    };

    return mapping[actionType] || actionType;
  }

  /**
   * 转换工具结果为后端协议格式
   */
  private transformResult(toolResult: any, actionType: string): ActionResult {
    const normalizedError =
      typeof toolResult?.error === 'object' && toolResult?.error?.message
        ? toolResult.error.message
        : toolResult?.error;
    const normalizedToolResult = {
      ...toolResult,
      error: normalizedError
    };

    this.logger?.debug(`[ActionExecutorAdapter] transformResult 输入:`, {
      actionType,
      toolResultKeys: Object.keys(normalizedToolResult),
      hasData: !!normalizedToolResult.data,
      dataKeys: normalizedToolResult.data ? Object.keys(normalizedToolResult.data) : []
    });

    // Wave 4b L20 (2026-05-01)：crawl_clean_html / capture_webpage 分支已删除——
    // 上述工具下架后没有任何代码派发这两个 action type，分支永不命中。
    // cli-server `/browser/extract` 路由现在直调 `CrawlToolImpl.crawlCleanHtml`
    // (Electron) / `DaemonBrowserService.getPageContent` (Daemon)，自行处理响应字段映射。

    // 🔥 对于 request_snapshot / snapshot 工具：保持嵌套结构（后端需要 data.snapshot）
    if (actionType === 'request_snapshot' || actionType === 'snapshot' || actionType === 'browser_snapshot') {
      this.logger?.debug(`[ActionExecutorAdapter] 处理 snapshot`, {
        hasData: !!toolResult.data,
        hasSnapshot: !!(toolResult.data && toolResult.data.snapshot),
        snapshotKeys: toolResult.data?.snapshot ? Object.keys(toolResult.data.snapshot) : []
      });

      // ✅ 直接返回原始结构，不展平
      return {
        success: normalizedToolResult.success,
        data: normalizedToolResult.data,  // ← 保持 data.snapshot 嵌套结构
        error: normalizedToolResult.error
      };
    }

    // 🔥 对于 execute_act / act 工具：直接返回（已经是正确格式）
    if (actionType === 'execute_act' || actionType === 'act') {
      return {
        success: normalizedToolResult.success,
        ...normalizedToolResult  // 包含 snapshot, diff 等字段
      };
    }

    // 默认：直接返回工具结果
    return {
      success: normalizedToolResult.success,
      ...normalizedToolResult
    };
  }

  /**
   * 获取已注册的工具列表
   */
  getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 检查工具是否已注册
   */
  hasToolForAction(actionType: string): boolean {
    const toolName = this.mapActionTypeToTool(actionType);
    return this.tools.has(toolName);
  }

  /**
   * 获取工具定义（用于 MCP schema 等外部消费）
   */
  getToolDefinition(actionType: string): { name: string; description: string; parameters: { type: 'object'; properties: Record<string, any>; required: string[] } } | null {
    const toolName = this.mapActionTypeToTool(actionType);
    const tool = this.tools.get(toolName);
    if (!tool) return null;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {}, required: [] },
    };
  }
}
