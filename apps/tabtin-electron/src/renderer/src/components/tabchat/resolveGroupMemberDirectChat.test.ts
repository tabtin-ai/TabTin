import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalContact } from '@/services/tabchatApi'

const mockListExternalContacts = vi.hoisted(() => vi.fn())

vi.mock('@/services/tabchatApi', () => ({
  listExternalContacts: mockListExternalContacts,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

import {
  directChatTargetFromContact,
  planGroupMemberDirectChat,
  resolveGroupMemberDirectChat,
} from './resolveGroupMemberDirectChat'

function contact(overrides: Partial<ExternalContact> = {}): ExternalContact {
  return {
    contact_id: 'contact-1',
    organization_id: 'org-1',
    peer_organization_id: 'peer-org',
    peer_user_id: 'user-2',
    display_name: 'zsctest1',
    avatar_url: '',
    relationship: 'friend',
    is_restorable: false,
    updated_at: '2026-08-17T00:00:00Z',
    peer_organization_name: '外部组织',
    ...overrides,
  }
}

describe('directChatTargetFromContact', () => {
  it('拉黑联系人 → blocked', () => {
    expect(directChatTargetFromContact(contact({ relationship: 'blocked' }))).toEqual({
      kind: 'blocked',
    })
  })

  it('外部好友 → external-friend', () => {
    expect(directChatTargetFromContact(contact())).toEqual({
      kind: 'external-friend',
      contactId: 'contact-1',
    })
  })

  it('已删除或停用的联系人 → unavailable', () => {
    expect(directChatTargetFromContact(contact({ relationship: 'removed' }))).toEqual({
      kind: 'unavailable',
    })
    expect(directChatTargetFromContact(contact({ relationship: 'suspended' }))).toEqual({
      kind: 'unavailable',
    })
  })

  it('好友记录缺少 contact_id → unavailable', () => {
    expect(directChatTargetFromContact(contact({ contact_id: '' }))).toEqual({
      kind: 'unavailable',
    })
  })

  it('没有匹配联系人 → org-member', () => {
    expect(directChatTargetFromContact(undefined)).toEqual({ kind: 'org-member' })
  })
})

describe('planGroupMemberDirectChat', () => {
  it('blocked / unavailable 只提示，不创建', () => {
    expect(planGroupMemberDirectChat('org-1', 'user-2', { kind: 'blocked' })).toEqual({
      type: 'reject',
      messageKey: 'blockedContactCannotMessage',
    })
    expect(planGroupMemberDirectChat('org-1', 'user-2', { kind: 'unavailable' })).toEqual({
      type: 'reject',
      messageKey: 'cannotStartDirectChat',
    })
  })

  it('外部好友走 externalContactIds，组织成员走 memberIds', () => {
    expect(planGroupMemberDirectChat('org-1', 'user-2', {
      kind: 'external-friend',
      contactId: 'contact-1',
    })).toEqual({
      type: 'create',
      input: {
        organizationId: 'org-1',
        kind: 'dm',
        memberIds: [],
        externalContactIds: ['contact-1'],
      },
    })
    expect(planGroupMemberDirectChat('org-1', 'user-2', { kind: 'org-member' })).toEqual({
      type: 'create',
      input: {
        organizationId: 'org-1',
        kind: 'dm',
        memberIds: ['user-2'],
      },
    })
  })
})

describe('resolveGroupMemberDirectChat', () => {
  beforeEach(() => {
    mockListExternalContacts.mockReset()
  })

  it('组织内成员不查外部联系人', async () => {
    await expect(resolveGroupMemberDirectChat({
      organizationId: 'org-1',
      userId: 'user-2',
    })).resolves.toEqual({ kind: 'org-member' })
    expect(mockListExternalContacts).not.toHaveBeenCalled()
  })

  it('外部成员已拉黑时返回 blocked', async () => {
    mockListExternalContacts.mockResolvedValue({
      items: [contact({ relationship: 'blocked' })],
    })
    await expect(resolveGroupMemberDirectChat({
      organizationId: 'org-1',
      userId: 'user-2',
      participantOrganizationId: 'peer-org',
      memberIsExternal: true,
    })).resolves.toEqual({ kind: 'blocked' })
  })

  it('外部成员仍是好友时返回 contactId', async () => {
    mockListExternalContacts.mockResolvedValue({ items: [
      contact({ contact_id: 'wrong-contact', peer_organization_id: 'org-other' }),
      contact(),
    ] })
    await expect(resolveGroupMemberDirectChat({
      organizationId: 'org-1',
      userId: 'user-2',
      participantOrganizationId: 'peer-org',
      memberIsExternal: true,
    })).resolves.toEqual({ kind: 'external-friend', contactId: 'contact-1' })
  })

  it('外部成员未命中联系人时不可发起私信', async () => {
    mockListExternalContacts.mockResolvedValue({ items: [] })
    await expect(resolveGroupMemberDirectChat({
      organizationId: 'org-1',
      userId: 'user-2',
      participantOrganizationId: 'peer-org',
      memberIsExternal: true,
    })).resolves.toEqual({ kind: 'unavailable' })
  })

  it('外部群里的组织成员未命中联系人时仍走组织私信', async () => {
    mockListExternalContacts.mockResolvedValue({ items: [] })
    await expect(resolveGroupMemberDirectChat({
      organizationId: 'org-1',
      userId: 'user-2',
      participantOrganizationId: 'org-1',
      conversationIsExternal: true,
    })).resolves.toEqual({ kind: 'org-member' })
  })

  it('查询失败时不创建组织私信', async () => {
    mockListExternalContacts.mockRejectedValue(new Error('network'))
    await expect(resolveGroupMemberDirectChat({
      organizationId: 'org-1',
      userId: 'user-2',
      participantOrganizationId: 'peer-org',
      memberIsExternal: true,
    })).resolves.toEqual({ kind: 'unavailable' })
  })

  it('外部会话缺少对端组织身份时拒绝按自然人回退', async () => {
    await expect(resolveGroupMemberDirectChat({
      organizationId: 'org-1',
      userId: 'user-2',
      memberIsExternal: true,
    })).resolves.toEqual({ kind: 'unavailable' })
    expect(mockListExternalContacts).not.toHaveBeenCalled()
  })
})
