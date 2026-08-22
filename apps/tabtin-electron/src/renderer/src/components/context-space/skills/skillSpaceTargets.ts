/**
 * Skill 启用目标 Space 列表（纯函数）。
 *
 * 产品口径：Skill 仍按 Space 启用；创建 / 导入 / 本机安装时让用户看见并选择
 * 「装到哪些 Space」，默认勾选当前 Space。候选范围 = 当前组织下未归档的 Space。
 */
import type { Space } from '@tabtin/app-shell'

export interface SkillEnableTargetSpace {
  id: string
  name: string
  isCurrent: boolean
}

export function listSkillEnableTargetSpaces(
  spaces: Space[],
  organizationId: string | null | undefined,
  currentSpaceId: string,
): SkillEnableTargetSpace[] {
  if (!organizationId) {
    const current = spaces.find(s => s.id === currentSpaceId)
    if (!current) {
      return currentSpaceId
        ? [{ id: currentSpaceId, name: currentSpaceId, isCurrent: true }]
        : []
    }
    return [{ id: current.id, name: current.name, isCurrent: true }]
  }

  const inOrg = spaces
    .filter(s => s.organization_id === organizationId && !s.is_archived)
    .sort((a, b) => {
      if (a.id === currentSpaceId) return -1
      if (b.id === currentSpaceId) return 1
      return (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

  if (inOrg.length === 0 && currentSpaceId) {
    return [{ id: currentSpaceId, name: currentSpaceId, isCurrent: true }]
  }

  return inOrg.map(s => ({
    id: s.id,
    name: s.name,
    isCurrent: s.id === currentSpaceId,
  }))
}

/** 默认勾选：当前 Space（若在候选里）；否则勾选第一个。 */
export function defaultSelectedSpaceIds(
  targets: SkillEnableTargetSpace[],
  currentSpaceId: string,
): string[] {
  if (targets.some(t => t.id === currentSpaceId)) return [currentSpaceId]
  return targets[0] ? [targets[0].id] : []
}

export function formatEnabledSpacesToast(
  spaceNames: string[],
  opts: { maxNames?: number } = {},
): { count: number; names: string; overflow: number } {
  const maxNames = opts.maxNames ?? 2
  const count = spaceNames.length
  const shown = spaceNames.slice(0, maxNames)
  return {
    count,
    names: shown.join('、'),
    overflow: Math.max(0, count - shown.length),
  }
}

/** 按是否溢出选择「短 / 多 Space」文案 key。 */
export function pickEnabledSpacesToastKey(
  baseKey: string,
  overflow: number,
): string {
  return overflow > 0 ? `${baseKey}Many` : baseKey
}
