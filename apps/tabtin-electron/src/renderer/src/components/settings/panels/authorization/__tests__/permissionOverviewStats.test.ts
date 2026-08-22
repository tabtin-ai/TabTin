/**
 * permissionOverviewStats — ：分母等于平台适用项数。
 */

import { describe, it, expect } from 'vitest'
import { computePermissionOverviewStats } from '../permissionOverviewStats'
import type { PermissionDescriptor } from '../permissionConfig'

function desc(
  partial: Partial<PermissionDescriptor> & Pick<PermissionDescriptor, 'kind' | 'status'>,
): PermissionDescriptor {
  return {
    platform: 'win32',
    canRequest: false,
    canOpenSettings: true,
    detection: 'supported',
    ...partial,
  }
}

describe('computePermissionOverviewStats ', () => {
  it('Windows：分母含位置/通知，麦克风已开时显示 1/3 而非 1/1', () => {
    const stats = computePermissionOverviewStats([
      desc({ kind: 'microphone', status: 'granted' }),
      desc({ kind: 'location', status: 'not-determined', detection: 'unsupported' }),
      desc({ kind: 'notifications', status: 'not-determined', detection: 'unsupported' }),
      desc({ kind: 'accessibility', status: 'not-applicable' }),
      desc({ kind: 'screenCapture', status: 'not-applicable' }),
      desc({ kind: 'automation', status: 'not-applicable' }),
      desc({ kind: 'fullDiskAccess', status: 'not-applicable' }),
    ])
    expect(stats).toEqual({
      granted: 1,
      total: 3,
      allDetectableGranted: true,
      someDetectableGranted: false,
    })
  })

  it('macOS：7 项适用时分母为 7，测不到项不挡必要权限齐', () => {
    const stats = computePermissionOverviewStats([
      desc({ kind: 'fullDiskAccess', status: 'granted', platform: 'darwin' }),
      desc({ kind: 'screenCapture', status: 'granted', platform: 'darwin' }),
      desc({ kind: 'accessibility', status: 'granted', platform: 'darwin' }),
      desc({
        kind: 'automation',
        status: 'not-determined',
        detection: 'unsupported',
        platform: 'darwin',
      }),
      desc({ kind: 'microphone', status: 'granted', platform: 'darwin' }),
      desc({
        kind: 'location',
        status: 'not-determined',
        detection: 'unsupported',
        platform: 'darwin',
      }),
      desc({ kind: 'notifications', status: 'granted', platform: 'darwin' }),
    ])
    expect(stats.granted).toBe(5)
    expect(stats.total).toBe(7)
    expect(stats.allDetectableGranted).toBe(true)
  })

  it('可检测项未齐时 someDetectableGranted', () => {
    const stats = computePermissionOverviewStats([
      desc({ kind: 'microphone', status: 'granted', platform: 'darwin' }),
      desc({ kind: 'screenCapture', status: 'denied', platform: 'darwin' }),
      desc({
        kind: 'location',
        status: 'not-determined',
        detection: 'unsupported',
        platform: 'darwin',
      }),
    ])
    expect(stats.granted).toBe(1)
    expect(stats.total).toBe(3)
    expect(stats.allDetectableGranted).toBe(false)
    expect(stats.someDetectableGranted).toBe(true)
  })
})
