/**
 * skill/read-content — 按 skillKey 查询本地 skill 内容。
 *
 * 迁移自 ElectronAgentHost.ts:1179-1228。原逻辑：等 skillsReady →
 * 从 registry 按 key 或 path-part fallback 查找 → 返回 content。
 *
 * 依赖注入模式：handler 需要访问宿主的 skills 模块状态（skillsReady
 * Promise + registry 实例），这些属于 Electron / Daemon 宿主内部状态，
 * cli-server-core 不直接引用。通过工厂函数接收依赖，调用方在
 * startup-services.ts 传入实际实现。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

// ─── 依赖接口 ──────────────────────────────────────────────────────

/**
 * Skill registry 中单个 skill 的最小信息。
 *
 * 不引用 @tabtin/agent-runtime 的完整类型，只声明 handler 用到的
 * 字段，避免 cli-server-core 引入重量级依赖。
 */
interface _SkillEntry {
  canonicalKey: string
  content?: string | null
}

/**
 * Skill registry 的最小接口——handler 只需要 listAll / getByKey。
 */
interface _SkillRegistry {
  listAll(): _SkillEntry[]
  getByKey(key: string): _SkillEntry | undefined
}

/**
 * 创建 skill/read-content surface 所需的宿主依赖。
 *
 * 由 startup-services.ts 在注册时传入——ElectronAgentHost 实例
 * 提供 skillsReady Promise 和 registry getter。
 */
export interface SkillReadContentDeps {
  /**
   * skills 模块初始化的 Promise。为 null 表示未启动。
   * handler 等待此 Promise 完成（带 5s 超时），确保 registry 可用。
   */
  getSkillsReady: () => Promise<void> | null
  /** 获取 skill registry 实例，未初始化时返回 null */
  getSkillsRegistry: () => _SkillRegistry | null
  /**
   * 可选：解析本地 skill 目录（：users/{userId}/organizations/{org}/skills/{slug}）。
   * spaceId 仅兼容旧 caller，宿主可忽略。
   */
  resolveSkillDir?: (
    spaceId: string,
    organizationId: string,
    slug: string,
  ) => string | Promise<string>
  /** 可选：读取本地 SKILL.md；不存在时返回 null。 */
  readSkillFile?: (skillDir: string, fileName: string) => Promise<string | null>
  /**
   * 可选：读取内置 skill 的源 SKILL.md。调用方必须自己做路径边界校验，
   * 避免 renderer 传入任意路径。
   */
  readSourceSkillFile?: (docPath: string) => Promise<string | null>
}

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

/** handler 输入：要查询的 skill key */
export interface SkillReadContentInput {
  skillKey: string
  /** 当前 Space；传入后 registry 不可用/未命中时可回退读本地文件。 */
  spaceId?: string | null
  /** Space 所属 Organization；避免回退到 `_unscoped`。 */
  organizationId?: string | null
  /**
   * 后端索引返回的内置源文件路径。用于 platform/app skill 尚未预装到当前
   * Space 时直接回源预览正文。
   */
  sourceDocPath?: string | null
}

/** handler 输出：skill 文件内容（未找到时为 null） */
export interface SkillReadContentOutput {
  content: string | null
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

/**
 * 创建并注册 skill/read-content surface。
 *
 * 等 skillsReady（5s 超时）后从 registry 查找 skill。
 * 支持 exact key 匹配和 path-part fallback（兼容旧 "source:path" 格式）。
 */
export function createSkillReadContentSurface(deps: SkillReadContentDeps) {
  return definePlatformSurface({
    module: 'skill',
    verb: 'read-content',
    kind: 'local',
    errorCodes: ['VALIDATION_ERROR', 'SKILL_REGISTRY_UNAVAILABLE'] as const,
    bindings: { ipc: true, http: true },

    handler: async (
      input: SkillReadContentInput,
    ): Promise<SkillReadContentOutput> => {
      if (!input?.skillKey) {
        throw new SurfaceError('VALIDATION_ERROR', 'skillKey 是必填参数')
      }

      const tryReadLocalFile = async (): Promise<SkillReadContentOutput | null> => {
        if (!deps.resolveSkillDir || !deps.readSkillFile) return null
        // ：本地文件回退只需 organizationId；spaceId 可选（兼容旧 caller）
        if (!input.organizationId) return null
        const slug = _extractSlug(input.skillKey)
        if (!slug) return null
        const skillDir = await deps.resolveSkillDir(
          input.spaceId ?? '',
          input.organizationId,
          slug,
        )
        const content = await deps.readSkillFile(skillDir, 'SKILL.md')
        if (content == null) return null
        return { content }
      }

      const tryReadSourceFile = async (): Promise<SkillReadContentOutput | null> => {
        if (!deps.readSourceSkillFile || !input.sourceDocPath) return null
        const content = await deps.readSourceSkillFile(input.sourceDocPath)
        if (content == null) return null
        return { content }
      }

      const shouldPreferLocalFile = _isUserSkillKey(input.skillKey)

      // ── 等 skills 模块就绪（5s 超时防卡死）。UI 已经知道当前 Space 时，
      // registry 不可用不应让草稿编辑器崩掉，后面会回退直接读本地 SKILL.md。
      const ready = deps.getSkillsReady()
      if (ready) {
        try {
          await Promise.race([
            ready,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('skills ready timeout')), 5_000),
            ),
          ])
        } catch {
          const local = await tryReadLocalFile()
          if (local) return local
          const source = await tryReadSourceFile()
          if (source) return source
          throw new SurfaceError(
            'SKILL_REGISTRY_UNAVAILABLE',
            'Skill registry 未初始化或初始化超时',
          )
        }
      }

      const registry = deps.getSkillsRegistry()
      if (!registry) {
        const local = await tryReadLocalFile()
        if (local) return local
        const source = await tryReadSourceFile()
        if (source) return source
        throw new SurfaceError(
          'SKILL_REGISTRY_UNAVAILABLE',
          'Skill registry 未初始化或初始化超时',
        )
      }

      // User/Mine skills are editable working copies. If the caller provides
      // a concrete Space + Organization, read the local SKILL.md first instead of
      // the registry snapshot, because the registry watcher can lag behind a
      // just-saved draft. Builtins still use registry/source fallback below.
      if (shouldPreferLocalFile) {
        const local = await tryReadLocalFile()
        if (local) return local
      }

      // ── exact key 匹配 ──
      let skill = registry.getByKey(input.skillKey)

      // ── path-part fallback（兼容 "source:path" 格式的 key） ──
      if (!skill) {
        const pathPart = input.skillKey.includes(':')
          ? input.skillKey.split(':').slice(1).join(':')
          : input.skillKey
        skill = registry.listAll().find((s) => {
          const sPath = s.canonicalKey.includes(':')
            ? s.canonicalKey.split(':').slice(1).join(':')
            : s.canonicalKey
          return sPath === pathPart
        })
      }

      if (skill?.content != null) {
        return { content: skill.content }
      }

      const local = await tryReadLocalFile()
      if (local) return local
      const source = await tryReadSourceFile()
      if (source) return source
      return { content: null }
    },
  })
}

function _extractSlug(skillKey: string): string {
  const idx = skillKey.indexOf(':')
  const slug = idx >= 0 ? skillKey.slice(idx + 1) : skillKey
  return slug.trim()
}

function _isUserSkillKey(skillKey: string): boolean {
  if (!skillKey.includes(':')) return true
  return skillKey.trim().toLowerCase().startsWith('user:')
}
