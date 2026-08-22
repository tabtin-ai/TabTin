import type { SkillIndexEntry } from './types'
import { normalizeSkillSource } from './types'

/**
 * 能力市场列表的记录身份。
 *
 * 注意：这不是 Agent 运行时 canonical key。运行时仍使用 `skill_key`；
 * 列表身份只负责保证云端独立资产不会因 slug 相同而互相覆盖。
 */
export function getSkillCatalogIdentity(skill: SkillIndexEntry): string {
  const isPersonalPluginRuntime = isPersonalPluginRuntimeSkill(skill)
  if (
    normalizeSkillSource(skill.source) === 'user'
    && skill.skill_id
    && !isPersonalPluginRuntime
  ) {
    return `user-record:${skill.skill_id}`
  }
  return skill.skill_key || skill.skill_id || ''
}

function isPersonalPluginRuntimeSkill(skill?: SkillIndexEntry): boolean {
  return normalizeSkillSource(skill?.source ?? '') === 'user'
    && typeof skill?.meta?.personal_plugin_id === 'string'
}

/** 按能力市场记录身份合并目录；后出现的同一记录覆盖旧状态。 */
export function mergeSkillCatalogEntries(skills: SkillIndexEntry[]): SkillIndexEntry[] {
  const merged = new Map<string, SkillIndexEntry>()
  const personalPluginRuntimeKeys = new Set<string>()
  for (const skill of skills) {
    const identity = getSkillCatalogIdentity(skill)
    if (!identity) continue
    const runtimeKey = skill.skill_key || ''
    const incomingIsPersonalPlugin = isPersonalPluginRuntimeSkill(skill)
    if (!incomingIsPersonalPlugin && personalPluginRuntimeKeys.has(runtimeKey)) continue
    if (incomingIsPersonalPlugin && runtimeKey) {
      for (const [existingIdentity, existing] of merged) {
        if (existing.skill_key === runtimeKey && !isPersonalPluginRuntimeSkill(existing)) {
          merged.delete(existingIdentity)
        }
      }
      personalPluginRuntimeKeys.add(runtimeKey)
    }
    merged.set(identity, skill)
  }
  return Array.from(merged.values())
}
