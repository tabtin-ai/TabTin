import type { SkillIndexEntry } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'

export type SkillDetailKind = 'builtin' | 'my_skill' | 'organization_skill' | 'marketplace_installed' | 'device_local'

/** Skill 面板当前 Inner tab（决定详情页给哪些动作） */
export type SkillPanelTab = 'organization' | 'mine' | 'enabled'

/** Mine tab 展示管理向操作（编辑入口、可见性、删除，以及 owner 自己 skill 的 enable 开关） */
export function isMineManagementTab(panelTab: SkillPanelTab): boolean {
  return panelTab === 'mine'
}

export interface SkillDetailProductState {
  detailKind: SkillDetailKind
  isOwner: boolean
  isUserSkill: boolean
  canToggleAvailability: boolean
  canShowUninstall: boolean
  /**
   * 从组织移除：删除独立的组织静态快照，保留原有私有原件。
   * 文案用「从组织中移除」，不用「设为仅我可见」。
   */
  canShowRemoveFromOrg: boolean
  /** 删除 owner 自己的 user skill。 */
  canShowDelete: boolean
  /**
   * 从「我的」移除已获取的 Skill：只删除当前用户的接入关系与本地副本，
   * 不删除组织精选 / 市场原件。
   */
  canShowRemoveFromMine: boolean
  /**
   * 他人 user skill：另存为我的副本（组织共享 / 已启用 / 我的 视角均可）。
   * 不绑死 mine tab——从组织共享打开同事 skill 时也必须能看到入口。
   */
  canShowSaveAsCopy: boolean
  /**
   * 市场 / 内置「另存为我的再编辑」——产品已收回，恒为 false（保留字段以免调用方断裂）。
   */
  canShowForkToMine: boolean
  /**
   * 本机互操作目录发现的 Skill——可选「另存为我的」可编辑副本（次要动作）。
   * 主路径是当前 Space 直接启停，不再强制「安装到 Space」。恒为 false。
   */
  canShowImportToSpace: boolean
  canShowMakeTeamVisible: boolean
  canShowChangeCategory: boolean
}

function normalizeUserId(userId: unknown): string {
  return String(userId ?? '').trim().toLowerCase()
}

export function isSkillOwnedByCurrentUser(skill: SkillIndexEntry, currentUserId: string): boolean {
  const ownerId = normalizeUserId(skill.owner_user_id)
  const viewerId = normalizeUserId(currentUserId)
  return Boolean(ownerId && viewerId && ownerId === viewerId)
}

/**
 * 首发分身预装的官方 Pack。货架上仍可按 marketplace 安装，
 * 携带集来源跟 TabCode / Terminal 一样标「内置起步包」。
 * 改名单时同步 `FIRST_PARTY_STARTER_PACK_IDS`（`@tabtin/agent-runtime/skills`）。
 */
export const FIRST_PARTY_STARTER_PACK_IDS = new Set([
  'tabtin-workflow-skills-pack',
  'tabtin-engineering-discipline-pack',
  'ponytail',
])

export function resolveAppSkillPackId(skill: {
  app_id?: string | null
  skill_key?: string | null
}): string {
  const appId = typeof skill.app_id === 'string' ? skill.app_id.trim() : ''
  if (appId) return appId
  const key = typeof skill.skill_key === 'string' ? skill.skill_key.trim() : ''
  if (!key.startsWith('app:')) return ''
  const rest = key.slice('app:'.length)
  const slash = rest.indexOf('/')
  return (slash === -1 ? rest : rest.slice(0, slash)).trim()
}

export function isFirstPartyStarterPackSkill(skill: {
  app_id?: string | null
  skill_key?: string | null
  source?: string | null
}): boolean {
  const rawSource = (skill.source || '').trim()
  const source = rawSource
    ? normalizeSkillSource(rawSource)
    : (skill.skill_key || '').split(':')[0]
  if (source !== 'app') return false
  return FIRST_PARTY_STARTER_PACK_IDS.has(resolveAppSkillPackId(skill))
}

export function isBuiltinCatalogSkill(skill: SkillIndexEntry): boolean {
  const source = normalizeSkillSource(skill.source)
  if (source === 'platform') return true
  if (source !== 'app') return false
  if (isFirstPartyStarterPackSkill(skill)) return true
  return skill.distribution !== 'marketplace'
}

export function canEditSkillFiles(
  skill: SkillIndexEntry,
  currentUserId: string,
  panelTab: SkillPanelTab,
  organizationId?: string | null,
): boolean {
  if (normalizeSkillSource(skill.source) !== 'user') return false
  if (!skill.skill_key || !organizationId) return false
  // 组织可见记录是精选货架上的静态快照，即便从旧入口或缓存以 Mine 场景打开也只读。
  if (skill.visibility === 'organization') return false
  // 本人的私有原件仅在「我的」可编辑；其它浏览场景始终只读。
  if (!isMineManagementTab(panelTab)) return false
  return isSkillOwnedByCurrentUser(skill, currentUserId)
}

export function getSkillDetailKind(skill: SkillIndexEntry, currentUserId: string): SkillDetailKind {
  if (
    normalizeSkillSource(skill.source) === 'device'
    || normalizeSkillSource(skill.source) === 'workspace'
    || skill.meta?.from_workspace_scan === true
  ) {
    return 'device_local'
  }
  if (isBuiltinCatalogSkill(skill)) return 'builtin'
  const source = normalizeSkillSource(skill.source)
  if (source === 'app' && skill.distribution === 'marketplace') return 'marketplace_installed'
  if (source !== 'user') return 'builtin'
  if (skill.visibility === 'organization') return 'organization_skill'
  if (isSkillOwnedByCurrentUser(skill, currentUserId)) return 'my_skill'
  return 'marketplace_installed'
}

/**
 * Skill 是一个 SKILL.md 文件——没有把多份历史版本暴露给用户管理这层概念。
 * 详情页能力按当前 Inner tab + 关系（owner/organization/market/builtin/device）派生：
 * - Installed tab（当前 Space 的启用中心）：user/organization 来源可 enable/disable；
 *   marketplace 安装包走安装/卸载心智，可卸载但不暴露 enable 开关。
 * - Mine tab（owner 的私有原件管理）：编辑 / 可见性 / 删除；已获取的市场包可从「我的」移除；
 *   组织静态快照不进入 Mine。
 * - 本机（device / interop）：当前 Space 可直接启停；组织共享会物化一条云端记录。
 * - 市场 / 内置：原件只读，不再提供「另存为我的再编辑」。
 *
 * `isPersonalOrganization`：当前 Space 归属的 organization 是否「个人组织」（组织里只有自己
 * 一个人、没有真正的多人协作）。个人组织下「共享给组织」无同事可看，是纯噪音，因此隐藏；
 * 只有真正的多人组织才暴露该动作。默认 false（按多人组织对待），既向后兼容旧调用，
 * 也避免在信号缺失时误隐藏真组织的功能。
 *
 * 从组织移除 = 删除组织静态快照；不会把快照转成新的私有 Skill。
 */
export function getSkillDetailProductState(
  skill: SkillIndexEntry,
  currentUserId: string,
  panelTab: SkillPanelTab = 'mine',
  isPersonalOrganization = false,
): SkillDetailProductState {
  const detailKind = getSkillDetailKind(skill, currentUserId)
  const isUserSkill = normalizeSkillSource(skill.source) === 'user'
  const isOwner = isSkillOwnedByCurrentUser(skill, currentUserId)
  const isMineTab = isMineManagementTab(panelTab)
  const isInstalledTab = panelTab === 'enabled'
  const isDeviceLocal = detailKind === 'device_local'
  const isOrganizationSnapshot = isUserSkill && skill.visibility === 'organization'
  // ：工作区目录扫到的 Skill 只展示，不能当本机 interop 去「共享给组织」。
  const isWorkspaceScan = skill.meta?.from_workspace_scan === true

  return {
    detailKind,
    isOwner,
    isUserSkill,
    // 技能库页不再暴露用户总闸开关；启停改由 Agent 携带集子开关负责。
    canToggleAvailability: false,
    canShowUninstall: isInstalledTab && detailKind === 'marketplace_installed',
    // 我的私有原件 / 本机 Skill：共享时都物化一条组织可见静态快照。
    canShowMakeTeamVisible:
      !isPersonalOrganization
      && isMineTab
      && !isWorkspaceScan
      && (
        (isOwner && isUserSkill && skill.visibility === 'private')
        || isDeviceLocal
      ),
    // 组织精选对 owner 只保留「从组织中移除」；其它管理动作仍只在「我的」。
    canShowRemoveFromOrg:
      panelTab === 'organization'
      && isOwner
      && isOrganizationSnapshot,
    // 删除整条只针对「我的」私有原件；组织静态快照只能从组织移除。
    canShowDelete: isMineTab && isOwner && isUserSkill && !isOrganizationSnapshot,
    // 从「我的」移除接入：组织精选获取的非本人 Skill，以及已获取的市场压缩包。
    // 市场包不是 user 原件，不能走 discard；推荐货架仍不露卸载。
    canShowRemoveFromMine: isMineTab && skill.acquired === true && (
      (!isOwner && isUserSkill)
      || detailKind === 'marketplace_installed'
    ),
    // 他人 user skill：另存为我的副本（组织共享等）。
    // 公开市场口径（detailKind=marketplace_installed）的 user 条目不走此入口。
    canShowSaveAsCopy:
      !isOwner && isUserSkill && detailKind !== 'marketplace_installed',
    canShowForkToMine: false,
    canShowImportToSpace: false,
    canShowChangeCategory: isMineTab && isOwner && isUserSkill && !isOrganizationSnapshot,
  }
}
