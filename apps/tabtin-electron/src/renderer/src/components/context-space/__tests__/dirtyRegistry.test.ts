/**
 * dirtyRegistry 聚合层单元测试（W2.5 T9）
 *
 * 验证：
 * - register / unregister provider 生命周期
 * - collectAllDirty 跨 provider 聚合
 * - collectAllDirty(spaceId) 按 space 过滤
 * - saveDirtyResource / saveAllDirty 路由 + 异常容错
 * - provider 抛错不影响其他 provider 的结果聚合
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  collectAllDirty,
  registerDirtyProvider,
  saveAllDirty,
  saveDirtyResource,
  _getDirtyProviderCount,
  _resetDirtyRegistry,
  type DirtyResource,
  type DirtyResourceProvider,
} from '../dirtyRegistry'

beforeEach(() => {
  _resetDirtyRegistry()
})

const makeResource = (overrides: Partial<DirtyResource> = {}): DirtyResource => ({
  type: 'tabdoc',
  id: 'doc-1',
  spaceId: 'sp-1',
  title: 'Doc 1',
  ...overrides,
})

const makeProvider = (overrides: Partial<DirtyResourceProvider> = {}): DirtyResourceProvider => ({
  type: 'tabdoc',
  collect: vi.fn(() => []),
  save: vi.fn(async () => true),
  ...overrides,
})

describe('registerDirtyProvider', () => {
  it('注册后 _getDirtyProviderCount 增加', () => {
    expect(_getDirtyProviderCount()).toBe(0)
    registerDirtyProvider(makeProvider())
    expect(_getDirtyProviderCount()).toBe(1)
  })

  it('返回的 unregister 能清理自己', () => {
    const unregister = registerDirtyProvider(makeProvider())
    expect(_getDirtyProviderCount()).toBe(1)
    unregister()
    expect(_getDirtyProviderCount()).toBe(0)
  })

  it('同 type 重复注册时新值覆盖旧值，且旧 unregister 不误删新 entry', () => {
    const oldProvider = makeProvider({ type: 'tabdoc', collect: vi.fn(() => [makeResource({ title: 'old' })]) })
    const newProvider = makeProvider({ type: 'tabdoc', collect: vi.fn(() => [makeResource({ title: 'new' })]) })
    const unregisterOld = registerDirtyProvider(oldProvider)
    registerDirtyProvider(newProvider)

    expect(_getDirtyProviderCount()).toBe(1)
    expect(collectAllDirty()[0]?.title).toBe('new')

    unregisterOld()
    expect(_getDirtyProviderCount()).toBe(1)
    expect(collectAllDirty()[0]?.title).toBe('new')
  })

  it('空 type 返回 noop unregister，不入表', () => {
    const unregister = registerDirtyProvider(makeProvider({ type: '' }))
    expect(_getDirtyProviderCount()).toBe(0)
    unregister()
  })
})

describe('collectAllDirty', () => {
  it('无 provider 时返回空数组', () => {
    expect(collectAllDirty()).toEqual([])
  })

  it('多个 provider 的 dirty 资源按注册顺序拼接', () => {
    registerDirtyProvider(makeProvider({
      type: 'tabdoc',
      collect: vi.fn(() => [makeResource({ id: 'doc-1' })]),
    }))
    registerDirtyProvider(makeProvider({
      type: 'tabslide',
      collect: vi.fn(() => [makeResource({ type: 'tabslide', id: 'slide-1', title: 'S1' })]),
    }))

    const result = collectAllDirty()
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'tabdoc', id: 'doc-1' })
    expect(result[1]).toMatchObject({ type: 'tabslide', id: 'slide-1' })
  })

  it('spaceId 过滤透传给各 provider', () => {
    const collect = vi.fn(() => [])
    registerDirtyProvider(makeProvider({ collect }))

    collectAllDirty('sp-target')
    expect(collect).toHaveBeenCalledWith('sp-target')

    collectAllDirty()
    expect(collect).toHaveBeenLastCalledWith(undefined)
  })

  it('单 provider 抛错时不影响其他 provider；抛错的 provider 会插入 fallback 资源（P1 修复）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerDirtyProvider(makeProvider({
      type: 'tabdoc',
      collect: vi.fn(() => { throw new Error('boom') }),
    }))
    registerDirtyProvider(makeProvider({
      type: 'tabslide',
      collect: vi.fn(() => [makeResource({ type: 'tabslide', id: 's1', title: 'S1' })]),
    }))

    const result = collectAllDirty()
    // P1 修复：抛错的 provider 不再静默消失；应插入 fallback resource（id 以 __collect_failed__: 开头）
    // 让上层弹对话框迫使用户感知；tabslide 正常资源也保留
    expect(result).toHaveLength(2)
    const tabdocFallback = result.find(r => r.type === 'tabdoc' && r.id.startsWith('__collect_failed__:'))
    expect(tabdocFallback).toBeDefined()
    expect(tabdocFallback?.title).toContain('采样失败')
    const slideOk = result.find(r => r.type === 'tabslide')
    expect(slideOk?.id).toBe('s1')
    expect(slideOk?.title).toBe('S1')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('saveDirtyResource', () => {
  it('未注册的 type 返回 false 且打印 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = await saveDirtyResource({ type: 'unknown', id: 'x' })
    expect(ok).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('成功 provider 返回 true', async () => {
    registerDirtyProvider(makeProvider({ save: vi.fn(async () => true) }))
    expect(await saveDirtyResource({ type: 'tabdoc', id: 'doc-1' })).toBe(true)
  })

  it('失败 provider 返回 false', async () => {
    registerDirtyProvider(makeProvider({ save: vi.fn(async () => false) }))
    expect(await saveDirtyResource({ type: 'tabdoc', id: 'doc-1' })).toBe(false)
  })

  it('provider.save 抛错时返回 false（不向上传播）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerDirtyProvider(makeProvider({ save: vi.fn(async () => { throw new Error('boom') }) }))
    expect(await saveDirtyResource({ type: 'tabdoc', id: 'doc-1' })).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('saveAllDirty', () => {
  it('串行保存，progress 回调按顺序触发', async () => {
    const calls: string[] = []
    registerDirtyProvider(makeProvider({
      save: vi.fn(async (id) => {
        calls.push(id)
        return true
      }),
    }))

    const resources = [
      makeResource({ id: 'doc-1' }),
      makeResource({ id: 'doc-2' }),
      makeResource({ id: 'doc-3' }),
    ]
    const progressEvents: Array<{ done: number; total: number; id: string }> = []
    const results = await saveAllDirty(resources, (done, total, current) => {
      progressEvents.push({ done, total, id: current.id })
    })

    expect(calls).toEqual(['doc-1', 'doc-2', 'doc-3'])
    expect(results).toHaveLength(3)
    expect(results.every(r => r.ok)).toBe(true)
    // progress 在每条 save 之前触发：done=0/1/2, total 始终为 3
    expect(progressEvents).toEqual([
      { done: 0, total: 3, id: 'doc-1' },
      { done: 1, total: 3, id: 'doc-2' },
      { done: 2, total: 3, id: 'doc-3' },
    ])
  })

  it('部分失败时仍继续保存其余，返回每条结果', async () => {
    let callCount = 0
    registerDirtyProvider(makeProvider({
      save: vi.fn(async (id) => {
        callCount++
        return id !== 'doc-2'
      }),
    }))

    const results = await saveAllDirty([
      makeResource({ id: 'doc-1' }),
      makeResource({ id: 'doc-2' }),
      makeResource({ id: 'doc-3' }),
    ])

    expect(callCount).toBe(3)
    expect(results.map(r => r.ok)).toEqual([true, false, true])
  })

  it('空列表立即返回空数组', async () => {
    const results = await saveAllDirty([])
    expect(results).toEqual([])
  })
})
