/**
 * skill/write-content — 把草稿 SKILL.md 写入本地 platform-data。
 *
 * 为什么需要这个 surface（W6 后补丁）：
 *   - 旧路径让 renderer 调 `fs:ensureSpaceSandbox(spaceId)` + `fs:writeFile`
 *     自己拼 `{skillsPath}/{slug}/SKILL.md`，但 `ensureSpaceSandbox` 拿不到
 *     organizationId 时落到 `_unscoped`，而 LocalSkillRegistry 只 watch 带真实
 *     organizationId 的 root → 写完 Registry 也扫不到 → `skill:read-content`
 *     永远 null → 编辑器“暂无 SKILL.md 内容”。
 *   - 把路径解析、mkdir、写入、registry 失效统一收敛到主进程，renderer
 *     只持 `spaceId/organizationId/skillKey/content`，不用知道 platform-data
 *     目录结构。
 *
 * 依赖注入：
 *   - `resolveSkillDir`：与 `skill:install` 同源，解析 skill 目录绝对路径
 *   - `ensureSpaceSkills?`：写入后主动让 LocalSkillRegistry watch + 扫描该
 *     space skills 根（首次调用时才会注册 watcher，等同于 session 启动时的
 *     行为）
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

// ─── 依赖接口 ──────────────────────────────────────────────────────

export interface SkillWriteContentDeps {
  isValidSkillKey: (key: string) => boolean
  /** ：宿主按 userId+organizationId 解析；spaceId 可忽略 */
  resolveSkillDir: (
    spaceId: string,
    organizationId: string,
    skillKey: string,
  ) => string | Promise<string>
  /** mkdir -p + writeFile UTF-8 */
  writeSkillFile: (dirPath: string, fileName: string, content: string) => Promise<void>
  /**
   * 确保 user/org skills 根已 watch + 扫描。可选。
   * 签名仍带 spaceId 以兼容旧 caller。
   */
  ensureSpaceSkills?: (organizationId: string, spaceId: string) => Promise<void>
  /**
   * 主动重新读单个 skill 文件（绕过 watcher 延迟）。可选。
   */
  rescanSkill?: (skillDir: string) => Promise<void>
}

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

export interface SkillWriteContentInput {
  /** Skill 所属 Space */
  spaceId: string
  /** Space 所属 Organization（必填——避免落到 `_unscoped` 分裂目录） */
  organizationId: string
  /**
   * Canonical key（`user:<slug>`）或纯 slug。surface 内部统一抽出 slug
   * 作为目录名。
   */
  skillKey: string
  /** SKILL.md 完整正文（含 frontmatter） */
  content: string
}

export interface SkillWriteContentOutput {
  /** 写入的 SKILL.md 绝对路径 */
  mdPath: string
  /** skill 目录绝对路径（父目录） */
  skillDir: string
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createSkillWriteContentSurface(deps: SkillWriteContentDeps) {
  return definePlatformSurface({
    module: 'skill',
    verb: 'write-content',
    kind: 'local',
    risk: 'write', // ：写 SKILL.md 到 platform-data
    errorCodes: ['VALIDATION_ERROR', 'WRITE_FAILED'] as const,
    bindings: { ipc: true, http: true },

    handler: async (
      input: SkillWriteContentInput,
    ): Promise<SkillWriteContentOutput> => {
      if (!input?.skillKey) {
        throw new SurfaceError('VALIDATION_ERROR', 'skillKey 是必填参数')
      }
      if (!input.spaceId) {
        throw new SurfaceError('VALIDATION_ERROR', 'spaceId 是必填参数')
      }
      if (!input.organizationId) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          'organizationId 是必填参数（避免草稿落到 _unscoped 分裂目录）',
        )
      }
      if (typeof input.content !== 'string') {
        throw new SurfaceError('VALIDATION_ERROR', 'content 必须是字符串')
      }

      const slug = _extractSlug(input.skillKey)
      if (!slug) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          `无法从 skillKey 抽出 slug: ${input.skillKey}`,
        )
      }
      if (!deps.isValidSkillKey(slug)) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          `skill slug 格式不合法: ${slug}`,
        )
      }

      // 先 ensure（注册 watcher + scanRoot），保证写完后 Registry 能监听到。
      // 不存在 ensureSpaceSkills 时不阻断；后续靠 watcher 自然 fs 事件。
      if (deps.ensureSpaceSkills) {
        try {
          await deps.ensureSpaceSkills(input.organizationId, input.spaceId)
        } catch {
          // ensureSpaceSkills 失败不阻断写入——保留草稿优先
        }
      }

      const skillDir = await deps.resolveSkillDir(
        input.spaceId,
        input.organizationId,
        slug,
      )

      try {
        await deps.writeSkillFile(skillDir, 'SKILL.md', input.content)
      } catch (err) {
        throw new SurfaceError(
          'WRITE_FAILED',
          err instanceof Error ? err.message : '写入 SKILL.md 失败',
          { skillDir },
        )
      }

      if (deps.rescanSkill) {
        try {
          await deps.rescanSkill(skillDir)
        } catch {
          // 主动 rescan 失败不阻断；watcher 会兜底
        }
      }

      // path.join 由调用方传 `fileName` 自己拼也行，这里直接 / 拼。
      // 跨平台：deps.writeSkillFile 内已 normalize 过路径，回传给前端只用做
      // 跳转 TabCode / 展示用，无需平台相关 separator。
      const mdPath = `${skillDir.replace(/[/\\]$/, '')}/SKILL.md`
      return { mdPath, skillDir }
    },
  })
}

// ─── helpers ───────────────────────────────────────────────────────

function _extractSlug(skillKey: string): string {
  const idx = skillKey.indexOf(':')
  const slug = idx >= 0 ? skillKey.slice(idx + 1) : skillKey
  return slug.trim()
}
