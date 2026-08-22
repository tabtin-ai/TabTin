import { describe, expect, it } from 'vitest'
import type { SkillIndexEntry } from '@/skills/types'
import { localizeRecommendedMarketSkill } from './recommendedSkillCatalogLocale'

const officialSkill: SkillIndexEntry = {
  skill_id: 'skill-okr',
  skill_key: 'app:tabtin-business-analysis-pack/okr-planner',
  slug: 'okr-planner',
  name: 'okr-planner',
  display_name: 'OKR 制定与复盘',
  description: '中文描述',
  source: 'app',
  app_id: 'tabtin-business-analysis-pack',
  distribution: 'marketplace',
}

describe('localizeRecommendedMarketSkill', () => {
  it('uses English catalog copy for an official recommended skill', () => {
    const localized = localizeRecommendedMarketSkill(officialSkill, 'en-US')

    expect(localized.display_name).toBe('OKR Planning & Review')
    expect(localized.description).toContain('objectives and key results')
    expect(localized.skill_key).toBe(officialSkill.skill_key)
  })

  it('keeps the source copy for Chinese', () => {
    expect(localizeRecommendedMarketSkill(officialSkill, 'zh-CN')).toBe(officialSkill)
  })

  it.each(['ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES'])(
    'does not leak Chinese catalog copy in %s',
    (language) => {
      const localized = localizeRecommendedMarketSkill(officialSkill, language)
      expect(localized.display_name).toBe('OKR Planning & Review')
      expect(localized.description).not.toContain('中文')
    },
  )

  it('does not translate user-published skills with a matching slug', () => {
    const userSkill: SkillIndexEntry = {
      ...officialSkill,
      source: 'user',
      app_id: null,
      distribution: null,
      skill_key: 'user:okr-planner',
    }

    expect(localizeRecommendedMarketSkill(userSkill, 'en-US')).toBe(userSkill)
  })

  it('can resolve the stable slug from the canonical key', () => {
    const withoutSlug = { ...officialSkill, slug: undefined, name: 'legacy-name' }

    expect(localizeRecommendedMarketSkill(withoutSlug, 'en').display_name)
      .toBe('OKR Planning & Review')
  })
})
