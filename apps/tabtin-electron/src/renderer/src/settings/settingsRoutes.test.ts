import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_ROUTES,
  isOrganizationSettingsSection,
  normalizeSettingsRoute,
} from './settingsRoutes'

describe('settingsRoutes', () => {
  it('账号设备深链由运行时组织灰度决定', () => {
    expect(normalizeSettingsRoute('devices')).toEqual({ category: 'profile', section: 'devices' })
  })

  it('支持 legacy string route（llm 深链接命中独立「模型配置」入口）', () => {
    // IA 拆分后「AI 与模型」拆成模型配置(llm) / AI 成本(services) 两个独立一级入口，
    // 'llm' 直接命中 section 'llm'（不再归并到已删的 'ai' 组合）。
    expect(normalizeSettingsRoute('llm')).toEqual({
      category: 'organization',
      section: 'llm',
      organizationId: '',
    })
  })

  it('services 字符串深链接命中独立「AI 成本」入口', () => {
    expect(normalizeSettingsRoute('services')).toEqual({
      category: 'organization',
      section: 'services',
      organizationId: '',
    })
  })

  it('billingServices 字符串深链接命中订阅与账单的服务计费子 tab', () => {
    expect(normalizeSettingsRoute('billingServices')).toEqual({
      category: 'organization',
      section: 'pricing',
      organizationId: '',
    })
  })

  it('隐藏未就绪的连接账号与访问凭据 profile section', () => {
    expect(normalizeSettingsRoute({ category: 'profile', section: 'credentials' })).toBe(
      DEFAULT_SETTINGS_ROUTES.profile,
    )
    expect(normalizeSettingsRoute({ category: 'profile', section: 'credentials-ai' })).toBe(
      DEFAULT_SETTINGS_ROUTES.profile,
    )
    expect(normalizeSettingsRoute({ category: 'profile', section: 'credentials-apps' })).toBe(
      DEFAULT_SETTINGS_ROUTES.profile,
    )
    expect(normalizeSettingsRoute({ category: 'profile', section: 'developer' })).toBe(
      DEFAULT_SETTINGS_ROUTES.profile,
    )
    expect(normalizeSettingsRoute('credentials')).toBe(DEFAULT_SETTINGS_ROUTES.profile)
    expect(normalizeSettingsRoute('developer')).toBe(DEFAULT_SETTINGS_ROUTES.profile)
  })

  // settings-IA Phase 0：storage 组合已删，storageManager/performance 改指各自字面量 section
  // （父组 deviceGroup 由 parent map 反查）。锁死 §4 必改点——UserProfile「存储管理」入口
  // 走 openSettings('storageManager') 字符串深链接，必须命中 storageManager 而非已删的 storage。
  it('storageManager 字符串深链接指向 storageManager（设备域）而非已删的 storage', () => {
    expect(normalizeSettingsRoute('storageManager')).toEqual({
      category: 'device',
      section: 'storageManager',
    })
  })

  it('performance 字符串深链接指向 performance（设备域）而非已删的 storage', () => {
    expect(normalizeSettingsRoute('performance')).toEqual({
      category: 'device',
      section: 'performance',
    })
  })

  it('deviceGroup 字符串深链接保持兼容旧设备域入口', () => {
    expect(normalizeSettingsRoute('deviceGroup')).toEqual({
      category: 'device',
      section: 'deviceGroup',
    })
  })

  it('保留合法的 device section', () => {
    expect(normalizeSettingsRoute({ category: 'device', section: 'authorization' })).toEqual({
      category: 'device',
      section: 'authorization',
    })
  })

  it('非法 device section 兜底到 DEFAULT_SETTINGS_ROUTES.device', () => {
    const route = {
      category: 'device',
      section: 'modelSettings',
    } as unknown as Parameters<typeof normalizeSettingsRoute>[0]

    expect(normalizeSettingsRoute(route)).toBe(DEFAULT_SETTINGS_ROUTES.device)
  })

  it('保留合法的 organization section', () => {
    expect(normalizeSettingsRoute({ category: 'organization', section: 'llm', organizationId: 'wt-1' })).toEqual({
      category: 'organization',
      section: 'llm',
      organizationId: 'wt-1',
    })
  })

  it('应用与扩展字符串深链接精确命中对应子 tab', () => {
    expect(normalizeSettingsRoute('apps')).toEqual({
      category: 'organization',
      section: 'apps',
      organizationId: '',
    })
    expect(normalizeSettingsRoute('appCatalog')).toEqual({
      category: 'organization',
      section: 'apps',
      organizationId: '',
    })
    expect(normalizeSettingsRoute('extensions')).toEqual({
      category: 'organization',
      section: 'extensions',
      organizationId: '',
    })
    expect(normalizeSettingsRoute('installedExtensions')).toEqual({
      category: 'organization',
      section: 'installedExtensions',
      organizationId: '',
    })
  })

  it('拒绝把组件名或 i18n key 当成 organization section', () => {
    const route = {
      category: 'organization',
      section: 'modelSettings',
      organizationId: 'wt-1',
    } as Parameters<typeof normalizeSettingsRoute>[0]

    expect(normalizeSettingsRoute(route)).toBe(DEFAULT_SETTINGS_ROUTES.profile)
    expect(isOrganizationSettingsSection('modelSettings')).toBe(false)
  })

  it('myUsage 字符串深链接命中个人设置的我的 AI 用量', () => {
    expect(normalizeSettingsRoute('myUsage')).toEqual({
      category: 'profile',
      section: 'myUsage',
    })
  })

  it('偏好子项字符串深链接精确命中对应 tab', () => {
    expect(normalizeSettingsRoute('language')).toEqual({
      category: 'profile',
      section: 'language',
    })
    expect(normalizeSettingsRoute('voice')).toEqual({
      category: 'profile',
      section: 'voice',
    })
  })

  it('订阅与账单 legacy 字符串深链接映射到新 IA 子 tab', () => {
    expect(normalizeSettingsRoute('membership')).toEqual({
      category: 'organization',
      section: 'membership',
      organizationId: '',
    })
    expect(normalizeSettingsRoute('wallet')).toEqual({
      category: 'organization',
      section: 'usage',
      organizationId: '',
    })
    expect(normalizeSettingsRoute('usage')).toEqual({
      category: 'organization',
      section: 'usage',
      organizationId: '',
    })
    expect(normalizeSettingsRoute('billing')).toEqual({
      category: 'organization',
      section: 'billing',
      organizationId: '',
    })
    expect(normalizeSettingsRoute('storage')).toEqual({
      category: 'organization',
      section: 'billing',
      organizationId: '',
    })
  })

  it('拒绝非法 profile section', () => {
    const route = {
      category: 'profile',
      section: 'modelSettings',
    } as unknown as Parameters<typeof normalizeSettingsRoute>[0]

    expect(normalizeSettingsRoute(route)).toBe(DEFAULT_SETTINGS_ROUTES.profile)
  })

  it('拒绝异常 category', () => {
    const route = {
      category: 'workspace',
      section: 'llm',
    } as unknown as Parameters<typeof normalizeSettingsRoute>[0]

    expect(normalizeSettingsRoute(route)).toBe(DEFAULT_SETTINGS_ROUTES.profile)
  })
})
