/**
 * W1.4 / C2: useTrashRecoveryStore 单元测试
 *
 * 覆盖:
 * - markDegraded → isDegraded / getDegraded
 * - 切表隔离(clearForTable)
 * - 用户主动清除单条(clearDegradedRecord)
 * - reset 清空全局
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useTrashRecoveryStore } from '../useTrashRecoveryStore'

describe('useTrashRecoveryStore (W1.4 / C2)', () => {
  beforeEach(() => {
    useTrashRecoveryStore.getState().reset()
  })

  it('markDegraded 后 isDegraded 应返回 true', () => {
    const store = useTrashRecoveryStore.getState()
    store.markDegraded('table-1', ['rec-a', 'rec-b'])

    const after = useTrashRecoveryStore.getState()
    expect(after.isDegraded('table-1', 'rec-a')).toBe(true)
    expect(after.isDegraded('table-1', 'rec-b')).toBe(true)
    expect(after.isDegraded('table-1', 'rec-c')).toBe(false)
  })

  it('getDegraded 应返回完整列表', () => {
    useTrashRecoveryStore.getState().markDegraded('table-1', ['rec-a', 'rec-b'])
    const ids = useTrashRecoveryStore.getState().getDegraded('table-1')
    expect(ids.sort()).toEqual(['rec-a', 'rec-b'])
  })

  it('不同表之间应自动隔离,避免污染', () => {
    const store = useTrashRecoveryStore.getState()
    store.markDegraded('table-1', ['rec-a'])
    store.markDegraded('table-2', ['rec-b'])

    const after = useTrashRecoveryStore.getState()
    expect(after.isDegraded('table-1', 'rec-a')).toBe(true)
    expect(after.isDegraded('table-1', 'rec-b')).toBe(false)
    expect(after.isDegraded('table-2', 'rec-b')).toBe(true)
    expect(after.isDegraded('table-2', 'rec-a')).toBe(false)
  })

  it('clearForTable 只清除指定表,不影响其它表', () => {
    const store = useTrashRecoveryStore.getState()
    store.markDegraded('table-1', ['rec-a'])
    store.markDegraded('table-2', ['rec-b'])
    store.clearForTable('table-1')

    const after = useTrashRecoveryStore.getState()
    expect(after.isDegraded('table-1', 'rec-a')).toBe(false)
    expect(after.isDegraded('table-2', 'rec-b')).toBe(true)
  })

  it('clearDegradedRecord 单条清除', () => {
    const store = useTrashRecoveryStore.getState()
    store.markDegraded('table-1', ['rec-a', 'rec-b'])
    store.clearDegradedRecord('table-1', 'rec-a')

    const after = useTrashRecoveryStore.getState()
    expect(after.isDegraded('table-1', 'rec-a')).toBe(false)
    expect(after.isDegraded('table-1', 'rec-b')).toBe(true)
  })

  it('clearDegradedRecord 清除最后一条时,应删除整张表的 entry', () => {
    const store = useTrashRecoveryStore.getState()
    store.markDegraded('table-1', ['rec-a'])
    store.clearDegradedRecord('table-1', 'rec-a')

    const after = useTrashRecoveryStore.getState()
    expect(after.getDegraded('table-1')).toEqual([])
  })

  it('reset 清空全局所有表', () => {
    const store = useTrashRecoveryStore.getState()
    store.markDegraded('table-1', ['rec-a'])
    store.markDegraded('table-2', ['rec-b'])
    store.reset()

    const after = useTrashRecoveryStore.getState()
    expect(after.isDegraded('table-1', 'rec-a')).toBe(false)
    expect(after.isDegraded('table-2', 'rec-b')).toBe(false)
  })

  it('markDegraded 接收空数组应不变更状态', () => {
    const store = useTrashRecoveryStore.getState()
    store.markDegraded('table-1', [])

    const after = useTrashRecoveryStore.getState()
    expect(after.getDegraded('table-1')).toEqual([])
  })

  it('重复 markDegraded 同 record_id 应去重', () => {
    const store = useTrashRecoveryStore.getState()
    store.markDegraded('table-1', ['rec-a'])
    store.markDegraded('table-1', ['rec-a', 'rec-b'])

    const after = useTrashRecoveryStore.getState()
    const ids = after.getDegraded('table-1')
    expect(ids.length).toBe(2)
    expect(new Set(ids)).toEqual(new Set(['rec-a', 'rec-b']))
  })
})
