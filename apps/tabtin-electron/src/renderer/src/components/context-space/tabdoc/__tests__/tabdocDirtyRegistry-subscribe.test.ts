/**
 * tabdocDirtyRegistry · subscribe / notify 接口回归测试（Wave 3 T6 新增）
 *
 * 独立文件，避免与同事 Agent 同时维护 `tabdocDirtyRegistry.test.ts` 时互相覆盖。
 *
 * 验证：
 *   - 订阅本身不触发 listener（订阅方自己用 getTabDocDirtySnapshot 拿初始值）
 *   - register / unregister 自动 emit
 *   - notifyTabDocDirty 主动 emit
 *   - 多 listener 互不干扰
 *   - listener 抛错被 warn 隔离
 *   - 空 documentId 订阅 / 通知都是 noop
 *   - _reset 同时清理 listener 防跨用例污染
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerTabDocDirtySource,
  notifyTabDocDirty,
  subscribeTabDocDirty,
  _resetTabDocDirtyRegistry,
  type TabDocDirtySnapshot,
} from '../tabdocDirtyRegistry'

const baseSnapshot = (overrides: Partial<TabDocDirtySnapshot> = {}): TabDocDirtySnapshot => ({
  saveState: 'idle',
  isDirty: false,
  isCollaborating: false,
  title: 'Doc',
  ...overrides,
})

beforeEach(() => {
  _resetTabDocDirtyRegistry()
})

describe('subscribeTabDocDirty / notifyTabDocDirty', () => {
  it('订阅本身不触发 listener（订阅方负责拿初始值）', () => {
    const listener = vi.fn()
    subscribeTabDocDirty('doc-1', listener)
    expect(listener).not.toHaveBeenCalled()
  })

  it('register 后自动触发一次（snapshot 非 null）', () => {
    const listener = vi.fn()
    subscribeTabDocDirty('doc-1', listener)

    registerTabDocDirtySource(
      'doc-1',
      () => baseSnapshot({ saveState: 'dirty' }),
      async () => true,
    )
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ saveState: 'dirty' }))
  })

  it('unregister 自动触发一次（snapshot=null）', () => {
    const listener = vi.fn()
    subscribeTabDocDirty('doc-1', listener)
    const unregister = registerTabDocDirtySource(
      'doc-1',
      () => baseSnapshot(),
      async () => true,
    )
    listener.mockClear()
    unregister()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(null)
  })

  it('notifyTabDocDirty 主动触发：所有 listener 都收到当前 snapshot', () => {
    let currentState: TabDocDirtySnapshot['saveState'] = 'idle'
    registerTabDocDirtySource(
      'doc-1',
      () => baseSnapshot({ saveState: currentState }),
      async () => true,
    )
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    subscribeTabDocDirty('doc-1', listenerA)
    subscribeTabDocDirty('doc-1', listenerB)

    currentState = 'dirty'
    notifyTabDocDirty('doc-1')
    expect(listenerA).toHaveBeenCalledWith(expect.objectContaining({ saveState: 'dirty' }))
    expect(listenerB).toHaveBeenCalledWith(expect.objectContaining({ saveState: 'dirty' }))

    currentState = 'saved'
    notifyTabDocDirty('doc-1')
    expect(listenerA).toHaveBeenCalledTimes(2)
    expect(listenerB).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe 后该 listener 不再被通知（其他 listener 不受影响）', () => {
    registerTabDocDirtySource('doc-1', () => baseSnapshot(), async () => true)
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    const unsubA = subscribeTabDocDirty('doc-1', listenerA)
    subscribeTabDocDirty('doc-1', listenerB)

    listenerA.mockClear()
    listenerB.mockClear()
    unsubA()
    notifyTabDocDirty('doc-1')

    expect(listenerA).not.toHaveBeenCalled()
    expect(listenerB).toHaveBeenCalledTimes(1)
  })

  it('某 listener 抛错不影响其他 listener（隔离 + warn）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerTabDocDirtySource(
      'doc-1',
      () => baseSnapshot({ saveState: 'dirty' }),
      async () => true,
    )
    const goodListener = vi.fn()
    subscribeTabDocDirty('doc-1', () => {
      throw new Error('listener boom')
    })
    subscribeTabDocDirty('doc-1', goodListener)

    notifyTabDocDirty('doc-1')

    expect(goodListener).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('空 documentId 订阅 → noop unsubscribe + 通知不触发', () => {
    const listener = vi.fn()
    const unsub = subscribeTabDocDirty('', listener)
    notifyTabDocDirty('')
    expect(listener).not.toHaveBeenCalled()
    expect(() => unsub()).not.toThrow()
  })

  it('无订阅者时 notifyTabDocDirty 是 no-op（不调 source）', () => {
    const source = vi.fn(() => baseSnapshot())
    registerTabDocDirtySource('doc-1', source, async () => true)
    source.mockClear()
    notifyTabDocDirty('doc-1')
    expect(source).not.toHaveBeenCalled()
  })

  it('_resetTabDocDirtyRegistry 同时清理 listener（避免跨用例污染）', () => {
    const listener = vi.fn()
    subscribeTabDocDirty('doc-1', listener)
    _resetTabDocDirtyRegistry()
    notifyTabDocDirty('doc-1')
    expect(listener).not.toHaveBeenCalled()
  })
})
