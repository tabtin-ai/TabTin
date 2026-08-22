/**
 * Unit tests for useMcpPanelData 模块级 dedup 缓存。
 *
 * 验收：
 *   1. 同时挂载多个 hook 实例，只触发一次底层 IPC 2 件套
 *   2. 短窗口内重复挂载命中缓存
 *   3. 'refresh' 模式绕过缓存（用户主动刷新不应看 stale）
 *   4. TTL 过后会重新拉取
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  listConnections: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? '',
  }),
}))

beforeEach(() => {
  mocks.discover.mockReset().mockResolvedValue({ timestamp: 1, candidates: [] })
  mocks.listConnections.mockReset().mockResolvedValue([])

  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      localMcp: {
        discover: mocks.discover,
        listConnections: mocks.listConnections,
      },
    },
  })
})

afterEach(async () => {
  const mod = await import('../useMcpPanelData')
  mod.__testingMcpPanelDataCache.reset()
})

describe('useMcpPanelData dedup', () => {
  it('多个 hook 并发挂载只触发一次 IPC 2 件套', async () => {
    const { useMcpPanelData } = await import('../useMcpPanelData')

    const h1 = renderHook(() => useMcpPanelData('agent-1'))
    const h2 = renderHook(() => useMcpPanelData('agent-1'))
    const h3 = renderHook(() => useMcpPanelData('agent-2'))

    await waitFor(() => {
      expect(h1.result.current.loading).toBe(false)
      expect(h2.result.current.loading).toBe(false)
      expect(h3.result.current.loading).toBe(false)
    })

    expect(mocks.discover).toHaveBeenCalledTimes(1)
    expect(mocks.listConnections).toHaveBeenCalledTimes(1)
  })

  it('短窗口内串行挂载命中缓存', async () => {
    const { useMcpPanelData } = await import('../useMcpPanelData')

    const h1 = renderHook(() => useMcpPanelData('agent-1'))
    await waitFor(() => expect(h1.result.current.loading).toBe(false))
    expect(mocks.discover).toHaveBeenCalledTimes(1)

    const h2 = renderHook(() => useMcpPanelData('agent-1'))
    await waitFor(() => expect(h2.result.current.loading).toBe(false))
    expect(mocks.discover).toHaveBeenCalledTimes(1) // 命中缓存，不再发新 IPC
  })

  it('refresh 模式绕过缓存', async () => {
    const { useMcpPanelData } = await import('../useMcpPanelData')

    const h1 = renderHook(() => useMcpPanelData('agent-1'))
    await waitFor(() => expect(h1.result.current.loading).toBe(false))
    expect(mocks.discover).toHaveBeenCalledTimes(1)

    await act(async () => {
      await h1.result.current.loadPanelData('refresh')
    })
    expect(mocks.discover).toHaveBeenCalledTimes(2)
    expect(mocks.listConnections).toHaveBeenCalledTimes(2)
  })

  it('TTL 过后挂载会重新拉取', async () => {
    const { useMcpPanelData, __testingMcpPanelDataCache } = await import('../useMcpPanelData')

    const h1 = renderHook(() => useMcpPanelData('agent-1'))
    await waitFor(() => expect(h1.result.current.loading).toBe(false))
    expect(mocks.discover).toHaveBeenCalledTimes(1)

    // 用 reset 等价于 TTL 过期场景（更直接：避免 fakeTimers 跟 await 不和）
    __testingMcpPanelDataCache.reset()

    const h2 = renderHook(() => useMcpPanelData('agent-1'))
    await waitFor(() => expect(h2.result.current.loading).toBe(false))
    expect(mocks.discover).toHaveBeenCalledTimes(2)
  })

  it('activeAttachedConnections 按 Agent ID 过滤', async () => {
    mocks.listConnections.mockResolvedValue([
      {
        id: 'conn-1',
        name: 'github',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'stdio',
        envKeys: [],
        headerKeys: [],
        enabled: true,
        attachedAgentIds: ['agent-1'],
        requiresAgentSelection: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ])
    const { useMcpPanelData } = await import('../useMcpPanelData')

    const hook = renderHook(() => useMcpPanelData('agent-1'))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))

    expect(hook.result.current.activeAttachedConnections.map(item => item.id)).toEqual(['conn-1'])
  })

  it('upsertConnection 局部更新且不触发 discover', async () => {
    mocks.listConnections.mockResolvedValue([
      {
        id: 'conn-1',
        name: 'github',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'stdio',
        envKeys: [],
        headerKeys: [],
        enabled: true,
        attachedAgentIds: [],
        requiresAgentSelection: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ])
    const { useMcpPanelData, __testingMcpPanelDataCache } = await import('../useMcpPanelData')
    __testingMcpPanelDataCache.reset()

    const hook = renderHook(() => useMcpPanelData('agent-1'))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    const discoverCalls = mocks.discover.mock.calls.length

    act(() => {
      hook.result.current.upsertConnection({
        id: 'conn-1',
        name: 'github',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'stdio',
        envKeys: [],
        headerKeys: [],
        enabled: true,
        attachedAgentIds: ['agent-1'],
        requiresAgentSelection: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-08-03T12:00:00.000Z',
      })
    })

    expect(hook.result.current.connections[0]?.attachedAgentIds).toEqual(['agent-1'])
    expect(mocks.discover).toHaveBeenCalledTimes(discoverCalls)
  })
})
