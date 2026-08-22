/**
 * User Skill slug 预览（与 Django `slug_utils.slugify_skill_name` 行为对齐）。
 */

export const MAX_SKILL_SLUG_LENGTH = 64
const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function slugifySkillName(raw: string): string {
  const s = (raw || '').trim().toLowerCase()
  const cleaned: string[] = []
  for (const ch of s) {
    if (/[a-z0-9-]/.test(ch)) {
      cleaned.push(ch)
    } else if (/[\s_/\\]/.test(ch)) {
      cleaned.push('-')
    }
  }
  let result = cleaned.join('')
  while (result.includes('--')) {
    result = result.replace('--', '-')
  }
  result = result.replace(/^-+|-+$/g, '') || 'skill'
  if (result.length > MAX_SKILL_SLUG_LENGTH) {
    result = result.replace(/-+$/, '').slice(0, MAX_SKILL_SLUG_LENGTH) || 'skill'
  }
  return result
}

export function isValidKebabSlug(slug: string): boolean {
  return Boolean(slug) && KEBAB_SLUG_RE.test(slug) && slug.length <= MAX_SKILL_SLUG_LENGTH
}

export function userCanonicalKeyFromSlug(slug: string): string {
  return `user:${slug}`
}

/** 仅 user 来源 Skill 的 kebab slug（不含路径斜杠） */
export function resolveUserSkillSlug(skill: {
  slug?: string | null
  skill_key?: string | null
  name?: string | null
}): string {
  const explicit = (skill.slug || '').trim()
  if (explicit) return explicit
  const key = (skill.skill_key || '').trim()
  if (key.startsWith('user:')) {
    return key.slice('user:'.length)
  }
  if ((skill.name || '').trim()) {
    return slugifySkillName(skill.name!)
  }
  return 'skill'
}

/** user Skill 命令式展示名：`/deep-explain` */
export function formatUserSkillSlashName(skill: {
  slug?: string | null
  skill_key?: string | null
  name?: string | null
}): string {
  return `/${resolveUserSkillSlug(skill)}`
}

/**
 * 从 canonical key 提取 UI 用 kebab 段（只影响展示，不改 skill_key / 目录名）。
 * - `user:deep-explain` → `deep-explain`
 * - `app:tabcode/tabcode-operator` → `tabcode-operator`（app 末段已唯一，取最后一段）
 * - `platform:device/operations` → `device-operations`（platform 保留 domain，否则
 *   device/mcp/tabslide 三个 `operations` 会撞成同名 `/operations`，UI 无法区分）
 */
export function resolveSlashLabelSegment(skillKey: string): string {
  const key = (skillKey || '').trim()
  if (!key) return 'skill'
  if (key.startsWith('user:')) {
    return resolveUserSkillSlug({ skill_key: key })
  }
  if (key.includes(':')) {
    const prefix = key.slice(0, key.indexOf(':'))
    const path = key.slice(key.indexOf(':') + 1)
    const segments = path.split('/').filter(Boolean)
    // platform skill 用 `domain-slug` 区分同名 slug（三个 operations 分属
    // device/mcp/tabslide）；app/user 末段已唯一，仅取末段避免 appId 冗余重复。
    const segment = prefix === 'platform' && segments.length > 1
      ? segments.join('-')
      : (segments.pop() || path)
    if (segment && isValidKebabSlug(segment)) return segment
    if (segment) return slugifySkillName(segment)
  }
  return slugifySkillName(key)
}

/** kebab / 目录段 → Title Case 展示名（`table-operator` → `Table Operator`）。 */
export function beautifyKebab(slug: string): string {
  const seg = (slug || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || (slug || '')
  const words = seg.split(/[-_\s]+/).filter(Boolean)
  if (!words.length) return seg
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/**
 * Skill 人类可读展示名（A 阶段统一口径）：
 * 1. `display_name`（后端/扫描层归一化结果：metadata.tabtin.displayName 等）
 * 2. 旧格式顶层 `name`（当它是人类标题，即非 kebab-case）
 * 3. slug / canonical key 段美化兜底
 *
 * 注意：列表/详情标题仍用 `formatSkillPanelTitle`（`/kebab` 命令式）；本函数用于
 * 市场卡片标题、配置弹窗、toast、搜索/排序等需要「人话名字」的场景。
 */
function looksLikePackPath(value: string): boolean {
  return value.includes('/')
}

export function resolveSkillDisplayName(skill: {
  display_name?: string | null
  name?: string | null
  slug?: string | null
  skill_key?: string | null
  skill_id?: string | null
}): string {
  const explicit = (skill.display_name || '').trim()
  if (explicit && !looksLikePackPath(explicit)) return explicit
  const name = (skill.name || '').trim()
  if (name && !isValidKebabSlug(name) && !looksLikePackPath(name)) return name
  const segment = resolveSlashLabelSegment(
    (skill.skill_key || skill.slug || name || skill.skill_id || '').trim(),
  )
  return beautifyKebab(segment) || name || 'Skill'
}

/**
 * 携带集标题：有人话名字就用；否则只留 canonical key 末段，
 * 去掉 `tabtin-data-ai-pack/` 这类包名前缀。
 */
export function resolveSkillCarryTitle(skill: {
  display_name?: string | null
  name?: string | null
  skill_key?: string | null
}): string {
  const explicit = (skill.display_name || '').trim()
  if (explicit && !looksLikePackPath(explicit)) return explicit
  const name = (skill.name || '').trim()
  if (name && !looksLikePackPath(name)) return name
  const raw = (skill.skill_key || name || '').trim()
  const key = raw.includes(':') ? raw : (looksLikePackPath(raw) ? `app:${raw}` : raw)
  return resolveSlashLabelSegment(key) || name || 'Skill'
}

/** Skill Tab 列表 / 详情标题：统一 `/kebab-slug`（纯 UI，不动后端与 canonical key） */
export function formatSkillPanelTitle(skill: {
  slug?: string | null
  skill_key?: string | null
  name?: string | null
  skill_id?: string | null
}): string {
  const key = (skill.skill_key || '').trim()
  if (key) {
    return `/${resolveSlashLabelSegment(key)}`
  }
  const explicit = (skill.slug || '').trim()
  if (explicit) {
    return `/${isValidKebabSlug(explicit) ? explicit : slugifySkillName(explicit)}`
  }
  const fromName = (skill.name || '').trim()
  if (fromName) {
    return `/${slugifySkillName(fromName)}`
  }
  return `/${slugifySkillName(skill.skill_id || 'skill')}`
}
