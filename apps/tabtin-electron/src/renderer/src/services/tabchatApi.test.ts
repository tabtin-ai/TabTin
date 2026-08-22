import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApiRequest, mockGetAuthToken } = vi.hoisted(() => ({
  mockApiRequest: vi.fn(),
  mockGetAuthToken: vi.fn(),
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: mockApiRequest,
  getAuthToken: mockGetAuthToken,
}))

import { ApiError } from '@/services/api'
import {
  acceptExternalContact,
  createExternalDM,
  createGroup,
  discoverExternalContact,
  issueContactInvitation,
  leaveConversation,
  listContactInvitations,
  listExternalContacts,
  listLabels,
  rememberIMConversationRoute,
  requestDeniedResourceAccess,
  searchOrganizationMembers,
  startIMProvider,
  stopIMProvider,
  updateContactInvitation,
  updateExternalContact,
} from './tabchatApi'

describe('TabChat API error boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuthToken.mockResolvedValue('test-token')
  })

  it('returns a group-creation entitlement error to its user-action caller without emitting a global toast', async () => {
    const message = '当前套餐群组额度已用完，请升级套餐或购买群组扩容包。'
    mockApiRequest.mockResolvedValue({
      status: 403,
      data: {
        success: false,
        message,
        data: { error_code: 'ENTITLEMENT_GROUP_LIMIT_EXCEEDED' },
        code: 403,
      },
    })
    const eventListener = vi.fn()
    window.addEventListener('billing:api:error', eventListener)

    try {
      const error = await createGroup('organization-1', '测试群', ['member-1'])
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({
        status: 403,
        data: {
          data: { error_code: 'ENTITLEMENT_GROUP_LIMIT_EXCEEDED' },
        },
      })
      expect(eventListener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('billing:api:error', eventListener)
    }
  })

  it('sends external contact ids through the Django group creation contract', async () => {
    mockApiRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        message: 'ok',
        data: { conversation_id: 'conversation-1' },
        code: 200,
      },
    })

    await createGroup(
      'organization-1',
      '外部群',
      ['member-1'],
      '',
      undefined,
      ['contact-1'],
      'create-group-request-1',
    )

    expect(JSON.parse(mockApiRequest.mock.calls[0][0].body)).toMatchObject({
      organization_id: 'organization-1',
      member_ids: ['member-1'],
      external_contact_ids: ['contact-1'],
      client_request_id: 'create-group-request-1',
    })
  })

  it('creates an external DM through the Django conversation contract', async () => {
    mockApiRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: { conversation_id: 'conversation-1' },
      },
    })

    await expect(
      createExternalDM('organization-1', 'contact-1'),
    ).resolves.toEqual({ conversation_id: 'conversation-1' })
    expect(mockApiRequest.mock.calls[0][0].url).toContain('/im/conversations/dm')
    expect(JSON.parse(mockApiRequest.mock.calls[0][0].body)).toEqual({
      organization_id: 'organization-1',
      external_contact_id: 'contact-1',
    })
  })

  it('does not surface a billing toast for a background label refresh', async () => {
    mockApiRequest.mockResolvedValue({
      status: 402,
      data: {
        success: false,
        message: '组织钱包余额不足，请联系管理员充值',
        data: { error_code: 'ORGANIZATION_INSUFFICIENT_CREDITS' },
        code: 402,
      },
    })
    const eventListener = vi.fn()
    window.addEventListener('billing:api:error', eventListener)

    try {
      await expect(listLabels('organization-1')).rejects.toBeInstanceOf(ApiError)
      expect(eventListener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('billing:api:error', eventListener)
    }
  })

  it('loads every member by default while keeping keyword searches bounded', async () => {
    mockApiRequest.mockResolvedValue({
      status: 200,
      data: { success: true, data: { members: [] } },
    })

    await searchOrganizationMembers('organization-1', '')
    await searchOrganizationMembers('organization-1', '程')

    const defaultParams = new URL(mockApiRequest.mock.calls[0][0].url).searchParams
    const searchParams = new URL(mockApiRequest.mock.calls[1][0].url).searchParams
    expect(defaultParams.get('limit')).toBe('0')
    expect(searchParams.get('limit')).toBe('20')
  })

  it('marks no-permission access requests as permission-denied surface requests', async () => {
    mockApiRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          id: 'request-1',
          resource_type: 'table',
          resource_id: 'table-1',
          role: 'viewer',
          status: 'pending',
        },
      },
    })

    await requestDeniedResourceAccess('table', 'table-1', 'viewer')

    expect(JSON.parse(mockApiRequest.mock.calls[0][0].body)).toMatchObject({
      resource_type: 'table',
      resource_id: 'table-1',
      role: 'viewer',
      source_surface: 'permission_denied',
    })
  })

  it('loads external contacts and invitations from Django IM', async () => {
    mockApiRequest.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        message: 'ok',
        data: { items: [{ contact_id: 'contact-1' }] },
        code: 200,
      },
    })
    await expect(listExternalContacts('organization-1')).resolves.toEqual({
      items: [{ contact_id: 'contact-1' }],
    })
    expect(mockApiRequest).toHaveBeenCalledTimes(1)
    expect(mockApiRequest.mock.calls[0][0].url).toContain('/im/external-contacts?')

    mockApiRequest.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: { items: [{ invitation_id: 'invitation-1' }] },
      },
    })
    await expect(
      listContactInvitations('organization-1', 'incoming', 'pending'),
    ).resolves.toEqual({ items: [{ invitation_id: 'invitation-1' }] })
    const invitationUrl = new URL(mockApiRequest.mock.calls[1][0].url)
    expect(invitationUrl.pathname).toContain('/im/external-contact-invitations')
    expect(invitationUrl.searchParams.get('organization_id')).toBe('organization-1')
    expect(invitationUrl.searchParams.get('direction')).toBe('incoming')
    expect(invitationUrl.searchParams.get('status')).toBe('pending')
  })

  it('uses the Django external-contact control-plane contracts', async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: {
            user_id: 'peer-1',
            display_name: 'Peer',
            avatar_url: '',
            relationship: 'none',
          },
        },
      })
      .mockResolvedValueOnce({
        status: 201,
        data: {
          success: true,
          data: {
            invitation: { invitation_id: 'invitation-1', status: 'pending' },
            invitation_id: 'invitation-1',
            status: 'pending',
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: { contact_id: 'contact-1', relationship: 'friend' },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: { invitation_id: 'invitation-1', status: 'rejected' },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          success: true,
          data: { contact_id: 'contact-1', relationship: 'blocked' },
        },
      })

    await discoverExternalContact('organization-1', '13900001165')
    await issueContactInvitation('organization-1', 'peer-1', '一起协作')
    await acceptExternalContact('organization-2', 'invitation-1')
    await updateContactInvitation('organization-1', 'invitation-1', 'reject')
    await updateExternalContact('organization-1', 'contact-1', 'block')

    expect(mockApiRequest.mock.calls.map(([request]) => ({
      method: request.method,
      url: request.url,
      body: request.body ? JSON.parse(request.body) : undefined,
    }))).toEqual([
      {
        method: 'POST',
        url: expect.stringContaining('/im/external-contacts/discover'),
        body: { organization_id: 'organization-1', phone: '13900001165' },
      },
      {
        method: 'POST',
        url: expect.stringContaining('/im/external-contact-invitations'),
        body: {
          organization_id: 'organization-1',
          target_user_id: 'peer-1',
          note: '一起协作',
        },
      },
      {
        method: 'POST',
        url: expect.stringContaining('/im/external-contacts/accept'),
        body: {
          organization_id: 'organization-2',
          invite_code: 'invitation-1',
        },
      },
      {
        method: 'PATCH',
        url: expect.stringContaining('/im/external-contact-invitations/invitation-1'),
        body: { organization_id: 'organization-1', action: 'reject' },
      },
      {
        method: 'PATCH',
        url: expect.stringContaining('/im/external-contacts/contact-1'),
        body: { organization_id: 'organization-1', action: 'block' },
      },
    ])
  })
})

describe('TabChat leave conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuthToken.mockResolvedValue('test-token')
  })

  afterEach(async () => {
    await stopIMProvider()
  })

  it('退群走 POST /leave，不把自己当成员删掉', async () => {
    mockApiRequest.mockResolvedValue({
      status: 200,
      data: { success: true, message: 'ok', code: 200, data: null },
    })
    await startIMProvider({ organizationId: 'organization-1', userId: 'user-1' })
    rememberIMConversationRoute('conversation-1', 'organization-1')

    await expect(leaveConversation('conversation-1', 'user-1')).resolves.toBeUndefined()

    expect(mockApiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: expect.stringMatching(/\/im\/conversations\/conversation-1\/leave$/),
    }))
  })
})
