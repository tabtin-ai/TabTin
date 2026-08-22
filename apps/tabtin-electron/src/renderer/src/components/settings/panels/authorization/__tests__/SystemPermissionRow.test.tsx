/**
 * SystemPermissionRow 单测
 *
 * 覆盖关键的 UX 规则：
 *  - granted 状态不显示按钮
 *  - not-applicable 状态既不显示按钮，整行也降透明度
 *  - 麦克风 canRequest=true 显示「立即请求」
 *  - 辅助功能 / 屏幕录制不显示「立即请求」，只显示打开系统设置类按钮
 *  - 待重启确认徽章 vs 尚未确认
 */

import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}))

import { SystemPermissionRow } from '../SystemPermissionRow'
import type { PermissionDescriptor } from '../permissionConfig'

const baseDescriptor: PermissionDescriptor = {
  kind: 'microphone',
  status: 'not-determined',
  platform: 'darwin',
  canRequest: true,
  canOpenSettings: true,
}

describe('SystemPermissionRow', () => {
  it('未授权时麦克风同时显示「立即请求」与「去授权」按钮', () => {
    const onRequest = vi.fn().mockResolvedValue(undefined)
    const onOpenSettings = vi.fn().mockResolvedValue(undefined)
    render(
      <SystemPermissionRow
        descriptor={baseDescriptor}
        onRequest={onRequest}
        onOpenSettings={onOpenSettings}
      />,
    )
    expect(screen.getByTestId('permission-request-microphone')).toBeTruthy()
    expect(screen.getByTestId('permission-open-settings-microphone')).toBeTruthy()
    expect(screen.getByText('authorizationSystem.actions.request')).toBeTruthy()
  })

  it('granted 状态不显示任何操作按钮', () => {
    render(
      <SystemPermissionRow
        descriptor={{ ...baseDescriptor, status: 'granted' }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('permission-request-microphone')).toBeNull()
    expect(screen.queryByTestId('permission-open-settings-microphone')).toBeNull()
  })

  it('not-applicable 状态不显示操作按钮', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'fullDiskAccess',
          status: 'not-applicable',
          canRequest: false,
          canOpenSettings: false,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('permission-open-settings-fullDiskAccess')).toBeNull()
  })

  it('canRequest=false 时仅显示打开设置入口', () => {
    render(
      <SystemPermissionRow
        descriptor={{ ...baseDescriptor, canRequest: false }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('permission-request-microphone')).toBeNull()
    expect(screen.getByTestId('permission-open-settings-microphone')).toBeTruthy()
  })

  it('点击「立即请求」触发 onRequest', () => {
    const onRequest = vi.fn().mockResolvedValue(undefined)
    render(
      <SystemPermissionRow
        descriptor={baseDescriptor}
        onRequest={onRequest}
        onOpenSettings={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('permission-request-microphone'))
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('点击打开设置触发 onOpenSettings', () => {
    const onOpenSettings = vi.fn().mockResolvedValue(undefined)
    render(
      <SystemPermissionRow
        descriptor={baseDescriptor}
        onRequest={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    )
    fireEvent.click(screen.getByTestId('permission-open-settings-microphone'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('辅助功能不显示「立即请求」，按钮文案为前往辅助功能设置', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'accessibility',
          // 即便 main 误标 canRequest，UI 也不得展示「立即请求」
          canRequest: true,
          canOpenSettings: true,
          requiresAppRestartAfterGrant: true,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('permission-request-accessibility')).toBeNull()
    expect(screen.queryByText('authorizationSystem.actions.request')).toBeNull()
    expect(screen.getByTestId('permission-open-settings-accessibility')).toBeTruthy()
    expect(screen.getByText('authorizationSystem.actions.openAccessibilitySettings')).toBeTruthy()
  })

  it('屏幕录制不显示「立即请求」，按钮文案为打开系统设置', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'screenCapture',
          canRequest: false,
          canOpenSettings: true,
          requiresAppRestartAfterGrant: true,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('permission-request-screenCapture')).toBeNull()
    expect(screen.getByText('authorizationSystem.actions.openSystemSettings')).toBeTruthy()
  })

  it('用户未操作：not-determined 显示尚未确认，不显示待重启确认', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'accessibility',
          canRequest: false,
          requiresAppRestartAfterGrant: true,
          pendingRestartConfirmation: false,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText('authorizationSystem.status.not-determined')).toBeTruthy()
    expect(screen.queryByText('authorizationSystem.status.pending-restart-confirmation')).toBeNull()
    expect(screen.queryByText(/未授权/)).toBeNull()
  })

  it('点击打开系统设置后：显示待重启确认', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'accessibility',
          canRequest: false,
          requiresAppRestartAfterGrant: true,
          pendingRestartConfirmation: true,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText('authorizationSystem.status.pending-restart-confirmation')).toBeTruthy()
    expect(screen.queryByText('authorizationSystem.status.not-determined')).toBeNull()
  })

  it('系统开启但未重启：显示待重启确认（非未授权）', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'screenCapture',
          platform: 'darwin',
          canRequest: false,
          requiresAppRestartAfterGrant: true,
          pendingRestartConfirmation: true,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByTestId('permission-restart-hint-screenCapture')).toBeTruthy()
    expect(screen.getByText('authorizationSystem.status.pending-restart-confirmation')).toBeTruthy()
    expect(screen.queryByText('authorizationSystem.status.denied')).toBeNull()
  })

  it('重启后已授权：显示已授权且无操作按钮', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'accessibility',
          status: 'granted',
          canRequest: false,
          requiresAppRestartAfterGrant: true,
          pendingRestartConfirmation: false,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText('authorizationSystem.status.granted')).toBeTruthy()
    expect(screen.queryByTestId('permission-open-settings-accessibility')).toBeNull()
    expect(screen.queryByText('authorizationSystem.status.pending-restart-confirmation')).toBeNull()
  })

  it('detection=unsupported 时展示人工确认提示并保留系统设置入口', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'notifications',
          canRequest: false,
          detection: 'unsupported',
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByTestId('permission-detection-hint-notifications')).toBeTruthy()
    expect(screen.getByText('authorizationSystem.hints.detectionUnsupported')).toBeTruthy()
    expect(screen.queryByTestId('permission-request-notifications')).toBeNull()
    expect(screen.getByTestId('permission-open-settings-notifications')).toBeTruthy()
    expect(screen.queryByText('authorizationSystem.status.not-determined')).toBeNull()
  })

  it('detection=supported 且 denied 时仍显示状态和授权入口', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'microphone',
          status: 'denied',
          canRequest: false,
          canOpenSettings: true,
          detection: 'supported',
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText('authorizationSystem.status.denied')).toBeTruthy()
    expect(screen.getByTestId('permission-open-settings-microphone')).toBeTruthy()
  })

  it('macOS 辅助功能未授权时展示进程身份提示', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'accessibility',
          canRequest: false,
          processLabel: 'Electron',
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByTestId('permission-accessibility-hint')).toBeTruthy()
    expect(screen.getByText('authorizationSystem.hints.accessibilityIdentity')).toBeTruthy()
  })

  it('明确拒绝的重启敏感权限仍展示拒绝状态', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'screenCapture',
          platform: 'darwin',
          status: 'denied',
          canRequest: false,
          requiresAppRestartAfterGrant: true,
          pendingRestartConfirmation: true,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText('authorizationSystem.status.denied')).toBeTruthy()
    expect(screen.queryByText('authorizationSystem.status.pending-restart-confirmation')).toBeNull()
  })

  it('受系统限制的重启敏感权限仍展示限制状态', () => {
    render(
      <SystemPermissionRow
        descriptor={{
          ...baseDescriptor,
          kind: 'screenCapture',
          platform: 'darwin',
          status: 'restricted',
          canRequest: false,
          requiresAppRestartAfterGrant: true,
          pendingRestartConfirmation: true,
        }}
        onRequest={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText('authorizationSystem.status.restricted')).toBeTruthy()
    expect(screen.queryByText('authorizationSystem.status.pending-restart-confirmation')).toBeNull()
  })
})
