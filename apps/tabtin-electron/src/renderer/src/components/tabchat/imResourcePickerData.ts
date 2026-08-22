import { SpaceApiService, type SpaceContextItem } from '@/services/spaceApi'
import type { Conversation } from '@/services/tabchatApi'
import { contextItemToCardRef } from '@/lib/imResourceCard'

type ResourcePickerConversation = Pick<Conversation, 'id' | 'organization_id' | 'space_id'>
type ListOrganizationContextItems = typeof SpaceApiService.listOrganizationContextItems

const RESOURCE_PICKER_PAGE_SIZE = 100

async function loadAllResourcePickerItems(
  organizationId: string,
  itemType: 'tabdata' | 'tabdoc',
  listOrganizationContextItems: ListOrganizationContextItems,
): Promise<SpaceContextItem[]> {
  const items: SpaceContextItem[] = []
  let page = 1
  let total = Infinity

  while (items.length < total) {
    const response = await listOrganizationContextItems(organizationId, {
      item_type: itemType,
      page,
      page_size: RESOURCE_PICKER_PAGE_SIZE,
    })
    const pageItems = response.items ?? []
    items.push(...pageItems)
    total = response.total ?? 0
    if (pageItems.length === 0) break
    page += 1
  }

  return items
}

export function resolveResourcePickerOrganizationId(
  conversations: ResourcePickerConversation[],
  conversationId: string,
): string | null {
  return conversations.find((conversation) => conversation.id === conversationId)?.organization_id ?? null
}

export async function loadResourcePickerItems(
  organizationId: string | null,
  listOrganizationContextItems: ListOrganizationContextItems = SpaceApiService.listOrganizationContextItems,
): Promise<SpaceContextItem[]> {
  if (!organizationId) return []

  const [tables, docs] = await Promise.all([
    loadAllResourcePickerItems(organizationId, 'tabdata', listOrganizationContextItems),
    loadAllResourcePickerItems(organizationId, 'tabdoc', listOrganizationContextItems),
  ])
  const seenResourceKeys = new Set<string>()
  return [...tables, ...docs].filter((item) => {
    const ref = contextItemToCardRef(item)
    if (!ref) return false

    const resourceKey = `${ref.type}:${ref.resourceId}`
    if (seenResourceKeys.has(resourceKey)) return false
    seenResourceKeys.add(resourceKey)
    return true
  })
}
