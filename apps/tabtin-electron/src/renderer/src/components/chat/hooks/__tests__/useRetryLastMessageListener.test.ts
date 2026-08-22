import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRetryLastMessageListener } from '../useRetryLastMessageListener'
import type { ChatMessage } from '@tabtin/chat-client'

function userMsg(
  id: string,
  content: string,
  extras?: Partial<ChatMessage>,
): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    created_at: '2026-07-21T00:00:00Z',
    ...extras,
  } as ChatMessage
}

describe('useRetryLastMessageListener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('主栏：detail.sessionId 缺省时续跑当前会话', () => {
    const onContinue = vi.fn()
    renderHook(() => useRetryLastMessageListener({
      sessionId: 'sess-a',
      isStreaming: false,
      messages: [userMsg('u1', 'hello')],
      onContinue,
    }))

    window.dispatchEvent(new CustomEvent('chat:retry-last-message', { detail: {} }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('分屏：requireExplicitSessionMatch 时缺省 sessionId 不触发', () => {
    const onContinue = vi.fn()
    renderHook(() => useRetryLastMessageListener({
      sessionId: 'sess-a',
      isStreaming: false,
      messages: [userMsg('u1', 'hello')],
      onContinue,
      requireExplicitSessionMatch: true,
    }))

    window.dispatchEvent(new CustomEvent('chat:retry-last-message', { detail: {} }))
    expect(onContinue).not.toHaveBeenCalled()

    window.dispatchEvent(new CustomEvent('chat:retry-last-message', {
      detail: { sessionId: 'sess-a' },
    }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('streaming 中不续跑', () => {
    const onContinue = vi.fn()
    renderHook(() => useRetryLastMessageListener({
      sessionId: 'sess-a',
      isStreaming: true,
      messages: [userMsg('u1', 'hello')],
      onContinue,
    }))

    window.dispatchEvent(new CustomEvent('chat:retry-last-message', {
      detail: { sessionId: 'sess-a' },
    }))
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('额度墙重试跳过 push-notification，只要有真实用户轮次就续跑', () => {
    const onContinue = vi.fn()
    renderHook(() => useRetryLastMessageListener({
      sessionId: 'sess-a',
      isStreaming: false,
      messages: [
        userMsg('u1', '打开小红书笔记'),
        userMsg('push-1', '3 background commands completed…\n\n<task-notification>', {
          metadata: { triggered_by: 'push-notification' },
        }),
      ],
      onContinue,
    }))

    window.dispatchEvent(new CustomEvent('chat:retry-last-message', { detail: {} }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('纯附件用户轮（空正文）仍可续跑', () => {
    const onContinue = vi.fn()
    renderHook(() => useRetryLastMessageListener({
      sessionId: 'sess-a',
      isStreaming: false,
      messages: [userMsg('u1', '', {
        attachments_json: [{ type: 'image', filename: 'a.png' }],
      })],
      onContinue,
    }))

    window.dispatchEvent(new CustomEvent('chat:retry-last-message', { detail: {} }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('主栏与分屏同时监听时同一事件只续跑一次', () => {
    const onContinueMain = vi.fn()
    const onContinueSplit = vi.fn()
    renderHook(() => useRetryLastMessageListener({
      sessionId: 'sess-a',
      isStreaming: false,
      messages: [userMsg('u1', 'hello')],
      onContinue: onContinueMain,
    }))
    renderHook(() => useRetryLastMessageListener({
      sessionId: 'sess-a',
      isStreaming: false,
      messages: [userMsg('u1', 'hello')],
      onContinue: onContinueSplit,
      requireExplicitSessionMatch: true,
    }))

    window.dispatchEvent(new CustomEvent('chat:retry-last-message', {
      detail: { sessionId: 'sess-a' },
    }))
    expect(onContinueMain.mock.calls.length + onContinueSplit.mock.calls.length).toBe(1)
  })

  it('没有真实用户轮次时不续跑', () => {
    const onContinue = vi.fn()
    renderHook(() => useRetryLastMessageListener({
      sessionId: 'sess-a',
      isStreaming: false,
      messages: [
        userMsg('push-1', 'background done', {
          metadata: { triggered_by: 'push-notification' },
        }),
      ],
      onContinue,
    }))

    window.dispatchEvent(new CustomEvent('chat:retry-last-message', { detail: {} }))
    expect(onContinue).not.toHaveBeenCalled()
  })
})
