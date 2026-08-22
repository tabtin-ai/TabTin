/**
 * tabdocDirtyRegistry 单元测试
 *
 * 验证：
 * - register / unregister 生命周期
 * - source 抛错的容错
 * - shouldConfirmTabDocClose 的判定规则覆盖所有 SaveState
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerTabDocDirtySource,
  getTabDocDirtySnapshot,
  saveTabDoc,
  shouldConfirmTabDocClose,
  _getTabDocDirtyRegistrySize,
  _resetTabDocDirtyRegistry,
  type TabDocDirtySnapshot,
} from '../tabdocDirtyRegistry'

beforeEach(() => {
  _resetTabDocDirtyRegistry()
})

const baseSnapshot = (overrides: Partial<TabDocDirtySnapshot> = {}): TabDocDirtySnapshot => ({
  saveState: 'idle',
  isDirty: false,
  isCollaborating: false,
  title: 'doc-1',
  ...overrides,
})

describe('registerTabDocDirtySource / getTabDocDirtySnapshot', () => {
  it('未注册时 getTabDocDirtySnapshot 返回 null', () => {
    expect(getTabDocDirtySnapshot('doc-1')).toBeNull()
    expect(_getTabDocDirtyRegistrySize()).toBe(0)
  })

  it('注册后可读到当前 snapshot', () => {
    const source = vi.fn(() => baseSnapshot({ saveState: 'dirty' }))
    registerTabDocDirtySource('doc-1', source, async () => true)

    const snap = getTabDocDirtySnapshot('doc-1')
    expect(snap).toEqual({
      saveState: 'dirty',
      isDirty: false,
      isCollaborating: false,
      title: 'doc-1',
    })
    expect(source).toHaveBeenCalledTimes(1)
    expect(_getTabDocDirtyRegistrySize()).toBe(1)
  })

  it('返回的 unregister 函数能清理自己', () => {
    const source = vi.fn(() => baseSnapshot())
    const unregister = registerTabDocDirtySource('doc-1', source, async () => true)
    unregister()

    expect(getTabDocDirtySnapshot('doc-1')).toBeNull()
    expect(_getTabDocDirtyRegistrySize()).toBe(0)
  })

  it('重复注册同一 documentId 时新值覆盖旧值', () => {
    const oldSource = vi.fn(() => baseSnapshot({ title: 'old' }))
    const newSource = vi.fn(() => baseSnapshot({ title: 'new' }))
    registerTabDocDirtySource('doc-1', oldSource, async () => true)
    registerTabDocDirtySource('doc-1', newSource, async () => true)

    expect(getTabDocDirtySnapshot('doc-1')?.title).toBe('new')
    expect(_getTabDocDirtyRegistrySize()).toBe(1)
  })

  it('被覆盖后旧 entry 的 unregister 不会误删新 entry', () => {
    const oldSource = vi.fn(() => baseSnapshot({ title: 'old' }))
    const newSource = vi.fn(() => baseSnapshot({ title: 'new' }))
    const unregisterOld = registerTabDocDirtySource('doc-1', oldSource, async () => true)
    registerTabDocDirtySource('doc-1', newSource, async () => true)
    unregisterOld()

    expect(getTabDocDirtySnapshot('doc-1')?.title).toBe('new')
    expect(_getTabDocDirtyRegistrySize()).toBe(1)
  })

  it('source 抛错时返回保守 fallback snapshot（saveState=error + isDirty=true）以强制弹窗', () => {
    const source = vi.fn(() => {
      throw new Error('boom')
    })
    registerTabDocDirtySource('doc-1', source, async () => true)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const snap = getTabDocDirtySnapshot('doc-1')
    expect(snap).not.toBeNull()
    expect(snap).toEqual({
      saveState: 'error',
      isDirty: true,
      isCollaborating: false,
      title: null,
    })
    // shouldConfirmTabDocClose 拿到这个 fallback 应该决定要弹窗
    expect(shouldConfirmTabDocClose(snap)).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('未注册（null）与采样失败（fallback）应该可被 shouldConfirmTabDocClose 区分', () => {
    expect(getTabDocDirtySnapshot('unregistered')).toBeNull()
    expect(shouldConfirmTabDocClose(null)).toBe(false)
  })

  it('空 documentId 注册时返回 noop unregister，不入表', () => {
    const unregister = registerTabDocDirtySource('', vi.fn(), async () => true)
    expect(_getTabDocDirtyRegistrySize()).toBe(0)
    unregister()
  })
})

describe('saveTabDoc', () => {
  it('未注册时返回 false', async () => {
    expect(await saveTabDoc('doc-1')).toBe(false)
  })

  it('saver 成功返回 true 时透传 true', async () => {
    registerTabDocDirtySource('doc-1', () => baseSnapshot(), async () => true)
    expect(await saveTabDoc('doc-1')).toBe(true)
  })

  it('saver 返回 false 时透传 false', async () => {
    registerTabDocDirtySource('doc-1', () => baseSnapshot(), async () => false)
    expect(await saveTabDoc('doc-1')).toBe(false)
  })

  it('saver 抛错时返回 false（不向上传播异常）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerTabDocDirtySource('doc-1', () => baseSnapshot(), async () => {
      throw new Error('flush failed')
    })
    expect(await saveTabDoc('doc-1')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('shouldConfirmTabDocClose', () => {
  it('snapshot 为 null 时不需要确认', () => {
    expect(shouldConfirmTabDocClose(null)).toBe(false)
  })

  it('idle / saved + 非 dirty → 不需要确认', () => {
    expect(shouldConfirmTabDocClose(baseSnapshot({ saveState: 'idle' }))).toBe(false)
    expect(shouldConfirmTabDocClose(baseSnapshot({ saveState: 'saved' }))).toBe(false)
  })

  it('dirty 状态需要确认', () => {
    expect(shouldConfirmTabDocClose(baseSnapshot({ saveState: 'dirty' }))).toBe(true)
  })

  it('saving 状态需要确认（避免在 flush 中途丢数据）', () => {
    expect(shouldConfirmTabDocClose(baseSnapshot({ saveState: 'saving' }))).toBe(true)
  })

  it('error 状态需要确认（保存失败时关闭尤其危险）', () => {
    expect(shouldConfirmTabDocClose(baseSnapshot({ saveState: 'error' }))).toBe(true)
  })

  it('saveState=idle 但 controller.isDirty()=true 时仍需确认（防御性兜底）', () => {
    expect(shouldConfirmTabDocClose(baseSnapshot({ saveState: 'idle', isDirty: true }))).toBe(true)
  })

  it('isCollaborating 不影响判定（dirty 仍然 dirty）', () => {
    expect(shouldConfirmTabDocClose(baseSnapshot({ saveState: 'idle', isCollaborating: true }))).toBe(false)
    expect(shouldConfirmTabDocClose(baseSnapshot({ saveState: 'dirty', isCollaborating: true }))).toBe(true)
  })
})
