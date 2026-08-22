import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const {
  gatewayListeners,
  mockConnect,
  mockCollectionHandleWsEvent,
  mockHandleStructuralEvent,
  mockHandleWsEvent,
  mockOffReconnectedEvent,
  mockOnReconnectedEvent,
  mockRequest,
  mockSubscribe,
  reconnectedHandlers,
} = vi.hoisted(() => {
  const listeners = new Set<(envelope: any) => void>()
  const reconnected = new Set<() => void>()

  return {
    gatewayListeners: {
      add: (listener: (envelope: any) => void) => listeners.add(listener),
      remove: (listener: (envelope: any) => void) => listeners.delete(listener),
      emit: (envelope: any) => {
        for (const listener of Array.from(listeners)) {
          listener(envelope)
        }
      },
      clear: () => listeners.clear(),
    },
    reconnectedHandlers: {
      add: (handler: () => void) => reconnected.add(handler),
      remove: (handler: () => void) => reconnected.delete(handler),
      emit: () => {
        for (const handler of Array.from(reconnected)) {
          handler()
        }
      },
      clear: () => reconnected.clear(),
    },
    mockConnect: vi.fn(),
    mockCollectionHandleWsEvent: vi.fn(),
    mockHandleStructuralEvent: vi.fn(),
    mockHandleWsEvent: vi.fn(),
    mockOffReconnectedEvent: vi.fn((handler: () => void) => {
      reconnected.delete(handler)
    }),
    mockOnReconnectedEvent: vi.fn((handler: () => void) => {
      reconnected.add(handler)
    }),
    mockRequest: vi.fn(),
    mockSubscribe: vi.fn(),
  }
})

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => ({
      connect: mockConnect,
      addListener: gatewayListeners.add,
      removeListener: gatewayListeners.remove,
      onReconnectedEvent: mockOnReconnectedEvent,
      offReconnectedEvent: mockOffReconnectedEvent,
      subscribe: mockSubscribe,
      request: mockRequest,
    }),
  }),
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedOrganization: { id: 'ws-1' },
      organizations: [{ id: 'ws-1' }],
      getEffectiveOrganizationId: () => 'ws-1',
    }),
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'user-1' },
    }),
}))

vi.mock('@/stores/useUnifiedResources', () => ({
  useUnifiedResources: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      handleStructuralEvent: mockHandleStructuralEvent,
      handleWsEvent: mockHandleWsEvent,
    }),
}))

vi.mock('@/stores/useCollections', () => ({
  useCollections: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      handleWsEvent: mockCollectionHandleWsEvent,
    }),
}))

describe('useResourceEventStream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gatewayListeners.clear()
    reconnectedHandlers.clear()
    mockConnect.mockResolvedValue(true)
    mockSubscribe.mockResolvedValue({ ok: true })
    mockRequest.mockResolvedValue({ ok: true })
    mockOnReconnectedEvent.mockImplementation((handler: () => void) => {
      reconnectedHandlers.add(handler)
    })
    mockOffReconnectedEvent.mockImplementation((handler: () => void) => {
      reconnectedHandlers.remove(handler)
    })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('多 Space 订阅并存时只处理命中当前 topic 的事件', async () => {
    const { useResourceEventStream } = await import('../useResourceEventStream')

    const first = renderHook(() => useResourceEventStream({ spaceId: 'space-1' }))
    const second = renderHook(() => useResourceEventStream({ spaceId: 'space-2' }))

    // ：每个 hook 额外订阅 user topic（同 user topic 可能重复 ensure）
    await waitFor(() => {
      expect(mockSubscribe.mock.calls.length).toBeGreaterThanOrEqual(3)
    })

    // 非云资源仍可走 space topic；云资源应走 user topic（见下方用例）
    gatewayListeners.emit({
      type: 'resource_created',
      _topic: 'context.sync.space-2',
      resource_type: 'tabsite',
      resource_id: 'site-1',
      title: 'Site 1',
      space_id: 'space-2',
    })

    expect(mockHandleWsEvent).toHaveBeenCalledTimes(1)
    expect(mockHandleWsEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_created',
      resource_type: 'tabsite',
      resource_id: 'site-1',
      space_id: 'space-2',
    }))

    first.unmount()
    second.unmount()
  })

  it('透传资源事件中的服务端 updated_at', async () => {
    const { useResourceEventStream } = await import('../useResourceEventStream')

    const hook = renderHook(() => useResourceEventStream({ spaceId: 'space-1' }))

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith(['context.sync.space-1'])
      expect(mockSubscribe).toHaveBeenCalledWith(['context.sync.user.user-1'])
    })

    gatewayListeners.emit({
      type: 'context.sync.event',
      _topic: 'context.sync.space-1',
      payload: {
        type: 'resource_updated',
        resource_type: 'tabsite',
        resource_id: 'site-1',
        title: '新标题',
        space_id: 'space-1',
        updated_at: '2026-06-08T07:00:00Z',
      },
    })

    expect(mockHandleWsEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_updated',
      resource_type: 'tabsite',
      resource_id: 'site-1',
      updated_at: '2026-06-08T07:00:00Z',
    }))

    hook.unmount()
  })

  it('透传资源创建事件里的 collection_id，避免合集内新建资源被当作根目录项', async () => {
    const { useResourceEventStream } = await import('../useResourceEventStream')

    const hook = renderHook(() => useResourceEventStream({ spaceId: 'space-1' }))

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith(['context.sync.user.user-1'])
    })

    gatewayListeners.emit({
      type: 'context.sync.event',
      _topic: 'context.sync.user.user-1',
      payload: {
        type: 'resource_created',
        resource_type: 'tabdoc',
        resource_id: 'doc-in-folder',
        title: '合集内文档',
        space_id: 'space-1',
        organization_id: 'ws-1',
        collection_id: 'collection-1',
      },
    })

    expect(mockHandleWsEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_created',
      resource_type: 'tabdoc',
      resource_id: 'doc-in-folder',
      collection_id: 'collection-1',
    }))

    hook.unmount()
  })

  it('organization scope 订阅聚合 topic + user topic，并转发结构事件', async () => {
    const { useResourceEventStream } = await import('../useResourceEventStream')

    const hook = renderHook(() => useResourceEventStream({ spaceId: 'space-1', scope: 'organization' }))

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith(['context.sync.organization.ws-1'])
      expect(mockSubscribe).toHaveBeenCalledWith(['context.sync.user.user-1'])
    })

    gatewayListeners.emit({
      type: 'items_moved',
      _topic: 'context.sync.organization.ws-1',
      space_id: 'space-2',
      organization_id: 'ws-1',
      count: 2,
    })

    expect(mockHandleStructuralEvent).toHaveBeenCalledTimes(1)
    expect(mockHandleStructuralEvent).toHaveBeenCalledWith({
      type: 'items_moved',
      space_id: 'space-2',
      organization_id: 'ws-1',
    })

    hook.unmount()
  })

  it('organization topic 上的云资源敏感事件被前端忽略', async () => {
    const { useResourceEventStream } = await import('../useResourceEventStream')

    const hook = renderHook(() => useResourceEventStream({ spaceId: 'space-1', scope: 'organization' }))

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith(['context.sync.organization.ws-1'])
    })

    gatewayListeners.emit({
      type: 'resource_created',
      _topic: 'context.sync.organization.ws-1',
      resource_type: 'tabdoc',
      resource_id: 'secret-doc',
      title: '不该看见',
      space_id: 'space-1',
      organization_id: 'ws-1',
    })

    expect(mockHandleWsEvent).not.toHaveBeenCalled()

    hook.unmount()
  })

  it('结构事件透传 collection_id，远端删除合集也能即时清理资源缓存', async () => {
    const { useResourceEventStream } = await import('../useResourceEventStream')

    const hook = renderHook(() => useResourceEventStream({ spaceId: 'space-1', scope: 'organization' }))

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith(['context.sync.organization.ws-1'])
    })

    gatewayListeners.emit({
      type: 'collection_deleted',
      _topic: 'context.sync.organization.ws-1',
      space_id: 'space-2',
      organization_id: 'ws-1',
      collection_id: 'collection-parent',
      collection_ids: ['collection-parent', 'collection-child', 123],
    })

    expect(mockHandleStructuralEvent).toHaveBeenCalledWith({
      type: 'collection_deleted',
      space_id: 'space-2',
      organization_id: 'ws-1',
      collection_id: 'collection-parent',
      collection_ids: ['collection-parent', 'collection-child'],
    })

    hook.unmount()
  })

  it('organization topic 的 collection_created 携带 organization_id 并进入 collection store ', async () => {
    const { useResourceEventStream } = await import('../useResourceEventStream')

    const hook = renderHook(() => useResourceEventStream({ spaceId: 'space-1', scope: 'organization' }))

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith(['context.sync.organization.ws-1'])
    })

    gatewayListeners.emit({
      type: 'collection_created',
      _topic: 'context.sync.organization.ws-1',
      organization_id: 'ws-1',
      collection_id: 'a7298523-1111-2222-3333-444444444444',
      collection_name: 'CLI Folder',
    })

    expect(mockCollectionHandleWsEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'collection_created',
      organization_id: 'ws-1',
      collection_id: 'a7298523-1111-2222-3333-444444444444',
    }))
    expect(mockHandleStructuralEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'collection_created',
      organization_id: 'ws-1',
    }))

    hook.unmount()
  })

  it('重连后触发 onReconnected 补偿回调 ', async () => {
    const { useResourceEventStream } = await import('../useResourceEventStream')
    const onReconnected = vi.fn()

    const hook = renderHook(() =>
      useResourceEventStream({ spaceId: 'space-1', scope: 'organization', onReconnected }),
    )

    await waitFor(() => {
      expect(mockOnReconnectedEvent).toHaveBeenCalled()
    })

    // Gateway reconnect handler 会先 resubscribe，成功后才调 onReconnected
    reconnectedHandlers.emit()

    await waitFor(() => {
      expect(onReconnected).toHaveBeenCalledTimes(1)
    })

    hook.unmount()
  })
})
