/**
 * 外部 Agent 导入任务状态 store（Layer D）。
 *
 * 契约：`window.tabtin.import.run` 立即返回 jobId，真正的进度经 IPC event
 * `import:progress`（onProgress 订阅）逐条推来；最终结果报告经 `status({jobId})`
 * 拉取。本 store 把这两路信息聚合成单一可订阅状态，让**向导第三步**与**悬浮进度
 * 面板**共享同一份进度——用户关掉向导 Dialog 后导入仍在后台跑，面板继续显示
 * （PRD §4.4「后台进行，期间可正常使用」）。
 *
 * onProgress 订阅只在 `ExternalImportWizardHost`（挂 AppLayout，全局单例）里建立
 * 一次，事件路由到 `applyProgress`；`startJob` 内部起一个轻量 status 轮询兜底，
 * 直到任务 state 脱离 running 才停。
 */

import { create } from 'zustand'
import type {
  ImportJobState,
  ImportProgressEvent,
  ImportRollbackOutput,
  ImportRunInput,
  ImportRunReport,
} from '@tabtin/cli-server-core'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { markExternalImportCompleted } from './importSidebarIndicator'
import { useExternalArchiveIndexStore } from './useExternalArchiveIndexStore'
import { forgetExternalOpenedSession } from './externalOpenedSessionRegistry'
import type { ExternalArchiveIndexEntry } from './externalArchiveTypes'

/** 导入 / 撤销都会改本机档案；侧栏索引和工作空间列表要主动刷新。 */
function refreshExternalImportViews(organizationId: string | undefined): void {
  useExternalArchiveIndexStore.getState().bump()
  if (!organizationId) return
  void useSpaceStore.getState().loadSpaces(organizationId).catch(() => {
    /* 刷新失败不挡结果页 */
  })
}

function archiveKey(entry: Pick<ExternalArchiveIndexEntry, 'source' | 'sourceSessionId'>): string {
  return `${entry.source}:${entry.sourceSessionId}`
}

function resolveOpenedSessionSpaceId(entry: ExternalArchiveIndexEntry): string | null {
  const openedSessionId = entry.openedSessionId?.trim()
  if (!openedSessionId) return null
  if (entry.workspaceId) return entry.workspaceId

  const chat = useChatStore.getState()
  const session = chat.getSessionById(openedSessionId)
  const fromSession = session ? resolveSessionScopeId(session) : null
  if (fromSession) return fromSession

  for (const [spaceId, sessions] of Object.entries(chat.sessionsBySpaceId ?? {})) {
    if ((sessions ?? []).some((item) => item.id === openedSessionId)) {
      return spaceId
    }
  }
  return null
}

async function cleanupOpenedSessionsForRemovedArchives(args: {
  before: ExternalArchiveIndexEntry[]
  after: ExternalArchiveIndexEntry[]
}): Promise<void> {
  const afterKeys = new Set(args.after.map(archiveKey))
  const removed = args.before.filter((entry) => !afterKeys.has(archiveKey(entry)))
  const chat = useChatStore.getState()
  const seenSessionIds = new Set<string>()

  for (const entry of removed) {
    const sessionId = entry.openedSessionId?.trim()
    if (!sessionId || seenSessionIds.has(sessionId)) continue
    seenSessionIds.add(sessionId)
    const spaceId = resolveOpenedSessionSpaceId(entry)
    if (!spaceId) {
      forgetExternalOpenedSession(sessionId)
      continue
    }
    try {
      await chat.deleteSession(spaceId, sessionId)
    } catch {
      /* 单条会话清理失败不阻断 rollback 结果页 */
    } finally {
      forgetExternalOpenedSession(sessionId)
    }
  }
}

/** 向导内部把 idle 也纳入状态机，区分「从未导过」与「已完成」。 */
export type ImportJobUiState = 'idle' | ImportJobState

interface ImportJobStore {
  jobId: string | null
  organizationId: string | null
  state: ImportJobUiState
  /** 整体进度（会话粒度）。onProgress 与 status 轮询都会刷新，取较新者。 */
  overall: { done: number; total: number }
  /** 当前正在处理的 workspace 标识与阶段（onProgress 载荷）。 */
  currentWorkspace: string | null
  phase: string | null
  /** 处理过的 workspace 轨迹（去重，用于「逐 workspace」展示）。 */
  seenWorkspaces: string[]
  report: ImportRunReport | null
  error: string | null
  /** rollback 成功后置位，用于禁用「移除本次导入」按钮避免重复删。 */
  rolledBack: boolean

  startJob: (input: ImportRunInput) => Promise<void>
  applyProgress: (evt: ImportProgressEvent) => void
  cancel: () => Promise<void>
  rollbackLast: () => Promise<ImportRollbackOutput | null>
  reset: () => void
}

const IDLE_SNAPSHOT = {
  jobId: null,
  organizationId: null,
  state: 'idle' as ImportJobUiState,
  overall: { done: 0, total: 0 },
  currentWorkspace: null,
  phase: null,
  seenWorkspaces: [] as string[],
  report: null,
  error: null,
  rolledBack: false,
}

export const useImportJobStore = create<ImportJobStore>((set, get) => ({
  ...IDLE_SNAPSHOT,

  startJob: async (input) => {
    const api = window.tabtin?.import
    const totalSessions = input.sources.reduce((n, s) => n + (s.sessionRefs?.length ?? 0), 0)
    set({
      ...IDLE_SNAPSHOT,
      jobId: input.jobId,
      organizationId: input.options.targetOrganizationId,
      state: 'running',
      overall: { done: 0, total: totalSessions },
    })

    if (!api) {
      set({ state: 'error', error: '导入服务尚未就绪，请稍后重试' })
      return
    }

    try {
      await api.run(input)
    } catch (err) {
      set({ state: 'error', error: err instanceof Error ? err.message : String(err) })
      return
    }

    // status 轮询兜底：即使个别 onProgress 丢失，也能拿到最终报告与终态。
    const poll = async (): Promise<void> => {
      // 任务已被 reset / 换了新 job → 停止旧轮询。
      if (get().jobId !== input.jobId) return
      try {
        const st = await api.status({ jobId: input.jobId })
        // 只在仍是同一 job 且未提前进入终态时回写。
        if (get().jobId !== input.jobId) return
        if (st.progress && st.progress.total > 0) {
          set({ overall: st.progress })
        }
        if (st.state !== 'running') {
          if (st.state === 'completed') {
            markExternalImportCompleted()
          }
          // completed / cancelled（可能已写入部分档案）都刷新侧栏工作空间
          if (st.state === 'completed' || st.state === 'cancelled') {
            refreshExternalImportViews(input.options?.targetOrganizationId)
          }
          set({ state: st.state, report: st.report ?? get().report })
          return
        }
      } catch {
        // status 抖动不致命，继续轮询。
      }
      window.setTimeout(() => {
        void poll()
      }, 900)
    }
    window.setTimeout(() => {
      void poll()
    }, 900)
  },

  applyProgress: (evt) => {
    if (get().jobId !== evt.jobId) return
    set((s) => {
      const seen = s.seenWorkspaces.includes(evt.workspace)
        ? s.seenWorkspaces
        : [...s.seenWorkspaces, evt.workspace]
      // done/total 为整体会话进度（workspace 字段标当前处理项）。
      const nextTotal = evt.total > 0 ? evt.total : s.overall.total
      return {
        overall: { done: evt.done, total: nextTotal },
        currentWorkspace: evt.workspace,
        phase: evt.phase,
        seenWorkspaces: seen,
      }
    })
  },

  cancel: async () => {
    const { jobId } = get()
    if (!jobId) return
    try {
      await window.tabtin?.import?.cancel({ jobId })
    } catch {
      /* 取消失败也把 UI 置为取消态，避免卡在 running */
    }
    set({ state: 'cancelled' })
  },

  rollbackLast: async () => {
    const { jobId, organizationId } = get()
    if (!jobId || !window.tabtin?.import) return null
    const listArchives = window.tabtin.import.listArchives
    const beforeArchives = organizationId && listArchives
      ? await listArchives(organizationId).catch(() => [] as ExternalArchiveIndexEntry[])
      : []
    const res = await window.tabtin.import.rollback({ jobId })
    if (res) {
      const afterArchives = organizationId && listArchives
        ? await listArchives(organizationId).catch(() => [] as ExternalArchiveIndexEntry[])
        : []
      await cleanupOpenedSessionsForRemovedArchives({
        before: beforeArchives as ExternalArchiveIndexEntry[],
        after: afterArchives as ExternalArchiveIndexEntry[],
      })
      refreshExternalImportViews(organizationId ?? undefined)
      set({ rolledBack: true })
    }
    return res
  },

  reset: () => set({ ...IDLE_SNAPSHOT }),
}))
