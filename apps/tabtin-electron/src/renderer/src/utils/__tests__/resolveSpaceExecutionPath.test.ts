import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resolveActiveSpaceId, resolveSpaceExecutionPath } from '../resolveSpaceExecutionPath'

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: vi.fn(),
  },
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: vi.fn(() => ({
      selectedSpaceId: null,
      selectedSpaceKind: null,
    })),
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: vi.fn(() => ({
      itemsBySpace: {},
      activeKeyBySpace: {},
    })),
  },
}))

vi.mock('@stores/useWorkbenchSceneStore', () => ({
  fromWorkbenchSceneId: vi.fn((id: string | null) => id),
  useWorkbenchSceneStore: {
    getState: vi.fn(() => ({ foregroundSceneId: 'space-1' })),
  },
}))

vi.mock('@components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: vi.fn(() => ({ selectedProjectId: null })),
  },
}))

import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useWorkbenchSceneStore, fromWorkbenchSceneId } from '@stores/useWorkbenchSceneStore'
import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'

describe('resolveActiveSpaceId', () => {
  beforeEach(() => {
    vi.mocked(fromWorkbenchSceneId).mockImplementation((id: string | null) => id)
    vi.mocked(useWorkbenchSceneStore.getState).mockReturnValue({ foregroundSceneId: null } as never)
    vi.mocked(useSpaceStore.getState).mockReturnValue({ selectedSpace: null } as never)
    vi.mocked(useSpaceListStore.getState).mockReturnValue({
      selectedSpaceId: null,
      selectedSpaceKind: null,
    } as never)
    vi.mocked(useProjectWorkspaceSelectionStore.getState).mockReturnValue({
      selectedProjectId: null,
    } as never)
  })

  it('优先使用工作台前台 scene', () => {
    vi.mocked(useWorkbenchSceneStore.getState).mockReturnValue({
      foregroundSceneId: 'fg-space',
    } as never)
    vi.mocked(useSpaceStore.getState).mockReturnValue({
      selectedSpace: { id: 'store-space' },
    } as never)

    expect(resolveActiveSpaceId()).toBe('fg-space')
  })

  it('前台为空时回退 useSpaceStore.selectedSpace', () => {
    vi.mocked(useSpaceStore.getState).mockReturnValue({
      selectedSpace: { id: 'store-space' },
    } as never)

    expect(resolveActiveSpaceId()).toBe('store-space')
  })

  it('回退侧栏 workspace 选中', () => {
    vi.mocked(useSpaceListStore.getState).mockReturnValue({
      selectedSpaceId: 'workspace-raw-1',
      selectedSpaceKind: 'workspace',
    } as never)

    expect(resolveActiveSpaceId()).toBe('workspace-raw-1')
  })

  it('回退侧栏 team 选中与 Project 选中', () => {
    vi.mocked(useSpaceListStore.getState).mockReturnValue({
      selectedSpaceId: 'team:team-space-1',
      selectedSpaceKind: 'team',
    } as never)

    expect(resolveActiveSpaceId()).toBe('team-space-1')

    vi.mocked(useSpaceListStore.getState).mockReturnValue({
      selectedSpaceId: null,
      selectedSpaceKind: null,
    } as never)
    vi.mocked(useProjectWorkspaceSelectionStore.getState).mockReturnValue({
      selectedProjectId: 'project-space-1',
    } as never)

    expect(resolveActiveSpaceId()).toBe('project-space-1')
  })

  it('忽略 dm / im-group 选中', () => {
    vi.mocked(useSpaceListStore.getState).mockReturnValue({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
    } as never)
    vi.mocked(useProjectWorkspaceSelectionStore.getState).mockReturnValue({
      selectedProjectId: null,
    } as never)

    expect(resolveActiveSpaceId()).toBeNull()
  })
})

describe('resolveSpaceExecutionPath', () => {
  beforeEach(() => {
    vi.stubGlobal('tabtin', {
      fileSystem: {
        ensureSpaceSandbox: vi.fn().mockResolvedValue({ path: '/tmp/sandbox' }),
      },
    })
    vi.mocked(fromWorkbenchSceneId).mockImplementation((id: string | null) => id)
    vi.mocked(useWorkbenchSceneStore.getState).mockReturnValue({
      foregroundSceneId: 'space-1',
    } as never)
    vi.mocked(useSpaceListStore.getState).mockReturnValue({
      selectedSpaceId: null,
      selectedSpaceKind: null,
    } as never)
    vi.mocked(useProjectWorkspaceSelectionStore.getState).mockReturnValue({
      selectedProjectId: null,
    } as never)
  })

  it('returns agent working_dir for workspace Space', async () => {
    vi.mocked(useSpaceStore.getState).mockReturnValue({
      selectedSpace: { id: 'space-1' },
      spaces: [{ id: 'space-1', type: 'workspace', agent_id: 'agent-1' }],
      agentCache: { 'agent-1': { working_dir: '/Users/me/proj' } },
      selectedAgent: null,
    } as never)

    await expect(resolveSpaceExecutionPath()).resolves.toBe('/Users/me/proj')
  })

  it('does not fallback to sandbox when workspace working_dir is missing ', async () => {
    vi.mocked(useSpaceStore.getState).mockReturnValue({
      selectedSpace: { id: 'space-1' },
      spaces: [{ id: 'space-1', type: 'workspace', agent_id: 'agent-1' }],
      agentCache: { 'agent-1': { working_dir: '' } },
      selectedAgent: null,
    } as never)

    await expect(resolveSpaceExecutionPath()).resolves.toBeNull()
    expect(window.tabtin?.fileSystem?.ensureSpaceSandbox).not.toHaveBeenCalled()
  })
})
