/**
 * skill/resolve-path — 查询 skill 在本地 platform-data 的绝对路径。
 *
 * 给「查看源码 / 打开文件夹」用：renderer 不知道 platform-data 目录规则，
 * 也不知道 organizationId fallback 怎么走，统一让主进程算。
 *
 * 不创建目录、不写文件——纯查询，自带 `exists` 字段告诉调用方是否真有。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

// ─── 依赖接口 ──────────────────────────────────────────────────────

export interface SkillResolvePathDeps {
  isValidSkillKey: (key: string) => boolean
  /** ：宿主按 userId+organizationId 解析；spaceId 可忽略 */
  resolveSkillDir: (
    spaceId: string,
    organizationId: string,
    skillKey: string,
  ) => string | Promise<string>
  /** 返回路径是否存在（目录或文件均算 true，调用方自己区分） */
  pathExists: (absPath: string) => Promise<boolean>
  /**
   * 跨目录回退查找：在 users/{userId}/skills 与
   * users/{userId}/organizations/{orgId}/skills 下按 slug 找第一个含 SKILL.md 的目录。
   * 字段名保留 searchAcrossSpaces 兼容旧 caller。
   */
  findSkillDirAcrossSpaces?: (slug: string) => Promise<string | null>
}

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

export interface SkillResolvePathInput {
  spaceId: string
  organizationId: string
  /** Canonical key（`user:<slug>`）或 slug */
  skillKey: string
  /**
   * 当前 space 下没有 SKILL.md 时，是否跨 space 回退查找真实目录。
   * 发布/分享场景传 true（源文件可能在别的 space）；「打开当前 space 文件夹」传 false/省略。
   */
  searchAcrossSpaces?: boolean
}

export interface SkillResolvePathOutput {
  /** skill 目录绝对路径 */
  skillDir: string
  /** SKILL.md 绝对路径 */
  mdPath: string
  /** 目录是否真实存在 */
  exists: boolean
  /** SKILL.md 文件是否存在 */
  mdExists: boolean
  /** 是否由跨 space 回退查找命中（skillDir 指向的不是请求的 space） */
  resolvedAcrossSpaces?: boolean
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createSkillResolvePathSurface(deps: SkillResolvePathDeps) {
  return definePlatformSurface({
    module: 'skill',
    verb: 'resolve-path',
    kind: 'local',
    errorCodes: ['VALIDATION_ERROR'] as const,
    bindings: { ipc: true, http: true },

    handler: async (
      input: SkillResolvePathInput,
    ): Promise<SkillResolvePathOutput> => {
      if (!input?.skillKey) {
        throw new SurfaceError('VALIDATION_ERROR', 'skillKey 是必填参数')
      }
      if (!input.spaceId) {
        throw new SurfaceError('VALIDATION_ERROR', 'spaceId 是必填参数')
      }
      if (!input.organizationId) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          'organizationId 是必填参数',
        )
      }

      const slug = _extractSlug(input.skillKey)
      if (!slug || !deps.isValidSkillKey(slug)) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          `skill slug 格式不合法: ${slug}`,
        )
      }

      const skillDir = await deps.resolveSkillDir(
        input.spaceId,
        input.organizationId,
        slug,
      )
      const mdPath = `${skillDir.replace(/[/\\]$/, '')}/SKILL.md`
      const [exists, mdExists] = await Promise.all([
        deps.pathExists(skillDir),
        deps.pathExists(mdPath),
      ])

      // 当前 space 没有 SKILL.md 且调用方要求跨 space 回退：在用户全部 space 里找源文件。
      if (!mdExists && input.searchAcrossSpaces && deps.findSkillDirAcrossSpaces) {
        const foundDir = await deps.findSkillDirAcrossSpaces(slug)
        if (foundDir) {
          const foundMdPath = `${foundDir.replace(/[/\\]$/, '')}/SKILL.md`
          return {
            skillDir: foundDir,
            mdPath: foundMdPath,
            exists: true,
            mdExists: true,
            resolvedAcrossSpaces: true,
          }
        }
      }

      return { skillDir, mdPath, exists, mdExists }
    },
  })
}

function _extractSlug(skillKey: string): string {
  const idx = skillKey.indexOf(':')
  const slug = idx >= 0 ? skillKey.slice(idx + 1) : skillKey
  return slug.trim()
}
