import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createSessionShare,
  listSessionShares,
  revokeSessionShare,
  setSessionShare,
  bumpSessionShareDetailVersion,
  loadSessionShareV2,
  ensureProfiles,
  createConversationAndActivate,
  setImSidebarView,
  listExternalContacts,
  organizationState,
} = vi.hoisted(() => ({
  createSessionShare: vi.fn(),
  listSessionShares: vi.fn(),
  revokeSessionShare: vi.fn(),
  setSessionShare: vi.fn(),
  bumpSessionShareDetailVersion: vi.fn(),
  loadSessionShareV2: vi.fn(),
  ensureProfiles: vi.fn(),
  createConversationAndActivate: vi.fn(),
  setImSidebarView: vi.fn(),
  listExternalContacts: vi.fn(),
  organizationState: { selectedOrganization: { id: 'org-1' } },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      let value = options?.defaultValue ?? key
      for (const [name, replacement] of Object.entries(options ?? {})) {
        if (name !== 'defaultValue') value = value.replace(`{{${name}}}`, replacement)
      }
      return value
    },
  }),
}))

vi.mock('@components/ui', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@utils/cn', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))

vi.mock('@/services/tabchatApi', () => ({
  createSessionShare,
  listSessionSharesBySession: listSessionShares,
  listExternalContacts,
  revokeSessionShare,
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof organizationState) => unknown) => (
    selector(organizationState)
  ),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({
      setSessionShare,
      bumpSessionShareDetailVersion,
      loadSessionShareV2,
      sessionShares: {},
      createConversationAndActivate,
      setImSidebarView,
    }),
  },
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: { getState: () => ({ ensureProfiles }) },
  useUserProfile: () => ({ nickname: '来源用户', username: 'source_user' }),
  useAvatar: () => 'https://example.com/source.png',
}))

vi.mock('@components/tabchat/ColorAvatar', () => ({
  ColorAvatar: ({ seed }: { seed?: string }) => (
    <span data-testid="collaborator-avatar" data-user-id={seed} />
  ),
}))

vi.mock('@components/tabchat/SessionShareGranteeList', () => ({
  SessionShareGranteeList: ({ shares, onRevoke, onResume }: {
    shares: Array<{ id: string }>
    onRevoke?: (share: never) => void
    onResume?: (share: never) => void
  }) => (
    <>
      <button type="button" onClick={() => onRevoke?.(shares[0] as never)}>
        cancel pending
      </button>
      <button type="button" onClick={() => onResume?.(shares[0] as never)}>
        resume revoked
      </button>
    </>
  ),
}))

vi.mock('@components/chat/composer/ShareSessionDialog', () => ({
  ShareSessionDialog: () => null,
}))

describe('SessionCollaborators', () => {
  beforeEach(() => {
    listSessionShares.mockReset()
    createSessionShare.mockReset()
    revokeSessionShare.mockReset()
    setSessionShare.mockReset()
    bumpSessionShareDetailVersion.mockReset()
    loadSessionShareV2.mockReset()
    ensureProfiles.mockReset()
    createConversationAndActivate.mockReset()
    setImSidebarView.mockReset()
    listExternalContacts.mockReset()
    organizationState.selectedOrganization = { id: 'org-1' }
    window.sessionStorage.clear()
  })

  it('共享接收态复用协作者头像样式显示来源用户，且不请求分享方管理列表', async () => {
    const { SessionCollaborators } = await import('./SessionCollaborators')
    render(
      <SessionCollaborators
        sessionId="shared-session-1"
        sourceUserId="owner-1"
        sourceDisplayName="分享人"
        sourceOrganizationId="org-1"
      />,
    )

    const avatar = await screen.findByTestId('collaborator-avatar')
    expect(avatar.getAttribute('data-user-id')).toBe('owner-1')
    expect(ensureProfiles).toHaveBeenCalledWith(['owner-1'])
    expect(listSessionShares).not.toHaveBeenCalled()
    expect(screen.getByText('来源用户')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '打开与 来源用户 的私信' }))
    await waitFor(() => {
      expect(createConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'org-1',
        kind: 'dm',
        memberIds: ['owner-1'],
      })
    })
    expect(setImSidebarView).toHaveBeenCalledWith('inbox')
  })

  it('跨组织共享来源按对端组织解析外部联系人私聊', async () => {
    listExternalContacts.mockResolvedValue({
      items: [{
        contact_id: 'contact-owner-1',
        peer_user_id: 'owner-1',
        peer_organization_id: 'org-owner',
        relationship: 'friend',
      }],
    })
    const { SessionCollaborators } = await import('./SessionCollaborators')
    render(
      <SessionCollaborators
        sessionId="shared-session-1"
        sourceUserId="owner-1"
        sourceOrganizationId="org-owner"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开与 来源用户 的私信' }))
    await waitFor(() => {
      expect(createConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'org-1',
        kind: 'dm',
        memberIds: [],
        externalContactIds: ['contact-owner-1'],
      })
    })
  })

  it('同一接收人的多条共享记录只显示一个头像', async () => {
    listSessionShares.mockResolvedValue([
      { id: 'share-1', grantee_user_id: 'user-1', status: 'active' },
      { id: 'share-2', grantee_user_id: 'user-1', status: 'active' },
      { id: 'share-3', grantee_user_id: 'user-1', status: 'active' },
    ])

    const { SessionCollaborators } = await import('./SessionCollaborators')
    render(<SessionCollaborators sessionId="session-1" />)

    const avatars = await screen.findAllByTestId('collaborator-avatar')
    expect(avatars).toHaveLength(1)
    expect(avatars[0]?.getAttribute('data-user-id')).toBe('user-1')
    expect(screen.queryByText('+2')).toBeNull()
  })

  it('取消待确认共享后清除幂等意图，允许重新共享', async () => {
    const pendingShare = {
      id: 'share-pending',
      session_id: 'session-1',
      grantee_user_id: 'user-1',
      status: 'pending',
      can_fork: false,
      can_chat: false,
    }
    listSessionShares.mockResolvedValue([pendingShare])
    revokeSessionShare.mockResolvedValue({ ...pendingShare, status: 'revoked' })
    const { buildSessionShareIntentKey, rememberPendingShareIntent } = await import(
      '@components/tabchat/sessionSharePendingIntent'
    )
    const intentKey = buildSessionShareIntentKey({
      organizationId: 'org-1',
      sessionId: 'session-1',
      granteeUserId: 'user-1',
      tier: 'view',
    })
    rememberPendingShareIntent(
      intentKey,
      '019fc711-ab26-7924-bc0a-1b115740aca6',
    )

    const { SessionCollaborators } = await import('./SessionCollaborators')
    render(<SessionCollaborators sessionId="session-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'cancel pending' }))

    await waitFor(() => {
      expect(window.sessionStorage.getItem('tabtin:session-share:pending-intents:v1'))
        .toBeNull()
    })
  })

  it('恢复投影未确认时重新读取服务端 pending 状态', async () => {
    const revokedShare = {
      id: 'share-revoked',
      session_id: 'session-1',
      grantee_user_id: 'user-1',
      status: 'revoked',
      can_fork: false,
      can_chat: false,
    }
    listSessionShares
      .mockResolvedValueOnce([revokedShare])
      .mockResolvedValueOnce([{ ...revokedShare, status: 'pending' }])
    createSessionShare.mockRejectedValue(new Error('projection unconfirmed'))

    const { SessionCollaborators } = await import('./SessionCollaborators')
    render(<SessionCollaborators sessionId="session-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'resume revoked' }))

    await waitFor(() => expect(listSessionShares).toHaveBeenCalledTimes(2))
  })
})
