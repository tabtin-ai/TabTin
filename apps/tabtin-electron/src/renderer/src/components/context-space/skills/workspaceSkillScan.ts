/**
 * ：把主进程 workspace-scan 结果映射成 SkillIndexEntry。
 * 用于技能库发现、Composer `/` 菜单；发现归工作区，使用权仍按 Agent 携带集控制。
 */
import type { SkillIndexEntry } from '@/skills/types'
import type { DeviceControlView } from '@/services/deviceControlMatch'
import {
  listLocalWorkspaces,
  type LocalWorkspaceCandidate,
} from '@/components/sidebar/localWorkspaceNeed'

export const WORKSPACE_SCAN_META_FLAG = 'from_workspace_scan' as const

export interface WorkspaceScanSkillEntry {
  key: string
  slug: string
  name: string
  display_name?: string
  description?: string
  emoji?: string
  rel_path?: string
  doc_path?: string
  /** 与云端 D11 算法一致的整个 Skill 目录内容哈希。 */
  content_hash?: string
  /** SKILL.md 解算软链接后的真实路径。 */
  realpath?: string
}

export interface WorkspaceSkillScanTarget {
  spaceId: string
  spaceName: string
  workspaceRoot: string
}

/**
 * Workspace 目录发现只服务「我的 / 工作区」货架。
 * 推荐、组织精选和全部货架不需要为了计数提前触发本机磁盘扫描。
 */
export function shouldScanWorkspaceSkills(input: {
  sourceFilter: string
  workspaceScopeId?: string | null
}): boolean {
  return input.sourceFilter === 'mine' || Boolean(input.workspaceScopeId)
}

/**
 * 目录 Skill 只能扫描当前用户 API 返回的、本组织、本机个人 Workspace。
 * `listLocalWorkspaces` 同时排除他机、team_space 与 Project/Task 系统伴生现场；
 * 用户边界由后端 Workspace API 的成员权限过滤保证。
 */
export function resolveWorkspaceSkillScanTargets(
  spaces: readonly (LocalWorkspaceCandidate & { working_dir?: string | null })[],
  organizationId: string | null,
  currentDevice: DeviceControlView | null,
  devices: readonly DeviceControlView[] = [],
): WorkspaceSkillScanTarget[] {
  return listLocalWorkspaces(spaces, organizationId, currentDevice, { devices })
    .filter((space) => typeof space.working_dir === 'string' && space.working_dir.trim().length > 0)
    .map((space) => ({
      spaceId: space.id,
      spaceName: space.name.trim() || space.id,
      workspaceRoot: space.working_dir!.trim(),
    }))
}

export function isWorkspaceScanSkill(skill: SkillIndexEntry): boolean {
  return skill.meta?.[WORKSPACE_SCAN_META_FLAG] === true
    || skill.source === 'workspace'
    || Boolean(skill.skill_key?.startsWith('workspace:'))
}

export function mapWorkspaceScanToSkillIndexEntry(
  entry: WorkspaceScanSkillEntry,
  opts: {
    spaceId: string
    spaceName: string
    /** 当前 Agent 是否显式携带；未传时按封闭携带集默认关闭。 */
    agentEnabled?: boolean
  },
): SkillIndexEntry {
  return {
    skill_id: entry.key,
    skill_key: entry.key,
    slug: entry.slug,
    name: entry.name,
    display_name: entry.display_name || entry.name,
    description: entry.description,
    emoji: entry.emoji,
    source: 'workspace',
    path: entry.doc_path,
    doc_path: entry.doc_path,
    enabled: true,
    agent_enabled: opts.agentEnabled ?? false,
    meta: {
      [WORKSPACE_SCAN_META_FLAG]: true,
      workspace_space_id: opts.spaceId,
      workspace_space_name: opts.spaceName,
      rel_path: entry.rel_path,
      content_hash: entry.content_hash,
      realpath: entry.realpath,
    },
  }
}

function normalizeContentHash(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function getSkillContentHash(skill: SkillIndexEntry): string | null {
  return normalizeContentHash(
    skill.meta?.content_hash
    ?? skill.install_content_hash,
  )
}

function normalizeIdentityText(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized || null
}

function normalizeSourceUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase()
  }
}

function normalizeLocalPath(value: unknown): string | null {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  return normalized || null
}

interface SkillIdentity {
  canonicalKey: string | null
  packageId: string | null
  sourceUrl: string | null
  contentHash: string | null
  realpath: string | null
  slug: string | null
}

function getSkillIdentity(skill: SkillIndexEntry): SkillIdentity {
  const canonicalKey = normalizeIdentityText(skill.skill_key || skill.skill_id)
  const workspaceSpaceId = isWorkspaceScanSkill(skill)
    ? normalizeIdentityText(skill.meta?.workspace_space_id)
    : null

  return {
    // workspace:* 是相对路径键，只在所属 Workspace 内稳定，不能跨 Workspace 直接比较。
    canonicalKey: canonicalKey && workspaceSpaceId
      ? `${workspaceSpaceId}:${canonicalKey}`
      : canonicalKey,
    packageId: normalizeIdentityText(skill.package_id ?? skill.meta?.packageId),
    sourceUrl: normalizeSourceUrl(skill.import_source_url ?? skill.meta?.import_source_url),
    contentHash: getSkillContentHash(skill),
    realpath: normalizeLocalPath(skill.meta?.realpath ?? skill.doc_path ?? skill.path),
    slug: normalizeIdentityText(skill.slug || skill.name),
  }
}

function hasSameStrongIdentity(left: SkillIdentity, right: SkillIdentity): boolean {
  return Boolean(
    (left.canonicalKey && left.canonicalKey === right.canonicalKey)
    || (left.packageId && left.packageId === right.packageId)
    || (left.sourceUrl && left.sourceUrl === right.sourceUrl)
    || (left.contentHash && left.contentHash === right.contentHash)
    || (left.realpath && left.realpath === right.realpath),
  )
}

function hasConflictingSemanticIdentity(left: SkillIdentity, right: SkillIdentity): boolean {
  return Boolean(
    (left.packageId && right.packageId && left.packageId !== right.packageId)
    || (left.sourceUrl && right.sourceUrl && left.sourceUrl !== right.sourceUrl)
    || (left.contentHash && right.contentHash && left.contentHash !== right.contentHash),
  )
}

function isSameSkillIdentity(left: SkillIdentity, right: SkillIdentity): boolean {
  if (hasSameStrongIdentity(left, right)) return true
  return Boolean(
    left.slug
    && left.slug === right.slug
    && !hasConflictingSemanticIdentity(left, right),
  )
}

/**
 * 本机候选列表的内容级去重 seam。
 *
 * 候选按输入顺序保留第一个；身份优先级为稳定 key / package / 来源地址 /
 * 内容哈希 / realpath。旧数据缺少强身份时才回落 slug；若双方强身份明确冲突，
 * 即使同名也保留，避免误吞用户的本机改版。
 */
export function dedupeMachineDiscoveredSkills(
  candidates: readonly SkillIndexEntry[],
  catalogSkills: readonly SkillIndexEntry[],
): SkillIndexEntry[] {
  const seen = catalogSkills.map(getSkillIdentity)
  const result: SkillIndexEntry[] = []

  for (const skill of candidates) {
    const identity = getSkillIdentity(skill)
    if (seen.some(existing => isSameSkillIdentity(identity, existing))) continue
    seen.push(identity)
    result.push(skill)
  }

  return result
}
