/**
 * 「共享给组织」产品口径（2026-07 收口）：
 *
 * - **我的 Skill（user / private）**：共享时创建组织可见的静态快照，原件保持私有。
 * - **本机 Skill（device）**：同样物化成一条组织可见的静态快照。
 * - **重复共享**：每次都尝试创建新快照，不在前端复用或覆盖；标识名重复由前端对照组织精选 + 后端闸门拦截。
 * - **编辑隔离**：组织快照只读，后续编辑「我的」原件不会自动更新已共享快照。
 */
import type { SkillIndexEntry } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { createLogger } from '@/utils/logger'
import {
  formatSemVer,
  suggestNextSemVer,
} from './skillSemver'
import { MAX_SKILL_SLUG_LENGTH, resolveUserSkillSlug, slugifySkillName } from './skillSlug'
import { isOrganizationSharedUserSkill } from './skillSourceGroups'

const log = createLogger('SkillShare')

export function nextVersionLabelForShare(skill: SkillIndexEntry): string {
  const existing: string[] = []
  if (skill.latest_version_label?.trim()) existing.push(skill.latest_version_label.trim())
  return formatSemVer(suggestNextSemVer(existing))
}

export type ShareOrgCopyFile = {
  path: string
  content: string
  encoding?: 'text' | 'base64'
}

/** 原件的稳定 slug（与后端 create 时 slugify 对齐）。 */
export function resolveShareIdentitySlug(params: {
  displayName: string
  skill?: SkillIndexEntry | null
}): string {
  const fromSkillKey = params.skill?.skill_key?.trim() || ''
  // device:ai-pm-self-tracking / user:ai-pm-self-tracking
  if (fromSkillKey.includes(':')) {
    const segment = fromSkillKey.slice(fromSkillKey.indexOf(':') + 1).trim()
    if (segment) return slugifySkillName(segment)
  }
  if (params.skill) {
    const fromUser = resolveUserSkillSlug(params.skill)
    if (fromUser) return slugifySkillName(fromUser)
  }
  return slugifySkillName(params.displayName)
}

/**
 * 同一个原件在同一个组织内始终映射到同一个快照 slug：
 * - 首次共享不会与私有原件的 slug 冲突；
 * - 再次共享会由后端 reject 策略明确报重复；
 * - 同一用户加入多个组织时，各组织快照互不冲突。
 */
export function buildOrganizationSnapshotSlug(sourceSlug: string, organizationId: string): string {
  const organizationToken = slugifySkillName(organizationId).replaceAll('-', '').slice(0, 12)
    || 'organization'
  const suffix = `-org-${organizationToken}`
  const normalizedSource = slugifySkillName(sourceSlug)
  const copySuffix = normalizedSource.match(/-copy(?:-\d+)?$/)?.[0] || ''
  if (copySuffix) {
    const sourceSnapshotSlug = normalizedSource.slice(0, -copySuffix.length)
    if (sourceSnapshotSlug.endsWith(suffix)) return sourceSnapshotSlug
  }
  const maxBaseLength = MAX_SKILL_SLUG_LENGTH - suffix.length
  const base = normalizedSource.slice(0, maxBaseLength).replace(/-+$/, '') || 'skill'
  return `${base}${suffix}`
}

/** 从组织精选条目取出可比对的标识名（slug）。 */
export function resolveOrganizationSkillSlug(skill: Pick<SkillIndexEntry, 'slug' | 'skill_key' | 'name'>): string {
  return resolveUserSkillSlug(skill)
}

/** 共享前对照当前组织精选；同标识快照已存在时禁止重复分享。 */
export function findOrganizationSlugConflict(params: {
  snapshotSlug: string
  organizationId: string
  organizationSkills: readonly SkillIndexEntry[]
}): { slug: string } | null {
  const target = (params.snapshotSlug || '').trim()
  if (!target) return null
  const hit = params.organizationSkills.find((skill) => {
    if (!isOrganizationSharedUserSkill(skill, params.organizationId)) return false
    return resolveOrganizationSkillSlug(skill) === target
  })
  return hit ? { slug: target } : null
}

export interface ShareSkillToOrganizationParams {
  skill: SkillIndexEntry
  organizationId: string
  /** 当前登录用户，用于把可恢复草稿严格限制在本人名下。 */
  currentUserId?: string
  displayName: string
  description?: string
  /** 当前组织精选列表（用于共享前标识名去重）；缺省则只依赖后端闸门。 */
  organizationSkills?: readonly SkillIndexEntry[]
  /** create / publish 结果不确定时绕过缓存重新查询服务端状态。 */
  reloadSkills?: () => Promise<readonly SkillIndexEntry[]>
  resolveSkillDir: () => Promise<string>
  collectFiles: (skillDir: string) => Promise<{
    files: ShareOrgCopyFile[]
    skipped: unknown[]
  }>
  hasSkillMd: (files: ShareOrgCopyFile[]) => boolean
  createSkill: (payload: {
    organization_id: string
    agent_id?: string
    name: string
    description?: string
    slug?: string
    slug_conflict_policy?: 'suffix' | 'reject'
  }) => Promise<SkillIndexEntry & { skill_key?: string; skill_id?: string; name?: string }>
  publishSkill: (payload: {
    skillId: string
    organization_id: string
    agent_id?: string
    version_label: string
    visibility: 'organization'
    change_note: string
    files: ShareOrgCopyFile[]
  }) => Promise<unknown>
  deleteSkill: (skillId: string) => Promise<void>
}

export interface ShareSkillToOrganizationResult {
  skill: SkillIndexEntry & { skill_key?: string; skill_id?: string; name?: string }
  skippedFileCount: number
  mode: 'organization_snapshot'
}

function isOwnedUserSkill(skill: SkillIndexEntry, currentUserId: string): boolean {
  return Boolean(
    currentUserId
    && normalizeSkillSource(skill.source) === 'user'
    && String(skill.owner_user_id || '') === currentUserId,
  )
}

function findRecoverablePrivateSnapshot(params: {
  snapshotSlug: string
  currentUserId: string
  skills: readonly SkillIndexEntry[]
}): SkillIndexEntry | null {
  return params.skills.find((skill) => (
    Boolean(skill.skill_id)
    && isOwnedUserSkill(skill, params.currentUserId)
    && skill.visibility === 'private'
    && resolveOrganizationSkillSlug(skill) === params.snapshotSlug
  )) || null
}

function findPublishedSnapshot(params: {
  snapshotSlug: string
  organizationId: string
  currentUserId: string
  skillId: string
  skills: readonly SkillIndexEntry[]
}): SkillIndexEntry | null {
  return params.skills.find((skill) => (
    skill.skill_id === params.skillId
    && isOwnedUserSkill(skill, params.currentUserId)
    && isOrganizationSharedUserSkill(skill, params.organizationId)
    && resolveOrganizationSkillSlug(skill) === params.snapshotSlug
  )) || null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isUncertainNetworkError(error: unknown): boolean {
  return /request timeout|socket hang up|network error|econnreset|etimedout/i.test(errorText(error))
}

function shouldProbeCreateRecovery(error: unknown): boolean {
  return isUncertainNetworkError(error) || /标识名已存在|already exists/i.test(errorText(error))
}

async function reloadForRecovery(
  reloadSkills: ShareSkillToOrganizationParams['reloadSkills'],
  phase: 'create' | 'publish',
): Promise<readonly SkillIndexEntry[]> {
  if (!reloadSkills) return []
  try {
    return await reloadSkills()
  } catch (error) {
    log.warn('共享恢复：重新拉取 Skill 状态失败', { phase }, error)
    return []
  }
}

export async function shareSkillToOrganization(
  params: ShareSkillToOrganizationParams,
): Promise<ShareSkillToOrganizationResult> {
  const displayName = params.displayName.trim()
  const sourceSlug = resolveShareIdentitySlug({ displayName, skill: params.skill })
  const snapshotSlug = buildOrganizationSnapshotSlug(sourceSlug, params.organizationId)

  const source = normalizeSkillSource(params.skill.source)
  if (source !== 'user' && source !== 'device') {
    throw new Error(`unsupported skill source for share: ${source}`)
  }

  const conflict = findOrganizationSlugConflict({
    snapshotSlug,
    organizationId: params.organizationId,
    organizationSkills: params.organizationSkills || [],
  })
  if (conflict) {
    throw new Error(
      `组织内已存在相同标识名的 Skill（slug=${conflict.slug}），请更换后再共享`,
    )
  }

  const skillDir = await params.resolveSkillDir()
  if (!skillDir) {
    throw new Error('本地文件不可用。请确认本机 Skill 目录仍存在。')
  }
  const collected = await params.collectFiles(skillDir)
  if (!params.hasSkillMd(collected.files)) {
    throw new Error('collected files missing SKILL.md')
  }

  const currentUserId = (params.currentUserId || '').trim()
  let created: SkillIndexEntry & { skill_key?: string; skill_id?: string; name?: string } | null
    = findRecoverablePrivateSnapshot({
      snapshotSlug,
      currentUserId,
      skills: params.organizationSkills || [],
    })

  if (created) {
    log.warn('共享恢复：复用已有私有快照草稿', {
      skillId: created.skill_id,
      snapshotSlug,
    })
  }

  try {
    if (!created) {
      try {
        // 展示名沿用原件；组织专属 slug + reject 保证首次成功、重复共享显式失败。
        created = await params.createSkill({
          organization_id: params.organizationId,
          name: displayName,
          slug: snapshotSlug,
          slug_conflict_policy: 'reject',
          description: (params.description || params.skill.description || '').trim(),
        })
      } catch (createError) {
        if (!shouldProbeCreateRecovery(createError)) throw createError
        const latestSkills = await reloadForRecovery(params.reloadSkills, 'create')
        created = findRecoverablePrivateSnapshot({
          snapshotSlug,
          currentUserId,
          skills: latestSkills,
        })
        if (!created) throw createError
        log.warn('共享恢复：create 结果不确定，已找到服务端私有草稿', {
          skillId: created.skill_id,
          snapshotSlug,
        })
      }
    }

    const copyId = created.skill_id
    if (!copyId) throw new Error('create returned no skill_id')

    try {
      await params.publishSkill({
        skillId: copyId,
        organization_id: params.organizationId,
        version_label: nextVersionLabelForShare(created),
        visibility: 'organization',
        change_note: 'share-to-organization',
        files: collected.files,
      })
    } catch (publishError) {
      if (isUncertainNetworkError(publishError)) {
        const latestSkills = await reloadForRecovery(params.reloadSkills, 'publish')
        const published = findPublishedSnapshot({
          snapshotSlug,
          organizationId: params.organizationId,
          currentUserId,
          skillId: copyId,
          skills: latestSkills,
        })
        if (published) {
          created = published
          log.warn('共享恢复：publish 响应丢失，服务端快照已可见', {
            skillId: copyId,
            snapshotSlug,
          })
        } else {
          // 网络错误只代表客户端没有拿到结果，不能据此删除服务端可能已成功的快照。
          throw publishError
        }
      } else {
        throw publishError
      }
    }

    return {
      skill: { ...created, name: created.name || displayName, visibility: 'organization' },
      skippedFileCount: collected.skipped.length,
      mode: 'organization_snapshot',
    }
  } catch (err) {
    const copyId = created?.skill_id
    if (copyId && !isUncertainNetworkError(err)) {
      try {
        await params.deleteSkill(copyId)
      } catch (cleanupErr) {
        const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        const origin = err instanceof Error ? err.message : String(err)
        throw new Error(
          `${origin}；且清理半成品失败（${detail}）。请手动删除「${displayName}」。`,
        )
      }
    }
    throw err
  }
}

export async function resolveShareSourceDir(params: {
  skill: SkillIndexEntry
  spaceId: string
  organizationId: string
  resolveLocalPath: (args: {
    spaceId: string
    organizationId: string
    skillKey: string
    searchAcrossSpaces?: boolean
  }) => Promise<{ skillDir: string; mdExists: boolean } | null>
  restorePublishedVersion?: (args: {
    skill: SkillIndexEntry
    spaceId: string
    organizationId: string
    versionSeq: number
  }) => Promise<void>
}): Promise<string> {
  const { skill, spaceId, organizationId, resolveLocalPath, restorePublishedVersion } = params
  const isDevice = normalizeSkillSource(skill.source) === 'device'
  if (isDevice) {
    return (skill.path || '').trim()
  }
  const skillKey = skill.skill_key || ''
  if (skillKey) {
    const resolved = await resolveLocalPath({
      spaceId,
      organizationId,
      skillKey,
      searchAcrossSpaces: true,
    })
    if (resolved?.mdExists) return resolved.skillDir

    // IPC 不可用时保留历史 path 兼容；已明确探测到 mdExists=false 则不能把陈旧
    // 路径当真，必须从云端不可变版本恢复。
    if (!resolved) {
      const legacyPath = (skill.path || '').trim()
      if (legacyPath) return legacyPath
    }
  } else {
    const legacyPath = (skill.path || '').trim()
    if (legacyPath) return legacyPath
  }

  const versionSeq = skill.latest_version_seq
  if (!restorePublishedVersion || !skill.package_id || !versionSeq) {
    throw new Error('该 Skill 从未发布且本机原件已丢失，无法恢复')
  }

  await restorePublishedVersion({
    skill,
    spaceId,
    organizationId,
    versionSeq,
  })

  const restored = await resolveLocalPath({
    spaceId,
    organizationId,
    skillKey,
    searchAcrossSpaces: true,
  })
  if (!restored?.mdExists) {
    throw new Error('云端版本恢复后仍未找到 SKILL.md，无法共享')
  }
  return restored.skillDir
}
