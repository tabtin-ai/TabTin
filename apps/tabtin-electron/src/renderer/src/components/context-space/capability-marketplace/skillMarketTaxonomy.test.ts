import { describe, expect, it } from 'vitest'

import {
  isRecommendedMarketPackSkill,
  resolveSkillMarketCategory,
  SKILL_MARKET_CATEGORY_ORDER,
} from './skillMarketTaxonomy'

describe('resolveSkillMarketCategory', () => {
  it.each([
    ['writing', 'writing'],
    ['collab', 'collab'],
    ['data', 'data'],
    ['research', 'research'],
    ['creative', 'creative'],
    ['engineering', 'engineering'],
  ] as const)('分类 %s 对应压缩包文件夹 key %s', (input, expected) => {
    expect(resolveSkillMarketCategory(input)).toBe(expected)
  })

  it('推荐分类顺序与压缩包文件夹一致', () => {
    expect([...SKILL_MARKET_CATEGORY_ORDER]).toEqual([
      'writing',
      'collab',
      'data',
      'research',
      'creative',
      'engineering',
    ])
  })

  it('未分类 / 旧细分类不进新推荐 chip', () => {
    expect(resolveSkillMarketCategory(null)).toBeNull()
    expect(resolveSkillMarketCategory('developer')).toBeNull()
    expect(resolveSkillMarketCategory('analysis')).toBeNull()
  })
})

describe('isRecommendedMarketPackSkill', () => {
  it('只认压缩包 6 个 pack', () => {
    expect(isRecommendedMarketPackSkill({
      app_id: 'tabtin-writing-tools-pack',
      distribution: 'marketplace',
    })).toBe(true)
    expect(isRecommendedMarketPackSkill({
      app_id: 'tabtin-office-skills-pack',
      distribution: 'marketplace',
    })).toBe(false)
    expect(isRecommendedMarketPackSkill({
      app_id: 'tabdata',
      distribution: 'builtin',
    })).toBe(false)
  })
})
