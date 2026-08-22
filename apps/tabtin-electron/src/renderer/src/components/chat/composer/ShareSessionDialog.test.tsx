import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareSessionDialog } from './ShareSessionDialog'

const mocks = vi.hoisted(() => ({
  createSessionContinuation: vi.fn(),
  createSessionShareFromChat: vi.fn(),
  searchOrganizationMembers: vi.fn(async () => [{
    id: 'user-2',
    nickname: 'zsc2',
    username: 'zsc2',
    avatar: '',
    email: '',
  }]),
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
}))

vi.mock('@/services/sessionShareApi', () => ({
  createSessionShareFromChat: mocks.createSessionShareFromChat,
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({
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
      target: { value: 'bob' },
    })

    await waitFor(() => {
      expect(mocks.searchOrganizationMembers).toHaveBeenLastCalledWith('org-1', 'bob')
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
})
