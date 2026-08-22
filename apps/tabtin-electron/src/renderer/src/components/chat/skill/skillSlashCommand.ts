import { normalizeSkillSource, type SkillIndexEntry } from '@/skills/types'
import { isBuiltinCatalogSkill } from '@components/context-space/skills/skillProductState'
import {
  assignUniqueTokenWithSuffix,
  resolveDisambiguatedSlashToken,
} from './skillSlashTokenResolver'

export interface SkillSlashAvailabilityOptions {
  /** 未传时按小Tin 口径：本机无携带行仍默认可调。 */
  isDefaultAgent?: boolean
}

const SLASH_TOKEN_RE = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+([\s\S]*))?$/
const CURSOR_SLASH_RE = /(?:^|\s)\/([^\s/]*)$/

export interface SkillSlashCommandOption {
  kind: 'skill'
  skill: SkillIndexEntry
  token: string
  slug: string
  canonicalKey: string
  label: string
  description: string
}

export interface BuiltinSlashCommandOption {
  kind: 'builtin'
  command: 'compact'
  token: string
  slug: string
  canonicalKey: string
  label: string
  description: string
}

export type SlashCommandOption = SkillSlashCommandOption | BuiltinSlashCommandOption

export interface ParsedSkillSlashCommand {
  option: SkillSlashCommandOption
  args: string
}

export interface ParsedBuiltinSlashCommand {
  option: BuiltinSlashCommandOption
  args: string
}

function displayNameForSkill(skill: SkillIndexEntry): string {
  return skill.display_name || skill.name || skill.slug || skill.skill_key || skill.skill_id
}

function deriveSlugFromCanonicalKey(key: string): string {
  const afterColon = key.includes(':') ? key.split(':').slice(1).join(':') : key
  const afterSlash = afterColon.includes('/') ? afterColon.split('/').pop() : afterColon
  return (afterSlash || key).trim()
}

function canonicalKeyForSkill(skill: Pick<SkillIndexEntry, 'skill_key' | 'skill_id'>): string {
  return (skill.skill_key || skill.skill_id || '').trim().toLowerCase()
}

function canonicalPathParts(key: string): string[] {
  const afterColon = key.includes(':') ? key.split(':').slice(1).join(':') : key
  return afterColon.split('/').map(part => part.trim()).filter(Boolean)
}

function toSlashToken(slug: string): string | null {
  const trimmed = slug.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) return null
  return `/${trimmed}`
}

function sanitizeSlugPart(value: string | null | undefined): string {
  return (value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function skillSourcePriority(skill: SkillIndexEntry): number {
  switch (skill.source) {
    case 'platform':
      return 0
    case 'app':
      return 1
    case 'device':
      return 2
    case 'workspace':
      return 3
    case 'user':
      return 4
    default:
      return 5
  }
}

function disambiguationPrefixes(skill: SkillIndexEntry, baseSlug: string): string[] {
  const pathParts = canonicalPathParts(skill.skill_key || '')
  const owner = sanitizeSlugPart(
    skill.app_id
      || skill.package_id
      || (skill.source === 'platform' ? pathParts[0] : skill.source),
  )
  const source = sanitizeSlugPart(skill.source)
  const skillId = sanitizeSlugPart(skill.skill_id)

  return [owner, source, skillId]
    .filter(prefix => prefix && prefix.toLowerCase() !== baseSlug.toLowerCase())
}

function personalPluginSearchTerms(skill: SkillIndexEntry): string[] {
  const meta = skill.meta ?? {}
  return [
    meta.personal_plugin_id,
    meta.personal_plugin_name,
    meta.personal_plugin_display_name,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

/**
 * Skill 斜杠搜索相关度：数字越小越靠前；`null` = 不命中。
 *
 * 短查询（1–2 字）只打在命令 token / slug / 标题上，避免 description 里
 * 到处是 `t`/`a` 把列表撑爆，目标 skill 要敲到第 4 个字母才「看起来匹配」。
 * 前缀命中优先于子串，保证输入 `t` 时 `/table-operator` 一类出现在前排。
 */
export function scoreSkillSlashMatch(
  query: string,
  parts: {
    slug: string
    token: string
    label: string
    /** @deprecated 斜杠搜索不再用 description 命中，保留字段以免调用方改动 */
    description?: string
    extraTerms?: string[]
  },
): number | null {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0

  const slug = parts.slug.trim().toLowerCase()
  const token = parts.token.trim().toLowerCase()
  const tokenStem = token.startsWith('/') ? token.slice(1) : token
  const label = parts.label.trim().toLowerCase()
  void parts.description
  const extra = (parts.extraTerms || []).map(term => term.trim().toLowerCase()).filter(Boolean)

  if (slug === normalizedQuery || tokenStem === normalizedQuery) return 0
  if (slug.startsWith(normalizedQuery) || tokenStem.startsWith(normalizedQuery)) return 1
  if (label.startsWith(normalizedQuery)) return 2
  // kebab 分段前缀：`de` → systematic-**de**bugging；短查询也生效
  if (slug.split('-').some(segment => segment.startsWith(normalizedQuery))) return 2

  // 短查询只认前缀：否则 `t` 会命中所有含字母 t 的 slug（如 browser-opera**t**or）
  if (normalizedQuery.length < 3) return null

  if (slug.includes(normalizedQuery) || tokenStem.includes(normalizedQuery) || label.includes(normalizedQuery)) {
    return 3
  }

  // 斜杠弹层不扫 description（避免 tabs/tables 等文案噪音）；plugin meta 仍可命中
  if (normalizedQuery.length >= 3 && extra.some(term => term.includes(normalizedQuery))) {
    return 4
  }
  return null
}

export function buildSlashCommandToken(skill: Pick<SkillIndexEntry, 'slug' | 'skill_key' | 'name' | 'skill_id'>): string | null {
  const raw = skill.slug || (skill.skill_key ? deriveSlugFromCanonicalKey(skill.skill_key) : '') || skill.name || skill.skill_id
  return toSlashToken(raw)
}

/**
 * 斜杠 /「+」菜单可用判定。
 * - 封闭携带集（user / marketplace）：用户总闸未关且 `agent_enabled === true`
 * - 平台 / 内置 App：有携带行即可点（定制分身模板技能不能丢）；无行仅小Tin 默认可点
 * - 本机发现：小Tin 缺携带行默认可调；其他分身须显式分配
 * - 工作区目录 Skill：只对显式携带的 Agent 可见
 */
export function isSkillSlashAvailable(
  skill: SkillIndexEntry,
  options?: SkillSlashAvailabilityOptions,
): boolean {
  if (!skill.skill_key || skill.enabled === false) return false
  const isDefaultAgent = options?.isDefaultAgent !== false
  if (typeof skill.agent_enabled === 'boolean') return skill.agent_enabled
  if (
    normalizeSkillSource(skill.source) === 'device'
    || skill.skill_key.startsWith('device:')
  ) {
    return isDefaultAgent
  }
  if (isBuiltinCatalogSkill(skill)) return isDefaultAgent
  return false
}

export function buildSkillSlashCommandOptions(
  skills: SkillIndexEntry[],
  query = '',
  options?: SkillSlashAvailabilityOptions,
): SkillSlashCommandOption[] {
  const normalizedQuery = query.trim().toLowerCase()
  const candidates: Array<{
    skill: SkillIndexEntry
    baseToken: string
    baseSlug: string
    canonicalKey: string
    label: string
    description: string
    originalIndex: number
  }> = []
  const seenCanonicalKeys = new Set<string>()

  for (const [originalIndex, skill] of skills.entries()) {
    if (!isSkillSlashAvailable(skill, options) || !skill.skill_key) continue
    const canonicalKey = canonicalKeyForSkill(skill)
    if (!canonicalKey || seenCanonicalKeys.has(canonicalKey)) continue

    const baseToken = buildSlashCommandToken(skill)
    if (!baseToken) continue
    seenCanonicalKeys.add(canonicalKey)

    const label = displayNameForSkill(skill)
    const description = skill.description || ''

    candidates.push({
      skill,
      baseToken,
      baseSlug: baseToken.slice(1),
      canonicalKey: skill.skill_key,
      label,
      description,
      originalIndex,
    })
  }

  const groups = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    const key = candidate.baseToken.toLowerCase()
    const group = groups.get(key)
    if (group) {
      group.push(candidate)
    } else {
      groups.set(key, [candidate])
    }
  }

  const usedTokens = new Set<string>()
  const scoredOptions: Array<SkillSlashCommandOption & { score: number }> = []

  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => (
      skillSourcePriority(a.skill) - skillSourcePriority(b.skill)
      || a.originalIndex - b.originalIndex
    ))

    for (const [groupIndex, candidate] of ordered.entries()) {
      const prefixes = disambiguationPrefixes(candidate.skill, candidate.baseSlug)
      const candidateTokens = prefixes
        .map(prefix => toSlashToken(`${prefix}-${candidate.baseSlug}`))
        .filter((value): value is string => Boolean(value))
      const disambiguated = resolveDisambiguatedSlashToken(
        group.length,
        groupIndex,
        candidate.baseToken,
        candidate.baseSlug,
        candidateTokens,
        usedTokens,
      )
      const token = assignUniqueTokenWithSuffix(disambiguated, candidate.baseSlug, usedTokens)

      const slug = token.slice(1)
      const label = candidate.label
      const description = candidate.description
      const score = scoreSkillSlashMatch(normalizedQuery, {
        slug,
        token,
        label,
        description,
        extraTerms: personalPluginSearchTerms(candidate.skill),
      })
      if (score == null) continue

      scoredOptions.push({
        kind: 'skill',
        skill: candidate.skill,
        token,
        slug,
        canonicalKey: candidate.canonicalKey,
        label,
        description,
        score,
      })
    }
  }

  return scoredOptions
    .sort((a, b) => a.score - b.score || a.slug.localeCompare(b.slug))
    .map(({ score: _score, ...option }) => option)
}

export function buildBuiltinSlashCommandOptions(query = ''): BuiltinSlashCommandOption[] {
  const normalizedQuery = query.trim().toLowerCase()
  const options: BuiltinSlashCommandOption[] = [{
    kind: 'builtin',
    command: 'compact',
    token: '/compact',
    slug: 'compact',
    canonicalKey: 'builtin:compact',
    label: '压缩上下文',
    description: '将当前会话历史压缩成摘要，可附加侧重说明',
  }]

  if (!normalizedQuery) return options
  return options.filter(option => [
    option.token,
    option.slug,
    option.label,
    option.description,
  ].join(' ').toLowerCase().includes(normalizedQuery))
}

export function buildSlashCommandOptions(
  skills: SkillIndexEntry[],
  query = '',
  options?: SkillSlashAvailabilityOptions,
): SlashCommandOption[] {
  const normalizedQuery = query.trim().toLowerCase()
  const builtins = buildBuiltinSlashCommandOptions(query)
  const skillsOptions = buildSkillSlashCommandOptions(skills, query, options)
  // 有查询时保留 skill 侧的前缀优先序；builtin 仅在自身命中时插入，按同样相关度规则靠前。
  if (!normalizedQuery) {
    return [...builtins, ...skillsOptions].sort((a, b) => a.slug.localeCompare(b.slug))
  }
  const scored = [
    ...builtins.map(option => ({
      option,
      score: scoreSkillSlashMatch(normalizedQuery, {
        slug: option.slug,
        token: option.token,
        label: option.label,
        description: option.description,
      }) ?? 99,
    })),
    ...skillsOptions.map(option => ({
      option,
      score: scoreSkillSlashMatch(normalizedQuery, {
        slug: option.slug,
        token: option.token,
        label: option.label,
        description: option.description,
        extraTerms: option.kind === 'skill' ? personalPluginSearchTerms(option.skill) : [],
      }) ?? 99,
    })),
  ]
  return scored
    .sort((a, b) => a.score - b.score || a.option.slug.localeCompare(b.option.slug))
    .map(entry => entry.option)
}

export function detectSkillSlashQuery(value: string, cursorPos: number): { query: string; anchorPos: number } | null {
  const textBeforeCursor = value.slice(0, cursorPos)
  const match = textBeforeCursor.match(CURSOR_SLASH_RE)
  if (!match) return null
  return {
    query: match[1] ?? '',
    anchorPos: cursorPos - (match[1]?.length ?? 0) - 1,
  }
}

export function replaceSkillSlashToken(
  value: string,
  anchorPos: number,
  query: string,
  option: SlashCommandOption,
): { value: string; cursorPos: number } {
  const before = value.slice(0, anchorPos)
  const after = value.slice(anchorPos + query.length + 1)
  const insertion = `${option.token} `
  const nextValue = `${before}${insertion}${after.replace(/^\s*/, '')}`
  return {
    value: nextValue,
    cursorPos: before.length + insertion.length,
  }
}

export interface ComposerSkillTokenHighlight {
  /** token 起点（`/` 位置） */
  start: number
  /** token 终点（不含尾随空白） */
  end: number
  token: string
  option: SlashCommandOption
}

function findSlashOption(
  options: SlashCommandOption[],
  token: string,
  slug: string,
): SlashCommandOption | undefined {
  const tokenLower = token.toLowerCase()
  const slugLower = slug.toLowerCase()
  return options.find(candidate => (
    candidate.token.toLowerCase() === tokenLower
    || candidate.slug.toLowerCase() === slugLower
  ))
}

/**
 * 解析 composer 内全部「已确认」的斜杠 Skill / builtin token，供 pill 高亮。
 *
 * 不限行首——`replaceSkillSlashToken` 可在光标处插入第二、第三个 Skill。
 * 仅在 token 后为空白或文末时命中，避免输入 `/can` 过程中误着色。
 */
export function resolveComposerSkillTokenHighlights(
  value: string,
  options: SlashCommandOption[],
): ComposerSkillTokenHighlight[] {
  if (!value || options.length === 0) return []

  // 每次新建 /g regex，避免模块级 lastIndex 被并发调用踩脏
  const confirmedSlashTokenRe = /(?:^|\s)(\/([A-Za-z0-9][A-Za-z0-9._-]*))(?=\s|$)/g
  const highlights: ComposerSkillTokenHighlight[] = []
  let match: RegExpExecArray | null
  while ((match = confirmedSlashTokenRe.exec(value)) !== null) {
    const token = match[1] ?? ''
    const slug = match[2] ?? ''
    const option = findSlashOption(options, token, slug)
    if (!option) continue

    const start = match.index + match[0].length - token.length
    highlights.push({
      start,
      end: start + token.length,
      token: value.slice(start, start + token.length),
      option,
    })
  }
  return highlights
}

/** @deprecated 使用 {@link resolveComposerSkillTokenHighlights}；保留给只关心首个 token 的调用方 */
export function resolveComposerSkillTokenHighlight(
  value: string,
  options: SlashCommandOption[],
): ComposerSkillTokenHighlight | null {
  return resolveComposerSkillTokenHighlights(value, options)[0] ?? null
}

/**
 * Skill pill 作为原子块的删除区间：token 本身 + 紧随的一个分隔空白（插入时带的尾随空格）。
 */
export function resolveComposerSkillTokenUnitRange(
  highlight: ComposerSkillTokenHighlight,
  value: string,
): { start: number; end: number } {
  let end = highlight.end
  if (end < value.length && /\s/.test(value[end] ?? '')) {
    end += 1
  }
  return { start: highlight.start, end }
}

/**
 * Backspace / Delete 时整块移除光标触及的已确认 Skill pill（支持多个）。
 *
 * - 光标在 pill 内或紧贴其右侧（含尾随空格）按 Backspace
 * - 光标在 pill 起点或内部按 Delete
 * - 选区与 pill 相交时，扩选后整块删掉（可一次覆盖多个 pill）
 *
 * 不命中则返回 null，交给浏览器默认逐字删除。
 */
export function resolveComposerSkillTokenAtomicDeletion(params: {
  value: string
  selectionStart: number
  selectionEnd: number
  key: 'Backspace' | 'Delete'
  options: SlashCommandOption[]
}): { value: string; cursorPos: number } | null {
  const highlights = resolveComposerSkillTokenHighlights(params.value, params.options)
  if (highlights.length === 0) return null

  const units = highlights.map(h => resolveComposerSkillTokenUnitRange(h, params.value))
  const selStart = Math.min(params.selectionStart, params.selectionEnd)
  const selEnd = Math.max(params.selectionStart, params.selectionEnd)
  const hasSelection = selStart !== selEnd

  const intersecting = units.filter(unit => {
    if (hasSelection) return selEnd > unit.start && selStart < unit.end
    if (params.key === 'Backspace') return selStart > unit.start && selStart <= unit.end
    return selStart >= unit.start && selStart < unit.end
  })
  if (intersecting.length === 0) return null

  const unitStarts = intersecting.map(unit => unit.start)
  const unitEnds = intersecting.map(unit => unit.end)
  const deleteStart = hasSelection ? Math.min(selStart, ...unitStarts) : unitStarts[0]
  const deleteEnd = hasSelection ? Math.max(selEnd, ...unitEnds) : unitEnds[0]

  return {
    value: `${params.value.slice(0, deleteStart)}${params.value.slice(deleteEnd)}`,
    cursorPos: deleteStart,
  }
}

export function parseLeadingSkillSlashCommand(
  message: string,
  options: SlashCommandOption[],
): ParsedSkillSlashCommand | null {
  const trimmed = message.trim()
  const match = trimmed.match(SLASH_TOKEN_RE)
  if (!match) return null

  const slug = match[1].toLowerCase()
  const option = options.find((candidate): candidate is SkillSlashCommandOption => (
    candidate.kind === 'skill' && candidate.slug.toLowerCase() === slug
  ))
  if (!option) return null

  return {
    option,
    args: (match[2] ?? '').trim(),
  }
}

export function parseLeadingBuiltinSlashCommand(
  message: string,
  options: SlashCommandOption[],
): ParsedBuiltinSlashCommand | null {
  const trimmed = message.trim()
  const match = trimmed.match(SLASH_TOKEN_RE)
  if (!match) return null

  const slug = match[1].toLowerCase()
  const option = options.find((candidate): candidate is BuiltinSlashCommandOption => (
    candidate.kind === 'builtin' && candidate.slug.toLowerCase() === slug
  ))
  if (!option) return null

  return {
    option,
    args: (match[2] ?? '').trim(),
  }
}

/**
 * 消息以 `/token` 开头，但既不是内置命令也不是当前 Agent 可用 Skill 时，
 * 返回该 token（含 `/`），供发送前拦截提示。
 */
export function detectUnrecognizedLeadingSlashToken(
  message: string,
  options: SlashCommandOption[],
): string | null {
  const trimmed = message.trim()
  const match = trimmed.match(SLASH_TOKEN_RE)
  if (!match) return null
  if (parseLeadingBuiltinSlashCommand(trimmed, options)) return null
  if (parseLeadingSkillSlashCommand(trimmed, options)) return null
  return `/${match[1]}`
}
