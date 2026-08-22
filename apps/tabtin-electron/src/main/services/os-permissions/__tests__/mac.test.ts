/**
 * OsPermissions.mac 单测
 *
 * 覆盖：
 *  - 各权限 status 的映射逻辑（granted / denied / not-determined / restricted）
 *  - canRequest 标记仅对支持的权限项为 true
 *  - openSystemSettings 通过系统 opener 打开正确 URL
 *  - request 路径：microphone → askForMediaAccess；accessibility → isTrustedAccessibilityClient(true)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { electronMock, notificationMock } = vi.hoisted(() => ({
  electronMock: {
    mediaAccessStatus: {
      microphone: 'granted',
      screen: 'denied',
      camera: 'not-determined',
    } as Record<string, string>,
    trustedAccessibilityClient: false,
    askForMediaAccessResult: true as boolean | Error,
    settingsOpener: vi.fn().mockResolvedValue(undefined),
  },
  notificationMock: {
    status: 'not-determined' as string,
    source: 'system-preferences' as 'system-preferences' | 'fallback',
  },
}))

vi.mock('electron', () => ({
  app: {
    getName: () => 'TabTin Dev',
  },
  systemPreferences: {
    getMediaAccessStatus: (kind: string) => electronMock.mediaAccessStatus[kind] ?? 'unknown',
    isTrustedAccessibilityClient: (prompt: boolean) => {
      if (prompt) {
        // 模拟"传 true 触发系统对话框后返回当前状态"
        return electronMock.trustedAccessibilityClient
      }
      return electronMock.trustedAccessibilityClient
    },
    askForMediaAccess: vi.fn(async () => {
      if (electronMock.askForMediaAccessResult instanceof Error) {
        throw electronMock.askForMediaAccessResult
      }
      return electronMock.askForMediaAccessResult
    }),
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
    granted: notificationMock.status === 'authorized' || notificationMock.status === 'provisional',
    status: notificationMock.status,
    supported: true,
    source: notificationMock.source,
    platform: 'darwin',
  }),
}))

import { createMacOsPermissions } from '../mac'

/** 用注入的 fdaCheck stub 构造 API（避免 mock node:fs，vitest 4 对它支持不稳定） */
function buildApi(opts: { fdaGranted?: boolean } = {}) {
  return createMacOsPermissions({
    fdaCheck: () => (opts.fdaGranted ? 'granted' : 'not-determined'),
    settingsOpener: electronMock.settingsOpener,
  })
}

describe('OsPermissions.mac', () => {
  beforeEach(() => {
    electronMock.settingsOpener.mockClear()
    electronMock.mediaAccessStatus = {
      microphone: 'granted',
      screen: 'denied',
      camera: 'not-determined',
    }
    electronMock.trustedAccessibilityClient = false
    electronMock.askForMediaAccessResult = true
    notificationMock.status = 'not-determined'
    notificationMock.source = 'system-preferences'
  })

  it('list 返回所有 7 项权限', async () => {
    const api = buildApi()
    const list = await api.list()
    expect(list.map((it) => it.kind).sort()).toEqual(
      [
        'accessibility',
        'automation',
        'fullDiskAccess',
        'location',
        'microphone',
        'notifications',
        'screenCapture',
      ].sort(),
    )
  })

  it('麦克风 status 映射 getMediaAccessStatus 的返回值', async () => {
    electronMock.mediaAccessStatus.microphone = 'denied'
    const api = buildApi()
    const desc = await api.check('microphone')
    expect(desc.status).toBe('denied')
    expect(desc.canRequest).toBe(true) // mac 麦克风支持 askForMediaAccess
    expect(desc.canOpenSettings).toBe(true)
  })

  it('屏幕录制 status 映射正常', async () => {
    electronMock.mediaAccessStatus.screen = 'granted'
    const api = buildApi()
    const desc = await api.check('screenCapture')
    expect(desc.status).toBe('granted')
    expect(desc.requiresAppRestartAfterGrant).toBe(true)
  })

  it('辅助功能 status 映射 isTrustedAccessibilityClient', async () => {
    electronMock.trustedAccessibilityClient = true
    const api = buildApi()
    const granted = await api.check('accessibility')
    expect(granted.status).toBe('granted')
    expect(granted.processLabel).toBeUndefined()
    expect(granted.canRequest).toBe(false)

    electronMock.trustedAccessibilityClient = false
    const pending = await api.check('accessibility')
    expect(pending.status).toBe('not-determined')
    expect(pending.processLabel).toBe('TabTin Dev')
    expect(pending.detection).toBe('supported')
    expect(pending.requiresAppRestartAfterGrant).toBe(true)
    // ：辅助功能只能去系统设置，不提供「立即请求」
    expect(pending.canRequest).toBe(false)
    expect(pending.canOpenSettings).toBe(true)
  })

  it('完全磁盘访问：fdaCheck 注入 not-determined 时透传', async () => {
    const api = buildApi({ fdaGranted: false })
    expect((await api.check('fullDiskAccess')).status).toBe('not-determined')
  })

  it('完全磁盘访问：fdaCheck 注入 granted 时透传', async () => {
    const api = buildApi({ fdaGranted: true })
    expect((await api.check('fullDiskAccess')).status).toBe('granted')
  })

  it('自动化 / 位置：始终返回 not-determined 且 detection=unsupported', async () => {
    const api = buildApi()
    const automation = await api.check('automation')
    const location = await api.check('location')
    expect(automation.status).toBe('not-determined')
    expect(automation.detection).toBe('unsupported')
    expect(location.status).toBe('not-determined')
    expect(location.detection).toBe('unsupported')
  })

  it('通知：映射 resolveNotificationPermissionStatus', async () => {
    notificationMock.status = 'authorized'
    const api = buildApi()
    const granted = await api.check('notifications')
    expect(granted.status).toBe('granted')
    expect(granted.detection).toBe('supported')

    notificationMock.status = 'denied'
    expect((await api.check('notifications')).status).toBe('denied')
  })

  it('通知：source=fallback 时 detection=unsupported（ 勿把读不到当成未确定）', async () => {
    notificationMock.status = 'not-determined'
    notificationMock.source = 'fallback'
    const api = buildApi()
    const desc = await api.check('notifications')
    expect(desc.status).toBe('not-determined')
    expect(desc.detection).toBe('unsupported')
  })

  it('canRequest 仅对 microphone 为 true（辅助功能改走系统设置入口）', async () => {
    const api = buildApi()
    const list = await api.list()
    const requestable = list.filter((it) => it.canRequest).map((it) => it.kind).sort()
    expect(requestable).toEqual(['microphone'])
  })

  it('canOpenSettings 对所有项为 true（macOS）', async () => {
    const api = buildApi()
    const list = await api.list()
    expect(list.every((it) => it.canOpenSettings)).toBe(true)
  })

  it('request(microphone) 透传 askForMediaAccess 结果', async () => {
    electronMock.askForMediaAccessResult = true
    const api = buildApi()
    expect(await api.request('microphone')).toBe('granted')

    electronMock.askForMediaAccessResult = false
    expect(await api.request('microphone')).toBe('denied')
  })

  it('openSystemSettings 通过系统 opener 打开对应权限页', async () => {
    const api = buildApi()
    await api.openSystemSettings('accessibility')
    expect(electronMock.settingsOpener).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    )

    await api.openSystemSettings('microphone')
    expect(electronMock.settingsOpener).toHaveBeenLastCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    )
  })

  it('通知设置入口携带当前运行包身份', async () => {
    process.env.TABTIN_APP_ID = 'com.tabtin.app.preprod'
    try {
      const api = buildApi()

      await api.openSystemSettings('notifications')

      expect(electronMock.settingsOpener).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.tabtin.app.preprod',
      )
    } finally {
      delete process.env.TABTIN_APP_ID
    }
  })

  it('openSystemSettings 在系统 opener 抛错时返回 false', async () => {
    electronMock.settingsOpener.mockRejectedValueOnce(new Error('boom'))
    const api = buildApi()
    const ok = await api.openSystemSettings('notifications')
    expect(ok).toBe(false)
  })
})
