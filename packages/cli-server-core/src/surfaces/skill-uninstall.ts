/**
 * skill/uninstall — 从本地 user/org skills 目录卸载 skill。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

interface _StatResult {
  isDirectory(): boolean
}

export interface SkillUninstallDeps {
  isValidSkillKey: (key: string) => boolean
  resolveSkillDir: (
    skillKey: string,
    ctx: { userId: string; organizationId?: string },
  ) => string
  resolveUserId?: () => Promise<string | undefined>
  uninstallSkillLocal: (dir: string) => Promise<boolean>
  statOrNull: (path: string) => Promise<_StatResult | null>
}

export interface SkillUninstallInput {
  skillKey: string
  /** @deprecated  保留兼容 */
  spaceId?: string
  userId?: string
  organizationId?: string
}

export interface SkillUninstallOutput {
  missing?: boolean
}

export function createSkillUninstallSurface(deps: SkillUninstallDeps) {
  return definePlatformSurface({
    module: 'skill',
    verb: 'uninstall',
    kind: 'local',
    risk: 'high-risk-write',
    errorCodes: ['VALIDATION_ERROR', 'UNINSTALL_FAILED'] as const,
    bindings: { ipc: true, http: true },

    handler: async (
      input: SkillUninstallInput,
    ): Promise<SkillUninstallOutput> => {
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

      const targetStat = await deps.statOrNull(targetDir)
      if (!targetStat) {
        return { missing: true }
      }

      if (!targetStat.isDirectory()) {
        throw new SurfaceError(
          'UNINSTALL_FAILED',
          `Local skill target is not a directory: ${targetDir}`,
        )
      }

      const removed = await deps.uninstallSkillLocal(targetDir)
      if (removed) {
        return {}
      }

      const postStat = await deps.statOrNull(targetDir)
      if (!postStat) {
        return { missing: true }
      }

      throw new SurfaceError(
        'UNINSTALL_FAILED',
        `Local skill directory removal failed: ${targetDir}`,
      )
    },
  })
}
