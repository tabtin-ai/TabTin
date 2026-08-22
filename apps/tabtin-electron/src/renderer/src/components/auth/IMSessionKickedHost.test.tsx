import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  dialogHarness,
  authState,
  logoutMock,
  organizationState,
  setConnectionStatusMock,
  startIMProviderMock,
  stopIMProviderMock,
} = vi.hoisted(() => {
  const logoutMock = vi.fn().mockResolvedValue(undefined)
  const setConnectionStatusMock = vi.fn()
  return {
    dialogHarness: { onOpenChange: undefined as ((open: boolean) => void) | undefined },
    authState: {
      user: { id: 'zsctest1' },
      logout: logoutMock,
    },
    logoutMock,
    organizationState: {
      selectedOrganization: { id: 'org-b' } as { id: string } | null,
      organizations: [{ id: 'org-a' }, { id: 'org-b' }],
    },
    setConnectionStatusMock,
    startIMProviderMock: vi.fn().mockResolvedValue(undefined),
    stopIMProviderMock: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) => {
    dialogHarness.onOpenChange = onOpenChange
    return open ? <>{children}</> : null
  },
  DialogContent: ({
    children,
    closeLabel,
  }: {
    children: React.ReactNode
    closeLabel: string
  }) => (
    <div role="dialog">
      {children}
      <button aria-label={closeLabel} onClick={() => dialogHarness.onOpenChange?.(false)} />
    </div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('lucide-react', () => ({ RefreshCw: () => null }))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: { getState: () => authState },
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: { getState: () => organizationState },
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: { getState: () => ({ setConnectionStatus: setConnectionStatusMock }) },
}))

vi.mock('@/services/tabchatApi', () => ({
  startIMProvider: startIMProviderMock,
  stopIMProvider: stopIMProviderMock,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

import { IMSessionKickedHost } from './IMSessionKickedHost'

describe('IMSessionKickedHost', () => {
  beforeEach(() => {
    dialogHarness.onOpenChange = undefined
    logoutMock.mockReset().mockResolvedValue(undefined)
    setConnectionStatusMock.mockReset()
    startIMProviderMock.mockReset().mockResolvedValue(undefined)
    stopIMProviderMock.mockReset().mockResolvedValue(undefined)
    organizationState.selectedOrganization = { id: 'org-b' }
  })

  it('reconnects IM only after confirmation', async () => {
    render(<IMSessionKickedHost />)

    act(() => {
      window.dispatchEvent(new CustomEvent('im:session-kicked'))
      window.dispatchEvent(new CustomEvent('im:session-kicked'))
    })

    expect(screen.getByText('已在其他设备登录对话')).toBeTruthy()
    expect(stopIMProviderMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))

    await waitFor(() => {
      expect(stopIMProviderMock).toHaveBeenCalledOnce()
      expect(startIMProviderMock).toHaveBeenCalledOnce()
      expect(startIMProviderMock).toHaveBeenCalledWith({ organizationId: 'org-b', userId: 'zsctest1' })
      expect(logoutMock).not.toHaveBeenCalled()
      expect(setConnectionStatusMock).toHaveBeenCalledWith('connected')
      expect(screen.queryByText('已在其他设备登录对话')).toBeNull()
    })
  })

  it('keeps the dialog open when reconnect fails', async () => {
    startIMProviderMock.mockRejectedValueOnce(new Error('offline'))
    render(<IMSessionKickedHost />)

    act(() => window.dispatchEvent(new CustomEvent('im:session-kicked')))
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))

    expect((await screen.findByRole('alert')).textContent).toBe('重新连接失败，请稍后再试。')
    expect(logoutMock).not.toHaveBeenCalled()
    expect(screen.getByText('已在其他设备登录对话')).toBeTruthy()
  })

  it('blocks the app when automatic network recovery is exhausted', () => {
    render(<IMSessionKickedHost />)

    act(() => window.dispatchEvent(new CustomEvent('im:connection-recovery-failed')))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('消息服务连接失败')).toBeTruthy()
    expect(screen.getByText('网络连接持续异常，消息服务无法恢复。请检查网络后重新连接。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy()
  })

  it('logs out when the prompt is closed', async () => {
    render(<IMSessionKickedHost />)

    act(() => window.dispatchEvent(new CustomEvent('im:session-kicked')))
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledWith('session_revoked')
      expect(screen.queryByText('已在其他设备登录对话')).toBeNull()
    })
  })
})
