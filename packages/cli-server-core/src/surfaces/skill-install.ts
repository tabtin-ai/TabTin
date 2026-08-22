/**
 * skill/install — 将 skill bundle 安装到本地 user/org skills 目录。
 *
 * 依赖注入：installSkillFromBundle / isValidSkillKey / resolveSkillDir 由宿主提供。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

export interface SkillBundleFile {
  path: string
  sha256: string
  size: number
  download_url: string
  content_type: string
}

export interface SkillInstallMeta {
  source: string
  version: string
  installedAt: string
  packageId: string
  versionSeq?: number
  bundleSha256?: string
}

interface _InstallResult {
  ok: boolean
  filesWritten: number
  error?: string
}

export interface SkillInstallDeps {
  isValidSkillKey: (key: string) => boolean
  /**
   * 解析 skill 本地目录。#7118：必须带真实 userId（禁止 `_unscoped`）。
   * organizationId 有值 → 组织 skills；否则 → 用户个人 skills。
   */
  resolveSkillDir: (
    skillKey: string,
    ctx: { userId: string; organizationId?: string },
  ) => string
  /** 可选：body 未带 userId 时由宿主从登录态解析 */
  resolveUserId?: () => Promise<string | undefined>
  installSkillFromBundle: (opts: {
    skillKey: string
    files: SkillBundleFile[]
    targetDir: string
    meta?: SkillInstallMeta
  }) => Promise<_InstallResult>
}

export interface SkillInstallInput {
  skillKey: string
  /** @deprecated  本地落盘不再按 space；保留字段兼容旧 caller */
  spaceId?: string
  userId?: string
  organizationId?: string
  files: SkillBundleFile[]
  meta?: SkillInstallMeta
}

export interface SkillInstallOutput {
  filesWritten: number
}

export function createSkillInstallSurface(deps: SkillInstallDeps) {
  return definePlatformSurface({
    module: 'skill',
    verb: 'install',
    kind: 'local',
    risk: 'write',
    errorCodes: ['VALIDATION_ERROR', 'INSTALL_FAILED'] as const,
    bindings: { ipc: true, http: true },

    handler: async (
      input: SkillInstallInput,
    ): Promise<SkillInstallOutput> => {
      if (!input?.skillKey) {
        throw new SurfaceError('VALIDATION_ERROR', 'skillKey 是必填参数')
      }
      if (!deps.isValidSkillKey(input.skillKey)) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          `skillKey 格式不合法: ${input.skillKey}`,
        )
      }

      const userId =
        (typeof input.userId === 'string' && input.userId.trim()) ||
        (await deps.resolveUserId?.()) ||
        ''
      if (!userId || userId === '_unscoped') {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          'userId 是必填参数（禁止落到 _unscoped skills 目录）',
        )
      }

      const organizationId =
        typeof input.organizationId === 'string' && input.organizationId.trim()
          ? input.organizationId.trim()
          : undefined

      const targetDir = deps.resolveSkillDir(input.skillKey, {
        userId,
        organizationId,
      })

      const result = await deps.installSkillFromBundle({
        skillKey: input.skillKey,
        files: input.files,
        targetDir,
        meta: input.meta,
      })

      if (!result.ok) {
        throw new SurfaceError(
          'INSTALL_FAILED',
          result.error ?? 'skill 安装失败',
          { filesWritten: result.filesWritten },
        )
      }

      return { filesWritten: result.filesWritten }
    },
  })
}
