/**
 * dirtyExitConfirmStore 单元测试（W2.5 T9）
 *
 * 验证：
 * - requestDirtyExitConfirm + settle 的 Promise 桥接
 * - 空 resources 列表立即 resolve('discard')
 * - 重复 request 期间复用同一 active resolve
 * - markSaving / setProgress 阶段流转
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  markDirtyExitConfirmSaving,
  requestDirtyExitConfirm,
  setDirtyExitConfirmProgress,
  settleDirtyExitConfirm,
  useDirtyExitConfirmStore,
  _isDirtyExitConfirmActive,
  _resetDirtyExitConfirm,
} from '../dirtyExitConfirmStore'

beforeEach(() => {
  _resetDirtyExitConfirm()
})

const mkResource = (id = 'doc-1') => ({
  type: 'tabdoc',
  id,
  spaceId: 'sp-1',
  title: `T-${id}`,
})

describe('requestDirtyExitConfirm', () => {
  it('空 resources 立即 resolve discard 且不进入 active 状态', async () => {
    const result = await requestDirtyExitConfirm({ resources: [], reason: 'app-quit' })
    expect(result).toEqual({ choice: 'discard' })
    expect(_isDirtyExitConfirmActive()).toBe(false)
    expect(useDirtyExitConfirmStore.getState().open).toBe(false)
  })

  it('非空 resources 进入 awaiting 状态等用户选择', async () => {
    const promise = requestDirtyExitConfirm({
      resources: [mkResource('doc-1'), mkResource('doc-2')],
      reason: 'app-quit',
    })

    const state = useDirtyExitConfirmStore.getState()
    expect(state.open).toBe(true)
    expect(state.phase).toBe('awaiting')
    expect(state.resources).toHaveLength(2)
    expect(_isDirtyExitConfirmActive()).toBe(true)

    settleDirtyExitConfirm('cancel')
    expect(await promise).toEqual({ choice: 'cancel' })
    expect(useDirtyExitConfirmStore.getState().open).toBe(false)
    expect(_isDirtyExitConfirmActive()).toBe(false)
  })

  it('discard 选择 resolve choice="discard"', async () => {
    const promise = requestDirtyExitConfirm({ resources: [mkResource()], reason: 'app-quit' })
    settleDirtyExitConfirm('discard')
    expect(await promise).toEqual({ choice: 'discard' })
  })

  it('save-all 选择带 saveResults 透传', async () => {
    const promise = requestDirtyExitConfirm({ resources: [mkResource()], reason: 'app-quit' })
    const saveResults = [{ resource: mkResource(), ok: true }]
    settleDirtyExitConfirm('save-all', saveResults)
    expect(await promise).toEqual({ choice: 'save-all', saveResults })
  })

  it('reason="space-delete" 时 spaceName 入 store', async () => {
    const promise = requestDirtyExitConfirm({
      resources: [mkResource()],
      reason: 'space-delete',
      spaceName: 'My Space',
    })
    expect(useDirtyExitConfirmStore.getState().spaceName).toBe('My Space')
    expect(useDirtyExitConfirmStore.getState().reason).toBe('space-delete')
    settleDirtyExitConfirm('cancel')
    await promise
  })

  it('已有对话框 active 时第二次 request 与第一次共享结果', async () => {
    const p1 = requestDirtyExitConfirm({ resources: [mkResource('doc-1')], reason: 'app-quit' })
    const p2 = requestDirtyExitConfirm({ resources: [mkResource('doc-2')], reason: 'space-delete' })

    settleDirtyExitConfirm('discard')
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.choice).toBe('discard')
    expect(r2.choice).toBe('discard')
  })

  it('settle 在没有 active 时是 no-op，不抛错', () => {
    expect(() => settleDirtyExitConfirm('cancel')).not.toThrow()
  })
})

describe('阶段流转', () => {
  it('markDirtyExitConfirmSaving 把 phase 切到 saving', async () => {
    const promise = requestDirtyExitConfirm({ resources: [mkResource()], reason: 'app-quit' })
    expect(useDirtyExitConfirmStore.getState().phase).toBe('awaiting')

    markDirtyExitConfirmSaving()
    expect(useDirtyExitConfirmStore.getState().phase).toBe('saving')

    settleDirtyExitConfirm('save-all', [])
    await promise
  })

  it('setProgress 仅在 saving phase 生效', () => {
    requestDirtyExitConfirm({ resources: [mkResource()], reason: 'app-quit' })
    setDirtyExitConfirmProgress({ done: 1, total: 3, currentTitle: 'X' })
    // 当前是 awaiting phase，progress 应被忽略
    expect(useDirtyExitConfirmStore.getState().progress).toBeNull()

    markDirtyExitConfirmSaving()
    setDirtyExitConfirmProgress({ done: 1, total: 3, currentTitle: 'X' })
    expect(useDirtyExitConfirmStore.getState().progress).toEqual({ done: 1, total: 3, currentTitle: 'X' })
    settleDirtyExitConfirm('cancel')
  })
})

describe('store 选择器订阅', () => {
  it('settle 后 store 重置为 idle', async () => {
    const promise = requestDirtyExitConfirm({
      resources: [mkResource()],
      reason: 'space-delete',
      spaceName: 'S1',
    })
    settleDirtyExitConfirm('discard')
    await promise

    const state = useDirtyExitConfirmStore.getState()
    expect(state.open).toBe(false)
    expect(state.resources).toEqual([])
    expect(state.spaceName).toBeNull()
    expect(state.phase).toBe('idle')
  })

  it('Listener 收到 phase 变更', async () => {
    const phases: string[] = []
    const unsubscribe = useDirtyExitConfirmStore.subscribe((state) => {
      phases.push(state.phase)
    })

    const promise = requestDirtyExitConfirm({ resources: [mkResource()], reason: 'app-quit' })
    markDirtyExitConfirmSaving()
    settleDirtyExitConfirm('save-all', [])
    await promise

    expect(phases).toContain('awaiting')
    expect(phases).toContain('saving')
    expect(phases).toContain('idle')
    unsubscribe()
  })
})
