import { describe, it, expect } from 'vitest'
import type { Space } from '@tabtin/app-shell'
import {
  defaultSelectedSpaceIds,
  formatEnabledSpacesToast,
  listSkillEnableTargetSpaces,
  pickEnabledSpacesToastKey,
} from '../skillSpaceTargets'

function mkSpace(partial: Partial<Space> & { id: string; name: string }): Space {
  return {
    organization_id: 'org-1',
    status: 'active',
    table_count: 0,
    order: 0,
    is_archived: false,
    is_default: false,
    created_at: '',
    updated_at: '',
    ...partial,
  } as Space
}

describe('listSkillEnableTargetSpaces', () => {
  it('同组织未归档 Space 都进候选，当前 Space 排第一', () => {
    const spaces = [
      mkSpace({ id: 'b', name: 'Beta', order: 2 }),
      mkSpace({ id: 'a', name: 'Alpha', order: 1 }),
      mkSpace({ id: 'c', name: 'OtherOrg', organization_id: 'org-2' }),
      mkSpace({ id: 'd', name: 'Archived', is_archived: true }),
    ]
    const targets = listSkillEnableTargetSpaces(spaces, 'org-1', 'b')
    expect(targets.map(t => t.id)).toEqual(['b', 'a'])
    expect(targets[0].isCurrent).toBe(true)
  })

  it('无 organizationId 时只回退当前 Space', () => {
    const spaces = [mkSpace({ id: 'a', name: 'Alpha' }), mkSpace({ id: 'b', name: 'Beta' })]
    expect(listSkillEnableTargetSpaces(spaces, null, 'a')).toEqual([
      { id: 'a', name: 'Alpha', isCurrent: true },
    ])
  })
})

describe('defaultSelectedSpaceIds', () => {
  it('默认勾选当前 Space', () => {
    const targets = [
      { id: 'a', name: 'A', isCurrent: true },
      { id: 'b', name: 'B', isCurrent: false },
    ]
    expect(defaultSelectedSpaceIds(targets, 'a')).toEqual(['a'])
  })
})

describe('formatEnabledSpacesToast / pickEnabledSpacesToastKey', () => {
  it('超过 maxNames 时记 overflow', () => {
    const parts = formatEnabledSpacesToast(['一', '二', '三'], { maxNames: 2 })
    expect(parts).toEqual({ count: 3, names: '一、二', overflow: 1 })
    expect(pickEnabledSpacesToastKey('skills.enabledInSpaces', parts.overflow)).toBe(
      'skills.enabledInSpacesMany',
    )
  })
})
