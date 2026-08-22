import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackerTask } from '@/services/trackerApi'

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  listTasks: vi.fn(),
  subscriptions: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/services/trackerApi', () => ({
  getTask: (...args: unknown[]) => mocks.getTask(...args),
  listTasks: (...args: unknown[]) => mocks.listTasks(...args),
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('@/stores/sessionResetRegistry', () => ({
  registerResetAction: () => () => {},
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      spaces: [{ id: 'space-1', organization_id: 'organization-1' }],
    }),
  },
}))

vi.mock('@hooks/useTrackerEventStream', () => ({
  useTrackerEventStream: (options: Record<string, unknown>) => {
    mocks.subscriptions.push(options)
  },
}))

import { TrackerSpaceStreams } from './TrackerSpaceStreams'
import { useTrackerListState, useTrackerStore } from '@/stores/useTrackerStore'

const ORGANIZATION_ID = 'organization-1'
const SPACE_ID = 'space-1'

function makeTask(id: string, name: string): TrackerTask {
  return {
    id,
    name,
    description: '',
    space_id: SPACE_ID,
    status: 'active',
    trigger_type: 'cron',
    trigger_config: {},
    skill_key: 'test-skill',
    skill_params: {},
    agent_id: null,
    next_run_at: null,
    last_run_at: null,
    created_at: '2026-08-15T00:00:00Z',
    updated_at: '2026-08-15T00:00:00Z',
    total_runs: 0,
    success_runs: 0,
    fail_runs: 0,
    has_active_run: false,
  }
}

function resetTrackerStore(): void {
  useTrackerStore.setState({
    tasks: [],
    isLoading: false,
    loadError: false,
    hasMore: false,
    currentPage: 1,
    _organizationId: null,
    _spaceId: null,
    _listOptions: undefined,
    _listRequestSeq: 0,
    _inflightKey: null,
    _lastFailedKey: null,
    _lastFailedAt: 0,
    _lastFailedCooldownMs: 0,
    _listsByKey: {},
    _inflightKeys: {},
  })
}

async function primeSidebar(tasks: TrackerTask[]): Promise<void> {
  mocks.listTasks.mockResolvedValueOnce({
    tasks,
    hasMore: false,
    page: 1,
    pageSize: 200,
    total: tasks.length,
  })
  await useTrackerStore.getState().loadTasks(ORGANIZATION_ID, SPACE_ID)
}

function SidebarTrackerNames() {
  const { tasks } = useTrackerListState(ORGANIZATION_ID, SPACE_ID)
  return <>{tasks.map(task => <span key={task.id}>{task.name}</span>)}</>
}

function renderGlobalStreamAndSidebar() {
  render(
    <>
      <TrackerSpaceStreams spaceIds={[SPACE_ID]} enabled handlers={{}} />
      <SidebarTrackerNames />
    </>,
  )
  return mocks.subscriptions[0]
}

describe('TrackerSpaceStreams 自动化侧栏 CRUD 同步', () => {
  beforeEach(() => {
    mocks.getTask.mockReset()
    mocks.listTasks.mockReset()
    mocks.subscriptions.length = 0
    resetTrackerStore()
  })

  it('Agent 创建任务事件到达全局订阅后，侧栏出现新任务', async () => {
    await primeSidebar([])
    mocks.getTask.mockResolvedValueOnce(makeTask('tracker-1', 'Agent 新建任务'))
    const subscription = renderGlobalStreamAndSidebar()

    act(() => {
      const onCreated = subscription.onTrackerCreated as ((payload: { tracker_id: string }) => void) | undefined
      onCreated?.({ tracker_id: 'tracker-1' })
    })

    expect(await screen.findByText('Agent 新建任务')).toBeTruthy()
  })

  it('Agent 更新任务事件到达全局订阅后，侧栏更新任务名称', async () => {
    await primeSidebar([makeTask('tracker-1', '旧任务名')])
    mocks.getTask.mockResolvedValueOnce(makeTask('tracker-1', '新任务名'))
    const subscription = renderGlobalStreamAndSidebar()

    act(() => {
      const onUpdated = subscription.onTrackerUpdated as ((payload: { tracker_id: string }) => void) | undefined
      onUpdated?.({ tracker_id: 'tracker-1' })
    })

    expect(await screen.findByText('新任务名')).toBeTruthy()
    expect(screen.queryByText('旧任务名')).toBeNull()
  })

  it('全局订阅会接上 running 进度，供侧栏刷新执行记录', () => {
    render(
      <TrackerSpaceStreams
        spaceIds={[SPACE_ID]}
        enabled
        handlers={{ onProgress: vi.fn() }}
      />,
    )
    const subscription = mocks.subscriptions[0]
    expect(typeof subscription.onProgress).toBe('function')
  })

  it('Agent 删除任务事件到达全局订阅后，侧栏移除任务', async () => {
    await primeSidebar([makeTask('tracker-1', '待删除任务')])
    const subscription = renderGlobalStreamAndSidebar()

    act(() => {
      const onDeleted = subscription.onTrackerDeleted as ((payload: { tracker_id: string }) => void) | undefined
      onDeleted?.({ tracker_id: 'tracker-1' })
    })

    expect(screen.queryByText('待删除任务')).toBeNull()
  })
})
