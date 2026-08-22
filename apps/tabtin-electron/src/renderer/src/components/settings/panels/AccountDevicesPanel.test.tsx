import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() => ({
  data: [] as Array<Record<string, unknown>>,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}))

const dialogMock = vi.hoisted(() => ({
  openCreateForDaemon: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'accountDevices.deviceDetails') {
        return `${String(options?.system)} · ${String(options?.version)}`
      }
      if (key === 'accountDevices.lastSeen') return `last seen ${String(options?.time)}`
      if (key === 'accountDevices.listCount') return `${String(options?.count)} devices`
      return key
    },
  }),
}))

vi.mock('@/hooks/queries/accountDevices', () => ({
  useAccountDevicesQuery: () => queryMock,
}))

vi.mock('@/stores/useSpaceAgentDialogStore', () => ({
  useSpaceAgentDialogStore: (selector: (state: typeof dialogMock) => unknown) => (
    selector(dialogMock)
  ),
}))

vi.mock('@/services/daemonControlApi', () => ({
  DAEMON_CONTROL_DEVICE_KIND: { electron: 1, daemon: 2, mobile: 3, sandbox: 4 },
  DAEMON_CONTROL_DEVICE_ROLE: { controller: 1, executor: 2 },
  DAEMON_CONTROL_CONTROL_STATE: { active: 1 },
  DAEMON_CONTROL_PRESENCE: { online: 1, offline: 2, unknown: 3 },
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, onClick, disabled, title }: React.PropsWithChildren<{
    onClick?: React.MouseEventHandler<HTMLButtonElement>
    disabled?: boolean
    title?: string
  }>) => (
    <button type="button" onClick={onClick} disabled={disabled} title={title}>{children}</button>
  ),
  EmptyState: ({ title, description }: { title?: React.ReactNode; description?: React.ReactNode }) => (
    <section><h3>{title}</h3><p>{description}</p></section>
  ),
}))

vi.mock('../SettingsBadge', () => ({
  SettingsBadge: ({ children, tone }: React.PropsWithChildren<{ tone?: string }>) => (
    <span data-tone={tone}>{children}</span>
  ),
}))

vi.mock('../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

vi.mock('../SettingsSectionCard', () => ({
  SettingsSectionCard: ({ title, subtitle, actions, children }: React.PropsWithChildren<{
    title?: React.ReactNode
    subtitle?: React.ReactNode
    actions?: React.ReactNode
  }>) => (
    <section>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}{actions}{children}</section>
  ),
}))

vi.mock('../SettingsSectionHeader', () => ({
  SettingsSectionHeader: ({ section, subtitle, meta }: {
    section: string
    subtitle?: React.ReactNode
    meta?: React.ReactNode
  }) => <header><h1>{section}</h1><p>{subtitle}</p>{meta}</header>,
}))

import { AccountDevicesPanel } from './AccountDevicesPanel'

const baseDevice = {
  owner_user_id: 'user-1',
  roles: [2],
  control_state: 1,
  os: 'linux',
  arch: 'arm64',
  app_version: '1.2.3',
  created_at: '2026-08-12T02:00:00Z',
}

describe('AccountDevicesPanel', () => {
  beforeEach(() => {
    queryMock.data = []
    queryMock.isLoading = false
    queryMock.isError = false
    queryMock.isFetching = false
    queryMock.refetch.mockReset()
    dialogMock.openCreateForDaemon.mockReset()
  })

  it('展示全部已登录设备的类型、三态在线状态、版本和 last seen', () => {
    queryMock.data = [
      {
        ...baseDevice,
        device_id: 'daemon-1',
        installation_id: 'installation-1',
        name: 'Home Daemon',
        kind: 2,
        presence: { state: 1, last_seen_at: '2026-08-13T02:00:00Z' },
      },
      {
        ...baseDevice,
        device_id: 'desktop-1',
        installation_id: 'installation-2',
        name: 'Office Mac',
        kind: 1,
        presence: { state: 2 },
      },
      {
        ...baseDevice,
        device_id: 'sandbox-1',
        installation_id: 'installation-3',
        name: 'Cloud Sandbox',
        kind: 4,
        presence: { state: 3 },
      },
    ]

    render(<AccountDevicesPanel />)

    expect(screen.getByText('Home Daemon')).toBeTruthy()
    expect(screen.getByText('Office Mac')).toBeTruthy()
    expect(screen.getByText('Cloud Sandbox')).toBeTruthy()
    expect(screen.getByText('accountDevices.types.daemon')).toBeTruthy()
    expect(screen.getByText('accountDevices.types.electron')).toBeTruthy()
    expect(screen.getByText('accountDevices.types.sandbox')).toBeTruthy()
    expect(screen.getByText('accountDevices.status.online')).toBeTruthy()
    expect(screen.getByText('accountDevices.status.offline')).toBeTruthy()
    expect(screen.getByText('accountDevices.status.unknown')).toBeTruthy()
    expect(screen.getAllByText('linux · arm64 · v1.2.3')).toHaveLength(3)
    expect(screen.getByText(/^last seen /)).toBeTruthy()
  })

  it('打开页面后可手动刷新设备快照', () => {
    render(<AccountDevicesPanel />)

    fireEvent.click(screen.getByTitle('accountDevices.refresh'))
    expect(queryMock.refetch).toHaveBeenCalledOnce()
  })

  it('电脑端和 Daemon 中只有 active executor 可创建 Workspace', () => {
    queryMock.data = [
      {
        ...baseDevice,
        device_id: 'electron-1',
        installation_id: 'electron-installation-1',
        name: 'Office Mac',
        kind: 1,
        presence: { state: 2 },
      },
      {
        ...baseDevice,
        device_id: 'daemon-1',
        installation_id: 'daemon-installation-1',
        name: 'Home Daemon',
        kind: 2,
        presence: { state: 1 },
      },
      {
        ...baseDevice,
        device_id: 'inactive-electron',
        installation_id: 'inactive-installation',
        name: 'Inactive Mac',
        kind: 1,
        control_state: 0,
        presence: { state: 1 },
      },
      {
        ...baseDevice,
        device_id: 'controller-only-daemon',
        installation_id: 'controller-installation',
        name: 'Controller only',
        kind: 2,
        roles: [1],
        presence: { state: 1 },
      },
      {
        ...baseDevice,
        device_id: 'mobile-1',
        installation_id: 'mobile-installation',
        name: 'Phone',
        kind: 3,
        presence: { state: 1 },
      },
    ]

    render(<AccountDevicesPanel />)
    const createButtons = screen.getAllByText('accountDevices.createWorkspace')

    expect(createButtons).toHaveLength(2)
    fireEvent.click(createButtons[0])
    fireEvent.click(createButtons[1])

    expect(dialogMock.openCreateForDaemon).toHaveBeenNthCalledWith(1, {
      installationId: 'electron-installation-1',
      deviceName: 'Office Mac',
    })
    expect(dialogMock.openCreateForDaemon).toHaveBeenNthCalledWith(2, {
      installationId: 'daemon-installation-1',
      deviceName: 'Home Daemon',
    })
  })
})
