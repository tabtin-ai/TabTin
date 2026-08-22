/**
 * useGatewayTopic 初始订阅失败重试。
 *
 * 修复前：初始 subscribe 失败（如 WS_REQUEST_TIMEOUT）会 detach listener 并
 * 永久放弃，用户停留在会话里镜像流失联。修复后带指数退避重试直至成功或
 * 达到上限。
 */

import React from 'react'
import { render, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const subscribeMock = vi.fn()
const connectMock = vi.fn()
const getOrganizationIdsMock = vi.fn()
const wsState = {
  organizationAccessRecoveryInFlight: false,
}

const gatewayMock = {
  connect: connectMock,
  subscribe: subscribeMock,
  request: vi.fn().mockResolvedValue(undefined),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  onReconnectedEvent: vi.fn(),
  offReconnectedEvent: vi.fn(),
}

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => gatewayMock,
    getOrganizationIds: getOrganizationIdsMock,
  }),
}))

vi.mock('@/stores/useOrganizationStore', () => {
  const state = {
    selectedOrganization: { id: 'wt-1' },
    organizations: [{ id: 'wt-1' }],
  }
  const useOrganizationStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useOrganizationStore }
})

vi.mock('@/stores/useWsConnectionStore', () => ({
  useWsConnectionStore: (selector: (s: typeof wsState) => unknown) => selector(wsState),
}))

import { useGatewayTopic, type GatewayTopicStatus } from './useGatewayTopic'

function HookHost({ onStatus }: { onStatus: (s: GatewayTopicStatus) => void }) {
  const { status } = useGatewayTopic({ topic: 'agent.stream.chat-session-x', logPrefix: 'test' })
  onStatus(status)
  return null
}

async function flushMicrotasks() {
  // subscribe/connect promise 链需要多轮 microtask 才结算
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('useGatewayTopic · 初始订阅失败重试', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    connectMock.mockReset().mockResolvedValue(true)
    subscribeMock.mockReset()
    getOrganizationIdsMock.mockReset().mockReturnValue(['wt-1'])
    wsState.organizationAccessRecoveryInFlight = false
    gatewayMock.addListener.mockClear()
    gatewayMock.removeListener.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次 subscribe 失败 → 退避后自动重试并最终 connected', async () => {
    subscribeMock
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })

    let latestStatus: GatewayTopicStatus = 'idle'
    render(<HookHost onStatus={(s) => { latestStatus = s }} />)

    await flushMicrotasks()
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(latestStatus).toBe('error')

    // 第一次退避 2s
    await act(async () => { vi.advanceTimersByTime(2_100) })
    await flushMicrotasks()

    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(latestStatus).toBe('connected')
  })

  it('连续失败达到上限后停止重试，保持 error 态', async () => {
    subscribeMock.mockResolvedValue({ ok: false })

    let latestStatus: GatewayTopicStatus = 'idle'
    render(<HookHost onStatus={(s) => { latestStatus = s }} />)

    await flushMicrotasks()
    // 逐次推进退避：2s/4s/8s/16s/30s/30s（cap），之后不再重试
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { vi.advanceTimersByTime(31_000) })
      await flushMicrotasks()
    }

    // 初始 1 次 + 最多 6 次重试
    expect(subscribeMock).toHaveBeenCalledTimes(7)
    expect(latestStatus).toBe('error')
  })

  it('确定性权限失败不重试，避免把权限问题放大成重连风暴', async () => {
    subscribeMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'WS_1005_PERMISSION_DENIED',
        message: 'session access denied',
      },
    })

    let latestStatus: GatewayTopicStatus = 'idle'
    render(<HookHost onStatus={(s) => { latestStatus = s }} />)

    await flushMicrotasks()
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(latestStatus).toBe('error')

    await act(async () => { vi.advanceTimersByTime(120_000) })
    await flushMicrotasks()

    expect(subscribeMock).toHaveBeenCalledTimes(1)
  })

  it('卸载时清掉待执行的重试定时器', async () => {
    subscribeMock.mockResolvedValue({ ok: false })

    const { unmount } = render(<HookHost onStatus={() => {}} />)
    await flushMicrotasks()
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => { vi.advanceTimersByTime(120_000) })
    await flushMicrotasks()

    expect(subscribeMock).toHaveBeenCalledTimes(1)
  })

  it('当前组织尚未进入 gateway membership 快照时不抢先订阅', async () => {
    getOrganizationIdsMock.mockReturnValue(['old-wt'])
    subscribeMock.mockResolvedValue({ ok: true })

    let latestStatus: GatewayTopicStatus = 'connected'
    const { rerender } = render(<HookHost onStatus={(s) => { latestStatus = s }} />)

    await flushMicrotasks()

    expect(subscribeMock).not.toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
    expect(latestStatus).toBe('idle')

    getOrganizationIdsMock.mockReturnValue(['old-wt', 'wt-1'])
    rerender(<HookHost onStatus={(s) => { latestStatus = s }} />)
    await flushMicrotasks()

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(latestStatus).toBe('connected')
  })

  it('组织 membership 刷新进行中时保持 idle，避免 WS_NOT_CONNECTED 噪声', async () => {
    wsState.organizationAccessRecoveryInFlight = true
    subscribeMock.mockResolvedValue({ ok: true })

    let latestStatus: GatewayTopicStatus = 'connected'
    const { rerender } = render(<HookHost onStatus={(s) => { latestStatus = s }} />)

    await flushMicrotasks()

    expect(subscribeMock).not.toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
    expect(latestStatus).toBe('idle')

    wsState.organizationAccessRecoveryInFlight = false
    rerender(<HookHost onStatus={(s) => { latestStatus = s }} />)
    await flushMicrotasks()

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(latestStatus).toBe('connected')
  })
})
