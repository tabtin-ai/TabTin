import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openCreate: vi.fn(),
  openCreateForDaemon: vi.fn(),
  getLastUsedWorkspaceId: vi.fn(() => null),
  spaces: [
    {
      id: 'ws-local',
      name: '本机现场',
      type: 'workspace',
      organization_id: 'org-1',
      is_archived: false,
      working_dir: '/Users/me/local',
      control_device_id: 'device-local',
    },
    {
      id: 'ws-remote-online',
      name: '远程现场',
      type: 'workspace',
      organization_id: 'org-1',
      is_archived: false,
      working_dir: '/srv/online',
      control_device_id: 'device-remote',
    },
    {
      id: 'ws-remote-offline',
      name: '离线现场',
      type: 'workspace',
      organization_id: 'org-1',
      is_archived: false,
      working_dir: '/srv/offline',
      control_device_id: 'device-offline',
    },
  ],
}))

const devices = [
  { id: 'device-local', name: 'Local Mac', status: 'online', fingerprint: 'local-installation' },
  { id: 'device-remote', name: 'Office Mac', status: 'online', fingerprint: 'remote-installation' },
  { id: 'device-offline', name: 'Home Server', status: 'offline', fingerprint: 'offline-installation' },
]

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; device?: string }) => {
      if (options?.defaultValue) {
        return options.device
          ? options.defaultValue.replace('{{device}}', options.device)
          : options.defaultValue
      }
      return key
    },
  }),
}))

vi.mock('@components/ui', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  Button: ({
    children,
    onClick,
    disabled,
  }: React.PropsWithChildren<{
    onClick?: React.MouseEventHandler<HTMLButtonElement>
    disabled?: boolean
  }>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: React.PropsWithChildren<{ onSelect?: () => void }>) => (
    <button type="button" onClick={onSelect}>{children}</button>
  ),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { selectedOrganization: { id: string } }) => unknown) =>
    selector({ selectedOrganization: { id: 'org-1' } }),
}))

vi.mock('@stores/useSpaceStore', () => {
  const state = { spaces: mocks.spaces, agentCache: {} }
  const useSpaceStore = (selector: (value: typeof state) => unknown) => selector(state)
  useSpaceStore.getState = () => state
  return { useSpaceStore }
})

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (selector: (state: {
    devices: typeof devices
    currentDevice: (typeof devices)[0]
  }) => unknown) => selector({ devices, currentDevice: devices[0] }),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: {
    getState: () => ({ getLastUsedWorkspaceId: mocks.getLastUsedWorkspaceId }),
  },
}))

vi.mock('@stores/useSpaceAgentDialogStore', () => ({
  useSpaceAgentDialogStore: (selector: (state: {
    openCreate: typeof mocks.openCreate
    openCreateForDaemon: typeof mocks.openCreateForDaemon
  }) => unknown) => selector({
    openCreate: mocks.openCreate,
    openCreateForDaemon: mocks.openCreateForDaemon,
  }),
}))

vi.mock('@/hooks/useEffectiveFeature', () => ({
  useEffectiveFeature: () => ({ enabled: true }),
}))

vi.mock('@/hooks/queries/accountDevices', () => ({
  useAccountDevicesQuery: () => ({
    data: [
      {
        device_id: 'account-local',
        installation_id: 'local-installation',
        name: 'Local Mac',
        kind: 1,
        roles: [2],
        control_state: 1,
        presence: { state: 1 },
      },
      {
        device_id: 'account-remote',
        installation_id: 'remote-installation',
        name: 'Office Mac',
        kind: 1,
        roles: [2],
        control_state: 1,
        presence: { state: 1 },
      },
      {
        device_id: 'account-offline',
        installation_id: 'offline-installation',
        name: 'Home Server',
        kind: 2,
        roles: [2],
        control_state: 1,
        presence: { state: 2 },
      },
    ],
  }),
}))

vi.mock('@/utils/defaultExecutionSpace', () => ({
  resolveDefaultExecutionWorkspaceId: () => 'ws-local',
}))

vi.mock('@/utils/logger', () => {
  const instance = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    createLogger: () => instance,
    logger: instance,
  }
})

import { AgentWorkspacePickerDialog } from './AgentWorkspacePickerDialog'

describe('AgentWorkspacePickerDialog', () => {
  beforeEach(() => {
    mocks.openCreate.mockReset()
    mocks.openCreateForDaemon.mockReset()
    mocks.getLastUsedWorkspaceId.mockReset().mockReturnValue(null)
  })

  it('为本机 / 远程 / 离线现场打上与侧栏一致的状态标记，且远程离线仍可选', () => {
    render(
      <AgentWorkspacePickerDialog
        open
        onOpenChange={vi.fn()}
        title="选择执行现场"
        onConfirm={vi.fn()}
      />,
    )

    const localRow = screen.getByRole('button', { name: /本机现场/ })
    const remoteRow = screen.getByRole('button', { name: /远程现场/ })
    const offlineRow = screen.getByRole('button', { name: /离线现场/ })

    expect(localRow.querySelector('[data-testid="execution-device-status-tag"]')).toBeNull()
    expect(remoteRow.querySelector('[data-tone="remote"]')).not.toBeNull()
    expect(remoteRow.querySelector('[data-secondary-tone]')).toBeNull()
    expect(offlineRow.querySelector('[data-tone="remote"]')).not.toBeNull()
    expect(offlineRow.querySelector('[data-secondary-tone="offline"]')).not.toBeNull()

    expect((offlineRow as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(offlineRow)
    expect((screen.getByRole('button', { name: 'confirmWorkspace' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('添加入口可建本机工作空间，以及远程在线 / 离线设备上的工作空间', () => {
    render(
      <AgentWorkspacePickerDialog
        open
        onOpenChange={vi.fn()}
        title="选择执行现场"
        onConfirm={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加工作空间' }))
    expect(mocks.openCreate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '本机工作空间' }))
    expect(mocks.openCreate).toHaveBeenCalledWith(expect.objectContaining({
      onCreated: expect.any(Function),
    }))

    fireEvent.click(screen.getByRole('button', { name: /Office Mac/ }))
    expect(mocks.openCreateForDaemon).toHaveBeenCalledWith(
      { installationId: 'remote-installation', deviceName: 'Office Mac' },
      expect.objectContaining({ onCreated: expect.any(Function) }),
    )

    fireEvent.click(screen.getByRole('button', { name: /Home Server/ }))
    expect(mocks.openCreateForDaemon).toHaveBeenCalledWith(
      { installationId: 'offline-installation', deviceName: 'Home Server' },
      expect.objectContaining({ onCreated: expect.any(Function) }),
    )
  })

  it('更换现场以当前绑定为预选，不被 lastUsed/default 覆盖', () => {
    mocks.getLastUsedWorkspaceId.mockReturnValue('ws-local')

    render(
      <AgentWorkspacePickerDialog
        open
        onOpenChange={vi.fn()}
        title="更换现场"
        initialWorkspaceId="ws-remote-offline"
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /离线现场/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /本机现场/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('加 Agent 不传初值时仍走默认现场', () => {
    mocks.getLastUsedWorkspaceId.mockReturnValue('ws-remote-online')

    render(
      <AgentWorkspacePickerDialog
        open
        onOpenChange={vi.fn()}
        title="选择执行现场"
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /本机现场/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('确认换绑后再打开，勾选跟随新的 binding', () => {
    const { rerender } = render(
      <AgentWorkspacePickerDialog
        open
        onOpenChange={vi.fn()}
        title="更换现场"
        initialWorkspaceId="ws-local"
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /本机现场/ }).getAttribute('aria-pressed')).toBe('true')

    rerender(
      <AgentWorkspacePickerDialog
        open={false}
        onOpenChange={vi.fn()}
        title="更换现场"
        initialWorkspaceId="ws-local"
        onConfirm={vi.fn()}
      />,
    )
    rerender(
      <AgentWorkspacePickerDialog
        open
        onOpenChange={vi.fn()}
        title="更换现场"
        initialWorkspaceId="ws-remote-online"
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /远程现场/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /本机现场/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('弹窗内新建工作空间后保持勾选新建项', () => {
    render(
      <AgentWorkspacePickerDialog
        open
        onOpenChange={vi.fn()}
        title="更换现场"
        initialWorkspaceId="ws-local"
        onConfirm={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '本机工作空间' }))
    act(() => {
      mocks.openCreate.mock.calls[0][0].onCreated('ws-remote-offline')
    })

    expect(screen.getByRole('button', { name: /离线现场/ }).getAttribute('aria-pressed')).toBe('true')
  })
})
