import { describe, expect, it } from 'vitest'
import {
  probeWindowsNotificationPermission,
  resolveWindowsNotificationPermissionStatus,
} from '../win-notification-permission'

describe('win notification permission probe ', () => {
  it('全局 ToastEnabled=0 → denied + detected', () => {
    expect(
      probeWindowsNotificationPermission({
        readGlobalToastEnabled: () => 0,
        readAppEnabled: () => undefined,
      }),
    ).toEqual({ detected: true, status: 'denied' })
  })

  it('AUMID Enabled=0 → denied', () => {
    expect(
      probeWindowsNotificationPermission({
        aumids: ['com.tabtin.app'],
        readGlobalToastEnabled: () => null,
        readAppEnabled: (id) => (id === 'com.tabtin.app' ? 0 : undefined),
      }),
    ).toEqual({ detected: true, status: 'denied' })
  })

  it('AUMID Enabled=1 → authorized', () => {
    expect(
      probeWindowsNotificationPermission({
        aumids: ['com.tabtin.app.dev'],
        readGlobalToastEnabled: () => 1,
        readAppEnabled: (id) => (id === 'com.tabtin.app.dev' ? 1 : undefined),
      }),
    ).toEqual({ detected: true, status: 'authorized' })
  })

  it('AUMID 键存在但无 Enabled DWORD → authorized（系统默认开）', () => {
    expect(
      probeWindowsNotificationPermission({
        aumids: ['com.tabtin.app'],
        readGlobalToastEnabled: () => null,
        readAppEnabled: () => null,
      }),
    ).toEqual({ detected: true, status: 'authorized' })
  })

  it('候选 AUMID 均无注册表项 → not-determined 且未 detected', () => {
    expect(
      probeWindowsNotificationPermission({
        aumids: ['com.tabtin.app', 'com.tabtin.app.dev'],
        readGlobalToastEnabled: () => null,
        readAppEnabled: () => undefined,
      }),
    ).toEqual({ detected: false, status: 'not-determined' })
  })

  it('resolve：探测成功时 source=system-preferences', () => {
    expect(
      resolveWindowsNotificationPermissionStatus({
        platform: 'win32',
        supported: true,
        aumids: ['com.tabtin.app'],
        readGlobalToastEnabled: () => null,
        readAppEnabled: () => 1,
      }),
    ).toEqual({
      supported: true,
      granted: true,
      status: 'authorized',
      source: 'system-preferences',
      platform: 'win32',
    })
  })

  it('resolve：无证据时 source=fallback，不谎称 authorized', () => {
    expect(
      resolveWindowsNotificationPermissionStatus({
        platform: 'win32',
        supported: true,
        aumids: ['com.tabtin.app'],
        readGlobalToastEnabled: () => null,
        readAppEnabled: () => undefined,
      }),
    ).toEqual({
      supported: true,
      granted: false,
      status: 'not-determined',
      source: 'fallback',
      platform: 'win32',
    })
  })

  it('优先匹配显式 aumids 中的关闭状态', () => {
    expect(
      probeWindowsNotificationPermission({
        aumids: ['com.tabtin.app.dev', 'com.tabtin.app'],
        readGlobalToastEnabled: () => null,
        readAppEnabled: (id) => {
          if (id === 'com.tabtin.app.dev') return 0
          if (id === 'com.tabtin.app') return 1
          return undefined
        },
      }),
    ).toEqual({ detected: true, status: 'denied' })
  })
})
