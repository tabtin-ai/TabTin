import { describe, expect, it } from 'vitest'

import type { Agent, Space } from '@tabtin/app-shell'

import { canManageSpaceLifecycle } from './useCanManageSpaceLifecycle'

const baseSpace = (overrides: Partial<Space> = {}): Space =>
  ({
    id: 'space-1',
    name: 'IDE',
    organization_id: 'wt-1',
    type: 'workspace',
    visibility: 'private',
    status: 'active',
    table_count: 0,
    order: 0,
    is_archived: false,
    is_default: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  }) as Space

const baseAgent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    id: 'agent-1',
    organization_id: 'wt-1',
    name: 'IDE',
    type: 'bot',
    is_active: true,
    ...overrides,
  }) as Agent

describe('canManageSpaceLifecycle', () => {
  it('工作空间：agent owner 可管理生命周期，即使只是 Team Editor', () => {
    expect(
      canManageSpaceLifecycle(
        baseSpace(),
        baseAgent({ owner_user_id: 'user-1' }),
        'user-1',
        'editor',
      ),
    ).toBe(true)
  })

  it('工作空间：无 agent / 无 visibility 时仍允许（壳消解后 ）', () => {
    expect(
      canManageSpaceLifecycle(
        baseSpace({ visibility: undefined }),
        null,
        'user-1',
        'editor',
      ),
    ).toBe(true)
  })

  it('workspace_record：非 Org Owner 也可管生命周期', () => {
    expect(
      canManageSpaceLifecycle(
        baseSpace({
          workspace_record: true,
          visibility: undefined,
          type: 'workspace',
        }),
        null,
        'user-1',
        'viewer',
      ),
    ).toBe(true)
  })

  it('个人 private Space：无 agent 快照时仍允许（能进设置即 owner）', () => {
    expect(canManageSpaceLifecycle(baseSpace(), null, 'user-1', 'editor')).toBe(true)
  })

  it('Project：仍要求 Organization Owner', () => {
    expect(
      canManageSpaceLifecycle(
        baseSpace({ type: 'team_space' }),
        null,
        'user-1',
        'editor',
      ),
    ).toBe(false)
    expect(
      canManageSpaceLifecycle(
        baseSpace({ type: 'team_space' }),
        null,
        'user-1',
        'owner',
      ),
    ).toBe(true)
  })
})
