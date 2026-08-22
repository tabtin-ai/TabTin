import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogStore } from '@tabtin/agent-host/state'

const mocks = vi.hoisted(() => ({
  listAttachedServers: vi.fn(),
  listAttachedTools: vi.fn(),
  invalidationListeners: new Set<(event: {
    agentIds?: readonly string[]
    mode: 'drop' | 'stale'
    reason: string
  }) => void>(),
}))

vi.mock('../../../services/LocalMcpService.js', () => {
  const service = {
    listAttachedServers: mocks.listAttachedServers,
    listAttachedTools: mocks.listAttachedTools,
    onToolCacheInvalidated: (listener: (event: {
      agentIds?: readonly string[]
      mode: 'drop' | 'stale'
      reason: string
    }) => void) => {
      mocks.invalidationListeners.add(listener)
      return () => mocks.invalidationListeners.delete(listener)
    },
  }
  return { getLocalMcpService: () => service }
})

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}))

import {
  createMcpListingFetcher,
  resetMcpListingFetcherForTest,
} from '../mcp-listing-fetcher'
import {
  bindCatalogStore,
  unbindCatalogStoreForTests,
} from '../cli-commands-materializer'

describe('createMcpListingFetcher Agent scope', () => {
  beforeEach(() => {
    const catalog = new CatalogStore()
    bindCatalogStore(() => catalog)
    vi.clearAllMocks()
  })

  afterEach(() => {
    resetMcpListingFetcherForTest()
    unbindCatalogStoreForTests()
  })

  it('按闭包中的 agentId 读取 server 与 tools', async () => {
    mocks.listAttachedServers.mockReturnValue([
      { serverName: 'github', sourceLabel: 'Manual' },
    ])
    mocks.listAttachedTools.mockResolvedValue([
      {
        server: { serverName: 'github' },
        tools: [{ name: 'create_issue', description: 'Create issue' }],
      },
    ])

    const result = await createMcpListingFetcher('agent-A')({})

    expect(mocks.listAttachedServers).toHaveBeenCalledWith('agent-A')
    expect(mocks.listAttachedTools).toHaveBeenCalledWith('agent-A')
    expect(result).toMatchObject({
      servers: [{ serverName: 'github' }],
      tools: [{ serverName: 'github', name: 'create_issue' }],
    })
  })

  it('配置变更后不等待 TTL，下一轮立即刷新工具', async () => {
    mocks.listAttachedServers.mockReturnValue([
      { serverName: 'github', sourceLabel: 'Manual' },
    ])
    mocks.listAttachedTools
      .mockResolvedValueOnce([{
        server: { serverName: 'github' },
        tools: [{ name: 'old_tool', description: 'Old' }],
      }])
      .mockResolvedValueOnce([{
        server: { serverName: 'github' },
        tools: [{ name: 'new_tool', description: 'New' }],
      }])

    const fetcher = createMcpListingFetcher('agent-cache')
    await fetcher({})
    await fetcher({})
    expect(mocks.listAttachedTools).toHaveBeenCalledTimes(1)

    for (const listener of mocks.invalidationListeners) {
      listener({
        agentIds: ['agent-cache'],
        mode: 'drop',
        reason: 'configuration-changed',
      })
    }

    await vi.waitFor(() => expect(mocks.listAttachedTools).toHaveBeenCalledTimes(2))
    const refreshed = await fetcher({})
    expect(mocks.listAttachedTools).toHaveBeenCalledTimes(2)
    expect(refreshed?.tools).toEqual([
      expect.objectContaining({ name: 'new_tool' }),
    ])
  })

  it('服务端通知使缓存立即过期，刷新失败时保留同一 server 的旧工具', async () => {
    mocks.listAttachedServers.mockReturnValue([
      { serverName: 'github', sourceLabel: 'Manual' },
    ])
    mocks.listAttachedTools
      .mockResolvedValueOnce([{
        server: { serverName: 'github' },
        tools: [{ name: 'stable_tool', description: 'Stable' }],
      }])
      .mockRejectedValue(new Error('temporary disconnect'))

    const fetcher = createMcpListingFetcher('agent-notify')
    await fetcher({})
    for (const listener of mocks.invalidationListeners) {
      listener({
        agentIds: ['agent-notify'],
        mode: 'stale',
        reason: 'server-list-changed',
      })
    }

    await vi.waitFor(() => expect(mocks.listAttachedTools).toHaveBeenCalledTimes(2))
    const fallback = await fetcher({})
    expect(mocks.listAttachedTools).toHaveBeenCalledTimes(3)
    expect(fallback?.tools).toEqual([
      expect.objectContaining({ name: 'stable_tool' }),
    ])
  })

  it('失效发生在刷新途中时，旧响应不能重新写回缓存', async () => {
    mocks.listAttachedServers.mockReturnValue([
      { serverName: 'github', sourceLabel: 'Manual' },
    ])
    let resolveFirst!: (value: Array<{
      server: { serverName: string }
      tools: Array<{ name: string; description: string }>
    }>) => void
    mocks.listAttachedTools
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFirst = resolve
      }))
      .mockResolvedValueOnce([{
        server: { serverName: 'github' },
        tools: [{ name: 'fresh_tool', description: 'Fresh' }],
      }])

    const fetcher = createMcpListingFetcher('agent-race')
    const staleRequest = fetcher({})
    await vi.waitFor(() => expect(mocks.listAttachedTools).toHaveBeenCalledTimes(1))
    for (const listener of mocks.invalidationListeners) {
      listener({
        agentIds: ['agent-race'],
        mode: 'drop',
        reason: 'configuration-changed',
      })
    }
    resolveFirst([{
      server: { serverName: 'github' },
      tools: [{ name: 'stale_tool', description: 'Stale' }],
    }])
    await staleRequest

    const refreshed = await fetcher({})
    expect(mocks.listAttachedTools).toHaveBeenCalledTimes(2)
    expect(refreshed?.tools).toEqual([
      expect.objectContaining({ name: 'fresh_tool' }),
    ])
  })

  it('无 agentId 时 fail-closed 且不读取 service', async () => {
    const result = await createMcpListingFetcher(undefined)({})

    expect(result).toEqual({ servers: [], tools: [] })
    expect(mocks.listAttachedServers).not.toHaveBeenCalled()
    expect(mocks.listAttachedTools).not.toHaveBeenCalled()
  })
})
