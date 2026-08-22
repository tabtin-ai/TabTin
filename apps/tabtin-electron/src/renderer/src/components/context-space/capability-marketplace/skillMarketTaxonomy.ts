/**
 * 能力市场「推荐」分类 = 压缩包文件夹名（文档写作 / 协作效率 / …）。
 * skill.category 与下列 key 一一对应，不再做细分类合并。
 */
export const SKILL_MARKET_CATEGORY_ORDER = [
  'writing',
  'collab',
  'data',
  'research',
  'creative',
  'engineering',
] as const

export type SkillMarketCategory = (typeof SKILL_MARKET_CATEGORY_ORDER)[number]

/** 推荐货架只展示这批压缩包导入的 pack（不含内置 Operator / 其它 marketplace pack）。 */
export const RECOMMENDED_MARKET_PACK_IDS = new Set([
  'tabtin-writing-tools-pack',
  'tabtin-collab-efficiency-pack',
  'tabtin-data-toolkit-pack',
  'tabtin-business-analysis-pack',
  'tabtin-creative-toolkit-pack',
  'tabtin-dev-toolkit-pack',
])

const CATEGORY_KEYS = new Set<string>(SKILL_MARKET_CATEGORY_ORDER)

export function resolveSkillMarketCategory(category: string | null | undefined): SkillMarketCategory | null {
  const normalized = category?.trim().toLowerCase()
  if (!normalized) return null
  return CATEGORY_KEYS.has(normalized) ? (normalized as SkillMarketCategory) : null
}

export function isRecommendedMarketPackSkill(skill: {
  app_id?: string | null
  source?: string | null
  distribution?: string | null
}): boolean {
  const appId = typeof skill.app_id === 'string' ? skill.app_id.trim() : ''
  if (!appId || !RECOMMENDED_MARKET_PACK_IDS.has(appId)) return false
  return skill.distribution === 'marketplace'
}
