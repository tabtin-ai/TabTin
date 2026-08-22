import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiRequestMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: apiRequestMock,
  getAuthToken: vi.fn().mockResolvedValue('token-1'),
}))

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'https://api.test' },
  API_ENDPOINTS: {
    PROJECT: {
      LIST: '/context/projects',
      CREATE_WITH_WORKSPACE: '/context/projects/create-with-workspace',
      DETAIL: (id: string) => `/context/projects/${id}`,
      PENDING_INVITATIONS: '/context/projects/invitations/pending',
      INVITE: (id: string) => `/context/projects/${id}/invitations`,
      INVITE_ACCEPT: (id: string) => `/context/projects/${id}/invitations/accept`,
      INVITE_REJECT: (id: string) => `/context/projects/${id}/invitations/reject`,
      WORKSPACE_ENSURE: (id: string) => `/context/projects/${id}/workspace/ensure`,
    },
  },
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path}`,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

let ProjectApiService: typeof import('../projectApi').ProjectApiService
let ProjectApiError: typeof import('../projectApi').ProjectApiError

beforeEach(async () => {
  vi.clearAllMocks()
  const mod = await import('../projectApi')
  ProjectApiService = mod.ProjectApiService
  ProjectApiError = mod.ProjectApiError
})

describe('ProjectApiService.createWithWorkspace', () => {
  it('POSTs project and workspace payload', async () => {
    apiRequestMock.mockResolvedValue({
      status: 201,
      data: {
        success: true,
        data: {
          project: {
            id: 'p1',
            name: 'P',
            organization_id: 'wt-1',
            type: 'team_space',
            execution_space_id: null,
            table_count: 0,
            order: 0,
            is_archived: false,
            is_default: false,
            config_version: 1,
            my_workspace: { id: 'w1' },
          },
          workspace: {
            id: 'w1',
            name: 'W',
            organization_id: 'wt-1',
            project_id: 'p1',
            type: 'workspace',
            working_dir: '/x',
            execution_agent_id: 'agent-1',
            control_device_id: 'device-1',
            control_device_status: 'online',
            is_companion: true,
          },
        },
      },
    })

    const result = await ProjectApiService.createWithWorkspace({
      organization_id: 'wt-1',
      name: 'P',
      description: 'D',
      device_id: 'd1',
      working_dir: '/x',
      working_dir_type: 'mixed',
    })

    expect(result.project.id).toBe('p1')
    expect(result.project.type).toBe('team_space')
    expect(result.project.execution_space_id).toBeNull()
    expect(result.project.config_version).toBe(1)
    expect(result.workspace.id).toBe('w1')
    expect(result.workspace.control_device_id).toBe('device-1')
    expect(result.workspace.execution_agent_id).toBe('agent-1')
    const call = apiRequestMock.mock.calls[0][0]
    expect(call.url).toContain('/context/projects/create-with-workspace')
    expect(call.method).toBe('POST')
    expect(JSON.parse(call.body)).toMatchObject({
      organization_id: 'wt-1',
      name: 'P',
      device_id: 'd1',
      working_dir: '/x',
    })
  })
})

describe('ProjectApiService.listProjects', () => {
  it('passes organization_id and returns data', async () => {
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { projects: [{ id: 'p1' }], total: 1 } },
    })
    const result = await ProjectApiService.listProjects('wt-1')
    expect(result.total).toBe(1)
    const call = apiRequestMock.mock.calls[0][0]
    expect(call.url).toContain('organization_id=wt-1')
    expect(call.method).toBe('GET')
  })

  it('throws ProjectApiError on non-200', async () => {
    apiRequestMock.mockResolvedValue({ status: 403, data: { message: 'no' } })
    await expect(ProjectApiService.listProjects('wt-1')).rejects.toBeInstanceOf(ProjectApiError)
  })
})

describe('ProjectApiService.getProject', () => {
  it('returns project with my_workspace', async () => {
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { id: 'p1', my_workspace: { id: 'w1' } } },
    })
    const project = await ProjectApiService.getProject('p1')
    expect(project.my_workspace?.id).toBe('w1')
  })
})

describe('ProjectApiService.inviteMember', () => {
  it('POSTs invite payload', async () => {
    apiRequestMock.mockResolvedValue({ status: 201, data: { success: true, data: {} } })
    await ProjectApiService.inviteMember('p1', { user_id: 'u2', role: 'editor' })
    const call = apiRequestMock.mock.calls[0][0]
    expect(call.url).toContain('/context/projects/p1/invitations')
    expect(JSON.parse(call.body)).toEqual({ user_id: 'u2', role: 'editor' })
  })

  it('throws on failure', async () => {
    apiRequestMock.mockResolvedValue({ status: 409, data: { code: 'ALREADY_MEMBER' } })
    await expect(
      ProjectApiService.inviteMember('p1', { user_id: 'u2', role: 'editor' }),
    ).rejects.toMatchObject({ errorCode: 'ALREADY_MEMBER' })
  })
})

describe('ProjectApiService.acceptInvitation', () => {
  it('returns companion workspace', async () => {
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          project_id: 'p1',
          project_name: 'P',
          role: 'editor',
          workspace: { id: 'w1', name: 'W', working_dir: '/x' },
        },
      },
    })
    const result = await ProjectApiService.acceptInvitation('p1', {
      device_id: 'd1',
      working_dir: '/x',
    })
    expect(result.workspace.id).toBe('w1')
    const call = apiRequestMock.mock.calls[0][0]
    expect(JSON.parse(call.body)).toMatchObject({ device_id: 'd1', working_dir: '/x' })
  })
})

describe('ProjectApiService.rejectInvitation', () => {
  it('POSTs reject', async () => {
    apiRequestMock.mockResolvedValue({ status: 200, data: { success: true } })
    await ProjectApiService.rejectInvitation('p1')
    const call = apiRequestMock.mock.calls[0][0]
    expect(call.url).toContain('/context/projects/p1/invitations/reject')
  })
})
