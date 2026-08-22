/**
 * ：AI 分身工作台打开个人 Workspace 会话须先 pin，再改指针。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSessionWithAgent } from '@tabtin/chat-client'

const mocks = vi.hoisted(() => ({
  openProjectTaskChatSession: vi.fn(),
  loadSessions: vi.fn(),
  pinSessionInSpace: vi.fn(),
  setCurrentSessionForSpace: vi.fn(),
  selectSession: vi.fn(),
  getSessionById: vi.fn(),
  sessionsBySpaceId: {} as Record<string, Array<{ id: string }>>,
  setCurrentTab: vi.fn(),
  setChatSidePanelCollapsed: vi.fn(),
  spaces: [] as Array<{
    id: string
    organization_id: string
    type?: 'workspace' | 'team_space'
    is_archived?: boolean
  }>,
}))

vi.mock('@/services/openProjectTaskChatSession', () => ({
  openProjectTaskChatSession: (...args: unknown[]) => mocks.openProjectTaskChatSession(...args),
}))

vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: vi.fn(),
}))

vi.mock('@/services/focusProjectTask', () => ({
  focusProjectTask: vi.fn(),
}))

vi.mock('@/stores/chat/messages/product/delivery/projectTaskSendGate', () => ({
  rememberProjectTaskRunStatus: vi.fn(),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      loadSessions: mocks.loadSessions,
      pinSessionInSpace: mocks.pinSessionInSpace,
      setCurrentSessionForSpace: mocks.setCurrentSessionForSpace,
      selectSession: mocks.selectSession,
      getSessionById: mocks.getSessionById,
      sessionsBySpaceId: mocks.sessionsBySpaceId,
      syncContext: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ spaces: mocks.spaces }),
  },
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: Object.assign(
    () => ({ currentTab: 'agent' }),
    {
      getState: () => ({ setCurrentTab: mocks.setCurrentTab, currentTab: 'agent' }),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({ setChatSidePanelCollapsed: mocks.setChatSidePanelCollapsed }),
  },
}))

import { openAgentChatSession } from '../openAgentWorkbenchActivity'

const personalSession = {
  id: 'sess-workbench-1',
  title: '工作台活动会话',
  status: 'active',
  organization_id: 'org-1',
  space_id: 'space-personal',
  agent_id: 'agent-1',
  created_at: '2026-07-24T10:00:00.000Z',
  updated_at: '2026-07-24T10:00:00.000Z',
  last_message_at: '2026-07-24T10:00:00.000Z',
  message_count: 2,
  last_message_preview: 'hi',
} satisfies ChatSessionWithAgent

describe('openAgentChatSession ( pin before select)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadSessions.mockResolvedValue(undefined)
    mocks.selectSession.mockResolvedValue(undefined)
    mocks.getSessionById.mockReturnValue(null)
    mocks.sessionsBySpaceId = {
      'space-personal': [{ id: 'sess-other' }],
    }
    mocks.spaces = [
      {
        id: 'space-personal',
        organization_id: 'org-1',
        type: 'workspace',
        is_archived: false,
      },
    ]
  })

  it('个人工作空间桶非空且目标会话不在桶内：仍 pin 再 setCurrent/select，且不走 Project 打开', async () => {
    await openAgentChatSession({
      organizationId: 'org-1',
      session: personalSession,
    })

    expect(mocks.loadSessions).not.toHaveBeenCalled()
    expect(mocks.pinSessionInSpace).toHaveBeenCalledWith(
      'space-personal',
      expect.objectContaining({
        id: 'sess-workbench-1',
        space_id: 'space-personal',
        agent_id: 'agent-1',
      }),
    )
    expect(mocks.pinSessionInSpace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setCurrentSessionForSpace.mock.invocationCallOrder[0],
    )
    expect(mocks.setCurrentSessionForSpace).toHaveBeenCalledWith(
      'space-personal',
      'sess-workbench-1',
      true,
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:space-personal',
        organizationId: 'org-1',
      }),
    )
    expect(mocks.selectSession).toHaveBeenCalledWith(
      'space-personal',
      'sess-workbench-1',
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:space-personal',
        organizationId: 'org-1',
      }),
    )
    expect(mocks.openProjectTaskChatSession).not.toHaveBeenCalled()
  })

  it('团队 Space 仍委托 openProjectTaskChatSession（含 pin）', async () => {
    mocks.spaces = [
      {
        id: 'space-team',
        organization_id: 'org-1',
        type: 'team_space',
        is_archived: false,
      },
    ]
    await openAgentChatSession({
      organizationId: 'org-1',
      session: {
        ...personalSession,
        space_id: 'space-team',
      },
    })

    expect(mocks.openProjectTaskChatSession).toHaveBeenCalledWith({
      projectId: 'space-team',
      organizationId: 'org-1',
      sessionId: 'sess-workbench-1',
      session: expect.objectContaining({ id: 'sess-workbench-1' }),
      loadSessions: true,
    })
    expect(mocks.pinSessionInSpace).not.toHaveBeenCalled()
    expect(mocks.setCurrentSessionForSpace).not.toHaveBeenCalled()
  })
})
