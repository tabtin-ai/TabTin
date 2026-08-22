/**
 * SystemPermissionsComposite —  回归：同页不得出现两个「系统通知」标题。
 *
 * 上半分类开关用「通知偏好」，OS 权限行用「桌面通知」，文案必须可区分。
 */

import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import zhCN from '../../../../i18n/locales/zh-CN/settings.json'
import enUS from '../../../../i18n/locales/en-US/settings.json'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const parts = key.split('.')
      let cur: unknown = zhCN
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p]
        } else {
          return key
        }
      }
      return typeof cur === 'string' ? cur : key
    },
  }),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: () => undefined,
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

vi.mock('../../SettingsSectionHeader', () => ({
  SettingsSectionHeader: ({ section }: { section: string }) => (
    <h1 data-testid="section-header">{section}</h1>
  ),
}))

vi.mock('../../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../SettingsSection', () => ({
  SettingsSection: ({
    title,
    children,
  }: {
    title: string
    children: React.ReactNode
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}))

import { SystemPermissionsComposite } from '../SettingsGroupComposites'

describe('SystemPermissionsComposite ', () => {
  it('zh-CN：通知偏好与桌面通知文案互不相同，且都不叫「系统通知」', () => {
    const prefsTitle = zhCN.sections.notifications
    const osTitle = zhCN.authorizationSystem.items.notifications.title
    expect(prefsTitle).toBe('通知偏好')
    expect(osTitle).toBe('桌面通知')
    expect(prefsTitle).not.toBe(osTitle)
    expect(prefsTitle).not.toBe('系统通知')
    expect(osTitle).not.toBe('系统通知')
  })

  it('en-US：Notification Preferences 与 Desktop Notifications 可区分', () => {
    const prefsTitle = enUS.sections.notifications
    const osTitle = enUS.authorizationSystem.items.notifications.title
    expect(prefsTitle).toBe('Notification Preferences')
    expect(osTitle).toBe('Desktop Notifications')
    expect(prefsTitle).not.toBe(osTitle)
  })

  it('上半区块标题用「通知偏好」，不再用「系统通知」', () => {
    render(<SystemPermissionsComposite />)
    expect(screen.getByText('通知偏好')).toBeTruthy()
    expect(screen.getByText('其他权限')).toBeTruthy()
    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    expect(headings).not.toContain('系统通知')
  })
})
