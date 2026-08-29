import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareSessionDialog } from './ShareSessionDialog'

const mocks = vi.hoisted(() => ({
  createSessionContinuation: vi.fn(),
  createSessionShareFromChat: vi.fn(),
  createDM: vi.fn(),
  searchOrganizationMembers: vi.fn(async () => [{
    id: 'user-2',
    nickname: 'zsc2',
    username: 'zsc2',
    avatar: '',
    email: '',
  }]),
  conversations: [] as Array<{
    id: string
    organization_id: string
    type: number
    dm_peer_user_id: string | null
  }>,
  setSessionContinuation: vi.fn(),
  onOpenChange: vi.fn(),
  translate: (_key: string, options?: Record<string, string>) => {
    let value = options?.defaultValue ?? _key
    for (const [name, replacement] of Object.entries(options ?? {})) {
      if (name !== 'defaultValue') value = value.replace(`{{${name}}}`, replacement)
    }
    return value
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
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
  ConfirmDialog: ({
    open,
    title,
    confirmText,
    cancelText,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean
    title: string
    confirmText: string
    cancelText: string
    onConfirm: () => Promise<void>
    onOpenChange: (open: boolean) => void
  }) => open ? (
    <div role="alertdialog">
      <div>{title}</div>
      <button onClick={() => onOpenChange(false)}>{cancelText}</button>
      <button onClick={() => { void onConfirm() }}>{confirmText}</button>
    </div>
  ) : null,
  toast: vi.fn(),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => (
    selector({ user: { id: 'user-1' } })
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { selectedOrganization: { id: string } }) => unknown) => (
    selector({ selectedOrganization: { id: 'org-1' } })
  ),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { agentCache: object; selectedAgent: null }) => unknown) => (
    selector({ agentCache: {}, selectedAgent: null })
  ),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      sessionsBySpaceId: {
        'space-1': [{ id: 'session-1', title: '季度经营复盘', status: 'active' }],
      },
      messagesBySessionId: {
        'session-1': [{ role: 'user' }, { role: 'assistant' }],
      },
    }),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  searchOrganizationMembers: mocks.searchOrganizationMembers,
  createSessionContinuation: mocks.createSessionContinuation,
  createDM: mocks.createDM,
  isContinuationLocalFileTooLargeError: (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'LOCAL_FILE_TOO_LARGE'
  ),
}))

vi.mock('@/services/sessionShareApi', () => ({
  createSessionShareFromChat: mocks.createSessionShareFromChat,
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({
      conversations: mocks.conversations,
      setSessionContinuation: mocks.setSessionContinuation,
      bumpSessionShareListVersion: vi.fn(),
      patchSessionShare: vi.fn(),
      bumpSessionShareDetailVersion: vi.fn(),
    }),
  },
}))

vi.mock('@components/tabchat/ColorAvatar', () => ({
  ColorAvatar: ({ name }: { name: string }) => <span>{name}</span>,
}))

vi.mock('@components/chat/model/resolveAgentDisplayName', () => ({
  resolveCurrentAgentDisplay: () => null,
}))

vi.mock('@components/tabchat/sessionSharePresentation', () => ({
  SessionShareModeField: ({
    value,
    onChange,
  }: {
    value: string
    onChange: (value: 'view' | 'fork' | 'control' | 'continue') => void
  }) => (
    <select
      aria-label="协作方式"
      value={value}
      onChange={(event) => onChange(event.target.value as 'view' | 'fork' | 'control' | 'continue')}
    >
      <option value="view">实时查看</option>
      <option value="control">实时协作</option>
      <option value="continue">交给同事继续</option>
    </select>
  ),
  shareTierToFlags: () => ({ canFork: false, canChat: false }),
}))

vi.mock('@components/tabchat/sessionSharePendingIntent', () => ({
  buildSessionShareIntentKey: () => 'intent-key',
  forgetPendingShareIntent: vi.fn(),
  rememberPendingShareIntent: vi.fn(),
  resolvePendingShareClientRequestId: () => '019fcaa1-7777-7777-8777-777777777777',
}))

describe('ShareSessionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.conversations = []
    mocks.createDM.mockResolvedValue({ conversation_id: 'dm-created' })
    mocks.createSessionShareFromChat.mockResolvedValue({
      id: 'share-1',
      session_id: 'session-1',
      conversation_id: 'dm-created',
    })
    mocks.createSessionContinuation.mockResolvedValue({
      object_id: 'continuation-1',
      version: 2,
      role: 'owner',
      title_snapshot: '季度经营复盘',
    })
  })

  it('does not show stale members while a new search is pending', async () => {
    render(
      <ShareSessionDialog
        open
        onOpenChange={mocks.onOpenChange}
        sessionId="session-1"
        spaceId="space-1"
      />,
    )

    expect(await screen.findByRole('button', { name: /zsc2/ })).toBeTruthy()

    mocks.searchOrganizationMembers.mockImplementationOnce(() => new Promise(() => undefined))
    fireEvent.change(screen.getByPlaceholderText('搜索同事'), {
      target: { value: 'huchenxi' },
    })

    await waitFor(() => {
      expect(mocks.searchOrganizationMembers).toHaveBeenLastCalledWith('org-1', 'huchenxi')
    })
    expect(screen.queryByRole('button', { name: /zsc2/ })).toBeNull()
    expect(screen.getByText('搜索中…')).toBeTruthy()
  })

  it('sends a frozen continuation instead of granting access to the original task', async () => {
    render(
      <ShareSessionDialog
        open
        onOpenChange={mocks.onOpenChange}
        sessionId="session-1"
        spaceId="space-1"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /zsc2/ }))
    fireEvent.change(screen.getByRole('combobox', { name: '协作方式' }), {
      target: { value: 'continue' },
    })
    fireEvent.click(screen.getByRole('button', { name: '交给 zsc2' }))

    await waitFor(() => {
      expect(mocks.createSessionContinuation).toHaveBeenCalledWith({
        sourceSessionId: 'session-1',
        recipientUserId: 'user-2',
        clientRequestId: '019fcaa1-7777-7777-8777-777777777777',
      })
    })
    expect(mocks.createSessionShareFromChat).not.toHaveBeenCalled()
    expect(mocks.setSessionContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: 'continuation-1' }),
    )
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('can retry an oversized handoff as dialogue only with the same request id', async () => {
    mocks.createSessionContinuation
      .mockRejectedValueOnce(Object.assign(new Error('分享会话文件超过50MB'), {
        code: 'LOCAL_FILE_TOO_LARGE',
        status: 409,
      }))
      .mockResolvedValueOnce({
        object_id: 'continuation-text-only',
        version: 2,
        role: 'owner',
        title_snapshot: '季度经营复盘',
      })

    render(
      <ShareSessionDialog
        open
        onOpenChange={mocks.onOpenChange}
        sessionId="session-1"
        spaceId="space-1"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /zsc2/ }))
    fireEvent.change(screen.getByRole('combobox', { name: '协作方式' }), {
      target: { value: 'continue' },
    })
    fireEvent.click(screen.getByRole('button', { name: '交给 zsc2' }))

    expect(await screen.findByText(
      '分享会话文件超过50MB，是否选择只交接对话，不交接上下文',
    )).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确定' }))

    await waitFor(() => expect(mocks.createSessionContinuation).toHaveBeenCalledTimes(2))
    expect(mocks.createSessionContinuation).toHaveBeenNthCalledWith(2, {
      sourceSessionId: 'session-1',
      recipientUserId: 'user-2',
      clientRequestId: '019fcaa1-7777-7777-8777-777777777777',
      includeContext: false,
    })
    expect(mocks.setSessionContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: 'continuation-text-only' }),
    )
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reuses the current-org DM when sharing a new Agent session', async () => {
    mocks.conversations = [{
      id: 'dm-existing',
      organization_id: 'org-1',
      type: 1,
      dm_peer_user_id: 'user-2',
    }]

    render(
      <ShareSessionDialog
        open
        onOpenChange={mocks.onOpenChange}
        sessionId="session-1"
        spaceId="space-1"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /zsc2/ }))
    fireEvent.click(screen.getByRole('button', { name: '发给 zsc2' }))

    await waitFor(() => {
      expect(mocks.createSessionShareFromChat).toHaveBeenCalledWith({
        session_id: 'session-1',
        grantee_user_id: 'user-2',
        can_fork: false,
        can_chat: false,
        client_request_id: '019fcaa1-7777-7777-8777-777777777777',
        conversation_id: 'dm-existing',
      })
    })
    expect(mocks.createDM).not.toHaveBeenCalled()
  })

  it('creates the current-org DM before sharing when the list does not have one', async () => {
    render(
      <ShareSessionDialog
        open
        onOpenChange={mocks.onOpenChange}
        sessionId="session-1"
        spaceId="space-1"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /zsc2/ }))
    fireEvent.click(screen.getByRole('button', { name: '发给 zsc2' }))

    await waitFor(() => {
      expect(mocks.createDM).toHaveBeenCalledWith('org-1', 'user-2')
      expect(mocks.createSessionShareFromChat).toHaveBeenCalledWith(
        expect.objectContaining({ conversation_id: 'dm-created' }),
      )
    })
  })
})
