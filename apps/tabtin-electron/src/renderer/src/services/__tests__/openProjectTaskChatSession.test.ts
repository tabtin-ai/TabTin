/**
 * ：打开 Project 任务会话时显式透传稳定 draft scope A。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadSessions: vi.fn(),
  pinSessionInSpace: vi.fn(),
  setCurrentSessionForSpace: vi.fn(),
  selectSession: vi.fn(),
  getSessionById: vi.fn(),
  openTaskSession: vi.fn(),
  setChatSidePanelCollapsed: vi.fn(),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      loadSessions: mocks.loadSessions,
      pinSessionInSpace: mocks.pinSessionInSpace,
      setCurrentSessionForSpace: mocks.setCurrentSessionForSpace,
      selectSession: mocks.selectSession,
      getSessionById: mocks.getSessionById,
      currentSessionId: null,
      currentSessionIdBySpaceId: {},
    }),
  },
}))

vi.mock('@components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: () => ({ openTaskSession: mocks.openTaskSession }),
  },
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({ setChatSidePanelCollapsed: mocks.setChatSidePanelCollapsed }),
  },
}))

import { openProjectTaskChatSession } from '../openProjectTaskChatSession'

describe('openProjectTaskChatSession ( stable draft A)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadSessions.mockResolvedValue(undefined)
    mocks.selectSession.mockResolvedValue(undefined)
    mocks.getSessionById.mockReturnValue(null)
  })

  it('select/setCurrent 透传 conversation:draft:project-a，不丢 scope', async () => {
    await openProjectTaskChatSession({
      projectId: 'project-a',
      organizationId: 'org-1',
      sessionId: 'sess-task-1',
      loadSessions: false,
    })

    expect(mocks.setCurrentSessionForSpace).toHaveBeenCalledWith(
      'project-a',
      'sess-task-1',
      true,
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:project-a',
        organizationId: 'org-1',
        projectId: 'project-a',
      }),
    )
    expect(mocks.selectSession).toHaveBeenCalledWith(
      'project-a',
      'sess-task-1',
      expect.objectContaining({
        draftScopeKey: 'conversation:draft:project-a',
        organizationId: 'org-1',
        projectId: 'project-a',
      }),
    )
  })
})
