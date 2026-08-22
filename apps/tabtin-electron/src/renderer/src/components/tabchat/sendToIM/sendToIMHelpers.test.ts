import { describe, expect, it } from 'vitest'
import type { SpaceContextItem } from '@/services/spaceApi'
import type { Conversation } from '@/services/tabchatApi'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from '@/constants/tabchat'
import {
  buildSendToIMTargets,
  canSendResourceToIM,
  filterSendToIMGroupConversations,
  filterSendToIMGroupsByQuery,
  normalizeSendToIMResource,
} from './sendToIMHelpers'

describe('sendToIMHelpers', () => {
  it('normalizes tabdoc into resource card', () => {
    const item: SpaceContextItem = {
      id: 'ctx-1',
      item_type: 'tabdoc',
      title: '设计文档',
      preview: '摘要',
      resource_id: 'doc-1',
      space_id: 'space-1',
      is_archived: false,
      updated_at: null,
      created_at: null,
    }

    expect(normalizeSendToIMResource(item)).toEqual({
      kind: 'resource_card',
      ref: expect.objectContaining({
        type: 'document',
        resourceId: 'doc-1',
        name: '设计文档',
      }),
    })
  })

  it('normalizes cloud file using resource_id as file_id', () => {
    const item: SpaceContextItem = {
      id: 'ctx-file',
      item_type: 'tabfiles',
      title: 'report.pdf',
      preview: '',
      resource_id: 'file-uuid',
      metadata: {
        file_name: 'report.pdf',
        file_size: 2048,
        mime_type: 'application/pdf',
      },
      is_archived: false,
      updated_at: null,
      created_at: null,
    }

    expect(normalizeSendToIMResource(item)).toEqual({
      kind: 'cloud_file',
      fileId: 'file-uuid',
      fileName: 'report.pdf',
      fileSize: 2048,
      mimeType: 'application/pdf',
    })
  })

  it('filters regular group conversations for current org', () => {
    const conversations: Conversation[] = [
      {
        id: 'g1',
        organization_id: 'org-1',
        type: CONVERSATION_TYPE_GROUP,
        name: '产品群',
        avatar_url: '',
        member_count: 3,
        last_message_at: null,
        last_message_preview: '',
        unread_count: 0,
        created_at: '',
      },
      {
        id: 'team',
        organization_id: 'org-1',
        type: CONVERSATION_TYPE_GROUP,
        name: 'Project',
        avatar_url: '',
        member_count: 5,
        is_team_space_channel: true,
        space_id: 'space-team',
        last_message_at: null,
        last_message_preview: '',
        unread_count: 0,
        created_at: '',
      },
      {
        id: 'external',
        organization_id: 'org-1',
        type: CONVERSATION_TYPE_GROUP,
        name: '外部群',
        avatar_url: '',
        member_count: 3,
        is_external: true,
        last_message_at: null,
        last_message_preview: '',
        unread_count: 0,
        created_at: '',
      },
      {
        id: 'dm-1',
        organization_id: 'org-1',
        type: CONVERSATION_TYPE_DM,
        name: 'Alice',
        avatar_url: '',
        member_count: 2,
        dm_peer_user_id: 'user-2',
        last_message_at: null,
        last_message_preview: '',
        unread_count: 0,
        created_at: '',
      },
    ]

    expect(filterSendToIMGroupConversations(conversations, 'org-1').map((c) => c.id)).toEqual(['g1'])
  })

  it('filters groups by query without throwing on empty name', () => {
    const groups: Conversation[] = [
      {
        id: 'g-empty',
        organization_id: 'org-1',
        type: CONVERSATION_TYPE_GROUP,
        name: '',
        avatar_url: '',
        member_count: 2,
        last_message_at: null,
        last_message_preview: '',
        unread_count: 0,
        created_at: '',
      },
      {
        id: 'g-named',
        organization_id: 'org-1',
        type: CONVERSATION_TYPE_GROUP,
        name: '产品群',
        avatar_url: '',
        member_count: 3,
        last_message_at: null,
        last_message_preview: '',
        unread_count: 0,
        created_at: '',
      },
    ]

    expect(filterSendToIMGroupsByQuery(groups, '产品').map((g) => g.id)).toEqual(['g-named'])
  })

  it('builds mixed contact and group targets', () => {
    const targets = buildSendToIMTargets({
      selectedContactIds: new Set(['user-2']),
      selectedGroupIds: new Set(['group-1']),
      contacts: [{ user_id: 'user-2', user: { nickname: 'Bob' } }],
      groups: [{
        id: 'group-1',
        organization_id: 'org-1',
        type: CONVERSATION_TYPE_GROUP,
        name: '研发群',
        avatar_url: '',
        member_count: 4,
        last_message_at: null,
        last_message_preview: '',
        unread_count: 0,
        created_at: '',
      }],
    })

    expect(targets).toEqual([
      expect.objectContaining({ kind: 'contact', userId: 'user-2', label: 'Bob' }),
      expect.objectContaining({ kind: 'group', conversationId: 'group-1', label: '研发群' }),
    ])
  })

  it('canSendResourceToIM rejects local items and folders', () => {
    expect(canSendResourceToIM({
      id: 'local:tmp',
      item_type: 'tabdoc',
      title: 'x',
      preview: '',
      resource_id: 'doc-1',
      is_archived: false,
      updated_at: null,
      created_at: null,
    })).toBe(false)

    expect(canSendResourceToIM({
      id: 'ctx-folder',
      item_type: 'tabfolder',
      title: 'folder',
      preview: '',
      resource_id: 'folder-1',
      is_archived: false,
      updated_at: null,
      created_at: null,
    })).toBe(false)

    expect(canSendResourceToIM({
      id: 'ctx-slide',
      item_type: 'tabslide',
      title: 'deck',
      preview: '',
      resource_id: 'slide-1',
      is_archived: false,
      updated_at: null,
      created_at: null,
    })).toBe(false)
  })

  it('canSendResourceToIM allows tabdata/tabdoc/tabfiles', () => {
    expect(canSendResourceToIM({
      id: 'ctx-doc',
      item_type: 'tabdoc',
      title: 'doc',
      preview: '',
      resource_id: 'doc-1',
      is_archived: false,
      updated_at: null,
      created_at: null,
    })).toBe(true)
  })
})
