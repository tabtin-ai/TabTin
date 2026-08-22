import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'
import { ErrorClassCard } from './ErrorClassCard'

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@components/ui', () => ({ ConfirmDialog: () => null }))
vi.mock('@utils/cn', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }))
vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (state: { selectedSpace: null }) => unknown) => selector({ selectedSpace: null }),
    { getState: () => ({ selectedSpace: null }) },
  ),
}))
vi.mock('@/stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: { getState: () => ({ openSettings: vi.fn() }) },
}))
vi.mock('@/stores/useAgentSettingsSheetStore', () => ({
  useAgentSettingsSheetStore: (selector: (state: { open: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ open: vi.fn() }),
}))
vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: {
      currentSessionId: null
      sessions: []
      sessionsBySpaceId: Record<string, never>
    }) => unknown) =>
      selector({ currentSessionId: null, sessions: [], sessionsBySpaceId: {} }),
    { getState: () => ({ createSession: vi.fn() }) },
  ),
}))
vi.mock('@/stores/chat/messages/product/delivery/projectTaskSendGate', () => ({
  isProjectTaskEditAndResendBlocked: () => false,
}))
vi.mock('@/services/agentContextSwitchGuard', () => ({
  runWithAgentContextSwitchGuard: vi.fn(),
}))

const switchModelInfo = {
  title: '模型能力不匹配',
  suggestion: '请切换模型',
  severity: 'error' as const,
  retryable: false,
  suggestedAction: 'switch_model',
}

const networkErrorInfo = {
  title: '网络连接异常',
  suggestion: '对话连接中断，可点击重试或检查网络后再试',
  severity: 'warning' as const,
  retryable: true,
  suggestedAction: 'retry_later',
}

describe('ErrorClassCard · 共享会话模型动作', () => {
  beforeEach(() => {
    useSessionAccessStore.setState({ bySessionId: {} })
  })

  it('协作接收方不展示无法执行的切换模型按钮', () => {
    useSessionAccessStore.getState().setSharedAccess({
      shareId: 'share-1',
      sessionId: 'session-1',
      role: 'grantee',
    })

    render(<ErrorClassCard info={switchModelInfo} sessionId="session-1" />)

    expect(screen.queryByRole('button', { name: '换模型' })).toBeNull()
    expect(screen.getByText('共享任务的模型由任务所有者管理，请联系对方切换模型后重试。')).toBeTruthy()
  })

  it('任务所有者仍可从错误卡打开模型选择器', () => {
    const onOpen = vi.fn()
    window.addEventListener('chat:open-model-selector', onOpen)
    render(<ErrorClassCard info={switchModelInfo} sessionId="session-1" />)

    fireEvent.click(screen.getByRole('button', { name: '换模型' }))
    expect(onOpen).toHaveBeenCalledOnce()
    window.removeEventListener('chat:open-model-selector', onOpen)
  })

  it('协作接收方可从网络错误卡重试当前会话', () => {
    useSessionAccessStore.getState().setSharedAccess({
      shareId: 'share-1',
      sessionId: 'session-1',
      role: 'grantee',
    })
    const onRetry = vi.fn()
    window.addEventListener('chat:retry-last-message', onRetry)

    render(<ErrorClassCard info={networkErrorInfo} sessionId="session-1" />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(onRetry).toHaveBeenCalledOnce()
    expect((onRetry.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ sessionId: 'session-1' })
    window.removeEventListener('chat:retry-last-message', onRetry)
  })
})
