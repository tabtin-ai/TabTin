import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentWorkbenchActivity } from '@/services/agentWorkbenchActivities'
import { AgentRecentActivitiesPanel } from './AgentRecentActivitiesPanel'

const fetchAgentWorkbenchActivities = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@/services/agentWorkbenchActivities', () => ({
  activityRowKey: (activity: { kind: string; session?: { id: string }; task?: { id: string } }) =>
    activity.kind === 'chat' ? `chat:${activity.session?.id}` : `project:${activity.task?.id}`,
  fetchAgentWorkbenchActivities: (...args: unknown[]) => fetchAgentWorkbenchActivities(...args),
}))

vi.mock('@/services/openAgentWorkbenchActivity', () => ({
  openAgentWorkbenchActivity: vi.fn(),
}))

vi.mock('@components/settings/panels/MyAgentsPanel', () => ({
  formatAgentRelativeTime: () => '刚刚',
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function chatActivity(title: string): AgentWorkbenchActivity {
  return {
    kind: 'chat',
    session: {
      id: title,
      title,
      status: 'active',
      organization_id: title,
      agent_id: 'agent-1',
      message_count: 1,
      updated_at: '2026-08-14T00:00:00.000Z',
    },
  }
}

describe('AgentRecentActivitiesPanel', () => {
  beforeEach(() => {
    fetchAgentWorkbenchActivities.mockReset()
  })

  it('组织切换后忽略旧请求的成功结果', async () => {
    const requestA = createDeferred<AgentWorkbenchActivity[]>()
    const requestB = createDeferred<AgentWorkbenchActivity[]>()
    fetchAgentWorkbenchActivities
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise)

    const view = render(
      <AgentRecentActivitiesPanel organizationId="org-a" agentId="agent-1" />,
    )
    await waitFor(() => {
      expect(fetchAgentWorkbenchActivities).toHaveBeenCalledWith({
        organizationId: 'org-a',
        agentId: 'agent-1',
        limit: 20,
      })
    })

    view.rerender(<AgentRecentActivitiesPanel organizationId="org-b" agentId="agent-1" />)
    expect(screen.getByText('正在加载任务…')).toBeTruthy()
    await waitFor(() => {
      expect(fetchAgentWorkbenchActivities).toHaveBeenLastCalledWith({
        organizationId: 'org-b',
        agentId: 'agent-1',
        limit: 20,
      })
    })

    await act(async () => {
      requestB.resolve([chatActivity('组织 B 任务')])
      await requestB.promise
    })
    expect(screen.getByText('组织 B 任务')).toBeTruthy()

    await act(async () => {
      requestA.resolve([chatActivity('组织 A 任务')])
      await requestA.promise
    })
    expect(screen.getByText('组织 B 任务')).toBeTruthy()
    expect(screen.queryByText('组织 A 任务')).toBeNull()
  })

  it('组织切换后忽略旧请求的失败结果', async () => {
    const requestA = createDeferred<AgentWorkbenchActivity[]>()
    const requestB = createDeferred<AgentWorkbenchActivity[]>()
    fetchAgentWorkbenchActivities
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise)

    const view = render(
      <AgentRecentActivitiesPanel organizationId="org-a" agentId="agent-1" />,
    )
    await waitFor(() => expect(fetchAgentWorkbenchActivities).toHaveBeenCalledTimes(1))

    view.rerender(<AgentRecentActivitiesPanel organizationId="org-b" agentId="agent-1" />)
    await waitFor(() => expect(fetchAgentWorkbenchActivities).toHaveBeenCalledTimes(2))

    await act(async () => {
      requestB.resolve([chatActivity('组织 B 任务')])
      await requestB.promise
    })

    await act(async () => {
      requestA.reject(new Error('org-a request failed'))
      await Promise.resolve()
    })
    expect(screen.getByText('组织 B 任务')).toBeTruthy()
    expect(screen.queryByText('任务列表加载失败')).toBeNull()
  })
})
