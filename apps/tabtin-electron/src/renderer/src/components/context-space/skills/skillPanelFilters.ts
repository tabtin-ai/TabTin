/**
 * SkillPanel 纯过滤 / 归类辅助函数。
 *
 * 从 SkillPanel.tsx 抽出，避免「只为测一个纯函数而 import 整个面板」——后者会拉起
 * smartsheet-ui / table-ui 等重依赖，导致单测在模块求值期就因 mock 不全而失败。
 * 这里只依赖类型与同目录的纯模块，可被 UI 与测试同时复用。
 */
import type { SkillIndexEntry, SkillConfig } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { isBuiltinCatalogSkill, type SkillPanelTab } from './skillProductState'
import { classifySkillGroup, isOrganizationSharedUserSkill } from './skillSourceGroups'
import { formatSkillPanelTitle, resolveSkillDisplayName } from './skillSlug'

export function getSkillKey(skill: SkillIndexEntry): string {
  return skill.skill_key || skill.skill_id
}

export function isDeviceSkill(skill: {
  source?: string
  skill_key?: string
}): boolean {
  return normalizeSkillSource(skill.source || '') === 'device'
    || Boolean(skill.skill_key?.startsWith('device:'))
}

/**
 * 小Tin 的系统套件：平台 / 内置 App / 本机。
 * 其他分身添加池不收录这些项；携带集以真实携带行为准，不按来源再藏。
 * 货架压缩包（distribution=marketplace）不算套件，仍可教给任意分身。
 */
export function isDefaultAgentSystemKitSkill(skill: {
  source?: string
  skill_key?: string
  distribution?: string | null
}): boolean {
  const source = normalizeSkillSource(skill.source || '')
    || (skill.skill_key || '').split(':')[0]
  if (source === 'platform' || source === 'device') return true
  if (source === 'app') return skill.distribution !== 'marketplace'
  return false
}

export function canAssignSkillToAgent(
  skill: SkillIndexEntry,
  options?: { isDefaultAgent?: boolean },
): boolean {
  const key = skill.skill_key || ''
  if (!key.includes(':')) return false
  // 工作区 Skill 由 SkillPanel Assign 入口携带；AgentSkillsPanel 添加池不收录
  if (
    normalizeSkillSource(skill.source) === 'workspace'
    || key.startsWith('workspace:')
    || skill.meta?.from_workspace_scan === true
  ) {
    return false
  }
  // 其他分身不能从携带集再加系统套件；本机改从「技能-我的」分配。
  if (options?.isDefaultAgent === false && isDefaultAgentSystemKitSkill(skill)) {
    return false
  }
  return true
}

export function isBuiltinSkill(skill: SkillIndexEntry): boolean {
  return isBuiltinCatalogSkill(skill)
}

export function isSkillInstalledInSpace(
  skill: SkillIndexEntry,
  _skillConfigs: Record<string, SkillConfig>,
): boolean {
  if (isBuiltinSkill(skill)) return true
  // 本机扫描：扫到即出现在「已安装/我的」；启用态另看 isSkillEnabledInCurrentSpace
  if (normalizeSkillSource(skill.source) === 'device') return true
  // user 来源：「已安装到本 Space」看「行存在」信号（installed），不是 enabled。
  // 停用（enabled=false）的行仍在 → 留在「已安装」里灰显、可原地重开；
  // 只有从没在本 Space 装过（无行 → installed=false 且无 installed_version_seq）才隐藏。
  // installed_version_seq 兜底兼容未下发 installed 字段的旧后端。
  return skill.installed === true || skill.installed_version_seq != null
}

export function isSkillEnabledInCurrentSpace(skill: SkillIndexEntry): boolean {
  if (isBuiltinCatalogSkill(skill)) return true
  // 用户总闸 opt-out：缺字段 / 非 false = 开；仅显式 false 为关。
  // 不再读 /skills/config 的 AgentSkillLink.enabled（那是 Agent 子开关）。
  return skill.enabled !== false
}

/** 技能库页已去掉总闸开关；保留函数供旧调用方/合同测，恒为 false。 */
export function canToggleSkillAvailability(_skill: SkillIndexEntry): boolean {
  return false
}

export function filterSkillsByTab(
  tab: SkillPanelTab,
  skills: SkillIndexEntry[],
  skillConfigs: Record<string, SkillConfig>,
  currentUserId: string,
  currentOrganizationId?: string | null,
): SkillIndexEntry[] {
  return skills.filter((skill) => {
    const group = classifySkillGroup(skill, currentUserId)
    // 组织共享 = 当前组织下 visibility=organization 的 user skill（含我自己共享出去的）。
    // 不能用 classifySkillGroup 的 'organization'：它对 owner 优先归 'mine'，会把「我共享到组织的」漏掉。
    // 这类 skill 同时出现在 Mine（管理视角）和 Organization（组织浏览视角），符合预期。
    if (tab === 'organization') {
      return isOrganizationSharedUserSkill(skill, currentOrganizationId)
    }
    if (tab === 'mine') return group === 'mine'
    // Installed = 当前 Space 的「已安装中心」：展示所有已安装到本 Space 的 skill（含停用）。
    // 内置 / 本机随运行时常在；user 来源（含我自己的）只要在本 Space 装过就出现——
    // 停用的灰显、可原地重开（「停用 ≠ 卸载」）；从没在本 Space 装过的 user skill 不混进来。
    if (group === 'builtin' || group === 'device') return true
    return isSkillInstalledInSpace(skill, skillConfigs)
  })
}

export function filterSkillsBySearch(skills: SkillIndexEntry[], search: string): SkillIndexEntry[] {
  if (!search.trim()) return skills
  const q = search.trim().toLowerCase()
  const commandQuery = q.startsWith('/')
  const commandStem = commandQuery ? q.slice(1) : q
  if (commandQuery && !commandStem) return skills

  const scored = skills.flatMap((skill) => {
    const title = formatSkillPanelTitle(skill).toLowerCase()
    const titleStem = title.startsWith('/') ? title.slice(1) : title
    const displayName = resolveSkillDisplayName(skill).toLowerCase()
    const description = (skill.description || '').toLowerCase()
    const stemQuery = commandStem || q

    let score: number | null = null
    if (titleStem === stemQuery || title === q || displayName === stemQuery || displayName === q) {
      score = 0
    } else if (
      titleStem.startsWith(stemQuery)
      || title.startsWith(q)
      || displayName.startsWith(stemQuery)
      || displayName.startsWith(q)
    ) {
      score = 1
    } else if (stemQuery.length >= 3 && (
      title.includes(q)
      || titleStem.includes(stemQuery)
      || displayName.includes(q)
      || displayName.includes(stemQuery)
    )) {
      score = 3
    } else if (description.includes(q)) {
      score = 4
    }

    return score == null ? [] : [{ skill, score, sortKey: titleStem }]
  })

  return scored
    .sort((a, b) => a.score - b.score || a.sortKey.localeCompare(b.sortKey))
    .map(entry => entry.skill)
}
