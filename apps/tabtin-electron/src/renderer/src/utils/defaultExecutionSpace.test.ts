import { describe, expect, it } from 'vitest'
import { resolveDefaultExecutionWorkspaceId } from './defaultExecutionSpace'

const spaces = [
  {
    id: 'recent',
    organization_id: 'org-1',
    type: 'workspace',
    last_activity_at: '2026-07-20T10:00:00Z',
  },
  {
    id: 'home',
    organization_id: 'org-1',
    type: 'workspace',
    is_default: true,
    last_activity_at: '2026-07-19T10:00:00Z',
  },
  {
    id: 'project',
    organization_id: 'org-1',
    type: 'team_space',
    last_activity_at: '2026-07-21T10:00:00Z',
  },
]

describe('resolveDefaultExecutionWorkspaceId', () => {
  it('优先沿用仍有效的最后使用 Workspace', () => {
    expect(resolveDefaultExecutionWorkspaceId('org-1', spaces, 'recent')).toBe('recent')
  })

  it('最后使用项失效时回落组织主场', () => {
    expect(resolveDefaultExecutionWorkspaceId('org-1', spaces, 'missing')).toBe('home')
  })

  it('没有主场时按最近活跃选择，并排除 Project', () => {
    expect(resolveDefaultExecutionWorkspaceId(
      'org-1',
      spaces.map(space => ({ ...space, is_default: false })),
      null,
    )).toBe('recent')
  })

  it('没有可用个人 Workspace 时返回 null', () => {
    expect(resolveDefaultExecutionWorkspaceId('org-2', spaces, null)).toBeNull()
  })
})
