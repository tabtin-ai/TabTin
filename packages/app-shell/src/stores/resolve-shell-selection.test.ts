import { describe, expect, it } from 'vitest'
import {
  resolveDefaultExecutionWorkspaceId,
  resolveShellSelection,
} from './resolve-shell-selection.js'

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
    expect(resolveDefaultExecutionWorkspaceId('org-1', spaces, 'recent')).toBe(
      'recent',
    )
  })

  it('最后使用项失效时回落组织主场', () => {
    expect(resolveDefaultExecutionWorkspaceId('org-1', spaces, 'missing')).toBe(
      'home',
    )
  })

  it('没有主场时按最近活跃选择，并排除 Project', () => {
    expect(
      resolveDefaultExecutionWorkspaceId(
        'org-1',
        spaces.map((space) => ({ ...space, is_default: false })),
        null,
      ),
    ).toBe('recent')
  })

  it('没有可用个人 Workspace 时返回 null', () => {
    expect(resolveDefaultExecutionWorkspaceId('org-2', spaces, null)).toBeNull()
  })
})

describe('resolveShellSelection', () => {
  it('保留仍有效的 workspace 记忆', () => {
    expect(
      resolveShellSelection({
        organizationId: 'org-1',
        spaces,
        conversations: [],
        selectedSpaceId: 'recent',
        selectedSpaceKind: 'workspace',
      }),
    ).toEqual({ kind: 'workspace', rawId: 'recent' })
  })

  it('workspace 记忆失效时回落默认 Workspace', () => {
    expect(
      resolveShellSelection({
        organizationId: 'org-1',
        spaces,
        conversations: [],
        selectedSpaceId: 'gone',
        selectedSpaceKind: 'workspace',
      }),
    ).toEqual({ kind: 'workspace', rawId: 'home' })
  })

  it('空选中时解析默认 Workspace，不返回 null（有候选时）', () => {
    expect(
      resolveShellSelection({
        organizationId: 'org-1',
        spaces,
        conversations: [],
        selectedSpaceId: null,
        selectedSpaceKind: null,
      }),
    ).toEqual({ kind: 'workspace', rawId: 'home' })
  })

  it('真无 Workspace 时返回 null', () => {
    expect(
      resolveShellSelection({
        organizationId: 'org-2',
        spaces,
        conversations: [],
        selectedSpaceId: null,
        selectedSpaceKind: null,
      }),
    ).toBeNull()
  })

  it('缓存未命中时 dm 记忆回落 Workspace，不卡死', () => {
    expect(
      resolveShellSelection({
        organizationId: 'org-1',
        spaces,
        conversations: [],
        selectedSpaceId: 'dm:conv-1',
        selectedSpaceKind: 'dm',
      }),
    ).toEqual({ kind: 'workspace', rawId: 'home' })
  })

  it('缓存命中时保留 dm 选中（不因列表加载失败语义踢出，）', () => {
    expect(
      resolveShellSelection({
        organizationId: 'org-1',
        spaces,
        conversations: [{ id: 'conv-1', type: 1, organization_id: 'org-1' }],
        selectedSpaceId: 'dm:conv-1',
        selectedSpaceKind: 'dm',
      }),
    ).toEqual({ kind: 'dm', rawId: 'conv-1' })
  })

  it('team 选中不回落 Workspace', () => {
    expect(
      resolveShellSelection({
        organizationId: 'org-1',
        spaces,
        conversations: [],
        selectedSpaceId: 'team:team-1',
        selectedSpaceKind: 'team',
      }),
    ).toBeNull()
  })
})
