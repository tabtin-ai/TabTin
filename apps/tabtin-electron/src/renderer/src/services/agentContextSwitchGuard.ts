import { useChatStore } from '@/stores/chat/useChatStore'
import { toast } from '@tabtin/smartsheet-ui'
import { createLogger } from '@/utils/logger'
import { getBusySessionIds } from '@/stores/chat/execution/sessionRunProjection'
import {
  requestAgentContextSwitchConfirm,
  type AgentContextSwitchKind,
  type BusyAgentSessionSummary,
} from '@components/app/agentContextSwitchConfirm'

const log = createLogger('AgentContextSwitchGuard')
const STOP_TIMEOUT_MS = 15_000
const STOP_POLL_INTERVAL_MS = 250

type BusySession = {
  sessionId: string
  queuedRunIds: string[]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function listBusySessions(): Promise<BusySession[]> {
  return window.tabtin.agentEngine.getState().then((state) => {
    if (state.busySessions !== undefined) {
      if (state.busy && state.busySessions.length === 0) {
        throw new Error('Local Agent runtime is busy but did not return session identifiers')
      }
      return state.busySessions.map((session) => ({
        sessionId: session.sessionId,
        queuedRunIds: session.queuedRunIds,
      }))
    }
    if (state.busy) {
      const fallbackSessions = getBusySessionIds()
      if (fallbackSessions.length === 0) {
        throw new Error('Local Agent runtime is busy but did not return session identifiers')
      }
      return fallbackSessions.map((sessionId) => ({ sessionId, queuedRunIds: [] }))
    }
    // 兼容旧主进程：仍以新 IPC 为权威；只有该加性字段缺失时才回退到 renderer 投影。
    return getBusySessionIds().map((sessionId) => ({ sessionId, queuedRunIds: [] }))
  })
}

function describeSessions(sessions: BusySession[]): BusyAgentSessionSummary[] {
  const titlesById = new Map(
    useChatStore.getState().sessions.map((session) => [session.id, session.title] as const),
  )
  return sessions.map((session) => ({
    sessionId: session.sessionId,
    title: titlesById.get(session.sessionId) || '未命名任务',
    queuedCount: session.queuedRunIds.length,
  }))
}

async function waitUntilIdle(sessionId: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const state = await window.tabtin.agentEngine.getState({ sessionId })
    if (!state.busy) return true
    await delay(STOP_POLL_INTERVAL_MS)
  }
  return false
}

async function stopBusySessions(previouslyBusySessions: BusySession[]): Promise<boolean> {
  const deadline = Date.now() + STOP_TIMEOUT_MS
  // 弹窗打开期间任务可能已自然结束；以当前 busy 为准，避免对已 idle 会话重发中断。
  let pendingSessions = await listBusySessions()
  if (pendingSessions.length === 0) {
    log.info('Local Agent sessions already idle before context switch stop', {
      previouslyBusySessionCount: previouslyBusySessions.length,
    })
    return true
  }

  log.info('Stopping local Agent sessions before context switch', {
    sessionCount: pendingSessions.length,
  })
  while (pendingSessions.length > 0 && Date.now() < deadline) {
    for (const session of pendingSessions) {
      const current = await window.tabtin.agentEngine.getState({ sessionId: session.sessionId })
      if (!current.busy) continue

      const result = await window.tabtin.agentEngine.abortRun(session.sessionId)
      if (!result.localHit && !result.remoteRequested) {
        log.warn('Agent context switch could not request run abort', {
          sessionId: session.sessionId.slice(0, 8),
        })
        return false
      }
      if (!await waitUntilIdle(session.sessionId, deadline)) {
        log.warn('Agent context switch timed out waiting for run to stop', {
          sessionId: session.sessionId.slice(0, 8),
          timeoutMs: STOP_TIMEOUT_MS,
        })
        return false
      }
    }
    // 在确认弹窗打开或停止期间新出现的 run 也必须纳入同一轮停止，避免穿过
    // “停止完成 → 切换组织”这段窗口。
    pendingSessions = await listBusySessions()
    if (pendingSessions.length === 0) {
      log.info('Stopped local Agent sessions before context switch', {
        sessionCount: previouslyBusySessions.length,
      })
      return true
    }
  }
  return false
}

let activeGuard: Promise<boolean> | null = null

/**
 * 用户主动离开当前组织或账号前的安全门禁。只有所有本机 Agent 会话真正 idle 后，
 * 才调用 continuation 改变上下文。
 */
export function runWithAgentContextSwitchGuard(
  kind: AgentContextSwitchKind,
  proceed: () => Promise<void> | void,
): Promise<boolean> {
  if (activeGuard) return activeGuard

  activeGuard = (async () => {
    try {
      const sessions = await listBusySessions()
      if (sessions.length > 0) {
        const confirmed = await requestAgentContextSwitchConfirm({
          kind,
          sessions: describeSessions(sessions),
          stop: () => stopBusySessions(sessions),
        })
        if (!confirmed) return false
      }
      await proceed()
      log.info('Agent context switch completed', { kind, stoppedSessionCount: sessions.length })
      return true
    } catch (error) {
      log.error('Agent context switch guard failed', { kind, error })
      toast({
        variant: 'destructive',
        title: '无法确认正在运行的 Agent 状态，请稍后重试。',
      })
      return false
    } finally {
      activeGuard = null
    }
  })()

  return activeGuard
}
