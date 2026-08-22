import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HandoffComposerDialog } from './HandoffComposerDialog'

const mocks = vi.hoisted(() => {
  type Member = Record<string, unknown>
  type RefreshMembers = (
    conversationId: string,
    options?: { supersede?: boolean; invalidateSnapshot?: boolean },
  ) => Promise<void>
  type State = {
    conversationMembers: Record<string, Member[] | undefined>
    conversationMembersLoading: Record<string, boolean>
    refreshConversationMembers: RefreshMembers
  }
  const listeners = new Set<() => void>()
  const refreshConversationMembers = vi.fn<RefreshMembers>(async () => undefined)
  let state: State = {
    conversationMembers: {},
    conversationMembersLoading: {},
    refreshConversationMembers,
  }
  return {
    createHandoff: vi.fn(async () => undefined),
    ensureProfiles: vi.fn(),
    refreshConversationMembers,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setMembers: (members: Member[] | undefined) => {
      state = {
        ...state,
        conversationMembers: {
          ...state.conversationMembers,
          'group-1': members,
        },
      }
      listeners.forEach((listener) => listener())
    },
    setLoading: (loading: boolean) => {
      state = {
        ...state,
        conversationMembersLoading: {
          ...state.conversationMembersLoading,
          'group-1': loading,
        },
      }
      listeners.forEach((listener) => listener())
    },
    reset: () => {
      state = {
        conversationMembers: {},
        conversationMembersLoading: {},
        refreshConversationMembers,
      }
      listeners.clear()
    },
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div>{children}</div> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => (
    selector({ user: { id: 'user-1' } })
  ),
}))

vi.mock('@stores/useIMStore', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react')
  type State = ReturnType<typeof mocks.getState>
  const useIMStore = Object.assign(
    <T,>(selector: (state: State) => T): T => (
      ReactModule.useSyncExternalStore(
        mocks.subscribe,
        () => selector(mocks.getState()),
        () => selector(mocks.getState()),
      )
    ),
    { getState: mocks.getState },
  )
  return { useIMStore }
})

vi.mock('@stores/useUserProfileCache', () => ({
  useDisplayName: () => '',
  useUserProfileCache: (
    selector: (state: { ensureProfiles: typeof mocks.ensureProfiles }) => unknown,
  ) => selector({ ensureProfiles: mocks.ensureProfiles }),
}))

vi.mock('@/services/tabchatApi', () => ({
  createHandoff: mocks.createHandoff,
}))

vi.mock('./ColorAvatar', () => ({
  ColorAvatar: ({ name }: { name: string }) => <span aria-hidden>{name.slice(0, 1)}</span>,
}))

const member = (userId: string, nickname: string) => ({
  member_type: 'user' as const,
  user_id: userId,
  agent_id: null,
  nickname,
  username: nickname.toLowerCase(),
  avatar: '',
  role: 1,
  is_muted: false,
  pinned: false,
  joined_at: null,
})

describe('HandoffComposerDialog member snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reset()
  })

  it('首次打开且只有一个候选时自动选择该成员', async () => {
    mocks.setMembers([member('user-2', 'Bob')])
    render(
      <HandoffComposerDialog
        open
        onOpenChange={vi.fn()}
        conversationId="group-1"
        sourceMessage={null}
      />,
    )

    const submit = screen.getByRole('button', { name: '发送交接' })
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    expect(mocks.refreshConversationMembers).toHaveBeenCalledWith('group-1', {
      supersede: true,
      invalidateSnapshot: true,
    })
    fireEvent.click(submit)

    await waitFor(() => {
      expect(mocks.createHandoff).toHaveBeenCalledWith({
        conversationId: 'group-1',
        goal: '上下文交接',
        recipients: ['user-2'],
        references: [],
      })
    })
  })

  it('已选成员退出后不会自动改发给剩余成员', async () => {
    mocks.setMembers([
      member('user-2', 'Alice'),
      member('user-3', 'Bob'),
    ])
    render(
      <HandoffComposerDialog
        open
        onOpenChange={vi.fn()}
        conversationId="group-1"
        sourceMessage={null}
      />,
    )

    await act(async () => {
      await mocks.refreshConversationMembers.mock.results[0]?.value
    })
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }))
    const submit = screen.getByRole('button', { name: '发送交接' })
    expect((submit as HTMLButtonElement).disabled).toBe(false)

    act(() => {
      mocks.setMembers([member('user-3', 'Bob')])
    })

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Alice' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Bob' })).toBeTruthy()
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(submit)
    expect(mocks.createHandoff).not.toHaveBeenCalled()
  })

  it('本次打开的校准完成前不展示或提交旧成员', async () => {
    let resolveRefresh!: () => void
    mocks.setMembers([member('user-2', 'Alice')])
    mocks.refreshConversationMembers.mockImplementationOnce(() => {
      mocks.setLoading(true)
      return new Promise<void>((resolve) => { resolveRefresh = resolve })
    })

    render(
      <HandoffComposerDialog
        open
        onOpenChange={vi.fn()}
        conversationId="group-1"
        sourceMessage={null}
      />,
    )

    const submit = screen.getByRole('button', { name: '发送交接' })
    expect(screen.queryByRole('button', { name: 'Alice' })).toBeNull()
    expect(screen.getByText('正在更新成员…')).toBeTruthy()
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(submit)
    expect(mocks.createHandoff).not.toHaveBeenCalled()

    act(() => {
      mocks.setMembers([member('user-3', 'Bob')])
      mocks.setLoading(false)
      resolveRefresh()
    })

    expect(await screen.findByRole('button', { name: 'Bob' })).toBeTruthy()
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
  })
})
