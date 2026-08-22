/**
 * ：侧栏 SessionStatusIcon 读统一 runProjection.busy。
 * 覆盖 busy → idle 后蓝圈（Loader2 spin）收口。
 */

import React from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession, ChatSessionRunState } from '@tabtin/chat-client'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import {
  applyRuntimeRunSync,
  applySessionRunStateSnapshot,
} from '@/stores/chat/execution/sessionRunProjection'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
    i18n: { language: 'zh-CN' },
  }),
}))

const chatStoreState = vi.hoisted(() => ({
  pendingAskUserBySessionId: {} as Record<string, unknown>,
  pendingApprovalBySessionId: {} as Record<string, unknown>,
  messagesBySessionId: {} as Record<string, unknown[]>,
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: typeof chatStoreState) => unknown) => selector(chatStoreState),
    { getState: () => chatStoreState },
  ),
}))

vi.mock('@/stores/useWsConnectionStore', () => ({
  useWsConnectionStore: (selector: (s: { suspendedSessionIds: string[] }) => unknown) =>
    selector({ suspendedSessionIds: [] }),
}))

function makeSession(id: string): ChatSession {
  return {
    id,
    title: 'test',
    message_count: 2,
    status: 'active',
  } as ChatSession
}

function makeRunState(
  status: ChatSessionRunState['status'],
  errorClass: string | null = status === 'failed' ? 'provider_error' : null,
): ChatSessionRunState {
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
  return {
    run_id: 'run-sidebar',
    sequence: 1,
    revision: 1,
    status,
    queue_depth: 0,
    started_at: null,
    state_changed_at: '2026-07-28T10:00:00Z',
    ended_at: terminal ? '2026-07-28T10:00:01Z' : null,
    stop_reason: null,
    error_class: errorClass,
    waiting_interaction_id: null,
  }
}

describe('#4985 SessionStatusIcon · runProjection.busy', () => {
  beforeEach(() => {
    useChatRuntimeStore.setState({ runProjectionBySessionId: {} })
    chatStoreState.pendingAskUserBySessionId = {}
    chatStoreState.pendingApprovalBySessionId = {}
    chatStoreState.messagesBySessionId = {}
  })

  it('busy 显示蓝色转圈；run_sync idle 后收口（无 spin）', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = makeSession('sess-sidebar-a')

    applyRuntimeRunSync(session.id, {
      session_id: session.id,
      run_id: 'run-1',
      status: 'running',
      seq: 1,
      queued_run_ids: [],
    })
    const { container, rerender } = render(<SessionStatusIcon session={session} />)
    expect(container.querySelector('.animate-spin')).toBeTruthy()
    expect(container.querySelector('.text-accent')).toBeTruthy()

    act(() => {
      applyRuntimeRunSync(session.id, {
        session_id: session.id,
        run_id: null,
        status: 'idle',
        seq: 2,
        queued_run_ids: [],
      })
    })
    rerender(<SessionStatusIcon session={session} />)
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('title_generation_status=failed 时不展示失败徽标（idle 无图标）', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = {
      ...makeSession('sess-title-failed'),
      title_generation_status: 'failed' as const,
    }

    const { container } = render(<SessionStatusIcon session={session} />)
    expect(container.querySelector('[aria-label="标题生成失败,将自动重试"]')).toBeNull()
    expect(container.querySelector('[aria-label="上次运行失败"]')).toBeNull()
    expect(container.querySelector('.text-destructive\\/80')).toBeNull()
  })

  it('title_generation_status=failed 时仍展示上次运行失败（不被标题失败徽标抢占）', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = {
      ...makeSession('sess-title-and-run-failed'),
      title_generation_status: 'failed' as const,
    }

    chatStoreState.messagesBySessionId = {
      [session.id]: [
        {
          role: 'assistant',
          error_info_json: {
            error_class: 'LLM_PROVIDER_ERROR',
            error_message: '7476 coexistence probe',
            category: 'runtime_failed',
          },
        },
      ],
    }

    const { container } = render(<SessionStatusIcon session={session} />)
    expect(container.querySelector('[aria-label="标题生成失败,将自动重试"]')).toBeNull()
    expect(container.querySelector('[aria-label="上次运行失败"]')).toBeTruthy()
    expect(container.querySelector('.text-destructive\\/80')).toBeTruthy()
  })

  it('冷启动从 session.run_state 恢复 running 蓝色转圈', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = { ...makeSession('sess-cold-running'), run_state: makeRunState('running') }
    const { container } = render(<SessionStatusIcon session={session} />)

    expect(container.querySelector('.animate-spin')).toBeTruthy()
    expect(container.querySelector('.text-accent')).toBeTruthy()
  })

  it('服务端 failed 显示红色感叹号', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = { ...makeSession('sess-failed'), run_state: makeRunState('failed') }
    const { container } = render(<SessionStatusIcon session={session} />)

    expect(container.querySelector('.text-destructive\\/80')).toBeTruthy()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('#9048：已消警的余额不足 failed 不再显示侧栏失败徽标', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = {
      ...makeSession('sess-billing-resolved'),
      run_state: makeRunState('failed', 'LLM_BILLING_ERROR'),
    }
    chatStoreState.messagesBySessionId[session.id] = [{
      id: 'assistant-billing',
      role: 'assistant',
      metadata: {
        errorCategory: 'organization_insufficient_credits',
        errorClass: 'LLM_BILLING_ORG_INSUFFICIENT',
        billingErrorResolved: true,
      },
    }]

    const { container } = render(<SessionStatusIcon session={session} />)

    expect(container.querySelector('[aria-label="上次运行失败"]')).toBeNull()
    expect(container.querySelector('.text-destructive\\/80')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('#9048：未消警的余额不足 failed 仍显示侧栏失败徽标', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = {
      ...makeSession('sess-billing-unresolved'),
      run_state: makeRunState('failed', 'LLM_BILLING_ERROR'),
    }
    chatStoreState.messagesBySessionId[session.id] = [{
      id: 'assistant-billing',
      role: 'assistant',
      metadata: {
        errorCategory: 'organization_insufficient_credits',
        errorClass: 'LLM_BILLING_ORG_INSUFFICIENT',
      },
    }]

    const { container } = render(<SessionStatusIcon session={session} />)

    expect(container.querySelector('[aria-label="上次运行失败"]')).toBeTruthy()
    expect(container.querySelector('.text-destructive\\/80')).toBeTruthy()
  })

  it('completed 且本地未读显示蓝色实心点', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = { ...makeSession('sess-completed'), run_state: makeRunState('completed') }
    const { container } = render(<SessionStatusIcon session={session} unread />)

    expect(container.querySelector('.bg-accent')).toBeTruthy()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('用户取消为中性完成，不被 aborted assistant 误判为 failed', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = makeSession('sess-cancelled')
    chatStoreState.messagesBySessionId[session.id] = [{
      id: 'assistant-aborted',
      role: 'assistant',
      intent: 'interrupted',
      stop_reason: 'aborted',
    }]
    applySessionRunStateSnapshot({
      ...session,
      run_state: makeRunState('cancelled'),
    })
    const { container } = render(<SessionStatusIcon session={session} unread />)

    expect(container.querySelector('.text-destructive\\/80')).toBeNull()
    expect(container.querySelector('.bg-accent')).toBeNull()
  })

  it('新后端显式 null 不再启用旧消息错误启发式', async () => {
    const { SessionStatusIcon } = await import('../SessionStatusIcon')
    const session = { ...makeSession('sess-null-state'), run_state: null }
    chatStoreState.messagesBySessionId[session.id] = [{
      id: 'assistant-legacy-error',
      role: 'assistant',
      is_error: true,
    }]
    const { container } = render(<SessionStatusIcon session={session} />)

    expect(container.querySelector('.text-destructive\\/80')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})
