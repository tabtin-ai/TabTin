import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionCollaborationCardController } from './SessionCollaborationCardController'

const mocks = vi.hoisted(() => {
  const detail = {
    object_id: 'share-1',
    role: 'recipient',
    phase: 'awaitingJoin',
    version: 2,
    session_id: null,
    session_title: '调研东南亚协作工具',
    owner_display_name: 'zsc1',
    actions: { can_join: true, can_open: false },
  }
  const state = {
    sessionShares: {
      'share-1': { detail, loadState: 'loaded' },
    },
  }
  return {
    state,
    accept: vi.fn(),
    load: vi.fn(),
    setShare: vi.fn((next) => {
      state.sessionShares['share-1'].detail = next
    }),
    openSharedSessionInIm: vi.fn(() => true),
    toast: vi.fn(),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}))

vi.mock('@components/ui', () => ({ toast: mocks.toast }))
vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => ({
        loadSessionShareV2: mocks.load,
        setSessionShare: mocks.setShare,
      }),
    },
  ),
}))
vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: { getState: () => ({ selectedOrganization: null }) },
}))
vi.mock('@/components/chat/shared-view/openSharedSessionInIm', () => ({
  openSharedSessionInIm: mocks.openSharedSessionInIm,
}))
vi.mock('@/services/tabchatApi', () => ({
  acceptSessionShareV2: mocks.accept,
  retrySessionShareV2Delivery: vi.fn(),
}))
vi.mock('./useSharedTaskLive', () => ({
  useSharedTaskLive: (detail: { live?: unknown } | null) => detail?.live ?? null,
}))

describe('SessionCollaborationCardController', () => {
  beforeEach(() => {
    mocks.state.sessionShares['share-1'].detail = {
      object_id: 'share-1',
      role: 'recipient',
      phase: 'awaitingJoin',
      version: 2,
      session_id: null,
      session_title: '调研东南亚协作工具',
      owner_display_name: 'zsc1',
      actions: { can_join: true, can_open: false },
    }
    mocks.accept.mockReset()
    mocks.load.mockReset()
    mocks.setShare.mockClear()
    mocks.openSharedSessionInIm.mockClear()
  })

  it('changes from pending confirmation to participating after the recipient confirms', async () => {
    let resolveAccept: (value: unknown) => void = () => undefined
    mocks.accept.mockReturnValue(new Promise((resolve) => {
      resolveAccept = resolve
    }))

    render(
      <SessionCollaborationCardController
        conversationId="conversation-1"
        card={{
          object_id: 'share-1',
          version: 2,
          title_snapshot: '调研东南亚协作工具',
        } as never}
      />,
    )

    expect(screen.getAllByText('待确认')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '确认加入任务' }))
    const confirming = screen.getByRole('button', { name: '确认中' }) as HTMLButtonElement
    expect(confirming.disabled).toBe(true)
    expect(confirming.getAttribute('aria-busy')).toBe('true')

    const active = {
      ...mocks.state.sessionShares['share-1'].detail,
      phase: 'activeView',
      version: 3,
      session_id: 'session-1',
      actions: { can_join: false, can_open: true },
    }
    await act(async () => {
      resolveAccept(active)
    })

    expect(mocks.accept).toHaveBeenCalledWith('share-1')
    expect(screen.getByText('参与中')).toBeTruthy()
    expect(screen.getByText('可实时查看，不可操作对方现场')).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看任务' })).toBeTruthy()
  })

  it('does not expose the internal card version to the owner', () => {
    mocks.state.sessionShares['share-1'].detail = {
      ...mocks.state.sessionShares['share-1'].detail,
      role: 'owner',
      version: 3,
      actions: { can_join: false, can_open: true },
    }

    render(
      <SessionCollaborationCardController
        conversationId="conversation-1"
        card={{
          object_id: 'share-1',
          version: 3,
          title_snapshot: '调研东南亚协作工具',
        } as never}
      />,
    )

    expect(screen.queryByText('状态版本 3')).toBeNull()
  })
  it('opens the owner task in the current IM sidebar by clicking the card', () => {
    mocks.state.sessionShares['share-1'].detail = {
      ...mocks.state.sessionShares['share-1'].detail,
      role: 'owner',
      phase: 'activeView',
      session_id: 'session-1',
      grantee_display_name: 'zsc2',
      actions: { can_join: false, can_open: true },
    } as never

    render(
      <SessionCollaborationCardController
        conversationId="conversation-1"
        card={{ object_id: 'share-1', version: 3, title_snapshot: '调研东南亚协作工具' } as never}
      />,
    )

    expect(screen.getByText('对方可实时查看，不可操作我的现场')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开我的任务' }))
    expect(mocks.openSharedSessionInIm).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      shareId: 'share-1',
      incoming: false,
    }))
  })

  it('does not keep showing live elapsed time after sharing stops', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-15T08:01:00Z'))
      mocks.state.sessionShares['share-1'].detail = {
        ...mocks.state.sessionShares['share-1'].detail,
        role: 'owner',
        phase: 'stopped',
        session_id: 'session-1',
        actions: { can_join: false, can_open: true },
        live: {
          run_state: {
            run_id: 'run-1',
            status: 'running',
            started_at: '2026-08-15T08:00:00Z',
            state_changed_at: '2026-08-15T08:00:00Z',
            ended_at: null,
            stop_reason: null,
            error_class: null,
          },
          duration_ms: 60_000,
          step_count: 0,
          current_step: null,
          recent_steps: [],
          resources: [],
        },
      } as never

      render(
        <SessionCollaborationCardController
          conversationId="conversation-1"
          card={{ object_id: 'share-1', version: 3, title_snapshot: '调研东南亚协作工具' } as never}
        />,
      )

      expect(screen.getByText('已停止')).toBeTruthy()
      expect(screen.queryByText('最近一轮')).toBeNull()
      expect(screen.queryByText(/运行中/)).toBeNull()
      expect(screen.queryByText(/耗时/)).toBeNull()

      act(() => vi.advanceTimersByTime(1_000))
      expect(screen.queryByText(/运行中/)).toBeNull()
      expect(screen.queryByText(/耗时/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders the latest run time and status instead of an ambiguous step count', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-13T10:00:00Z'))
      mocks.state.sessionShares['share-1'].detail = {
        ...mocks.state.sessionShares['share-1'].detail,
        phase: 'activeView',
        session_id: 'session-1',
        actions: { can_join: false, can_open: true },
        live: {
          run_state: {
            run_id: 'run-1',
            status: 'completed',
            started_at: '2026-08-13T08:00:00Z',
            state_changed_at: '2026-08-13T08:04:00Z',
            ended_at: '2026-08-13T08:04:00Z',
            stop_reason: null,
            error_class: null,
          },
          duration_ms: 240_000,
          step_count: 2,
          current_step: null,
          recent_steps: [
            { id: 'step-1', title: '读取搜索结果第 3 页', status: 'done' },
            { id: 'step-2', title: '写入 notes-raw.json', status: 'done' },
          ],
          resources: [{ type: 'document', id: 'doc-1', label: '竞品笔记清单.md' }],
        },
      } as never

      render(
        <SessionCollaborationCardController
          conversationId="conversation-1"
          card={{ object_id: 'share-1', version: 3, title_snapshot: '调研东南亚协作工具' } as never}
        />,
      )

      const completedAt = new Date('2026-08-13T08:04:00Z').toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
      expect(screen.getByText('最近一轮')).toBeTruthy()
      expect(screen.getByText(`${completedAt} · 已完成`)).toBeTruthy()
      expect(screen.getByText('耗时 4 分钟')).toBeTruthy()
      expect(screen.queryByText(/2 步/)).toBeNull()
      expect(screen.queryByText('暂无运行步骤')).toBeNull()
      expect(screen.getByText('读取搜索结果第 3 页')).toBeTruthy()
      expect(screen.getByText('竞品笔记清单.md')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
