/**
 * tabdocCloseConfirm 队列单元测试
 *
 * 锁定 W2 T5 三视角 Review 修复的 FIFO 队列契约：
 * - 同一时刻只展示一个对话框
 * - settle 后立即从队列取下一个
 * - 多个并发 request 不会互相 cancel
 *
 * 这一行为与 useCloseHandlers.batchClose 的 Promise.all 并发模式协同，
 * 保证用户对每个 dirty tabdoc 都有机会做明确选择，而不是被静默丢弃。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  requestTabDocCloseConfirm,
  settleTabDocCloseConfirm,
  useTabDocCloseConfirmStore,
  _resetTabDocCloseConfirm,
  _getTabDocCloseConfirmQueueSize,
  type TabDocCloseChoice,
} from '../tabdocCloseConfirm'

beforeEach(() => {
  _resetTabDocCloseConfirm()
})

describe('requestTabDocCloseConfirm 队列', () => {
  it('单个请求：立即展示并 settle', async () => {
    const promise = requestTabDocCloseConfirm('doc-A')

    expect(useTabDocCloseConfirmStore.getState().open).toBe(true)
    expect(useTabDocCloseConfirmStore.getState().displayName).toBe('doc-A')
    expect(useTabDocCloseConfirmStore.getState().pendingCount).toBe(1)
    expect(_getTabDocCloseConfirmQueueSize()).toBe(1)

    settleTabDocCloseConfirm('discard')

    await expect(promise).resolves.toBe('discard')
    expect(useTabDocCloseConfirmStore.getState().open).toBe(false)
    expect(useTabDocCloseConfirmStore.getState().pendingCount).toBe(0)
    expect(_getTabDocCloseConfirmQueueSize()).toBe(0)
  })

  it('两个并发请求：FIFO 串行展示，互不 cancel', async () => {
    const choices: Array<{ name: string; choice: TabDocCloseChoice }> = []

    const p1 = requestTabDocCloseConfirm('doc-A').then((c) =>
      choices.push({ name: 'A', choice: c }),
    )
    const p2 = requestTabDocCloseConfirm('doc-B').then((c) =>
      choices.push({ name: 'B', choice: c }),
    )

    // 第一个对话框正在展示，第二个已入队
    expect(useTabDocCloseConfirmStore.getState().displayName).toBe('doc-A')
    expect(useTabDocCloseConfirmStore.getState().pendingCount).toBe(2)
    expect(_getTabDocCloseConfirmQueueSize()).toBe(2)

    // 用户对第一个选 cancel
    settleTabDocCloseConfirm('cancel')
    await p1

    // 第二个应自动展示
    expect(useTabDocCloseConfirmStore.getState().open).toBe(true)
    expect(useTabDocCloseConfirmStore.getState().displayName).toBe('doc-B')
    expect(useTabDocCloseConfirmStore.getState().pendingCount).toBe(1)

    // 用户对第二个选 save
    settleTabDocCloseConfirm('save')
    await p2

    expect(choices).toEqual([
      { name: 'A', choice: 'cancel' },
      { name: 'B', choice: 'save' },
    ])
    expect(useTabDocCloseConfirmStore.getState().open).toBe(false)
    expect(_getTabDocCloseConfirmQueueSize()).toBe(0)
  })

  it('三个并发请求 + 各自不同选择：每个都被精确处置', async () => {
    const results: TabDocCloseChoice[] = []

    const promises = [
      requestTabDocCloseConfirm('A').then((c) => {
        results.push(c)
      }),
      requestTabDocCloseConfirm('B').then((c) => {
        results.push(c)
      }),
      requestTabDocCloseConfirm('C').then((c) => {
        results.push(c)
      }),
    ]

    expect(useTabDocCloseConfirmStore.getState().displayName).toBe('A')
    expect(useTabDocCloseConfirmStore.getState().pendingCount).toBe(3)

    settleTabDocCloseConfirm('discard')
    await promises[0]
    expect(useTabDocCloseConfirmStore.getState().displayName).toBe('B')
    expect(useTabDocCloseConfirmStore.getState().pendingCount).toBe(2)

    settleTabDocCloseConfirm('cancel')
    await promises[1]
    expect(useTabDocCloseConfirmStore.getState().displayName).toBe('C')
    expect(useTabDocCloseConfirmStore.getState().pendingCount).toBe(1)

    settleTabDocCloseConfirm('save')
    await promises[2]

    expect(results).toEqual(['discard', 'cancel', 'save'])
    expect(useTabDocCloseConfirmStore.getState().open).toBe(false)
  })

  it('settle 在没有 active 请求时是 no-op', () => {
    expect(() => settleTabDocCloseConfirm('cancel')).not.toThrow()
    expect(useTabDocCloseConfirmStore.getState().open).toBe(false)
  })

  it('_reset 清空队列与 active', async () => {
    const p1 = requestTabDocCloseConfirm('A')
    requestTabDocCloseConfirm('B')
    expect(_getTabDocCloseConfirmQueueSize()).toBe(2)

    _resetTabDocCloseConfirm()
    expect(_getTabDocCloseConfirmQueueSize()).toBe(0)
    expect(useTabDocCloseConfirmStore.getState().open).toBe(false)

    // reset 后未 settle 的 promise 不会自动 resolve（它们悬空了），
    // 但下一次 request 应该能正常工作
    settleTabDocCloseConfirm('cancel')
    const p3 = requestTabDocCloseConfirm('C')
    expect(useTabDocCloseConfirmStore.getState().displayName).toBe('C')
    settleTabDocCloseConfirm('discard')
    await expect(p3).resolves.toBe('discard')

    // p1 因 reset 已无法被 settle，留作悬空 Promise；reset 是测试 helper，
    // 生产代码不会调用。这里仅断言"reset 不影响后续可用性"。
    void p1
  })
})
