import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserPortrait } from '@/services/userPortraitApi'

const {
  getMyPortraitMock,
  triggerDistillMock,
  submitHintMock,
  invalidatePortraitCacheMock,
} = vi.hoisted(() => ({
  getMyPortraitMock: vi.fn(),
  triggerDistillMock: vi.fn(),
  submitHintMock: vi.fn(),
  invalidatePortraitCacheMock: vi.fn(),
}))

vi.mock('@/services/userPortraitApi', () => ({
  UserPortraitApi: {
    getMyPortrait: getMyPortraitMock,
    triggerDistill: triggerDistillMock,
    submitHint: submitHintMock,
  },
  UserPortraitApiError: class UserPortraitApiError extends Error {},
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { useUserPortrait } from '../useUserPortrait'

const ORGANIZATION_ID = 'organization-1'
const AGENT_ID = 'agent-1'

function portrait(overrides: Partial<UserPortrait> = {}): UserPortrait {
  return {
    id: 'portrait-1',
    user_id: 'user-1',
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    content_md: '## 工作背景\n旧画像',
    version: 1,
    last_distilled_at: '2026-07-25T00:00:00Z',
    last_distill_status: 'idle',
    last_distill_error: '',
    pending_hints_count: 0,
    memory_enabled: true,
    created_at: '2026-07-25T00:00:00Z',
    updated_at: '2026-07-25T00:00:00Z',
    ...overrides,
  }
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useUserPortrait 整理轮询', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    ;(window as typeof window & {
      tabtin?: {
        agentEngine?: {
          invalidateUserPortraitCache?: typeof invalidatePortraitCacheMock
        }
      }
    }).tabtin = {
      agentEngine: {
        invalidateUserPortraitCache: invalidatePortraitCacheMock,
      },
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('任务尚未被 worker 领取时不把旧 idle 状态误判为完成', async () => {
    const baseline = portrait()
    const pending = portrait({
      last_distill_status: 'pending',
      updated_at: '2026-07-25T00:00:03Z',
    })
    const completed = portrait({
      content_md: '## 工作背景\n新画像',
      version: 2,
      last_distilled_at: '2026-07-25T00:00:06Z',
      updated_at: '2026-07-25T00:00:06Z',
    })

    getMyPortraitMock
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(completed)
    triggerDistillMock.mockResolvedValue(baseline)

    const { result, unmount } = renderHook(() => (
      useUserPortrait(ORGANIZATION_ID, AGENT_ID)
    ))
    await flushMicrotasks()

    await act(async () => {
      await result.current.triggerDistill()
    })
    expect(result.current.isDistilling).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(result.current.isDistilling).toBe(true)
    expect(result.current.portrait?.version).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(result.current.isDistilling).toBe(true)
    expect(result.current.portrait?.last_distill_status).toBe('pending')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(result.current.isDistilling).toBe(false)
    expect(result.current.isStillDistilling).toBe(false)
    expect(result.current.portrait?.version).toBe(2)
    expect(invalidatePortraitCacheMock).toHaveBeenCalled()

    unmount()
  })

  it('上一轮 failed 状态不会让新任务提前结束，只接受更新时间变化后的失败终态', async () => {
    const previousFailure = portrait({
      last_distill_status: 'failed',
      last_distill_error: '上一轮失败',
    })
    const finalFailure = portrait({
      last_distill_status: 'failed',
      last_distill_error: '本轮重试已耗尽',
      updated_at: '2026-07-25T00:00:06Z',
    })

    getMyPortraitMock
      .mockResolvedValueOnce(previousFailure)
      .mockResolvedValueOnce(previousFailure)
      .mockResolvedValueOnce(finalFailure)
    triggerDistillMock.mockResolvedValue(previousFailure)

    const { result, unmount } = renderHook(() => (
      useUserPortrait(ORGANIZATION_ID, AGENT_ID)
    ))
    await flushMicrotasks()

    await act(async () => {
      await result.current.triggerDistill()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(result.current.isDistilling).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(result.current.isDistilling).toBe(false)
    expect(result.current.portrait?.last_distill_error).toBe('本轮重试已耗尽')

    unmount()
  })

  it('打开面板时后端已是 pending 会自动接续轮询', async () => {
    const pending = portrait({
      last_distill_status: 'pending',
      updated_at: '2026-07-25T00:00:03Z',
    })
    const completed = portrait({
      content_md: '## 工作背景\n后台完成后的新画像',
      version: 2,
      last_distilled_at: '2026-07-25T00:00:06Z',
      updated_at: '2026-07-25T00:00:06Z',
    })
    getMyPortraitMock
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(completed)

    const { result, unmount } = renderHook(() => (
      useUserPortrait(ORGANIZATION_ID, AGENT_ID)
    ))
    await flushMicrotasks()

    expect(result.current.isDistilling).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(result.current.isDistilling).toBe(false)
    expect(result.current.portrait?.version).toBe(2)

    unmount()
  })

  it('快速重复点击只派发一个整理请求', async () => {
    const baseline = portrait({ accepted: true })
    let resolveRequest: ((value: UserPortrait) => void) | undefined
    triggerDistillMock.mockReturnValue(new Promise<UserPortrait>((resolve) => {
      resolveRequest = resolve
    }))
    getMyPortraitMock.mockResolvedValue(baseline)

    const { result, unmount } = renderHook(() => (
      useUserPortrait(ORGANIZATION_ID, AGENT_ID)
    ))
    await flushMicrotasks()

    let firstRequest: Promise<UserPortrait>
    let secondRequest: Promise<UserPortrait>
    act(() => {
      firstRequest = result.current.triggerDistill()
      secondRequest = result.current.triggerDistill()
    })
    expect(triggerDistillMock).toHaveBeenCalledTimes(1)
    expect(firstRequest!).toBe(secondRequest!)

    await act(async () => {
      resolveRequest?.(baseline)
      await firstRequest!
    })
    unmount()
  })
})
