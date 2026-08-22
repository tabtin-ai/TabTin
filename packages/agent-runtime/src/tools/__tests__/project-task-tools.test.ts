import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectTaskTools } from '../project-task-tools.js'

const deps = {
  apiBaseUrl: 'https://api.example.com/api',
  apiAuthToken: 'token',
  organizationId: 'org-1',
  projectId: 'project-1',
}

function response(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('project task tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('combines active Project memberships with organization member names', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        memberships: [
          { user_id: 'user-1', role: 'owner', is_active: true },
          { user_id: 'user-2', role: 'editor', is_active: false },
          { agent_id: 'agent-1', role: 'editor', is_active: true },
        ],
      }))
      .mockResolvedValueOnce(response({
        members: [{
          user_id: 'user-1',
          user: { id: 'user-1', nickname: 'Seda' },
        }],
      }))
    vi.stubGlobal('fetch', fetchMock)

    const tool = createProjectTaskTools(deps).find(item => item.name === 'project_members_list')!
    const result = await tool.execute({}, {} as never)

    expect(JSON.parse(result.content)).toEqual({
      success: true,
      members: [{ user_id: 'user-1', name: 'Seda', role: 'owner' }],
      total: 1,
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/api/context/spaces/project-1/memberships',
    )
  })

  it('creates a confirmed task plan through the Project-scoped batch endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      tasks: [{ id: 'task-1', title: 'Ship release' }],
      total: 1,
    }, 201))
    vi.stubGlobal('fetch', fetchMock)

    const tool = createProjectTaskTools(deps).find(item => item.name === 'project_tasks_create')!
    const input = {
      tasks: [{
        title: 'Ship release',
        priority: 'high',
        responsible_user_id: 'user-1',
      }],
    }
    const result = await tool.execute(input, {} as never)

    expect(tool.isReadOnly).toBe(false)
    expect(tool.riskLevel).toBe('review')
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/api/context/projects/project-1/tasks/batch',
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ tasks: input.tasks })
    expect(JSON.parse(result.content).total).toBe(1)
  })
})
