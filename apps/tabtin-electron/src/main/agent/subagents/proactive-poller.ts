/**
 * Proactive Poller — Electron Main 侧冷启动汇报
 *
 * PRD 06 §5.5.1 三种主机状态中的状态 B / C：
 *   B：用户离线但 Main 活 → 用户重新打开 Space → 冷启动 runtime 生成汇报
 *   C：Main 销毁后重启 → 扫 crashed + 未 push 的
 *
 * 设计原则：
 *   - 不自己实现 runtime 初始化——复用 ElectronAgentHost.handleQueryInternal
 *   - Django API 调用复用现有 fetch + TokenManager 模式
 *   - 查询/标记 pending 的幂等性由 Django 侧 SELECT FOR UPDATE SKIP LOCKED 保证
 */
import { TokenManager } from '../../auth.js'
import { API_BASE_URL } from '../../config/api.js'
import { getCLIOrganizationId } from '../../cli/cli-server.js'
import { createLogger } from '../../logger.js'
import { joinApiPath } from '@tabtin/config'

const log = createLogger('proactive-poller')

const STALE_THRESHOLD_MINUTES = 5
const MAX_CONCURRENT_COLD_STARTS = 3

// ─── Types ──────────────────────────────────────────────────────────

export interface PendingReportSummary {
  pending_count: number
  thread_ids: string[]
}

export interface CrashedRunInfo {
  run_id: string
  thread_id: string
  parent_thread_id: string
  updated_at: string
}

// ─── Django API Client ──────────────────────────────────────────────

/**
 * 查询指定 thread 下 pending（终态 + notified_at IS NULL）的子任务数量。
 * 路由：GET /services/agent-engine/subtask-runs/pending/?parent_thread_id=X
 *
 * 当前 Django 可能尚未实现此 endpoint——本模块做防御性处理：
 * API 不存在 / 返回非 200 时返回 { pending_count: 0 }，不阻塞 Renderer 进入。
 */
async function fetchPendingCount(threadId: string): Promise<PendingReportSummary> {
  try {
    const token = await TokenManager.getAccessToken()
    if (!token) {
      log.warn('fetchPendingCount: no auth token, returning 0')
      return { pending_count: 0, thread_ids: [] }
    }

    const organizationId = getCLIOrganizationId()
    const url = joinApiPath(API_BASE_URL, `/services/agent-engine/subtask-runs/pending/?parent_thread_id=${encodeURIComponent(threadId)}`)

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!resp.ok) {
      log.warn(`fetchPendingCount: HTTP ${resp.status} for thread=${threadId.slice(0, 8)}…`)
      return { pending_count: 0, thread_ids: [] }
    }

    const data = (await resp.json()) as {
      pending_count?: number
      thread_ids?: string[]
    }

    return {
      pending_count: data.pending_count ?? 0,
      thread_ids: data.thread_ids ?? [],
    }
  } catch (err) {
    log.warn(`fetchPendingCount failed: ${err instanceof Error ? err.message : err}`)
    return { pending_count: 0, thread_ids: [] }
  }
}

/**
 * 扫描所有 status='running' 且 updated_at 超过阈值的 SubtaskRun，标记为 crashed。
 * 路由：POST /services/agent-engine/subtask-runs/scan-crashed/
 *
 * 同样做防御性处理：Django 未实现时静默降级。
 */
async function scanAndMarkCrashed(): Promise<CrashedRunInfo[]> {
  try {
    const token = await TokenManager.getAccessToken()
    if (!token) {
      log.warn('scanAndMarkCrashed: no auth token')
      return []
    }

    const organizationId = getCLIOrganizationId()
    const url = joinApiPath(API_BASE_URL, '/services/agent-engine/subtask-runs/scan-crashed/')

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      },
      body: JSON.stringify({ stale_threshold_minutes: STALE_THRESHOLD_MINUTES }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!resp.ok) {
      log.warn(`scanAndMarkCrashed: HTTP ${resp.status}`)
      return []
    }

    const data = (await resp.json()) as { crashed_runs?: CrashedRunInfo[] }
    return data.crashed_runs ?? []
  } catch (err) {
    log.warn(`scanAndMarkCrashed failed: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export type ColdStartTrigger = (threadId: string) => Promise<void>

export interface ProactivePollerDeps {
  /**
   * 冷启动 runtime 生成汇报消息的回调。
   * 由 ElectronAgentHost 提供——内部构造一个特殊的 QueryRequest
   * 然后调用 handleQueryInternal。
   */
  triggerColdStartReport: ColdStartTrigger
}

let deps: ProactivePollerDeps | null = null

/** 正在冷启动中的 threadId 集合——防止重复触发 */
const inflightColdStarts = new Set<string>()

export function initProactivePoller(d: ProactivePollerDeps): void {
  deps = d
  inflightColdStarts.clear()
  log.info('initialized')
}

export function destroyProactivePoller(): void {
  deps = null
  inflightColdStarts.clear()
  log.info('destroyed')
}

/**
 * 状态 B 入口：Renderer 打开 Space 时调用。
 * 返回 pending_count 让 Renderer 决定是否需要等待汇报消息。
 */
export async function checkPendingReports(
  threadId: string,
): Promise<PendingReportSummary> {
  const summary = await fetchPendingCount(threadId)

  if (summary.pending_count > 0 && deps) {
    if (inflightColdStarts.has(threadId)) {
      log.info(`cold start already in-flight for thread=${threadId.slice(0, 8)}…, skipping`)
      return summary
    }

    inflightColdStarts.add(threadId)
    log.info(
      `pending_count=${summary.pending_count} for thread=${threadId.slice(0, 8)}… → triggering cold start`,
    )
    deps.triggerColdStartReport(threadId)
      .catch((err) => {
        log.error(`triggerColdStartReport failed: ${err instanceof Error ? err.message : err}`)
      })
      .finally(() => {
        inflightColdStarts.delete(threadId)
      })
  }

  return summary
}

/**
 * 查询所有 pending 汇报（不限某个 thread），返回去重的 parent_thread_id 列表。
 * 路由：GET /services/agent-engine/subtask-runs/pending-threads/
 *
 * 如果 Django 未实现此 endpoint，返回空数组——不阻塞启动。
 */
async function fetchAllPendingThreads(): Promise<string[]> {
  try {
    const token = await TokenManager.getAccessToken()
    if (!token) return []

    const organizationId = getCLIOrganizationId()
    const url = joinApiPath(API_BASE_URL, '/services/agent-engine/subtask-runs/pending-threads/')

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!resp.ok) {
      log.warn(`fetchAllPendingThreads: HTTP ${resp.status}`)
      return []
    }

    const data = (await resp.json()) as { thread_ids?: string[] }
    return data.thread_ids ?? []
  } catch (err) {
    log.warn(`fetchAllPendingThreads failed: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

/**
 * 状态 C 入口：Main 启动时调用。
 * 1. 扫 status='running' 且过期的 SubtaskRun → 标 crashed
 * 2. 全量扫所有 pending（completed/failed/error/crashed + notified_at IS NULL）→ 逐 thread 触发冷启动
 *
 * 关键点：步骤 2 不只扫 crashed 的 parent_thread_id，还扫所有设备上
 * 可能遗漏通知的 pending run——覆盖"SubtaskRun 正常完成但 Main 在通知前 crash"的场景。
 */
export async function scanCrashedRuns(): Promise<void> {
  log.info('scanning for crashed / orphaned SubtaskRun…')

  const crashed = await scanAndMarkCrashed()
  if (crashed.length > 0) {
    log.info(`marked ${crashed.length} SubtaskRun(s) as crashed`)
  }

  // 全量扫描所有 pending thread（不只是 crashed 的 parent），覆盖：
  // - 子 Agent 完成但 Main crash 前未通知
  // - 刚标记 crashed 的 parent thread
  const pendingThreads = await fetchAllPendingThreads()
  if (pendingThreads.length > 0 && deps) {
    log.info(`checking pending reports for ${pendingThreads.length} thread(s)`)
    const chunks: string[][] = []
    for (let i = 0; i < pendingThreads.length; i += MAX_CONCURRENT_COLD_STARTS) {
      chunks.push(pendingThreads.slice(i, i + MAX_CONCURRENT_COLD_STARTS))
    }
    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map((threadId) =>
          checkPendingReports(threadId).catch((err) => {
            log.warn(`checkPendingReports for thread=${threadId.slice(0, 8)}… failed: ${err}`)
          }),
        ),
      )
    }
  }

  log.info('scan complete')
}

/**
 * 检测是否有运行中的子任务（用于 Cmd+Q 退出警告）。
 * 路由：GET /services/agent-engine/subtask-runs/active-count/
 */
export async function getActiveSubtaskCount(): Promise<number> {
  try {
    const token = await TokenManager.getAccessToken()
    if (!token) return 0

    const organizationId = getCLIOrganizationId()
    const url = joinApiPath(API_BASE_URL, '/services/agent-engine/subtask-runs/active-count/')

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      },
      signal: AbortSignal.timeout(2_000),
    })

    if (!resp.ok) return 0

    const data = (await resp.json()) as { active_count?: number }
    return data.active_count ?? 0
  } catch {
    return 0
  }
}

// ─── Cold-Start Support ─────────────────────────────────────

export interface PendingSubtaskDetail {
  run_id: string
  display_name: string
  short_id: string
  status: 'completed' | 'failed' | 'error' | 'crashed'
  task: string
  summary: string
  error_message: string
  initiator_speaker_id: string
  completed_at: string | null
}

/**
 * 获取指定 thread 下 pending 子任务的完整详情。
 * 供冷启动路径使用——需要真实数据注入 LLM prompt。
 */
export async function fetchPendingSubtaskDetails(
  threadId: string,
): Promise<PendingSubtaskDetail[]> {
  try {
    const token = await TokenManager.getAccessToken()
    if (!token) return []

    const organizationId = getCLIOrganizationId()
    const url = joinApiPath(API_BASE_URL, `/services/agent-engine/subtask-runs/pending/?parent_thread_id=${encodeURIComponent(threadId)}`)

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!resp.ok) {
      log.warn(`fetchPendingSubtaskDetails: HTTP ${resp.status}`)
      return []
    }

    const data = (await resp.json()) as { items?: PendingSubtaskDetail[] }
    return data.items ?? []
  } catch (err) {
    log.warn(`fetchPendingSubtaskDetails failed: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

/**
 * 将指定 SubtaskRun 标记为已通知（原子操作）。
 * 返回被成功标记的数量（0 表示已被其他实例抢先标记）。
 */
export async function markSubtaskRunsNotified(runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0
  try {
    const token = await TokenManager.getAccessToken()
    if (!token) return 0

    const organizationId = getCLIOrganizationId()
    const url = joinApiPath(API_BASE_URL, '/services/agent-engine/subtask-runs/mark-notified/')

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      },
      body: JSON.stringify({ run_ids: runIds }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!resp.ok) {
      log.warn(`markSubtaskRunsNotified: HTTP ${resp.status}`)
      return 0
    }

    const data = (await resp.json()) as { affected?: number }
    return data.affected ?? 0
  } catch (err) {
    log.warn(`markSubtaskRunsNotified failed: ${err instanceof Error ? err.message : err}`)
    return 0
  }
}
