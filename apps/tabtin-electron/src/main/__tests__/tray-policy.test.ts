import { describe, expect, it } from 'vitest'

import {
  isTrayModeEnabled,
  resolveAppSettings,
  resolveTrayIconEdgePx,
  shouldHideToTrayOnClose,
  shouldHideToTrayOnMinimize,
  shouldUseTraySetContextMenu,
} from '../tray-policy'

describe('resolveAppSettings', () => {
  it('minimizeToTray 默认开、autoStart 默认关', () => {
    expect(resolveAppSettings(undefined)).toEqual({ minimizeToTray: true, autoStart: false })
    expect(resolveAppSettings({})).toEqual({ minimizeToTray: true, autoStart: false })
  })

  it('显式设置覆盖默认值', () => {
    expect(resolveAppSettings({ minimizeToTray: false, autoStart: true }))
      .toEqual({ minimizeToTray: false, autoStart: true })
  })

  it('无关字段（theme/language）不影响结果', () => {
    expect(resolveAppSettings({ theme: 'dark', language: 'zh-CN' }))
      .toEqual({ minimizeToTray: true, autoStart: false })
  })
})

describe('isTrayModeEnabled', () => {
  it('Windows 默认启用', () => {
    expect(isTrayModeEnabled('win32', undefined)).toBe(true)
    expect(isTrayModeEnabled('win32', {})).toBe(true)
  })

  it('Windows 用户关闭开关后禁用', () => {
    expect(isTrayModeEnabled('win32', { minimizeToTray: false })).toBe(false)
  })

  it('macOS 默认启用，用户关闭开关后禁用', () => {
    expect(isTrayModeEnabled('darwin', undefined)).toBe(true)
    expect(isTrayModeEnabled('darwin', { minimizeToTray: true })).toBe(true)
    expect(isTrayModeEnabled('darwin', { minimizeToTray: false })).toBe(false)
  })

  it('Linux 暂不启用（即使显式打开）', () => {
    expect(isTrayModeEnabled('linux', { minimizeToTray: true })).toBe(false)
  })
})

describe('shouldHideToTrayOnClose', () => {
  it('Windows/macOS 后台常驻 + 非退出 → 隐藏', () => {
    expect(shouldHideToTrayOnClose({
      platform: 'win32',
      settings: undefined,
      isQuitting: false,
    })).toBe(true)
    expect(shouldHideToTrayOnClose({
      platform: 'darwin',
      settings: undefined,
      isQuitting: false,
    })).toBe(true)
  })

  it('真退出（isQuitting）永远放行销毁', () => {
    expect(shouldHideToTrayOnClose({
      platform: 'win32',
      settings: { minimizeToTray: true },
      isQuitting: true,
    })).toBe(false)
  })

  it('用户关闭托盘开关 → 走原退出链路', () => {
    expect(shouldHideToTrayOnClose({
      platform: 'win32',
      settings: { minimizeToTray: false },
      isQuitting: false,
    })).toBe(false)
  })

  it('Linux 不受影响', () => {
    expect(shouldHideToTrayOnClose({
      platform: 'linux',
      settings: undefined,
      isQuitting: false,
    })).toBe(false)
  })
})

describe('shouldHideToTrayOnMinimize', () => {
  it('macOS 后台常驻 → 最小化改 hide', () => {
    expect(shouldHideToTrayOnMinimize({
      platform: 'darwin',
      settings: undefined,
    })).toBe(true)
  })

  it('Windows 仍走任务栏最小化', () => {
    expect(shouldHideToTrayOnMinimize({
      platform: 'win32',
      settings: undefined,
    })).toBe(false)
  })

  it('用户关闭开关后 macOS 也不改', () => {
    expect(shouldHideToTrayOnMinimize({
      platform: 'darwin',
      settings: { minimizeToTray: false },
    })).toBe(false)
  })
})

describe('shouldUseTraySetContextMenu', () => {
  it('Windows / Linux 用 setContextMenu 绑右键，左键可独立 click 唤窗', () => {
    expect(shouldUseTraySetContextMenu('win32')).toBe(true)
    expect(shouldUseTraySetContextMenu('linux')).toBe(true)
  })

  it('macOS 不用 setContextMenu，避免系统吞掉左键', () => {
    expect(shouldUseTraySetContextMenu('darwin')).toBe(false)
  })
})

describe('resolveTrayIconEdgePx', () => {
  it('菜单栏用 20pt，按 scaleFactor 乘物理像素', () => {
    expect(resolveTrayIconEdgePx('darwin', 1)).toBe(20)
    expect(resolveTrayIconEdgePx('darwin', 2)).toBe(40)
    expect(resolveTrayIconEdgePx('win32', 2)).toBe(40)
    expect(resolveTrayIconEdgePx('darwin', 3)).toBe(60)
  })

  it('非法 / 缺失 scaleFactor 回退到 1x，且上限 3x', () => {
    expect(resolveTrayIconEdgePx('darwin')).toBe(20)
    expect(resolveTrayIconEdgePx('darwin', 0)).toBe(20)
    expect(resolveTrayIconEdgePx('darwin', Number.NaN)).toBe(20)
    expect(resolveTrayIconEdgePx('darwin', 8)).toBe(60)
  })
})
