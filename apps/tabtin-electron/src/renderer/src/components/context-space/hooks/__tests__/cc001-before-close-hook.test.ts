/**
 * CC-001 回归测试：beforeClose 钩子拦截关闭能力
 *
 * 验证：
 * 1. ContextRegistry.dispatchBeforeClose 正确调用 handler.beforeClose
 * 2. handler 无 beforeClose 时默认返回 true（允许关闭）
 * 3. useCloseHandlers.handleCloseItem 在 beforeClose 返回 false 时不执行关闭
 * 4. useCloseHandlers.handleCloseItem 在 beforeClose 返回 true 时正常关闭
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContextRegistry } from '../../registry/ContextRegistry'
import type { ContextItem, ContainerContext, ContextTypeHandler } from '../../registry/types'

// ── Fixtures ──

function makeItem(type = 'test-type', id = 'test-id'): ContextItem {
  return { type, id, tabKey: `${type}:${id}` as ContextItem['tabKey'] }
}

function makeContainerCtx(): ContainerContext {
  return {
    spaceId: 'sp-1',
    closeBrowserView: vi.fn(),
  }
}

// ── ContextRegistry.dispatchBeforeClose 单元测试 ──

describe('ContextRegistry.dispatchBeforeClose', () => {
  let registry: ContextRegistry

  beforeEach(() => {
    registry = new ContextRegistry()
  })

  it('handler 未声明 beforeClose 时返回 true（默认允许关闭）', async () => {
    const handler: ContextTypeHandler = { type: 'test-type' }
    registry.register(handler)

    const result = await registry.dispatchBeforeClose(makeItem(), makeContainerCtx())
    expect(result).toBe(true)
  })

  it('handler 未注册时返回 true（默认允许关闭）', async () => {
    const result = await registry.dispatchBeforeClose(makeItem('unknown'), makeContainerCtx())
    expect(result).toBe(true)
  })

  it('handler.beforeClose 返回 true 时 dispatchBeforeClose 返回 true', async () => {
    const beforeClose = vi.fn().mockResolvedValue(true)
    const handler: ContextTypeHandler = { type: 'test-type', beforeClose }
    registry.register(handler)

    const item = makeItem()
    const ctx = makeContainerCtx()
    const result = await registry.dispatchBeforeClose(item, ctx)

    expect(result).toBe(true)
    expect(beforeClose).toHaveBeenCalledWith(item, ctx)
  })

  it('handler.beforeClose 返回 false 时 dispatchBeforeClose 返回 false', async () => {
    const beforeClose = vi.fn().mockResolvedValue(false)
    const handler: ContextTypeHandler = { type: 'test-type', beforeClose }
    registry.register(handler)

    const result = await registry.dispatchBeforeClose(makeItem(), makeContainerCtx())
    expect(result).toBe(false)
  })

  it('beforeClose 抛出异常时 dispatchBeforeClose 向上传播', async () => {
    const beforeClose = vi.fn().mockRejectedValue(new Error('dialog-error'))
    const handler: ContextTypeHandler = { type: 'test-type', beforeClose }
    registry.register(handler)

    await expect(
      registry.dispatchBeforeClose(makeItem(), makeContainerCtx())
    ).rejects.toThrow('dialog-error')
  })
})

// ── useCloseHandlers 集成测试（通过 contextRegistry mock） ──

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ closePane: vi.fn(), spaceGroups: {} }),
    { getState: () => ({ spaceGroups: {} }) }
  ),
}))

const mockCloseTab = vi.fn()
const mockTabOrderBySpace: Record<string, string[]> = {}
const mockActiveKeyBySpace: Record<string, string | null> = {}

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({}),
    {
      getState: () => ({
        tabOrderBySpace: mockTabOrderBySpace,
        activeKeyBySpace: mockActiveKeyBySpace,
        closeTab: mockCloseTab,
      }),
    }
  ),
}))

const mockDispatchBeforeClose = vi.fn()
const mockDispatchClose = vi.fn()

vi.mock('../../registry', () => ({
  contextRegistry: {
    dispatchBeforeClose: (...args: unknown[]) => mockDispatchBeforeClose(...args),
    dispatchClose: (...args: unknown[]) => mockDispatchClose(...args),
    dispatchAfterClose: vi.fn(),
  },
}))

vi.mock('../../utils/canvasLayout', () => ({
  EMPTY_CANVAS_GROUPS: [],
  findGroupForTabKey: () => null,
}))

import { renderHook, act } from '@testing-library/react'
import { useCloseHandlers } from '../useCloseHandlers'

function makeHookParams(spaceId = 'sp-1') {
  return {
    spaceId,
    containerCtx: makeContainerCtx(),
    visibleTabKeys: ['test-type:test-id'],
    contextItemByTabKey: new Map([['test-type:test-id', makeItem()]]),
    setActiveKey: vi.fn(),
    handleSelectItem: vi.fn(),
  }
}

describe('useCloseHandlers.handleCloseItem with beforeClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDispatchBeforeClose.mockResolvedValue(true)
    // W2 T4 升级：dispatchClose 返回 DispatchCloseResult。`needsClose: true` 表示 hook 仍需 closeTab 兜底。
    mockDispatchClose.mockResolvedValue({ hasHandler: false, needsClose: true })
    mockTabOrderBySpace['sp-1'] = ['test-type:test-id']
  })

  it('beforeClose 返回 true 时正常执行关闭', async () => {
    mockDispatchBeforeClose.mockResolvedValue(true)
    mockDispatchClose.mockResolvedValue({ hasHandler: false, needsClose: true })

    const { result } = renderHook(() => useCloseHandlers(makeHookParams()))

    await act(async () => {
      result.current.handleCloseItem(makeItem())
      await new Promise(r => setTimeout(r, 50))
    })

    expect(mockDispatchBeforeClose).toHaveBeenCalledTimes(1)
    expect(mockDispatchClose).toHaveBeenCalledTimes(1)
    expect(mockCloseTab).toHaveBeenCalledTimes(1)
  })

  it('beforeClose 返回 false 时不执行关闭', async () => {
    mockDispatchBeforeClose.mockResolvedValue(false)

    const { result } = renderHook(() => useCloseHandlers(makeHookParams()))

    await act(async () => {
      result.current.handleCloseItem(makeItem())
      await new Promise(r => setTimeout(r, 50))
    })

    expect(mockDispatchBeforeClose).toHaveBeenCalledTimes(1)
    expect(mockDispatchClose).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('handler 无 beforeClose 时（返回 true）正常关闭', async () => {
    mockDispatchBeforeClose.mockResolvedValue(true)
    mockDispatchClose.mockResolvedValue({ hasHandler: true, needsClose: true })

    const { result } = renderHook(() => useCloseHandlers(makeHookParams()))

    await act(async () => {
      result.current.handleCloseItem(makeItem())
      await new Promise(r => setTimeout(r, 50))
    })

    expect(mockDispatchBeforeClose).toHaveBeenCalledTimes(1)
    expect(mockDispatchClose).toHaveBeenCalledTimes(1)
  })
})
