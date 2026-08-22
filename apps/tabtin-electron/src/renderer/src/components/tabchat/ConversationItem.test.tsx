import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from '@/constants/tabchat'
import type { Conversation } from '@/services/tabchatApi'

const { mockTogglePin, mockToggleMute, mockUpdateConversation, mockToast } = vi.hoisted(() => ({
  mockTogglePin: vi.fn(),
  mockToggleMute: vi.fn(),
  mockUpdateConversation: vi.fn(),
  mockToast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/services/tabchatApi', () => ({
  SYSTEM_LABEL_MENTION_ID: 'sys:mention',
  togglePin: mockTogglePin,
  toggleMute: mockToggleMute,
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: { unreadCounts: Record<string, number> }) => unknown) =>
      selector({ unreadCounts: {} }),
    { getState: () => ({ updateConversation: mockUpdateConversation, markAsRead: vi.fn() }) },
  ),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfile: () => null,
  useUserProfileCache: (selector: (state: { ensureProfiles: () => void }) => unknown) =>
    selector({ ensureProfiles: vi.fn() }),
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: (selector: (state: { selectSpaceById: () => void }) => unknown) =>
    selector({ selectSpaceById: vi.fn() }),
}))

vi.mock('@hooks/spaceActivity', () => ({ useScopedEventListener: vi.fn() }))
vi.mock('@tabtin/smartsheet-ui', () => ({ toast: mockToast }))
vi.mock('@tabtin/app-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tabtin/app-shell')>()),
  getConversationNavigationKind: () => 'conversation',
}))
vi.mock('@components/ui', () => ({ OVERLAY_SURFACE_CLASS: '' }))
vi.mock('./ColorAvatar', () => ({ ColorAvatar: () => <div aria-label="群组头像" /> }))
vi.mock('./conversationMenuPosition', () => ({
  positionConversationMenu: vi.fn(() => ({ x: 10, y: 10 })),
}))
vi.mock('@/lib/dateUtils', () => ({ formatConversationTime: (value: string | null) => value ?? '' }))

import { ConversationItem } from './ConversationItem'

function groupConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'group-1',
    organization_id: 'org-1',
    type: CONVERSATION_TYPE_GROUP,
    name: '新群组',
    avatar_url: '',
    member_count: 2,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-07-31T02:57:49.630481Z',
    ...overrides,
  }
}

describe('ConversationItem 时间展示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('群组没有消息时展示创建时间', () => {
    render(<ConversationItem conversation={groupConversation()} isActive={false} />)

    expect(screen.getByText('2026-07-31T02:57:49.630481Z')).toBeTruthy()
  })

  it('侧栏预览把 mention markdown 收成 @名称', () => {
    render(
      <ConversationItem
        conversation={groupConversation({
          last_message_preview: 'user_0941: [@小Tin](mention:agent/d16b77ff-aaaa) 看下',
        })}
        isActive={false}
      />,
    )

    expect(screen.getByText('user_0941: @小Tin 看下')).toBeTruthy()
    expect(screen.queryByText(/mention:agent/)).toBeNull()
  })

  it('已有消息时仍优先展示最后消息时间', () => {
    render(
      <ConversationItem
        conversation={groupConversation({ last_message_at: '2026-07-31T03:00:00.000Z' })}
        isActive={false}
      />,
    )

    expect(screen.getByText('2026-07-31T03:00:00.000Z')).toBeTruthy()
  })

  it('私信没有消息时不展示创建时间', () => {
    render(
      <ConversationItem
        conversation={groupConversation({ type: CONVERSATION_TYPE_DM })}
        isActive={false}
      />,
    )

    expect(screen.queryByText('2026-07-31T02:57:49.630481Z')).toBeNull()
  })

  it('服务端确认置顶前不提前修改本地会话状态', async () => {
    let resolvePin!: (value: { pinned: boolean; pinned_source: 'tabtin' }) => void
    mockTogglePin.mockReturnValueOnce(new Promise((resolve) => {
      resolvePin = resolve
    }))
    render(<ConversationItem conversation={groupConversation()} isActive={false} />)

    fireEvent.contextMenu(screen.getByText('新群组').closest('button')!)
    fireEvent.click(screen.getByText('pin'))

    expect(mockTogglePin).toHaveBeenCalledWith('group-1', true)
    expect(mockUpdateConversation).not.toHaveBeenCalled()

    resolvePin({ pinned: true, pinned_source: 'tabtin' })
    await waitFor(() => {
      expect(mockUpdateConversation).toHaveBeenCalledWith('group-1', {
        pinned: true,
        pinned_source: 'tabtin',
      })
    })
  })

  it('未发首条消息时免打扰失败会提示明确原因', async () => {
    mockToggleMute.mockRejectedValueOnce(new Error('conversation is not activated'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<ConversationItem conversation={groupConversation()} isActive={false} />)

    fireEvent.contextMenu(screen.getByText('新群组').closest('button')!)
    fireEvent.click(screen.getByText('mute'))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'muteBeforeFirstMessage',
        variant: 'destructive',
      })
    })
    consoleError.mockRestore()
  })
})
