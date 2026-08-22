/**
 * useTrackerStore regression test —
 * 钉死「请求频率过高」雪崩根因修复(charter 内 Tracker 模块):
 *   1. inflight 同 key 去重(多组件挂载并发)
 *   2. 失败后 5s 冷却期内同 key 调用直接 noop(useEffect 失败-翻转-死循环)
 *   3. force=true 绕过冷却(retry 按钮)
 *   4. scope 切换不被旧 key 冷却阻拦
 *
 * Wave 2A 扩展:动态读取 ApiError.retryAfter 做冷却,
 * 5_000 ms 仅作 fallback(协议总控决策 #6)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listTasks = vi.fn()
const getTask = vi.fn()

vi.mock('@/services/trackerApi', () => ({
  listTasks: (...args: unknown[]) => listTasks(...args),
  getTask: (...args: unknown[]) => getTask(...args),
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('./sessionResetRegistry', () => ({
  registerResetAction: () => () => {},
}))

import { useTrackerStore } from './useTrackerStore'
import { ApiError } from '@/services/api'

const EMPTY_RESULT = { tasks: [], hasMore: false, page: 1, pageSize: 200, total: 0 }

function resetStore(): void {
  useTrackerStore.setState({
    tasks: [],
    isLoading: false,
    loadError: false,
    hasMore: false,
    currentPage: 1,
    _organizationId: null,
    _spaceId: null,
    _listOptions: undefined,
    _listRequestSeq: 0,
    _inflightKey: null,
    _lastFailedKey: null,
    _lastFailedAt: 0,
    _lastFailedCooldownMs: 0,
    _listsByKey: {},
    _inflightKeys: {},
  })
}

function makeTask(id: string, spaceId: string) {
  return {
    id,
    name: id,
    description: '',
    space_id: spaceId,
    status: 'active',
    trigger_type: 'cron',
    skill_key: null,
    next_run_at: null,
    last_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    total_runs: 0,
    success_runs: 0,
    fail_runs: 0,
    has_active_run: false,
  }
}

describe('useTrackerStore loadTasks 雪崩防御', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    listTasks.mockReset()
    getTask.mockReset()
    resetStore()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('同 key 已在飞行中,再次调用直接 noop(并发去重)', async () => {
    let resolveFn: (v: unknown) => void = () => {}
    listTasks.mockImplementation(
      () => new Promise(r => {
        resolveFn = r
      }),
    )

    const p1 = useTrackerStore.getState().loadTasks('wt', 'sp')
    const p2 = useTrackerStore.getState().loadTasks('wt', 'sp')
    const p3 = useTrackerStore.getState().loadTasks('wt', 'sp')

    expect(listTasks).toHaveBeenCalledTimes(1)

    resolveFn(EMPTY_RESULT)
    await Promise.all([p1, p2, p3])
  })

  it('失败后冷却期内同 key 调用直接 noop(防失败-翻转死循环)', async () => {
    listTasks.mockRejectedValue(new Error('请求频率过高,请稍后再试'))

    await useTrackerStore.getState().loadTasks('wt', 'sp')
    expect(listTasks).toHaveBeenCalledTimes(1)

    // 模拟原 useEffect 因 isLoading/tasks.length 翻转反复触发的场景
    await useTrackerStore.getState().loadTasks('wt', 'sp')
    await useTrackerStore.getState().loadTasks('wt', 'sp')
    await useTrackerStore.getState().loadTasks('wt', 'sp')

    expect(listTasks).toHaveBeenCalledTimes(1)
  })

  it('force=true 绕过失败冷却(retry 按钮场景)', async () => {
    listTasks.mockRejectedValueOnce(new Error('网络错误'))
    await useTrackerStore.getState().loadTasks('wt', 'sp')
    expect(listTasks).toHaveBeenCalledTimes(1)

    listTasks.mockResolvedValueOnce(EMPTY_RESULT)
    await useTrackerStore
      .getState()
      .loadTasks('wt', 'sp', undefined, { force: true })

    expect(listTasks).toHaveBeenCalledTimes(2)
    expect(useTrackerStore.getState().loadError).toBe(false)
  })

  it('scope 切换发新请求,不被旧 key 冷却阻拦', async () => {
    listTasks.mockRejectedValueOnce(new Error('fail A'))
    await useTrackerStore.getState().loadTasks('wt-A', 'sp-1')
    expect(listTasks).toHaveBeenCalledTimes(1)

    listTasks.mockResolvedValueOnce(EMPTY_RESULT)
    await useTrackerStore.getState().loadTasks('wt-B', 'sp-1')
    expect(listTasks).toHaveBeenCalledTimes(2)
  })

  it('成功加载后清空 _lastFailedKey,后续可立即再次发请求', async () => {
    listTasks.mockResolvedValueOnce(EMPTY_RESULT)
    await useTrackerStore.getState().loadTasks('wt', 'sp')

    listTasks.mockResolvedValueOnce(EMPTY_RESULT)
    await useTrackerStore.getState().loadTasks('wt', 'sp')

    expect(listTasks).toHaveBeenCalledTimes(2)
  })

  it('按 scope 缓存列表,组织级和 Space 级不会互相覆盖', async () => {
    const orgTask = makeTask('org-task', 'sp-2')
    const spaceTask = makeTask('space-task', 'sp-1')
    listTasks
      .mockResolvedValueOnce({ ...EMPTY_RESULT, tasks: [orgTask] })
      .mockResolvedValueOnce({ ...EMPTY_RESULT, tasks: [spaceTask] })

    await useTrackerStore.getState().loadTasks('wt', undefined)
    await useTrackerStore.getState().loadTasks('wt', 'sp-1')

    const state = useTrackerStore.getState()
    expect(state._listsByKey['wt||']?.tasks).toEqual([orgTask])
    expect(state._listsByKey['wt|sp-1|']?.tasks).toEqual([spaceTask])
  })

  it('patchTaskFromWS 只把新任务加入事件所属组织的缓存', async () => {
    listTasks
      .mockResolvedValueOnce(EMPTY_RESULT)
      .mockResolvedValueOnce(EMPTY_RESULT)

    await useTrackerStore.getState().loadTasks('org-A', undefined)
    await useTrackerStore.getState().loadTasks('org-B', undefined)

    const created = makeTask('tracker-A', 'space-A')
    getTask.mockResolvedValueOnce(created)
    await useTrackerStore.getState().patchTaskFromWS('tracker-A', {
      organizationId: 'org-A',
    })

    const state = useTrackerStore.getState()
    expect(state._listsByKey['org-A||']?.tasks).toEqual([created])
    expect(state._listsByKey['org-B||']?.tasks).toEqual([])
    expect(state.tasks).toEqual([])
  })

  it('patchTaskFromWS 将迁移 Workspace 的任务移出旧 Space 并加入新 Space', async () => {
    const beforeMove = makeTask('tracker-moved', 'space-old')
    const afterMove = {
      ...makeTask('tracker-moved', 'space-new'),
      name: '迁移后的自动化',
    }
    listTasks
      .mockResolvedValueOnce({ ...EMPTY_RESULT, tasks: [beforeMove] })
      .mockResolvedValueOnce(EMPTY_RESULT)

    await useTrackerStore.getState().loadTasks('org-A', 'space-old')
    await useTrackerStore.getState().loadTasks('org-A', 'space-new')

    getTask.mockResolvedValueOnce(afterMove)
    await useTrackerStore.getState().patchTaskFromWS('tracker-moved', {
      organizationId: 'org-A',
    })

    const state = useTrackerStore.getState()
    expect(state._listsByKey['org-A|space-old|']?.tasks).toEqual([])
    expect(state._listsByKey['org-A|space-new|']?.tasks).toEqual([afterMove])
  })

  // ─────────────────────────────────────────────────────────────
  // Wave 2A 新增:动态 retryAfter 冷却(协议总控决策 #6)
  // ─────────────────────────────────────────────────────────────

  it('Wave 2A:ApiError.retryAfter=10 时,store 用 10 秒冷却(动态主路径)', async () => {
    const apiError = new ApiError('请求频率过高,请稍后再试', 429, {
      success: false,
      code: 'RATE_LIMITED',
      message: '请求频率过高,请稍后再试',
      data: null,
      retry_after_seconds: 10,
    }, 10)
    listTasks.mockRejectedValueOnce(apiError)

    await useTrackerStore.getState().loadTasks('wt', 'sp')
    expect(listTasks).toHaveBeenCalledTimes(1)

    // 失败后 store 应记录 _lastFailedCooldownMs = 10 * 1000
    const state = useTrackerStore.getState()
    expect(state.loadError).toBe(true)
    expect(state._lastFailedCooldownMs).toBe(10_000)
    expect(state._lastFailedKey).not.toBeNull()
  })

  it('Wave 2A:ApiError 无 retryAfter(非 429)时,store 用 5_000 ms fallback', async () => {
    // 模拟 5xx 网络错误 / 协议失守:err 是 ApiError 但没 retryAfter
    const apiError = new ApiError('Internal Server Error', 500, {
      success: false,
      code: 'INTERNAL_ERROR',
    })
    listTasks.mockRejectedValueOnce(apiError)

    await useTrackerStore.getState().loadTasks('wt', 'sp')
    expect(listTasks).toHaveBeenCalledTimes(1)

    // fallback 路径:_lastFailedCooldownMs = 5_000
    expect(useTrackerStore.getState()._lastFailedCooldownMs).toBe(5_000)
  })

  it('Wave 2A:普通 Error(非 ApiError)走 fallback 5_000 ms', async () => {
    listTasks.mockRejectedValueOnce(new Error('network error'))
    await useTrackerStore.getState().loadTasks('wt', 'sp')

    expect(useTrackerStore.getState()._lastFailedCooldownMs).toBe(5_000)
  })

  it('Wave 2A:动态冷却生效 — retryAfter=2 时 1.5 秒后仍冷却,2.5 秒后可再请求', async () => {
    vi.useFakeTimers()
    try {
      const apiError = new ApiError('limited', 429, null, 2)
      listTasks.mockRejectedValueOnce(apiError)
      await useTrackerStore.getState().loadTasks('wt', 'sp')
      expect(listTasks).toHaveBeenCalledTimes(1)

      // 1.5 秒后,仍在 2 秒冷却内,同 key 调用应被跳过
      vi.advanceTimersByTime(1_500)
      await useTrackerStore.getState().loadTasks('wt', 'sp')
      expect(listTasks).toHaveBeenCalledTimes(1)

      // 2.5 秒(累计)后,过了冷却,新请求应被发起
      vi.advanceTimersByTime(1_000)
      listTasks.mockResolvedValueOnce(EMPTY_RESULT)
      await useTrackerStore.getState().loadTasks('wt', 'sp')
      expect(listTasks).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
