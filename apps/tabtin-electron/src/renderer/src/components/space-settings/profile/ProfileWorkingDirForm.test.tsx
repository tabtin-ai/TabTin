/**
 * ：工作目录失效重选必须走 updateSpace（Space.working_dir SSOT），
 * 不能再 updateAgent——后端 AgentUpdate 已忽略 working_dir。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/smartsheet-ui')>('@tabtin/smartsheet-ui')
  return {
    ...actual,
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  }
})

const updateSpaceMock = vi.fn()
const updateAgentMock = vi.fn()
const notifyMock = vi.fn()
const showOpenDialogMock = vi.fn()
const pathExistsMock = vi.fn()
const resolveRealPathMock = vi.fn(async (p: string) => p)
const sheetState = { relocateNonce: 0 }

const space = {
  id: 'space-1',
  type: 'workspace' as const,
  name: 'Demo',
  organization_id: 'org-1',
  working_dir: '/Users/me/gone',
  working_dir_type: 'mixed' as const,
  control_device_id: 'device-1',
  bound_device_id: 'device-1',
  execution_agent_id: 'agent-1',
  agent_id: 'agent-1',
}

/** Agent 纯化后不再有 working_dir；空串不得盖住 Space 执行根。 */
const agent = {
  id: 'agent-1',
  organization_id: 'org-1',
  name: '小Tin',
  type: 'bot' as const,
  is_active: true,
  created_at: '',
  updated_at: '',
  working_dir: '',
  working_dir_type: '',
}

vi.mock('@stores/useSpaceStore', () => {
  const useSpaceStore = Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        spaces: [space],
        selectedAgent: agent,
        agentCache: { 'agent-1': agent },
        updateSpace: updateSpaceMock,
        updateAgent: updateAgentMock,
        isLoading: false,
        error: null,
        loadAgent: vi.fn(),
      }),
    { getState: () => ({ error: null, spaces: [space] }) },
  )
  return { useSpaceStore }
})

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (selector: (s: unknown) => unknown) =>
    selector({
      currentDevice: { id: 'device-1', fingerprint: 'fp-1' },
      devices: [{ id: 'device-1', fingerprint: 'fp-1' }],
    }),
}))

vi.mock('../../../components/context-space/hooks/useIsAgentControlDevice', () => ({
  useIsAgentControlDevice: () => ({
    isControl: true,
    controlDeviceName: 'This Mac',
    isResolving: false,
  }),
}))

vi.mock('../../../components/context-space/hooks/useIsRemoteViewer', () => ({
  useIsRemoteViewer: () => ({
    isRemoteViewer: false,
    isResolving: false,
    controlDeviceName: null,
  }),
}))

vi.mock('../../../components/context-space/hooks/useWorkspaceRootHealth', () => ({
  useWorkspaceRootHealth: () => ({
    status: 'unreachable',
    workingDir: '/Users/me/gone',
    retry: vi.fn(),
  }),
}))

vi.mock('@stores/useAgentSettingsSheetStore', () => ({
  useAgentSettingsSheetStore: (selector: (s: unknown) => unknown) =>
    selector({ relocateNonce: sheetState.relocateNonce }),
}))

vi.mock('@components/workspace/notifyWorkspacePaths', () => ({
  notifyWorkspacePathsForSpace: (...args: unknown[]) => notifyMock(...args),
}))

vi.mock('@utils/canonicalPath', () => ({
  resolveRealPath: (p: string) => resolveRealPathMock(p),
}))

vi.mock('./workingDirConflict', () => ({
  findLocalWorkingDirConflict: () => undefined,
  getSelectedWorkingDirCreateBlocker: () => ({ blocked: false }),
  handleWorkingDirConflictResponse: vi.fn(),
  isWorkingDirConflictError: () => false,
}))

import { ProfileWorkingDirForm } from './ProfileWorkingDirForm'

describe('ProfileWorkingDirForm ( Space.working_dir SSOT)', () => {
  beforeEach(() => {
    updateSpaceMock.mockReset()
    updateAgentMock.mockReset()
    notifyMock.mockReset()
    showOpenDialogMock.mockReset()
    pathExistsMock.mockReset()
    resolveRealPathMock.mockImplementation(async (p: string) => p)
    updateSpaceMock.mockResolvedValue(true)
    updateAgentMock.mockResolvedValue(true)
    pathExistsMock.mockResolvedValue({ exists: false, isDirectory: false })
    showOpenDialogMock.mockResolvedValue(['/Users/me/new-project'])
    sheetState.relocateNonce = 0
    window.tabtin = {
      showOpenDialog: showOpenDialogMock,
      fileSystem: { pathExists: pathExistsMock },
      git: { isGitRepo: vi.fn().mockResolvedValue({ success: true, isRepo: false }) },
    } as unknown as typeof window.tabtin
  })

  it('以 Space.working_dir 为 SSOT：Agent 空目录时仍展示失效路径与重选', async () => {
    render(<ProfileWorkingDirForm spaceId="space-1" canManage />)

    expect(screen.getByText('/Users/me/gone')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新选择...' })).toBeTruthy()
    expect(screen.queryByText(/尚未设置工作目录/)).toBeNull()
  })

  it('失效重选（relocate）选完目录自动 updateSpace，不走 updateAgent', async () => {
    const { rerender } = render(<ProfileWorkingDirForm spaceId="space-1" canManage />)

    await act(async () => {
      sheetState.relocateNonce = 1
      rerender(<ProfileWorkingDirForm spaceId="space-1" canManage />)
    })

    await waitFor(() => {
      expect(showOpenDialogMock).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: ['openDirectory'],
          defaultPath: '/Users/me/gone',
        }),
      )
    })

    await waitFor(() => {
      expect(updateSpaceMock).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({
          working_dir: '/Users/me/new-project',
          working_dir_type: 'mixed',
          device_fingerprint: 'fp-1',
        }),
      )
    })
    expect(updateAgentMock).not.toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalledWith('space-1')
  })

  it('表单内点「重新选择...」在失效态选完即 updateSpace（autoSave）', async () => {
    showOpenDialogMock.mockResolvedValueOnce(['/Users/me/picked'])
    render(<ProfileWorkingDirForm spaceId="space-1" canManage />)

    fireEvent.click(screen.getByRole('button', { name: '重新选择...' }))

    await waitFor(() => {
      expect(updateSpaceMock).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({
          working_dir: '/Users/me/picked',
          device_fingerprint: 'fp-1',
        }),
      )
    })
    expect(updateAgentMock).not.toHaveBeenCalled()
  })
})
