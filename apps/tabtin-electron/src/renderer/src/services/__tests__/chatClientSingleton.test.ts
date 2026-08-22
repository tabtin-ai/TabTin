import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/stores/sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

const mockBgClearAll = vi.fn()
vi.mock('@/stores/useBackgroundEventStore', () => ({
  useBackgroundEventStore: {
    getState: () => ({ clearAll: mockBgClearAll }),
  },
}))

function createMockClient() {
  return {
    abortStream: vi.fn(),
    getGateway: vi.fn(() => ({ close: vi.fn() })),
    setOnReconnected: vi.fn(),
  } as any
}

let getChatClientInstance: typeof import('../chatClientSingleton').getChatClientInstance
let setChatClientInstance: typeof import('../chatClientSingleton').setChatClientInstance
let resetChatClient: typeof import('../chatClientSingleton').resetChatClient
let setReconnectHandler: typeof import('../chatClientSingleton').setReconnectHandler

beforeEach(async () => {
  vi.resetModules()
  mockBgClearAll.mockClear()
  const mod = await import('../chatClientSingleton')
  getChatClientInstance = mod.getChatClientInstance
  setChatClientInstance = mod.setChatClientInstance
  resetChatClient = mod.resetChatClient
  setReconnectHandler = mod.setReconnectHandler
})

describe('chatClientSingleton', () => {
  it('初始状态返回 null', () => {
    expect(getChatClientInstance()).toBeNull()
  })

  it('set 后 get 返回同一实例', () => {
    const client = createMockClient()
    setChatClientInstance(client)
    expect(getChatClientInstance()).toBe(client)
  })

  it('reset 调用 abortStream + gateway.close 并置空', () => {
    const closeFn = vi.fn()
    const client = createMockClient()
    client.getGateway.mockReturnValue({ close: closeFn })

    setChatClientInstance(client)
    resetChatClient()

    expect(client.abortStream).toHaveBeenCalled()
    expect(closeFn).toHaveBeenCalled()
    expect(getChatClientInstance()).toBeNull()
  })

  it('reset 无实例时不报错', () => {
    expect(() => resetChatClient()).not.toThrow()
  })

  it('reset 时 close 抛异常仍能置空实例', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = createMockClient()
    client.getGateway.mockReturnValue({
      close: () => { throw new Error('close failed') },
    })

    setChatClientInstance(client)
    resetChatClient()

    expect(getChatClientInstance()).toBeNull()
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('reset 时清空 useBackgroundEventStore（Wave 3 行为：避免账号 A 登出后事件残留给 B）', () => {
    const client = createMockClient()
    setChatClientInstance(client)

    resetChatClient()

    expect(mockBgClearAll).toHaveBeenCalledTimes(1)
  })

  it('reset 时即使无 instance 也清空 useBackgroundEventStore', () => {
    resetChatClient()
    expect(mockBgClearAll).toHaveBeenCalledTimes(1)
  })

  describe('reconnect handler', () => {
    it('先注册 handler 后 set instance：handler 在 set 时挂载', () => {
      const handler = vi.fn()
      const client = createMockClient()

      setReconnectHandler(handler)
      setChatClientInstance(client)

      expect(client.setOnReconnected).toHaveBeenCalledWith(handler)
    })

    it('先 set instance 后注册 handler：handler 立即挂载', () => {
      const handler = vi.fn()
      const client = createMockClient()

      setChatClientInstance(client)
      setReconnectHandler(handler)

      expect(client.setOnReconnected).toHaveBeenCalledWith(handler)
    })

    it('替换 handler 时更新到已有 instance', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      const client = createMockClient()

      setChatClientInstance(client)
      setReconnectHandler(handler1)
      setReconnectHandler(handler2)

      expect(client.setOnReconnected).toHaveBeenLastCalledWith(handler2)
    })

    it('新 instance set 时使用最近注册的 handler', () => {
      const handler = vi.fn()
      const client1 = createMockClient()
      const client2 = createMockClient()

      setReconnectHandler(handler)
      setChatClientInstance(client1)
      setChatClientInstance(client2)

      expect(client2.setOnReconnected).toHaveBeenCalledWith(handler)
    })
  })
})
