import * as tabchatApi from '@/services/tabchatApi'
import type { ExternalContact } from '@/services/tabchatApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('resolveGroupMemberDirectChat')

export type GroupMemberDirectChatTarget =
  | { kind: 'org-member' }
  | { kind: 'external-friend'; contactId: string }
  | { kind: 'blocked' }
  | { kind: 'unavailable' }

export type GroupMemberDirectChatPlan =
  | { type: 'reject'; messageKey: 'blockedContactCannotMessage' | 'cannotStartDirectChat' }
  | {
      type: 'create'
      input: {
        organizationId: string
        kind: 'dm'
        memberIds: string[]
        externalContactIds?: string[]
      }
    }

export function directChatTargetFromContact(
  contact: ExternalContact | undefined,
): GroupMemberDirectChatTarget {
  if (!contact) return { kind: 'org-member' }
  if (contact.relationship === 'blocked') return { kind: 'blocked' }
  if (contact.relationship === 'friend' && contact.contact_id) {
    return { kind: 'external-friend', contactId: contact.contact_id }
  }
  return { kind: 'unavailable' }
}

export function planGroupMemberDirectChat(
  organizationId: string,
  userId: string,
  target: GroupMemberDirectChatTarget,
): GroupMemberDirectChatPlan {
  if (target.kind === 'blocked') {
    return { type: 'reject', messageKey: 'blockedContactCannotMessage' }
  }
  if (target.kind === 'unavailable') {
    return { type: 'reject', messageKey: 'cannotStartDirectChat' }
  }
  if (target.kind === 'external-friend') {
    return {
      type: 'create',
      input: {
        organizationId,
        kind: 'dm',
        memberIds: [],
        externalContactIds: [target.contactId],
      },
    }
  }
  return {
    type: 'create',
    input: {
      organizationId,
      kind: 'dm',
      memberIds: [userId],
    },
  }
}

export async function resolveGroupMemberDirectChat(args: {
  organizationId: string
  userId: string
  participantOrganizationId?: string
  memberIsExternal?: boolean
  conversationIsExternal?: boolean
}): Promise<GroupMemberDirectChatTarget> {
  if (!args.memberIsExternal && !args.conversationIsExternal) return { kind: 'org-member' }
  if (!args.participantOrganizationId) return { kind: 'unavailable' }
  try {
    const { items } = await tabchatApi.listExternalContacts(args.organizationId)
    const contact = items.find((item) => (
      item.peer_user_id === args.userId
      && item.peer_organization_id === args.participantOrganizationId
    ))
    if (contact) return directChatTargetFromContact(contact)
    // 成员明确是外部却没有联系人记录：不能再走组织私信，否则又会「创建对话失败」。
    if (args.memberIsExternal) return { kind: 'unavailable' }
    return { kind: 'org-member' }
  } catch (error) {
    log.warn('Failed to resolve group member contact before opening DM', {
      organizationId: args.organizationId,
      userId: args.userId,
      error,
    })
    return { kind: 'unavailable' }
  }
}
