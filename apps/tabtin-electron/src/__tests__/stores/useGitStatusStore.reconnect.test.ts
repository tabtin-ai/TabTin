/**
 * C5-01 回归测试：WS 重连后 git status 缓存清空 + 重新请求
 *
 * 验证 _wsReconnectHandler 在 WS 重连时：
 * 1. 清空 statusBySpaceId
 * 2. 清空 diffCache
 * 3. 对已知 spaceId 发起 git.status.request 刷新请求
 * 4. 请求成功后更新 store 中对应 space 的状态
 * 5. 请求失败时静默忽略（不抛异常）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- 构造 mock gateway ----
let _reconnectHandler: (() => void) | null = null
let _listener: ((e: any) => void) | null = null
const mockRequest = vi.fn()

const mockGateway = {
  addListener: vi.fn((fn) => { _listener = fn }),
  removeListener: vi.fn(),
  onReconnectedEvent: vi.fn((fn) => { _reconnectHandler = fn }),
  offReconnectedEvent: vi.fn(),
  request: mockRequest,
}

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => mockGateway,
  }),
}))

vi.mock('@/stores/sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

describe('useGitStatusStore — WS 重连处理 (C5-01)', () => {
  let store: typeof import('@/stores/useGitStatusStore').useGitStatusStore

  beforeEach(async () => {
    vi.resetModules()
    _reconnectHandler = null
    _listener = null
    mockRequest.mockReset()

    const mod = await import('@/stores/useGitStatusStore')
    store = mod.useGitStatusStore
    store.getState().reset()
  })

  afterEach(() => {
    store.getState().teardownWsListener()
  })

  it('重连时 statusBySpaceId 被清空', () => {
    store.getState().setGitStatus('space-1', { is_repo: true, branch: 'main' } as any)
    store.getState().setGitStatus('space-2', { is_repo: true, branch: 'dev' } as any)

    store.getState().setupWsListener()
    expect(Object.keys(store.getState().statusBySpaceId)).toHaveLength(2)

    // 模拟 WS 重连
    mockRequest.mockResolvedValue({ ok: false })
    _reconnectHandler?.()

    expect(store.getState().statusBySpaceId).toEqual({})
  })

  it('重连时 diffCache 被清空', () => {
    // 手动注入缓存数据
    store.setState({
      diffCache: {
        'space-1:README.md:false': { diff: '@@...', fetchedAt: Date.now() },
      },
    })

    store.getState().setupWsListener()
    mockRequest.mockResolvedValue({ ok: false })
    _reconnectHandler?.()

    expect(store.getState().diffCache).toEqual({})
  })

  it('重连时对已知 spaceId 发起 git.status.request', () => {
    store.getState().setGitStatus('space-1', { is_repo: true, branch: 'main' } as any)
    store.getState().setGitStatus('space-2', { is_repo: true, branch: 'dev' } as any)

    store.getState().setupWsListener()
    mockRequest.mockResolvedValue({ ok: false })
    _reconnectHandler?.()

    expect(mockRequest).toHaveBeenCalledTimes(2)
    const calledSpaceIds = mockRequest.mock.calls.map((c) => c[1]?.space_id)
    expect(calledSpaceIds).toContain('space-1')
    expect(calledSpaceIds).toContain('space-2')
    expect(mockRequest.mock.calls[0][0]).toBe('git.status.request')
  })

  it('请求成功后将新状态写入 store', async () => {
    store.getState().setGitStatus('space-1', { is_repo: true, branch: 'main' } as any)
    store.getState().setupWsListener()

    const freshStatus = { is_repo: true, branch: 'main', has_changes: true }
    mockRequest.mockResolvedValue({ ok: true, payload: { git_status: freshStatus } })

    _reconnectHandler?.()

    // 等待微任务队列
    await new Promise((r) => setTimeout(r, 0))

    expect(store.getState().statusBySpaceId['space-1']).toEqual(freshStatus)
  })

  it('请求失败时静默忽略，不更新 store', async () => {
    store.getState().setGitStatus('space-1', { is_repo: true, branch: 'main' } as any)
    store.getState().setupWsListener()

    mockRequest.mockRejectedValue(new Error('network error'))

    // 不应抛出
    expect(() => _reconnectHandler?.()).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))

    // store 已清空，且错误没有恢复任何数据
    expect(store.getState().statusBySpaceId['space-1']).toBeUndefined()
  })

  it('无已知 space 时重连不发起请求', () => {
    store.getState().setupWsListener()
    mockRequest.mockResolvedValue({ ok: false })

    _reconnectHandler?.()

    expect(mockRequest).not.toHaveBeenCalled()
  })
})
