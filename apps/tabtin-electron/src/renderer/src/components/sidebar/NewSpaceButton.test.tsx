import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createSpace: vi.fn(),
  refreshSpace: vi.fn(),
  openCreatedWorkspaceAsNewTask: vi.fn(),
  dialogState: {
    isOpen: true,
    mode: 'create',
    openCreate: vi.fn(),
    close: vi.fn(),
    createOptions: null as { onCreated?: (spaceId: string) => void } | null,
  },
}))

const spaceState = {
  spaces: [],
  agentCache: {},
  selectedAgent: null,
  error: null,
  createSpace: mocks.createSpace,
  updateSpace: vi.fn(),
  updateAgent: vi.fn(),
  loadAgent: vi.fn(),
  refreshSpace: mocks.refreshSpace,
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}))

vi.mock('@components/ui', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogScrollBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  Button: ({ children, onClick, disabled, type }: React.PropsWithChildren<{
    onClick?: React.MouseEventHandler<HTMLButtonElement>
    disabled?: boolean
    type?: 'button' | 'submit'
  }>) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  toast: vi.fn(),
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))

vi.mock('@stores/useSpaceStore', () => {
  const useSpaceStore = (selector: (state: typeof spaceState) => unknown) =>
    selector(spaceState)
  useSpaceStore.getState = () => spaceState
  return { useSpaceStore }
})

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: { id: 'organization-1', name: 'My Organization' },
      organizations: [],
    }),
  },
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: {
    getState: () => ({ currentDevice: { id: 'local-device-id' } }),
  },
}))

vi.mock('@stores/useSpaceAgentDialogStore', () => {
  const useSpaceAgentDialogStore = (selector: (value: typeof mocks.dialogState) => unknown) =>
    selector(mocks.dialogState)
  useSpaceAgentDialogStore.getState = () => mocks.dialogState
  return { useSpaceAgentDialogStore }
})

vi.mock('@components/workspace/notifyWorkspacePaths', () => ({
  notifyWorkspacePathsForSpace: vi.fn(),
}))

vi.mock('@components/context-space/ContextDialogHeader', () => ({
  ContextDialogHeader: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>,
}))

vi.mock('@utils/canonicalPath', () => ({ resolveRealPath: vi.fn() }))
vi.mock('@/services/newTaskDraftNavigation', () => ({
  openCreatedWorkspaceAsNewTask: mocks.openCreatedWorkspaceAsNewTask,
}))
vi.mock('@components/space-settings/profile/workingDirConflict', () => ({
  findLocalWorkingDirConflict: vi.fn(),
  getSelectedWorkingDirCreateBlocker: vi.fn(() => ({ blocked: false })),
  handleWorkingDirConflictResponse: vi.fn(),
  isWorkingDirConflictError: vi.fn(() => false),
}))
vi.mock('./generateRandomWorkspaceName', () => ({
  generateRandomWorkspaceName: () => 'Generated Workspace',
}))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}))

import { CreateSpaceDialog } from './NewSpaceButton'

describe('CreateSpaceDialog 远程执行设备 Workspace', () => {
  beforeEach(() => {
    mocks.createSpace.mockReset().mockResolvedValue({ id: 'workspace-1' })
    mocks.refreshSpace.mockReset().mockResolvedValue(undefined)
    mocks.openCreatedWorkspaceAsNewTask.mockReset().mockResolvedValue(undefined)
    mocks.dialogState.createOptions = null
  })

  it('rejects paths that normalize to the remote root', () => {
    render(
      <CreateSpaceDialog
        open
        onOpenChange={vi.fn()}
        daemonTarget={{ installationId: 'electron-installation-1', deviceName: 'Office Mac' }}
      />,
    )

    fireEvent.change(document.querySelector('#daemon-working-dir')!, {
      target: { value: '/tmp/..' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))

    expect(screen.getByRole('alert').textContent).toBe('请输入执行设备上的非根绝对路径')
    expect(mocks.createSpace).not.toHaveBeenCalled()
  })

  it('用选中执行设备的 installation id 创建，不混入当前本机 device id', async () => {
    render(
      <CreateSpaceDialog
        open
        onOpenChange={vi.fn()}
        daemonTarget={{ installationId: 'electron-installation-1', deviceName: 'Office Mac' }}
      />,
    )

    fireEvent.change(document.querySelector('#daemon-working-dir')!, {
      target: { value: '/srv/tabtin/project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))

    await waitFor(() => {
      expect(mocks.createSpace).toHaveBeenCalledWith(expect.objectContaining({
        organization_id: 'organization-1',
        device_id: undefined,
        device_installation_id: 'electron-installation-1',
        working_dir: '/srv/tabtin/project',
      }))
    })
    expect(mocks.createSpace.mock.calls[0][0].device_id).toBeUndefined()
  })

  it('调用方接管创建结果时不自动打开新任务', async () => {
    const onCreated = vi.fn()
    mocks.dialogState.createOptions = { onCreated }

    render(
      <CreateSpaceDialog
        open
        onOpenChange={vi.fn()}
        daemonTarget={{ installationId: 'electron-installation-1', deviceName: 'Office Mac' }}
      />,
    )

    fireEvent.change(document.querySelector('#daemon-working-dir')!, {
      target: { value: '/srv/tabtin/project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('workspace-1')
    })
    expect(mocks.openCreatedWorkspaceAsNewTask).not.toHaveBeenCalled()
  })
})
