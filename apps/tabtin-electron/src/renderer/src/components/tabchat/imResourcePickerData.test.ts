import { describe, expect, it, vi } from 'vitest'
import {
  loadResourcePickerItems,
  resolveResourcePickerOrganizationId,
} from './imResourcePickerData'
import type { SpaceContextItem } from '@/services/spaceApi'
import type { Conversation } from '@/services/tabchatApi'

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    organization_id: 'organization-1',
    space_id: null,
    type: 1,
    name: 'DM',
    avatar_url: '',
    member_count: 2,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-06-21T00:00:00Z',
    ...overrides,
  }
}

describe('imResourcePickerData', () => {
  it('resolves organization_id when conversation.space_id is null', () => {
    const organizationId = resolveResourcePickerOrganizationId(
      [makeConversation({ id: 'conv-null-space', organization_id: 'organization-1', space_id: null })],
      'conv-null-space',
    )

    expect(organizationId).toBe('organization-1')
  })

  it('loads TabData and TabDoc resources through the organization API', async () => {
    const tableItem: SpaceContextItem = {
      id: 'ctx-table-1',
      item_type: 'tabdata',
      title: 'Team Table',
      preview: '',
      resource_id: 'table-1',
      space_id: 'resource-space-1',
      space_name: 'Project Space',
      is_archived: false,
      updated_at: null,
      created_at: null,
    }
    const docItem: SpaceContextItem = {
      id: 'ctx-doc-1',
      item_type: 'tabdoc',
      title: 'Team Doc',
      preview: '',
      resource_id: 'doc-1',
      space_id: 'resource-space-2',
      space_name: 'Docs Space',
      is_archived: false,
      updated_at: null,
      created_at: null,
    }
    const listOrganizationContextItems = vi.fn()
      .mockResolvedValueOnce({ items: [tableItem], total: 1, page: 1, page_size: 50 })
      .mockResolvedValueOnce({ items: [docItem], total: 1, page: 1, page_size: 50 })

    await expect(loadResourcePickerItems('organization-1', listOrganizationContextItems)).resolves.toEqual([
      tableItem,
      docItem,
    ])

    expect(listOrganizationContextItems).toHaveBeenCalledWith('organization-1', {
      item_type: 'tabdata',
      page: 1,
      page_size: 100,
    })
    expect(listOrganizationContextItems).toHaveBeenCalledWith('organization-1', {
      item_type: 'tabdoc',
      page: 1,
      page_size: 100,
    })
  })

  it('loads every page before deduplicating resource entries', async () => {
    const duplicate: SpaceContextItem = {
      id: 'ctx-table-duplicate',
      item_type: 'tabdata',
      title: 'Duplicate table',
      preview: '',
      resource_id: 'table-1',
      space_id: 'resource-space-1',
      is_archived: false,
      updated_at: null,
      created_at: null,
    }
    const laterUnique: SpaceContextItem = {
      ...duplicate,
      id: 'ctx-table-later',
      title: 'Later table',
      resource_id: 'table-2',
    }
    const listOrganizationContextItems = vi.fn((_organizationId: string, params: { item_type?: string; page?: number }) => {
      if (params.item_type === 'tabdata' && params.page === 1) {
        return Promise.resolve({ items: [duplicate, { ...duplicate, id: 'ctx-table-duplicate-2' }], total: 3, page: 1, page_size: 100 })
      }
      if (params.item_type === 'tabdata' && params.page === 2) {
        return Promise.resolve({ items: [laterUnique], total: 3, page: 2, page_size: 100 })
      }
      return Promise.resolve({ items: [], total: 0, page: 1, page_size: 100 })
    })

    await expect(loadResourcePickerItems('organization-1', listOrganizationContextItems)).resolves.toEqual([
      duplicate,
      laterUnique,
    ])
  })

  it('deduplicates resource entries by their card resource identity', async () => {
    const firstTableItem: SpaceContextItem = {
      id: 'ctx-table-first',
      item_type: 'tabdata',
      title: 'First table entry',
      preview: '',
      resource_id: 'legacy-table-id',
      space_id: 'resource-space-1',
      metadata: { current_table_id: 'table-1' },
      is_archived: false,
      updated_at: null,
      created_at: null,
    }
    const duplicateTableItem: SpaceContextItem = {
      ...firstTableItem,
      id: 'ctx-table-duplicate',
      title: 'Duplicate table entry',
      resource_id: 'table-1',
    }
    const docWithSameId: SpaceContextItem = {
      ...firstTableItem,
      id: 'ctx-doc-1',
      item_type: 'tabdoc',
      title: 'Document with same UUID',
      resource_id: 'table-1',
    }
    const listOrganizationContextItems = vi.fn()
      .mockResolvedValueOnce({ items: [firstTableItem, duplicateTableItem], total: 2, page: 1, page_size: 50 })
      .mockResolvedValueOnce({ items: [docWithSameId], total: 1, page: 1, page_size: 50 })

    await expect(loadResourcePickerItems('organization-1', listOrganizationContextItems)).resolves.toEqual([
      firstTableItem,
      docWithSameId,
    ])
  })

  it('returns an empty list without calling API when organization_id is missing', async () => {
    const listOrganizationContextItems = vi.fn()

    await expect(loadResourcePickerItems(null, listOrganizationContextItems)).resolves.toEqual([])

    expect(listOrganizationContextItems).not.toHaveBeenCalled()
  })
})
