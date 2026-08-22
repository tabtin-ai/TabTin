/**
 * useUserPortrait — 用户画像状态管理 Hook（/#4118 画像 per-Agent 化）
 *
 * 封装：
 *   - 按 (organizationId, agentId) 加载 + 手动 refresh
 *   - 蒸馏轮询：提交 hint / 触发 distill 后，每 3 秒轮询一次直到 status != pending
 *   - 轮询超时（约 36s）后进入 "stillDistilling" 软状态——前台不再 spin，
 *     但 UI 可以提示用户手动刷新查看（轮询本身已停，避免无限请求）
 *   - organizationId / agentId 变化自动重拉（切 Agent / 切 Space 时触发）
 *   - 错误统一处理：区分"加载/网络错误"与"蒸馏失败"两种语义
 *   - 成功路径调用主进程 IPC 失效画像缓存，让 Agent 对话立即用上新画像
 *
 * 画像 per-Agent 化关键变更：
 *   - organizationId + agentId 都是必传参数——画像按 Agent 完全隔离
 *   - organizationId / agentId 任一变化都会重置状态并重拉（每个 (org, agent) 一份独立画像）
 *   - submitHint / triggerDistill 成功后失效主进程缓存（M1.4 IPC）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { UserPortraitApi, UserPortraitApiError, type UserPortrait } from '@/services/userPortraitApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('UserPortrait')

interface UseUserPortraitState {
  portrait: UserPortrait | null
  isLoading: boolean
  /** 加载/网络错误（独立于"蒸馏失败"——蒸馏失败请看 portrait.last_distill_status === 'failed'） */
  loadError: string | null
  /** 蒸馏中：刚触发或后端正在处理 */
  isDistilling: boolean
  /** 轮询已超时但后端仍可能在处理——UI 可以提示用户手动刷新 */
  isStillDistilling: boolean
}

interface UseUserPortraitActions {
  refresh: () => Promise<void>
  submitHint: (text: string) => Promise<UserPortrait>
  triggerDistill: () => Promise<UserPortrait>
}

// 后端单次任务 soft/hard limit 为 150/180s，任务层会在 60s 后重试一次。
// 轮询窗口覆盖完整恢复预算；前一分钟快速跟进，之后降频，避免长任务制造请求风暴。
const POLL_FAST_INTERVAL_MS = 3000
const POLL_SLOW_INTERVAL_MS = 10_000
const POLL_FAST_WINDOW_MS = 60_000
const POLL_MAX_DURATION_MS = 390_000
const PORTRAIT_LOAD_TIMEOUT_MS = 10_000

interface PollBaseline {
  version: number
  updatedAt: string
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId)
  })
}

/**
 * 调用 Electron 主进程的 invalidate-user-portrait-cache IPC。
 *
 * 故意不抛错——失效缓存失败不应阻塞用户操作；最坏情况是 Agent 在缓存 TTL
 * 过期前继续看到旧画像。Daemon / 浏览器宿主下 window.tabtin 不存在时同样 noop。
 */
async function invalidateMainProcessPortraitCache(organizationId: string, agentId: string): Promise<void> {
  try {
    const bridge = (typeof window !== 'undefined'
      ? window.tabtin?.agentEngine?.invalidateUserPortraitCache
      : undefined)
    if (typeof bridge !== 'function') return
    await bridge(organizationId, agentId)
  } catch (err) {
    // 缓存失效是体验加分项，不阻塞主流程
    log.warn('画像缓存失效通知失败，等待缓存自然过期', {
      organizationId,
      agentId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function useUserPortrait(
  organizationId: string,
  agentId: string,
  enabled: boolean = true,
): UseUserPortraitState & UseUserPortraitActions {
  const [portrait, setPortrait] = useState<UserPortrait | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isDistilling, setIsDistilling] = useState(false)
  const [isStillDistilling, setIsStillDistilling] = useState(false)

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollGenerationRef = useRef(0)
  const pollStartedAtRef = useRef<number | null>(null)
  const triggerPromiseRef = useRef<Promise<UserPortrait> | null>(null)
  const isMountedRef = useRef(true)
  // 跟踪当前 (organizationId, agentId)，防止切换时旧 fetch 结果污染新 state
  const currentOrganizationIdRef = useRef(organizationId)
  const currentAgentIdRef = useRef(agentId)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    pollGenerationRef.current += 1
    pollStartedAtRef.current = null
    // 停轮询同时清蒸馏 UI 态——避免 organizationId 切换 / 异常 stop 后
    // isDistilling 残留为 true 导致遮罩跟"加载失败 banner"同屏出现。
    setIsDistilling(false)
    setIsStillDistilling(false)
  }, [])

  const refresh = useCallback(async () => {
    if (!enabled || !organizationId || !agentId) return
    setIsLoading(true)
    setLoadError(null)
    try {
      const data = await withTimeout(
        UserPortraitApi.getMyPortrait(organizationId, agentId),
        PORTRAIT_LOAD_TIMEOUT_MS,
        '加载用户画像超时，请重试',
      )
      if (!isMountedRef.current) return
      // 防止 (organizationId, agentId) 在 fetch 期间被切换
      if (currentOrganizationIdRef.current !== organizationId || currentAgentIdRef.current !== agentId) return
      setPortrait(data)
      if (data.last_distill_status !== 'pending') {
        // stopPolling 会同步清 isDistilling / isStillDistilling
        stopPolling()
      }
    } catch (err) {
      if (!isMountedRef.current) return
      if (currentOrganizationIdRef.current !== organizationId || currentAgentIdRef.current !== agentId) return
      setLoadError(err instanceof UserPortraitApiError ? err.message : String(err))
      log.warn('画像加载失败', {
        organizationId,
        agentId,
        error: err instanceof Error ? err.message : String(err),
      })
      // 加载失败时主动停掉之前可能进行中的轮询/蒸馏 UI 态——
      // 避免出现"加载失败 banner + 蒸馏遮罩"同屏的矛盾画面。
      stopPolling()
    } finally {
      if (
        isMountedRef.current &&
        currentOrganizationIdRef.current === organizationId &&
        currentAgentIdRef.current === agentId
      ) {
        setIsLoading(false)
      }
    }
  }, [enabled, organizationId, agentId, stopPolling])

  const startPolling = useCallback((baseline: PollBaseline) => {
    stopPolling()
    setIsDistilling(true)
    setIsStillDistilling(false)
    const wid = organizationId  // 捕获当前 (organizationId, agentId)，避免轮询期间被切换
    const aid = agentId
    const generation = pollGenerationRef.current
    pollStartedAtRef.current = Date.now()
    log.info('画像整理轮询开始', {
      organizationId: wid,
      agentId: aid,
      baselineVersion: baseline.version,
      maxDurationMs: POLL_MAX_DURATION_MS,
    })

    const finishAsStillDistilling = () => {
      const durationMs = Date.now() - (pollStartedAtRef.current ?? Date.now())
      stopPolling()
      setIsStillDistilling(true)
      log.warn('画像整理超过自动轮询窗口', {
        organizationId: wid,
        agentId: aid,
        durationMs,
      })
    }

    const scheduleNext = (poll: () => Promise<void>) => {
      if (pollGenerationRef.current !== generation) return
      const elapsedMs = Date.now() - (pollStartedAtRef.current ?? Date.now())
      if (elapsedMs >= POLL_MAX_DURATION_MS) {
        finishAsStillDistilling()
        return
      }
      const delayMs = elapsedMs < POLL_FAST_WINDOW_MS
        ? POLL_FAST_INTERVAL_MS
        : POLL_SLOW_INTERVAL_MS
      pollTimerRef.current = setTimeout(() => {
        void poll()
      }, delayMs)
    }

    const poll = async () => {
      try {
        const data = await withTimeout(
          UserPortraitApi.getMyPortrait(wid, aid),
          PORTRAIT_LOAD_TIMEOUT_MS,
          '加载用户画像超时，请重试',
        )
        if (!isMountedRef.current || pollGenerationRef.current !== generation) return
        if (currentOrganizationIdRef.current !== wid || currentAgentIdRef.current !== aid) {
          stopPolling()
          return
        }
        setPortrait(data)
        const hasNewSuccessfulVersion = (
          data.last_distill_status === 'idle'
          && data.version > baseline.version
        )
        const hasNewTerminalFailure = (
          data.last_distill_status === 'failed'
          && data.updated_at !== baseline.updatedAt
        )
        if (hasNewSuccessfulVersion || hasNewTerminalFailure) {
          const durationMs = Date.now() - (pollStartedAtRef.current ?? Date.now())
          // stopPolling 会同步清 isDistilling / isStillDistilling
          stopPolling()
          // 蒸馏完成（成功或失败），成功路径通知主进程刷新画像缓存；
          // 失败时不必清缓存（后端没产出新画像）
          if (hasNewSuccessfulVersion) {
            void invalidateMainProcessPortraitCache(wid, aid)
          }
          log.info('画像整理轮询结束', {
            organizationId: wid,
            agentId: aid,
            status: data.last_distill_status,
            version: data.version,
            durationMs,
          })
          return
        }
      } catch (err) {
        // 单次轮询失败不结束任务；完整窗口耗尽后再交给用户手动刷新。
        log.debug('画像整理单次轮询失败，将继续重试', {
          organizationId: wid,
          agentId: aid,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      scheduleNext(poll)
    }

    scheduleNext(poll)
  }, [stopPolling, organizationId, agentId])

  const submitHint = useCallback(
    async (text: string): Promise<UserPortrait> => {
      const data = await UserPortraitApi.submitHint(organizationId, agentId, text)
      if (!isMountedRef.current) return data
      if (currentOrganizationIdRef.current !== organizationId || currentAgentIdRef.current !== agentId) return data
      setPortrait(data)
      // distill_dispatched 缺省视为 true（后端历史兼容）；显式 false 才不轮询
      if (data.distill_dispatched !== false) {
        startPolling({ version: data.version, updatedAt: data.updated_at })
        // 成功调度：立刻失效主进程缓存，对话端下一轮取最新画像
        void invalidateMainProcessPortraitCache(organizationId, agentId)
      }
      return data
    },
    [organizationId, agentId, startPolling],
  )

  const triggerDistill = useCallback((): Promise<UserPortrait> => {
    // 防止按钮状态提交到 React 前的快速双击重复派发同一份整理任务。
    if (triggerPromiseRef.current) return triggerPromiseRef.current

    setIsDistilling(true)
    const request = (async () => {
      try {
        const data = await UserPortraitApi.triggerDistill(organizationId, agentId)
        if (!isMountedRef.current) return data
        if (currentOrganizationIdRef.current !== organizationId || currentAgentIdRef.current !== agentId) return data
        setPortrait(data)
        if (data.accepted !== false) {
          startPolling({ version: data.version, updatedAt: data.updated_at })
          void invalidateMainProcessPortraitCache(organizationId, agentId)
        } else {
          stopPolling()
        }
        return data
      } catch (err) {
        if (
          isMountedRef.current
          && currentOrganizationIdRef.current === organizationId
          && currentAgentIdRef.current === agentId
        ) {
          setIsDistilling(false)
        }
        log.warn('画像整理触发失败', {
          organizationId,
          agentId,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      } finally {
        triggerPromiseRef.current = null
      }
    })()
    triggerPromiseRef.current = request
    return request
  }, [organizationId, agentId, startPolling, stopPolling])

  // 面板在后端任务执行期间打开/重开时，GET 会直接返回 pending。继续跟进该
  // 任务，避免按钮重新可点，也避免用户必须手动刷新才能看到最终结果。
  useEffect(() => {
    if (
      portrait?.last_distill_status === 'pending'
      && !isDistilling
      && !isStillDistilling
    ) {
      startPolling({
        version: portrait.version,
        updatedAt: portrait.updated_at,
      })
    }
  }, [
    portrait?.last_distill_status,
    portrait?.version,
    portrait?.updated_at,
    isDistilling,
    isStillDistilling,
    startPolling,
  ])

  // organizationId / agentId 变化时重置状态并重拉
  useEffect(() => {
    currentOrganizationIdRef.current = organizationId
    currentAgentIdRef.current = agentId
    if (enabled && organizationId && agentId) {
      // 切换 (organizationId, agentId) 时清空旧画像，让 UI 显示加载中而不是错的画像
      setPortrait(null)
      setLoadError(null)
      setIsStillDistilling(false)
      stopPolling()
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, organizationId, agentId])

  // 卸载清理
  useEffect(() => {
    // React StrictMode in dev intentionally runs effect cleanup/setup once more.
    // Reset the ref in setup so the second pass can still commit async results.
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      stopPolling()
    }
  }, [stopPolling])

  return {
    portrait,
    isLoading,
    loadError,
    isDistilling,
    isStillDistilling,
    refresh,
    submitHint,
    triggerDistill,
  }
}
