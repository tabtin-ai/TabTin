import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const electronFetchMock = vi.hoisted(() => vi.fn())
const ensureMaterializeMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/electronFetch', () => ({
  electronFetch: electronFetchMock,
}))

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'http://localhost:6060' },
  API_ENDPOINTS: {
    AGENT: {
      SKILLS: (agentId: string) => `/agents/${agentId}/skills`,
      SKILL: (agentId: string, key: string) =>
        `/agents/${agentId}/skills/${encodeURIComponent(key)}`,
    },
  },
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'token-1',
      user: { id: 'user-1' },
    }),
  },
}))

vi.mock('./skills', () => ({
  // ：避免 importActual 拉起 skills.ts 全量依赖（worktree 无完整 package 解析）
  skillKeys: {
    all: ['skills'] as const,
    list: (organizationId: string) => ['skills', 'list', organizationId] as const,
  },
  agentSkillKeys: {
    all: ['agent-skills'] as const,
    list: (agentId: string) => ['agent-skills', 'list', agentId] as const,
  },
  ensureSkillMaterializedLocally: ensureMaterializeMock,
}))

function makeWrapper() {
  return makeHarness().wrapper
}

function makeHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
  return { queryClient, wrapper }
}

describe('agent skill attach/re-enable materialize ', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
    ensureMaterializeMock.mockReset()
    ensureMaterializeMock.mockResolvedValue('installed')
  })

  it('materializes locally after attach when skill + spaceId are provided', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          skill_canonical_key: 'user:probe',
          enabled: true,
          name: 'probe',
        },
      }),
    })

    const { useAttachAgentSkillMutation } = await import('./agentSkills')
    const { result } = renderHook(() => useAttachAgentSkillMutation(), {
      wrapper: makeWrapper(),
    })

    const skill = {
      skill_id: 'probe',
      skill_key: 'user:probe',
      name: 'probe',
      source: 'user' as const,
      package_id: 'pkg-1',
      latest_version_seq: 1,
    }

    await act(async () => {
      await result.current.mutateAsync({
        agentId: 'agent-1',
        skillCanonicalKey: 'user:probe',
        spaceId: 'space-1',
        organizationId: 'wt-1',
        skill,
      })
    })

    expect(ensureMaterializeMock).toHaveBeenCalledWith({
      skill,
      spaceId: 'space-1',
      organizationId: 'wt-1',
    })
  })

  it('does not materialize on attach when skill metadata is omitted', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { skill_canonical_key: 'user:probe', enabled: true },
      }),
    })

    const { useAttachAgentSkillMutation } = await import('./agentSkills')
    const { result } = renderHook(() => useAttachAgentSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        agentId: 'agent-1',
        skillCanonicalKey: 'user:probe',
        spaceId: 'space-1',
      })
    })

    expect(ensureMaterializeMock).not.toHaveBeenCalled()
  })

  it('does not rematerialize a workspace skill that already exists in the workspace', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { skill_canonical_key: 'workspace:skills/probe', enabled: true },
      }),
    })

    const { useAttachAgentSkillMutation } = await import('./agentSkills')
    const { result } = renderHook(() => useAttachAgentSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        agentId: 'agent-1',
        skillCanonicalKey: 'workspace:skills/probe',
        spaceId: 'space-1',
        organizationId: 'wt-1',
        skill: {
          skill_id: 'workspace:skills/probe',
          skill_key: 'workspace:skills/probe',
          name: 'probe',
          source: 'workspace',
        },
      })
    })

    expect(ensureMaterializeMock).not.toHaveBeenCalled()
  })

  it('materializes when re-enabling a link with skill + spaceId', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { skill_canonical_key: 'user:probe', enabled: true },
      }),
    })

    const { useUpdateAgentSkillLinkMutation } = await import('./agentSkills')
    const { result } = renderHook(() => useUpdateAgentSkillLinkMutation(), {
      wrapper: makeWrapper(),
    })

    const skill = {
      skill_id: 'probe',
      skill_key: 'user:probe',
      name: 'probe',
      source: 'user' as const,
    }

    await act(async () => {
      await result.current.mutateAsync({
        agentId: 'agent-1',
        skillCanonicalKey: 'user:probe',
        enabled: true,
        spaceId: 'space-1',
        skill,
      })
    })

    expect(ensureMaterializeMock).toHaveBeenCalledWith({
      skill,
      spaceId: 'space-1',
    })
  })

  it('surfaces materialize failure after successful attach', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { skill_canonical_key: 'user:probe', enabled: true },
      }),
    })
    ensureMaterializeMock.mockRejectedValue(new Error('disk full'))

    const { useAttachAgentSkillMutation } = await import('./agentSkills')
    const { result } = renderHook(() => useAttachAgentSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await expect(result.current.mutateAsync({
      agentId: 'agent-1',
      skillCanonicalKey: 'user:probe',
      spaceId: 'space-1',
      skill: {
        skill_id: 'probe',
        skill_key: 'user:probe',
        name: 'probe',
        source: 'user',
      },
    })).rejects.toThrow('disk full')
  })

  it('#8698 update link invalidates agent carry list, not org catalog agent_enabled', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { skill_canonical_key: 'user:probe', enabled: false },
      }),
    })

    const { queryClient, wrapper } = makeHarness()
    const orgCatalogKey = ['skills', 'list', 'wt-1'] as const
    const agentCarryKey = ['agent-skills', 'list', 'agent-1'] as const
    queryClient.setQueryData(orgCatalogKey, [
      {
        skill_id: 'probe',
        skill_key: 'user:probe',
        name: 'probe',
        source: 'user',
        enabled: true,
      },
    ])
    queryClient.setQueryData(agentCarryKey, [
      { skill_canonical_key: 'user:probe', enabled: true },
    ])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { useUpdateAgentSkillLinkMutation } = await import('./agentSkills')
    const { result } = renderHook(() => useUpdateAgentSkillLinkMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        agentId: 'agent-1',
        skillCanonicalKey: 'user:probe',
        enabled: false,
        spaceId: 'space-1',
      })
    })

    // 组织目录不再被原地改 agent_enabled
    expect(queryClient.getQueryData(orgCatalogKey)).toEqual([
      expect.objectContaining({ skill_key: 'user:probe', enabled: true }),
    ])
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: agentCarryKey }),
    )
  })

  it('#8698 attach invalidates agent carry + skills catalog queries', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { skill_canonical_key: 'user:probe', enabled: true },
      }),
    })

    const { queryClient, wrapper } = makeHarness()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { useAttachAgentSkillMutation } = await import('./agentSkills')
    const { result } = renderHook(() => useAttachAgentSkillMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        agentId: 'agent-1',
        skillCanonicalKey: 'user:probe',
        enabled: true,
      })
    })

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['agent-skills', 'list', 'agent-1'] }),
    )
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['skills'] }),
    )
  })

  it('#8698 detach invalidates agent carry + skills catalog queries', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { skill_canonical_key: 'user:probe', found: true },
      }),
    })

    const { queryClient, wrapper } = makeHarness()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { useDetachAgentSkillMutation } = await import('./agentSkills')
    const { result } = renderHook(() => useDetachAgentSkillMutation(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        agentId: 'agent-1',
        skillCanonicalKey: 'user:probe',
        spaceId: 'space-1',
      })
    })

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['agent-skills', 'list', 'agent-1'] }),
    )
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['skills'] }),
    )
  })

  it('批量配置可延后 attach / detach 的逐条查询刷新', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { skill_canonical_key: 'user:probe', enabled: true, found: true },
      }),
    })

    const { queryClient, wrapper } = makeHarness()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const { useAttachAgentSkillMutation, useDetachAgentSkillMutation } = await import('./agentSkills')
    const { result: attach } = renderHook(() => useAttachAgentSkillMutation(), { wrapper })
    const { result: detach } = renderHook(() => useDetachAgentSkillMutation(), { wrapper })

    await act(async () => {
      await attach.current.mutateAsync({
        agentId: 'agent-1',
        skillCanonicalKey: 'user:probe',
        deferQueryInvalidation: true,
      })
      await detach.current.mutateAsync({
        agentId: 'agent-2',
        skillCanonicalKey: 'user:probe',
        deferQueryInvalidation: true,
      })
    })

    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})
