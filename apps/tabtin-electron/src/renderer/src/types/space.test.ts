import { describe, expect, it } from 'vitest'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from '@/constants/tabchat'
import type { Conversation } from '@/services/tabchatApi'
import type { Space } from '@tabtin/app-shell'
import {
  spaceToListItem,
  buildSpaceSelectionId,
  getConversationNavigationKind,
  getSpaceNavigationIcon,
  getSpaceNavigationLabel,
  getSpaceVisibilityLabel,
  imConversationToListItem,
  parseSpaceSelectionId,
} from '@tabtin/app-shell'

const buildSpace = (overrides: Partial<Space> = {}): Space => ({
  id: 'space-1',
  name: '助手一号',
  organization_id: 'ws-1',
  description: 'desc',
  icon: '🤖',
  color: '#000000',
  status: 'active',
  table_count: 0,
  order: 7,
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
  name: '私聊一号',
  avatar_url: '',
  member_count: 2,
  last_message_at: null,
  last_message_preview: '',
  unread_count: 3,
  created_at: '2026-03-09T00:00:00Z',
  ...overrides,
})

describe('types/space', () => {
  it('构建与解析统一的 selection id，并把 legacy group 前缀回退到 bot', () => {
    expect(buildSpaceSelectionId('bot', 'space-1')).toBe('space-1')
    expect(buildSpaceSelectionId('dm', 'conv-1')).toBe('dm:conv-1')

    expect(parseSpaceSelectionId('space-1')).toEqual({
      kind: 'bot',
      rawId: 'space-1',
    })
    expect(parseSpaceSelectionId('group:room-1')).toEqual({
      kind: 'bot',
      rawId: 'group:room-1',
    })
  })

  it('根据会话类型解析导航 kind', () => {
    expect(getConversationNavigationKind(buildConversation())).toBe('dm')
    expect(getConversationNavigationKind(buildConversation({
      type: CONVERSATION_TYPE_GROUP,
    }))).toBe('im-group')
  })

  it('把 workspace Space 映射为带可见范围的 SpaceListItem', () => {
    expect(spaceToListItem(buildSpace({
      visibility: 'private',
      member_count: 1,
    }))).toMatchObject({
      id: 'space-1',
      source_id: 'space-1',
      navigationKind: 'workspace',
      type: 'workspace',
      visibility: 'private',
      member_count: 1,
      order: 7,
    })

    expect(getSpaceVisibilityLabel('private')).toBe('仅自己可见')
    expect(getSpaceVisibilityLabel('shared', 3)).toBe('已共享 · 3 人')
  })

  it('把 bot / dm 映射为统一的 SpaceListItem', () => {
    expect(spaceToListItem(buildSpace())).toMatchObject({
      id: 'space-1',
      source_id: 'space-1',
      navigationKind: 'bot',
      type: 'workspace',
      visibility: 'private',
      order: 7,
    })

    expect(imConversationToListItem(buildConversation(), 'ws-1', 4)).toMatchObject({
      id: 'dm:conv-1',
      source_id: 'conv-1',
      navigationKind: 'dm',
      type: 'dm',
      order: 200_004,
      unread_count: 3,
    })
  })

  it('返回稳定的导航图标与标签', () => {
    expect(getSpaceNavigationLabel('bot')).toBe('助手')
    expect(getSpaceNavigationLabel('dm')).toBe('私聊')
    expect(getSpaceNavigationIcon('im-group')).toBe('👥')
    expect(getSpaceNavigationIcon('team')).toBe('🗂️')
  })
})
