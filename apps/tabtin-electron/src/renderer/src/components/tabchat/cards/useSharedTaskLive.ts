import { useCallback, useEffect, useMemo, useState } from 'react'
import { useGatewayTopic } from '@/hooks/useGatewayTopic'
import type {
  SessionShareInfo,
  SessionShareLiveDetail,
  SessionShareLiveStep,
} from '@/services/tabchatApi'

const MAX_RECENT_STEPS = 3
type SharedRunStatus = NonNullable<SessionShareLiveDetail['run_state']>['status']
export type SessionShareLiveSource = Pick<SessionShareInfo, 'id'>
  & Partial<Pick<SessionShareInfo, 'live' | 'actions' | 'access_epoch' | 'version'>>
const RUN_STATUSES = new Set<SharedRunStatus>([
  'queued',
  'running',
  'waiting_user',
  'paused',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

function isRunStatus(status: string): status is SharedRunStatus {
  return RUN_STATUSES.has(status as SharedRunStatus)
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function upsertStep(
  state: SessionShareLiveDetail,
  step: SessionShareLiveStep,
): SessionShareLiveDetail {
  const steps = state.recent_steps.filter(item => item.id !== step.id)
  steps.push(step)
  return {
    ...state,
    current_step: step.status === 'running'
      ? step
      : state.current_step?.id === step.id ? null : state.current_step,
    recent_steps: steps.slice(-MAX_RECENT_STEPS),
  }
}

export function reduceSharedTaskLive(
  state: SessionShareLiveDetail,
  envelope: Record<string, unknown>,
): SessionShareLiveDetail {
  const type = stringField(envelope.type)
  const payload = envelope.payload && typeof envelope.payload === 'object'
    ? envelope.payload as Record<string, unknown>
    : {}

  if (type === 'chat.session.run_state.updated') {
    const runState = payload.run_state && typeof payload.run_state === 'object'
      ? payload.run_state as Record<string, unknown>
      : null
    const status = stringField(runState?.status)
    if (!runState || !status || !isRunStatus(status)) return state
    const startedAt = stringField(runState.started_at)
    const stateChangedAt = stringField(runState.state_changed_at)
    const endedAt = stringField(runState.ended_at)
    const durationEnd = endedAt ?? (status === 'running' ? null : stateChangedAt)
    const durationMs = startedAt && durationEnd
      ? Math.max(0, Date.parse(durationEnd) - Date.parse(startedAt))
      : state.duration_ms
    return {
      ...state,
      run_state: {
        run_id: stringField(runState.run_id) ?? '',
        status,
        started_at: startedAt,
        state_changed_at: stateChangedAt,
        ended_at: endedAt,
        stop_reason: stringField(runState.stop_reason),
        error_class: stringField(runState.error_class),
      },
      duration_ms: Number.isFinite(durationMs) ? durationMs : state.duration_ms,
      current_step: status === 'running' ? state.current_step : null,
    }
  }

  if (type === 'agent.stream.lifecycle') {
    const phase = stringField(payload.phase)
    const startedAt = numberField(payload.started_at)
    const endedAt = numberField(payload.ended_at)
    const durationMs = numberField(payload.duration_ms)
    if (phase === 'start') {
      return {
        ...state,
        run_state: {
          run_id: stringField(payload.run_id) ?? '',
          status: 'running',
          started_at: startedAt === null ? new Date().toISOString() : new Date(startedAt).toISOString(),
          state_changed_at: startedAt === null ? new Date().toISOString() : new Date(startedAt).toISOString(),
          ended_at: null,
          stop_reason: null,
          error_class: null,
        },
        duration_ms: 0,
        current_step: null,
        recent_steps: [],
      }
    }
    if (phase === 'end' || phase === 'error' || phase === 'terminated') {
      const status = phase === 'end' ? 'completed' : phase === 'error' ? 'failed' : 'interrupted'
      return {
        ...state,
        run_state: state.run_state ? {
          ...state.run_state,
          status,
          state_changed_at: endedAt === null ? new Date().toISOString() : new Date(endedAt).toISOString(),
          ended_at: endedAt === null ? new Date().toISOString() : new Date(endedAt).toISOString(),
        } : null,
        duration_ms: durationMs ?? state.duration_ms,
        current_step: null,
      }
    }
  }

  if (type === 'agent.stream.step') {
    if (payload.step_type === 'thinking') return state
    const id = stringField(payload.step_id) ?? `${stringField(payload.run_id) ?? 'run'}:${state.step_count + 1}`
    return upsertStep(state, {
      id,
      title: stringField(payload.title) ?? '执行任务',
      status: payload.status === 'error' ? 'error' : payload.status === 'done' ? 'done' : 'running',
    })
  }

  if (type === 'agent.stream.content_block_start') {
    const block = payload.block && typeof payload.block === 'object'
      ? payload.block as Record<string, unknown>
      : null
    if (block?.type === 'tool_use') {
      const id = stringField(block.id) ?? stringField(payload.block_id) ?? `tool:${state.step_count + 1}`
      return upsertStep(state, {
        id,
        title: stringField(block.title) ?? stringField(block.name) ?? '执行任务',
        status: 'running',
      })
    }
    if (block?.type === 'tool_result') {
      const toolUseId = stringField(block.tool_use_id)
      if (!toolUseId) return state
      const matched = state.recent_steps.find(item => item.id === toolUseId)
      if (!matched) return state
      return upsertStep(state, { ...matched, status: block.is_error ? 'error' : 'done' })
    }
  }

  if (type === 'agent.stream.message_committed') {
    const runId = stringField(payload.run_id)
    if (
      payload.role !== 'assistant'
      || (stringField(payload.message_kind) ?? 'llm') !== 'llm'
      || (runId && state.run_state?.run_id && runId !== state.run_state.run_id)
    ) return state
    return { ...state, step_count: state.step_count + 1 }
  }

  return state
}

const EMPTY_LIVE: SessionShareLiveDetail = {
  run_state: null,
  duration_ms: null,
  step_count: 0,
  current_step: null,
  recent_steps: [],
  resources: [],
}

export function useSharedTaskLive(
  detail: SessionShareLiveSource | null,
  reload: () => void,
): SessionShareLiveDetail | null {
  const [live, setLive] = useState<SessionShareLiveDetail | null>(detail?.live ?? null)

  useEffect(() => {
    setLive(detail?.live ?? null)
  }, [detail?.live])

  const topic = useMemo(() => (
    detail?.actions?.can_open
      && detail.access_epoch
      && live?.run_state?.status === 'running'
      ? `session.collaboration.${detail.id}.${detail.access_epoch}`
      : null
  ), [detail?.access_epoch, detail?.actions?.can_open, detail?.id, live?.run_state?.status])

  const onEvent = useCallback((envelope: Record<string, unknown>) => {
    const payload = envelope.payload && typeof envelope.payload === 'object'
      ? envelope.payload as Record<string, unknown>
      : null
    if (payload?.collaboration_id !== detail?.id) return
    setLive(current => reduceSharedTaskLive(current ?? EMPTY_LIVE, envelope))
    if (envelope.type === 'agent.stream.message_committed' || envelope.type === 'agent.stream.done') {
      reload()
    }
  }, [detail?.id, reload])

  useGatewayTopic({
    topic,
    enabled: Boolean(topic),
    subscriptionKey: detail?.version ?? 0,
    onEvent,
    onReconnected: reload,
    logPrefix: 'SharedTaskLive',
  })

  return live
}
