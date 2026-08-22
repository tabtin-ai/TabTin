/**
 * FrontendActionBridge - 前端动作桥接服务
 *
 * 职责：
 * 1. 接收渲染进程的前端动作请求（通过 IPC）
 * 2. 通过 ActionExecutorAdapter 统一调用工具
 * 3. 返回执行结果给渲染进程
 *
 * 设计原则：
 * - 统一通过工具平台架构
 * - 职责清晰，只做动作路由
 * - 工具实现由 @tabtin/action-tools 负责
 *
 * 本文件为 Facade 入口，具体实现拆分至：
 * - tool-registry.ts（工具注册）
 * - bridge-core.ts（核心 API 注入桥接）
 * - resource-actions.ts（资源检测/下载/流解析）
 * - cdp-actions.ts（CDP 截图/PDF/Markdown）
 */

import type { ActionRequiredEventData, ActionResultRequest } from '@tabtin/chat-client'
import { BrowserWindow } from 'electron'
import { ActionExecutorAdapter } from '@tabtin/action-tools/adapters'
import { getSharedBrowserToolImpl } from '@tabtin/action-tools/impl'
import { validateProjectPath } from '@tabtin/action-tools/headless'
import {
  getInteractiveTerminalPolicySupportError,
  normalizeTerminalExecutionPolicy,
  evaluateTerminalPolicyDegradation,
  evaluateLocalFilePolicy,
  evaluateLocalTerminalPolicy,
  isAutoApprovedTerminalWrite,
  containsCommandSubstitution,
  executeDegraded,
  type DegradationDecision,
} from '@tabtin/terminal-core'
import {
  checkHardlineCommand,
  checkHardlinePath,
  CHECKPOINT_MUTATING_ACTIONS,
} from '@tabtin/security-policy'
import {
  getHumanInteractionContext,
  runWithHumanInteractionContext,
  resolveUserRoot,
} from '@tabtin/agent-runtime'
import { requestApproval } from './ApprovalManager.js'
import {
  shouldBypassConfirmApproval,
  shouldBypassSecurityFloorApproval,
} from '../agent/policy/approval-mode-context'

import {
  enableForTab as enableCDPNetworkForTab,
} from './CDPNetworkBridge'

import { resolve } from 'node:path'
import { resolveDataRoot } from '@tabtin/terminal-core'
import { getPtyManager } from '../terminal/PtyManager'
import { getCLISpaceId, getCLICrawlspaceId, getCLIOrganizationRoot, getCLIWorkspaceScopeKey } from '../cli/cli-context'
import { getViewFactory } from '../view-factory'
import { getRunSessionManager } from '../run-session/RunSessionManager'
import { getCrawlspaceContextHub } from '../crawlspace/CrawlspaceContextHub'
import { getBrowserEnvironmentService } from '../browser-env/BrowserEnvironmentService'
import type { ContextSpaceToolBridge } from './ContextSpaceToolBridge'
import { getStreamDownloadService } from './StreamDownloadService'
import type { StreamProgressEvent } from '@shared/types/download'
import { getLocalMcpService } from './LocalMcpService'
import { createLogger } from '../logger'
import { resolveOrganizationIdFromUserInfo } from '../cli/routes/shared/error-handler'

import { getCheckpointService } from '../checkpoint/CheckpointService'
import { registerAllTools } from './tool-registry'
import { setupCoreAPIs } from './bridge-core'
import { setupResourceDetectionAPI } from './resource-actions'
import { setupAllCDPActions } from './cdp-actions'
import { getCurrentAllowedWorkspaceRoots } from '../security/path-access-checker'
import { TokenManager } from '../auth'
import { MonitorExecutor } from '../monitor/MonitorExecutor'
import { electronWsGateway } from '../ws/ElectronWsGateway'

const log = createLogger('ActionBridge')

const EXECUTE_ACTION_TIMEOUT_MS = 300_000 // 5 min — aligned with Daemon's TOOL_EXECUTION_TIMEOUT_MS

/**
 * 反爬升级流程复用的稳定 partition 名（W1.3 / 本地存储清单 A2-H2 修复）。
 *
 * 历史上这里用 `tabtin:upgrade:${Date.now()}`，每次访问受限触发升级都会
 * 在 `userData/Partitions/` 下新建一个永远不会被清理的目录，调用频繁的
 * 用户磁盘上能积累成百上千个孤儿 partition（GB 级）。
 *
 * 现在所有升级流程共享同一个 transient partition：
 *   - 命名带 `transient` 后缀，语义上明确"用完即弃"
 *   - 不带 `persist:` 前缀（buildSessionConfigForView 会按 persistent: true
 *     自动补 `persist:`，落盘后实际目录是 `Partitions/persist_3atabtin_3aupgrade_3atransient/`）
 *
 * **双重清理路径**（参考 RFC §五 W1.3 "复用 partition + 流程结束 clearStorageData()" 字面措辞）：
 *   1. **主路径**：每次升级流程结束（success / fail / throw）在 finally 里 clearStorageData
 *      —— 长会话不让 cookies / cache 在同一个 partition 内跨升级累积
 *   2. **兜底**：主进程启动时一次性 clear，覆盖崩溃 / 强 kill 留下的残留
 *
 * **不选 `sessionMode: 'temporary'` 的原因**：openTab 当前没有 sessionMode
 * 透传通道，强行打通会扩散到 RunSessionManager / ViewFactory / SessionConfigFactory
 * 三层签名；而稳定 partition + 双路径清理是最小且可验证的修复。
 *
 * **并发场景遗留**：当多次 access-strategy-upgrade 在同一进程内并发触发，
 * 它们共享同一 partition 会出现 cookies / sessionStorage 互相污染——本期
 * 不解决（A2 §4.4 第 4 个产品问题），登记到 harness 笔记本作为 Wave 2/3 backlog。
 */
export const UPGRADE_TRANSIENT_PARTITION = 'tabtin:upgrade:transient'

/**
 * 清理 upgrade transient partition 里的 cookie / 缓存 / IndexedDB /
 * serviceworker 等。
 *
 * 同时被两条路径调用：
 *   - 启动期一次性兜底（startup-services 的 registerCoreProcessHandlers，通过
 *     {@link kickoffUpgradePartitionStartupClear} 包装成 fire-and-forget +
 *     启动 gate promise，让首次升级流程能 await 等它跑完）
 *   - 每次升级流程结束（FrontendActionBridge 升级分支的 finally）
 *
 * - 必须在 `app.whenReady()` resolve 之后调用（依赖 `electron.session`）。
 * - 失败 best-effort：清理失败不阻塞业务流程，仅 warn。
 * - 幂等：重复调用即重复清理，无副作用。
 */
export async function clearUpgradeTransientPartition(): Promise<void> {
  try {
    const { session } = await import('electron')
    const partition = `persist:${UPGRADE_TRANSIENT_PARTITION}`
    await session.fromPartition(partition).clearStorageData()
    log.info('[AccessStrategy] upgrade transient partition 已清空:', partition)
  } catch (err) {
    log.warn('[AccessStrategy] 清理 upgrade transient partition 失败（非致命）:', err)
  }
}

// ── 启动期清理 gate（W1.3 / R2 F3 修复）─────────────────────────────────
//
// **场景**：启动期 fire-and-forget 调 `clearUpgradeTransientPartition` 走异步
// `session.clearStorageData`（Chromium 后台清 cookies / IDB / SW，几百 ms 量级）。
// 如果同一时刻第一次 access-strategy-upgrade 已经触发，升级流程刚写入的
// cookies 会被启动期清扫线程清掉 → 升级假阳性失败。
//
// **设计**：startup-services 调用 {@link kickoffUpgradePartitionStartupClear}
// 触发启动期清理并把返回的 promise 存到模块级 gate；升级流程在 openTab 之前
// `await awaitUpgradePartitionStartupClear()` 等 gate resolve（带 5s 超时
// 防 hang）。gate resolve 后保持 resolved 状态——后续升级流程 await 立即返回。

const STARTUP_CLEAR_TIMEOUT_MS = 5000
let _startupClearGate: Promise<void> | null = null

/**
 * 启动期触发一次 transient partition 清理，并把 promise 存到 gate 让首次
 * 升级流程能 await 等它完成。仅由 `startup-services` 在 `app.whenReady()`
 * resolve 后调用一次；多次调用幂等覆盖（最后一次的 promise 生效）。
 */
export function kickoffUpgradePartitionStartupClear(): Promise<void> {
  _startupClearGate = clearUpgradeTransientPartition()
  return _startupClearGate
}

/**
 * 升级流程在 openTab 之前调用：等启动期清理完成（或 5s 超时放弃）。
 * 启动期 gate 还没 set（极早期触发 / 未来重构）→ 立即返回。
 *
 * 实现细节：超时 setTimeout 在 gate 提前 resolve 时也要 clearTimeout，
 * 避免泄漏定时器引用（Node 进程退出时 unref，不致命，但显式释放更优雅）。
 */
export async function awaitUpgradePartitionStartupClear(): Promise<void> {
  if (!_startupClearGate) return
  const gate = _startupClearGate
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, STARTUP_CLEAR_TIMEOUT_MS)
  })
  try {
    await Promise.race([gate, timeoutPromise])
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
  }
}

/** 仅限测试：重置启动 gate，让测试可以模拟"启动期未触发"状态。 */
export function __resetUpgradePartitionStartupClearForTest(): void {
  _startupClearGate = null
}

// ── 升级流程引用计数（W1.3 / R2 F1 修复）───────────────────────────────
//
// **场景**：UPGRADE_TRANSIENT_PARTITION 是单一稳定 partition，所有
// access-strategy-upgrade 流程复用。Agent 模式下，一个 chat 里同时跑两
// 个浏览任务（A：抓 X 站；B：抓 Y 站），两者都撞反爬 → 同时进入升级
// 分支 → 共享同一 partition。如果 A 的 retry 先完成进入 finally
// `await clearUpgradeTransientPartition()`，会把 B 还没 retry 完的 cookies
// 一并清掉 → B 假阳性"被封禁"。
//
// **设计**：模块级计数器 `_activeUpgradeCount` 跟踪当前并发升级流程数：
//   - 进入升级分支 +1（在 openTab 之前）
//   - finally 退出 -1
//   - 仅当计数归零（最后一个并发流程结束）才执行 clearStorageData
//
// **不变量**：
//   - 计数只在升级链路调，不会被其他地方污染
//   - 即便 finally 抛错也不影响 -1（用 try/finally 包裹）
//   - 不要求 atomic：JS 单线程，++ / -- 在 microtask 边界外是原子的
//
// **退而求其次**：彻底解决"并发隔离"需要 sessionMode='temporary' 透传到
// RunSessionManager / ViewFactory / SessionConfigFactory 三层签名（A2 §4.4
// 第 4 个产品问题），登记 backlog；本期引用计数只解决"末次清理不互踩"，
// 不解决"两个并发升级流程的 cookies 隔离"——后者本期接受"互相污染但
// 不互相破坏"的折中。

let _activeUpgradeCount = 0

/** 升级流程进入时调用——返回 release fn，调用方在 finally 调一次（即便抛错也要释放）。 */
export function acquireUpgradeRefcount(): () => Promise<void> {
  _activeUpgradeCount += 1
  let released = false
  return async () => {
    if (released) return // 防御 double-release
    released = true
    _activeUpgradeCount -= 1
    if (_activeUpgradeCount < 0) {
      // 不变量违反：理论上不可能（每个 acquire 配一个 release）。
      // 防御性归零并 warn——继续运行不阻塞业务。
      log.warn('[AccessStrategy] _activeUpgradeCount went negative, resetting to 0')
      _activeUpgradeCount = 0
    }
    if (_activeUpgradeCount === 0) {
      await clearUpgradeTransientPartition()
    }
  }
}

/** 仅限测试：重置升级引用计数。 */
export function __resetUpgradeRefcountForTest(): void {
  _activeUpgradeCount = 0
}

/** 仅限测试：读当前引用计数。 */
export function __getUpgradeRefcountForTest(): number {
  return _activeUpgradeCount
}

/**
 * ：解析当前登录用户的 userId（同源 ElectronAgentHost.resolveSkillUserId，
 * 字段兼容 id / user_id / userId）。未认证时返回 undefined。
 */
async function resolveCurrentUserId(): Promise<string | undefined> {
  const userInfo = (await TokenManager.getUserInfo()) as
    | { id?: unknown; user_id?: unknown; userId?: unknown }
    | null
  const raw = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
  if (raw === undefined || raw === null || raw === '') return undefined
  return String(raw)
}

/**
 *  硬切：`validateProjectPath` 需要一个"平台恒定允许根"兜底
 * write/read 边界。旧实现传 `resolvePlatformDataRoot()`（放行全体 legacy
 * `platform-data/organizations/**` 树，跨用户跨组织）；硬切后收窄到当前
 * 登录用户在新布局下的私有根 `{dataRoot}/users/{userId}/`（skills / plugins /
 * conversations / downloads / sites 均在其下）。未认证时退到 `dataRoot` 本身
 * （legacy 兼容窗口，仍比放行整个 platform-data 树更收敛）。
 */
async function resolveBoundaryDataRoot(): Promise<string> {
  const dataRoot = resolveDataRoot()
  const userId = await resolveCurrentUserId()
  return userId ? resolveUserRoot(dataRoot, userId) : dataRoot
}

// W2afollow-up：mkdir/move_file 补入策略闸门集合，与 write_file/
// edit_file/delete_file 走同一套 boundary + hardline + sandbox 审批检查。
// move_file 的 from/to 双路径由下方 `filePolicyPaths` 派生逻辑单独处理，
// 不能只查其中一个字段。
const FILE_POLICY_ACTIONS = new Set(['write_file', 'edit_file', 'delete_file', 'mkdir', 'move_file'])
const READ_SANDBOX_ACTIONS = new Set(['read_file', 'glob_search', 'grep_search', 'read_lints'])

const TABDATA_WRITE_ACTIONS = new Set([
  'tabdata_create_record', 'tabdata_update_record', 'tabdata_delete_record',
])

/**
 * 前端动作桥接服务
 */
export class FrontendActionBridge {
  private adapter: ActionExecutorAdapter
  private contextSpaceBridge: ContextSpaceToolBridge | null = null
  private streamProgressHandler: ((progress: StreamProgressEvent) => void) | null = null
  private _destroyed = false
  private _disposeToolRegistry: (() => void) | null = null
  // Wave 1.5（2026-05-13）：旧 file-lock-manager 实例字段已删除——锁的责任
  // 收口到 ActionExecutorAdapter 一侧（统一 `withFileLock` 跨入口共享 lockMap，
  // 详见 `@tabtin/action-tools/utils/file-lock`）。外层不再嵌一道 withLock 调用，
  // 避免「上层包了下层又包」同 key 死锁；且 LLM Agent chat（agent-runtime
  // adapter）跟 FAB IPC push action 改同文件天然 FIFO 串行（L-11 升级核心
  // H 不变量）。

  constructor(private mainWindow: BrowserWindow) {
    log.info('初始化服务...')

    // 1. 创建 adapter 并注册所有工具
    this.adapter = new ActionExecutorAdapter()
    this._disposeToolRegistry = registerAllTools(this.adapter)

    // 2. 注入核心 API 桥接（RunSession/ViewFactory/CrawlView/ContextSpace/HttpCrawl/Pty）
    const { contextSpaceBridge } = setupCoreAPIs(mainWindow)
    this.contextSpaceBridge = contextSpaceBridge

    // 3. 注入资源检测/下载 API
    setupResourceDetectionAPI({
      getMainWindow: () => this.mainWindow,
      ensureStreamProgressForwarding: () => this.ensureStreamProgressForwarding(),
    })

    // 4. 注入 CDP 截图 / PDF / Markdown API
    setupAllCDPActions()

    log.info(`服务初始化完成，已注册 ${this.adapter.getRegisteredTools().length} 个工具`)
  }

  setMainWindow(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
  }

  getRegisteredTools(): string[] {
    if (!this.adapter?.getRegisteredTools) return []
    return this.adapter.getRegisteredTools()
  }

  hasToolForAction(actionType: string): boolean {
    if (!this.adapter?.hasToolForAction) return false
    return this.adapter.hasToolForAction(actionType)
  }

  /**
   * 执行前端动作
   *
   * @param action - 前端动作数据（来自 WS 的 frontend_action 事件）
   * @returns 动作执行结果
   */
  get destroyed(): boolean {
    return this._destroyed
  }

  async executeAction(action: ActionRequiredEventData & { crawlTabId?: string }): Promise<ActionResultRequest> {
    if (getHumanInteractionContext()?.threadId) {
      return this.executeActionWithContext(action)
    }
    const actionRecord = action as unknown as Record<string, unknown>
    const threadId = (
      actionRecord._thread_id
      ?? actionRecord.thread_id
    )
    if (typeof threadId !== 'string' || !threadId.trim()) {
      return this.executeActionWithContext(action)
    }
    return runWithHumanInteractionContext(
      { threadId, interactionMode: 'interactive' },
      () => this.executeActionWithContext(action),
    )
  }

  private async executeActionWithContext(action: ActionRequiredEventData & { crawlTabId?: string }): Promise<ActionResultRequest> {
    if (this._destroyed) {
      return {
        success: false,
        error: 'FrontendActionBridge has been destroyed (app is shutting down).',
        clean_html: '',
        title: '',
        url: ''
      }
    }

    const { task_id, params, crawlTabId } = action
    const actionType = action.action || (action as any).type
    const requestedTimeoutMs = (action as any).timeout_ms
    const actionTimeoutMs = typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : EXECUTE_ACTION_TIMEOUT_MS
    // ────────────────────────────────────────────────────────
    // runId 语义（系统级约定）
    //
    // explicitTraceId — Agent/WS 注入的权威 trace，唯一来源是
    //   action.trace_id | params.trace_id | action.run_id
    //   **仅此会 createRun()**，用于事件归档、回放、审计。
    //
    // traceId — 宽松标识，含 explicitTraceId 和 params.runId。
    //   用于 view 查找（run.activeViewId）和事件关联，
    //   **不会 createRun()**。
    //
    // CLI 路径通常两者均为空，依赖 crawlTabId + ContextSpace。
    // ────────────────────────────────────────────────────────
    const explicitTraceId = (action as any)?.trace_id || (params as any)?.trace_id || (action as any)?.run_id
    const traceId = explicitTraceId || (params as any)?.runId || (params as any)?.run_id
    const threadId = getHumanInteractionContext()?.threadId
    let effectiveTabId = (params as any)?.crawlTabId || crawlTabId
    let fallbackReason: string | undefined

    log.info('executeAction', actionType, 'task:', task_id)
    log.debug('executeAction detail:', { task_id, actionType, crawlTabId, traceId, threadId, params })

    // ── Monitor fast path — route to MonitorExecutor, bypass normal tool pipeline ──
    if (actionType === 'monitor_start' || actionType === 'monitor_stop') {
      return this._handleMonitorAction(actionType, params as Record<string, unknown>)
    }

    const allowFallback = process.env.TABTIN_FRONTEND_ACTION_FALLBACK === '1'
    try {
      const manager = getRunSessionManager()
      if (explicitTraceId) {
        manager.createRun(explicitTraceId)
      }

      if (!effectiveTabId && traceId && actionType !== 'open_tab') {
        try {
          const run = manager.getRun(traceId)
          if (run?.activeViewId) {
            effectiveTabId = run.activeViewId
            log.debug('复用 run activeViewId:', effectiveTabId)
            manager.setActiveView(traceId, effectiveTabId)
          } else if (run?.views?.length) {
            effectiveTabId = run.views[0].viewId
            log.debug('复用 run 第一个 view:', effectiveTabId)
            manager.setActiveView(traceId, effectiveTabId)
          } else if ((params as any)?.url) {
            const userAgent = (params as any).userAgent || (params as any).ua
            const partition = (params as any).partition
            const proxy = (params as any).proxy
            fallbackReason = 'no_run_view_available'
            if (!allowFallback) {
              log.warn('fallback 已禁用，跳过 runSession.openTab:', {
                runId: traceId,
                url: (params as any).url,
                action: actionType
              })
            } else {
              const result = await manager.openTab({
                runId: traceId,
                url: (params as any).url,
                partition,
                userAgent,
                proxy,
                profile: 'background-task',
                metadata: {
                  source: 'frontend-action',
                  taskId: task_id,
                  action: actionType,
                  fallbackReason
                },
                fallbackReason
              })
              if (result.success && result.id) {
                effectiveTabId = result.id
                log.warn('fallback to background-task view:', {
                  runId: traceId,
                  viewId: result.id,
                  url: (params as any).url,
                  profile: 'background-task',
                  partition,
                  fallbackReason,
                })
                log.debug('runSession.openTab 创建 View:', result)
              } else {
                log.warn('runSession.openTab 创建失败:', result.error)
              }
            }
          }
        } catch (err) {
          log.warn('获取/创建 run 视图失败，继续执行:', err)
        }
      }

      if (!effectiveTabId && traceId && actionType === 'open_tab') {
        try {
          const snapshots = getCrawlspaceContextHub().getAllSnapshots()
          const match = snapshots
            .map(snapshot => snapshot.views.find(view => view.runId === traceId && view.isActive))
            .find(Boolean)
          const fallback = match ?? snapshots.map(s => s.views.find(view => view.runId === traceId)).find(Boolean)
          if (fallback?.viewId) {
            effectiveTabId = fallback.viewId
            log.debug('关联 crawlspace view:', effectiveTabId)
          }
        } catch (err) {
          log.warn('解析 crawlspace view 失败:', err)
        }
        if (!effectiveTabId) {
          fallbackReason = fallbackReason || 'missing_crawlspace_view'
          log.warn('open_tab fallback to background-task (no crawlspace view):', {
            runId: traceId,
            fallbackReason,
          })
        }
      }

      // Auto-enable CDP network monitoring for the target tab
      //  Phase 3: 容器无关取页面 WebContents（WCV 与 webview guest 通吃）
      if (effectiveTabId) {
        try {
          const wc = getViewFactory().getWebContents(effectiveTabId)
          if (wc && !wc.isDestroyed()) {
            enableCDPNetworkForTab(wc, effectiveTabId).catch(() => {})
          }
        } catch { /* non-critical */ }
      }

      // 为 view-creating actions 注入 Space / Crawlspace 上下文。
      //
      // partition 解析（本地化退役 Wave 2 之后）：
      //   1. `params.partition`（Agent 调用方显式传入） —— 尊重上游
      //   2. `BrowserEnvironmentService.getPartitionForSpace(spaceId)` ——
      //      永远立即返回真实 partition（显式绑定 / 默认 env），不抛异常
      // 解析不到时 partition 留空，下游 RunSessionManager 拿 metadata.spaceId
      // 二次解析或返回错误。crawlspaceId 仅作视图分组身份注入，不再参与 partition 拼接。
      const spaceContext: Record<string, any> = {}
      if (actionType === 'open_tab' && !(params as any)?.metadata?.crawlspaceId) {
        const paramsMeta = (params as any)?.metadata || {}
        const spaceId = paramsMeta.spaceId || getCLISpaceId()
        const crawlspaceId = paramsMeta.crawlspaceId || getCLICrawlspaceId()
        const explicitTabScopeKey = (params as any)?.tabScopeKey
        const explicitWorkspaceScopeKey = (params as any)?.workspaceScopeKey
        //  / ：显式 params > 发起 thread lease。
        // 无 thread 的人手动作不读取 legacy/其他 Agent scope，交给 renderer 前台 fallback。
        const fallbackScopeKey = threadId ? getCLIWorkspaceScopeKey(threadId) : null
        const tabScopeKey = explicitTabScopeKey || explicitWorkspaceScopeKey || fallbackScopeKey
        const workspaceScopeKey = explicitWorkspaceScopeKey || explicitTabScopeKey || fallbackScopeKey
        const explicitPartition = (params as any)?.partition
        let resolvedPartition: string | undefined = typeof explicitPartition === 'string' && explicitPartition
          ? explicitPartition
          : undefined
        if (!resolvedPartition && typeof spaceId === 'string' && spaceId) {
          try {
            resolvedPartition = getBrowserEnvironmentService().getPartitionForSpace(spaceId)
          } catch (err) {
            log.warn('getPartitionForSpace 失败，走兼容分支:', err)
          }
        }
        // 本地化退役 Wave 2 之后 BES 永远立即可用，`resolvedPartition` 拿到
        // 的就是真实 env partition；下推到 RunSessionManager 即可，无需额外
        // pending guard。
        if (spaceId || crawlspaceId || resolvedPartition) {
          if (resolvedPartition) spaceContext.partition = resolvedPartition
          spaceContext.metadata = {
            ...paramsMeta,
            ...(crawlspaceId ? { crawlspaceId, kind: 'workspace-view' } : {}),
            ...(spaceId ? { spaceId } : {}),
          }
        }
        if (tabScopeKey) {
          spaceContext.tabScopeKey = tabScopeKey
        }
        if (workspaceScopeKey) {
          spaceContext.workspaceScopeKey = workspaceScopeKey
        }
      }

      let serverPolicy = (action as any)?.sandbox_policy
      const riskLevel: string = serverPolicy?.risk_level ?? 'review'
      const isStrict = riskLevel === 'strict'
      const normalizedServerPolicy = normalizeTerminalExecutionPolicy(serverPolicy)

      if (actionType === 'execute_in_terminal') {
        const command = ((params as any)?.command || '').trim()
        if (command) {
          // Validate working_directory — must not contain command substitution syntax
          const workDir = (params as any)?.working_directory
          if (workDir && typeof workDir === 'string' && containsCommandSubstitution(workDir)) {
            log.warn(`[POLICY] Blocked: working_directory contains command substitution: ${workDir.slice(0, 120)}`)
            return {
              success: false,
              error: 'working_directory contains disallowed shell substitution syntax.',
              error_code: 'POLICY_BLOCKED',
              clean_html: '',
              title: '',
              url: ''
            } as any
          }

          // Validate env keys and values — must not contain command substitution syntax
          const env = (params as any)?.env
          if (env && typeof env === 'object') {
            for (const [key, value] of Object.entries(env)) {
              if (typeof key === 'string' && containsCommandSubstitution(key)) {
                log.warn(`[POLICY] Blocked: env key contains command substitution: ${key.slice(0, 80)}`)
                return {
                  success: false,
                  error: `Environment variable key "${key}" contains disallowed shell substitution syntax.`,
                  error_code: 'POLICY_BLOCKED',
                  clean_html: '',
                  title: '',
                  url: ''
                } as any
              }
              if (typeof value === 'string' && containsCommandSubstitution(value)) {
                log.warn(`[POLICY] Blocked: env value for "${key}" contains command substitution: ${String(value).slice(0, 80)}`)
                return {
                  success: false,
                  error: `Environment variable "${key}" value contains disallowed shell substitution syntax.`,
                  error_code: 'POLICY_BLOCKED',
                  clean_html: '',
                  title: '',
                  url: ''
                } as any
              }
            }
          }

          const cmdHit = checkHardlineCommand(command)
          if (cmdHit.hit) {
            log.warn(`[POLICY] Blocked terminal command: ${command.slice(0, 120)} — ${cmdHit.description} [${cmdHit.pattern}]`)
            return {
              success: false,
              error: cmdHit.description || 'Command blocked by security policy.',
              error_code: 'POLICY_BLOCKED',
              clean_html: '',
              title: '',
              url: ''
            } as any
          }

          const termDecision = evaluateLocalTerminalPolicy(command, serverPolicy)
          if (termDecision.blocked) {
            return {
              success: false,
              error: termDecision.denyReason || 'Command blocked by local sandbox policy.',
              clean_html: '',
              title: '',
              url: ''
            }
          }
          const unsupportedPolicyError = getInteractiveTerminalPolicySupportError(normalizedServerPolicy)
          if (unsupportedPolicyError) {
            const degradation = evaluateTerminalPolicyDegradation(normalizedServerPolicy)
            if (degradation?.canDegrade) {
              log.info(`[DEGRADE] PTY 不支持当前策略，降级到 spawn+sandbox: reason=${degradation.reason}`)
              const workDir = (params as any)?.working_directory || (params as any)?._workspace_root || getCLIOrganizationRoot() || process.cwd()
              const spaceId = (params as any)?._space_id
              const degradeResult = await this.executeDegradedBridge(command, degradation, {
                workingDirectory: workDir,
                spaceId,
                threadId,
              })
              return degradeResult as any
            }
            return {
              success: false,
              error: unsupportedPolicyError,
              clean_html: '',
              title: '',
              url: ''
            }
          }

          // ：统一审批档口径——普通 confirm 由 auto/full_access 旁路；
          // 本机安全底线（relaxed 高危命令，securityFloor）仅 full_access 旁路，
          // auto 仍须确认（对齐 judge「risk 级 auto 转 ask」语义）。
          // 硬红线 checkHardlineCommand/Path 已在上游 block，不受影响。
          const bypassTermApproval = !isStrict && (
            termDecision.securityFloor
              ? shouldBypassSecurityFloorApproval(threadId)
              : shouldBypassConfirmApproval(threadId)
          )
          if (termDecision.approvalRequired && !bypassTermApproval) {
            const truncated = command.length > 200 ? command.slice(0, 200) + '…' : command
            const approvalResult = await requestApproval({
              actionType,
              detail: truncated,
              reason: termDecision.denyReason || undefined,
              isStrict,
            })
            if (!approvalResult.approved) {
              return {
                success: false,
                error: 'This command requires user approval but was denied or timed out.',
                error_code: 'APPROVAL_DENIED',
                clean_html: '',
                title: '',
                url: ''
              } as any
            }
            if (serverPolicy) {
              serverPolicy = { ...serverPolicy, approval_required: false }
            }
          }
        }
      }

      if (actionType === 'write_to_terminal') {
        const data = ((params as any)?.data || '').trim()
        if (data && !isAutoApprovedTerminalWrite(data)) {
          const writeCmdHit = checkHardlineCommand(data)
          if (writeCmdHit.hit) {
            log.warn(`[POLICY] Blocked terminal write: ${data.slice(0, 80)}`)
            return {
              success: false,
              error: writeCmdHit.description || 'Terminal write blocked by security policy.',
              error_code: 'POLICY_BLOCKED',
              clean_html: '',
              title: '',
              url: ''
            } as any
          }
        }
      }

      const filePath = (params as any)?.file_path || (params as any)?.path || ''

      // W2afollow-up：`move_file` 用 `from`/`to` 两个字段而不是单一
      // `path`/`file_path`——上面的 `filePath` 单值拿不到 `from`。下面几段
      // boundary / hardline / sandbox 策略检查都要看 `filePolicyPaths`
      // （move_file 是 [from, to] 两条都要过，其余 FILE_POLICY_ACTIONS 动作
      // 仍是原来的单值 [filePath]），否则从工作区外挪文件进来或挪到工作区外
      // 都可能只查了一头而绕过策略。
      const filePolicyPaths: string[] =
        actionType === 'move_file'
          ? [(params as any)?.from, (params as any)?.to].filter(
              (p: unknown): p is string => typeof p === 'string' && p.length > 0,
            )
          : filePath
            ? [filePath]
            : []

      // Resolve effective workspace_root — aligned with Daemon's normalization
      const effectiveWorkspaceRoot =
        (params as any)?._workspace_root ||
        (params as any)?.working_directory ||
        getCLIOrganizationRoot() ||
        undefined

      // 单根契约（见 docs/single-root-space-prd.md §2.2）：FrontendActionBridge
      // 校验 path 是否在用户允许范围内。allowedRoots = effectiveWorkspaceRoot
      // （来自 LLM ctx 的当前 session cwd） + getCurrentAllowedWorkspaceRoots()
      // （来自 main session.workspaceSnapshot.allowedPaths，单根模型下通常就是
      // working_dir）。Set 去重避免重叠。
      //
      // **过去（多 root）**：要把 TabCode 多个 project / TabFolder 多个 user
      // folder 全合并进 allowedRoots。
      // **现在（单根）**：getCurrentAllowedWorkspaceRoots() 自然只返回 sandbox
      // + working_dir，逻辑保持不变但语义自动收敛。
      const allowedRootsForValidation: string[] = effectiveWorkspaceRoot
        ? Array.from(new Set([effectiveWorkspaceRoot, ...getCurrentAllowedWorkspaceRoots()]))
        : Array.from(new Set([...getCurrentAllowedWorkspaceRoots()]))

      // 路径权限治理 W7 / B6 (W4 P1-3 后续清理)：
      //
      // FrontendActionBridge 是"被远端动作打过来的兜底闸门"，
      // 不能信任 wire envelope 上的 `_already_judged` 字段 ——
      // 任何能塞 wire 的客户端（移动端 / 受 XSS 的 Web 端 / 恶意客户端）
      // 都能伪造此字段绕过 boundary。
      //
      // W4 P1-3 阶段：用 `alreadyJudged` 局部常量显式锁死 false，保留传参链路。
      // W7 / B6 收口：D3 反例"永远 false 的字段挂在签名上"应当彻底清退 ——
      // `validateProjectPath` 的 `alreadyJudged` 默认 false，不传 = false，
      // 行为完全等价。本机 LLM 主路径走 tabcode-adapter（独立链路 + 真值
      // 派生），不经过 FrontendActionBridge。

      // EEL-004: Workspace boundary check for file write/edit/delete
      // 路径权限治理 Wave 2 第一轮 Review P1-3 修复：旧实现 `effectiveWorkspaceRoot`
      // 缺失时整个 boundary 块不跑（fail-open）。Wave 2 收紧——只要
      // `allowedRootsForValidation` 非空（v3 snapshot 有任何授权路径），就用
      // `path.resolve(filePath)` 做绝对化后跑 boundary。
      const hasResolutionBase =
        Boolean(effectiveWorkspaceRoot) || allowedRootsForValidation.length > 0
      if (FILE_POLICY_ACTIONS.has(actionType) && filePolicyPaths.length > 0 && hasResolutionBase) {
        for (const fp of filePolicyPaths) {
          try {
            const resolvedPath = effectiveWorkspaceRoot
              ? resolve(effectiveWorkspaceRoot, fp)
              : resolve(fp)
            validateProjectPath('write', resolvedPath, {
              workspaceRoots: allowedRootsForValidation,
              platformDataRoot: await resolveBoundaryDataRoot(),
            })
          } catch (err: any) {
            log.warn(`[POLICY] Blocked file action: [${actionType}] path "${fp}" outside workspace — ${err.message}`)
            return {
              success: false,
              error: err.message,
              error_code: 'POLICY_BLOCKED',
              clean_html: '',
              title: '',
              url: (params as any)?.url || ''
            } as any
          }
        }
      }

      let fileApprovalAlreadyGranted = false
      if (FILE_POLICY_ACTIONS.has(actionType) && filePolicyPaths.length > 0) {
        for (const fp of filePolicyPaths) {
          const filePathHit = checkHardlinePath(fp, 'file')
          if (filePathHit.hit) {
            log.warn(`[POLICY] Blocked file action: [${actionType}] ${fp} — ${filePathHit.description}`)
            return {
              success: false,
              error: filePathHit.description || 'File operation blocked by security policy.',
              error_code: 'POLICY_BLOCKED',
              clean_html: '',
              title: '',
              url: (params as any)?.url || ''
            } as any
          }
        }
      }

      // EEL-003: Workspace boundary check for read actions (read_file, glob_search, grep_search, read_lints)
      if (READ_SANDBOX_ACTIONS.has(actionType)) {
        const pathsToCheck: string[] = []
        if (actionType === 'glob_search') {
          const td = (params as any)?.target_directory ?? ''
          if (td) pathsToCheck.push(td)
        } else if (actionType === 'grep_search') {
          const searchPath = (params as any)?.path ?? (params as any)?.target_directory ?? ''
          if (searchPath) pathsToCheck.push(searchPath)
        } else if (actionType === 'read_lints') {
          const paths = (params as any)?.paths
          if (Array.isArray(paths)) {
            for (const p of paths) {
              if (typeof p === 'string' && p) pathsToCheck.push(p)
            }
          }
        } else {
          if (filePath) pathsToCheck.push(filePath)
        }
        // 同 EEL-004 修复：effectiveWorkspaceRoot 缺失时仍跑 boundary。
        if (pathsToCheck.length > 0 && hasResolutionBase) {
          for (const fp of pathsToCheck) {
            try {
              const resolvedPath = effectiveWorkspaceRoot
                ? resolve(effectiveWorkspaceRoot, fp)
                : resolve(fp)
              validateProjectPath('read', resolvedPath, {
                workspaceRoots: allowedRootsForValidation,
                platformDataRoot: await resolveBoundaryDataRoot(),
              })
            } catch (err: any) {
              log.warn(`[POLICY] Blocked read action: [${actionType}] path "${fp}" outside workspace — ${err.message}`)
              return {
                success: false,
                error: err.message,
                error_code: 'POLICY_BLOCKED',
                clean_html: '',
                title: '',
                url: (params as any)?.url || ''
              } as any
            }
          }
        }

        if (actionType === 'read_file' && filePath) {
          const readPathHit = checkHardlinePath(filePath, 'file')
          if (readPathHit.hit) {
            log.warn(`[POLICY] Blocked read_file: ${filePath} — ${readPathHit.description} [${readPathHit.pattern}]`)
            return {
              success: false,
              error: readPathHit.description || 'File read blocked by security policy.',
              error_code: 'POLICY_BLOCKED',
              clean_html: '',
              title: '',
              url: (params as any)?.url || ''
            } as any
          }
        }

        if (actionType === 'glob_search' || actionType === 'grep_search') {
          for (const p of pathsToCheck) {
            const searchPathHit = checkHardlinePath(p, 'file')
            if (searchPathHit.hit) {
              log.warn(`[POLICY] Blocked ${actionType}: ${searchPathHit.description} [${searchPathHit.pattern}]`)
              return {
                success: false,
                error: searchPathHit.description || `${actionType} blocked by security policy.`,
                error_code: 'POLICY_BLOCKED',
                clean_html: '',
                title: '',
                url: (params as any)?.url || ''
              } as any
            }
          }
        }

        if (actionType === 'read_lints') {
          for (const p of pathsToCheck) {
            const diagPathHit = checkHardlinePath(p, 'file')
            if (diagPathHit.hit) {
              log.warn(`[POLICY] Blocked read_lints: path "${p}" — ${diagPathHit.description} [${diagPathHit.pattern}]`)
              return {
                success: false,
                error: diagPathHit.description || 'read_lints path blocked by security policy.',
                error_code: 'POLICY_BLOCKED',
                clean_html: '',
                title: '',
                url: (params as any)?.url || ''
              } as any
            }
          }
        }
      }

      // EEL-009: evaluateLocalFilePolicy only applies to write actions, not reads
      if (FILE_POLICY_ACTIONS.has(actionType)) {
        // move_file 有 from/to 两条路径，各自可能命中不同的 sensitive-pattern /
        // security floor（比如从 .ssh/ 挪出来 vs 挪进普通目录本该判定不同）——
        // 逐条评估后取"最严格"的合并结果：只要有一条 blocked 就整体 block；
        // 没有 blocked 时只要有一条要审批就整体要审批（securityFloor 同理取
        // 命中的那条，不能因为另一条路径不敏感就把 floor 语义冲淡）。
        let fileDecision: ReturnType<typeof evaluateLocalFilePolicy> = {
          blocked: false,
          approvalRequired: false,
        }
        for (const fp of filePolicyPaths.length > 0 ? filePolicyPaths : [filePath]) {
          const decision = evaluateLocalFilePolicy(actionType, fp, serverPolicy)
          if (decision.blocked) {
            fileDecision = decision
            break
          }
          if (decision.approvalRequired && !fileDecision.approvalRequired) {
            fileDecision = decision
          }
        }
        if (fileDecision.blocked) {
          return {
            success: false,
            error: fileDecision.denyReason || 'Action blocked by sandbox policy.',
            clean_html: '',
            title: '',
            url: (params as any)?.url || ''
          }
        }
        // SDP-008: Skip redundant approval if PolicyEvaluator already prompted and user approved
        // ：普通 confirm 由 auto/full_access 旁路；本机安全底线（file_delete /
        // 敏感文件写，securityFloor）仅 full_access 旁路，auto 仍须确认（硬红线在上游 block）。
        const bypassFileApproval = !isStrict && (
          fileDecision.securityFloor
            ? shouldBypassSecurityFloorApproval(threadId)
            : shouldBypassConfirmApproval(threadId)
        )
        if (fileDecision.approvalRequired && !fileApprovalAlreadyGranted && !bypassFileApproval) {
          const approvalDetailSource = filePolicyPaths.length > 0 ? filePolicyPaths.join(' -> ') : filePath
          const truncatedPath =
            approvalDetailSource.length > 150 ? '…' + approvalDetailSource.slice(-150) : approvalDetailSource
          const approvalResult = await requestApproval({
            actionType,
            detail: truncatedPath,
            reason: fileDecision.denyReason || undefined,
            isStrict,
          })
          if (!approvalResult.approved) {
            return {
              success: false,
              error: 'This file operation requires user approval but was denied or timed out. The user may be away or chose to reject this operation.',
              error_code: 'APPROVAL_DENIED',
              clean_html: '',
              title: '',
              url: (params as any)?.url || ''
            } as any
          }
          if (serverPolicy) {
            serverPolicy = { ...serverPolicy, approval_required: false }
          }
        }
      }

      if (CHECKPOINT_MUTATING_ACTIONS.has(actionType)) {
        if (actionType === 'checkpoint_restore') {
          const projectPath = (params as any)?.project_path
          const commitHash = (params as any)?.commit_hash
          if (projectPath && typeof projectPath === 'string' && commitHash && typeof commitHash === 'string') {
            try {
              validateProjectPath('write', projectPath, {
                workspaceRoots: allowedRootsForValidation,
                platformDataRoot: await resolveBoundaryDataRoot(),
              })
              const service = getCheckpointService(projectPath)
              const affectedRelPaths = await service.getAffectedPaths(commitHash)
              for (const relPath of affectedRelPaths) {
                const absPath = resolve(projectPath, relPath)
                const restorePathHit = checkHardlinePath(absPath, 'file')
                if (restorePathHit.hit) {
                  log.warn(`[POLICY] Blocked checkpoint_restore: file "${relPath}" hits hardline — ${restorePathHit.description}`)
                  return {
                    success: false,
                    error: `Checkpoint restore blocked: restoring would write to protected path '${relPath}'. ${restorePathHit.description}`,
                    error_code: 'POLICY_BLOCKED',
                    clean_html: '',
                    title: '',
                    url: ''
                  } as any
                }
              }
            } catch (err) {
              log.warn(`[POLICY] Blocked checkpoint_restore: pre-check failed — ${err instanceof Error ? err.message : String(err)}`)
              return {
                success: false,
                error: `Checkpoint restore blocked: unable to verify that restore does not write to protected paths. ${err instanceof Error ? err.message : String(err)}`,
                error_code: 'POLICY_BLOCKED',
                clean_html: '',
                title: '',
                url: ''
              } as any
            }
          }
        }
      }

      // Wave 1.5（2026-05-13）Round 1 review M3 自修复：把
      // `effectiveWorkspaceRoot` 写回 `_workspace_root` —— 跟 daemon
      // `action-bridge.ts` 顶部的 `if (!params._workspace_root) {
      // params._workspace_root = params.working_directory || config.workspace_root; }`
      // 对称。下游 ActionExecutorAdapter 加锁时用 `enrichedParams._workspace_root`
      // 作为 canonicalizePath 的 baseDir —— 缺这条 normalize 会让边缘场景
      // （server push action 带相对路径 + 不显式传 _workspace_root）的 canonical
      // key 退化到 `process.cwd()`，跟 LLM Agent 主路径的 key 不一致，破跨入口
      // 锁串行不变量（虽然 production 几乎不可能触发，但跟 daemon 不对称是
      // 实际缺陷）。
      const enhancedParams = {
        ...params,
        ...spaceContext,
        ...(effectiveWorkspaceRoot ? { _workspace_root: effectiveWorkspaceRoot } : {}),
        ...(effectiveTabId ? { crawlTabId: effectiveTabId } : {}),
        ...(traceId ? { trace_id: traceId, runId: traceId } : {}),
        ...(actionType === 'open_tab' && fallbackReason ? { fallbackReason } : {}),
        ...(serverPolicy ? { _sandbox_policy: serverPolicy } : {}),
      }

      const executeCore = async (): Promise<any> => {
        const actionPromise = this.adapter.executeAction({
          task_id,
          type: actionType,
          params: enhancedParams,
          thread_id: threadId || '',
          run_id: traceId
        })

        let timer: ReturnType<typeof setTimeout>
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            `Action "${actionType}" timed out after ${actionTimeoutMs / 1000}s (task: ${task_id})`
          )), actionTimeoutMs)
        })

        try {
          return await Promise.race([actionPromise, timeoutPromise])
        } finally {
          clearTimeout(timer!)
        }
      }

      // Wave 1.5（2026-05-13）：文件锁的责任已收口到 ActionExecutorAdapter
      // 一侧（统一 `withFileLock` 跨入口共享 lockMap）。本层不再嵌外层锁——
      // 避免「上层包下层又包」同 key 死锁。FILE_POLICY_ACTIONS 集合保留——
      // 它在上方 EEL-004 / EEL-009 等位置用作「需要 sandbox boundary 检查的
      // 文件操作」标记，不只是锁专用。
      // 用 `let`：下方反爬自适应升级分支会重新赋值 `result = retryResult`。
      let result: any = await executeCore()

      // ── 反爬自适应升级（独立于 allowFallback，由 AccessStrategyService.policy 控制）──
      if (result?.accessUpgradeNeeded && traceId) {
        const {
          getSharedAccessStrategyService, AccessLevel,
        } = await import('@tabtin/browser-core')
        const strategyService = getSharedAccessStrategyService()

        if (strategyService.isUpgradeEnabled()) {
          const upgradeLog = result.accessUpgradeLog || '检测到访问限制，升级访问策略'
          log.warn('[AccessStrategy]', upgradeLog)

          // W1.3 / R2 F3：等待启动期 transient partition 清理完成再创建升级 view，
          // 避免"启动 fire-and-forget clearStorageData 与第一次升级写入"的 race
          // —— 否则升级刚写入的 cookies 会被启动期清扫线程清掉。`awaitStartupClear`
          // 内部 5s 超时，防 hang。
          await awaitUpgradePartitionStartupClear()

          // W1.3 / R2 F1：升级流程引用计数 +1 —— release fn 在 finally 调用时
          // 才真正 -1 + 末次清 partition。多个并发升级共享同一 partition 时
          // 不会因为某个先完成的 finally 把别人正在用的 cookies 清掉。
          const releaseUpgradeRefcount = acquireUpgradeRefcount()

          const manager = getRunSessionManager()
          // W1.3 / R2 F4：在 openTab 之前记录当前 activeViewId，retry 完成后
          // 把 activeView 切回原值，并 closeTab 升级 view —— 避免升级 view
          // 留在 manager 里继续作为 activeView，导致后续同 traceId 请求命中
          // 一个 session 已被清空的"空壳" view（用户登录态被误清）。
          const prevActiveViewId =
            manager.getRun(traceId)?.activeViewId ?? null
          let upgradeViewId: string | null = null
          try {
            const upgradeConfig = result.accessUpgradeConfig
            const targetUrl = (params as any)?.url || result?.url || ''

            const upgradeResult = await manager.openTab({
              runId: traceId,
              url: targetUrl,
              profile: 'background-task',
              antiDetect: upgradeConfig,
              // W1.3 / A2-H2 修复：复用稳定 partition，启动期统一清理（见
              // 模块顶部 UPGRADE_TRANSIENT_PARTITION 的注释）。
              partition: UPGRADE_TRANSIENT_PARTITION,
              metadata: {
                source: 'access-strategy-upgrade',
                taskId: task_id,
                action: actionType,
                upgradeLog,
              },
            })

            if (upgradeResult.success && upgradeResult.id) {
              upgradeViewId = upgradeResult.id
              log.info('[AccessStrategy] 升级 View 创建成功:', upgradeResult.id)

              const retryParams = {
                ...enhancedParams,
                crawlTabId: upgradeResult.id,
              }
              const retryResult = await this.adapter.executeAction({
                task_id,
                type: actionType,
                params: retryParams,
                thread_id: threadId || '',
                run_id: traceId,
              }) as any

              if (!retryResult?.block?.blocked) {
                log.info('[AccessStrategy] 升级后访问成功')
                if (targetUrl) {
                  strategyService.recordSuccess(targetUrl, AccessLevel.L1)
                  const { scheduleSave } = await import('./SiteAccessMemoryPersistence')
                  scheduleSave()
                }
                result = retryResult
              } else {
                log.warn('[AccessStrategy] 升级后仍被封禁，标记需要人机协作')
                result = {
                  ...retryResult,
                  humanAssistRequired: true,
                  accessStrategyLog: `${upgradeLog} → 升级后仍被封禁，需要人工协助`,
                }
              }
            }
          } catch (upgradeError) {
            log.warn('[AccessStrategy] 升级重试失败:', upgradeError)
          } finally {
            // W1.3 / R2 F4：升级 view 仅服务于本次 retry。retry 完成后必须：
            //   1. closeTab：把升级 view 从 RunSessionManager 摘掉，避免它
            //      作为 run.activeViewId 被后续同 traceId 请求复用
            //   2. 恢复 prevActiveViewId：openTab 内部会自动 setActiveView，
            //      若上游 run 之前有别的 active view，需要切回去
            //   3. release refcount：内部仅当末次（计数归零）才 clearStorageData
            //      transient partition 的所有持久化数据（cookies / IDB / SW
            //      / cache）—— 防 R2 F1 并发互踩
            // 三步顺序无依赖，但都必须 best-effort 不抛——失败不能阻塞业务。
            if (upgradeViewId) {
              try {
                await manager.closeTab({
                  runId: traceId,
                  viewId: upgradeViewId,
                  force: true,
                })
              } catch (closeErr) {
                log.warn('[AccessStrategy] 关闭升级 view 失败（非致命）:', closeErr)
              }
              try {
                manager.setActiveView(traceId, prevActiveViewId)
              } catch (restoreErr) {
                log.warn('[AccessStrategy] 恢复 prevActiveViewId 失败（非致命）:', restoreErr)
              }
            }
            await releaseUpgradeRefcount()
          }
        }
      }

      log.debug('动作执行完成:', actionType)
      return result as unknown as ActionResultRequest

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('动作执行失败:', {
        task_id,
        actionType,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      })

      return {
        success: false,
        error: errorMessage,
        clean_html: '',
        title: '',
        url: params?.url || ''
      }
    }
  }

  // ── Monitor ────────────────────────────────────────────────────────

  /**
   * 进程监控事件经 WebSocket 网关上报。启动前必须已登录且能解析 organizationId，
   * 否则拒绝 `monitor_start`，避免 PTY 已创建但云端永远收不到事件（过去仅 log.warn 静默跳过 send）。
   */
  private async resolveMonitorGatewayAuth(): Promise<
    | { ok: true; token: string; organizationId: string }
    | { ok: false; error: string; error_code: 'MONITOR_NO_AUTH' | 'MONITOR_NO_ORGANIZATION' }
  > {
    const token = await TokenManager.getAccessToken()
    if (!token) {
      return {
        ok: false,
        error: '未登录：进程监控需要有效登录。请检查登录状态后重试。',
        error_code: 'MONITOR_NO_AUTH' as const,
      }
    }
    const userInfo = await TokenManager.getUserInfo()
    const organizationId =
      process.env.TABTIN_ORGANIZATION_ID ||
      resolveOrganizationIdFromUserInfo(userInfo) ||
      ''
    if (!organizationId) {
      return {
        ok: false,
        error: '缺少组织：进程监控需要关联组织。请切换到一个组织后重试。',
        error_code: 'MONITOR_NO_ORGANIZATION' as const,
      }
    }
    return { ok: true, token, organizationId }
  }

  private _monitorExecutor: import('../monitor/MonitorExecutor').MonitorExecutor | null = null

  /** 连续上报失败后即将 stopAll 时通知渲染进程（toast + 可选卡片文案见 monitor:emitInterrupted） */
  private _notifyAgentMonitorEmitInterrupted(): void {
    try {
      if (this._destroyed) return
      const wc = this.mainWindow?.webContents
      if (!wc || wc.isDestroyed()) return
      wc.send('agent-monitor:emit-interrupted')
    } catch {
      // ignore
    }
  }

  private _getMonitorExecutor(): import('../monitor/MonitorExecutor').MonitorExecutor {
    if (!this._monitorExecutor) {
      let consecutiveEmitFailures = 0
      this._monitorExecutor = new MonitorExecutor(async (eventType, payload) => {
        try {
          const token = await TokenManager.getAccessToken()
          if (!token) {
            consecutiveEmitFailures++
            log.warn(`Monitor emit skipped: no auth token (consecutive failures: ${consecutiveEmitFailures})`)
            if (consecutiveEmitFailures >= 5) {
              log.error(`Monitor emit failed ${consecutiveEmitFailures} consecutive times (no auth token), stopping all monitors`)
              this._notifyAgentMonitorEmitInterrupted()
              this._monitorExecutor?.stopAll()
            }
            return
          }
          const userInfo = await TokenManager.getUserInfo()
          const organizationId =
            process.env.TABTIN_ORGANIZATION_ID ||
            resolveOrganizationIdFromUserInfo(userInfo) ||
            ''
          if (!organizationId) {
            consecutiveEmitFailures++
            log.warn(`Monitor emit skipped: no organization id (consecutive failures: ${consecutiveEmitFailures})`)
            if (consecutiveEmitFailures >= 5) {
              log.error(`Monitor emit failed ${consecutiveEmitFailures} consecutive times (no organization id), stopping all monitors`)
              this._notifyAgentMonitorEmitInterrupted()
              this._monitorExecutor?.stopAll()
            }
            return
          }
          await electronWsGateway.request(
            { token, organizationId },
            eventType,
            payload as Record<string, unknown>,
          )
          consecutiveEmitFailures = 0
        } catch (err) {
          consecutiveEmitFailures++
          log.warn(`Monitor emit failed (consecutive failures: ${consecutiveEmitFailures}):`, err)
          if (consecutiveEmitFailures >= 5) {
            log.error(`Monitor emit failed ${consecutiveEmitFailures} consecutive times, stopping all monitors`)
            this._notifyAgentMonitorEmitInterrupted()
            this._monitorExecutor?.stopAll()
          }
        }
      })
    }
    return this._monitorExecutor
  }

  private async _handleMonitorAction(
    actionType: string,
    params: Record<string, unknown>,
  ): Promise<ActionResultRequest> {
    try {
      const executor = this._getMonitorExecutor()
      if (actionType === 'monitor_start') {
        const auth = await this.resolveMonitorGatewayAuth()
        if (!auth.ok) {
          return {
            success: false,
            error: `[${auth.error_code}] ${auth.error}`,
            clean_html: '',
            title: '',
            url: '',
          } as ActionResultRequest
        }
        const result = await executor.start(params as any)
        return {
          success: result.success,
          error: result.error || '',
          clean_html: '',
          title: '',
          url: '',
        } as ActionResultRequest
      }
      if (actionType === 'monitor_stop') {
        executor.stop(params as any)
        return {
          success: true,
          error: '',
          clean_html: '',
          title: '',
          url: '',
        } as ActionResultRequest
      }
      return { success: false, error: `Unknown monitor action: ${actionType}`, clean_html: '', title: '', url: '' } as ActionResultRequest
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('Monitor action failed:', msg)
      return { success: false, error: msg, clean_html: '', title: '', url: '' } as ActionResultRequest
    }
  }

  /**
   * 销毁服务（清理资源）
   */
  async destroy(): Promise<void> {
    log.info('销毁服务...')
    this._destroyed = true
    // Wave 1.5（2026-05-13）：旧 file-lock-manager dispose 调用已删除——
    // 对应字段不再存在。新 `withFileLock` 实现无 dispose-cancel-all 语义；
    // in-flight withFileLock 调用在 finally 自动 refCount-- + Map.delete。

    if (this._monitorExecutor) {
      this._monitorExecutor.stopAll()
      this._monitorExecutor = null
    }

    if (this._disposeToolRegistry) {
      this._disposeToolRegistry()
      this._disposeToolRegistry = null
    }
    const impl = getSharedBrowserToolImpl()
    await impl.destroy()
    if (this.streamProgressHandler) {
      getStreamDownloadService().removeListener('progress', this.streamProgressHandler)
      this.streamProgressHandler = null
    }
    if (this.contextSpaceBridge) {
      this.contextSpaceBridge.destroy()
      this.contextSpaceBridge = null
    }
    await getLocalMcpService().dispose().catch(() => undefined)
  }

  /**
   * PTY 策略降级执行：当 PTY 不支持 sandbox/network-restricted 策略时，
   * 降级到 CommandExecutor spawn+sandbox 执行，并将输出推送到 PTY 数据通道。
   * 核心逻辑已提取到 @tabtin/terminal-core 的 executeDegraded。
   */
  private async executeDegradedBridge(
    command: string,
    degradation: DegradationDecision,
    context: {
      workingDirectory: string
      spaceId?: string
      threadId?: string
    },
  ): Promise<Record<string, any>> {
    const ptyManager = getPtyManager()
    let sessionId: string | undefined

    if (context.threadId && context.spaceId) {
      sessionId = ptyManager.resolveThreadSession(context.threadId) ?? undefined
    }
    if (!sessionId && context.spaceId && context.threadId) {
      sessionId = ptyManager.getOrSpawnAgentSession(
        context.threadId,
        context.spaceId,
        { cwd: context.workingDirectory },
      ) ?? undefined
    }

    if (sessionId) {
      ptyManager.triggerAutoCheckpoint(sessionId)
    }

    const result = await executeDegraded({
      command,
      cwd: context.workingDirectory,
      degradation,
      threadId: context.threadId,
      timeout: 120_000,
      onOutput: (data) => {
        if (sessionId) {
          ptyManager.emit('data', sessionId, data)
        }
      },
    })

    if (result.interactiveBlocked) {
      log.info(`[HITL-UPGRADE] 交互式命令检测到: ${result.matchedCommand} — ${result.interactiveReason}`)
      const detail = `${command.length > 200 ? command.slice(0, 200) + '…' : command}\n\n⚠ ${result.interactiveReason}`
      const { approved: interactiveApproved } = await requestApproval({
        actionType: 'interactive_command',
        detail,
        mode: 'pty_direct',
        reason: result.interactiveReason || undefined,
        isStrict: true,
      })
      if (!interactiveApproved) {
        return {
          success: false,
          error: `Interactive command requires approval but was denied: ${result.interactiveReason}`,
          error_code: 'APPROVAL_DENIED',
          clean_html: '',
          title: '',
          url: '',
        }
      }
      if (sessionId) {
        const ptyResult = await ptyManager.executeCommand(sessionId, command, {
          workingDirectory: context.workingDirectory,
          context: { threadId: context.threadId },
        })
        return {
          success: true,
          data: {
            output: ptyResult.output,
            exit_code: ptyResult.exitCode,
            command_succeeded: ptyResult.exitCode === 0,
            cwd: ptyResult.cwd,
            backgrounded: ptyResult.backgrounded,
            timed_out: ptyResult.timedOut,
            duration_ms: ptyResult.durationMs,
            session_id: sessionId,
            interactive_upgraded: true,
          },
        }
      }
      return {
        success: false,
        error: 'Interactive command approved but no PTY session available.',
        error_code: 'NO_SESSION',
        clean_html: '',
        title: '',
        url: '',
      }
    }

    if (result.exitCode !== 0 && result.stdout === '' && result.stderr !== '') {
      return {
        success: false,
        error: result.stderr,
        clean_html: '',
        title: '',
        url: '',
      }
    }

    return {
      success: true,
      data: {
        output: result.stdout || result.stderr,
        exit_code: result.exitCode,
        command_succeeded: result.exitCode === 0,
        cwd: result.cwd,
        backgrounded: false,
        timed_out: result.timedOut,
        duration_ms: result.durationMs,
        session_id: sessionId,
        degraded: true,
        degrade_reason: degradation.reason,
        ...(result.warnings.length ? { warnings: result.warnings } : {}),
      },
    }
  }

  private ensureStreamProgressForwarding(): void {
    if (this.streamProgressHandler) return
    this.streamProgressHandler = (progress: StreamProgressEvent) => {
      try {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('download:stream:progress', progress)
        }
      } catch { /* noop */ }
    }
    getStreamDownloadService().on('progress', this.streamProgressHandler)
  }
}

/**
 * 创建前端动作桥接服务
 */
export function createFrontendActionBridge(mainWindow: BrowserWindow): FrontendActionBridge {
  return new FrontendActionBridge(mainWindow)
}
