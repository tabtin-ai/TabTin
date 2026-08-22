import { beforeEach, describe, expect, it, vi } from 'vitest'

const { notificationState } = vi.hoisted(() => ({
  notificationState: {
    supported: true,
  },
}))

vi.mock('electron', () => ({
  Notification: {
    isSupported: () => notificationState.supported,
  },
  systemPreferences: {},
}))

import {
  normalizeMacAuthorizationStatus,
  resolveMacNotificationPermissionStatusFromSettings,
  resolveNotificationPermissionStatus,
} from '../permission-status'

describe('notification permission status', () => {
  beforeEach(() => {
    notificationState.supported = true
  })

  it('normalizes Apple authorization status codes correctly', () => {
    expect(normalizeMacAuthorizationStatus(0)).toBe('not-determined')
    expect(normalizeMacAuthorizationStatus(1)).toBe('denied')
    expect(normalizeMacAuthorizationStatus(2)).toBe('authorized')
    expect(normalizeMacAuthorizationStatus(3)).toBe('provisional')
  })

  it('normalizes string authorization statuses correctly', () => {
    expect(normalizeMacAuthorizationStatus('authorized')).toBe('authorized')
    expect(normalizeMacAuthorizationStatus('not determined')).toBe('not-determined')
    expect(normalizeMacAuthorizationStatus('restricted')).toBe('restricted')
  })

  it('builds mac permission status from systemPreferences settings', () => {
    expect(resolveMacNotificationPermissionStatusFromSettings({
      authorizationStatus: 2,
    })).toEqual({
      supported: true,
      granted: true,
      status: 'authorized',
      source: 'system-preferences',
      platform: process.platform,
    })
  })

  it('falls back to alert style when authorizationStatus is absent', () => {
    expect(resolveMacNotificationPermissionStatusFromSettings({
      alertStyle: 'none',
    })).toEqual({
      supported: true,
      granted: false,
      status: 'denied',
      source: 'system-preferences',
      platform: process.platform,
    })
  })

  it('returns unsupported when desktop notifications are unavailable', () => {
    notificationState.supported = false

    expect(resolveNotificationPermissionStatus({
      platform: 'darwin',
    })).toEqual({
      supported: false,
      granted: false,
      status: 'unsupported',
      source: 'fallback',
      platform: 'darwin',
    })
  })

  it('win32：注册表探测到开启时 granted', () => {
    expect(resolveNotificationPermissionStatus({
      platform: 'win32',
      supported: true,
      windows: {
        aumids: ['com.tabtin.app'],
        readGlobalToastEnabled: () => null,
        readAppEnabled: () => 1,
      },
    })).toEqual({
      supported: true,
      granted: true,
      status: 'authorized',
      source: 'system-preferences',
      platform: 'win32',
    })
  })

  it('win32：无注册表证据时不谎称 authorized', () => {
    expect(resolveNotificationPermissionStatus({
      platform: 'win32',
      supported: true,
      windows: {
        aumids: ['com.tabtin.app'],
        readGlobalToastEnabled: () => null,
        readAppEnabled: () => undefined,
      },
    })).toEqual({
      supported: true,
      granted: false,
      status: 'not-determined',
      source: 'fallback',
      platform: 'win32',
    })
  })

  it('linux 在无 OS API 时保持可发送假设', () => {
    expect(resolveNotificationPermissionStatus({
      platform: 'linux',
      supported: true,
    })).toEqual({
      supported: true,
      granted: true,
      status: 'authorized',
      source: 'fallback',
      platform: 'linux',
    })
  })

  it('reports provisional correctly on macOS', () => {
    expect(resolveNotificationPermissionStatus({
      platform: 'darwin',
      supported: true,
      getMacNotificationSettings: () => ({ authorizationStatus: 3 }),
    })).toEqual({
      supported: true,
      granted: true,
      status: 'provisional',
      source: 'system-preferences',
      platform: 'darwin',
    })
  })

  it('falls back to not-determined on macOS when all detection methods fail', () => {
    expect(resolveNotificationPermissionStatus({
      platform: 'darwin',
      supported: true,
      getMacNotificationSettings: () => undefined,
    })).toEqual({
      supported: true,
      granted: false,
      status: 'not-determined',
      source: 'fallback',
      platform: 'darwin',
    })
  })
})
