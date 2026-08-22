/**
 * tabdocDirtyRegistry.collectAllDirty 测试（W2.5 T9 扩展）
 *
 * 验证：
 * - collectAllDirty() 返回所有 dirty entries
 * - shouldConfirm 为 false 的 entry 不入结果
 * - spaceId 过滤工作正常
 * - source 抛错的 entry 走保守 fallback 仍被收录
 * - title 字段处理（null → 空字符串）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  collectAllDirty,
  registerTabDocDirtySource,
  _resetTabDocDirtyRegistry,
  type TabDocDirtySnapshot,
} from '../tabdocDirtyRegistry'

beforeEach(() => {
  _resetTabDocDirtyRegistry()
})

const cleanSnap = (overrides: Partial<TabDocDirtySnapshot> = {}): TabDocDirtySnapshot => ({
  saveState: 'saved',
  isDirty: false,
  isCollaborating: false,
  title: 'Doc',
  ...overrides,
})

const dirtySnap = (overrides: Partial<TabDocDirtySnapshot> = {}): TabDocDirtySnapshot => ({
  saveState: 'dirty',
  isDirty: false,
  isCollaborating: false,
  title: 'Doc',
  ...overrides,
})

describe('collectAllDirty', () => {
  it('未注册时返回空数组', () => {
    expect(collectAllDirty()).toEqual([])
  })

  it('已注册但都不 dirty 时返回空数组', () => {
    registerTabDocDirtySource('doc-1', () => cleanSnap(), async () => true, 'sp-1')
    registerTabDocDirtySource('doc-2', () => cleanSnap(), async () => true, 'sp-1')
    expect(collectAllDirty()).toEqual([])
  })

  it('返回所有 dirty 文档（不传 spaceId）', () => {
    registerTabDocDirtySource('doc-1', () => dirtySnap({ title: 'A' }), async () => true, 'sp-1')
    registerTabDocDirtySource('doc-2', () => cleanSnap(), async () => true, 'sp-1')
    registerTabDocDirtySource('doc-3', () => dirtySnap({ saveState: 'error', title: 'C' }), async () => true, 'sp-2')

    const result = collectAllDirty()
    expect(result).toHaveLength(2)
    const ids = result.map(r => r.documentId).sort()
    expect(ids).toEqual(['doc-1', 'doc-3'])
  })

  it('spaceId 过滤只返回该 space 下的 dirty 文档', () => {
    registerTabDocDirtySource('doc-1', () => dirtySnap({ title: 'A' }), async () => true, 'sp-1')
    registerTabDocDirtySource('doc-2', () => dirtySnap({ title: 'B' }), async () => true, 'sp-2')

    expect(collectAllDirty('sp-1').map(r => r.documentId)).toEqual(['doc-1'])
    expect(collectAllDirty('sp-2').map(r => r.documentId)).toEqual(['doc-2'])
    expect(collectAllDirty('sp-other')).toEqual([])
  })

  it('注册时 spaceId=null 的 entry 永远不被 spaceId 过滤命中（保守策略）', () => {
    registerTabDocDirtySource('doc-1', () => dirtySnap(), async () => true, null)

    expect(collectAllDirty()).toHaveLength(1)
    expect(collectAllDirty('sp-1')).toEqual([])
    expect(collectAllDirty('any')).toEqual([])
  })

  it('source 抛错的 entry 走保守 fallback 仍被收录（数据安全）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerTabDocDirtySource('doc-1', () => { throw new Error('boom') }, async () => true, 'sp-1')

    const result = collectAllDirty()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      documentId: 'doc-1',
      saveState: 'error',
      title: '',
    })
    warnSpy.mockRestore()
  })

  it('title 为 null 时序列化为空字符串', () => {
    registerTabDocDirtySource('doc-1', () => dirtySnap({ title: null }), async () => true, 'sp-1')
    expect(collectAllDirty()[0]?.title).toBe('')
  })

  it('包含 isCollaborating 字段', () => {
    registerTabDocDirtySource('doc-1', () => dirtySnap({ isCollaborating: true }), async () => true, 'sp-1')
    expect(collectAllDirty()[0]?.isCollaborating).toBe(true)
  })

  it('saving / error 状态都被识别为需确认', () => {
    registerTabDocDirtySource('doc-saving', () => dirtySnap({ saveState: 'saving' }), async () => true, 'sp-1')
    registerTabDocDirtySource('doc-error', () => dirtySnap({ saveState: 'error' }), async () => true, 'sp-1')

    const ids = collectAllDirty().map(r => r.documentId).sort()
    expect(ids).toEqual(['doc-error', 'doc-saving'])
  })
})
