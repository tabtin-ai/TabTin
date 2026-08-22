import { describe, expect, it } from 'vitest'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from '@/constants/tabchat'
import type { Conversation } from '@/services/tabchatApi'
import type { Space } from '@tabtin/app-shell'
import {
  buildSelectionSnapshot,
  EMPTY_SPACE_SELECTION,
  getOrganizationSelection,
  rememberOrganizationSelection,
  resolveSelectionBySpaceId,
} from '../spaceListSelection'

const buildBotSpace = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-workspace-1',
  organization_id: 'ws-1',
  name: 'Bot Space',
  description: '',
  icon: '',
  color: '#000000',
  type: 'workspace',
  status: 'active',
  table_count: 0,
  order: 0,
  is_archived: false,
  is_default: false,
  created_at: '2026-03-09T00:00:00Z',
  updated_at: '2026-03-09T00:00:00Z',
  ...overrides,
})

const buildConversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1',
  organization_id: 'ws-1',
  space_id: 'space-conv-1',
  type: CONVERSATION_TYPE_DM,
  name: 'DM',
  avatar_url: '',
  member_count: 2,
  last_message_at: null,
  last_message_preview: '',
  unread_count: 0,
  created_at: '2026-03-09T00:00:00Z',
  ...overrides,
})

describe('spaceListSelection', () => {
  it('按 organization 记忆并在空选择时移除记忆', () => {
    const selection = buildSelectionSnapshot('dm', 'conv-1')
    const remembered = rememberOrganizationSelection({}, 'ws-1', selection)

    expect(getOrganizationSelection(remembered, 'ws-1')).toEqual(selection)

    const cleared = rememberOrganizationSelection(remembered, 'ws-1', EMPTY_SPACE_SELECTION)
    expect(getOrganizationSelection(cleared, 'ws-1')).toEqual(EMPTY_SPACE_SELECTION)
  })

  it('优先按 workspace / conversation 的真实 space_id 解析路由', () => {
    expect(resolveSelectionBySpaceId({
      spaceId: 'space-workspace-1',
      spaces: [buildBotSpace()],
      conversations: [buildConversation()],
    })).toEqual({
      kind: 'workspace',
      rawId: 'space-workspace-1',
      compositeId: 'space-workspace-1',
    })

    expect(resolveSelectionBySpaceId({
      spaceId: 'space-room-1',
      spaces: [],
      conversations: [],
    })).toBeNull()
  })

  it('为 DM 和 IM 群会话解析正确的导航 kind', () => {
    expect(resolveSelectionBySpaceId({
      spaceId: 'space-conv-1',
      spaces: [],
      conversations: [buildConversation()],
    })).toEqual({
      kind: 'dm',
      rawId: 'conv-1',
      compositeId: 'dm:conv-1',
    })

    expect(resolveSelectionBySpaceId({
      spaceId: 'space-conv-group-1',
      spaces: [],
      conversations: [
        buildConversation({
          id: 'conv-group-1',
          space_id: 'space-conv-group-1',
          type: CONVERSATION_TYPE_GROUP,
        }),
      ],
    })).toEqual({
      kind: 'im-group',
      rawId: 'conv-group-1',
      compositeId: 'im-group:conv-group-1',
    })
  })
})
