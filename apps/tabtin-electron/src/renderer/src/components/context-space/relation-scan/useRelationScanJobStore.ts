/**
 * 第三方源关联关系扫描——多任务全局 store。
 *
 * 每个 startTask 生成独立折叠任务卡片，互不覆盖；source 可扩展（feishu / …）。
 * 条目状态机对齐导入进度：pending / running / done / error / skipped / cancelled。
 */
import { create } from 'zustand'
import { createLogger } from '@/utils/logger'
import {
  isExcludedFromScanResult,
  isTerminalRelationScanItemStatus,
  type RelationScanItem,
  type RelationScanSource,
  type RelationScanTask,
  type RelationScanTaskStatus,
} from './relationScanTypes'

const log = createLogger('RelationScanJob')

export interface StartRelationScanTaskInput {
  source: RelationScanSource
  title: string
  items: Array<{ key: string; name: string }>
  /** 默认 true：收束弹窗，完成后由发起方弹回 */
  holdingDialog?: boolean
}

export interface CompleteRelationScanResult {
  ok: boolean
  shouldResume: boolean
  excludedKeys: string[]
}

interface RelationScanJobStore {
  tasks: RelationScanTask[]

  startTask: (input: StartRelationScanTaskInput) => string
  /** 请求已发出：未终态条目标为 running */
  markTaskRunning: (taskId: string) => boolean
  completeTask: (taskId: string) => CompleteRelationScanResult
  failTask: (taskId: string, message: string) => CompleteRelationScanResult
  skipItem: (taskId: string, itemKey: string) => void
  cancelItem: (taskId: string, itemKey: string) => void
  toggleCollapsed: (taskId: string) => void
  expandTask: (taskId: string) => void
  dismissTask: (taskId: string) => void
  /** 是否有任意任务（或指定任务）仍占用弹窗收束态 */
  isHoldingDialog: (taskId?: string) => boolean
  getExcludedKeys: (taskId: string) => string[]
  getActiveItemKeys: (taskId: string) => string[]
}

function newTaskId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `relscan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function mapTask(
  tasks: RelationScanTask[],
  taskId: string,
  updater: (task: RelationScanTask) => RelationScanTask,
): RelationScanTask[] {
  return tasks.map((task) => (task.id === taskId ? updater(task) : task))
}

function findTask(tasks: RelationScanTask[], taskId: string): RelationScanTask | undefined {
  return tasks.find((task) => task.id === taskId)
}

function deriveTaskStatus(items: RelationScanItem[]): RelationScanTaskStatus {
  if (items.some((item) => item.status === 'error')) return 'error'
  if (items.every((item) => isTerminalRelationScanItemStatus(item.status))) {
    if (items.every((item) => isExcludedFromScanResult(item.status))) return 'error'
    return 'done'
  }
  return 'scanning'
}

export const useRelationScanJobStore = create<RelationScanJobStore>((set, get) => ({
  tasks: [],

  startTask: (input) => {
    const id = newTaskId()
    const hold = input.holdingDialog !== false
    const items: RelationScanItem[] = input.items.map((row) => ({
      key: row.key,
      name: row.name,
      status: 'pending' as const,
    }))
    const task: RelationScanTask = {
      id,
      source: input.source,
      title: input.title,
      status: 'scanning',
      items,
      collapsed: true,
      errorMessage: null,
      holdingDialog: hold,
      createdAt: Date.now(),
    }

    set((prev) => ({
      tasks: [
        // 新任务抢走弹窗 holding，旧任务转后台独立跑完
        ...prev.tasks.map((row) => (
          hold && row.holdingDialog ? { ...row, holdingDialog: false } : row
        )),
        task,
      ],
    }))

    log.info('relation scan task started', {
      taskId: id,
      source: input.source,
      items: items.length,
      holdingDialog: hold,
    })
    return id
  },

  markTaskRunning: (taskId) => {
    const task = findTask(get().tasks, taskId)
    if (!task || task.status !== 'scanning') return false
    set((prev) => ({
      tasks: mapTask(prev.tasks, taskId, (row) => ({
        ...row,
        items: row.items.map((item) => (
          isTerminalRelationScanItemStatus(item.status)
            ? item
            : { ...item, status: 'running' as const }
        )),
      })),
    }))
    return true
  },

  completeTask: (taskId) => {
    const task = findTask(get().tasks, taskId)
    if (!task) return { ok: false, shouldResume: false, excludedKeys: [] }
    const shouldResume = task.holdingDialog
    const excludedKeys = task.items
      .filter((item) => isExcludedFromScanResult(item.status))
      .map((item) => item.key)

    set((prev) => ({
      tasks: mapTask(prev.tasks, taskId, (row) => ({
        ...row,
        status: 'done',
        holdingDialog: shouldResume,
        errorMessage: null,
        items: row.items.map((item) => (
          isExcludedFromScanResult(item.status) || item.status === 'error'
            ? item
            : { ...item, status: 'done' as const }
        )),
      })),
    }))
    log.info('relation scan task completed', { taskId, shouldResume, excluded: excludedKeys.length })
    return { ok: true, shouldResume, excludedKeys }
  },

  failTask: (taskId, message) => {
    const task = findTask(get().tasks, taskId)
    if (!task) return { ok: false, shouldResume: false, excludedKeys: [] }
    const shouldResume = task.holdingDialog
    const excludedKeys = task.items
      .filter((item) => isExcludedFromScanResult(item.status))
      .map((item) => item.key)

    set((prev) => ({
      tasks: mapTask(prev.tasks, taskId, (row) => ({
        ...row,
        status: 'error',
        holdingDialog: shouldResume,
        errorMessage: message,
        collapsed: false,
        items: row.items.map((item) => (
          isTerminalRelationScanItemStatus(item.status)
            ? item
            : { ...item, status: 'error' as const }
        )),
      })),
    }))
    log.warn('relation scan task failed', { taskId, message })
    return { ok: true, shouldResume, excludedKeys }
  },

  skipItem: (taskId, itemKey) => {
    const task = findTask(get().tasks, taskId)
    if (!task || task.status !== 'scanning') return
    const item = task.items.find((row) => row.key === itemKey)
    if (!item || item.status !== 'running') return

    set((prev) => ({
      tasks: mapTask(prev.tasks, taskId, (row) => {
        const items = row.items.map((entry) => (
          entry.key === itemKey ? { ...entry, status: 'skipped' as const } : entry
        ))
        return { ...row, status: deriveTaskStatus(items), items }
      }),
    }))
    log.info('relation scan item skipped', { taskId, itemKey })
  },

  cancelItem: (taskId, itemKey) => {
    const task = findTask(get().tasks, taskId)
    if (!task || task.status !== 'scanning') return
    const item = task.items.find((row) => row.key === itemKey)
    if (!item || item.status !== 'pending') return

    set((prev) => ({
      tasks: mapTask(prev.tasks, taskId, (row) => {
        const items = row.items.map((entry) => (
          entry.key === itemKey ? { ...entry, status: 'cancelled' as const } : entry
        ))
        return { ...row, status: deriveTaskStatus(items), items }
      }),
    }))
    log.info('relation scan item cancelled', { taskId, itemKey })
  },

  toggleCollapsed: (taskId) => {
    set((prev) => ({
      tasks: mapTask(prev.tasks, taskId, (row) => ({
        ...row,
        collapsed: !row.collapsed,
      })),
    }))
  },

  expandTask: (taskId) => {
    set((prev) => ({
      tasks: mapTask(prev.tasks, taskId, (row) => ({
        ...row,
        collapsed: false,
      })),
    }))
  },

  dismissTask: (taskId) => {
    set((prev) => ({
      tasks: prev.tasks.filter((task) => task.id !== taskId),
    }))
    log.info('relation scan task dismissed', { taskId })
  },

  isHoldingDialog: (taskId) => {
    const { tasks } = get()
    if (taskId) {
      return Boolean(findTask(tasks, taskId)?.holdingDialog)
    }
    return tasks.some((task) => task.holdingDialog)
  },

  getExcludedKeys: (taskId) => {
    const task = findTask(get().tasks, taskId)
    if (!task) return []
    return task.items
      .filter((item) => isExcludedFromScanResult(item.status))
      .map((item) => item.key)
  },

  getActiveItemKeys: (taskId) => {
    const task = findTask(get().tasks, taskId)
    if (!task) return []
    return task.items
      .filter((item) => !isExcludedFromScanResult(item.status))
      .map((item) => item.key)
  },
}))
