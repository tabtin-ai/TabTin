import { describe, expect, it } from 'vitest'
import {
  buildResourceCardMetadata,
  contextItemToCardRef,
} from './imResourceCard'
import type { SpaceContextItem } from '@/services/spaceApi'

describe('imResourceCard', () => {
  it('preserves resource-owned space_id in card metadata', () => {
    const item: SpaceContextItem = {
      id: 'ctx-doc-1',
      item_type: 'tabdoc',
      title: 'Design Doc',
      preview: '',
      resource_id: 'doc-1',
      space_id: 'resource-space-1',
      space_name: 'Project Space',
      is_archived: false,
      updated_at: null,
      created_at: null,
    }

    const ref = contextItemToCardRef(item)
    expect(ref).toEqual(expect.objectContaining({
      type: 'document',
      resourceId: 'doc-1',
      spaceId: 'resource-space-1',
    }))

    const metadata = buildResourceCardMetadata(ref!)
    expect(metadata.card?.space_id).toBe('resource-space-1')
  })

  it('maps context item preview into card description', () => {
    const item: SpaceContextItem = {
      id: 'ctx-table-1',
      item_type: 'tabdata',
      title: 'Sales Table',
      preview: '客户、阶段和下一步行动',
      resource_id: 'table-1',
      space_id: 'resource-space-1',
      space_name: 'Project Space',
      is_archived: false,
      updated_at: null,
      created_at: null,
    }

    const ref = contextItemToCardRef(item)
    expect(ref?.description).toBe('客户、阶段和下一步行动')

    const metadata = buildResourceCardMetadata(ref!)
    expect(metadata.card?.description).toBe('客户、阶段和下一步行动')
  })

  it('uses TabData runtime table id instead of a context or session id when sharing from cloud disk', () => {
    const item: SpaceContextItem = {
      id: 'session-like-context-id',
      item_type: 'tabdata',
      title: '客户多维表',
      preview: '',
      resource_id: 'session-accidentally-here',
      space_id: 'resource-space-1',
      space_name: 'Project Space',
      metadata: {
        current_table_id: 'table-real-1',
      },
      is_archived: false,
      updated_at: null,
      created_at: null,
    }

    const ref = contextItemToCardRef(item)

    expect(ref).toEqual(expect.objectContaining({
      type: 'table',
      resourceId: 'table-real-1',
    }))
    expect(buildResourceCardMetadata(ref!).card?.resource_id).toBe('table-real-1')
  })

  it('uses TabDoc runtime doc id instead of a context or session id when sharing from cloud disk', () => {
    const item: SpaceContextItem = {
      id: 'session-like-context-id',
      item_type: 'tabdoc',
      title: '项目云文档',
      preview: '',
      resource_id: 'session-accidentally-here',
      space_id: 'resource-space-1',
      space_name: 'Project Space',
      metadata: {
        current_doc_id: 'doc-real-1',
      },
      is_archived: false,
      updated_at: null,
      created_at: null,
    }

    const ref = contextItemToCardRef(item)

    expect(ref).toEqual(expect.objectContaining({
      type: 'document',
      resourceId: 'doc-real-1',
    }))
    expect(buildResourceCardMetadata(ref!).card?.resource_id).toBe('doc-real-1')
  })
})
