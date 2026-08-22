/** @store-category domain */

/**
 * Project Task 统一状态源。
 *
 * Overview / TasksPane / 侧栏对话分组共用本 store，避免三份局部快照互不联动。
 * 实时路径：`agent.user.project_task_invalidated` → 按 version 去重 → 重拉权限 API。
 * 兜底：WS 重连、窗口焦点恢复对已跟踪 Project 做 revalidate。
 */

import { create } from 'zustand'
import { ProjectApiService } from '@/services/projectApi'
import type { ProjectTask } from '@/types/project'
import { registerResetAction } from './sessionResetRegistry'
import { createLogger } from '@/utils/logger'

const log = createLogger('ProjectTaskStore')

export interface ProjectTaskInvalidationPayload {
  project_id: string
  task_id: string
  event_type: string
  version: number
}

interface ProjectBucket {
  tasks: ProjectTask[]
  inbox: ProjectTask[]
  /** 该 Project 是否至少被某个 UI 挂载过（重连/焦点只刷这些）。 */
  tracked: boolean
  tasksLoading: boolean
  inboxLoading: boolean
  tasksError: string
  inboxError: string
}

interface ProjectTaskState {
  byProjectId: Record<string, ProjectBucket>
  /** taskId → 已接受的最高 version（去重刷新风暴）。 */
  appliedVersionByTaskId: Record<string, number>
  /** projectId → 合并窗口内的待处理 invalidation。 */
  pendingInvalidateByProjectId: Record<string, true>
  fetchTasks: (projectId: string, options?: { quiet?: boolean }) => Promise<void>
  fetchInbox: (projectId: string, options?: { quiet?: boolean }) => Promise<void>
  trackProject: (projectId: string) => void
  applyInvalidation: (payload: ProjectTaskInvalidationPayload) => void
  revalidateProject: (projectId: string) => Promise<void>
  revalidateTrackedProjects: () => void
  getTasks: (projectId: string) => ProjectTask[]
  getInbox: (projectId: string) => ProjectTask[]
}

const EMPTY_TASKS: ProjectTask[] = []

const emptyBucket = (): ProjectBucket => ({
  tasks: EMPTY_TASKS,
  inbox: EMPTY_TASKS,
  tracked: false,
  tasksLoading: false,
  inboxLoading: false,
  tasksError: '',
  inboxError: '',
})

const tasksInFlight = new Map<string, Promise<void>>()
const inboxInFlight = new Map<string, Promise<void>>()
const invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>()

const INVALIDATE_COALESCE_MS = 80

function rememberVersions(tasks: ProjectTask[]): Record<string, number> {
  const next: Record<string, number> = {}
  for (const task of tasks) {
    if (typeof task.version === 'number' && Number.isFinite(task.version)) {
      next[task.id] = task.version
    }
  }
  return next
}

function mergeAppliedVersions(
  current: Record<string, number>,
  fromTasks: ProjectTask[],
): Record<string, number> {
  if (fromTasks.length === 0) return current
  let changed = false
  const next = { ...current }
  for (const task of fromTasks) {
    if (typeof task.version !== 'number' || !Number.isFinite(task.version)) continue
    const prev = next[task.id]
    if (prev === undefined || task.version > prev) {
      next[task.id] = task.version
      changed = true
    }
  }
  return changed ? next : current
}

export const useProjectTaskStore = create<ProjectTaskState>((set, get) => ({
  byProjectId: {},
  appliedVersionByTaskId: {},
  pendingInvalidateByProjectId: {},

  getTasks: (projectId) => get().byProjectId[projectId]?.tasks ?? EMPTY_TASKS,
  getInbox: (projectId) => get().byProjectId[projectId]?.inbox ?? EMPTY_TASKS,

  trackProject: (projectId) => {
    if (!projectId) return
    set((state) => {
      const existing = state.byProjectId[projectId]
      if (existing?.tracked) return state
      return {
        byProjectId: {
          ...state.byProjectId,
          [projectId]: { ...(existing ?? emptyBucket()), tracked: true },
        },
      }
    })
  },

  fetchTasks: async (projectId, options = {}) => {
    if (!projectId) return
    const existing = tasksInFlight.get(projectId)
    if (existing) return existing

    const quiet = Boolean(options.quiet)
    const run = (async () => {
      get().trackProject(projectId)
      if (!quiet) {
        set((state) => ({
          byProjectId: {
            ...state.byProjectId,
            [projectId]: {
              ...(state.byProjectId[projectId] ?? emptyBucket()),
              tracked: true,
              tasksLoading: true,
              tasksError: '',
            },
          },
        }))
      }
      try {
        const result = await ProjectApiService.listTasks(projectId, false)
        const tasks = result.tasks ?? EMPTY_TASKS
        set((state) => ({
          byProjectId: {
            ...state.byProjectId,
            [projectId]: {
              ...(state.byProjectId[projectId] ?? emptyBucket()),
              tracked: true,
              tasks,
              tasksLoading: false,
              tasksError: '',
            },
          },
          appliedVersionByTaskId: mergeAppliedVersions(state.appliedVersionByTaskId, tasks),
        }))
      } catch (cause) {
        log.error('list tasks failed', { projectId, cause })
        set((state) => ({
          byProjectId: {
            ...state.byProjectId,
            [projectId]: {
              ...(state.byProjectId[projectId] ?? emptyBucket()),
              tracked: true,
              tasksLoading: false,
              tasksError: cause instanceof Error ? cause.message : '项目任务加载失败',
            },
          },
        }))
      } finally {
        tasksInFlight.delete(projectId)
      }
    })()

    tasksInFlight.set(projectId, run)
    return run
  },

  fetchInbox: async (projectId, options = {}) => {
    if (!projectId) return
    const existing = inboxInFlight.get(projectId)
    if (existing) return existing

    const quiet = Boolean(options.quiet)
    const run = (async () => {
      get().trackProject(projectId)
      if (!quiet) {
        set((state) => ({
          byProjectId: {
            ...state.byProjectId,
            [projectId]: {
              ...(state.byProjectId[projectId] ?? emptyBucket()),
              tracked: true,
              inboxLoading: true,
              inboxError: '',
            },
          },
        }))
      }
      try {
        const result = await ProjectApiService.listTasks(projectId, true)
        const inbox = result.tasks ?? EMPTY_TASKS
        set((state) => ({
          byProjectId: {
            ...state.byProjectId,
            [projectId]: {
              ...(state.byProjectId[projectId] ?? emptyBucket()),
              tracked: true,
              inbox,
              inboxLoading: false,
              inboxError: '',
            },
          },
          appliedVersionByTaskId: mergeAppliedVersions(state.appliedVersionByTaskId, inbox),
        }))
      } catch (cause) {
        log.error('list inbox failed', { projectId, cause })
        set((state) => ({
          byProjectId: {
            ...state.byProjectId,
            [projectId]: {
              ...(state.byProjectId[projectId] ?? emptyBucket()),
              tracked: true,
              inboxLoading: false,
              inboxError: cause instanceof Error ? cause.message : '收件箱加载失败',
            },
          },
        }))
      } finally {
        inboxInFlight.delete(projectId)
      }
    })()

    inboxInFlight.set(projectId, run)
    return run
  },

  applyInvalidation: (payload) => {
    const projectId = typeof payload?.project_id === 'string' ? payload.project_id : ''
    const taskId = typeof payload?.task_id === 'string' ? payload.task_id : ''
    const version = typeof payload?.version === 'number' ? payload.version : Number(payload?.version)
    if (!projectId || !taskId || !Number.isFinite(version)) {
      log.warn('invalid project_task_invalidated payload', { payload })
      return
    }

    const applied = get().appliedVersionByTaskId[taskId]
    if (applied !== undefined && applied >= version) {
      return
    }

    set((state) => ({
      appliedVersionByTaskId: {
        ...state.appliedVersionByTaskId,
        [taskId]: Math.max(applied ?? 0, version),
      },
      byProjectId: {
        ...state.byProjectId,
        [projectId]: {
          ...(state.byProjectId[projectId] ?? emptyBucket()),
          tracked: true,
        },
      },
      pendingInvalidateByProjectId: {
        ...state.pendingInvalidateByProjectId,
        [projectId]: true,
      },
    }))

    const existingTimer = invalidateTimers.get(projectId)
    if (existingTimer) clearTimeout(existingTimer)
    invalidateTimers.set(
      projectId,
      setTimeout(() => {
        invalidateTimers.delete(projectId)
        set((state) => {
          if (!state.pendingInvalidateByProjectId[projectId]) return state
          const pending = { ...state.pendingInvalidateByProjectId }
          delete pending[projectId]
          return { pendingInvalidateByProjectId: pending }
        })
        void get().revalidateProject(projectId)
      }, INVALIDATE_COALESCE_MS),
    )
  },

  revalidateProject: async (projectId) => {
    if (!projectId) return
    get().trackProject(projectId)
    await Promise.all([
      get().fetchTasks(projectId, { quiet: true }),
      get().fetchInbox(projectId, { quiet: true }),
    ])
  },

  revalidateTrackedProjects: () => {
    const tracked = Object.entries(get().byProjectId)
      .filter(([, bucket]) => bucket.tracked)
      .map(([projectId]) => projectId)
    for (const projectId of tracked) {
      void get().revalidateProject(projectId)
    }
  },
}))

registerResetAction('project-task', 'reset', () => {
  for (const timer of invalidateTimers.values()) clearTimeout(timer)
  invalidateTimers.clear()
  tasksInFlight.clear()
  inboxInFlight.clear()
  useProjectTaskStore.setState({
    byProjectId: {},
    appliedVersionByTaskId: {},
    pendingInvalidateByProjectId: {},
  })
})

/** 供单测导出：从列表提取 version map；并清空 in-flight / 桶状态。 */
export const __test__ = {
  rememberVersions,
  mergeAppliedVersions,
  INVALIDATE_COALESCE_MS,
  resetStore() {
    for (const timer of invalidateTimers.values()) clearTimeout(timer)
    invalidateTimers.clear()
    tasksInFlight.clear()
    inboxInFlight.clear()
    useProjectTaskStore.setState({
      byProjectId: {},
      appliedVersionByTaskId: {},
      pendingInvalidateByProjectId: {},
    })
  },
}
