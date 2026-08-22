/**
 * ：助手消息 footer 单轮计时（credits 旁）。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import type { ChatMessage } from '@tabtin/chat-client'

let debugEnabled = true
vi.mock('@/utils/featureFlags', () => ({
  get DEBUG_PANELS_ENABLED() {
    return debugEnabled
  },
}))

let mockState: {
  runStateBySessionId: Record<string, { startedAt?: number | null; endedAt?: number | null }>
} = { runStateBySessionId: {} }

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: (selector: (s: unknown) => unknown) => selector(mockState),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'defaultValue' in opts ? (opts.defaultValue as string) : key,
  }),
}))

vi.mock('../../panel/ChatIconTooltip', () => ({
  ChatIconTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { MessageRoundTimingLabel, formatRoundDuration } from '../messages/common/MessageRoundTimingLabel'

const SESSION = 'sess-1'
const T0 = 1_000_000_000

function assistant(partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'hi',
    created_at: new Date(T0).toISOString(),
    ...partial,
  } as ChatMessage
}

describe('formatRoundDuration', () => {
  it('formats under 60s with one decimal', () => {
    expect(formatRoundDuration(12300)).toBe('12.3s')
  })

  it('formats over 60s as Xm YYs', () => {
    expect(formatRoundDuration(65000)).toBe('1m 05s')
  })
})

describe('MessageRoundTimingLabel ', () => {
  beforeEach(() => {
    debugEnabled = true
    mockState = { runStateBySessionId: {} }
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('优先展示 metadata.round_duration_ms 定格值', () => {
    render(
      <MessageRoundTimingLabel
        sessionId={SESSION}
        message={assistant({ metadata: { round_duration_ms: 4500 } })}
        isLastAssistantMsg
      />,
    )
    expect(screen.getByTestId('message-round-timing').textContent).toContain('4.5s')
  })

  it('最后一条 assistant 且 run 进行中 → 实时跳动', () => {
    mockState.runStateBySessionId[SESSION] = { startedAt: T0 - 5000, endedAt: null }
    render(
      <MessageRoundTimingLabel
        sessionId={SESSION}
        message={assistant()}
        isLastAssistantMsg
      />,
    )
    expect(screen.getByText('5.0s')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('6.0s')).toBeTruthy()
  })

  it('#6529 endedAt 写入后停止跳动（定格）', () => {
    mockState.runStateBySessionId[SESSION] = { startedAt: T0 - 5000, endedAt: T0 }
    const { rerender } = render(
      <MessageRoundTimingLabel
        sessionId={SESSION}
        message={assistant()}
        isLastAssistantMsg
      />,
    )
    expect(screen.getByText('5.0s')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    // 仍定格在 endedAt - startedAt，不随 now 增长
    expect(screen.getByText('5.0s')).toBeTruthy()
    rerender(
      <MessageRoundTimingLabel
        sessionId={SESSION}
        message={assistant()}
        isLastAssistantMsg
      />,
    )
    expect(screen.getByText('5.0s')).toBeTruthy()
  })

  it('非最后一条 assistant 且无 metadata → 不渲染', () => {
    mockState.runStateBySessionId[SESSION] = { startedAt: T0 - 5000, endedAt: null }
    const { container } = render(
      <MessageRoundTimingLabel
        sessionId={SESSION}
        message={assistant()}
        isLastAssistantMsg={false}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('debug 关闭时不渲染', () => {
    debugEnabled = false
    const { container } = render(
      <MessageRoundTimingLabel
        sessionId={SESSION}
        message={assistant({ metadata: { round_duration_ms: 1000 } })}
        isLastAssistantMsg
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('user 消息不渲染', () => {
    const { container } = render(
      <MessageRoundTimingLabel
        sessionId={SESSION}
        message={{ ...assistant(), role: 'user' }}
        isLastAssistantMsg
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
