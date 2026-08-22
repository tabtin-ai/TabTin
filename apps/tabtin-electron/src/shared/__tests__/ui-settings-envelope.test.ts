import { describe, expect, it } from 'vitest'
import { unwrapUISettingsMap } from '../ui-settings-envelope'

/**
 * 共享解包纯函数回归——覆盖 main / renderer / WS 三端的实际信封形态。
 * 阻断-1 的根因正是 main 漏 unwrap 成功外壳的 `data` 层，这里把那条形态锁死。
 */
describe('unwrapUISettingsMap', () => {
  const np = { value: { enabled: false, desktopEnabled: false }, updatedAt: 111 }

  it('main 裸 GET {success,code,message,data:{settings:{ns:{value,updatedAt}}}} → 解出 ns（阻断-1）', () => {
    const body = {
      success: true,
      code: 0,
      message: 'ok',
      data: { settings: { notificationPrefs: np, theme: { value: 'dark', updatedAt: 222 } } },
    }
    const map = unwrapUISettingsMap(body)
    expect(map.notificationPrefs).toEqual(np)
    expect(map.theme).toEqual({ value: 'dark', updatedAt: 222 })
  })

  it('renderer 经 apiService 已剥 data 的 {settings:{...}} → 解出 ns', () => {
    expect(unwrapUISettingsMap({ settings: { notificationPrefs: np } }).notificationPrefs).toEqual(np)
  })

  it('WS envelope {type,payload:{data:{settings:{...}}}} → 解出 ns', () => {
    const env = { type: 'ui_settings_changed', payload: { data: { settings: { notificationPrefs: np } } } }
    expect(unwrapUISettingsMap(env).notificationPrefs).toEqual(np)
  })

  it('裸 {ns:{value,updatedAt}} 兜底', () => {
    expect(unwrapUISettingsMap({ notificationPrefs: np }).notificationPrefs).toEqual(np)
  })

  it('updatedAt 缺失/非数 → 兜底 0', () => {
    expect(unwrapUISettingsMap({ settings: { theme: { value: 'light' } } }).theme).toEqual({
      value: 'light',
      updatedAt: 0,
    })
  })

  it('空 / 非对象 / 无 value 条目 → 安全忽略，不误造空壳', () => {
    expect(unwrapUISettingsMap(null)).toEqual({})
    expect(unwrapUISettingsMap(undefined)).toEqual({})
    expect(unwrapUISettingsMap({ settings: {} })).toEqual({})
    expect(unwrapUISettingsMap({ success: false })).toEqual({})
    expect(unwrapUISettingsMap({ settings: { theme: { updatedAt: 1 } } })).toEqual({})
  })
})
