import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PermissionDescriptor } from '../permissionConfig'

const items: PermissionDescriptor[] = [
  'fullDiskAccess',
  'screenCapture',
  'accessibility',
  'automation',
  'microphone',
  'location',
  'notifications',
].map((kind) => ({
  kind: kind as PermissionDescriptor['kind'],
  status: 'denied',
  platform: 'darwin',
  canRequest: false,
  canOpenSettings: true,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { granted?: number; total?: number }) => {
      const copy: Record<string, string> = {
        'authorizationSystem.groups.data': '数据访问',
        'authorizationSystem.groups.screen': '屏幕与控制',
        'authorizationSystem.groups.input': '输入设备',
        'authorizationSystem.groups.output': '输出',
        'authorizationSystem.items.fullDiskAccess.title': '完全磁盘访问',
        'authorizationSystem.items.screenCapture.title': '屏幕录制',
        'authorizationSystem.items.accessibility.title': '辅助功能',
        'authorizationSystem.items.automation.title': '自动化',
        'authorizationSystem.items.microphone.title': '麦克风',
        'authorizationSystem.items.location.title': '位置服务',
        'authorizationSystem.items.notifications.title': '桌面通知',
        'authorizationSystem.overview.taglineNone': '尚未授权',
        'authorizationSystem.overview.refresh': '重新检查',
      }
      if (key === 'authorizationSystem.overview.summary') {
        return `已授权 ${options?.granted} / 共 ${options?.total} 项`
      }
      return copy[key] ?? key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock('@utils/cn', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}))

vi.mock('../usePermissionsState', () => ({
  usePermissionsState: () => ({
    items,
    loadState: 'ready',
    isRefreshing: false,
    errorMessage: null,
    refresh: vi.fn(),
    request: vi.fn(),
    openSettings: vi.fn(),
  }),
}))

import { AuthorizationSystemPanel } from '../../AuthorizationSystemPanel'

describe('AuthorizationSystemPanel capability visibility', () => {
  it('不展示未发布的屏幕与控制权限，也不把它们计入授权统计', () => {
    render(<AuthorizationSystemPanel embedded />)

    expect(screen.queryByText('屏幕与控制')).toBeNull()
    expect(screen.queryByText('屏幕录制')).toBeNull()
    expect(screen.queryByText('辅助功能')).toBeNull()
    expect(screen.queryByText('自动化')).toBeNull()
    expect(screen.getByText('完全磁盘访问')).toBeTruthy()
    expect(screen.getByText('麦克风')).toBeTruthy()
    expect(screen.getByText('位置服务')).toBeTruthy()
    expect(screen.getByText('桌面通知')).toBeTruthy()
    expect(screen.getByText('已授权 0 / 共 4 项')).toBeTruthy()
  })
})
