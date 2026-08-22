/**
 * skill/materialize-app — 按需把一个 marketplace 分发的 app skill（或首方 package
 * skill）的 bundled 源物化进当前 Space 的本地 skills 目录。
 *
 * 背景（ app 子案）：`collectAppSources` 刻意把 `distribution==='marketplace'`
 * 的 app skill 排除出默认预装（"等用户安装时再落盘"），但客户端 enable 链路此前只给
 * `user`+`package_id` 的 Package Registry 技能落盘。于是商店里的 app 技能点安装后，
 * 后端有 enablement、面板显示已装，但本地 `skills/` 没文件 → `LocalSkillRegistry`
 * 扫不到 → Agent 的 `<skills>` 段看不到。本 surface 补上「app 技能安装时落本地盘」，
 * 闭合「面板已装 == 本地有文件 == Agent 可见」。
 *
 * 依赖注入：`materializeAppSkill` 由宿主（Electron main 的 skills module）提供——它能
 * 访问 bundled 源目录（appsRoot）与 `LocalSkillRegistry`，cli-server-core 不直接引用。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

// ─── 依赖接口 ──────────────────────────────────────────────────────

/** 物化结果（对齐 preinstaller 的 PreinstallResult 子集）。 */
interface _MaterializeResult {
  installed: number
  skipped: number
  errors: string[]
}

export interface SkillMaterializeAppDeps {
  /**
   * 把指定 app skill 的 bundled 源拷进
   * `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`，
   * 并让 registry 立即可见。找不到 bundled 源 / 未初始化时抛错。
   */
  materializeAppSkill: (params: {
    organizationId: string
    /** @deprecated  本地落盘不再按 space */
    spaceId?: string
    userId?: string
    appId: string
    slug: string
  }) => Promise<_MaterializeResult>
}

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

export interface SkillMaterializeAppInput {
  /** @deprecated  本地落盘不再按 space；保留兼容旧 caller */
  spaceId?: string
  organizationId: string
  userId?: string
  appId: string
  slug: string
}

export interface SkillMaterializeAppOutput {
  installed: number
  skipped: number
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

/**
 * 创建并注册 skill/materialize-app surface。
 *
 * 校验 spaceId / organizationId / appId / slug → materializeAppSkill → 成功返
 * `{installed, skipped}`，失败抛 SurfaceError。
 */
export function createSkillMaterializeAppSurface(deps: SkillMaterializeAppDeps) {
  return definePlatformSurface({
    module: 'skill',
    verb: 'materialize-app',
    kind: 'local',
    errorCodes: ['VALIDATION_ERROR', 'MATERIALIZE_FAILED'] as const,
    bindings: { ipc: true, http: true },

    handler: async (
      input: SkillMaterializeAppInput,
    ): Promise<SkillMaterializeAppOutput> => {
      if (!input?.organizationId) {
        throw new SurfaceError('VALIDATION_ERROR', 'organizationId 是必填参数')
      }
      if (!input?.appId) {
        throw new SurfaceError('VALIDATION_ERROR', 'appId 是必填参数')
      }
      if (!input?.slug) {
        throw new SurfaceError('VALIDATION_ERROR', 'slug 是必填参数')
      }

      let result: _MaterializeResult
      try {
        result = await deps.materializeAppSkill({
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          userId: input.userId,
          appId: input.appId,
          slug: input.slug,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new SurfaceError('MATERIALIZE_FAILED', message)
      }

      if (result.errors.length > 0 && result.installed === 0) {
        throw new SurfaceError(
          'MATERIALIZE_FAILED',
          result.errors.join('; '),
          { installed: result.installed, skipped: result.skipped },
        )
      }

      return { installed: result.installed, skipped: result.skipped }
    },
  })
}
