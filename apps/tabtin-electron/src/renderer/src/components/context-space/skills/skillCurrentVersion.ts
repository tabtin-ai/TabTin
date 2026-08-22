import type { SkillIndexEntry, SkillVersion } from '@/skills/types'
import { formatSkillVersionLabel } from './skillSemver'

/**
 * 详情页「当前在用」版本号，与版本历史弹窗 currentSeq 同口径。
 *
 * 真源是发布记录的 SemVer `version_label`，**绝不**用内部 `version_seq`
 * 拼 `v2` / `v2.0.0`（seq=2 时会与真实 label 如 0.0.1 矛盾）。
 */
export function resolveCurrentSkillVersionLabel(
  skill: SkillIndexEntry,
  versions: SkillVersion[] = [],
): string | null {
  const fromInstalled = formatSkillVersionLabel(skill.installed_version_label || '')
  if (fromInstalled) return fromInstalled

  const currentSeq = skill.installed_version_seq ?? skill.latest_version_seq ?? null
  if (currentSeq != null && versions.length > 0) {
    const match = versions.find(v => v.version_seq === currentSeq)
    const fromList = formatSkillVersionLabel(match?.version_label || '')
    if (fromList) return fromList
  }

  if (
    skill.installed_version_seq == null
    || skill.installed_version_seq === skill.latest_version_seq
  ) {
    return formatSkillVersionLabel(skill.latest_version_label || '') || null
  }

  return null
}
