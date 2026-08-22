import { beforeEach, describe, expect, it, vi } from 'vitest'

const patchTaskFromWS = vi.fn()
const loadTrackerRunSessions = vi.fn()
const trackerState = {
  tasks: [{ id: 'tk-1', space_id: 'space-1' }] as Array<{ id: string; space_id?: string }>,
}
const spaceState = {
  selectedSpace: { id: 'space-1', organization_id: 'org-1' },
  spaces: [
    { id: 'space-1', organization_id: 'org-1' },
    { id: 'space-ws', organization_id: 'org-ws' },
  ],
}

vi.mock('@/stores/useTrackerStore', () => ({
  useTrackerStore: {
    getState: () => ({
      tasks: trackerState.tasks,
      patchTaskFromWS,
    }),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      loadTrackerRunSessions,
    }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceState,
  },
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: { id: 'org-2' },
    }),
  },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

describe('invalidateTrackerAfterTrigger', () => {
  beforeEach(() => {
    patchTaskFromWS.mockReset().mockResolvedValue(undefined)
    loadTrackerRunSessions.mockReset().mockResolvedValue(undefined)
    trackerState.tasks = [{ id: 'tk-1', space_id: 'space-1' }]
    vi.resetModules()
  })

  it('patches task and force-refreshes tracker run sessions', async () => {
    const { invalidateTrackerAfterTrigger } = await import('./invalidateTrackerAfterTrigger')
    await invalidateTrackerAfterTrigger('tk-1')

    expect(patchTaskFromWS).toHaveBeenCalledWith('tk-1')
    expect(loadTrackerRunSessions).toHaveBeenCalledWith('space-1', 'org-1', { force: true })
  })

  it('uses the tracker resource organization instead of the current selection', async () => {
    const { invalidateTrackerAfterTrigger } = await import('./invalidateTrackerAfterTrigger')
    await invalidateTrackerAfterTrigger('tk-1')

    expect(loadTrackerRunSessions).not.toHaveBeenCalledWith('space-1', 'org-2', { force: true })
  })

  it('does not refresh the foreground Space when the tracker has no resource Space', async () => {
    trackerState.tasks = []
    const { invalidateTrackerAfterTrigger } = await import('./invalidateTrackerAfterTrigger')
    await invalidateTrackerAfterTrigger('tk-1')

    expect(loadTrackerRunSessions).not.toHaveBeenCalled()
  })

  it('WS space_id 优先于 tasks 缓存，并按目标 Space 解析 organization', async () => {
    const { invalidateTrackerAfterTrigger } = await import('./invalidateTrackerAfterTrigger')
    await invalidateTrackerAfterTrigger('tk-1', { spaceId: 'space-ws' })

    expect(loadTrackerRunSessions).toHaveBeenCalledWith('space-ws', 'org-ws', { force: true })
  })

  it('running progress 首次刷新侧栏，同 Run 连发会冷却', async () => {
    const {
      shouldRefreshSidebarOnProgress,
      TRACKER_PROGRESS_SIDEBAR_COOLDOWN_MS,
    } = await import('./invalidateTrackerAfterTrigger')
    const now = 1_700_000_000_000
    expect(shouldRefreshSidebarOnProgress(
      { status: 'pending', run_id: 'run-1' },
      now,
    )).toBe(false)
    expect(shouldRefreshSidebarOnProgress(
      { status: 'running', run_id: 'run-1' },
      now,
    )).toBe(true)
    expect(shouldRefreshSidebarOnProgress(
      { status: 'running', run_id: 'run-1' },
      now + 1_000,
    )).toBe(false)
    expect(shouldRefreshSidebarOnProgress(
      { status: 'running', run_id: 'run-1' },
      now + TRACKER_PROGRESS_SIDEBAR_COOLDOWN_MS,
    )).toBe(true)
    expect(shouldRefreshSidebarOnProgress(
      { status: 'running', run_id: 'run-2' },
      now + 1_000,
    )).toBe(true)
  })
})
