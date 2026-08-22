import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (_key: string, options?: Record<string, unknown>) => {
      if (typeof options?.defaultValue === 'string') {
        return options.defaultValue.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''))
      }
      if (typeof options?.version === 'string') return `v${options.version}`
      return _key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick, disabled, variant, size }: any) => (
    <button type="button" onClick={onClick} disabled={disabled} data-variant={variant} data-size={size}>
      {children}
    </button>
  ),
  Progress: ({ value }: { value: number }) => <div data-testid="progress">{value}</div>,
  StatusNotice: ({ title, description, actions }: any) => (
    <section>
      {title ? <h4>{title}</h4> : null}
      {description}
      {actions}
    </section>
  ),
  ConfirmDialog: () => null,
  toast: vi.fn(),
}))

vi.mock('../SettingsPanelHeader', () => ({
  SettingsPanelHeader: ({ title, subtitle }: any) => (
    <header>
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </header>
  ),
}))

vi.mock('../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

vi.mock('../SettingsSectionCard', () => ({
  SettingsSectionCard: ({ title, subtitle, children }: any) => (
    <section>
      {title ? <h3>{title}</h3> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {children}
    </section>
  ),
}))

vi.mock('../SettingsInfoTooltip', () => ({
  SettingsInfoTooltip: () => null,
}))

vi.mock('./DesktopCleanupSection', () => ({
  DesktopCleanupSection: () => null,
}))

vi.mock('./MobileEnvironmentQrDialog', () => ({
  MobileEnvironmentQrDialog: ({ open }: { open: boolean }) => (
    open ? <div role="dialog">移动端环境二维码</div> : null
  ),
}))

vi.mock('@/hooks/useRuntimeVersionInfo', () => ({
  useRuntimeVersionInfo: () => ({
    clientVersion: '1.0.141',
    clientSourceSha: 'client1234567890',
    serverVersion: '260812',
    serverSourceSha: 'server1234567890',
    serverAddress: 'https://api-test.example.com/api',
    serverLoading: false,
  }),
}))

import {
  UpdatePanel,
  normalizeReleaseHistory,
} from './UpdatePanel'

const updaterApi = {
  getAppVersion: vi.fn(),
  getState: vi.fn(),
  getReleaseHistory: vi.fn(),
  onUpdateEvent: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}

describe('UpdatePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updaterApi.getAppVersion.mockResolvedValue('0.0.1-alpha.105')
    updaterApi.getState.mockResolvedValue({
      currentVersion: '0.0.1-alpha.105',
      platform: 'win',
      arch: 'x64',
      channel: 'alpha',
      status: 'idle',
      lastCheckedAt: '2026-06-24T04:00:00Z',
    })
    updaterApi.getReleaseHistory.mockResolvedValue([
      {
        version: '0.0.1-alpha.105',
        platform: 'win',
        arch: 'x64',
        channel: 'alpha',
        release_notes: '修复 Windows 桌面更新安装流程',
        published_at: '2026-06-24T03:00:00Z',
      },
    ])
    updaterApi.onUpdateEvent.mockReturnValue(() => {})

    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        updater: updaterApi,
        openExternal: vi.fn(),
      },
    })
  })

  it('renders release notes from backend history instead of static changelog', async () => {
    render(<UpdatePanel />)

    expect(await screen.findByText('修复 Windows 桌面更新安装流程')).toBeTruthy()
    expect(screen.queryByText('正式版发布')).toBeNull()
    expect(screen.queryByText('v1.0.0')).toBeNull()
    await waitFor(() => {
      expect(updaterApi.getReleaseHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'win',
          arch: 'x64',
          channel: 'alpha',
          limit: 10,
        }),
      )
    })
  })

  it('opens the mobile environment QR code from the version panel', async () => {
    render(<UpdatePanel />)

    fireEvent.click(screen.getByText('update.configureMobileEnvironment'))

    expect((await screen.findByRole('dialog')).textContent).toContain('移动端环境二维码')
  })

  it('normalizes snake_case release history fields', () => {
    expect(normalizeReleaseHistory([
      {
        version: '1.2.0',
        release_notes: '后台维护的更新说明',
        release_notes_en: 'Backend release notes',
        published_at: '2026-06-24T00:00:00Z',
        is_mandatory: true,
      },
    ])).toEqual([
      expect.objectContaining({
        version: '1.2.0',
        releaseNotes: '后台维护的更新说明',
        releaseNotesEn: 'Backend release notes',
        publishedAt: '2026-06-24T00:00:00Z',
        isMandatory: true,
      }),
    ])
  })

  it('does not render the internal diagnostics description', async () => {
    render(<UpdatePanel />)

    expect(await screen.findByText('诊断日志')).toBeTruthy()
    expect(
      screen.queryByText('遇到问题时导出客户端日志，随 bug 反馈发给研发排查'),
    ).toBeNull()
  })

  it('shows client and server build information', async () => {
    render(<UpdatePanel />)

    expect(await screen.findByText('1.0.141')).toBeTruthy()
    expect(screen.getByText('client12')).toBeTruthy()
    expect(screen.getByText('260812')).toBeTruthy()
    expect(screen.getByText('server12')).toBeTruthy()
    expect(screen.getByText('https://api-test.example.com/api')).toBeTruthy()
  })
})
