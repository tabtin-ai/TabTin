/**
 * 「另存为我的副本」幂等：与后端 `_fork_as_copy` 的命名约定对齐。
 * 列表里已有同名自有副本时，前端直接复用，避免连点 / 未部署后端时再造一张卡。
 */
import type { SkillIndexEntry } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { isSkillOwnedByCurrentUser } from './skillProductState'

/** 与 Django SkillService._fork_as_copy 硬编码后缀一致（半角括号）。 */
export const SAVE_AS_COPY_NAME_SUFFIX = '(我的副本)'

export function buildSaveAsCopyName(sourceName: string): string {
  return `${String(sourceName || '').trim()}${SAVE_AS_COPY_NAME_SUFFIX}`
}

export function findExistingSaveAsCopy(
  skills: readonly SkillIndexEntry[],
  source: Pick<SkillIndexEntry, 'name'>,
  currentUserId: string,
): SkillIndexEntry | undefined {
  const expected = buildSaveAsCopyName(source.name || '')
  if (!expected || expected === SAVE_AS_COPY_NAME_SUFFIX) return undefined
  return skills.find(
    (s) =>
      normalizeSkillSource(s.source) === 'user'
      && isSkillOwnedByCurrentUser(s, currentUserId)
      && String(s.name || '').trim() === expected,
  )
}
