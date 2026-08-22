import type { GatewayEnvelope } from '@tabtin/ws-gateway-client';
import { PERMISSION_TIMEOUTS } from '@tabtin/agent-wire';
import {
  isAutoApprovedTerminalWrite,
  containsCommandSubstitution,
  getInteractiveTerminalPolicySupportError,
  normalizeTerminalExecutionPolicy,
  evaluateTerminalPolicyDegradation,
  evaluateLocalTerminalPolicy,
  evaluateLocalFilePolicy,
  executeDegraded,
  resolveDataRoot,
  type TerminalExecutionPolicyPayload,
  type DegradationDecision,
} from '@tabtin/terminal-core';
import {
  checkHardlineCommand,
  checkHardlinePath,
  CHECKPOINT_MUTATING_ACTIONS,
} from '@tabtin/security-policy';
import { runWithHumanInteractionContext } from '@tabtin/agent-runtime';
import {
  createHeadlessAdapter,
  validateProjectPath,
  type ActionExecutorAdapter,
} from '@tabtin/action-tools/headless';
import { resolve } from 'node:path';
import type { DaemonConfig } from '../../base/types/daemon-config.js';
import type { Logger } from '../../platform/observability/logging/logger.js';
import type { ActionWorkspaceHistoryPort } from './workspace-history-port.js';
import {
  checkDaemonPathAccess,
  type WorkspaceSnapshotResolver,
} from '../../application/security/path-access.js';
import {
  executeRemoteFsListDir,
  executeRemoteFsPreview,
} from './remote-fs-handlers.js';
import { ActionAdmissionController } from './action-admission-controller.js';

type ActionHandler = (params: Record<string, any>, taskId?: string) => Promise<Record<string, any>>;

interface ActionPlugin {
  getActionHandlers(): Map<string, ActionHandler>;
}

export interface ActionPluginPort {
  getPlugins(): readonly ActionPlugin[];
  setOnPluginLoaded(callback: (plugin: ActionPlugin) => void): void;
}

export interface TranscriptRollbackPort {
  rollback(input: {
    threadId: string;
    targetMessageId?: string;
    targetRole?: 'user' | 'assistant';
    targetContent?: string;
    targetOccurrenceIndex?: number;
    mode?: 'rollback' | 'editAndResend';
    keepMessageCount?: number;
    spaceId?: string;
  }): Promise<{ success: boolean; applied?: boolean; keepMessageCount?: number | null; error?: string }>;
  unrevert(input: { threadId: string; spaceId?: string }): Promise<{ success: boolean; error?: string }>;
}

export interface ActionGitStatusPort {
  getOrCreate(workspaceRoot: string): unknown;
  invalidateAndNotify(workspaceRoot?: string): void;
}

/** Complete runtime boundary for the action execution module. */
export interface ActionExecutionPorts {
  sendResult(threadId: string, taskId: string, result: Record<string, any>, traceId?: string): Promise<void>;
  sendMonitorEvent(eventType: string, payload: Record<string, unknown>): Promise<void>;
  requestApproval(
    threadId: string,
    taskId: string,
    command: string,
    policy: Record<string, any>,
  ): Promise<boolean>;
  isPtyAvailable(): boolean;
  isBrowserAvailable(): boolean;
  resolveWorkspaceSnapshot: WorkspaceSnapshotResolver;
  getTranscriptRollbackPort(): TranscriptRollbackPort | null;
  readonly gitStatusRegistry: ActionGitStatusPort;
  readonly workspaceHistory: ActionWorkspaceHistoryPort;
}

export interface ActionRequestPayload {
  task_id: string;
  action: string;
  params?: Record<string, any>;
  agent_space_id?: string;
  space_id?: string;
  sandbox_policy?: Record<string, any>;
}

const MAX_RESULT_BYTES = 256 * 1024; // 256KB — WS message size guard
const TOOL_EXECUTION_TIMEOUT_MS = 300_000; // 5 minutes — prevents hung tool promises
/**
 * Fallback safety-net timeout for the approval mechanism.
 * Must be LONGER than business-layer APPROVAL_TIMEOUT_MS (PERMISSION_TIMEOUTS.FINAL_MS)
 * in daemon.ts / ApprovalManager.ts so the business timer fires first for orderly
 * cleanup. The 30s gap is a grace period to prevent this fallback from racing.
 */
const APPROVAL_FALLBACK_TIMEOUT_MS = PERMISSION_TIMEOUTS.FALLBACK_MS;

const FILE_POLICY_ACTIONS = new Set(['write_file', 'edit_file', 'delete_file']);
const MUTATING_ACTIONS = new Set([
  'execute_in_terminal',
  'write_file', 'edit_file', 'delete_file',
  ...CHECKPOINT_MUTATING_ACTIONS,
]);

const READ_SANDBOX_ACTIONS = new Set(['read_file', 'glob_search', 'grep_search', 'read_lints']);

const TABDATA_WRITE_ACTIONS = new Set([
  'tabdata_create_record', 'tabdata_update_record', 'tabdata_delete_record',
]);

const TRUNCATABLE_KEYS = ['stdout', 'stderr', 'output', 'content', 'clean_html', 'png_base64', 'video_data', 'base64_data'];
const MAX_FIELD_CHARS = 50_000;
const MAX_ARRAY_ELEMENTS = 100;
const MAX_GENERIC_STRING_CHARS = 100_000;

function truncateStringFields(obj: Record<string, any>): Record<string, any> {
  const result = { ...obj };
  for (const key of TRUNCATABLE_KEYS) {
    if (typeof result[key] === 'string' && result[key].length > MAX_FIELD_CHARS) {
      const original = result[key] as string;
      result[key] = original.slice(0, MAX_FIELD_CHARS) + `\n...[truncated, original ${original.length} chars]`;
    }
  }
  return result;
}

function deepTruncate(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    const truncatedArray = value.length > MAX_ARRAY_ELEMENTS
      ? value.slice(0, MAX_ARRAY_ELEMENTS)
      : value;
    const mapped = truncatedArray.map(deepTruncate);
    if (value.length > MAX_ARRAY_ELEMENTS) {
      (mapped as any)._array_truncated = true;
      (mapped as any)._original_length = value.length;
    }
    return mapped;
  }

  if (typeof value === 'string' && value.length > MAX_GENERIC_STRING_CHARS) {
    return value.slice(0, MAX_GENERIC_STRING_CHARS) + `\n...[truncated, original ${value.length} chars]`;
  }

  if (typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      result[k] = deepTruncate(v);
    }
    return result;
  }

  return value;
}

function truncateResult(result: Record<string, any>): Record<string, any> {
  const json = JSON.stringify(result);
  if (json.length <= MAX_RESULT_BYTES) return result;

  let truncated = truncateStringFields(result);
  if (truncated.data && typeof truncated.data === 'object') {
    truncated = { ...truncated, data: truncateStringFields(truncated.data) };
  }

  if (JSON.stringify(truncated).length > MAX_RESULT_BYTES) {
    truncated = deepTruncate(truncated) as Record<string, any>;
  }

  if (JSON.stringify(truncated).length > MAX_RESULT_BYTES) {
    const safeJson = JSON.stringify(truncated);
    const sliced = safeJson.slice(0, MAX_RESULT_BYTES - 200);
    truncated = {
      success: truncated.success,
      _truncated: true,
      _original_bytes: json.length,
      _partial: sliced,
    };
  }

  truncated._truncated = true;
  return truncated;
}

/**
 * 判断是否为「严格」的单行 `tabtin desktop ...` 调用：无 shell 链式/子 shell 等元字符。
 * 换行/回车必须拒绝，否则可在「截屏」后插入换行再拼接任意 shell 命令，绕过审批执行。
 * `()` 会误伤 `tabtin desktop open "App (Name)"`，但在 bash 中为子 shell 语法，保留拦截更安全。
 */
function isStrictInternalDesktopCLI(command: string): boolean {
  const t = command.trim();
  if (!/^\s*tabtin\s+desktop\b/i.test(t)) return false;
  return !/[;|&`$()\n\r]/.test(t);
}

export class DaemonActionBridge {
  private readonly config: DaemonConfig;
  private readonly pluginManager: ActionPluginPort;
  private readonly logger: Logger;
  private readonly ports: ActionExecutionPorts;
  private readonly handlers = new Map<string, ActionHandler>();
  private adapter: ActionExecutorAdapter;
  private readonly useAdapter: boolean;
  // Wave 1.5（2026-05-13）：旧 file-lock-manager 实例字段已删除——锁的责任
  // 收口到 ActionExecutorAdapter 一侧（统一 `withFileLock` 跨入口共享 lockMap，
  // 详见 `@tabtin/action-tools/utils/file-lock`）。外层不再嵌一道 withLock 调用，
  // 避免「上层包了下层又包」同 key 死锁。
  private readonly admission = new ActionAdmissionController();
  // **2026-05-13**：旧版 `turnChangedFilesByProject` per-project Set 已退役。
  //
  // 退役理由：
  //   1. **best-effort 收集有 SSoT 漂移问题**：dispatch 后 try-catch 静默吞错，
  //      工具执行成功但收集失败 → checkpoint commit 时 changed_files 数组缺
  //      这个文件 → file_changelog 不写这条 → 但 Shadow Git diff 已经捕获到
  //      → 双轨 SSoT 矛盾。
  //   2. **覆盖面有缺口**：只 hook 了 file_write/edit/delete 三个工具。LLM
  //      通过 `run_terminal_command rm -rf dir` / `mv` / `sed -i` 改的文件
  //      完全捕不到，进 ChangeLog 时漏掉。
  //   3. **Shadow Git 是天然 SSoT**：daemon 在 checkpoint_commit 后能拿到完整
  //      的 `diff_summary.files` —— 比 best-effort 收集准、比覆盖面广。
  //
  // 替代路径：Django `daemon_checkpoint_service._persist_checkpoint_hash` 改
  // 为消费 `diff_summary.files`（`extract_changed_files_from_diff_summary`
  // 升格为主路径）。daemon 端 commit 时不再返回 `changed_files`。
  //
  // 设计取舍：不维护 per-turn changedFiles 数组；
  // SSoT 是 readFileState（mtime 漂移反推）+ fileHistoryState（备份）。TabTin
  // 因为有 Shadow Git 这层更强的兜底，可以更激进地把 SSoT 完全归到 git diff。

  private static readonly DISPOSE_GRACE_MS = 3_000;

  constructor(
    config: DaemonConfig,
    pluginManager: ActionPluginPort,
    logger: Logger,
    ports: ActionExecutionPorts,
  ) {
    this.config = config;
    this.pluginManager = pluginManager;
    this.logger = logger;
    this.ports = ports;
    this.adapter = this.createAdapter(config.capabilities ?? ['terminal_execute', 'file']);
    this.useAdapter = process.env.TABTIN_USE_ACTION_ADAPTER !== '0';
    const adapterTools = this.adapter.getRegisteredTools();
    this.logger.info(`[ActionBridge] mode=${this.useAdapter ? 'adapter' : 'legacy'} (TABTIN_USE_ACTION_ADAPTER=${process.env.TABTIN_USE_ACTION_ADAPTER ?? 'unset'}), adapter tools (${adapterTools.length}): ${adapterTools.join(', ')}`);
  }

  private createAdapter(capabilities: Iterable<string>): ActionExecutorAdapter {
    const caps = new Set(capabilities);
    if (this.ports.isBrowserAvailable() && !caps.has('browser')) caps.add('browser');
    const adapter = createHeadlessAdapter({ logger: this.logger, capabilities: caps });
    this.logger.info(`[ActionBridge] Capabilities: ${[...caps].join(', ')}`);
    return adapter;
  }

  refreshCapabilities(capabilities: Iterable<string>): void {
    this.adapter = this.createAdapter(capabilities);
    const adapterTools = this.adapter.getRegisteredTools();
    this.logger.info(`[ActionBridge] adapter tools refreshed (${adapterTools.length}): ${adapterTools.join(', ')}`);
  }

  /**
   * 路径权限治理 Wave 4：从 action params 派生 workspaceRoots 列表给
   * `validateProjectPath` 用。
   *
   * 优先级：
   *   1. v3 SSoT：当前 session 的 `WorkspaceSnapshot.allowedPaths`（通过
   *      `params._space_id` 经 `workspaceSnapshotResolver` 拿到）—— 与 LLM
   *      主路径同源；
   *   2. config.workspace_root：daemon 启动期 fallback（与 Wave 4 之前的
   *      single-string 行为对齐，作为兜底）；
   *   3. params._workspace_root：LLM ctx 注入的相对路径解析基准（极少独立
   *      生效——通常 1 / 2 已 cover）。
   *
   * Set 去重，避免重复路径让 `validateProjectPath` 多比对。
   */
  private resolveWorkspaceRootsForPolicy(params: Record<string, any>): string[] {
    const roots = new Set<string>();
    const spaceId = typeof params._space_id === 'string' ? params._space_id : undefined;
    const snapshot = this.ports.resolveWorkspaceSnapshot(spaceId) ?? null;
    if (snapshot) {
      for (const p of snapshot.allowedPaths) {
        if (typeof p === 'string' && p.length > 0) roots.add(p);
      }
    }
    if (this.config.workspace_root) roots.add(this.config.workspace_root);
    if (typeof params._workspace_root === 'string' && params._workspace_root) {
      roots.add(params._workspace_root);
    }
    // ：会话归档 / skills / downloads 新布局落在 dataRoot 下
    roots.add(resolveDataRoot());
    return [...roots];
  }

  /**
   * 路径权限治理 Wave 4 P2-7 修复：相对路径解析的稳定 cwd 选择。
   *
   * Wave 4 之前的代码用 `resolve(workspaceRoots[0]!, filePath)` —— 但
   * `workspaceRoots` 数组顺序由 `resolveWorkspaceRootsForPolicy` 的
   * insertion 决定（snapshot.allowedPaths 之后才是 config.workspace_root /
   * params._workspace_root），LLM 当前工作的项目可能不是首位 → 解析到
   * 错误目录 → boundary 检查输入错误。
   *
   * 修法：相对路径解析固定走 `params._workspace_root || params.working_directory
   * || config.workspace_root || process.cwd()`（不是 workspaceRoots 数组首位）。
   * `workspaceRoots` 数组只用于 boundary 比对（多目录数组），相对路径解析
   * 用单一 cwd。
   *
   * 优先级：
   *   1. `params._workspace_root`：LLM ctx 显式注入的相对路径基准（最准）
   *   2. `params.working_directory`：terminal action 的 cwd（次准）
   *   3. `config.workspace_root`：daemon 启动配置的兜底
   *   4. `process.cwd()`：实在没有时用进程 cwd（极少发生）
   */
  private resolveRelativeCwd(params: Record<string, any>): string {
    if (typeof params._workspace_root === 'string' && params._workspace_root) {
      return params._workspace_root;
    }
    if (typeof params.working_directory === 'string' && params.working_directory) {
      return params.working_directory;
    }
    if (this.config.workspace_root) return this.config.workspace_root;
    return process.cwd();
  }

  /**
   * 路径权限治理 Wave 4 P0-2 修复：checkpoint handlers 共用的 v3 boundary
   * 检查 helper。
   *
   * Wave 4 之前 9 个 checkpoint handler（init/commit/restore/diff/destroy/
   * initial/gc/write_tree/diff_summary）每处都写
   * `validateProjectPath('write/read', projectPath, { workspaceRoots: [config.workspace_root] })`
   * single-string —— 用户在 TabCode 打开 `/Volumes/外接盘/proj/` 时全部撞
   * single-string boundary 必败，dogfood 完全无法 checkpoint。
   *
   * 此 helper 让 9 处 handler 都消费 v3 `WorkspaceSnapshot.allowedPaths`
   * 多目录数组（与 enforcePolicy 同源）。
   *
   * **跨进程边界不传 alreadyJudged**（W4 P1-3 + W7 B6）：checkpoint handlers
   * 是 wire 入口（被远端 publish_action 触发），不能信任 wire envelope 上的
   * `_already_judged`；`validateProjectPath` 默认 alreadyJudged=false 走完整
   * boundary 检查 —— D3 反例"永远 false 的字段挂在签名上"治理。
   */
  private validateCheckpointPath(
    action: 'read' | 'write',
    projectPath: string,
    params: Record<string, any>,
  ): void {
    const workspaceRoots = this.resolveWorkspaceRootsForPolicy(params);
    validateProjectPath(action, projectPath, {
      workspaceRoots,
      // 字段名仍叫 platformDataRoot（action-tools 契约），值已硬切为 dataRoot
      platformDataRoot: resolveDataRoot(),
    });
  }

  /**
   * Per-file rewind 的路径守卫（P0-1 ②，Daemon 侧）。
   *
   * 复用 `checkDaemonPathAccess`（与 Daemon 三家入口 + LLM 主路径同源消费 v3
   * `WorkspaceSnapshot.allowedPaths`），对回退**将写/删**的每条绝对路径判定是否
   * 允许写。snapshot 经 `params._space_id` 解析；缺失退化到 `config.workspace_root`
   * 兜底。返回 `{ allowed, reason }` 供引擎在锁内逐条原子校验。
   */
  private buildFileHistoryPathGuard(
    params: Record<string, any>,
  ): (absPath: string) => { allowed: boolean; reason?: string } {
    const spaceId = typeof params._space_id === 'string' ? params._space_id : undefined;
    const snapshot = this.ports.resolveWorkspaceSnapshot(spaceId) ?? null;
    const fallbackRoots = this.config.workspace_root ? [this.config.workspace_root] : [];
    return (absPath: string) => {
      const r = checkDaemonPathAccess(absPath, 'write', { snapshot, fallbackRoots });
      return { allowed: r.allowed, reason: r.reason?.message };
    };
  }

  registerCoreExecutors(): void {
    this.registerCheckpointHandlers();
    this.registerMonitorHandlers();
    this.registerRemoteFsHandlers();

    for (const plugin of this.pluginManager.getPlugins()) {
      for (const [actionType, handler] of plugin.getActionHandlers()) {
        this.registerHandler(actionType, handler);
      }
    }

    this.pluginManager.setOnPluginLoaded((plugin) => {
      for (const [actionType, handler] of plugin.getActionHandlers()) {
        this.registerHandler(actionType, handler);
      }
    });

    this.logger.info(`Registered ${this.handlers.size} legacy handlers: ${[...this.handlers.keys()].join(', ')}`);
  }

  /**
   *  远程文件浏览：`fs.list_dir` / `fs.read_file_preview`。
   *
   * 这是 UI 级只读查询（远端客户端经 Django `/devices/query` 中继），不是
   * LLM 工具。boundary = Django 注入的服务端权威 `params._working_dir`，
   * 实现与安全口径见 remote-fs-handlers.ts。
   */
  private registerRemoteFsHandlers(): void {
    this.registerHandler('fs.list_dir', async (params) => executeRemoteFsListDir(params));
    this.registerHandler('fs.read_file_preview', async (params) => executeRemoteFsPreview(params));
  }

  private registerCheckpointHandlers(): void {
    // Checkpoint 结果必须放入 `data` 字段：WS handler 经 ActionResultSchema 解析时
    // 只保留 schema 已声明的字段（success/error/data/...），顶层自定义字段会被
    // Pydantic v2 (extra='ignore') 静默丢弃。`data: Optional[dict]` 是 schema 中
    // 唯一的透传容器，checkpoint 结果放入此字段才能完整传回 Django。

    // 路径权限治理 Wave 4 P0-2：9 个 handler 全部走 validateCheckpointPath
    // helper 接 v3 snapshot.allowedPaths（多目录数组），与 enforcePolicy 同源；
    // 不再用 single-string `[config.workspace_root]`。

    this.registerHandler('checkpoint_init', async (params) => {
      try {
        const projectPath = params.project_path;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        this.validateCheckpointPath('write', projectPath, params);
        const gitPath = await this.ports.workspaceHistory.checkpoints.init(projectPath);
        // **2026-05-13**：原 `turnChangedFilesByProject.delete(projectPath)` 退役。
        // changed_files SSoT 已切到 Shadow Git diff_summary（Django 端反推），
        // daemon 不再维护 per-turn 文件集合。本 handler 只负责 git 仓库初始化。
        return { success: true, data: { git_path: gitPath } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] init failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('checkpoint_commit', async (params) => {
      try {
        const projectPath = params.project_path;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        this.validateCheckpointPath('write', projectPath, params);
        const policy = typeof params.policy === 'object' && params.policy !== null
          ? params.policy
          : undefined;
        const commitHash = await this.ports.workspaceHistory.checkpoints.commit(projectPath, policy);
        // **2026-05-13**：daemon 端不再返回 `changed_files`。
        //
        // 旧实现从 best-effort 收集的 `turnChangedFilesByProject` 派生 changed_files
        // 数组返回给 Django，但只覆盖 file_write/edit/delete 三个工具，遗漏所有
        // 通过 run_terminal_command 改的文件（rm/mv/sed -i）。
        //
        // 新设计：Django `_persist_checkpoint_hash` 自己调 `diff_summary` 接口
        // 拿 Shadow Git ground truth 反推 `changed_files`。SSoT 单一、覆盖面完整、
        // 且天然包括 LLM 通过任意路径（不限于 file 工具）改的文件。
        return { success: true, data: { commit_hash: commitHash ?? null } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] commit failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('checkpoint_restore', async (params) => {
      try {
        const projectPath = params.project_path;
        const commitHash = params.commit_hash;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        if (!commitHash || typeof commitHash !== 'string') {
          return { success: false, error: 'Missing required param: commit_hash' };
        }
        this.validateCheckpointPath('write', projectPath, params);
        const moveHead = params.move_head === true || params.moveHead === true;
        await this.ports.workspaceHistory.checkpoints.restore(projectPath, commitHash, moveHead);
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] restore failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('checkpoint_diff', async (params) => {
      try {
        const projectPath = params.project_path;
        const fromHash = params.from_hash;
        const toHash = params.to_hash;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        if (!fromHash || typeof fromHash !== 'string') {
          return { success: false, error: 'Missing required param: from_hash' };
        }
        this.validateCheckpointPath('read', projectPath, params);
        const entries = await this.ports.workspaceHistory.checkpoints.diff(projectPath, fromHash, toHash);
        return { success: true, data: { entries } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] diff failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('checkpoint_destroy', async (params) => {
      try {
        const projectPath = params.project_path;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        this.validateCheckpointPath('write', projectPath, params);
        await this.ports.workspaceHistory.checkpoints.destroy(projectPath);
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] destroy failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('checkpoint_initial', async (params) => {
      try {
        const projectPath = params.project_path;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        this.validateCheckpointPath('read', projectPath, params);
        const hash = await this.ports.workspaceHistory.checkpoints.initialCommit(projectPath);
        return { success: true, data: { commit_hash: hash } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] initial failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('checkpoint_gc', async (params) => {
      try {
        const projectPath = params.project_path;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        this.validateCheckpointPath('write', projectPath, params);
        await this.ports.workspaceHistory.checkpoints.gc(projectPath);
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] gc failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('checkpoint_write_tree', async (params) => {
      try {
        const projectPath = params.project_path;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        this.validateCheckpointPath('read', projectPath, params);
        const treeHash = await this.ports.workspaceHistory.checkpoints.writeTree(projectPath);
        return { success: true, data: { tree_hash: treeHash ?? null } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] write_tree failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('checkpoint_diff_summary', async (params) => {
      try {
        const projectPath = params.project_path;
        const commitHash = params.commit_hash;
        if (!projectPath || typeof projectPath !== 'string') {
          return { success: false, error: 'Missing required param: project_path' };
        }
        if (!commitHash || typeof commitHash !== 'string') {
          return { success: false, error: 'Missing required param: commit_hash' };
        }
        this.validateCheckpointPath('read', projectPath, params);
        const baseHash = typeof params.base_hash === 'string' ? params.base_hash : undefined;
        const summary = await this.ports.workspaceHistory.checkpoints.diffSummary(projectPath, commitHash, baseHash);
        return { success: true, data: summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Checkpoint] diff_summary failed: ${message}`);
        return { success: false, error: message };
      }
    });

    // ── Per-file history（替代 shadow git checkpoint 的回退能力） ──────────
    // 供后端回退编排调用（rewind / preview）。service 经 getOrResumeFileHistory 取：先命中
    // per-thread 内存缓存，内存 miss 时按 threadId 从磁盘 manifest lazy 恢复（Bug 1：daemon
    // 重启后历史会话也能回退）。安全（P0-1）：
    //   ① thread 用 **envelope 已认证的 `_thread_id`**（handleAction 从
    //      envelope.thread_id 注入），**绝不信任业务参数 `params.thread_id`**——
    //      wire envelope 可被恶意客户端伪造 params 覆盖，越权回退别会话文件。
    //   ② rewind / preview 前对回退**将写/删**的每条绝对路径走 path guard
    //      （checkDaemonPathAccess，与 LLM 主路径同源消费 v3 snapshot.allowedPaths）；
    //      任一不允许 → 拒绝整个 rewind（引擎锁内原子校验）。
    this.registerHandler('file_history_rewind', async (params) => {
      const threadId = params._thread_id;
      const anchorId = params.anchor_id;
      if (!threadId || typeof threadId !== 'string') {
        return { success: false, error: 'Missing authenticated thread (envelope thread_id)' };
      }
      if (!anchorId || typeof anchorId !== 'string') {
        return { success: false, error: 'Missing required param: anchor_id' };
      }
      // 内存命中或磁盘 manifest lazy 恢复（Bug 1：daemon 重启后历史会话也要能回退）。
      try {
        const result = await this.ports.workspaceHistory.files.rewind(
          threadId,
          anchorId,
          this.buildFileHistoryPathGuard(params),
        );
        if (!result) {
          return { success: false, error: `No file-history for thread ${threadId} (no snapshot on disk)` };
        }
        return {
          success: true,
          data: {
            files_restored: result.filesRestored,
            files_deleted: result.filesDeleted,
            failed_files: result.failedFiles,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[FileHistory] rewind failed: ${message}`);
        return { success: false, error: message };
      }
    });

    this.registerHandler('file_history_preview', async (params) => {
      const threadId = params._thread_id;
      const anchorId = params.anchor_id;
      if (!threadId || typeof threadId !== 'string') {
        return { success: false, error: 'Missing authenticated thread (envelope thread_id)', data: { affected_paths: [] } };
      }
      if (!anchorId || typeof anchorId !== 'string') {
        return { success: false, error: 'Missing required param: anchor_id', data: { affected_paths: [] } };
      }
      // 与 rewind 同源：内存命中或磁盘 manifest lazy 恢复（Bug 1：重启后预览也要能看到）。
      try {
        const affected = await this.ports.workspaceHistory.files.affectedPaths(threadId, anchorId);
        if (!affected) {
          return { success: false, error: `No file-history for thread ${threadId}`, data: { affected_paths: [] } };
        }
        // ② 与 rewind 同源 path guard：任一受影响路径越界 → 整体拒绝，不向远端暴露越界路径。
        const guard = this.buildFileHistoryPathGuard(params);
        const blocked = affected.filter((p) => !guard(p).allowed);
        if (blocked.length > 0) {
          return {
            success: false,
            error: `Rewind would touch ${blocked.length} path(s) outside the workspace or on a protected path`,
            data: { affected_paths: [] },
          };
        }
        return { success: true, data: { affected_paths: affected } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[FileHistory] preview failed: ${message}`);
        return { success: false, error: message };
      }
    });

    // ──  对话回退：remote 宿主 transcript 截断（与 file_history_rewind 同栈）──
    // thread 用 envelope 已认证的 `_thread_id`，绝不信任业务 params.thread_id。
    // 写 rewind 软标记（不删行，可 unrevert）；物理截断推迟到发下一条消息时
    // DaemonAgentHost.handleQuery 的 commitRewind。
    this.registerHandler('session_transcript_truncate', (params) => this.truncateSessionTranscript(params));
    this.registerTranscriptUnrevertHandler();
  }

  private async truncateSessionTranscript(params: Record<string, any>): Promise<Record<string, any>> {
      const threadId = params._thread_id;
      if (!threadId || typeof threadId !== 'string') {
        return { success: false, error: 'Missing authenticated thread (envelope thread_id)' };
      }
      const input = this.parseTranscriptRollbackInput(params);
      if (!input.targetMessageId && input.keepMessageCount === undefined) {
        return { success: false, error: 'Need target_message_id or keep_message_count' };
      }
      const transcriptRollback = this.ports.getTranscriptRollbackPort();
      if (!transcriptRollback) {
        return { success: false, error: 'Transcript rollback handler not wired (local runtime not ready)' };
      }
      const result = await transcriptRollback.rollback({
        threadId,
        ...input,
      });
      return result.success
        ? { success: true, data: { applied: result.applied ?? false } }
        : { success: false, error: result.error };
  }

  private parseTranscriptRollbackInput(params: Record<string, any>): {
    targetMessageId?: string;
    targetRole?: 'user' | 'assistant';
    targetContent?: string;
    targetOccurrenceIndex?: number;
    mode?: 'rollback' | 'editAndResend';
    keepMessageCount?: number;
    spaceId?: string;
  } {
    return {
      targetMessageId: typeof params.target_message_id === 'string' ? params.target_message_id : undefined,
      targetRole: params.target_role === 'user' || params.target_role === 'assistant' ? params.target_role : undefined,
      targetContent: typeof params.target_content === 'string' ? params.target_content : undefined,
      targetOccurrenceIndex: typeof params.target_occurrence_index === 'number' && Number.isFinite(params.target_occurrence_index)
        ? params.target_occurrence_index : undefined,
      mode: params.mode === 'rollback' || params.mode === 'editAndResend' ? params.mode : undefined,
      keepMessageCount: typeof params.keep_message_count === 'number' && Number.isFinite(params.keep_message_count)
        ? params.keep_message_count : undefined,
      spaceId: typeof params._space_id === 'string' ? params._space_id : undefined,
    };
  }

  private registerTranscriptUnrevertHandler(): void {
    this.registerHandler('session_transcript_unrevert', async (params) => {
      const threadId = params._thread_id;
      if (!threadId || typeof threadId !== 'string') {
        return { success: false, error: 'Missing authenticated thread (envelope thread_id)' };
      }
      const transcriptRollback = this.ports.getTranscriptRollbackPort();
      if (!transcriptRollback) {
        return { success: false, error: 'Transcript rollback handler not wired (local runtime not ready)' };
      }
      const spaceId = typeof params._space_id === 'string' ? params._space_id : undefined;
      const result = await transcriptRollback.unrevert({ threadId, spaceId });
      return result.success ? { success: true, data: {} } : { success: false, error: result.error };
    });
  }

  // ── Monitor ────────────────────────────────────────────────────────

  private monitorExecutor: import('./monitor-executor').DaemonMonitorExecutor | null = null;
  private registerMonitorHandlers(): void {
    this.registerHandler('monitor_start', async (params) => {
      try {
        const { DaemonMonitorExecutor } = await import('./monitor-executor');
        if (!this.monitorExecutor) {
          this.monitorExecutor = new DaemonMonitorExecutor((eventType, payload) => {
            this.ports.sendMonitorEvent(eventType, payload).catch((err) => {
              this.logger.warn(`[Monitor] emit ${eventType} failed: ${err}`);
            });
          });
        }
        const result = this.monitorExecutor.start(params as any);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Monitor] monitor_start failed: ${msg}`);
        return { success: false, error: msg };
      }
    });

    this.registerHandler('monitor_stop', async (params) => {
      if (this.monitorExecutor) {
        this.monitorExecutor.stop(params as any);
      }
      return { success: true };
    });
  }

  registerHandler(actionType: string, handler: ActionHandler): void {
    this.handlers.set(actionType, handler);
  }

  async handleAction(envelope: GatewayEnvelope): Promise<void> {
    const threadId = typeof envelope.thread_id === 'string' ? envelope.thread_id.trim() : '';
    if (!threadId) {
      return this.handleActionWithContext(envelope);
    }
    return runWithHumanInteractionContext(
      { threadId, interactionMode: 'interactive' },
      () => this.handleActionWithContext(envelope),
    );
  }

  private async handleActionWithContext(envelope: GatewayEnvelope): Promise<void> {
    if (envelope.type === 'agent.action.cancel' && !this.admission.isDisposed()) {
      this.handleActionCancel(envelope);
      return;
    }
    const rawPayload = envelope.payload ?? {};
    if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
      this.logger.warn('[ActionBridge] Rejected: payload is not a plain object', typeof rawPayload);
      return;
    }
    const payload = rawPayload as Record<string, unknown>;

    const requestLease = this.admission.admitRequest();
    if (!requestLease) {
      this.logger.warn('[ActionBridge] Rejected: bridge is disposing, no new actions accepted');
      return;
    }

    try {
      return await this.prepareAndHandleAction(envelope, payload);
    } finally {
      requestLease.complete();
    }
  }

  private async prepareAndHandleAction(
    envelope: GatewayEnvelope,
    payload: Record<string, unknown>,
  ): Promise<void> {

    const taskId = typeof payload.task_id === 'string' ? payload.task_id : '';
    const actionType = typeof payload.action === 'string' ? payload.action : '';

    const params = this.createActionParams(payload.params);

    // 路径权限治理 Wave 4 P1-3 修复：DaemonActionBridge 是"被远端动作打过来
    // 的兜底闸门"，不能信任 wire envelope 上的 `_already_judged` 字段
    // —— 任何能塞 wire 的客户端（mobile 主控 / 受 XSS 的 Web / 恶意客户端）
    // 都能伪造此字段绕过 boundary。强制 strip 保证 enforcePolicy 之下的
    // validateProjectPath 永远走完整 boundary 检查（与 tabcode-adapter 在
    // 本机 LLM 主路径上 `delete base._already_judged` 的同款治理）。
    if ('_already_judged' in params) {
      delete params._already_judged;
    }

    const threadId = typeof envelope.thread_id === 'string' ? envelope.thread_id : '';
    const traceId = envelope.trace_id;

    const sandboxPolicy = this.readSandboxPolicy(payload.sandbox_policy);
    this.injectBaseActionContext(params, payload, threadId, taskId, sandboxPolicy);
    // PR4-yolo (PRD v3 §5.6) + PRD §1.4 / DR-15：把 Django 在 `publish_action`
    // envelope 顶层透过来的 agent_mode / is_group_space 真值，与
    // ``_sandbox_policy`` 同模式注入 params._agent_mode / params._is_group_space。
    //
    // 与 ``_sandbox_policy`` 同模式的设计理由：
    //   - daemon 自己的 LLM 主路径走 ``DaemonAgentHost``，policyContext.currentAgentMode
    //     / isGroupSpace 已经从 prompt.forward 的 payload.agent_mode / is_group_space
    //     接通（任务 1 + 2）—— **本路径与本注入互不依赖**，本注入纯粹是
    //     为 daemon 端 action-handler 解锁未来对 mode 的可观测访问（譬如
    //     defensive audit log / 工具内 yolo 自检），与现有 ``_sandbox_policy``
    //     被 terminal.ts 消费同款"注入 → 由 handler 自行决定怎么用"的口径。
    //
    // 注意：**没有"Daemon → Django round-trip 携 params"路径**：
    //   - sendActionResult 只回传 result 字段，不包含 params；
    //   - Daemon 端 LLM 工具是本地执行，不再走 Django publish_action 回环。
    //   故本注入不替代 Django 端 _resolve_sandbox_policy 改读 ContextVar（任务 5），
    //   而是为本地 daemon 防御性可观测增量。
    //
    // 白名单（同 daemon.ts resolveAgentMode 任务 2）：避免畸形客户端注入未知 mode 串。
    this.injectAgentModeContext(params, payload);

    // EF-05: Fallback — backend publish_action() puts space_id / agent_space_id
    // inside params, not at payload top level. Read from params when envelope
    // fields were absent.
    if (!params._space_id) {
      params._space_id = params.space_id ?? params.agent_space_id;
    }
    if (!params._agent_space_id) {
      params._agent_space_id = params.agent_space_id ?? params.space_id;
    }

    if (!taskId || !actionType) {
      this.logger.warn('Received action without task_id or action type', payload);
      return;
    }

    const taskLease = this.admission.claimTask(taskId);
    if (!taskLease) {
      await this.ports.sendResult(threadId, taskId, {
        success: false,
        error: `Duplicate in-flight task_id: ${taskId}`,
        error_code: 'duplicate_task_id',
      }, traceId);
      return;
    }
    const taskAbort = taskLease.controller;

    this.logger.info(`Action received: ${actionType} (task: ${taskId})`);

    // ── Normalize _workspace_root BEFORE policy evaluation ──
    // File policy decisions may need resolved paths;
    // normalizing here ensures enforcePolicy always sees an absolute path.
    if (!params._workspace_root) {
      params._workspace_root = params.working_directory || this.config.workspace_root;
    }

    // ── C9 防御 #5：兜底注入 `_organization_id` ──
    //
    // 背景（C9 file_not_in_organization bug 收口审计）：ActionTool 内调
    // `uploadFileToOSS` 写 FileRecord 需要 organizationId 判断归属。先前几条 dispatch
    // 路径的 organizationId 透传不齐 —— SSE → daemon → ActionTool 这条 wire 不一定
    // 在 payload 顶层带 organization_id（`ActionRequestPayload` 类型上没这字段），
    // 工具又依赖 `globalThis.tabtin.organizationId` 做最终 fallback，碰到 backend
    // 改 payload schema 没同步、或客户端是其它 host 不写 globalThis 的情况就
    // 会写错 organization → 触发 `file_not_in_organization` 错误。
    //
    // 这里采用与 `_workspace_root` 同模式的"daemon 兜底注入"：
    //   - daemon 是 explicit 单 organization 模型（DaemonConfig.organization_id 必有值，
    //     切 organization 必须 `tabtin-daemon init --force` 重新激活，详见
    //     types.ts user_id 字段注释），所以 config.organization_id 就是这台 daemon
    //     绑定的唯一合法 organization，作 fallback 永远正确。
    //   - 不 override 已有 `_organization_id`（agent-runtime adapter 在本机 LLM
    //     主路径 / 未来其他 caller 可能已注入更精准值）。
    //   - 不读 `params.organization_id`（无下划线前缀的业务参数）：业务参数可能
    //     来自 LLM cross-organization 调用，与 daemon 当前 active organization 不一致；
    //     `_organization_id` 保留"当前 daemon 上下文真值"语义。
    //
    // 详docs/agent/cli-spec/api-evolution-mutual-protection.md C9 §防御
    if (!params._organization_id && this.config.organization_id) {
      params._organization_id = this.config.organization_id;
    }

    try {
      return await this.enforceAndExecuteAction({
        actionType,
        params,
        payload,
        taskId,
        threadId,
        traceId,
        sandboxPolicy,
        taskAbort,
      });
    } finally {
      taskLease.complete();
    }
  }

  private createActionParams(rawParams: unknown): Record<string, any> {
    return rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? { ...(rawParams as Record<string, any>) }
      : {};
  }

  private readSandboxPolicy(rawPolicy: unknown): Record<string, any> | undefined {
    return rawPolicy && typeof rawPolicy === 'object' && !Array.isArray(rawPolicy)
      ? rawPolicy as Record<string, any>
      : undefined;
  }

  private injectBaseActionContext(
    params: Record<string, any>,
    payload: Record<string, unknown>,
    threadId: string,
    taskId: string,
    sandboxPolicy?: Record<string, any>,
  ): void {
    if (sandboxPolicy) params._sandbox_policy = sandboxPolicy;
    params._thread_id = threadId;
    params._task_id = taskId;
    if (typeof payload.agent_space_id === 'string' && payload.agent_space_id) params._agent_space_id = payload.agent_space_id;
    if (typeof payload.space_id === 'string' && payload.space_id) params._space_id = payload.space_id;
  }

  private injectAgentModeContext(params: Record<string, any>, payload: Record<string, unknown>): void {
    const allowedModes = new Set(['agent', 'plan', 'ask', 'study', 'group', 'yolo']);
    if (typeof payload.agent_mode === 'string' && allowedModes.has(payload.agent_mode)) params._agent_mode = payload.agent_mode;
    if (typeof payload.is_group_space === 'boolean') params._is_group_space = payload.is_group_space;
  }

  private async enforceAndExecuteAction(context: {
    actionType: string;
    params: Record<string, any>;
    payload: Record<string, unknown>;
    taskId: string;
    threadId: string;
    traceId?: string;
    sandboxPolicy?: Record<string, any>;
    taskAbort: AbortController;
  }): Promise<void> {
    const { actionType, params, payload, taskId, threadId, traceId, sandboxPolicy, taskAbort } = context;

    // ── Centralized safety policy check ──
    const policyResult = await this.enforcePolicy(actionType, params, threadId, taskId, sandboxPolicy);
    if (this.admission.isDisposed() || taskAbort.signal.aborted) {
      this.logger.warn(`[ActionBridge] Action ${actionType} cancelled before execution`);
      return;
    }
    if (policyResult) {
      this.emitAuditLog(actionType, params, policyResult, threadId, traceId, 'policy');
      const safeResult = truncateResult(policyResult);
      await this.ports.sendResult(threadId, taskId, safeResult, traceId);
      return;
    }

    return this.executeAcceptedAction({
      actionType,
      params,
      payload,
      taskId,
      threadId,
      traceId,
      sandboxPolicy,
      taskAbort,
    });
  }

  private async executeAcceptedAction(context: {
    actionType: string;
    params: Record<string, any>;
    payload: Record<string, unknown>;
    taskId: string;
    threadId: string;
    traceId?: string;
    sandboxPolicy?: Record<string, any>;
    taskAbort?: AbortController;
  }): Promise<void> {
    const { actionType, params, payload, taskId, threadId, traceId, sandboxPolicy } = context;
    const taskAbort = context.taskAbort ?? new AbortController();

    const serverTimeout = typeof payload.timeout_ms === 'number' && (payload.timeout_ms as number) > 0
      ? payload.timeout_ms as number
      : TOOL_EXECUTION_TIMEOUT_MS;

    const executeCore = async (): Promise<{ result: Record<string, any>; executionPath: 'adapter' | 'legacy' }> => {
      if (this.useAdapter && this.adapter.hasToolForAction(actionType)) {
        // ── Adapter path: unified action-tools execution ──
        try {
          const startMs = Date.now();
          const toolPromise = this.adapter.executeAction({
            task_id: taskId,
            type: actionType,
            params,
            thread_id: threadId,
            run_id: traceId,
          }, taskAbort.signal);
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new Error(`Tool execution timed out after ${serverTimeout / 1000}s`));
              taskAbort.abort();
            }, serverTimeout);
          });
          const r = await Promise.race([toolPromise, timeoutPromise]).finally(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          });
          const elapsedMs = Date.now() - startMs;
          r.frontend_execution_time_ms = elapsedMs;
          this.logger.info(`Action completed (adapter): ${actionType} (${elapsedMs}ms, success=${r.success})`);
          return { result: r, executionPath: 'adapter' };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          const isTimeout = message.includes('timed out');
          this.logger.error(`Action failed (adapter): ${actionType} — ${message}${stack ? `\n${stack}` : ''}`);
          return { result: { success: false, error: message, ...(isTimeout ? { error_code: 'tool_timeout' } : {}) }, executionPath: 'adapter' };
        }
      } else {
        // ── Legacy handler fallback ──
        const handler = this.handlers.get(actionType);
        if (!handler) {
          return {
            result: {
              success: false,
              error: `Unsupported action type: ${actionType}. Available (adapter): ${this.adapter.getRegisteredTools().join(', ')}; Available (legacy): ${[...this.handlers.keys()].join(', ')}`,
            },
            executionPath: 'legacy',
          };
        }
        try {
          const startMs = Date.now();
          const r = await handler(params, taskId);
          const elapsedMs = Date.now() - startMs;
          r.frontend_execution_time_ms = elapsedMs;
          this.logger.info(`Action completed (legacy): ${actionType} (${elapsedMs}ms, success=${r.success})`);
          return { result: r, executionPath: 'legacy' };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.logger.error(`Action failed (legacy): ${actionType} — ${message}${stack ? `\n${stack}` : ''}`);
          return { result: { success: false, error: message }, executionPath: 'legacy' };
        }
      }
    };

    // Wave 1.5（2026-05-13）：S5-01 文件锁的责任已收口到 ActionExecutorAdapter
    // 一侧（统一 `withFileLock` 跨入口共享 lockMap）。本层不再嵌外层锁——避免
    // 「上层包下层又包」同 key 死锁、避免「跨 bridge 跨 daemon 各持一份锁不串」
    // 的 L-11 升级根因。FILE_POLICY_ACTIONS 集合保留——它在 enforcePolicy /
    // afterAction 等其他位置用作「需要 sandbox boundary 检查的文件操作」标记，
    // 不只是锁专用。
    let terminalResult: Record<string, any> | null = null;
    let executionPath: 'adapter' | 'legacy';
    try {
      const outcome = await executeCore();
      let result = outcome.result;
      executionPath = outcome.executionPath;

      // **2026-05-13**：原 per-turn file change tracking 整段退役。
      //
      // 旧逻辑（在每个 file_write/edit/delete 成功后 best-effort add 到
      // turnChangedFilesByProject）有两个根本问题：
      //   1. **SSoT 漂移**：try/catch 静默吞错，工具成功 + 收集失败的 case
      //      下，commit 返回 `changed_files` 缺这个文件，但 Shadow Git diff
      //      已经捕获 → file_changelog 双轨数据矛盾。
      //   2. **覆盖面缺口**：只 hook FILE_POLICY_ACTIONS（write/edit/delete）。
      //      LLM 通过 `run_terminal_command rm -rf dir` / `mv` / `sed -i` 改
      //      的文件完全收不到——但用户 rollback 时这些变更必须能恢复。
      //
      // 新设计：Django `_persist_checkpoint_hash` 直接消费 daemon 的 `diff_summary`
      // 调用结果作为 SSoT，覆盖**任何路径**对 workspace 文件的改动。daemon
      // 不再维护中间状态，行为更纯粹（哑终端 + Shadow Git diff 是 ground truth）。
      // 详见 `daemon_checkpoint_service._persist_checkpoint_hash`。

      // HITL 升级：交互式命令检测到后，请求用户审批，审批通过后在 PTY 中直接执行。
      // 检查 data.interactive_blocked（standardizeLegacyResult 会将 error_code 移入 ToolError，
      // 但 data 字段在 adapter pipeline 中保留）。
      ({ result, executionPath } = await this.upgradeInteractiveCommand({
        actionType, params, result, executionPath, threadId, taskId, sandboxPolicy, executeCore,
      }));

      this.emitAuditLog(actionType, params, result, threadId, traceId, executionPath);
      this.afterAction(actionType, params, result);

      // TDS-004: Surface structured warnings (sandbox degradation, unknown relaxed rules)
      // to the user/frontend via the result payload, not just audit logs.
      this.attachTerminalWarnings(actionType, result);

      terminalResult = truncateResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.admission.isDisposed()) {
        this.logger.warn(`[ActionBridge] Action ${actionType} cancelled during dispose: ${message}`);
      } else {
        this.logger.error(`[ActionBridge] Unhandled error in handleAction(${actionType}): ${message}`);
        terminalResult = truncateResult({ success: false, error: message });
      }
    } finally { /* admission owner removes the controller */ }

    if (terminalResult) {
      try {
        await this.ports.sendResult(threadId, taskId, terminalResult, traceId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[ActionBridge] Failed to deliver terminal result for ${actionType}: ${message}`);
      }
    }
  }

  private async upgradeInteractiveCommand(context: {
    actionType: string;
    params: Record<string, any>;
    result: Record<string, any>;
    executionPath: 'adapter' | 'legacy';
    threadId: string;
    taskId: string;
    sandboxPolicy?: Record<string, any>;
    executeCore: () => Promise<{ result: Record<string, any>; executionPath: 'adapter' | 'legacy' }>;
  }): Promise<{ result: Record<string, any>; executionPath: 'adapter' | 'legacy' }> {
    const { actionType, params, threadId, taskId, sandboxPolicy, executeCore } = context;
    const interactiveData = context.result.data ?? {};
    if (actionType !== 'execute_in_terminal' || interactiveData.interactive_blocked !== true) return context;
    const command = (params.command ?? '').trim();
    const displayedCommand = command.length > 200 ? `${command.slice(0, 200)}…` : command;
    const detail = `${displayedCommand}\n\n⚠ ${interactiveData.interactive_reason || 'command requires interactive input'}`;
    const approved = await this.requestApproval(threadId, taskId, detail, sandboxPolicy ?? {});
    if (!approved) {
      this.logger.info(`[HITL-UPGRADE] 用户拒绝交互式命令: ${command.slice(0, 120)}`);
      return { result: { success: false, error: `Interactive command requires approval but was denied: ${interactiveData.interactive_reason}`, error_code: 'APPROVAL_DENIED', data: { approval_status: 'denied' } }, executionPath: context.executionPath };
    }
    if (!this.ports.isPtyAvailable()) {
      this.logger.info(`[HITL-UPGRADE] 用户批准交互式命令但 PTY 不可用，无法执行: ${command.slice(0, 120)}`);
      return { result: { success: false, error: 'interactive_command_requires_pty', message: '此命令需要交互式终端，但当前设备的终端不可用。请在 Electron 客户端中执行。', error_code: 'INTERACTIVE_NO_PTY', data: { interactive_blocked: false, approval_status: 'approved_but_pty_unavailable' } }, executionPath: context.executionPath };
    }
    this.logger.info(`[HITL-UPGRADE] 用户批准交互式命令: ${command.slice(0, 120)}`);
    delete params._degradation_decision;
    delete params._policy_degraded;
    delete params._policy_degraded_reason;
    params._skip_policy_degradation = true;
    return executeCore();
  }

  private attachTerminalWarnings(actionType: string, result: Record<string, any>): void {
    if (actionType !== 'execute_in_terminal') return;
    const data = result.data ?? result;
    const warnings: string[] = [...(data.warnings ?? []), ...(result._warnings ?? [])];
    if (data.os_sandbox_degraded && !warnings.some((warning) => warning.includes('sandbox degraded'))) {
      warnings.push(`OS sandbox degraded: ${data.os_sandbox_degraded_reason || 'sandbox binary unavailable'}. Command executed without OS-level sandbox protection.`);
    }
    if (warnings.length > 0) result._warnings = warnings;
  }

  handleActionCancel(envelope: GatewayEnvelope): void {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    const taskId = typeof payload?.task_id === 'string' ? payload.task_id : '';
    if (!taskId) {
      this.logger.warn('[ActionBridge] cancel event missing task_id');
      return;
    }
    if (this.admission.cancel(taskId)) {
      this.logger.info(`[ActionBridge] Task cancelled via server signal: ${taskId}`);
    } else {
      this.logger.debug(`[ActionBridge] cancel signal for unknown/completed task: ${taskId}`);
    }
  }

  /**
   * Centralized security policy enforcement.
   * Returns a result object if the action should be blocked or denied;
   * returns null if the action is cleared to proceed.
   */
  private async enforcePolicy(
    actionType: string,
    params: Record<string, any>,
    threadId: string,
    taskId: string,
    sandboxPolicy?: Record<string, any>,
  ): Promise<Record<string, any> | null> {
    const serverPolicy: TerminalExecutionPolicyPayload | undefined =
      sandboxPolicy && typeof sandboxPolicy === 'object' ? sandboxPolicy as TerminalExecutionPolicyPayload : undefined;

    if (actionType === 'execute_in_terminal') {
      return this.enforceTerminalExecutionPolicy(params, threadId, taskId, sandboxPolicy, serverPolicy);
    }
    if (FILE_POLICY_ACTIONS.has(actionType)) {
      return this.enforceFilePolicy(actionType, params, threadId, taskId, sandboxPolicy, serverPolicy);
    }
    if (actionType === 'write_to_terminal') return this.enforceTerminalWritePolicy(params);
    if (READ_SANDBOX_ACTIONS.has(actionType)) return this.enforceReadPolicy(actionType, params);
    if (CHECKPOINT_MUTATING_ACTIONS.has(actionType)) return this.enforceCheckpointPolicy(actionType, params);
    return null;
  }

  private async enforceTerminalExecutionPolicy(
    params: Record<string, any>,
    threadId: string,
    taskId: string,
    sandboxPolicy: Record<string, any> | undefined,
    serverPolicy: TerminalExecutionPolicyPayload | undefined,
  ): Promise<Record<string, any> | null> {
      const command = (params.command ?? '').trim();
      if (!command) return null;

      const inputError = this.validateTerminalInput(command, params);
      if (inputError) return inputError;

      const cmdHit = checkHardlineCommand(command);
      if (cmdHit.hit) {
        this.logger.warn(`[POLICY] Blocked terminal command: ${command.slice(0, 120)} — ${cmdHit.description} [${cmdHit.pattern}]`);
        return {
          success: false,
          error: cmdHit.description || 'Command blocked by security policy.',
          error_code: 'POLICY_BLOCKED',
          data: { policy_decision: 'blocked', ruleName: cmdHit.pattern },
        };
      }

      const localTermDecision = evaluateLocalTerminalPolicy(command, serverPolicy);
      if (localTermDecision.blocked) {
        this.logger.warn(`[POLICY] Blocked by local terminal policy: ${command.slice(0, 120)} — ${localTermDecision.denyReason}`);
        return {
          success: false,
          error: localTermDecision.denyReason || 'Blocked by local security policy.',
          error_code: 'POLICY_BLOCKED',
          data: { policy_decision: 'blocked', ruleName: localTermDecision.ruleName },
        };
      }

      const approvalError = await this.enforceTerminalApproval(
        localTermDecision.approvalRequired, command, threadId, taskId, sandboxPolicy,
      );
      if (approvalError) return approvalError;
      return this.enforceTerminalPolicySupport(command, params, serverPolicy);
    }

  private validateTerminalInput(command: string, params: Record<string, any>): Record<string, any> | null {
      if (/^\s*tabtin\s+desktop\b/i.test(command) && !isStrictInternalDesktopCLI(command)) {
        this.logger.warn(
          `[POLICY] Blocked unsafe tabtin desktop command (shell meta or newline): ${command.slice(0, 120)}`,
        );
        return {
          success: false,
          error:
            'Unsafe tabtin desktop command: shell metacharacters or newlines are not allowed.',
          error_code: 'POLICY_BLOCKED',
          data: { policy_decision: 'blocked', ruleName: 'desktop-cli-strict' },
        };
      }

      const workDir = params.working_directory;
      if (workDir && typeof workDir === 'string') {
        if (containsCommandSubstitution(workDir)) {
          this.logger.warn(`[POLICY] Blocked: working_directory contains command substitution: ${workDir.slice(0, 120)}`);
          return {
            success: false,
            error: 'working_directory contains disallowed shell substitution syntax.',
            error_code: 'POLICY_BLOCKED',
            data: { policy_decision: 'blocked', field: 'working_directory' },
          };
        }
      }

      const env = params.env;
      if (env && typeof env === 'object') {
        for (const [key, value] of Object.entries(env)) {
          if (typeof key === 'string' && containsCommandSubstitution(key)) {
            this.logger.warn(`[POLICY] Blocked: env key contains command substitution: ${key.slice(0, 80)}`);
            return {
              success: false,
              error: `Environment variable key "${key}" contains disallowed shell substitution syntax.`,
              error_code: 'POLICY_BLOCKED',
              data: { policy_decision: 'blocked', field: 'env' },
            };
          }
          if (typeof value === 'string' && containsCommandSubstitution(value)) {
            this.logger.warn(`[POLICY] Blocked: env value for "${key}" contains command substitution: ${String(value).slice(0, 80)}`);
            return {
              success: false,
              error: `Environment variable "${key}" value contains disallowed shell substitution syntax.`,
              error_code: 'POLICY_BLOCKED',
              data: { policy_decision: 'blocked', field: 'env' },
            };
          }
        }
      }

      return null;
  }

  private async enforceTerminalApproval(
    required: boolean,
    command: string,
    threadId: string,
    taskId: string,
    sandboxPolicy?: Record<string, any>,
  ): Promise<Record<string, any> | null> {
    if (!required || isStrictInternalDesktopCLI(command)) return null;
    if (await this.requestApproval(threadId, taskId, command, sandboxPolicy ?? {})) return null;
    return {
      success: false,
      error: 'This command requires user approval but was denied or timed out.',
      error_code: 'APPROVAL_DENIED',
      data: { approval_status: 'denied' },
    };
  }

  private async enforceTerminalPolicySupport(
    command: string,
    params: Record<string, any>,
    serverPolicy?: TerminalExecutionPolicyPayload,
  ): Promise<Record<string, any> | null> {
      // Policy support check: verify PTY runtime can enforce the requested security constraints.
      // route=sandbox and networkMode=blocked/custom cannot be enforced in a PTY session.
      const normalizedServerPolicy = normalizeTerminalExecutionPolicy(serverPolicy);
      const policyUnsupportedError = getInteractiveTerminalPolicySupportError(normalizedServerPolicy);
      if (policyUnsupportedError) {
        const degradation = evaluateTerminalPolicyDegradation(normalizedServerPolicy);
        if (degradation?.canDegrade) {
          if (!this.ports.isPtyAvailable()) {
            // PTY 不可用：直接通过 CommandExecutor 降级执行（无需经过 adapter pipeline）
            params._policy_degraded = true;
            params._policy_degraded_reason = degradation.reason;
            this.logger.info(`[POLICY] PTY unavailable, executing degraded directly: ${degradation.reason} — ${command.slice(0, 120)}`);
            return this.executeDegradedDirect(command, degradation, params);
          }
          params._policy_degraded = true;
          params._policy_degraded_reason = degradation.reason;
          params._degradation_decision = degradation;
          this.logger.info(`[POLICY] Terminal policy degraded: ${degradation.reason} — ${command.slice(0, 120)}`);
        } else {
          this.logger.warn(`[POLICY] Terminal policy unsupported and not degradable: ${policyUnsupportedError}`);
          return {
            success: false,
            error: policyUnsupportedError,
            error_code: 'POLICY_BLOCKED',
            data: { policy_decision: 'blocked', reason: 'policy_not_supported' },
          };
        }
      }

      return null;
  }

  private async enforceFilePolicy(
    actionType: string,
    params: Record<string, any>,
    threadId: string,
    taskId: string,
    sandboxPolicy: Record<string, any> | undefined,
    serverPolicy: TerminalExecutionPolicyPayload | undefined,
  ): Promise<Record<string, any> | null> {
      const filePath = params.file_path ?? params.path ?? '';
      // 路径权限治理 Wave 4 / W7 B6：消费 v3 `WorkspaceSnapshot.allowedPaths`
      // 多目录数组替代单字符串 workspace_root，与 LLM 主路径同源。
      //
      // **跨进程边界不传 alreadyJudged**：handleAction 入口已 strip wire
      // 上的 `_already_judged`；这里不再透传该字段（W7/B6 死代码已清退）。
      // `validateProjectPath` 默认 alreadyJudged=false，走完整 boundary 检查。
      // 本机 LLM 主路径走 tabcode-adapter / checkFilePathSecurity 独立链路，
      // 不经本闸门。
      //
      // P2-7：相对路径解析走单一稳定 cwd（不取 workspaceRoots 数组首位 ——
      // 数组顺序由 insertion 决定，首位可能不是 LLM 实际项目）。
      const workspaceRoots = this.resolveWorkspaceRootsForPolicy(params);
      if (filePath && workspaceRoots.length > 0) {
        try {
          const resolvedPath = resolve(this.resolveRelativeCwd(params), filePath);
          validateProjectPath('write', resolvedPath, {
            workspaceRoots,
            platformDataRoot: resolveDataRoot(),
          });
        } catch (err: any) {
          this.logger.warn(`[POLICY] Blocked file action: [${actionType}] path "${filePath}" outside workspace — ${err.message}`);
          return {
            success: false,
            error: err.message,
            error_code: 'POLICY_BLOCKED',
            data: { policy_decision: 'blocked', reason: 'workspace_sandbox' },
          };
        }
      }

      if (filePath) {
        const filePathHit = checkHardlinePath(filePath, 'file');
        if (filePathHit.hit) {
          this.logger.warn(`[POLICY] Blocked file action: [${actionType}] ${filePath} — ${filePathHit.description}`);
          return {
            success: false,
            error: filePathHit.description || 'File operation blocked by security policy.',
            error_code: 'POLICY_BLOCKED',
            data: { policy_decision: 'blocked' },
          };
        }
      }
      let fileApprovalAlreadyGranted = false;

      const localFileDecision = evaluateLocalFilePolicy(actionType, filePath, serverPolicy);
      if (localFileDecision.blocked) {
        this.logger.warn(`[POLICY] Blocked by local file policy: [${actionType}] ${filePath} — ${localFileDecision.denyReason}`);
        return {
          success: false,
          error: localFileDecision.denyReason || 'Blocked by local file policy.',
          error_code: 'POLICY_BLOCKED',
          data: { policy_decision: 'blocked', ruleName: localFileDecision.ruleName },
        };
      }
      // SDP-008: Skip redundant approval if PolicyEvaluator already prompted and user approved
      if (localFileDecision.approvalRequired && !fileApprovalAlreadyGranted) {
        const approved = await this.requestApproval(threadId, taskId, `[${actionType}] ${filePath}`, sandboxPolicy ?? {});
        if (!approved) {
          return {
            success: false,
            error: 'File operation requires local policy approval but was denied or timed out.',
            error_code: 'APPROVAL_DENIED',
            data: { approval_status: 'denied' },
          };
        }
      }

      return null;
    }

  private enforceReadPolicy(
    actionType: string,
    params: Record<string, any>,
  ): Record<string, any> | null {
      const pathsToCheck = this.collectReadPaths(actionType, params);
      // Wave 4 / W7 B6：READ_SANDBOX_ACTIONS 同样消费 v3 snapshot.allowedPaths；
      // **跨进程边界不传 alreadyJudged**（同上 FILE_POLICY 分支）。
      // P2-7：相对路径解析走单一稳定 cwd（同上）。
      const readWorkspaceRoots = this.resolveWorkspaceRootsForPolicy(params);
      const readCwd = this.resolveRelativeCwd(params);
      if (pathsToCheck.length > 0 && readWorkspaceRoots.length > 0) {
        for (const filePath of pathsToCheck) {
          try {
            const resolvedPath = resolve(readCwd, filePath);
            validateProjectPath('read', resolvedPath, {
              workspaceRoots: readWorkspaceRoots,
              platformDataRoot: resolveDataRoot(),
            });
          } catch (err: any) {
            this.logger.warn(`[POLICY] Blocked read action: [${actionType}] path "${filePath}" outside workspace — ${err.message}`);
            return {
              success: false,
              error: err.message,
              error_code: 'POLICY_BLOCKED',
              data: { policy_decision: 'blocked', reason: 'workspace_sandbox' },
            };
          }
        }
      }

      for (const p of pathsToCheck) {
        const readPathHit = checkHardlinePath(p, 'file');
        if (readPathHit.hit) {
          this.logger.warn(`[POLICY] Blocked ${actionType}: path "${p}" — ${readPathHit.description} [${readPathHit.pattern}]`);
          return {
            success: false,
            error: readPathHit.description || `${actionType} blocked by security policy.`,
            error_code: 'POLICY_BLOCKED',
            data: { policy_decision: 'blocked', ruleName: readPathHit.pattern },
          };
        }
      }
      return null;
    }

  private collectReadPaths(actionType: string, params: Record<string, any>): string[] {
    if (actionType === 'glob_search') return this.onlyStringPaths([params.target_directory]);
    if (actionType === 'grep_search') return this.onlyStringPaths([params.path ?? params.target_directory]);
    if (actionType === 'read_lints') return this.onlyStringPaths(Array.isArray(params.paths) ? params.paths : []);
    return this.onlyStringPaths([params.file_path ?? params.path]);
  }

  private enforceTerminalWritePolicy(params: Record<string, any>): Record<string, any> | null {
    const rawData = String(params.data ?? '').trim();
    if (!rawData || isAutoApprovedTerminalWrite(rawData)) return null;
    const hit = checkHardlineCommand(rawData);
    if (!hit.hit) return null;
    this.logger.warn(`[POLICY] Blocked terminal write: ${rawData.slice(0, 80)}`);
    return {
      success: false,
      error: hit.description || 'Terminal write blocked by security policy.',
      error_code: 'POLICY_BLOCKED',
      data: { policy_decision: 'blocked' },
    };
  }

  private onlyStringPaths(values: unknown[]): string[] {
    return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  private async enforceCheckpointPolicy(
    actionType: string,
    params: Record<string, any>,
  ): Promise<Record<string, any> | null> {
    if (actionType !== 'checkpoint_restore') return null;
    const projectPath = params.project_path;
    const commitHash = params.commit_hash;
    if (typeof projectPath !== 'string' || !projectPath || typeof commitHash !== 'string' || !commitHash) return null;
    try {
      validateProjectPath('write', projectPath, {
        workspaceRoots: this.resolveWorkspaceRootsForPolicy(params),
        platformDataRoot: resolveDataRoot(),
      });
      const affectedRelPaths = await this.ports.workspaceHistory.checkpoints.affectedPaths(projectPath, commitHash);
      return this.findBlockedCheckpointPath(projectPath, affectedRelPaths);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[POLICY] Blocked checkpoint_restore: pre-check failed — ${message}`);
      return {
        success: false,
        error: `Checkpoint restore blocked: unable to verify that restore does not write to protected paths. ${message}`,
        error_code: 'POLICY_BLOCKED',
        data: { policy_decision: 'blocked', ruleName: 'hardline-precheck-failed' },
      };
    }
  }

  private findBlockedCheckpointPath(projectPath: string, affectedRelPaths: string[]): Record<string, any> | null {
    for (const relPath of affectedRelPaths) {
      const hit = checkHardlinePath(resolve(projectPath, relPath), 'file');
      if (!hit.hit) continue;
      this.logger.warn(`[POLICY] Blocked checkpoint_restore: file "${relPath}" hits hardline — ${hit.description}`);
      return {
        success: false,
        error: `Checkpoint restore blocked: restoring would write to protected path '${relPath}'. ${hit.description}`,
        error_code: 'POLICY_BLOCKED',
        data: { policy_decision: 'blocked', ruleName: hit.pattern, blocked_path: relPath },
      };
    }
    return null;
  }

  /**
   * PTY 不可用时的直接降级执行路径。
   * 使用 CommandExecutor (spawn + OS sandbox) 执行命令，不经过 adapter/PTY pipeline。
   * 交互式命令被直接拒绝（无 PTY 无法提供交互式终端）。
   */
  private async executeDegradedDirect(
    command: string,
    degradation: DegradationDecision,
    params: Record<string, any>,
  ): Promise<Record<string, any>> {
    const cwd = params.working_directory || params._workspace_root || this.config.workspace_root || process.cwd();
    const threadId = params._thread_id;

    try {
      const result = await executeDegraded({
        command,
        cwd,
        degradation,
        threadId,
        timeout: 120_000,
      });

      if (result.interactiveBlocked) {
        this.logger.info(`[DEGRADE] Interactive command rejected (no PTY): ${result.matchedCommand} — ${result.interactiveReason}`);
        return {
          success: false,
          error: `Interactive command not supported without PTY: ${result.interactiveReason}`,
          error_code: 'INTERACTIVE_BLOCKED',
          data: {
            interactive_blocked: true,
            interactive_reason: result.interactiveReason,
            matched_command: result.matchedCommand,
          },
        };
      }

      const output = result.stdout || result.stderr;
      return {
        success: true,
        data: {
          output,
          exit_code: result.exitCode,
          command_succeeded: result.exitCode === 0,
          cwd: result.cwd,
          backgrounded: false,
          timed_out: result.timedOut,
          duration_ms: result.durationMs,
          session_id: null,
          mode: 'sandbox',
          policy_degraded: true,
          policy_degraded_reason: degradation.reason,
          os_sandbox_degraded: !result.sandboxApplied && degradation.sandboxConfig.route === 'sandbox',
          os_sandbox_degraded_reason: !result.sandboxApplied ? 'sandbox binary unavailable' : undefined,
          warnings: result.warnings,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[DEGRADE] Direct degraded execution failed: ${message}`);
      return {
        success: false,
        error: message,
        data: { policy_degraded: true, policy_degraded_reason: degradation.reason },
      };
    }
  }

  private async requestApproval(
    threadId: string,
    taskId: string,
    command: string,
    policy: Record<string, any>,
  ): Promise<boolean> {
    this.logger.info(`[HITL] Requesting approval for: ${command.slice(0, 120)}`);
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const approvalPromise = this.ports.requestApproval(threadId, taskId, command, policy);
      const timeoutPromise = new Promise<never>((_, reject) => {
        fallbackTimer = setTimeout(
          () => reject(new Error('HITL approval fallback timeout')),
          APPROVAL_FALLBACK_TIMEOUT_MS,
        );
      });
      const approved = await Promise.race([approvalPromise, timeoutPromise]);
      this.logger.info(`[HITL] Approval ${approved ? 'granted' : 'denied'}: ${command.slice(0, 80)}`);
      return approved;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[HITL] Approval request failed: ${message} — denying by default`);
      return false;
    } finally {
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    }
  }

  private emitAuditLog(
    actionType: string,
    params: Record<string, any>,
    result: Record<string, any>,
    threadId: string,
    traceId?: string,
    executionPath?: 'adapter' | 'legacy' | 'policy',
  ): void {
    const d = result.data ?? result;
    const entry: Record<string, any> = {
      ts: new Date().toISOString(),
      action: actionType,
      thread_id: threadId,
      trace_id: traceId,
      execution_path: executionPath,
      success: result.success ?? false,
      duration_ms: result.frontend_execution_time_ms,
      exit_code: d.exit_code ?? result.exit_code,
    };

    if (actionType === 'execute_in_terminal') {
      this.enrichTerminalAuditEntry(entry, params, result, d);
    } else if (this.isPathAuditAction(actionType)) {
      entry.path = params.file_path ?? params.path ?? params.pattern;
    }

    if (!result.success && result.error) {
      entry.error = String(result.error).slice(0, 300);
    }

    this.logger.info(`[AUDIT] ${JSON.stringify(entry)}`);
  }

  private enrichTerminalAuditEntry(
    entry: Record<string, any>,
    params: Record<string, any>,
    result: Record<string, any>,
    data: Record<string, any>,
  ): void {
    entry.command = (params.command ?? '').slice(0, 200);
    entry.requested_mode = params.mode ?? 'unknown';
    entry.effective_mode = data.mode ?? result.mode ?? params.mode ?? 'unknown';
    entry.os_sandbox = data.os_sandbox ?? result.os_sandbox;
    entry.sandbox_level = data.sandbox_level ?? result.sandbox_level;
    const degraded = data.os_sandbox_degraded ?? result.os_sandbox_degraded;
    if (degraded) {
      entry.os_sandbox_degraded = true;
      entry.os_sandbox_degraded_reason = data.os_sandbox_degraded_reason ?? result.os_sandbox_degraded_reason;
      this.logger.warn(`[Audit] OS sandbox degraded: ${entry.os_sandbox_degraded_reason}`);
    }
    if (params._policy_degraded) {
      entry.policy_degraded = true;
      entry.policy_degraded_reason = params._policy_degraded_reason;
      this.logger.warn(`[Audit] Terminal policy degraded to spawn+sandbox: ${entry.policy_degraded_reason}`);
    }
  }

  private isPathAuditAction(actionType: string): boolean {
    return ['file_', 'code_', 'git_'].some((prefix) => actionType.startsWith(prefix));
  }

  private afterAction(actionType: string, params: Record<string, any>, result: Record<string, any>): void {
    const wsRoot = (params._workspace_root?.trim() || params.working_directory?.trim()) as string | undefined;
    if (wsRoot) {
      this.ports.gitStatusRegistry.getOrCreate(wsRoot);
    }

    if (MUTATING_ACTIONS.has(actionType) && result.success) {
      this.ports.gitStatusRegistry.invalidateAndNotify(wsRoot || undefined);
    }
  }

  getActionAdapter(): ActionExecutorAdapter {
    return this.adapter;
  }

  getRegisteredActions(): string[] {
    const adapterTools = this.adapter.getRegisteredTools();
    const legacyKeys = [...this.handlers.keys()];
    return [...new Set([...adapterTools, ...legacyKeys])];
  }

  getInflightActionCount(): number {
    return this.admission.getActiveRequestCount();
  }

  suspendIngress(): void {
    this.admission.suspend();
  }

  async dispose(): Promise<void> {
    this.admission.dispose();
    this.handlers.clear();

    if (this.monitorExecutor) {
      this.monitorExecutor.stopAll();
      this.monitorExecutor = null;
    }

    // Wave 1.5（2026-05-13）：旧的 file-lock-manager dispose 调用已删除——
    // 对应字段不再存在。新 `withFileLock` 实现无 dispose-cancel-all 语义
    // （取消只支持单调用 abortSignal 粒度），dispose 时本来就不需要主动
    // 全清——pendingAborts 已 abort 所有 in-flight task，对应 withFileLock
    // 调用会在 finally 自动 refCount-- + Map.delete 收尾。
    if (this.admission.getActiveRequestCount() > 0) {
      this.logger.info(`[ActionBridge] Waiting for ${this.admission.getActiveRequestCount()} in-flight action(s) to complete (grace: ${DaemonActionBridge.DISPOSE_GRACE_MS}ms)`);
      const deadline = Date.now() + DaemonActionBridge.DISPOSE_GRACE_MS;
      while (this.admission.getActiveRequestCount() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.admission.getActiveRequestCount() > 0) {
        this.logger.warn(`[ActionBridge] Grace period expired with ${this.admission.getActiveRequestCount()} action(s) still in-flight`);
      }
    }

    await this.ports.workspaceHistory.checkpoints.dispose();
  }
}
