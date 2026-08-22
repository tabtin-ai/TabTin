import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestComposerClearAfterSend = vi.hoisted(() => vi.fn())
const sharedChat = vi.hoisted(() => vi.fn())
const getSharedExecutionStatus = vi.hoisted(() => vi.fn())

const shareState = vi.hoisted(() => ({
  sessionShares: {
    'share-1': {
      detail: {
        id: 'share-1',
        status: 'active',
        owner_user_id: 'owner-1',
        grantee_user_id: 'grantee-1',
        can_chat: true,
        can_fork: false,
      },
      detailLoaded: true,
      accessDenied: false,
      loadState: 'loaded',
    },
  },
  sessionShareDetailVersions: {},
  loadSessionShare: vi.fn(),
}))

const toast = vi.hoisted(() => vi.fn())

vi.mock('@components/ui', () => ({ toast }))
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'grantee-1' } }),
}))
vi.mock('@/stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: typeof shareState) => unknown) => selector(shareState),
    { getState: () => shareState },
  ),
}))
vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      clearReplyTarget: vi.fn(),
      requestComposerClearAfterSend,
    }),
  },
}))
vi.mock('@/services/sessionShareApi', () => ({
  getSharedExecutionStatus,
  sharedChat,
}))

import { useSessionAccessComposer } from '../useSessionAccessComposer'

describe('useSessionAccessComposer 发送确认', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Reflect.set(shareState.sessionShares['share-1'], 'detail', {
      id: 'share-1',
      status: 'active',
      owner_user_id: 'owner-1',
      grantee_user_id: 'grantee-1',
      can_chat: true,
      can_fork: false,
    })
    shareState.sessionShares['share-1'].detailLoaded = true
    getSharedExecutionStatus.mockResolvedValue({ reachable: true })
    sharedChat.mockResolvedValue({})
  })

  it('共享详情加载期保留 Composer 外壳并禁用发送', () => {
    Reflect.set(shareState.sessionShares['share-1'], 'detail', null)
    shareState.sessionShares['share-1'].detailLoaded = false

    const { result } = renderHook(() => useSessionAccessComposer({
      sessionId: 'session-1',
      shareId: 'share-1',
    }))

    expect(result.current.visible).toBe(true)
    expect(result.current.capabilities.canSendSharedChat).toBe(false)
    expect(result.current.disabledReason).toBe('shared_initializing')
  })

  it('共享消息发送成功后请求统一 Composer 清稿', async () => {
    const { result } = renderHook(() => useSessionAccessComposer({
      sessionId: 'session-1',
      shareId: 'share-1',
    }))

    await act(() => result.current.onSend('你好'))

    expect(requestComposerClearAfterSend).toHaveBeenCalledOnce()
    expect(requestComposerClearAfterSend).toHaveBeenCalledWith('session-1')
  })

  it('共享消息发送失败时保留草稿', async () => {
    sharedChat.mockRejectedValueOnce(new Error('send failed'))
    const { result } = renderHook(() => useSessionAccessComposer({
      sessionId: 'session-1',
      shareId: 'share-1',
    }))

    await act(() => result.current.onSend('你好'))

    expect(requestComposerClearAfterSend).not.toHaveBeenCalled()
  })

  it('共享消息业务失败时保留草稿并提示错误', async () => {
    sharedChat.mockResolvedValueOnce({
      error_category: 'llm_error',
      error_message: '模型执行失败',
    })
    const { result } = renderHook(() => useSessionAccessComposer({
      sessionId: 'session-1',
      shareId: 'share-1',
    }))

    await act(() => result.current.onSend('你好'))

    expect(requestComposerClearAfterSend).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '发言失败',
      description: '模型执行失败',
      variant: 'destructive',
    }))
  })

  it('共享消息已落库但执行失败时清稿并刷新时间线', async () => {
    const onSent = vi.fn()
    sharedChat.mockResolvedValueOnce({
      message_id: 'message-1',
      error_category: 'queue_full',
      error_message: '执行队列已满',
    })
    const { result } = renderHook(() => useSessionAccessComposer({
      sessionId: 'session-1',
      shareId: 'share-1',
      onSent,
    }))

    await act(() => result.current.onSend('你好'))

    expect(requestComposerClearAfterSend).toHaveBeenCalledWith('session-1')
    expect(onSent).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: '执行队列已满',
      variant: 'destructive',
    }))
  })

  it('共享消息返回瞬态设备错误时保留草稿但不锁死输入框', async () => {
    sharedChat.mockResolvedValueOnce({
      error_category: 'device_busy',
      error_message: '远程设备忙碌',
    })
    const { result } = renderHook(() => useSessionAccessComposer({
      sessionId: 'session-1',
      shareId: 'share-1',
    }))

    await act(() => result.current.onSend('你好'))

    expect(requestComposerClearAfterSend).not.toHaveBeenCalled()
    expect(result.current.offline).toBe(false)

    await act(() => result.current.onSend('再次发送'))

    expect(sharedChat).toHaveBeenCalledTimes(2)
  })

  it('共享消息已落库但设备离线时清稿、刷新并提示', async () => {
    const onSent = vi.fn()
    sharedChat.mockResolvedValueOnce({
      message_id: 'message-1',
      error_category: 'device_offline',
      error_message: 'control_device offline',
      reply: '远程设备离线，请稍后重试',
    })
    const { result } = renderHook(() => useSessionAccessComposer({
      sessionId: 'session-1',
      shareId: 'share-1',
      onSent,
    }))

    await act(() => result.current.onSend('你好'))

    expect(requestComposerClearAfterSend).toHaveBeenCalledWith('session-1')
    expect(onSent).toHaveBeenCalledOnce()
    expect(result.current.offline).toBe(false)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: '远程设备离线，请稍后重试',
      variant: 'destructive',
    }))
  })

  it('离线后点击错误卡重试会重新探测并在恢复后发送', async () => {
    getSharedExecutionStatus.mockResolvedValueOnce({ reachable: false })
    const { result } = renderHook(() => useSessionAccessComposer({
      sessionId: 'session-1',
      shareId: 'share-1',
    }))
    await waitFor(() => expect(result.current.offline).toBe(true))
    getSharedExecutionStatus.mockResolvedValueOnce({ reachable: true })

    await act(() => result.current.onSend('重试原请求'))

    expect(sharedChat).toHaveBeenCalledWith(
      'session-1',
      'share-1',
      '重试原请求',
      expect.any(String),
    )
    expect(result.current.offline).toBe(false)
  })
})
