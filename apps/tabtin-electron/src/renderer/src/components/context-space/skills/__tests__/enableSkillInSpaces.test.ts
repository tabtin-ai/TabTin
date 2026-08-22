import { describe, it, expect, vi } from 'vitest'
import { enableSkillInSpaces } from '../enableSkillInSpaces'
import type { SkillIndexEntry } from '@/skills/types'

describe('enableSkillInSpaces', () => {
  it('串行启用，单点失败不阻断其余', async () => {
    const enable = vi.fn(async ({ spaceId }: { spaceId: string }) => {
      if (spaceId === 'bad') throw new Error('fail')
    })
    const skill = { skill_id: '1', skill_key: 'user:demo', name: 'demo', source: 'user' } as SkillIndexEntry
    const result = await enableSkillInSpaces({
      spaceIds: ['a', 'bad', 'c'],
      canonicalKey: 'user:demo',
      skill,
      enable,
    })
    expect(result.okSpaceIds).toEqual(['a', 'c'])
    expect(result.failedSpaceIds).toEqual(['bad'])
    expect(enable).toHaveBeenCalledTimes(3)
  })
})
