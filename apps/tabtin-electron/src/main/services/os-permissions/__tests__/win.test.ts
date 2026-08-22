/**
 * OsPermissions.win 单测
 *
 * Windows 大多数 macOS 专属权限直接 not-applicable；
 * 麦克风 / 通知 / 位置走 ms-settings: URL。
 * 通知状态与 notification/permission-status 共用探测。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { electronMock, notificationMock } = vi.hoisted(() => ({
  electronMock: {
    micStatus: 'granted' as string,
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  notificationMock: {
    granted: false,
    status: 'not-determined' as string,
    source: 'fallback' as 'system-preferences' | 'fallback',
  },
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: electronMock.openExternal,
  },
  systemPreferences: {
    getMediaAccessStatus: (kind: string) =>
      kind === 'microphone' ? electronMock.micStatus : 'unknown',
  },
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../notification/permission-status', () => ({
  resolveNotificationPermissionStatus: () => ({
    granted: notificationMock.granted,
    status: notificationMock.status,
    supported: true,
    source: notificationMock.source,
    platform: 'win32',
  }),
}))

import { createWindowsOsPermissions } from '../win'

describe('OsPermissions.win', () => {
  beforeEach(() => {
    electronMock.openExternal.mockClear()
    electronMock.micStatus = 'granted'
    notificationMock.granted = false
    notificationMock.status = 'not-determined'
    notificationMock.source = 'fallback'
  })

  it('macOS TCC 专属权限在 Windows 全部 not-applicable', async () => {
    const api = createWindowsOsPermissions()
    const list = await api.list()
    const na = list
      .filter((it) => it.status === 'not-applicable')
      .map((it) => it.kind)
      .sort()
    expect(na).toEqual(
      ['accessibility', 'automation', 'fullDiskAccess', 'screenCapture'].sort(),
    )
  })

  it('麦克风状态映射 getMediaAccessStatus', async () => {
    electronMock.micStatus = 'denied'
    const api = createWindowsOsPermissions()
    expect((await api.check('microphone')).status).toBe('denied')
  })

  it('通知：无注册表证据时 not-determined 且 detection=unsupported', async () => {
    const api = createWindowsOsPermissions()
    const notifications = await api.check('notifications')
    expect(notifications.status).toBe('not-determined')
    expect(notifications.detection).toBe('unsupported')
  })

  it('通知：注册表探测到开启时 granted + detection=supported', async () => {
    notificationMock.granted = true
    notificationMock.status = 'authorized'
    notificationMock.source = 'system-preferences'
    const api = createWindowsOsPermissions()
    const notifications = await api.check('notifications')
    expect(notifications.status).toBe('granted')
    expect(notifications.detection).toBe('supported')
  })

  it('通知：注册表探测到关闭时 denied + detection=supported', async () => {
    notificationMock.granted = false
    notificationMock.status = 'denied'
    notificationMock.source = 'system-preferences'
    const api = createWindowsOsPermissions()
    const notifications = await api.check('notifications')
    expect(notifications.status).toBe('denied')
    expect(notifications.detection).toBe('supported')
  })

  it('位置默认 not-determined 且 detection=unsupported', async () => {
    const api = createWindowsOsPermissions()
    const location = await api.check('location')
    expect(location.status).toBe('not-determined')
    expect(location.detection).toBe('unsupported')
  })

  it('麦克风 detection 为 supported', async () => {
    const api = createWindowsOsPermissions()
    expect((await api.check('microphone')).detection).toBe('supported')
  })

  it('canRequest 在 Windows 永远是 false', async () => {
    const api = createWindowsOsPermissions()
    const list = await api.list()
    expect(list.every((it) => it.canRequest === false)).toBe(true)
  })

  it('openSystemSettings 仅对 mic/通知/位置 三项有效，URL 走 ms-settings:', async () => {
    const api = createWindowsOsPermissions()
    await api.openSystemSettings('microphone')
    expect(electronMock.openExternal).toHaveBeenCalledWith('ms-settings:privacy-microphone')

    await api.openSystemSettings('notifications')
    expect(electronMock.openExternal).toHaveBeenLastCalledWith('ms-settings:notifications')

    await api.openSystemSettings('location')
    expect(electronMock.openExternal).toHaveBeenLastCalledWith('ms-settings:privacy-location')
  })

  it('openSystemSettings 对 macOS 专属项静默返回 false', async () => {
    const api = createWindowsOsPermissions()
    expect(await api.openSystemSettings('fullDiskAccess')).toBe(false)
    expect(electronMock.openExternal).not.toHaveBeenCalled()
  })
})
