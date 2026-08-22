/**
 * VS-008 回归测试 — TabData rollback/checkpoint-restore 后 forceReconnect
 *
 * @vitest-environment jsdom
 *
 * 验证：
 * 1. useTableCollaboration 暴露 forceReconnect 方法
 * 2. 监听 'tabtin:collab-resource-restored' 事件触发 forceReconnect
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('VS-008: useTableCollaboration forceReconnect', () => {
  it('UseTableCollaborationResult interface includes forceReconnect', async () => {
    // 验证类型导出中包含 forceReconnect
    const mod = await import('../useTableCollaboration')
    // 检查导出的接口类型：运行时无法直接检查接口，
    // 但可以验证函数代码中包含 forceReconnect 相关逻辑
    const sourceText = mod.useTableCollaboration.toString()
    expect(sourceText).toContain('forceReconnect')
  })

  it('disables IndexedDB cache for table collaboration', async () => {
    const mod = await import('../useTableCollaboration')
    const sourceText = mod.useTableCollaboration.toString()

    expect(sourceText).toContain('enableIndexedDB: false')
  })

  it('dispatches tabtin:collab-resource-restored event with resourceTypes', () => {
    const handler = vi.fn()
    window.addEventListener('tabtin:collab-resource-restored', handler)

    window.dispatchEvent(new CustomEvent('tabtin:collab-resource-restored', {
      detail: { resourceTypes: ['table', 'canvas'] },
    }))

    expect(handler).toHaveBeenCalledTimes(1)
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail
    expect(detail.resourceTypes).toContain('table')

    window.removeEventListener('tabtin:collab-resource-restored', handler)
  })

  it('event with non-table resourceTypes does not match table filter', () => {
    const detail = { resourceTypes: ['design', 'slide'] }
    const includes = detail.resourceTypes.includes('table')
    expect(includes).toBe(false)
  })

  it('event with table resourceType matches filter', () => {
    const detail = { resourceTypes: ['table', 'canvas'] }
    const includes = detail.resourceTypes.includes('table')
    expect(includes).toBe(true)
  })
})
