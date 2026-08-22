import type { SpaceContextItem } from '@/services/spaceApi'
import type { Conversation } from '@/services/tabchatApi'
import {
  CONVERSATION_TYPE_DM,
  CONVERSATION_TYPE_GROUP,
} from '@/constants/tabchat'
import { contextItemToCardRef } from '@/lib/imResourceCard'
import { ACCEPTED_IMAGE_MIMES } from '@/constants/upload'
import type { IMMemberItem } from '../imMemberPicker/types'
import { memberDisplayName } from '../imMemberPicker/types'
import { suggestedGroupNameFromMembers } from '../imMemberPicker/suggestedGroupName'
import type {
  SendToIMResource,
  SendToIMResourcePreview,
  SendToIMTarget,
} from './types'
import { sendToIMTargetKey } from './types'

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function isCloudFileItem(item: SpaceContextItem): boolean {
  return item.item_type === 'tabfiles' || item.item_type === 'file'
}

/** 右键 / 列表入口：本地项、文件夹、不可归一化类型不展示「发送到私信」。 */
export function canSendResourceToIM(item: SpaceContextItem): boolean {
  if (item.id.startsWith('local:')) return false
  if (item.item_type === 'tabfolder') return false
  return normalizeSendToIMResource(item) !== null
}

/** ContextItem → 资源卡或云盘附件；入口只传 item，不在调用方拼消息。 */
export function normalizeSendToIMResource(item: SpaceContextItem): SendToIMResource | null {
  const cardRef = contextItemToCardRef(item)
  if (cardRef) {
    return { kind: 'resource_card', ref: cardRef }
  }

  if (!isCloudFileItem(item) || !item.resource_id) return null

  const metadata = item.metadata ?? {}
  return {
    kind: 'cloud_file',
    fileId: item.resource_id,
    fileName: firstString(metadata.file_name, metadata.filename, item.title) || item.resource_id,
    fileSize: firstNumber(metadata.file_size, metadata.size),
    mimeType: firstString(metadata.mime_type, metadata.file_type) || undefined,
  }
}

export function buildSendToIMResourcePreview(resource: SendToIMResource): SendToIMResourcePreview {
  if (resource.kind === 'resource_card') {
    return {
      kind: resource.kind,
      title: resource.ref.name,
      subtitle: resource.ref.type === 'table' ? 'resourceCardTable' : 'resourceCardDocument',
    }
  }
  return {
    kind: resource.kind,
    title: resource.fileName,
    subtitle: 'resourceCardCloudFile',
  }
}

export function buildSendToIMContacts(
  members: IMMemberItem[],
  currentUserId?: string,
): IMMemberItem[] {
  return members.filter((member) => member.user_id !== currentUserId)
}

export function filterSendToIMGroupConversations(
  conversations: Conversation[],
  organizationId: string,
): Conversation[] {
  return conversations.filter((conversation) => (
    conversation.organization_id === organizationId
    && conversation.type === CONVERSATION_TYPE_GROUP
    && !conversation.is_external
    && !conversation.is_team_space_channel
  ))
}

export function buildSendToIMTargets(options: {
  selectedContactIds: ReadonlySet<string>
  selectedGroupIds: ReadonlySet<string>
  contacts: IMMemberItem[]
  groups: Conversation[]
}): SendToIMTarget[] {
  const targets: SendToIMTarget[] = []

  for (const userId of options.selectedContactIds) {
    const member = options.contacts.find((contact) => contact.user_id === userId)
    targets.push({
      key: sendToIMTargetKey('contact', userId),
      kind: 'contact',
      userId,
      label: member ? memberDisplayName(member) : userId,
    })
  }

  for (const conversationId of options.selectedGroupIds) {
    const group = options.groups.find((conversation) => conversation.id === conversationId)
    targets.push({
      key: sendToIMTargetKey('group', conversationId),
      kind: 'group',
      conversationId,
      label: group?.name || conversationId,
    })
  }

  return targets
}

export function buildSuggestedGroupName(
  members: IMMemberItem[],
  selectedIds: ReadonlySet<string>,
  fallback: string,
): string {
  return suggestedGroupNameFromMembers(members, selectedIds) || fallback
}

export function isImageMimeType(mimeType?: string): boolean {
  if (!mimeType) return false
  return ACCEPTED_IMAGE_MIMES.has(mimeType.toLowerCase())
}

export function filterSendToIMContactsByQuery(
  contacts: IMMemberItem[],
  query: string,
): IMMemberItem[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return contacts
  return contacts.filter((member) => {
    const name = memberDisplayName(member).toLowerCase()
    const email = member.user?.email?.toLowerCase() ?? ''
    return name.includes(normalized) || email.includes(normalized)
  })
}

export function filterSendToIMGroupsByQuery(
  groups: Conversation[],
  query: string,
): Conversation[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return groups
  return groups.filter((group) => (group.name || '').toLowerCase().includes(normalized))
}
