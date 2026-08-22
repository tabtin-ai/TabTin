import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadSpaces: vi.fn(),
  deleteSpace: vi.fn(),
  bump: vi.fn(),
  run: vi.fn(),
  rollback: vi.fn(),
  listArchives: vi.fn(),
  deleteSession: vi.fn(),
  forgetExternalOpenedSession: vi.fn(),
  getSessionById: vi.fn(),
  sessionsBySpaceId: {} as Record<string, Array<{ id: string }>>,
}))

vi.mock('@tabtin/app-shell', () => ({
  resolveSessionScopeId: vi.fn((session: { space_id?: string | null; workspace_id?: string | null }) => (
    session.space_id ?? session.workspace_id ?? null
  )),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      loadSpaces: mocks.loadSpaces,
      deleteSpace: mocks.deleteSpace,
    }),
  },
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      deleteSession: mocks.deleteSession,
      getSessionById: mocks.getSessionById,
      sessionsBySpaceId: mocks.sessionsBySpaceId,
    }),
  },
}))

vi.mock('./useExternalArchiveIndexStore', () => ({
  useExternalArchiveIndexStore: {
    getState: () => ({
      bump: mocks.bump,
    }),
  },
}))

vi.mock('./externalOpenedSessionRegistry', () => ({
  forgetExternalOpenedSession: mocks.forgetExternalOpenedSession,
}))

import { useImportJobStore } from './useImportJobStore'

describe('useImportJobStore rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useImportJobStore.getState().reset()
    mocks.loadSpaces.mockResolvedValue(undefined)
    mocks.deleteSpace.mockResolvedValue(true)
    mocks.run.mockResolvedValue({ jobId: 'job-1' })
    mocks.rollback.mockResolvedValue({ deletedSessions: 2, deletedMessages: 0 })
    mocks.listArchives.mockResolvedValue([])
    mocks.deleteSession.mockResolvedValue(undefined)
    mocks.getSessionById.mockReturnValue(null)
    mocks.sessionsBySpaceId = {}
    vi.stubGlobal('window', {
      setTimeout: vi.fn(),
      tabtin: {
        import: {
          run: mocks.run,
          rollback: mocks.rollback,
          listArchives: mocks.listArchives,
        },
      },
    })
  })

  it('refreshes the external archive index and spaces after rollback succeeds', async () => {
    await useImportJobStore.getState().startJob({
      jobId: 'job-1',
      sources: [{ source: 'codex', sessionRefs: [] }],
      options: {
        targetOrganizationId: 'org-1',
        agentId: 'agent-1',
        deviceId: 'device-1',
      },
    })

    const res = await useImportJobStore.getState().rollbackLast()

    expect(res).toEqual({ deletedSessions: 2, deletedMessages: 0 })
    expect(mocks.rollback).toHaveBeenCalledWith({ jobId: 'job-1' })
    expect(mocks.bump).toHaveBeenCalledTimes(1)
    expect(mocks.loadSpaces).toHaveBeenCalledWith('org-1')
    expect(useImportJobStore.getState().rolledBack).toBe(true)
  })

  it('deletes opened chat sessions for archives removed by rollback without deleting workspaces client-side', async () => {
    const beforeArchives = [
      {
        source: 'codex',
        sourceSessionId: 'source-1',
        title: 'Imported Codex Session',
        cwd: '/tmp/project',
        workspaceId: 'workspace-1',
        importedAt: '2026-07-27T00:00:00.000Z',
        messageCount: 2,
        openedSessionId: 'chat-1',
      },
      {
        source: 'codex',
        sourceSessionId: 'source-2',
        title: 'Never Opened Session',
        cwd: '/tmp/project',
        workspaceId: 'workspace-1',
        importedAt: '2026-07-27T00:00:00.000Z',
        messageCount: 1,
        openedSessionId: null,
      },
      {
        source: 'cursor',
        sourceSessionId: 'kept-source',
        title: 'Kept Session',
        cwd: '/tmp/kept',
        workspaceId: 'workspace-2',
        importedAt: '2026-07-27T00:00:00.000Z',
        messageCount: 1,
        openedSessionId: 'chat-kept',
      },
    ]
    mocks.listArchives
      .mockResolvedValueOnce(beforeArchives)
      .mockResolvedValueOnce([beforeArchives[2]])

    await useImportJobStore.getState().startJob({
      jobId: 'job-1',
      sources: [{ source: 'codex', sessionRefs: [] }],
      options: {
        targetOrganizationId: 'org-1',
        agentId: 'agent-1',
        deviceId: 'device-1',
      },
    })

    await useImportJobStore.getState().rollbackLast()

    expect(mocks.deleteSession).toHaveBeenCalledTimes(1)
    expect(mocks.deleteSession).toHaveBeenCalledWith('workspace-1', 'chat-1')
    expect(mocks.deleteSpace).not.toHaveBeenCalled()
    expect(mocks.forgetExternalOpenedSession).toHaveBeenCalledWith('chat-1')
    expect(mocks.forgetExternalOpenedSession).not.toHaveBeenCalledWith('chat-kept')
  })
})
