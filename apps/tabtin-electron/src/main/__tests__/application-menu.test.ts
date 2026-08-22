import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  menuBuildFromTemplate,
  menuSetApplicationMenu,
  appGetLocale,
  getMainWindow,
} = vi.hoisted(() => ({
  menuBuildFromTemplate: vi.fn((template: unknown) => ({ template })),
  menuSetApplicationMenu: vi.fn((_menu: unknown) => undefined),
  appGetLocale: vi.fn(() => 'en-US'),
  getMainWindow: vi.fn(() => null),
}))

vi.mock('electron', () => ({
  app: {
    getLocale: () => appGetLocale(),
  },
  Menu: {
    buildFromTemplate: (template: unknown) => menuBuildFromTemplate(template),
    setApplicationMenu: (menu: unknown) => menuSetApplicationMenu(menu),
  },
}))

vi.mock('../window-manager', () => ({
  getMainWindow: () => getMainWindow(),
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  resolveApplicationMenuHelpLabels,
  resolveApplicationMenuLocale,
  setApplicationMenuLocale,
  setupApplicationMenu,
} from '../application-menu'

describe('application-menu locale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appGetLocale.mockReturnValue('en-US')
  })

  it('maps English system locales to English Help labels', () => {
    expect(resolveApplicationMenuLocale('en-US')).toBe('en-US')
    expect(resolveApplicationMenuHelpLabels('en')).toEqual({
      help: 'Help',
      exportDiagnostics: 'Export Diagnostic Logs',
      copyDiagnostics: 'Copy Diagnostic Logs to Clipboard',
    })
  })

  it('maps Simplified and Traditional Chinese locales', () => {
    expect(resolveApplicationMenuHelpLabels('zh-CN').help).toBe('帮助')
    expect(resolveApplicationMenuHelpLabels('zh-TW').help).toBe('說明')
    expect(resolveApplicationMenuHelpLabels('zh-HK').help).toBe('說明')
  })

  it.each([
    ['ja-JP', 'ヘルプ'],
    ['ko-KR', '도움말'],
    ['de-DE', 'Hilfe'],
    ['fr-FR', 'Aide'],
    ['es-ES', 'Ayuda'],
  ])('maps %s to localized Help labels', (locale, help) => {
    expect(resolveApplicationMenuHelpLabels(locale).help).toBe(help)
  })

  it('installs English Help menu when system locale is English', () => {
    appGetLocale.mockReturnValue('en-US')
    setupApplicationMenu({ allowMainDevTools: false })

    expect(menuSetApplicationMenu).toHaveBeenCalledTimes(1)
    const template = menuBuildFromTemplate.mock.calls[0]?.[0] as Array<{ label?: string; submenu?: Array<{ label?: string }> }>
    const help = template.find((item) => item.label === 'Help')
    expect(help).toBeTruthy()
    expect(help?.submenu?.map((item) => item.label)).toEqual([
      'Export Diagnostic Logs',
      'Copy Diagnostic Logs to Clipboard',
    ])
  })

  it('keeps English Help on English systems even if an explicit Chinese locale is requested later for tests', () => {
    appGetLocale.mockReturnValue('en-US')
    setupApplicationMenu({ allowMainDevTools: false })

    const firstTemplate = menuBuildFromTemplate.mock.calls[0]?.[0] as Array<{ label?: string }>
    expect(firstTemplate.some((item) => item.label === 'Help')).toBe(true)

    // Production path does not sync app UI language into the native menu bar.
    // This API remains for tests/ops; calling zh-CN should rebuild to Chinese.
    menuBuildFromTemplate.mockClear()
    menuSetApplicationMenu.mockClear()
    setApplicationMenuLocale('zh-CN')
    const rebuilt = menuBuildFromTemplate.mock.calls[0]?.[0] as Array<{ label?: string }>
    expect(rebuilt.some((item) => item.label === '帮助')).toBe(true)
  })

  it('does not rebuild when locale is unchanged', () => {
    appGetLocale.mockReturnValue('en-US')
    setupApplicationMenu({ allowMainDevTools: false })
    // Reset module to English after previous test may have switched locale.
    setApplicationMenuLocale('en-US')
    menuBuildFromTemplate.mockClear()
    menuSetApplicationMenu.mockClear()

    setApplicationMenuLocale('en')
    expect(menuSetApplicationMenu).not.toHaveBeenCalled()
  })
})
