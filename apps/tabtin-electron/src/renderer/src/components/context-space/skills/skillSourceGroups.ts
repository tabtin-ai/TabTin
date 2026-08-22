import type { SkillIndexEntry } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { isRecommendedMarketPackSkill } from '../capability-marketplace/skillMarketTaxonomy'
import { isBuiltinCatalogSkill, isSkillOwnedByCurrentUser } from './skillProductState'

export type SourceGroup5 = 'mine' | 'organization' | 'builtin' | 'device' | 'public_market'

/**
 * 顶层来源 chip 分组（问题2 去重）：本机（device）不再单列，并入「我的」——
 * 本机 skill 对用户来说也是「我的」，只读差异改用卡片标记 / 子筛选表达，
 * 而不是在顶层再开一个来源分类。能力层（详情动作、只读判定）仍用
 * `classifySkillGroup` / `getSkillDetailKind` 认 device，互不影响。
 */
export type TopChipGroup = 'mine' | 'organization' | 'builtin' | 'public_market'

export const TOP_CHIP_GROUP_ORDER: TopChipGroup[] = ['mine', 'organization', 'builtin', 'public_market']

/** 「我的」内的子筛选：全部 / 我创建的（云端可编辑）/ 本机（只读发现）。 */
export type MineScopeFilter = 'all' | 'created' | 'device'

export type MineSubGroup =
  | 'published_private'
  | 'published_organization'
  | 'public_pending'
  | 'marketplace_published'
  | 'public_rejected'
  | 'published_public'

export const SOURCE_GROUP_5_ORDER: SourceGroup5[] = ['mine', 'organization', 'builtin', 'device', 'public_market']

/** Installed tab 侧栏分组顺序；公开市场 Skill 安装后也必须有可见归宿。 */
export const ENABLED_SOURCE_GROUP_ORDER: SourceGroup5[] = ['mine', 'organization', 'builtin', 'device', 'public_market']

export const MINE_SUB_GROUP_ORDER: MineSubGroup[] = [
  'published_private',
  'published_organization',
  'public_pending',
  'marketplace_published',
  'public_rejected',
  'published_public',
]

/**
 * 能力市场「推荐」货架：仅压缩包导入的 6 个 pack。
 * 已获取仍留在推荐，卡片 CTA 由「获取」变为「管理」；「我的」可另列同一批资产。
 */
export function isRecommendedMarketCatalogSkill(skill: SkillIndexEntry): boolean {
  if (normalizeSkillSource(skill.source) !== 'app') return false
  return isRecommendedMarketPackSkill(skill)
}

/**
 * 管理视角归类：
 * - 本机 → device
 * - 组织可见的 user skill（无论作者是谁）→ organization，仅在精选货架出现
 * - 我拥有的其它 user skill → mine
 * - 其余 → public_market
 */
export function classifySkillGroup(skill: SkillIndexEntry, currentUserId: string): SourceGroup5 {
  const source = normalizeSkillSource(skill.source)
  if (isBuiltinCatalogSkill(skill)) return 'builtin'
  if (source === 'device') return 'device'
  if (source === 'user' && skill.visibility === 'organization') return 'organization'
  const isOwner = isSkillOwnedByCurrentUser(skill, currentUserId)
  if (isOwner) return 'mine'
  return 'public_market'
}

export function classifyMineSubGroup(skill: SkillIndexEntry): MineSubGroup {
  if (skill.visibility === 'organization') return 'published_organization'
  if (skill.visibility === 'public') {
    if (skill.latest_review_status === 'pending_review') return 'public_pending'
    if (skill.latest_review_status === 'approved') return 'marketplace_published'
    if (skill.latest_review_status === 'rejected') return 'public_rejected'
    return 'published_public'
  }
  return 'published_private'
}

export function hasInstallBaseline(skill: SkillIndexEntry): boolean {
  return Boolean(skill.install_content_hash)
}

/**
 * 组织共享 = 当前组织下 visibility=organization 的 user skill（含我自己共享出去的）。
 * ：必须匹配 `skill.organization_id === currentOrganizationId`，缺组织上下文时不展示。
 */
export function isOrganizationSharedUserSkill(
  skill: SkillIndexEntry,
  currentOrganizationId?: string | null,
): boolean {
  if (normalizeSkillSource(skill.source) !== 'user' || skill.visibility !== 'organization') {
    return false
  }
  if (!currentOrganizationId) return false
  return skill.organization_id === currentOrganizationId
}

/**
 * 来源 chip 过滤。organization 走 visibility + 当前组织口径（含我自己共享出去的）。
 * 我共享到组织的静态快照只归 organization；其私有原件仍归 mine。
 */
export function matchesSourceGroupFilter(
  skill: SkillIndexEntry,
  filter: SourceGroup5 | 'all',
  currentUserId: string,
  currentOrganizationId?: string | null,
): boolean {
  if (filter === 'all') return true
  if (filter === 'organization') {
    return isOrganizationSharedUserSkill(skill, currentOrganizationId)
  }
  return classifySkillGroup(skill, currentUserId) === filter
}

/** 顶层 chip 归组：device 折叠进「我的」，其余同 classifySkillGroup。 */
export function classifyTopChipGroup(skill: SkillIndexEntry, currentUserId: string): TopChipGroup {
  const group = classifySkillGroup(skill, currentUserId)
  return group === 'device' ? 'mine' : group
}

/** 顶层 chip 过滤：mine 含本机（device）；organization 同 matchesSourceGroupFilter 口径。 */
export function matchesTopChipFilter(
  skill: SkillIndexEntry,
  filter: TopChipGroup | 'all',
  currentUserId: string,
  currentOrganizationId?: string | null,
): boolean {
  if (filter === 'all') return true
  if (filter === 'organization') {
    return isOrganizationSharedUserSkill(skill, currentOrganizationId)
  }
  return classifyTopChipGroup(skill, currentUserId) === filter
}

/**
 * 统一市场「我的」口径：
 * - 用户创建 / 导入的 Skill 都是当前用户拥有的 user Skill，跟随 owner 跨组织可见；
 * - 用户从推荐或组织精选显式获取的 Skill 由 acquired 标记；
 * - 平台 / 内置 App 只进「内置」货架，不进「我的」；
 * - marketplace 压缩包仍须获取后才进「我的」；
 * - 本机发现另在市场「我的」下方单列，不混入主网格。
 */
export function isMarketplaceMineSkill(skill: SkillIndexEntry, currentUserId: string): boolean {
  if (isBuiltinCatalogSkill(skill)) return false
  return skill.acquired === true || (
    normalizeSkillSource(skill.source) === 'user'
    && isSkillOwnedByCurrentUser(skill, currentUserId)
  )
}

/**
 * 市场「我的」货架归属：本人创建的组织静态快照始终不进「我的」，
 * 「我的」只展示可继续编辑、分享给当前组织的私有原件。这样切换组织后，
 * 不会把 A 组织的快照误表达成已分享给 B 组织。
 * 队友的组织快照只有显式获取后才进入「我的」；解除获取后必须退出。
 */
export function isMarketplaceMineShelfSkill(
  skill: SkillIndexEntry,
  currentUserId: string,
  _currentOrganizationId?: string | null,
): boolean {
  if (
    normalizeSkillSource(skill.source) === 'user'
    && skill.visibility === 'organization'
    && isSkillOwnedByCurrentUser(skill, currentUserId)
  ) {
    return false
  }
  return isMarketplaceMineSkill(skill, currentUserId)
}

/**
 * 市场卡片 CTA：「管理」vs「获取」。
 *
 * 与顶层 chip 解耦——本人创建的 Skill 分享到组织后，在「组织精选」仍算已在库中，
 * 不因 `acquired` 尚未写 UserSkillPreference 而再要一次获取。
 * 队友看到的组织共享 Skill 仍须显式获取（或已配置给 Agent）。
 */
export function isMarketplaceSkillManaged(
  skill: SkillIndexEntry,
  currentUserId: string,
  options?: { localDiscovery?: boolean; configuredAgentCount?: number },
): boolean {
  if (options?.localDiscovery) return true
  if ((options?.configuredAgentCount ?? 0) > 0) return true
  if (skill.acquired_copy_skill_key) return true
  if (
    normalizeSkillSource(skill.source) === 'user'
    && skill.visibility === 'organization'
    && isSkillOwnedByCurrentUser(skill, currentUserId)
  ) {
    return true
  }
  return isMarketplaceMineSkill(skill, currentUserId)
}

/** 「我的」内子筛选：created = 我创建的云端 Skill（含已分享给组织）；device = 本机。 */
export function matchesMineScope(skill: SkillIndexEntry, scope: MineScopeFilter): boolean {
  if (scope === 'all') return true
  const isDevice = normalizeSkillSource(skill.source) === 'device'
  if (scope === 'device') return isDevice
  // created：云端 user skill 私有原件。
  return !isDevice && normalizeSkillSource(skill.source) === 'user'
}
