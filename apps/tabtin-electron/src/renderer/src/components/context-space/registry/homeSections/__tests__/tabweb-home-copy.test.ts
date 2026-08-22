import { describe, expect, it } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN/context.json'
import enUS from '@/i18n/locales/en-US/context.json'

describe('TabWeb custom homepage copy', () => {
  it('explains that the optional URL is a custom homepage and empty opens TabWeb workspace', () => {
    expect(zhCN.home.browserHome.homepage).toBe('自定义主页')
    expect(zhCN.home.browserHome.homepageEmpty).toBe('未设置')
    expect(zhCN.home.browserHome.homepagePlaceholder).toContain('TabWeb 工作区')

    expect(enUS.home.browserHome.homepage).toBe('Custom homepage')
    expect(enUS.home.browserHome.homepageEmpty).toBe('Not set')
    expect(enUS.home.browserHome.homepagePlaceholder).toContain('TabWeb workspace')
  })
})
