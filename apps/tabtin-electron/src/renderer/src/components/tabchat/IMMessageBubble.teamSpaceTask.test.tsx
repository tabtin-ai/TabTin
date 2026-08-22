import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'

const mocks = vi.hoisted(() => ({
  createAgentTaskFromMessage: vi.fn(),
  closeIM: vi.fn(),
  setCurrentConversation: vi.fn(),
  clearActiveContext: vi.fn(),
  setSpaceListState: vi.fn(),
  activateSpace: vi.fn(),
  setSelectedProjectId: vi.fn(),
  setCurrentTab: vi.fn(),
  setChatSidePanelCollapsed: vi.fn(),
  upsertSessionInSpace: vi.fn(),
  setCurrentSessionForSpace: vi.fn(),
  setSessionMessages: vi.fn(),
  selectSession: vi.fn(() => Promise.resolve()),
  sendMessage: vi.fn(() => Promise.resolve()),
  openProjectPage: vi.fn(),
  enterTeamSpaceProject: vi.fn(),
  selectedAgent: { id: 'agent-1' } as { id: string } | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, opts?: Record<string, string>) => opts?.defaultValue ?? _key }),
}))

vi.mock('@components/context-space/registry/homeRegistry', () => ({}))

vi.mock('react-markdown', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  resolveChoiceTagColors: vi.fn(() => ({ bg: '#eee', text: '#111' })),
}))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: vi.fn(),
  handleResourceLinkContextMenu: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  createAgentTaskFromMessage: mocks.createAgentTaskFromMessage,
  deleteMessage: vi.fn(),
  getMessageAttachmentDownloadUrl: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  addReaction: vi.fn(),
}))

vi.mock('@/services/tabchatAttachmentApi', () => ({ formatFileSize: vi.fn((size: number) => `${size} B`) }))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'human-user-1' } }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { selectedAgent: { id: string } | null }) => unknown) =>
    selector({ selectedAgent: mocks.selectedAgent }),
}))

vi.mock('@stores/useIMStore', () => {
  const imState = {
    conversations: [
      {
        id: 'conv-general',
        organization_id: 'organization-1',
        space_id: 'team-space-1',
        is_team_space_channel: true,
        type: 2,
        name: '#general',
      },
    ],
    readReceipts: {} as Record<string, unknown>,
    closeIM: mocks.closeIM,
    setCurrentConversation: mocks.setCurrentConversation,
  }
  const useIMStore = Object.assign(
    (selector: (state: typeof imState) => unknown) => selector(imState),
    {
      getState: () => imState,
    },
  )
  return { useIMStore }
})

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      upsertSessionInSpace: mocks.upsertSessionInSpace,
      setCurrentSessionForSpace: mocks.setCurrentSessionForSpace,
      setSessionMessages: mocks.setSessionMessages,
      clearSessionMessages: vi.fn(),
      selectSession: mocks.selectSession,
      sendMessage: mocks.sendMessage,
    }),
  },
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: Object.assign(
    {
      getState: () => ({
        activateSpace: mocks.activateSpace,
        clearActiveContext: mocks.clearActiveContext,
      }),
    },
    { setState: mocks.setSpaceListState },
  ),
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({
      setCurrentTab: mocks.setCurrentTab,
    }),
    subscribe: vi.fn(() => () => {}),
  },
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      setChatSidePanelCollapsed: mocks.setChatSidePanelCollapsed,
    }),
  },
}))

vi.mock('@components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: () => ({
      setSelectedProjectId: mocks.setSelectedProjectId,
    }),
  },
}))

vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: (...args: unknown[]) => mocks.enterTeamSpaceProject(...args),
}))

vi.mock('@/stores/useAppPageStore', () => ({
  useAppPageStore: {
    getState: () => ({
      openProjectPage: (...args: unknown[]) => mocks.openProjectPage(...args),
    }),
  },
}))

vi.mock('@stores/useFileAttachmentStore', () => ({
  useFileAttachmentStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ statuses: {}, markUnavailable: vi.fn(), ensureChecked: vi.fn(), reset: vi.fn() }),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: { ensureProfiles: () => void }) => unknown) =>
    selector({ ensureProfiles: vi.fn() }),
  useDisplayName: () => 'Seda',
  useDisplayNames: () => ({}),
  useAvatar: () => '',
}))

vi.mock('./ForwardDialog', () => ({ ForwardDialog: () => null }))
vi.mock('./TeamSpaceCreateTaskDialog', () => ({
  TeamSpaceCreateTaskDialog: ({
    isOpen,
    onConfirm,
  }: {
    isOpen: boolean
    onConfirm: (additionalContext: string) => void
  }) => (isOpen ? (
    <div role="dialog" aria-label="询问 Agent">
      <textarea aria-label="补充上下文" />
      <button
        type="button"
        onClick={() => onConfirm(
          document.querySelector<HTMLTextAreaElement>('[aria-label="补充上下文"]')?.value ?? '',
        )}
      >
        发送并打开
      </button>
    </div>
  ) : null),
}))
vi.mock('./EmojiReactionBar', () => ({ EmojiReactionBar: () => null, EmojiQuickPicker: () => null }))
vi.mock('./SpaceCard', () => ({ SpaceCard: () => null }))
vi.mock('./IMResourceCard', () => ({ IMResourceCard: () => null }))
vi.mock('./ContactCard', () => ({ ContactCard: () => null }))
vi.mock('./downloadImAttachment', () => ({ downloadImAttachment: vi.fn() }))
vi.mock('./IMMessageActionBar', () => ({
  IMMessageActionBar: ({
    canCreateAgentTask,
    onCreateAgentTask,
  }: {
    canCreateAgentTask?: boolean
    onCreateAgentTask?: () => void
  }) => (canCreateAgentTask ? (
    <button type="button" aria-label="询问 Agent" onClick={onCreateAgentTask}>
      询问 Agent
    </button>
  ) : null),
}))

function buildMessage(): IMMessage {
  return {
    id: 42,
    conversation_id: 'conv-general',
    sender_id: 'human-user-2',
    sender_type: 'user',
    sender_name: 'Mira',
    content: '把这条讨论升级成任务',
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-07-04T00:00:00Z',
    is_deleted: false,
    reactions: {},
  }
}

describe('IMMessageBubble Project Agent ask navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectedAgent = { id: 'agent-1' }
  })

  it('从频道消息询问 Agent 时保持 Project 项目上下文', async () => {
    mocks.createAgentTaskFromMessage.mockResolvedValueOnce({
      session_id: 'session-task-1',
      space_id: 'team-space-1',
      organization_id: 'organization-1',
      title: '频道消息任务',
      session: { id: 'session-task-1', space_id: 'team-space-1', title: '频道消息任务' },
      default_prompt: '请基于频道消息回答这次问询',
      source_message_ids: [42],
    })

    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage()} prevMessage={null} />)

    fireEvent.click(screen.getByRole('button', { name: '询问 Agent' }))
    fireEvent.change(screen.getByLabelText('补充上下文'), {
      target: { value: '请重点检查上线风险' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送并打开' }))

    await waitFor(() => {
      expect(mocks.enterTeamSpaceProject).toHaveBeenCalledWith('team-space-1')
    })
    expect(mocks.createAgentTaskFromMessage).toHaveBeenCalledWith(
      'conv-general',
      42,
      'agent-1',
      '请重点检查上线风险',
    )
    expect(mocks.activateSpace).not.toHaveBeenCalled()
    expect(mocks.clearActiveContext).not.toHaveBeenCalled()
    expect(mocks.setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
    expect(mocks.setCurrentSessionForSpace).toHaveBeenCalledWith('team-space-1', 'session-task-1', true)
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '请基于频道消息回答这次问询',
      true,
      undefined,
      undefined,
      'session-task-1',
      {
        spaceId: 'team-space-1',
        displayMessage: '基于频道消息询问 Agent',
      },
    )
  })

  it('未选择 Agent 时不创建无绑定的任务会话', async () => {
    mocks.selectedAgent = null
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage()} prevMessage={null} />)

    fireEvent.click(screen.getByRole('button', { name: '询问 Agent' }))
    fireEvent.click(screen.getByRole('button', { name: '发送并打开' }))

    expect(mocks.createAgentTaskFromMessage).not.toHaveBeenCalled()
  })
})
