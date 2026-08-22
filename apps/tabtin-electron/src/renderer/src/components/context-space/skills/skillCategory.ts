/**
 * Skill 分类枚举（共 27 类，两组用途并存）：
 *
 * - **能力域（能力域组）**：面向**内置技能**的平台能力维度。
 *   data / doc / web / media / device / collaboration / workflow / knowledge /
 *   communication / automation.
 * - **消费类（通用组）**：面向**市场 / 用户自建技能**的消费者视角分类。
 *   productivity / writing / research / analysis / project_management / sales_crm /
 *   customer_support / education / finance / hr / legal / marketing / design /
 *   developer / ai_media / lifestyle / other。
 *
 * ⚠️ 常量名沿用历史 `MARKET` 前缀（市场筛选等引用方未重命名），但语义已不只市场——
 *   详情页分类 badge（`normalizeSkillCategory`）与新建技能下拉都消费这套枚举。
 * ⚠️ 后端 `VALID_SKILL_CATEGORIES`
 *   （apps/tabtin_django/apps/skills/services/skill_service.py）必须与本枚举保持同步，
 *   否则用户在新建对话框选了新分类会被创建接口的 `_normalize_category` 拦截。
 */

/** 通用 / 消费组——市场 + 用户自建技能（developer 归此组，避免与能力域重复列举）。 */
export const SKILL_CONSUMER_CATEGORIES = [
  'productivity',
  'writing',
  'research',
  'analysis',
  'project_management',
  'sales_crm',
  'customer_support',
  'education',
  'finance',
  'hr',
  'legal',
  'marketing',
  'design',
  'developer',
  'ai_media',
  'lifestyle',
  'other',
] as const

/** 能力域组——内置技能能力维度（developer 已在通用组，这里不重复列出）。 */
export const SKILL_CAPABILITY_CATEGORIES = [
  'data',
  'doc',
  'web',
  'media',
  'device',
  'collaboration',
  'workflow',
  'knowledge',
  'communication',
  'automation',
] as const

/** 全部分类（消费类 + 能力域，共 27 类）。历史名沿用，详见文件头注释。 */
export const SKILL_MARKET_CATEGORIES = [
  ...SKILL_CONSUMER_CATEGORIES,
  ...SKILL_CAPABILITY_CATEGORIES,
] as const

/** 列表页分组展示顺序：能力域在前，消费类在后。 */
export const SKILL_CATEGORY_DISPLAY_ORDER = [
  ...SKILL_CAPABILITY_CATEGORIES,
  ...SKILL_CONSUMER_CATEGORIES,
] as const

/**
 * 列表页**展示分组**（粗粒度）：把 27 细分类合并成少量「xx与xx」标题，降低扫读碎片感。
 * 仅影响 Skill 面板列表分区；详情 badge / 新建下拉仍用 `SKILL_MARKET_CATEGORIES` 细分类。
 */
export const SKILL_LIST_DISPLAY_GROUPS = [
  {
    id: 'data',
    labelKey: 'skills.panel.categoryGroup.data',
    categories: ['data'] as const,
  },
  {
    id: 'doc_knowledge',
    labelKey: 'skills.panel.categoryGroup.docKnowledge',
    categories: ['doc', 'knowledge', 'writing'] as const,
  },
  {
    id: 'dev_runtime',
    labelKey: 'skills.panel.categoryGroup.devRuntime',
    categories: ['developer', 'web', 'device', 'automation'] as const,
  },
  {
    id: 'collab_workflow',
    labelKey: 'skills.panel.categoryGroup.collabWorkflow',
    categories: ['collaboration', 'communication', 'workflow', 'project_management'] as const,
  },
  {
    id: 'media_design',
    labelKey: 'skills.panel.categoryGroup.mediaDesign',
    categories: ['media', 'design', 'ai_media'] as const,
  },
  {
    id: 'productivity_research',
    labelKey: 'skills.panel.categoryGroup.productivityResearch',
    categories: ['productivity', 'research', 'analysis', 'education'] as const,
  },
  {
    id: 'business_misc',
    labelKey: 'skills.panel.categoryGroup.businessMisc',
    categories: [
      'sales_crm', 'customer_support', 'marketing', 'finance', 'hr', 'legal', 'lifestyle', 'other',
    ] as const,
  },
] as const

export type SkillListDisplayGroupId = typeof SKILL_LIST_DISPLAY_GROUPS[number]['id']

const SKILL_CATEGORY_TO_DISPLAY_GROUP = new Map<SkillMarketCategory, SkillListDisplayGroupId>(
  SKILL_LIST_DISPLAY_GROUPS.flatMap((group) =>
    group.categories.map((cat) => [cat, group.id] as const),
  ),
)

export function resolveSkillListDisplayGroupId(
  category: string | null | undefined,
): SkillListDisplayGroupId | null {
  const normalized = normalizeSkillCategory(category)
  if (!normalized) return null
  return SKILL_CATEGORY_TO_DISPLAY_GROUP.get(normalized) ?? null
}

export type SkillMarketCategory = typeof SKILL_MARKET_CATEGORIES[number]

/**
 * 新建技能下拉的分组（能力域组在前，通用组在后）。
 * group label 的 i18n key 见 `context.json` 的 `skills.createDialog.categoryGroup.*`。
 */
export const SKILL_CATEGORY_GROUPS = [
  {
    labelKey: 'skills.createDialog.categoryGroup.capability',
    categories: SKILL_CAPABILITY_CATEGORIES,
  },
  {
    labelKey: 'skills.createDialog.categoryGroup.general',
    categories: SKILL_CONSUMER_CATEGORIES,
  },
] as const

export function normalizeSkillCategory(value: string | null | undefined): SkillMarketCategory | null {
  const normalized = (value || '').trim().toLowerCase()
  if (!normalized) return null
  return (SKILL_MARKET_CATEGORIES as readonly string[]).includes(normalized)
    ? normalized as SkillMarketCategory
    : null
}

export function skillCategoryLabelKey(category: string | null | undefined): string | null {
  const normalized = normalizeSkillCategory(category)
  return normalized ? `skillMarket.category.${normalized}` : null
}

export const SKILL_UNCLASSIFIED_LABEL_KEY = 'skillMarket.category.unclassified'

export function skillCategoryLabelKeyWithFallback(
  category: string | null | undefined,
): string {
  return skillCategoryLabelKey(category) ?? SKILL_UNCLASSIFIED_LABEL_KEY
}

export interface SkillCategoryGroup<T> {
  /** 展示分组 id；未分类为 null。 */
  groupId: SkillListDisplayGroupId | null
  /** 分组标题的 i18n key（`skills.panel.categoryGroup.*` 或 unclassified）。 */
  labelKey: string
  skills: T[]
}

/**
 * 按**展示分组**把 Skill 分区，用于列表页。
 * - 多个细分类合并为一个「xx与xx」标题（见 `SKILL_LIST_DISPLAY_GROUPS`）。
 * - 组内保持输入顺序；空组不产出。
 */
export function groupSkillsByCategory<T extends { category?: string | null }>(
  skills: T[],
): SkillCategoryGroup<T>[] {
  const buckets = new Map<SkillListDisplayGroupId, T[]>()
  const unclassified: T[] = []
  for (const skill of skills) {
    const groupId = resolveSkillListDisplayGroupId(skill.category)
    if (!groupId) {
      unclassified.push(skill)
      continue
    }
    const arr = buckets.get(groupId)
    if (arr) arr.push(skill)
    else buckets.set(groupId, [skill])
  }

  const groups: SkillCategoryGroup<T>[] = []
  for (const group of SKILL_LIST_DISPLAY_GROUPS) {
    const arr = buckets.get(group.id)
    if (arr && arr.length) {
      groups.push({ groupId: group.id, labelKey: group.labelKey, skills: arr })
    }
  }
  if (unclassified.length) {
    groups.push({ groupId: null, labelKey: SKILL_UNCLASSIFIED_LABEL_KEY, skills: unclassified })
  }
  return groups
}
