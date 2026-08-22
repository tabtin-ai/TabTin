import { describe, expect, it } from 'vitest'
import type { SkillIndexEntry } from '@/skills/types'
import {
  buildSaveAsCopyName,
  findExistingSaveAsCopy,
  SAVE_AS_COPY_NAME_SUFFIX,
} from '../saveAsCopyIdempotency'

function mk(partial: Partial<SkillIndexEntry> & { skill_key: string }): SkillIndexEntry {
  return {
    skill_id: partial.skill_id || partial.skill_key,
    skill_key: partial.skill_key,
    name: partial.name || partial.skill_key,
    source: partial.source || 'user',
    owner_user_id: partial.owner_user_id,
    description: '',
    ...partial,
  } as SkillIndexEntry
}

describe('saveAsCopyIdempotency', () => {
  it('buildSaveAsCopyName 对齐后端半角后缀', () => {
    expect(buildSaveAsCopyName('tabtin-recruit-evaluator')).toBe(
      `tabtin-recruit-evaluator${SAVE_AS_COPY_NAME_SUFFIX}`,
    )
  })

  it('已有同名自有副本时复用，不认他人同名', () => {
    const me = 'user-1'
    const source = mk({
      skill_key: 'user:tabtin-recruit-evaluator',
      name: 'tabtin-recruit-evaluator',
      owner_user_id: 'other',
    })
    const mineCopy = mk({
      skill_id: 'copy-1',
      skill_key: 'user:tabtin-recruit-evaluator-copy',
      name: 'tabtin-recruit-evaluator(我的副本)',
      owner_user_id: me,
    })
    const otherCopy = mk({
      skill_id: 'copy-other',
      skill_key: 'user:other-copy',
      name: 'tabtin-recruit-evaluator(我的副本)',
      owner_user_id: 'someone-else',
    })
    expect(findExistingSaveAsCopy([otherCopy, mineCopy], source, me)?.skill_id).toBe('copy-1')
  })

  it('没有副本时返回 undefined', () => {
    const source = mk({
      skill_key: 'user:shared',
      name: 'shared',
      owner_user_id: 'other',
    })
    expect(findExistingSaveAsCopy([], source, 'user-1')).toBeUndefined()
  })
})
