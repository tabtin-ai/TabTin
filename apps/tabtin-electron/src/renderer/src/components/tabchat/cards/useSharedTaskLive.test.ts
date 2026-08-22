import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionShareLiveDetail } from '@/services/tabchatApi'
import { useGatewayTopic } from '@/hooks/useGatewayTopic'
import {
  reduceSharedTaskLive,
  type SessionShareLiveSource,
  useSharedTaskLive,
} from './useSharedTaskLive'

vi.mock('@/hooks/useGatewayTopic', () => ({ useGatewayTopic: vi.fn() }))

beforeEach(() => {
  vi.mocked(useGatewayTopic).mockClear()
})

const base: SessionShareLiveDetail = {
  run_state: null,
  duration_ms: null,
  step_count: 0,
  current_step: null,
  recent_steps: [],
  resources: [],
}

describe('reduceSharedTaskLive', () => {
  it('counts committed assistant messages without requiring a run id', () => {
    const running = reduceSharedTaskLive(base, {
      type: 'agent.stream.lifecycle',
      payload: { phase: 'start', run_id: 'run-1', started_at: 1_000 },
    })
    const withTurn = reduceSharedTaskLive(running, {
      type: 'agent.stream.message_committed',
      payload: {
        message_id: 'message-1',
        server_id: 'server-1',
        role: 'assistant',
      },
    })

    expect(withTurn.step_count).toBe(1)
  })

  it('keeps the task dialogue count when a new run starts', () => {
    const running = reduceSharedTaskLive({ ...base, step_count: 2 }, {
      type: 'agent.stream.lifecycle',
      payload: { phase: 'start', run_id: 'run-2', started_at: 1_000 },
    })

    expect(running.step_count).toBe(2)
  })

  it('does not count tool artifacts as dialogue turns', () => {
    const withArtifact = reduceSharedTaskLive(base, {
      type: 'agent.stream.message_committed',
      payload: { role: 'assistant', message_kind: 'tool_artifact' },
    })

    expect(withArtifact.step_count).toBe(0)
  })

  it('keeps the latest terminal state and progress after lifecycle end', () => {
    const running = reduceSharedTaskLive(base, {
      type: 'agent.stream.lifecycle',
      payload: { phase: 'start', run_id: 'run-1', started_at: 1_000 },
    })
    const withStep = reduceSharedTaskLive(running, {
      type: 'agent.stream.step',
      payload: { run_id: 'run-1', step_id: 'step-1', title: '读取资料', status: 'done' },
    })
    const withTurn = reduceSharedTaskLive(withStep, {
      type: 'agent.stream.message_committed',
      payload: { role: 'assistant', run_id: 'run-1' },
    })
    const completed = reduceSharedTaskLive(withTurn, {
      type: 'agent.stream.lifecycle',
      payload: { phase: 'end', ended_at: 241_000, duration_ms: 240_000 },
    })

    expect(completed.run_state?.status).toBe('completed')
    expect(completed.duration_ms).toBe(240_000)
    expect(completed.step_count).toBe(1)
    expect(completed.recent_steps[0]?.title).toBe('读取资料')
  })

  it('uses authoritative run-state updates and keeps the last terminal snapshot', () => {
    const paused = reduceSharedTaskLive(base, {
      type: 'chat.session.run_state.updated',
      payload: {
        run_state: {
          run_id: 'run-1',
          status: 'paused',
          started_at: '2026-08-13T02:00:00.000Z',
          state_changed_at: '2026-08-13T02:03:00.000Z',
          ended_at: null,
        },
      },
    })
    expect(paused.run_state?.status).toBe('paused')
    expect(paused.duration_ms).toBe(180_000)

    const completed = reduceSharedTaskLive({
      ...paused,
      step_count: 2,
      recent_steps: [{ id: 'tool-1', title: '读取文件', status: 'done' }],
    }, {
      type: 'chat.session.run_state.updated',
      payload: {
        run_state: {
          run_id: 'run-1',
          status: 'completed',
          started_at: '2026-08-13T02:00:00.000Z',
          state_changed_at: '2026-08-13T02:04:00.000Z',
          ended_at: '2026-08-13T02:04:00.000Z',
        },
      },
    })
    expect(completed).toMatchObject({
      duration_ms: 240_000,
      step_count: 2,
      recent_steps: [{ id: 'tool-1', title: '读取文件', status: 'done' }],
      run_state: { status: 'completed' },
    })
  })
})

describe('useSharedTaskLive', () => {
  it('accepts a partial store projection without subscribing', () => {
    const detail: SessionShareLiveSource = { id: 'share-1' }
    const reload = vi.fn()

    const { result } = renderHook(() => useSharedTaskLive(detail, reload))

    expect(result.current).toBeNull()
    expect(useGatewayTopic).toHaveBeenCalledWith(expect.objectContaining({
      topic: null,
      enabled: false,
      subscriptionKey: 0,
    }))
  })

  it('does not subscribe when the shared task is not running', () => {
    const detail: SessionShareLiveSource = {
      id: 'share-1',
      actions: {
        can_join: true,
        can_open: true,
        can_stop: false,
        can_restore: false,
        can_change_access: false,
      },
      access_epoch: 1,
      version: 3,
      live: {
        ...base,
        run_state: { status: 'completed' },
      },
    }

    const { result } = renderHook(() => useSharedTaskLive(detail, vi.fn()))

    expect(result.current).toEqual(detail.live)
    expect(useGatewayTopic).toHaveBeenLastCalledWith(expect.objectContaining({
      topic: null,
      enabled: false,
    }))
  })

  it('subscribes after the full detail reports a running task', () => {
    const reload = vi.fn()
    const { rerender } = renderHook(
      ({ detail }: { detail: SessionShareLiveSource }) => useSharedTaskLive(detail, reload),
      { initialProps: { detail: { id: 'share-1' } } },
    )

    rerender({
      detail: {
        id: 'share-1',
        actions: {
          can_join: true,
          can_open: true,
          can_stop: false,
          can_restore: false,
          can_change_access: false,
        },
        access_epoch: 1,
        version: 3,
        live: {
          ...base,
          run_state: { status: 'running' },
        },
      },
    })

    expect(useGatewayTopic).toHaveBeenLastCalledWith(expect.objectContaining({
      topic: 'session.collaboration.share-1.1',
      enabled: true,
      subscriptionKey: 3,
    }))
  })

  it('ignores runtime events projected for another shared task', () => {
    const detail: SessionShareLiveSource = {
      id: 'share-1',
      actions: {
        can_join: true,
        can_open: true,
        can_stop: false,
        can_restore: false,
        can_change_access: false,
      },
      access_epoch: 1,
      version: 3,
      live: {
        ...base,
        step_count: 4,
        duration_ms: 12_000,
        run_state: { status: 'running', run_id: 'share-1-run' },
      },
    }
    const { result } = renderHook(() => useSharedTaskLive(detail, vi.fn()))
    const onEvent = vi.mocked(useGatewayTopic).mock.calls.at(-1)?.[0].onEvent

    act(() => {
      onEvent?.({
        type: 'agent.stream.lifecycle',
        payload: {
          collaboration_id: 'share-2',
          phase: 'start',
          run_id: 'other-run',
          started_at: 20_000,
        },
      })
    })

    expect(result.current).toMatchObject({
      step_count: 4,
      duration_ms: 12_000,
      run_state: { status: 'running', run_id: 'share-1-run' },
    })

    act(() => {
      onEvent?.({
        type: 'agent.stream.lifecycle',
        payload: {
          collaboration_id: 'share-1',
          phase: 'start',
          run_id: 'current-run',
          started_at: 30_000,
        },
      })
    })

    expect(result.current).toMatchObject({
      step_count: 4,
      duration_ms: 0,
      run_state: { status: 'running', run_id: 'current-run' },
    })
  })
})
