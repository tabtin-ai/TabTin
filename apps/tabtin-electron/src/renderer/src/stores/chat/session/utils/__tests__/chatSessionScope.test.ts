import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: getStateMock,
  },
}))

import {
  resolveChatScopeHost,
  resolveChatSessionListQuery,
} from '../chatSessionScope'

describe('chatSessionScope', () => {
  beforeEach(() => {
    getStateMock.mockReset()
  })

  it('个人 Workspace 列表走 workspace_id', () => {
    getStateMock.mockReturnValue({
      spaces: [{ id: 'ws-1', type: 'workspace', organization_id: 'org-1' }],
      selectedSpace: null,
    })
    expect(resolveChatSessionListQuery('ws-1')).toEqual({ workspace_id: 'ws-1' })
    expect(resolveChatScopeHost('ws-1').currentProjectId).toBeNull()
  })

  it('Project 列表走 project_id', () => {
    getStateMock.mockReturnValue({
      spaces: [{ id: 'proj-1', type: 'team_space', organization_id: 'org-1' }],
      selectedSpace: null,
    })
    expect(resolveChatSessionListQuery('proj-1')).toEqual({ project_id: 'proj-1' })
    expect(resolveChatScopeHost('proj-1').currentProjectId).toBe('proj-1')
  })

  it('仅有成员 Workspace 时用 project_id 反推协作场', () => {
    getStateMock.mockReturnValue({
      spaces: [{
        id: 'ws-member',
        type: 'workspace',
        organization_id: 'org-1',
        project_id: 'proj-1',
      }],
      selectedSpace: null,
    })
    expect(resolveChatScopeHost('proj-1').currentProjectId).toBe('proj-1')
    expect(resolveChatSessionListQuery('proj-1')).toEqual({ project_id: 'proj-1' })
  })

  it('宿主未知时回退 space_id 兼容', () => {
    getStateMock.mockReturnValue({ spaces: [], selectedSpace: null })
    expect(resolveChatSessionListQuery('unknown-1')).toEqual({ space_id: 'unknown-1' })
  })
})
