import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const logoutMock = vi.fn()
const toastMock = vi.fn()
const wipeCredentialsMock = vi.fn()
const wipeLocalDataMock = vi.fn()
const uninstallAppMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { message?: string }) => (
      params?.message ? `${key}:${params.message}` : key
    ),
  }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { logout: typeof logoutMock }) => unknown) =>
    selector({ logout: logoutMock }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
  Checkbox: ({ checked, onCheckedChange, ...rest }: any) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      {...rest}
    />
  ),
  ConfirmDialog: ({ open, title, children, onConfirm }: any) => (
    open ? (
    <div data-testid="confirm-dialog">
      <p>{title}</p>
      {children}
      <button type="button" onClick={onConfirm}>confirm</button>
    </div>
    ) : null
  ),
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('../../SettingsSectionCard', () => ({
  SettingsSectionCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}))

import { DesktopCleanupSection } from '../DesktopCleanupSection'

function clickAction(label: string) {
  const matches = screen.getAllByText(label)
  const button = matches.find((node) => node.tagName.toLowerCase() === 'button')
  if (!button) throw new Error(`Button not found: ${label}`)
  fireEvent.click(button)
}

function installTabtinApi() {
  ;(window as unknown as { tabtin: unknown }).tabtin = {
    getPlatform: () => 'win32',
    appCleanup: {
      wipeCredentials: wipeCredentialsMock,
      wipeLocalData: wipeLocalDataMock,
      uninstallApp: uninstallAppMock,
    },
  }
}

describe('DesktopCleanupSection local data cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installTabtinApi()
    logoutMock.mockResolvedValue(undefined)
    wipeCredentialsMock.mockResolvedValue({ ok: true, removed: [], failed: [], credentialsCleared: true })
    wipeLocalDataMock.mockResolvedValue({ ok: true, removed: [], failed: [], credentialsCleared: true })
    uninstallAppMock.mockResolvedValue({
      ok: true,
      credentials: { ok: true, removed: [], failed: [], credentialsCleared: true },
      localData: null,
      willExit: false,
    })
  })

  it('清除本地配置与缓存时预约重启，不在当前进程登出', async () => {
    wipeLocalDataMock.mockResolvedValueOnce({
      ok: true,
      removed: [],
      failed: [],
      credentialsCleared: false,
      willRelaunch: true,
    })

    render(<DesktopCleanupSection />)

    clickAction('desktopCleanup.wipeLocalData')
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(wipeLocalDataMock).toHaveBeenCalledTimes(1))
    expect(logoutMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({ title: 'desktopCleanup.relaunchingToWipe' })
  })

  it('开发模式需手动重启时保留窗口与登录态，且 toast 不含 EBUSY', async () => {
    wipeLocalDataMock.mockResolvedValueOnce({
      ok: false,
      removed: [],
      failed: [{ path: 'cache', errorCode: 'busy' }],
      credentialsCleared: false,
      willRelaunch: false,
      needsManualDevRestart: true,
    })

    render(<DesktopCleanupSection />)

    clickAction('desktopCleanup.wipeLocalData')
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(wipeLocalDataMock).toHaveBeenCalledTimes(1))
    expect(logoutMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({
      title: 'desktopCleanup.needsManualDevRestart',
      variant: 'destructive',
    })
    const toastArg = toastMock.mock.calls[0]?.[0] as { title: string }
    expect(toastArg.title).not.toMatch(/EBUSY/i)
  })

  it('预约重启失败时保留登录态，且 toast 使用友好文案不含 EBUSY', async () => {
    wipeLocalDataMock.mockResolvedValueOnce({
      ok: false,
      removed: [],
      failed: [{ path: 'pending-local-data-wipe.json', errorCode: 'busy' }],
      credentialsCleared: false,
      willRelaunch: false,
    })

    render(<DesktopCleanupSection />)

    clickAction('desktopCleanup.wipeLocalData')
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(wipeLocalDataMock).toHaveBeenCalledTimes(1))
    expect(logoutMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({
      title: 'desktopCleanup.failed:desktopCleanup.errors.busy',
      variant: 'destructive',
    })
    const toastArg = toastMock.mock.calls[0]?.[0] as { title: string }
    expect(toastArg.title).not.toMatch(/EBUSY/i)
  })

  it('登录凭证清理失败时保留登录态，且 toast 不含 raw errno', async () => {
    wipeCredentialsMock.mockResolvedValueOnce({
      ok: false,
      removed: [],
      failed: [{ path: 'credentials', errorCode: 'busy' }],
      credentialsCleared: false,
    })

    render(<DesktopCleanupSection />)

    clickAction('desktopCleanup.wipeCredentials')
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(wipeCredentialsMock).toHaveBeenCalledTimes(1))
    expect(logoutMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({
      title: 'desktopCleanup.failed:desktopCleanup.errors.busy',
      variant: 'destructive',
    })
  })

  it('登录凭证清理成功后退出登录', async () => {
    render(<DesktopCleanupSection />)

    clickAction('desktopCleanup.wipeCredentials')
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(wipeCredentialsMock).toHaveBeenCalledTimes(1))
    expect(logoutMock).toHaveBeenCalledWith('manual')
    expect(toastMock).toHaveBeenCalledWith({ title: 'desktopCleanup.successCredentials' })
  })

  it('卸载前清理失败时不退出登录，且使用友好错误文案', async () => {
    uninstallAppMock.mockResolvedValueOnce({
      ok: false,
      credentials: {
        ok: false,
        removed: [],
        failed: [{ path: 'credentials', errorCode: 'unknown' }],
        credentialsCleared: false,
      },
      localData: {
        ok: false,
        removed: [],
        failed: [{ path: 'cache', errorCode: 'permission' }],
        credentialsCleared: false,
      },
      willExit: false,
    })

    render(<DesktopCleanupSection />)

    clickAction('desktopCleanup.uninstallApp')
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(uninstallAppMock).toHaveBeenCalledTimes(1))
    expect(logoutMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({
      title: 'desktopCleanup.failed:desktopCleanup.errors.permission',
      variant: 'destructive',
    })
    const toastArg = toastMock.mock.calls[0]?.[0] as { title: string }
    expect(toastArg.title).not.toMatch(/EPERM/i)
  })

  it('IPC 抛出含 EBUSY 的异常时 toast 仍走友好文案', async () => {
    wipeLocalDataMock.mockRejectedValueOnce(new Error('EBUSY: resource busy or locked, unlink'))

    render(<DesktopCleanupSection />)

    clickAction('desktopCleanup.wipeLocalData')
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(wipeLocalDataMock).toHaveBeenCalledTimes(1))
    expect(logoutMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith({
      title: 'desktopCleanup.failed:desktopCleanup.errors.busy',
      variant: 'destructive',
    })
  })
})
