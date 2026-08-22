/**
 * SystemPermissionsOverview 单测
 *
 * 「已授权 N / 共 M」：M = 平台适用项（含 detection=unsupported）；
 * not-applicable 不进分母。
 */

import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { granted?: number; total?: number }) => {
      if (key === 'authorizationSystem.overview.summary') {
        return `已授权 ${opts?.granted} / 共 ${opts?.total} 项`
      }
      return key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}))

import { SystemPermissionsOverview } from '../SystemPermissionsOverview'
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

describe('SystemPermissionsOverview', () => {
  it('Windows：适用三项时显示 1/3，可检测项齐则 taglineAll', () => {
    render(
      <SystemPermissionsOverview
        items={[
          desc({ kind: 'microphone', status: 'granted' }),
          desc({ kind: 'location', status: 'not-determined', detection: 'unsupported' }),
          desc({ kind: 'notifications', status: 'not-determined', detection: 'unsupported' }),
          desc({ kind: 'accessibility', status: 'not-applicable' }),
        ]}
        refreshing={false}
        onRefresh={vi.fn()}
      />,
    )
    expect(screen.getByText('已授权 1 / 共 3 项')).toBeTruthy()
    expect(screen.getByText('authorizationSystem.overview.taglineAll')).toBeTruthy()
  })

  it('可检测项未齐时显示部分授权 tagline，分母含测不到项', () => {
    render(
      <SystemPermissionsOverview
        items={[
          desc({ kind: 'microphone', status: 'granted', platform: 'darwin' }),
          desc({ kind: 'screenCapture', status: 'denied', platform: 'darwin' }),
          desc({
            kind: 'location',
            status: 'not-determined',
            detection: 'unsupported',
            platform: 'darwin',
          }),
        ]}
        refreshing={false}
        onRefresh={vi.fn()}
      />,
    )
    expect(screen.getByText('已授权 1 / 共 3 项')).toBeTruthy()
    expect(screen.getByText('authorizationSystem.overview.taglineSome')).toBeTruthy()
  })
})
