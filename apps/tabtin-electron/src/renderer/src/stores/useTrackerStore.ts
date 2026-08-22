/** @store-category domain */

import { create } from 'zustand'
import * as trackerApi from '@/services/trackerApi'
import { withToast } from '@/utils/with-toast-on-error'
import type {
  TrackerTask,
  ListTasksOptions,
  TrackerTaskCreate,
  TrackerTaskUpdate,
} from '@/services/trackerApi'
import { ApiError } from '@/services/api'
import { registerResetAction } from './sessionResetRegistry'
import { createLogger } from '@/utils/logger'

const log = createLogger('Tracker')

const VIEW_MODE_KEY = 'tabtin:tracker:viewMode'

/**
 * Wave 5 (charter v1.8 §3.2)：Tracker 模块三视图模式 — list / agenda / kanban
 * 同一份数据，不同渲染。`overview` 保留为「概览仪表盘」第 4 模式（不在 §3.2 三视图内
 * 但用户已习惯，向后兼容；charter 严守的是 list/agenda/kanban 都必须存在）。
 *
 * 默认值: `list`（v1.8 §3.2 明确"List 视图（默认）"）。已存历史值若是 'overview'
 * 仍尊重——已建立的用户偏好不强制重置。
 */
export type TrackerViewMode = 'list' | 'agenda' | 'kanban' | 'overview'

const VALID_VIEW_MODES: ReadonlySet<TrackerViewMode> = new Set([
  'list',
  'agenda',
  'kanban',
  'overview',
])

function loadViewMode(): TrackerViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY)
    if (v && VALID_VIEW_MODES.has(v as TrackerViewMode)) {
      return v as TrackerViewMode
    }
  } catch {
    /* ignore */
  }
  // charter v1.8 §3.2: List 视图（默认）
  return 'list'
}

function patchTaskInList(
  tasks: TrackerTask[],
  taskId: string,
  patch: Partial<TrackerTask>,
): TrackerTask[] {
  return tasks.map(t => (t.id === taskId ? { ...t, ...patch } : t))
}

function reconcileTaskPlacement(
  tasks: TrackerTask[],
  taskId: string,
  detail: TrackerTask,
  shouldInclude: boolean,
): TrackerTask[] {
  const exists = tasks.some(task => task.id === taskId)
  if (!shouldInclude) {
    return exists ? tasks.filter(task => task.id !== taskId) : tasks
  }
  return exists
    ? patchTaskInList(tasks, taskId, detail)
    : [detail, ...tasks]
}

/**
 * 失败冷却 fallback 默认值（毫秒）。
 *
 * Wave 2A(限流全栈治理)起,**主路径**改为读 `ApiError.retryAfter * 1000`
 * 动态冷却,本常量退化为 `??` 右侧 fallback,仅在以下场景触发:
 *   - 后端没返 retry_after_seconds(协议失守 / 老服务端)
 *   - 失败不是 429(网络错误 / 5xx),没有协议字段
 *   - ApiError 之外的非结构化错误(普通 Error)
 * 协议详见 `docs/api/rate-limit-protocol.md` §3.1 fallback 路径。
 *
 * **不要删除**:协议总控 §1 决策 #6 明确要求保留作 fallback;
 * `??` 主路径让我们在协议守住时尊重后端建议,fallback 让协议失守时不裸奔。
 */
const FAILURE_COOLDOWN_MS = 5_000

/**
 * 从错误对象提取协议返回的 retryAfter(秒);非 ApiError / 非 429 时返回 undefined。
 *
 * 协议 §3.1 — `ApiError.retryAfter` 已统一来自 body.retry_after_seconds /
 * Retry-After header(adapter 层转换),业务层只读 ts 风格字段。
 *
 * 与 `??` 主路径配合:
 * ```
 * const cooldownMs = (extractRetryAfterSeconds(err) ?? FAILURE_COOLDOWN_MS / 1000) * 1000
 * //                  ↑ 主路径,动态                    ↑ fallback,毫秒回算秒
 * ```
 */
function extractRetryAfterSeconds(err: unknown): number | undefined {
  if (err instanceof ApiError && typeof err.retryAfter === 'number') {
    return err.retryAfter
  }
  return undefined
}

function makeLoadKey(
  organizationId: string,
  spaceId: string | null | undefined,
  options: ListTasksOptions | undefined,
): string {
  const optStr = options
    ? JSON.stringify(options, Object.keys(options).sort())
    : ''
  return `${organizationId}|${spaceId ?? ''}|${optStr}`
}

interface TrackerListCache {
  tasks: TrackerTask[]
  isLoading: boolean
  loadError: boolean
  hasMore: boolean
  currentPage: number
  organizationId: string | null
  spaceId: string | null
  listOptions: ListTasksOptions | undefined
  requestSeq: number
  lastFailedAt: number
  lastFailedCooldownMs: number
}

const EMPTY_LIST_CACHE: TrackerListCache = {
  tasks: [],
  isLoading: false,
  loadError: false,
  hasMore: false,
  currentPage: 1,
  organizationId: null,
  spaceId: null,
  listOptions: undefined,
  requestSeq: 0,
  lastFailedAt: 0,
  lastFailedCooldownMs: 0,
}

function getListCache(
  listsByKey: Record<string, TrackerListCache>,
  key: string,
): TrackerListCache {
  return listsByKey[key] ?? EMPTY_LIST_CACHE
}

function shouldIncludeTask(
  cache: TrackerListCache,
  organizationId: string,
  spaceId: string | null | undefined,
): boolean {
  return cache.organizationId === organizationId
    && (cache.spaceId === null || cache.spaceId === (spaceId ?? null))
}

interface TrackerState {
  tasks: TrackerTask[]
  isLoading: boolean
  loadError: boolean
  hasMore: boolean
  currentPage: number
  viewMode: TrackerViewMode
  dialogState: { open: boolean; editTask?: TrackerTask | null; createSpaceId?: string | null }

  _organizationId: string | null
  _spaceId: string | null
  _listOptions: ListTasksOptions | undefined
  _listRequestSeq: number
  _inflightKey: string | null
  _lastFailedKey: string | null
  _lastFailedAt: number
  /**
   * Wave 2A:本次失败的冷却时长(毫秒),由 retryAfter 动态计算或 fallback。
   * 与 `_lastFailedAt` 配对,组成"距离 _lastFailedAt 不足 _lastFailedCooldownMs
   * 时同 key 跳过"判定。原版用固定 FAILURE_COOLDOWN_MS,现按后端建议浮动。
   */
  _lastFailedCooldownMs: number
  _listsByKey: Record<string, TrackerListCache>
  _inflightKeys: Record<string, true>

  loadTasks: (
    organizationId: string,
    spaceId?: string,
    options?: ListTasksOptions,
    opts?: { force?: boolean },
  ) => Promise<void>
  loadMoreTasks: (organizationId?: string, spaceId?: string, options?: ListTasksOptions) => Promise<void>
  setViewMode: (mode: TrackerViewMode) => void
  setDialogState: (state: { open: boolean; editTask?: TrackerTask | null; createSpaceId?: string | null }) => void

  createTask: (
    organizationId: string,
    spaceId: string,
    payload: TrackerTaskCreate,
  ) => Promise<TrackerTask | null>
  updateTask: (taskId: string, payload: TrackerTaskUpdate) => Promise<TrackerTask | null>
  deleteTask: (taskId: string) => Promise<boolean>

  patchTaskFromWS: (
    taskId: string,
    scope?: { organizationId: string },
  ) => Promise<void>
  removeTaskFromWS: (taskId: string) => void
}

const RESETTABLE_STATE = {
  tasks: [] as TrackerTask[],
  isLoading: false,
  loadError: false,
  hasMore: false,
  currentPage: 1,
  // charter v1.8 §3.2: List 视图（默认）
  viewMode: 'list' as TrackerViewMode,
  dialogState: { open: false as const },
  _organizationId: null as string | null,
  _spaceId: null as string | null,
  _listOptions: undefined as ListTasksOptions | undefined,
  _listRequestSeq: 0,
  _inflightKey: null as string | null,
  _lastFailedKey: null as string | null,
  _lastFailedAt: 0,
  _lastFailedCooldownMs: 0,
  _listsByKey: {} as Record<string, TrackerListCache>,
  _inflightKeys: {} as Record<string, true>,
}

export const useTrackerStore = create<TrackerState>()((set, get) => ({
  ...RESETTABLE_STATE,
  viewMode: loadViewMode(),

  loadTasks: async (organizationId, spaceId, options, opts) => {
    const key = makeLoadKey(organizationId, spaceId, options)
    const state = get()
    const cache = getListCache(state._listsByKey, key)

    // 同 key 已在飞行中 → 跳过(多组件挂载并发去重)
    if (state._inflightKeys[key]) return

    // Wave 2A 主路径:同 key 最近失败,冷却期长度 = 上次失败时记录的
    // `_lastFailedCooldownMs`(由 ApiError.retryAfter 动态计算 ?? FAILURE_COOLDOWN_MS
    // fallback)。原版固定 5s,现按后端协议建议浮动。
    // 用户点「重试」按钮显式 force 可绕过。
    if (
      !opts?.force
      && cache.loadError
      && Date.now() - cache.lastFailedAt < cache.lastFailedCooldownMs
    ) {
      return
    }

    const requestSeq = cache.requestSeq + 1
    const scopeChanged =
      cache.organizationId !== organizationId
      || cache.spaceId !== (spaceId ?? null)

    const nextCache: TrackerListCache = {
      ...cache,
      ...(scopeChanged ? { tasks: [] } : {}),
      isLoading: true,
      loadError: false,
      organizationId,
      spaceId: spaceId ?? null,
      listOptions: options,
      requestSeq,
    }

    set(s => ({
      ...(scopeChanged ? { tasks: [] } : {}),
      isLoading: true,
      loadError: false,
      _organizationId: organizationId,
      _spaceId: spaceId ?? null,
      _listOptions: options,
      _listRequestSeq: Math.max(s._listRequestSeq + 1, requestSeq),
      _inflightKey: key,
      _listsByKey: { ...s._listsByKey, [key]: nextCache },
      _inflightKeys: { ...s._inflightKeys, [key]: true },
    }))

    try {
      const result = await trackerApi.listTasks(organizationId, spaceId, options)
      const current = get()
      if (getListCache(current._listsByKey, key).requestSeq !== requestSeq) return
      const doneCache: TrackerListCache = {
        ...getListCache(current._listsByKey, key),
        tasks: result.tasks,
        isLoading: false,
        loadError: false,
        hasMore: result.hasMore,
        currentPage: result.page,
        lastFailedAt: 0,
        lastFailedCooldownMs: 0,
      }
      const { [key]: _removed, ...remainingInflight } = current._inflightKeys
      set({
        tasks: result.tasks,
        isLoading: false,
        loadError: false,
        hasMore: result.hasMore,
        currentPage: result.page,
        _inflightKey: null,
        _lastFailedKey: null,
        _lastFailedAt: 0,
        _lastFailedCooldownMs: 0,
        _listsByKey: { ...current._listsByKey, [key]: doneCache },
        _inflightKeys: remainingInflight,
      })
      log.debug('loadTasks done:', { organizationId, spaceId: spaceId ?? null, count: result.tasks.length, hasMore: result.hasMore })
    } catch (err) {
      log.error('loadTasks failed:', { organizationId, spaceId: spaceId ?? null, err })
      const current = get()
      if (getListCache(current._listsByKey, key).requestSeq !== requestSeq) return
      // Wave 2A 主路径:retryAfter 优先,FAILURE_COOLDOWN_MS 作 fallback
      // (协议失守 / 非 429 错误 / 普通 Error)。协议总控决策 #6 + §3.1。
      const cooldownMs =
        (extractRetryAfterSeconds(err) ?? FAILURE_COOLDOWN_MS / 1000) * 1000
      const failedCache: TrackerListCache = {
        ...getListCache(current._listsByKey, key),
        isLoading: false,
        loadError: true,
        lastFailedAt: Date.now(),
        lastFailedCooldownMs: cooldownMs,
      }
      const { [key]: _removed, ...remainingInflight } = current._inflightKeys
      set({
        isLoading: false,
        loadError: true,
        _inflightKey: null,
        _lastFailedKey: key,
        _lastFailedAt: failedCache.lastFailedAt,
        _lastFailedCooldownMs: cooldownMs,
        _listsByKey: { ...current._listsByKey, [key]: failedCache },
        _inflightKeys: remainingInflight,
      })
    }
  },

  loadMoreTasks: async (organizationIdArg, spaceIdArg, optionsArg) => {
    const state = get()
    const organizationId = organizationIdArg ?? state._organizationId
    const spaceId = spaceIdArg ?? state._spaceId ?? undefined
    const listOptions = optionsArg ?? state._listOptions
    if (!organizationId) return
    const key = makeLoadKey(organizationId, spaceId, listOptions)
    const cache = getListCache(state._listsByKey, key)
    if (!cache.hasMore || cache.isLoading) return

    set(s => ({
      isLoading: true,
      _listsByKey: {
        ...s._listsByKey,
        [key]: { ...cache, isLoading: true },
      },
    }))
    try {
      const nextPage = cache.currentPage + 1
      const result = await trackerApi.listTasks(organizationId, spaceId, {
        ...(listOptions ?? {}),
        page: nextPage,
      })
      set(s => ({
        tasks: [...s.tasks, ...result.tasks.filter(t => !s.tasks.some(ex => ex.id === t.id))],
        isLoading: false,
        hasMore: result.hasMore,
        currentPage: result.page,
        _listsByKey: {
          ...s._listsByKey,
          [key]: {
            ...getListCache(s._listsByKey, key),
            tasks: [
              ...getListCache(s._listsByKey, key).tasks,
              ...result.tasks.filter(t => !getListCache(s._listsByKey, key).tasks.some(ex => ex.id === t.id)),
            ],
            isLoading: false,
            hasMore: result.hasMore,
            currentPage: result.page,
          },
        },
      }))
    } catch (err) {
      log.error('loadMoreTasks failed:', { page: cache.currentPage + 1, err })
      set(s => ({
        isLoading: false,
        _listsByKey: {
          ...s._listsByKey,
          [key]: { ...getListCache(s._listsByKey, key), isLoading: false },
        },
      }))
    }
  },

  setViewMode: mode => {
    set({ viewMode: mode })
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode)
    } catch { /* ignore */ }
  },

  setDialogState: state => set({ dialogState: state }),

  // W2-γ：withToast 接入样板。原 try/catch + console.error + toast.error +
  // return null 模板被 HOC 接管，单 action 直接返业务结果，失败由 HOC 自动
  // 弹 destructive toast（含 trace 末 6 位，可点击复制）。caller 现有的
  // `if (created) { ... }` truthy check 在 rethrow:false 下仍生效（undefined
  // 仍 falsy）—— 行为兼容。
  createTask: withToast(
    async (organizationId, spaceId, payload) => {
      const created = await trackerApi.createTask(organizationId, spaceId, payload)
      const { _organizationId, _spaceId } = get()
      set(s => {
        const nextListsByKey: Record<string, TrackerListCache> = {}
        for (const [key, cache] of Object.entries(s._listsByKey)) {
          nextListsByKey[key] = shouldIncludeTask(cache, organizationId, spaceId)
            ? { ...cache, tasks: [created, ...cache.tasks.filter(t => t.id !== created.id)] }
            : cache
        }
        return {
          _listsByKey: nextListsByKey,
          ...(_organizationId === organizationId && (_spaceId === null || _spaceId === spaceId)
            ? { tasks: [created, ...s.tasks.filter(t => t.id !== created.id)] }
            : {}),
        }
      })
      return created
    },
    { titleKey: 'errors.trackerCreateFailed', rethrow: false },
  ),

  updateTask: async (taskId, payload) => {
    try {
      const updated = await trackerApi.updateTask(taskId, payload)
      set(s => ({
        tasks: patchTaskInList(s.tasks, taskId, updated),
        _listsByKey: Object.fromEntries(
          Object.entries(s._listsByKey).map(([key, cache]) => [
            key,
            { ...cache, tasks: patchTaskInList(cache.tasks, taskId, updated) },
          ]),
        ),
      }))
      return updated
    } catch (err) {
      // W2-γ 范围限定：本 action 暂不接入 withToast。原因：CreateTrackerDialog
      // 已经把 result?.error / submitError 渲染在表单内，再在 store 层弹 toast
      // 会与表单 inline error 重复呈现。withToast 接入留待后续按场景做。
      log.error('updateTask failed:', { taskId, err })
      throw err
    }
  },

  // W2-γ：withToast 接入样板。同 createTask 思路。
  deleteTask: withToast(
    async (taskId: string): Promise<boolean> => {
      await trackerApi.deleteTask(taskId)
      set(s => ({
        tasks: s.tasks.filter(t => t.id !== taskId),
        _listsByKey: Object.fromEntries(
          Object.entries(s._listsByKey).map(([key, cache]) => [
            key,
            { ...cache, tasks: cache.tasks.filter(t => t.id !== taskId) },
          ]),
        ),
        dialogState:
          s.dialogState.editTask?.id === taskId ? { open: false } : s.dialogState,
      }))
      return true
    },
    { titleKey: 'errors.trackerDeleteFailed', rethrow: false },
  ) as TrackerState['deleteTask'],

  patchTaskFromWS: async (taskId, scope) => {
    try {
      const detail = await trackerApi.getTask(taskId)
      set(s => {
        const topLevelExists = s.tasks.some(task => task.id === taskId)
        const topLevelOrganizationMatches = scope
          ? s._organizationId === scope.organizationId
          : topLevelExists
        const topLevelSpaceMatches = s._spaceId === null
          || s._spaceId === (detail.space_id ?? null)
        const tasks = reconcileTaskPlacement(
          s.tasks,
          taskId,
          detail,
          topLevelOrganizationMatches && topLevelSpaceMatches,
        )
        const nextListsByKey = Object.fromEntries(
          Object.entries(s._listsByKey).map(([key, cache]) => {
            const cacheExists = cache.tasks.some(t => t.id === taskId)
            const organizationMatches = scope
              ? cache.organizationId === scope.organizationId
              : cacheExists
            if (!organizationMatches) return [key, cache]
            const shouldInclude = cache.spaceId === null || cache.spaceId === (detail.space_id ?? null)
            const nextTasks = reconcileTaskPlacement(
              cache.tasks,
              taskId,
              detail,
              shouldInclude,
            )
            return [key, { ...cache, tasks: nextTasks }]
          }),
        )
        return { tasks, _listsByKey: nextListsByKey }
      })
    } catch (err) {
      // WS 推送触发的补丁失败非致命（下次列表刷新会自愈），但记一条便于对齐时间线
      log.warn('patchTaskFromWS failed (non-critical):', { taskId, err })
    }
  },

  removeTaskFromWS: (taskId) => {
    set(s => ({
      tasks: s.tasks.filter(t => t.id !== taskId),
      _listsByKey: Object.fromEntries(
        Object.entries(s._listsByKey).map(([key, cache]) => [
          key,
          { ...cache, tasks: cache.tasks.filter(t => t.id !== taskId) },
        ]),
      ),
    }))
  },
}))

export function useTrackerListState(
  organizationId: string | null | undefined,
  spaceId?: string,
  options?: ListTasksOptions,
) {
  const key = organizationId ? makeLoadKey(organizationId, spaceId, options) : null
  return useTrackerStore(s => {
    if (!key) return EMPTY_LIST_CACHE
    return getListCache(s._listsByKey, key)
  })
}

registerResetAction('tracker', 'reset', () => {
  useTrackerStore.setState({ ...RESETTABLE_STATE, viewMode: loadViewMode() })
})
