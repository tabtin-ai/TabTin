import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acceptInvitationMock,
  createWithWorkspaceMock,
  ensureDefaultAgentDirMock,
  ensureMyWorkspaceMock,
  registerCurrentDeviceMock,
} = vi.hoisted(() => ({
  acceptInvitationMock: vi.fn(),
  createWithWorkspaceMock: vi.fn(),
  ensureDefaultAgentDirMock: vi.fn(),
  ensureMyWorkspaceMock: vi.fn(),
  registerCurrentDeviceMock: vi.fn(),
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: {
    getState: () => ({
      registerCurrentDevice: registerCurrentDeviceMock,
    }),
  },
}))

vi.mock('@/services/projectApi', () => ({
  ProjectApiService: {
    acceptInvitation: acceptInvitationMock,
    createWithWorkspace: createWithWorkspaceMock,
    ensureMyWorkspace: ensureMyWorkspaceMock,
  },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

const {
  createProjectWithCompanionWorkspace,
  provisionProjectCompanionWorkspace,
} = await import('../provisionProjectWorkspace')

describe('provisionProjectCompanionWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        fileSystem: {
          ensureDefaultAgentDir: ensureDefaultAgentDirMock,
        },
      },
    })
  })

  it('creates project and workspace in one API call after local preparation', async () => {
    registerCurrentDeviceMock.mockResolvedValue({ id: 'device-1' })
    ensureDefaultAgentDirMock.mockResolvedValue({
      success: true,
      path: 'C:\\Users\\me\\TabTin\\Team\\Launch',
    })
    createWithWorkspaceMock.mockResolvedValue({
      project: { id: 'project-1', name: 'Launch' },
      workspace: {
        id: 'workspace-1',
        name: 'Launch 的工作空间',
        organization_id: 'organization-1',
        project_id: 'project-1',
        type: 'workspace',
        working_dir: 'C:\\Users\\me\\TabTin\\Team\\Launch',
        execution_agent_id: null,
        control_device_id: 'device-1',
        control_device_status: 'online',
        is_companion: true,
      },
    })

    const result = await createProjectWithCompanionWorkspace({
      organizationId: 'organization-1',
      organizationName: 'Team',
      projectName: 'Launch',
      description: 'Ship',
    })

    expect(result).toMatchObject({
      ok: true,
      project: { id: 'project-1' },
      workspace: {
        id: 'workspace-1',
        control_device_id: 'device-1',
        execution_agent_id: null,
      },
    })
    expect(createWithWorkspaceMock).toHaveBeenCalledWith({
      organization_id: 'organization-1',
      name: 'Launch',
      description: 'Ship',
      device_id: 'device-1',
      working_dir: 'C:\\Users\\me\\TabTin\\Team\\Launch',
      working_dir_type: 'mixed',
    })
    expect(ensureMyWorkspaceMock).not.toHaveBeenCalled()
  })

  it('registers current device, prepares default dir, and ensures my workspace', async () => {
    registerCurrentDeviceMock.mockResolvedValue({ id: 'device-1' })
    ensureDefaultAgentDirMock.mockResolvedValue({
      success: true,
      path: 'C:\\Users\\me\\TabTin\\Team\\Launch',
    })
    ensureMyWorkspaceMock.mockResolvedValue({
      id: 'workspace-1',
      name: 'Launch 项目的默认工作空间',
      working_dir: 'C:\\Users\\me\\TabTin\\Team\\Launch',
    })

    const result = await provisionProjectCompanionWorkspace({
      organizationId: 'organization-1',
      organizationName: 'Team',
      projectId: 'project-1',
      projectName: 'Launch',
      mode: 'ensure',
    })

    expect(result).toEqual({
      ok: true,
      workspace: {
        id: 'workspace-1',
        name: 'Launch 项目的默认工作空间',
        working_dir: 'C:\\Users\\me\\TabTin\\Team\\Launch',
      },
    })
    expect(registerCurrentDeviceMock).toHaveBeenCalledWith('organization-1')
    expect(ensureDefaultAgentDirMock).toHaveBeenCalledWith({
      organizationName: 'Team',
      spaceName: 'Launch',
    })
    expect(ensureMyWorkspaceMock).toHaveBeenCalledWith('project-1', {
      device_id: 'device-1',
      working_dir: 'C:\\Users\\me\\TabTin\\Team\\Launch',
      working_dir_type: 'mixed',
    })
    expect(acceptInvitationMock).not.toHaveBeenCalled()
  })

  it('uses accept invitation API in accept mode', async () => {
    registerCurrentDeviceMock.mockResolvedValue({ id: 'device-1' })
    ensureDefaultAgentDirMock.mockResolvedValue({
      success: true,
      path: 'C:\\Users\\me\\TabTin\\Team\\Launch',
    })
    acceptInvitationMock.mockResolvedValue({
      project_id: 'project-1',
      project_name: 'Launch',
      role: 'editor',
      workspace: {
        id: 'workspace-1',
        name: 'Launch 项目的默认工作空间',
        working_dir: 'C:\\Users\\me\\TabTin\\Team\\Launch',
      },
    })

    const result = await provisionProjectCompanionWorkspace({
      organizationId: 'organization-1',
      organizationName: 'Team',
      projectId: 'project-1',
      projectName: 'Launch',
      mode: 'accept',
    })

    expect(result).toEqual({
      ok: true,
      workspace: {
        id: 'workspace-1',
        name: 'Launch 项目的默认工作空间',
        working_dir: 'C:\\Users\\me\\TabTin\\Team\\Launch',
      },
    })
    expect(acceptInvitationMock).toHaveBeenCalledWith('project-1', {
      device_id: 'device-1',
      working_dir: 'C:\\Users\\me\\TabTin\\Team\\Launch',
      working_dir_type: 'mixed',
    })
    expect(ensureMyWorkspaceMock).not.toHaveBeenCalled()
  })
})
