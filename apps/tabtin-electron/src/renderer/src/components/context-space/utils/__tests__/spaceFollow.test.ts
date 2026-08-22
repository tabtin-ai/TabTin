import { describe, it, expect } from 'vitest'
import { getSpaceFollowTarget } from '../spaceFollow'
import type { ContextItem } from '@components/context-space/registry'

function makeItem(partial: Partial<ContextItem>): ContextItem {
  return {
    type: 'apphome',
    id: 'x',
    tabKey: 'apphome:x',
    ...partial,
  } as ContextItem
}

describe('getSpaceFollowTarget', () => {
  it('返回带 targetSpaceId 的 apphome 目录起始页的目标 Space id', () => {
    const item = makeItem({
      id: 'orchestration-space-b',
      tabKey: 'apphome:orchestration-space-b',
      meta: { appId: 'orchestration', targetSpaceId: 'space-b', spaceId: 'space-b' },
    })
    expect(getSpaceFollowTarget(item)).toBe('space-b')
  })

  it('apphome 但无 meta → null', () => {
    expect(getSpaceFollowTarget(makeItem({ meta: undefined }))).toBeNull()
  })

  it('apphome 但 targetSpaceId 非 string → null', () => {
    expect(getSpaceFollowTarget(makeItem({ meta: { targetSpaceId: 123 } }))).toBeNull()
  })

  it('apphome 但 targetSpaceId 为空串 → null', () => {
    expect(getSpaceFollowTarget(makeItem({ meta: { targetSpaceId: '' } }))).toBeNull()
  })

  it('非 apphome 页签（tabfolder / tabcode / tabweb）→ null', () => {
    for (const type of ['tabfolder', 'tabcode', 'tabweb', 'terminal'] as const) {
      const item = makeItem({
        type,
        tabKey: `${type}:foo`,
        meta: { targetSpaceId: 'space-b' },
      })
      expect(getSpaceFollowTarget(item)).toBeNull()
    }
  })
})
