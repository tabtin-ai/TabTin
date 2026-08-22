import { describe, expect, it } from 'vitest'
import { inferLocalizedTierType, resolveTierDisplayName } from '../subscriptionFormat'

const translations: Record<string, string> = {
  free: 'Free',
  basic: 'Basic',
  pro: 'Professional',
  team: 'Team',
  enterprise: 'Enterprise',
}

const translate = (tierType: string) => translations[tierType] || ''

describe('resolveTierDisplayName', () => {
  it('uses the current-language label for a known tier_type', () => {
    expect(resolveTierDisplayName('免费版', 'free', translate, 'Current plan')).toBe('Free')
    expect(resolveTierDisplayName('专业会员', 'pro', translate, 'Current plan')).toBe('Professional')
    expect(resolveTierDisplayName('后台基础套餐', 'basic', translate, 'Current plan')).toBe('Basic')
  })

  it('maps a Chinese backend name when tier_type is missing', () => {
    expect(resolveTierDisplayName('企业版', undefined, translate, 'Current plan')).toBe('Enterprise')
    expect(resolveTierDisplayName('專業會員', undefined, translate, 'Current plan')).toBe('Professional')
  })

  it('keeps a custom name when the tier is unknown', () => {
    expect(resolveTierDisplayName('内部试用套餐', 'future', translate, 'Current plan')).toBe('内部试用套餐')
  })

  it('falls back when both name and mapping are missing', () => {
    expect(resolveTierDisplayName('', 'future', translate, 'Current plan')).toBe('Current plan')
  })
})

describe('inferLocalizedTierType', () => {
  it('prefers a known tier_type over the raw name', () => {
    expect(inferLocalizedTierType('pro', '随便写的名字')).toBe('pro')
  })
})
