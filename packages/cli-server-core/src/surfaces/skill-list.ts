/**
 * skill/list — list local Skill catalog entries for a Space.
 *
 * Renderer code should not derive platform-data paths or ask Django for bundled
 * platform/app Skills. The host owns LocalSkillRegistry and must ensure the
 * Space has been materialized before returning the local catalog.
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError } from '../surface/types.js'

// ─── 依赖接口 ──────────────────────────────────────────────────────

type _SkillSource = 'platform' | 'app' | 'device' | 'user'

interface _SkillRequirements {
  bins?: string[]
  any_bins?: string[]
  env?: string[]
  config?: string[]
}

interface _SkillInstallSpec {
  id: string
  kind: 'brew' | 'node' | 'pip' | 'go' | 'download'
  formula?: string
  package?: string
  module?: string
  url?: string
  bins?: string[]
  label?: string
  os?: string[]
}

interface _SkillAgentDefinition {
  filename: string
  name: string
  description?: string
  model?: string
  reply_mode?: string
  tool_domains?: string[]
}

interface _LocalSkillEntry {
  canonicalKey: string
  source: _SkillSource
  metaSource?: _SkillSource
  scope?: string
  appId?: string
  spaceId?: string
  slug: string
  name: string
  displayName?: string
  description?: string
  whenToUse?: string
  version?: string
  docPath: string
  realpath?: string
  contentHash?: string
  primaryEnv?: string
  xTabtinApps?: string[]
  xTabtinAgents?: string[]
  tags?: string[]
  category?: string
  requires?: _SkillRequirements
  install?: _SkillInstallSpec[]
  osFilter?: string[]
  always?: boolean
  emoji?: string
  homepage?: string
  agents?: _SkillAgentDefinition[]
  rootKind?: string
  personalPluginId?: string
  personalPluginName?: string
  personalPluginDisplayName?: string
}

interface _SkillRegistry {
  listForSpace(
    spaceId: string,
    options?: { organizationId?: string },
  ): _LocalSkillEntry[]
}

export interface SkillListDeps {
  /** skills 模块初始化 Promise；null 表示当前宿主未启用 skills 模块。 */
  getSkillsReady: () => Promise<void> | null
  /** 获取 LocalSkillRegistry；未初始化时返回 null。 */
  getSkillsRegistry: () => _SkillRegistry | null
  /**
   * 确保当前用户/组织 skills 目录已预装并被 registry 扫描。
   * 签名仍带 spaceId 以兼容旧 caller；宿主可忽略 spaceId，改为 ensureUser/Org。
   */
  ensureSpaceSkills: (organizationId: string, spaceId: string) => Promise<void>
  /** 列出当前 Space 已启用的 Personal Plugin skills；宿主可选实现。 */
  listPersonalPluginSkills?: (input: SkillListInput) => Promise<_LocalSkillEntry[]>
  /** 等待 skills ready 的超时；默认 5s，测试可缩短。 */
  readyTimeoutMs?: number
}

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

export interface SkillListInput {
  spaceId: string
  organizationId: string
}

export interface SkillListEntry {
  skill_id: string
  /** 机器可读短名；聊天 slash picker 用它生成 `/slug`。 */
  slug?: string
  name: string
  /** 归一化展示名（metadata.tabtin.displayName / 旧 name / slug 美化）。 */
  display_name?: string
  description?: string
  version?: string
  source: _SkillSource
  app_id?: string | null
  skill_key: string
  path?: string
  doc_path?: string
  tags?: string[]
  /** UI 分类（详情页 badge 用），来自 frontmatter `metadata.tabtin.category`。 */
  category?: string | null
  status?: string
  meta?: Record<string, unknown>
  enabled?: boolean
  primary_env?: string
  emoji?: string
  os_filter?: string[]
  always?: boolean
  requires?: _SkillRequirements
  install?: _SkillInstallSpec[]
  homepage?: string
  agents?: _SkillAgentDefinition[]
}

export interface SkillListOutput {
  skills: SkillListEntry[]
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createSkillListSurface(deps: SkillListDeps) {
  return definePlatformSurface({
    module: 'skill',
    verb: 'list',
    kind: 'local',
    errorCodes: ['VALIDATION_ERROR', 'SKILL_REGISTRY_UNAVAILABLE'] as const,
    bindings: { ipc: true, http: true },

    handler: async (
      input: SkillListInput,
    ): Promise<SkillListOutput> => {
      if (!input?.spaceId) {
        throw new SurfaceError('VALIDATION_ERROR', 'spaceId 是必填参数')
      }
      if (!input.organizationId) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          'organizationId 是必填参数（避免 renderer 推导本地技能路径）',
        )
      }

      const ready = deps.getSkillsReady()
      if (ready) {
        try {
          const timeoutMs = deps.readyTimeoutMs ?? 5_000
          await Promise.race([
            ready,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('skills ready timeout')), timeoutMs),
            ),
          ])
        } catch {
          throw new SurfaceError(
            'SKILL_REGISTRY_UNAVAILABLE',
            'Skill registry 未初始化或初始化超时',
          )
        }
      }

      try {
        await deps.ensureSpaceSkills(input.organizationId, input.spaceId)
      } catch (err) {
        throw new SurfaceError(
          'SKILL_REGISTRY_UNAVAILABLE',
          err instanceof Error ? err.message : 'Skill registry 初始化 Space 失败',
        )
      }

      const registry = deps.getSkillsRegistry()
      if (!registry) {
        throw new SurfaceError(
          'SKILL_REGISTRY_UNAVAILABLE',
          'Skill registry 未初始化或初始化超时',
        )
      }

      let personalPluginSkills: _LocalSkillEntry[] = []
      if (deps.listPersonalPluginSkills) {
        try {
          personalPluginSkills = await deps.listPersonalPluginSkills(input)
        } catch (err) {
          throw new SurfaceError(
            'SKILL_REGISTRY_UNAVAILABLE',
            err instanceof Error ? err.message : 'Personal Plugin skills 加载失败',
          )
        }
      }

      const skills = mergeLocalSkillEntriesForList([
        ...registry.listForSpace(input.spaceId, {
          organizationId: input.organizationId,
        }),
        ...personalPluginSkills,
      ])
        .map(toSkillListEntry)
        .sort((a, b) => {
          if (a.source !== b.source) return a.source.localeCompare(b.source)
          return a.skill_key.localeCompare(b.skill_key)
        })

      return { skills }
    },
  })
}

function mergeLocalSkillEntriesForList(skills: _LocalSkillEntry[]): _LocalSkillEntry[] {
  const byKey = new Map<string, _LocalSkillEntry>()
  for (const skill of skills) {
    const existing = byKey.get(skill.canonicalKey)
    if (existing?.personalPluginId && !skill.personalPluginId) continue
    byKey.set(skill.canonicalKey, skill)
  }
  return Array.from(byKey.values())
}

function toSkillListEntry(skill: _LocalSkillEntry): SkillListEntry {
  const source = skill.metaSource ?? skill.source
  const docDir = stripSkillMd(skill.docPath)
  // 本机扫描 skill 默认关闭；面板以 Space enablement（configs）为准覆盖展示态
  const deviceOptInOff = source === 'device'
  return {
    skill_id: skill.slug,
    slug: skill.slug,
    name: skill.name || skill.slug,
    display_name: skill.displayName || beautifySkillSlug(skill.slug),
    description: skill.description,
    version: skill.version,
    source,
    app_id: skill.appId ?? null,
    skill_key: skill.canonicalKey,
    path: docDir,
    doc_path: skill.docPath,
    tags: skill.tags ?? [],
    category: skill.category ?? null,
    status: deviceOptInOff ? 'disabled' : 'enabled',
    enabled: !deviceOptInOff,
    primary_env: skill.primaryEnv,
    emoji: skill.emoji,
    os_filter: skill.osFilter,
    always: skill.always,
    requires: skill.requires,
    install: skill.install,
    homepage: skill.homepage,
    agents: skill.agents,
    meta: {
      scope: skill.scope,
      rootKind: skill.rootKind,
      source,
      appId: skill.appId,
      personal_plugin_id: skill.personalPluginId,
      personal_plugin_name: skill.personalPluginName,
      personal_plugin_display_name: skill.personalPluginDisplayName,
      when_to_use: skill.whenToUse,
      tags: skill.tags,
      x_tabtin_apps: skill.xTabtinApps,
      x_tabtin_agents: skill.xTabtinAgents,
      realpath: skill.realpath,
      content_hash: skill.contentHash,
    },
  }
}

function stripSkillMd(docPath: string): string {
  return docPath.replace(/[\\/]SKILL\.md$/, '')
}

/** slug / 目录名 → Title Case 展示名兜底（`table-operator` → `Table Operator`）。 */
function beautifySkillSlug(slug: string): string {
  if (!slug) return ''
  const seg = slug.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? slug
  const words = seg.split(/[-_\s]+/).filter(Boolean)
  if (!words.length) return seg
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
