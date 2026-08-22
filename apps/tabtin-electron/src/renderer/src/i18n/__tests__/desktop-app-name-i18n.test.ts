import { describe, expect, it } from 'vitest'

import zhContext from '../locales/zh-CN/context.json'
import enContext from '../locales/en-US/context.json'

const DESKTOP_APP_NAME_KEYS = [
  'tabdoc',
  'tabdata',
  'tabslide',
  'tabsite',
  'tabfolder',
  'tabfiles',
  'tabcode',
  'tabweb',
  'tabdesktop',
  'orchestration',
  'terminal',
  'tabtracker',
  'skill',
  'tins',
  'tabtin-demo-app',
] as const

function getAppNames(locale: unknown): Record<string, unknown> {
  return (locale as { appName?: Record<string, unknown> }).appName ?? {}
}

describe('desktop sidebar app names i18n', () => {
  it('内置桌面应用都有 zh-CN / en-US 显示名', () => {
    const zhAppNames = getAppNames(zhContext)
    const enAppNames = getAppNames(enContext)

    for (const appId of DESKTOP_APP_NAME_KEYS) {
      expect(zhAppNames[appId], `${appId} missing in zh-CN`).toEqual(expect.any(String))
      expect(String(zhAppNames[appId]).trim()).not.toBe('')
      expect(enAppNames[appId], `${appId} missing in en-US`).toEqual(expect.any(String))
      expect(String(enAppNames[appId]).trim()).not.toBe('')
    }
  })

  it('截图里曾回落到英文的功能型 App 在中文下使用中文名', () => {
    const zhAppNames = getAppNames(zhContext)

    expect(zhAppNames.tabtracker).toBe('自动化')
  })

  it('英文显示名不能混入中文 fallback', () => {
    const enAppNames = getAppNames(enContext)

    for (const appId of DESKTOP_APP_NAME_KEYS) {
      expect(enAppNames[appId]).not.toMatch(/[一-鿿]/)
    }
  })
})
