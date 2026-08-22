import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceContextItem } from '@/services/spaceApi'
import type { Conversation } from '@/services/tabchatApi'

const sendToIMDialogSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/tabchat/SendToIMDialog.tsx'),
  'utf8',
)

const {
  mockLoadMembers,
  mockLoadConversations,
  mockCreateConversationAndActivate,
  mockSendResourceToIMTarget,
  mockT,
  organizationRef,
  userRef,
  conversationsRef,
} = vi.hoisted(() => ({
  mockLoadMembers: vi.fn(() => Promise.resolve()),
  mockLoadConversations: vi.fn(() => Promise.resolve()),
  mockCreateConversationAndActivate: vi.fn(() => Promise.resolve('new-group')),
  mockSendResourceToIMTarget: vi.fn(() => Promise.resolve({ resourceOk: true, noteOk: true })),
  mockT: (key: string, options?: Record<string, unknown>) => {
    if (options?.count != null) return `${key}:${options.count}`
    return key
  },
  organizationRef: { current: { id: 'org-1' } },
  userRef: { current: { id: 'user-1' } },
  conversationsRef: {
    current: [{
      id: 'group-1',
      organization_id: 'org-1',
      type: 2,
      name: '研发群',
      avatar_url: '',
      member_count: 4,
      last_message_at: null,
      last_message_preview: '',
      unread_count: 0,
      created_at: '',
    }] as Conversation[],
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedOrganization: organizationRef.current,
      members: [
        { user_id: 'user-1', user: { nickname: 'Me' } },
        { user_id: 'user-2', user: { nickname: 'Bob' } },
      ],
      isLoadingMembers: false,
      loadMembers: mockLoadMembers,
    }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ user: userRef.current }),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      conversations: conversationsRef.current,
      loadConversations: mockLoadConversations,
      createConversationAndActivate: mockCreateConversationAndActivate,
    }),
}))

vi.mock('@/hooks/useCloseOnOrganizationContextReset', () => ({
  useCloseOnOrganizationContextReset: () => {},
}))

vi.mock('@/services/sendResourceToIM', () => ({
  createSendToIMRequestIds: () => ({
    resource: '019fc7b9-4cb3-7a55-863d-04b33361743c',
    note: '019fc7b9-4cb3-7a55-863d-04b33361743d',
  }),
  sendResourceToIMTarget: mockSendResourceToIMTarget,
}))

import {
  SEND_TO_IM_DIALOG_MIN_WIDTH_PX,
  SendToIMDialog,
  resolveSendToIMDialogSizeClass,
} from './SendToIMDialog'

const resource: SpaceContextItem = {
  id: 'ctx-doc',
  item_type: 'tabdoc',
  title: '设计文档',
  preview: '',
  resource_id: 'doc-1',
  is_archived: false,
  updated_at: null,
  created_at: null,
}

describe('resolveSendToIMDialogSizeClass', () => {
  it('uses panel percentage width with min-width when scoped', () => {
    const cls = resolveSendToIMDialogSizeClass(true)
    expect(cls).toContain('w-[85%]')
    expect(cls).toContain(`min-w-[${SEND_TO_IM_DIALOG_MIN_WIDTH_PX}px]`)
    expect(cls).toContain('max-w-[min(860px,calc(100%-24px))]')
    expect(cls).toContain('max-h-[min(85vh,90%)]')
    expect(cls).not.toContain('92vw')
    expect(cls).not.toContain('90vw')
  })

  it('falls back to viewport-bounded width when unscoped', () => {
    const cls = resolveSendToIMDialogSizeClass(false)
    expect(cls).toContain('w-[min(860px,90vw)]')
    expect(cls).toContain(`min-w-[${SEND_TO_IM_DIALOG_MIN_WIDTH_PX}px]`)
    expect(cls).toContain('max-w-[860px]')
    expect(cls).toContain('max-h-[85vh]')
    expect(cls).not.toContain('w-[85%]')
  })
})

describe('SendToIMDialog', () => {
  beforeEach(() => {
    mockLoadMembers.mockClear()
    mockLoadConversations.mockClear()
    mockCreateConversationAndActivate.mockClear()
    mockSendResourceToIMTarget.mockClear()
    mockCreateConversationAndActivate.mockResolvedValue('new-group')
    conversationsRef.current = [{
      id: 'group-1',
      organization_id: 'org-1',
      type: 2,
      name: '研发群',
      avatar_url: '',
      member_count: 4,
      last_message_at: null,
      last_message_preview: '',
      unread_count: 0,
      created_at: '',
    }]
  })

  it('wires dialog size class from OverlayContainer scope', () => {
    expect(sendToIMDialogSource).toContain('useOverlayContainer')
    expect(sendToIMDialogSource).toContain('resolveSendToIMDialogSizeClass')
    expect(sendToIMDialogSource).toContain('dialogSizeClass')
    expect(sendToIMDialogSource).not.toContain('w-[min(860px,92vw)]')
  })

  it('keeps shell resizing available only for the panel-scoped dialog', () => {
    expect(sendToIMDialogSource).toContain('modal={!isScopedToPanel}')
    expect(sendToIMDialogSource).toContain('data-shell-overlay-allows-resize={isScopedToPanel ? \'\' : undefined}')
    expect(sendToIMDialogSource).toContain("overlayClassName={isScopedToPanel ? '!pointer-events-none' : undefined}")
    expect(sendToIMDialogSource).toMatch(/onPointerDownOutside={[\s\S]*?isScopedToPanel[\s\S]*?preventDefault/)
    expect(sendToIMDialogSource).toMatch(/onInteractOutside={[\s\S]*?isScopedToPanel[\s\S]*?preventDefault/)
  })

  it('does not import or render cmdk CommandGroup (render crash outside Command)', () => {
    expect(sendToIMDialogSource).not.toMatch(/^\s*CommandGroup,?$/m)
    expect(sendToIMDialogSource).not.toMatch(/<\s*CommandGroup\b/)
  })

  it('toasts success before closing when all targets succeed', () => {
    expect(sendToIMDialogSource).toContain('notifySendSuccess')
    expect(sendToIMDialogSource).toContain("t('sendToIMSuccessToast'")
    expect(sendToIMDialogSource).toMatch(/notifySendSuccess\([\s\S]*?closeDialog\(\)/)
  })

  it('creates and reuses UUID request identities for each target attempt', () => {
    expect(sendToIMDialogSource).toContain('createSendToIMRequestIds')
    expect(sendToIMDialogSource).toContain('previous?.requestIds')
  })

  it('renders grouped contacts and groups on main screen', () => {
    render(<SendToIMDialog open resource={resource} onOpenChange={() => {}} />)

    expect(screen.getByText('sendToIMTitle')).toBeTruthy()
    expect(screen.getByText('sendToIMContactsHeading')).toBeTruthy()
    expect(screen.getByText('sendToIMGroupsHeading')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('研发群')).toBeTruthy()
    expect(screen.getByText('sendToIMCardOnlyHint')).toBeTruthy()
  })

  it('explains automatic viewer grant without exposing a permission selector', () => {
    render(
      <SendToIMDialog
        open
        resource={resource}
        onOpenChange={() => {}}
        canGrantResourceAccess
      />,
    )

    expect(screen.getByText('sendToIMViewerGrantHint')).toBeTruthy()
    expect(sendToIMDialogSource).not.toContain('CollaboratorPermission')
  })

  it('sends to selected contact and group targets', async () => {
    const onOpenChange = vi.fn()
    render(<SendToIMDialog open resource={resource} onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByText('Bob'))
    fireEvent.click(screen.getByText('研发群'))
    fireEvent.click(screen.getByText('sendToIMSend:2'))

    await vi.waitFor(() => {
      expect(mockSendResourceToIMTarget).toHaveBeenCalledTimes(2)
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows the group-membership reason instead of a generic resource failure', async () => {
    mockSendResourceToIMTarget.mockResolvedValueOnce({
      resourceOk: false,
      noteOk: false,
      error: 'removed_from_group',
    })
    render(<SendToIMDialog open resource={resource} onOpenChange={() => {}} />)

    fireEvent.click(screen.getByText('研发群'))
    fireEvent.click(screen.getByText('sendToIMSend:1'))

    await vi.waitFor(() => {
      expect(screen.getByText(/removedFromGroup/)).toBeTruthy()
    })
    expect(screen.queryByText('sendToIMErrorResourceFailed')).toBeNull()
  })

  it('resolves an organization member through the server instead of reusing another scoped DM', async () => {
    conversationsRef.current = [{
      id: 'old-external-dm',
      organization_id: 'org-1',
      type: 1,
      is_external: true,
      transport_kind: 'c2c',
      name: 'Bob',
      avatar_url: '',
      member_count: 2,
      dm_peer_user_id: 'user-2',
      last_message_at: null,
      last_message_preview: '',
      unread_count: 0,
      created_at: '',
    }]
    mockCreateConversationAndActivate.mockResolvedValueOnce('scoped-internal-dm')

    render(<SendToIMDialog open resource={resource} onOpenChange={() => {}} />)
    expect(screen.getByText('Bob')).toBeTruthy()
    fireEvent.click(screen.getByText('Bob'))
    fireEvent.click(screen.getByText('sendToIMSend:1'))

    await vi.waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'org-1',
        kind: 'dm',
        memberIds: ['user-2'],
        activate: false,
      })
      expect(mockSendResourceToIMTarget).toHaveBeenCalledWith(
        expect.objectContaining({ convId: 'scoped-internal-dm' }),
      )
    })
  })
})
