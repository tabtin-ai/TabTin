import { randomUUID } from 'crypto'
import type { RunObservationEvent, RunSessionSnapshot, RunViewInfo } from '@shared/run-session-snapshot'
export type { RunObservationEvent, RunSessionSnapshot, RunViewInfo } from '@shared/run-session-snapshot'
import { getCrawlspaceContextHub } from '../crawlspace/CrawlspaceContextHub'
import { syncWorkspaceViewMetadata } from '../crawlspace/view-metadata-sync'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import { getEventPersistence } from './EventPersistence'
import { getCLISpaceId, getCLICrawlspaceId } from '../cli/cli-context'
import { getBrowserEnvironmentService } from '../browser-env/BrowserEnvironmentService'
import { createLogger } from '../logger'

const log = createLogger('RunSessionManager')

type ViewFactoryLike = {
  createView: (config: any) => Promise<{ id: string; profile?: string; reused?: boolean }>
  markViewInUse: (id: string) => void
  hasView: (id: string) => boolean
  getViewState: (id: string) => any
  getStats: () => { total: number }
  showView: (id: string, options?: any) => Promise<void>
  destroyView: (id: string, options?: any) => Promise<void>
  onTaskCompleted: (viewId: string, context?: { taskId?: string; status?: string; reason?: string }) => Promise<void>
  on: (event: string, handler: (...args: any[]) => void) => any
}

let viewFactoryAccessor: (() => ViewFactoryLike) | null = null

export function setViewFactoryAccessor(accessor: () => ViewFactoryLike): void {
  viewFactoryAccessor = accessor

  // AA-005 修复：订阅 view:destroyed 事件，自动清理 viewToRun 孤儿条目。
  // autoClose=false 的 View 在 endRun 后保留 viewToRun 映射，若用户直接关闭
  // 窗口（不经 closeTab 路径），unregisterView 不会被调用导致条目永久驻留。
  try {
    const vf = accessor()
    vf.on('view:destroyed', ({ id }: { id: string }) => {
      getRunSessionManager().handleViewDestroyed(id)
    })
  } catch {
    // ViewFactory 尚未完全初始化时忽略，后续操作会通过其他路径兜底
  }
}

function getViewFactoryOrThrow(): ViewFactoryLike {
  if (!viewFactoryAccessor) {
    throw new Error('ViewFactory 未注入 RunSessionManager')
  }
  return viewFactoryAccessor()
}

// ==================== 配额配置 🆕 ====================

export interface QuotaConfig {
  /**
   * 最大并发 Run 数
   */
  maxConcurrentRuns: number

  /**
   * 每个 Run 最大 View 数
   */
  maxViewsPerRun: number

  /**
   * 全局最大 View 数
   */
  maxTotalViews: number

  /**
   * Run 超时时间（毫秒，0 表示不超时）
   */
  runTimeout: number

  /**
   * 是否启用配额控制
   */
  enabled: boolean
}

export const DEFAULT_QUOTA: QuotaConfig = {
  maxConcurrentRuns: 10,
  maxViewsPerRun: 5,
  maxTotalViews: 50,
  runTimeout: 30 * 60 * 1000, // 30 分钟
  enabled: true
}

// ==================== 现有类型定义（RunViewInfo / RunObservationEvent 见 @shared/run-session-snapshot）====================

/**
 * Run 的上下文数据
 *
 * 注意：虽然名为 SessionContext，实际上这是 Run 的数据结构（历史命名遗留）
 */
export interface SessionContext {
  /** Run ID（主键，唯一标识一次执行） */
  runId: string

  /**
   * Session ID（预留字段）
   *
   * ⚠️ 当前版本无实际作用，仅作为可选的分组标识
   * 未来可能用于：
   * - 按 sessionId 查询多个 Run（同一对话的多次执行）
   * - 按 sessionId 聚合统计（同一会话的总耗时）
   * - 按 sessionId 清理资源（一键清理某个会话的所有 Run）
   *
   * 当前实现：
   * - ❌ 没有按 sessionId 索引
   * - ❌ 没有按 sessionId 查询的 API
   * - ❌ 不影响任何业务逻辑
   */
  sessionId: string

  /**
   * 默认 Profile（用于该 Run 创建的 View）
   *
   * ⭐ 用途：
   * - Crawlspace 可指定 profile，后续 openTab 如未显式指定则复用该值
   * - 如果未设置，openTab 时默认使用 'background-task'
   */
  profile?: string

  /** 当前活跃的 View ID */
  activeViewId?: string | null

  /** 该 Run 关联的所有 View */
  views: Map<string, RunViewInfo>

  /** 会话内存（预留，当前未使用） */
  memory: Record<string, any>

  /**
   * 执行日志流（Observations）
   *
   * ⭐ 核心功能：记录 Run 的所有操作、观察、错误等事件
   * - 自动记录：页面导航、标签操作、工具调用、数据提取
   * - Ring Buffer：最多保留 200 条（FIFO 淘汰）
   * - 用途：调试、回溯、性能分析、Agent 历史追踪
   */
  observations: RunObservationEvent[]

  /** 创建时间戳 */
  createdAt: number

  /** 最后更新时间戳 */
  updatedAt: number

  /** 最后事件时间戳（用于超时判断） */
  lastEventAt: number | null

  /** 关联的 Space ID（用于资源归属和审计） */
  spaceId?: string | null

  /** 关联的 Crawlspace ID（用于视图隔离） */
  crawlspaceId?: string | null

  /** 事件总计数（单调递增，不受 ring buffer 截断影响） */
  totalEventCount: number
}

interface AddObservationInput {
  runId?: string
  viewId?: string
  type: string
  timestamp?: number
  data?: any
  context?: RunObservationEvent['context']
}

export interface OpenTabOptions {
  runId?: string
  id?: string
  url?: string
  profile?: string
  partition?: string
  userAgent?: string
  proxy?: any
  antiDetect?: any
  metadata?: Record<string, any>
  fallbackReason?: string
  displayMode?: 'embedded' | 'windowed' | 'hidden'
  showInSidebar?: boolean
  notifyRenderer?: boolean
  tabName?: string
  keepAlive?: boolean
  inUse?: boolean
}

interface SwitchTabOptions {
  runId?: string
  viewId: string
  bounds?: any
}

interface CloseTabOptions {
  runId?: string
  viewId: string
  force?: boolean
}

/**
 * Run 统计信息
 */
export interface RunStats {
  /** Run ID */
  runId: string

  /** Session ID（预留字段，当前版本无实际作用） */
  sessionId: string

  /** 归属 Space ID */
  spaceId: string | null

  /** 归属 Crawlspace ID */
  crawlspaceId: string | null

  /** View 总数 */
  viewCount: number

  /** 使用中的 View 数量 */
  inUseViewCount: number

  /** 当前活跃的 View ID */
  activeViewId: string | null

  /** 创建时间戳 */
  createdAt: number

  /** 最后更新时间戳 */
  updatedAt: number

  /** 最后事件时间戳 */
  lastEventAt: number | null

  /** 事件总数 */
  eventCount: number
}

export interface RunSessionStats {
  totalRuns: number
  activeRuns: number
  totalViews: number
  inUseViews: number
  runs: RunStats[]
}

/**
 * Run/Session 管理器（主进程内存）
 * - 管理 runId → SessionContext（activeViewId、view 列表、记忆 KV、事件）
 * - 提供 viewId → runId 映射，便于事件归集
 * - 提供简单的事件 ring buffer 查询
 * - 配额控制和超时回收 🆕
 */
class RunSessionManager {
  private runs = new Map<string, SessionContext>()
  private viewToRun = new Map<string, string>()
  private readonly maxEventsPerRun = 200
  private quota: QuotaConfig = { ...DEFAULT_QUOTA }  // 🆕
  private timeoutCheckInterval: NodeJS.Timeout | null = null  // 🆕
  private isCheckingTimeout = false
  private _openTabLock: Promise<void> = Promise.resolve()
  /**
   * Wave 2b 补丁 P1-3（独立质疑 10）+ Wave 2b 真·收尾补丁 P1-新-1：订阅
   * BrowserEnvironmentService 的 changed 事件，在 Space 被删除 / 绑定变更时
   * 给受影响的 runSession 记一条**可观测**的事件。
   *
   * ## 产品语义（已与用户拍板）
   *
   * Env 切换时，**正在进行中的 Agent run 继续用旧 session 跑到结束**；下一次
   * run 使用新 session。这符合用户对"run 原子性"的预期：
   *   - 用户启动一个 Agent 任务 → run 内部视角是一致的（同一 env 的 cookie /
   *     登录态）
   *   - 中途改了 Space↔env 绑定 → 不打断正在跑的 run，让它用老状态完成
   *   - 下次新 run 起来时才切到新环境
   *
   * ## 代码行为
   *
   * 事件到达 → 对匹配 spaceId 的活跃 run 打观测事件 `SPACE_ENV_CHANGED` +
   * warn 日志。**不调用 endRun，不打断 view**。`observation.data.fallbackReason`
   * 只是诊断用字段，方便事后排查"这条 run 为什么 cookie 看起来不对"——
   * **不**触发任何 abort 行为。
   *
   * 语义与 Wave 2b 真·收尾补丁 P1-新-1 对齐的关键点：
   *   - 旧版本代码暗示"未来可能 abort"，现在明确声明**不会**
   *   - 被影响 run 的 view 仍跑在原 session，cookie / 登录态保留直到 run 结束
   *   - `envChangedRuns` 集合防止同一 run 被重复 observe（一个 run 生命周期里
   *     多次 env 变更只记第一次即可，避免日志噪音）
   *
   * 详见 PRD 附录 "Env 切换与 Run 原子性" 段（docs/planning/credential-identity-prd.md）。
   */
  private browserEnvUnsubscribe: (() => void) | null = null
  /** 标记被 browser-env 事件影响过的 run（调试用，避免重复 warn）。 */
  private readonly envChangedRuns = new Set<string>()

  constructor() {
    this.startTimeoutChecker()
    this.subscribeBrowserEnvChanges()
  }

  /**
   * 懒注入 BrowserEnvironmentService 订阅。
   *
   * 失败兜底：Service 单例在测试环境可能被 mock 掉,没有 onChanged 方法；
   * 此时静默跳过不影响主流程。
   */
  private subscribeBrowserEnvChanges(): void {
    try {
      const svc = getBrowserEnvironmentService() as unknown as {
        onChanged?: (cb: (p: { reason: string; spaceId?: string; environmentId?: string }) => void) => () => void
      }
      if (typeof svc?.onChanged !== 'function') return
      this.browserEnvUnsubscribe = svc.onChanged((payload) => {
        if (!payload) return
        if (payload.reason !== 'bound' && payload.reason !== 'deleted') return
        const affectedSpaceId = payload.spaceId
        if (!affectedSpaceId) return
        for (const [runId, ctx] of this.runs) {
          if (ctx.spaceId !== affectedSpaceId) continue
          if (this.envChangedRuns.has(runId)) continue
          this.envChangedRuns.add(runId)
          // 语义：不打断当前 run。旧 session 继续跑到 endRun；下一次 run 走
          // 新 env。日志只用作可观测性，Agent 侧如需感知可读 observation。
          log.warn(
            'browser-env 变更事件到达（run 继续用旧 session 跑到结束）',
            { runId, spaceId: affectedSpaceId, reason: payload.reason },
          )
          this.addObservation({
            runId,
            type: 'SPACE_ENV_CHANGED',
            data: {
              reason: payload.reason,
              spaceId: affectedSpaceId,
              environmentId: payload.environmentId,
              // 诊断字段：不是 "Agent 应该 fallback 到别的逻辑" 的指令，只是
              // 历史命名留下的描述性标签。run 不会 abort。
              diagnosticNote: 'space_env_changed (run continues on old session until endRun)',
            },
          })
        }
      })
    } catch (err) {
      log.warn('subscribeBrowserEnvChanges 失败（不阻塞）', err)
    }
  }

  /**
   * 配置配额 🆕
   */
  configureQuota(config: Partial<QuotaConfig>): void {
    this.quota = { ...this.quota, ...config }
    log.info('配额已更新', this.quota)
  }

  /**
   * 获取当前配额配置 🆕
   */
  getQuota(): QuotaConfig {
    return { ...this.quota }
  }

  /**
   * 检查是否可以创建新 Run 🆕
   */
  private checkQuotaForNewRun(): { allowed: boolean; reason?: string } {
    if (!this.quota.enabled) {
      return { allowed: true }
    }

    const currentRuns = this.runs.size
    if (currentRuns >= this.quota.maxConcurrentRuns) {
      return {
        allowed: false,
        reason: `达到最大并发 Run 数限制 (${this.quota.maxConcurrentRuns})`
      }
    }

    return { allowed: true }
  }

  /**
   * 检查是否可以添加新 View 🆕
   *
   * ✅ 改为 public，允许 ViewFactory 调用
   */
  public checkQuotaForNewView(runId?: string, preflight = false): { allowed: boolean; reason?: string } {
    if (!this.quota.enabled) {
      return { allowed: true }
    }

    // 检查全局 View 数（包含未绑定 run 的视图）
    const viewFactory = getViewFactoryOrThrow()
    const totalViews = viewFactory.getStats().total
    const limitReached = preflight ? totalViews >= this.quota.maxTotalViews : totalViews > this.quota.maxTotalViews
    if (limitReached) {
      return {
        allowed: false,
        reason: `达到全局最大 View 数限制 (${this.quota.maxTotalViews})`
      }
    }

    // 检查 Run 的 View 数
    const run = runId ? this.runs.get(runId) : null
    if (run) {
      const runViews = run.views.size
      if (runViews >= this.quota.maxViewsPerRun) {
        return {
          allowed: false,
          reason: `Run ${runId} 达到最大 View 数限制 (${this.quota.maxViewsPerRun})`
        }
      }
    }

    return { allowed: true }
  }

  /**
   * 启动超时检查定时器 🆕
   */
  private startTimeoutChecker(): void {
    if (this.timeoutCheckInterval) {
      return
    }

    this.timeoutCheckInterval = setInterval(() => {
      this.checkAndCleanupTimeoutRuns()
    }, 60 * 1000)
    this.timeoutCheckInterval.unref()

    log.debug('超时检查器已启动')
  }

  /**
   * 停止超时检查定时器 🆕
   */
  stopTimeoutChecker(): void {
    if (this.timeoutCheckInterval) {
      clearInterval(this.timeoutCheckInterval)
      this.timeoutCheckInterval = null
      log.debug('超时检查器已停止')
    }
  }

  // RP-025: runs 数量上限保护，防止无限堆积
  private static readonly MAX_RUNS = 200

  /**
   * 检查并清理超时的 Run 🆕
   */
  private async checkAndCleanupTimeoutRuns(): Promise<void> {
    if (this.isCheckingTimeout) return
    // RP-025 fix: runs 为空时直接跳过，避免空遍历开销
    if (this.runs.size === 0) return
    if (!this.quota.enabled || this.quota.runTimeout === 0) {
      return
    }
    this.isCheckingTimeout = true

    const now = Date.now()
    const timeoutRuns: string[] = []

    for (const [runId, session] of this.runs) {
      const activityTs = session.lastEventAt ?? session.updatedAt ?? session.createdAt
      const age = now - activityTs
      if (age > this.quota.runTimeout) {
        timeoutRuns.push(runId)
      }
    }

    // RP-025 fix: 若 runs 超过上限，按最后活跃时间排序，清理最旧的
    if (this.runs.size > RunSessionManager.MAX_RUNS && timeoutRuns.length === 0) {
      const sorted = Array.from(this.runs.entries())
        .sort((a, b) => {
          const tsA = a[1].lastEventAt ?? a[1].updatedAt ?? a[1].createdAt
          const tsB = b[1].lastEventAt ?? b[1].updatedAt ?? b[1].createdAt
          return tsA - tsB
        })
      const excess = this.runs.size - RunSessionManager.MAX_RUNS
      for (let i = 0; i < excess; i++) {
        timeoutRuns.push(sorted[i][0])
      }
    }

    try {
      if (timeoutRuns.length > 0) {
        log.info('发现需清理的超时 Run，开始清理', { count: timeoutRuns.length })

        for (const runId of timeoutRuns) {
          try {
            await this.endRun(runId, { reason: 'run-timeout-cleanup' })
            log.info('超时 Run 已清理', { runId })
          } catch (error) {
            log.error('清理超时 Run 失败', { runId }, error)
          }
        }
      }
    } finally {
      this.isCheckingTimeout = false
    }
  }

  /**
   * 创建或获取 run（若存在则返回现有）
   */
  createRun(runId?: string, sessionId?: string, profile?: string): SessionContext {
    const id = runId || `run-${Date.now()}-${randomUUID()}`
    const existing = this.runs.get(id)
    if (existing) {
      return existing
    }

    // 🆕 检查配额
    const quotaCheck = this.checkQuotaForNewRun()
    if (!quotaCheck.allowed) {
      throw new Error(`无法创建 Run: ${quotaCheck.reason}`)
    }

    const ctx: SessionContext = {
      runId: id,
      sessionId: sessionId || `session-${Date.now()}-${randomUUID()}`,
      profile: profile,
      activeViewId: null,
      views: new Map(),
      memory: {},
      observations: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastEventAt: Date.now(),
      spaceId: getCLISpaceId(),
      crawlspaceId: getCLICrawlspaceId(),
      totalEventCount: 0,
    }

    this.runs.set(id, ctx)
    return ctx
  }

  /**
   * 获取 run 快照（便于 IPC 返回）
   */
  getRun(runId: string): RunSessionSnapshot | null {
    const ctx = this.runs.get(runId)
    if (!ctx) return null

    const snapshot: RunSessionSnapshot = {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      profile: ctx.profile, // 🆕 返回 profile
      activeViewId: ctx.activeViewId ?? null,
      spaceId: ctx.spaceId ?? null,
      crawlspaceId: ctx.crawlspaceId ?? null,
      memory: ctx.memory,
      createdAt: ctx.createdAt,
      updatedAt: ctx.updatedAt,
      lastEventAt: ctx.lastEventAt,
      totalEventCount: ctx.totalEventCount,
      views: Array.from(ctx.views.values()),
      observations: [...ctx.observations],
    }
    return snapshot
  }

  /**
   * 注册视图到 run，建立映射
   */
  registerView(runId: string, info: RunViewInfo): void {
    log.debug('注册 View 到 Run', { runId, viewId: info.viewId })

    const ctx = this.createRun(runId)

    // 🆕 检查配额
    const quotaCheck = this.checkQuotaForNewView(runId)
    if (!quotaCheck.allowed) {
      log.error('View 注册失败（配额限制）', { runId, viewId: info.viewId, reason: quotaCheck.reason })
      throw new Error(`无法添加 View: ${quotaCheck.reason}`)
    }

    ctx.views.set(info.viewId, info)
    ctx.updatedAt = Date.now()
    ctx.lastEventAt = Date.now()
    this.viewToRun.set(info.viewId, ctx.runId)

    // 🆕 同步 runId 到 crawlspace context（便于前端展示/调试）
    const metaCrawlspaceId = info.metadata?.crawlspaceId
    if (typeof metaCrawlspaceId === 'string' && info.metadata?.kind === 'workspace-view') {
      try {
        syncWorkspaceViewMetadata({
          viewId: info.viewId,
          crawlspaceId: metaCrawlspaceId,
          runId,
        })
      } catch {
        // ignore
      }
    }

    log.debug('View 已注册到 Run', {
      runId: ctx.runId,
      viewId: info.viewId,
      totalViews: ctx.views.size
    })
  }

  /**
   * AA-001 fix: 在 _openTabLock 互斥锁保护下注册视图，
   * 与 openTab 共享同一把锁，防止 TOCTOU 竞态
   */
  async registerViewLocked(runId: string, info: RunViewInfo): Promise<void> {
    let releaseLock!: () => void
    const prev = this._openTabLock
    this._openTabLock = new Promise<void>(r => { releaseLock = r })
    await prev
    try {
      this.registerView(runId, info)
    } finally {
      releaseLock()
    }
  }

  /**
   * 解除视图映射
   */
  unregisterView(runId: string, viewId: string): void {
    log.debug('从 Run 注销 View', { runId, viewId })

    const ctx = this.runs.get(runId)
    if (!ctx) {
      log.warn('Run 不存在，无法注销 View（仅清理 viewToRun 映射）', { runId, viewId })
      // R-MAIN-4 hotfix: 即使 Run 已被 endRun 删除，也要清理 viewToRun 映射，
      // 否则 autoClose=false 的 View 在 endRun 后手动关闭时 viewToRun 永不释放
      this.viewToRun.delete(viewId)
      return
    }

    ctx.views.delete(viewId)
    this.viewToRun.delete(viewId)
    if (ctx.activeViewId === viewId) {
      ctx.activeViewId = null
    }
    ctx.updatedAt = Date.now()

    log.debug('View 已从 Run 注销', {
      runId,
      viewId,
      remainingViews: ctx.views.size
    })
  }

  /**
   * 处理 ViewFactory 的 view:destroyed 事件，清理 viewToRun 孤儿条目。
   * 确保无论 View 通过何种路径销毁，映射都不会泄漏。
   */
  handleViewDestroyed(viewId: string): void {
    if (!this.viewToRun.has(viewId)) return

    const runId = this.viewToRun.get(viewId)!
    this.viewToRun.delete(viewId)

    const ctx = this.runs.get(runId)
    if (ctx) {
      ctx.views.delete(viewId)
      if (ctx.activeViewId === viewId) {
        ctx.activeViewId = null
      }
    }

    log.debug('view:destroyed 自动清理 viewToRun', { viewId, runId })
  }

  /**
   * 更新当前激活视图
   */
  setActiveView(runId: string, viewId?: string | null): void {
    const ctx = this.runs.get(runId)
    if (!ctx) return
    ctx.activeViewId = viewId ?? null
    const now = Date.now()
    ctx.updatedAt = now
    ctx.lastEventAt = now
  }

  /**
  * 打开/创建标签页（统一入口，便于 IPC 与业务调用复用）
  */
  async openTab(options: OpenTabOptions): Promise<{ success: boolean; id?: string; profile?: string; reused?: boolean; error?: string }> {
    // 互斥锁：确保配额检查 + createView 是原子操作，防止并发请求绕过配额
    let releaseLock!: () => void
    const prev = this._openTabLock
    this._openTabLock = new Promise<void>(r => { releaseLock = r })
    await prev

    try {
      return await this._openTabLocked(options)
    } finally {
      releaseLock()
    }
  }

  private async _openTabLocked(options: OpenTabOptions): Promise<{ success: boolean; id?: string; profile?: string; reused?: boolean; error?: string }> {
    const viewFactory = getViewFactoryOrThrow()
    const startTime = Date.now()
    const id = options.id || `run-tab-${Date.now()}`

    const metadata = { ...(options.metadata || {}) }
    if (options.fallbackReason && !metadata.fallbackReason) {
      metadata.fallbackReason = options.fallbackReason
    }
    const fallbackReason = options.fallbackReason ?? metadata.fallbackReason
    const source = metadata.source || metadata.createdBy || metadata.sourceType

    // Wave 2b-F：Agent 打开的所有 view 都应该带明确的 partition。当上游
    // 忘记传 partition 但有 spaceId 时，主进程兜底查一次 BrowserEnvironmentService
    // 得到 Space 绑定的登录环境 partition —— 这是 harness Wave 2b-F 的核心
    // 硬约束"Agent view 必须走 Space 绑定的 partition，而不是 defaultSession"。
    //
    // 降级契约：Service 未 ready / space 未绑定 → 返回默认环境 partition，
    // 不抛异常。
    if (!options.partition && typeof metadata.spaceId === 'string' && metadata.spaceId) {
      try {
        const resolved = getBrowserEnvironmentService().getPartitionForSpace(metadata.spaceId)
        if (resolved) {
          options = { ...options, partition: resolved }
        }
      } catch (err) {
        log.warn('getPartitionForSpace 失败，继续用上游传入的（可能为空）partition', { spaceId: metadata.spaceId }, err)
      }
    }

    const isCrawlspaceView = Boolean(metadata.crawlspaceId || metadata.kind === 'workspace-view')
    if (isCrawlspaceView) {
      const crawlspaceId = metadata.crawlspaceId || 'unknown'
      if (!metadata.kind) {
        const error = `[RunSessionManager] crawlspace view 缺少 metadata.kind: crawlspaceId=${crawlspaceId}`
        log.warn('crawlspace view 缺少 metadata.kind', { id, runId: options.runId, crawlspaceId })
        return { success: false, error }
      }
      if (!metadata.crawlspaceId) {
        const error = `[RunSessionManager] crawlspace view 缺少 metadata.crawlspaceId: crawlspaceId=${crawlspaceId}`
        log.warn('crawlspace view 缺少 metadata.crawlspaceId', { id, runId: options.runId, crawlspaceId })
        return { success: false, error }
      }
      if (!options.partition) {
        // 本地化退役 Wave 2 之后 BrowserEnvironmentService.getPartitionForSpace
        // 永远立即返回真实 partition（无 pending、无异步等待）。这里仅作"上游
        // 忘传 partition 但有 spaceId"的兜底解析。
        const spaceIdFromMeta = typeof metadata.spaceId === 'string' ? metadata.spaceId : ''
        if (!spaceIdFromMeta) {
          const error = `[RunSessionManager] crawlspace view 缺少 partition 且 metadata.spaceId 为空，无法兜底`
          log.warn('crawlspace view 缺少 partition 且 metadata.spaceId 为空，无法兜底', { id, runId: options.runId, crawlspaceId })
          return { success: false, error }
        }
        try {
          const partition = getBrowserEnvironmentService().getPartitionForSpace(spaceIdFromMeta)
          if (partition) {
            log.info(
              'crawlspace view 缺少 partition，按 spaceId 重新解析',
              { id, runId: options.runId, spaceId: spaceIdFromMeta, partition },
            )
            options = { ...options, partition }
          } else {
            const error = `[RunSessionManager] BrowserEnv 解析 partition 返回空字符串`
            log.warn('BrowserEnv 解析 partition 返回空字符串', { id, runId: options.runId, crawlspaceId, spaceId: spaceIdFromMeta })
            return { success: false, error }
          }
        } catch (err) {
          const error = `[RunSessionManager] getPartitionForSpace 异常: ${(err as any)?.message || err}`
          log.warn('getPartitionForSpace 异常', { id, runId: options.runId, spaceId: spaceIdFromMeta }, err)
          return { success: false, error }
        }
      }
    }

    // 🔥 修复：优先使用 options.profile，否则从 run 的 profile 中读取，最后才用默认值
    let profile = options.profile
    if (!profile && options.runId) {
      const run = this.runs.get(options.runId)
      if (run?.profile) {
        profile = run.profile
        log.debug('从 Run 继承 profile', { runId: options.runId, profile })
      }
    }
    if (!profile) {
      profile = 'background-task'
      log.debug('使用默认 profile', { profile })
    }

    log.info('openTab 请求', {
      runId: options.runId,
      viewId: id,
      profile,
      partition: options.partition,
      crawlspaceId: metadata.crawlspaceId,
      source,
      fallbackReason
    })

    // 配额预检查（全局 + run 维度）
    const quotaCheck = this.checkQuotaForNewView(options.runId, true)
    if (!quotaCheck.allowed) {
      return { success: false, error: `无法创建 View: ${quotaCheck.reason}` }
    }

    const runSpaceId = options.runId ? this.runs.get(options.runId)?.spaceId : undefined

    try {
      const handle = await viewFactory.createView({
        profile,
        id,
        url: options.url,
        partition: options.partition,
        userAgent: options.userAgent,
        proxy: options.proxy,
        ...(options.antiDetect ? { antiDetect: options.antiDetect } : {}),
        metadata,
        runId: options.runId,
        spaceId: runSpaceId || undefined,
        keepAlive: options.keepAlive ?? true,
        displayMode: options.displayMode ?? 'hidden',
        showInSidebar: options.showInSidebar ?? false,
        notifyRenderer: options.notifyRenderer ?? false,
        tabName: options.tabName
      })

      // 默认标记使用中，避免被清理
      if (options.inUse !== false) {
        try {
          viewFactory.markViewInUse(handle.id)
        } catch (err) {
          log.warn('markViewInUse 失败', { viewId: handle.id }, err)
        }
      }

      // 将新建视图标记为 active
      if (options.runId) {
        this.setActiveView(options.runId, handle.id)
        this.addObservation({
          runId: options.runId,
          viewId: handle.id,
          type: 'TAB_OPENED',
          data: {
            url: options.url,
            profile,
            partition: options.partition,
            userAgent: options.userAgent,
            proxy: options.proxy,
            reused: handle.reused,
            source,
            fallbackReason
          },
          context: {
            url: options.url,
            title: options.tabName,
            duration: Date.now() - startTime
          }
        })
      }

      log.info('openTab 完成', {
        runId: options.runId,
        viewId: handle.id,
        reused: handle.reused,
        profile,
        partition: options.partition,
        crawlspaceId: metadata.crawlspaceId,
        source,
        fallbackReason,
        durationMs: Date.now() - startTime
      })

      return { success: true, id: handle.id, profile: handle.profile, reused: handle.reused }
    } catch (error: any) {
      log.error('openTab 失败', { runId: options.runId, viewId: id, profile }, error)
      return { success: false, error: error?.message || String(error) }
    }
  }

  /**
   * 切换标签页（设置 active + 显示）
   */
  async switchTab(options: SwitchTabOptions): Promise<{ success: boolean; error?: string }> {
    const viewFactory = getViewFactoryOrThrow()
    const viewId = options.viewId
    const runId = options.runId || this.getRunIdByView(viewId)

    if (!viewFactory.hasView(viewId)) {
      return { success: false, error: `view ${viewId} not found` }
    }

    try {
      const state = viewFactory.getViewState(viewId)
      await viewFactory.showView(viewId, { bounds: options.bounds })
      try {
        const organizationTabManager = getOrganizationTabManager()
        const crawlspaceId =
          state?.config?.metadata?.crawlspaceId || organizationTabManager.getTabByView(viewId)
        if (crawlspaceId && organizationTabManager.isOrganizationTab(crawlspaceId)) {
          getCrawlspaceContextHub().setActiveView(crawlspaceId, viewId)
        }
      } catch (error) {
        log.warn('设置 Crawlspace activeView 失败', { viewId, runId }, error)
      }
      if (runId) {
        this.setActiveView(runId, viewId)
        this.addObservation({
          runId,
          viewId,
          type: 'TAB_SWITCHED',
          data: { bounds: options.bounds },
          context: {
            url: state?.url,
            title: state?.view?.webContents?.getTitle?.()
          }
        })
      }
      return { success: true }
    } catch (error: any) {
      log.error('switchTab 失败', { viewId, runId }, error)
      return { success: false, error: error?.message || String(error) }
    }
  }

  /**
   * 关闭标签页（销毁 + 解绑映射）
   */
  async closeTab(options: CloseTabOptions): Promise<{ success: boolean; error?: string }> {
    const viewFactory = getViewFactoryOrThrow()
    const viewId = options.viewId
    const runId = options.runId || this.getRunIdByView(viewId)
    const state = viewFactory.getViewState(viewId)

    try {
      if (viewFactory.hasView(viewId)) {
        await viewFactory.destroyView(viewId, { force: options.force ?? false })
      }
      if (runId) {
        this.unregisterView(runId, viewId)
        this.addObservation({
          runId,
          viewId,
          type: 'TAB_CLOSED',
          data: { force: options.force ?? false },
          context: {
            url: state?.url,
            title: state?.view?.webContents?.getTitle?.()
          }
        })
      }
      return { success: true }
    } catch (error: any) {
      log.error('closeTab 失败', { viewId, runId }, error)
      return { success: false, error: error?.message || String(error) }
    }
  }

  /**
   * 添加事件（可通过 viewId 反查 runId）
   */
  addObservation(event: AddObservationInput): void {
    const ts = event.timestamp ?? Date.now()
    const runId = event.runId || (event.viewId ? this.viewToRun.get(event.viewId) : undefined)

    // 🆕 修复：普通标签（user-tab）没有 runId 是正常情况，静默跳过
    if (!runId) {
      // 只在调试模式下记录（避免日志噪音）
      if (process.env.DEBUG_RUN_SESSION) {
        log.debug('事件跳过（View 未关联到 Run）', {
          type: event.type,
          viewId: event.viewId,
          availableRuns: Array.from(this.runs.keys()).length
        })
      }
      return
    }

    const ctx = this.runs.get(runId)

    // Run 不存在时才记录警告（这是真正的异常情况）
    if (!ctx) {
      log.warn('事件写入失败：Run 不存在', {
        runId,
        type: event.type,
        viewId: event.viewId,
        availableRuns: Array.from(this.runs.keys()).slice(0, 3),
        timestamp: new Date(ts).toISOString()
      })
      return
    }

    const record: RunObservationEvent = {
      runId,
      viewId: event.viewId,
      type: event.type,
      timestamp: ts,
      data: event.data,
      context: event.context
    }

    ctx.totalEventCount++
    ctx.observations.push(record)
    if (ctx.observations.length > this.maxEventsPerRun) {
      ctx.observations.splice(0, ctx.observations.length - this.maxEventsPerRun)
    }
    ctx.updatedAt = ts
    ctx.lastEventAt = ts

    try {
      getEventPersistence().addEvent({
        runId: record.runId,
        viewId: record.viewId,
        type: record.type,
        timestamp: record.timestamp,
        data: record.data,
        context: record.context,
      })
    } catch (err) {
      log.warn('addObservation: 持久化失败', { runId, type: event.type }, err)
    }
  }

  /**
   * 获取事件列表（可选按时间过滤）
   */
  getEvents(runId: string, since?: number): RunObservationEvent[] {
    const ctx = this.runs.get(runId)
    if (!ctx) return []
    if (since) {
      return ctx.observations.filter((e) => e.timestamp >= since)
    }
    return [...ctx.observations]
  }

  /**
   * 获取单个 run 的统计信息 🆕
   */
  getRunStats(runId: string): RunStats | null {
    const ctx = this.runs.get(runId)
    if (!ctx) return null
    const views = Array.from(ctx.views.values())
    const inUseViewCount = views.filter((v) => v.inUse).length
    return {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      spaceId: ctx.spaceId ?? null,
      crawlspaceId: ctx.crawlspaceId ?? null,
      viewCount: views.length,
      inUseViewCount,
      activeViewId: ctx.activeViewId ?? null,
      createdAt: ctx.createdAt,
      updatedAt: ctx.updatedAt,
      lastEventAt: ctx.lastEventAt,
      eventCount: ctx.totalEventCount
    }
  }

  /**
   * 获取全局统计信息（含每个 run）🆕
   */
  getStats(): RunSessionStats {
    const runs: RunStats[] = []
    let totalViews = 0
    let inUseViews = 0
    const now = Date.now()

    for (const runId of this.runs.keys()) {
      const stats = this.getRunStats(runId)
      if (stats) {
        runs.push(stats)
        totalViews += stats.viewCount
        inUseViews += stats.inUseViewCount
      }
    }

    const activeRuns = this.quota.runTimeout > 0
      ? runs.filter((r) => {
          const lastTs = r.lastEventAt ?? r.updatedAt ?? r.createdAt
          return now - lastTs <= this.quota.runTimeout
        }).length
      : runs.length

    return {
      totalRuns: this.runs.size,
      activeRuns,
      totalViews,
      inUseViews,
      runs
    }
  }

  /**
   * 关闭 Run，通知 ViewFactory 处理关联的 View
   *
   * ✅ 简化：移除 destroyViews 参数
   * ViewFactory 会根据 Profile 的 autoClose 配置自动决定是否销毁
   *
   * @param runId Run ID
   * @param options 可选配置（用于日志）
   */
  async endRun(runId: string, options?: { reason?: string }): Promise<void> {
    const ctx = this.runs.get(runId)
    if (!ctx) {
      return
    }

    log.info('结束 Run', {
      runId,
      viewCount: ctx.views.size,
      reason: options?.reason
    })

    const viewIds = [...ctx.views.keys()]
    const viewsToCleanMapping: string[] = []

    if (viewIds.length > 0) {
      const vf = getViewFactoryOrThrow()

      for (const viewId of viewIds) {
        try {
          await vf.onTaskCompleted(viewId, {
            taskId: ctx.sessionId,
            status: 'completed',
            reason: options?.reason
          })
        } catch (error) {
          log.warn('处理 View 失败', { viewId, runId }, error)
        }

        const viewState = vf.getViewState(viewId)
        if (viewState?.config?.autoClose === false) {
          log.debug('保留 viewToRun 映射 (autoClose=false)', { viewId, runId })
        } else {
          viewsToCleanMapping.push(viewId)
        }
      }
    }

    try {
      await getEventPersistence().flush()
    } catch (err) {
      log.warn('endRun: flush 失败，部分事件可能丢失', { runId }, err)
    }

    for (const viewId of viewsToCleanMapping) {
      this.viewToRun.delete(viewId)
    }
    this.runs.delete(runId)

    log.info('Run 已清理', { runId })
  }

  /**
   * 结束所有活跃 Run，销毁关联 View（退出清理时调用）
   */
  async endAllRuns(): Promise<void> {
    const runIds = [...this.runs.keys()]
    if (runIds.length === 0) return

    log.info('endAllRuns: 清理活跃 Run', { count: runIds.length })
    for (const runId of runIds) {
      try {
        await this.endRun(runId, { reason: 'app-shutdown' })
      } catch (err) {
        log.warn('endAllRuns: Run 清理失败', { runId }, err)
      }
    }
  }

  /**
   * 获取当前所有 run 的概要
   */
  listRuns(): Array<{
    runId: string
    sessionId: string
    viewCount: number
    activeViewId: string | null
    createdAt: number
    updatedAt: number
  }> {
    return Array.from(this.runs.values()).map((ctx) => ({
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      viewCount: ctx.views.size,
      activeViewId: ctx.activeViewId ?? null,
      createdAt: ctx.createdAt,
      updatedAt: ctx.updatedAt
    }))
  }

  /**
   * 通过 viewId 反查 runId
   */
  getRunIdByView(viewId: string): string | undefined {
    return this.viewToRun.get(viewId)
  }

  /**
   * Wave 5a (L-W4-1)：按 spaceId 拉某个时间戳之后的所有 observation。
   *
   * 用途：`agent-runtime` 通过宿主注入的 `getRecentRunObservations` callback
   * 拿"自上次以来新增的 observation"喂给 LLM 上下文，让 Agent 真能感知主进
   * 程异步触发的 autofill / env 切换事件。
   *
   * 语义：
   * - **包含 since（>=）**：调用方传上次返回的最大 timestamp 时不会重复拿；
   *   如果是 since（不含），调用方需要自己 + 1 ms。当前选择 `>` 避免边界
   *   case：宿主下次调用时把上次最大 ts 作为新 since，自动跳过已读条目；
   * - **跨 run 聚合**：同 spaceId 下多个活跃 run 的 observation 一起返回（按
   *   timestamp 排序），匹配"用户视角下 Space 的所有活动"语义；
   * - **类型过滤交给调用方**：本方法不做 `type` 过滤，让宿主可以自由
   *   注入更多 observation 类型（W4-G AGENT_AUTOFILL_AMBIGUOUS_MATCH 等
   *   未来扩展）。
   *
   * 性能：O(runs × observations)。runs 一般 ≤ 10，每个 run observations
   * 受 ring buffer ≤ 200 限制；调用频率 = 每轮 ReAct 一次（10s 量级），
   * 整体可忽略。
   */
  listObservationsBySpaceSince(
    spaceId: string,
    since: number,
  ): RunObservationEvent[] {
    const collected: RunObservationEvent[] = []
    for (const ctx of this.runs.values()) {
      if (ctx.spaceId !== spaceId) continue
      for (const obs of ctx.observations) {
        if (obs.timestamp > since) collected.push(obs)
      }
    }
    collected.sort((a, b) => a.timestamp - b.timestamp)
    return collected
  }

  /**
   * RP-034 fix: 应用退出时调用，停止定时器并清理资源
   */
  dispose(): void {
    this.stopTimeoutChecker()
    try { this.browserEnvUnsubscribe?.() } catch { /* ignore */ }
    this.browserEnvUnsubscribe = null
    this.envChangedRuns.clear()
    this.runs.clear()
    this.viewToRun.clear()
    log.info('disposed')
  }
}

let singleton: RunSessionManager | null = null

export function getRunSessionManager(): RunSessionManager {
  if (!singleton) {
    singleton = new RunSessionManager()
  }
  return singleton
}

/**
 * RP-034 fix: 应用退出时调用，清理 RunSessionManager 定时器
 */
export function disposeRunSessionManager(): void {
  if (singleton) {
    singleton.dispose()
    singleton = null
  }
}
