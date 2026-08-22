import { describe, expect, it } from 'vitest'
import zhCN from '../../../i18n/locales/zh-CN/settings.json'
import enUS from '../../../i18n/locales/en-US/settings.json'
import { resolveCleanupPlatform } from './desktopCleanupPlatform'

const PLATFORM_COPY_KEYS = [
  'subtitle',
  'uninstallAppDesc',
  'uninstallConfirmDesc',
  'uninstallHint',
] as const

describe('desktop cleanup platform copy', () => {
  it('maps Electron platforms to translation branches', () => {
    expect(resolveCleanupPlatform('darwin')).toBe('mac')
    expect(resolveCleanupPlatform('win32')).toBe('windows')
    expect(resolveCleanupPlatform('linux')).toBe('linux')
  })

  it('keeps macOS copy free of Windows-only instructions', () => {
    for (const key of PLATFORM_COPY_KEYS) {
      expect(zhCN.desktopCleanup[key].mac).toContain('访达')
      expect(zhCN.desktopCleanup[key].mac).not.toContain('Windows')
      expect(enUS.desktopCleanup[key].mac).toContain('Finder')
      expect(enUS.desktopCleanup[key].mac).not.toContain('Windows')
    }
  })

  it('retains Windows uninstall instructions on Windows', () => {
    for (const key of PLATFORM_COPY_KEYS) {
      expect(zhCN.desktopCleanup[key].windows).toContain('Windows')
      expect(enUS.desktopCleanup[key].windows).toContain('Windows')
    }
  })
})
