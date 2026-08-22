/**
 * LH2-A1（H3-C）：SubagentTracesSection 的纯函数 `extractSubagentSummaries` 单测。
 *
 * **当前 admindash 包未启用 vitest**——本文件作为"协议契约 + 设计意图"的
 * 文档化种子，未来 admindash 接入 vitest 后可一键纳入回归套件。
 *
 * 测试不涉及 React render，只验证从 trace events 提取子 Agent 概览的纯逻辑：
 *   - 仅当 event payload 含 `child_trace_id` 才返回卡片（避免旧 trace 渲染坏链接）
 *   - SUBAGENT_STARTED 提供 task / label，COMPLETED → completed，FAILED → failed
 *   - 多 subagent 共存时按 subagent_run_id 分别聚合
 */

import { describe, expect, it } from 'vitest'
import { __test__ } from '../subagent-traces-section'
import type { Event } from '@/types/agent-debug'

const { extractSubagentSummaries } = __test__

function makeEvent(overrides: Partial<Event> & { input?: Record<string, unknown> }): Event {
  const now = '2026-04-17T00:00:00Z'
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2, 8)}`,
    trace_id: overrides.trace_id ?? 'parent-trace',
    parent_event_id: null,
    seq: overrides.seq ?? 0,
    event_type: overrides.event_type ?? 'tool',
    name: overrides.name ?? 'tool',
    started_at: now,
    ended_at: now,
    duration_ms: 0,
    input: overrides.input ?? null,
    output: null,
    error: null,
    usage: null,
    ...overrides,
  } as Event
}

describe('extractSubagentSummaries', () => {
  it('returns empty when no subagent events', () => {
    const events: Event[] = [
      makeEvent({ seq: 1, event_type: 'tool', name: 'bash' }),
      makeEvent({ seq: 2, event_type: 'lifecycle', name: 'start' }),
    ]
    expect(extractSubagentSummaries(events)).toEqual([])
  })

  it('skips subagent events without child_trace_id (旧 trace)', () => {
    const events: Event[] = [
      makeEvent({
        seq: 1,
        event_type: 'subagent_started',
        name: 'started',
        input: {
          subagent_run_id: 'run-1',
          task: 'analyze',
          label: 'analysis',
          // no child_trace_id
        },
      }),
    ]
    expect(extractSubagentSummaries(events)).toEqual([])
  })

  it('builds summary from STARTED + PROGRESS + COMPLETED', () => {
    const events: Event[] = [
      makeEvent({
        seq: 1,
        event_type: 'subagent_started',
        name: 'started',
        input: {
          subagent_run_id: 'run-1',
          task: 'analyze module X',
          label: 'X analysis',
        },
      }),
      makeEvent({
        seq: 2,
        event_type: 'subagent_progress',
        name: 'progress',
        input: {
          subagent_run_id: 'run-1',
          step_count: 3,
          child_trace_id: 'child-uuid-1',
        },
      }),
      makeEvent({
        seq: 3,
        event_type: 'subagent_completed',
        name: 'completed',
        input: {
          subagent_run_id: 'run-1',
          child_trace_id: 'child-uuid-1',
          summary: 'done',
        },
      }),
    ]
    const out = extractSubagentSummaries(events)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      childTraceId: 'child-uuid-1',
      label: 'X analysis',
      taskPreview: 'analyze module X',
      status: 'completed',
      subagentRunId: 'run-1',
      stepCount: 3,
    })
  })

  it('FAILED → status=failed', () => {
    const events: Event[] = [
      makeEvent({
        seq: 1,
        event_type: 'subagent_started',
        name: 'started',
        input: {
          subagent_run_id: 'run-fail',
          task: 't',
        },
      }),
      makeEvent({
        seq: 2,
        event_type: 'subagent_failed',
        name: 'failed',
        input: {
          subagent_run_id: 'run-fail',
          child_trace_id: 'child-fail',
          error: 'crash',
        },
      }),
    ]
    const out = extractSubagentSummaries(events)
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('failed')
  })

  it('STARTED but no terminal event → status=running', () => {
    const events: Event[] = [
      makeEvent({
        seq: 1,
        event_type: 'subagent_started',
        name: 'started',
        input: {
          subagent_run_id: 'run-running',
          task: 't',
        },
      }),
      makeEvent({
        seq: 2,
        event_type: 'subagent_progress',
        name: 'progress',
        input: {
          subagent_run_id: 'run-running',
          step_count: 1,
          child_trace_id: 'child-running',
        },
      }),
    ]
    const out = extractSubagentSummaries(events)
    expect(out[0].status).toBe('running')
  })

  it('multiple sub-agents are grouped by subagent_run_id', () => {
    const events: Event[] = [
      makeEvent({
        seq: 1,
        event_type: 'subagent_started',
        name: 'started',
        input: { subagent_run_id: 'a', task: 'A', child_trace_id: 'child-a' },
      }),
      makeEvent({
        seq: 2,
        event_type: 'subagent_started',
        name: 'started',
        input: { subagent_run_id: 'b', task: 'B', child_trace_id: 'child-b' },
      }),
      makeEvent({
        seq: 3,
        event_type: 'subagent_completed',
        name: 'completed',
        input: { subagent_run_id: 'a', child_trace_id: 'child-a' },
      }),
    ]
    const out = extractSubagentSummaries(events)
    expect(out).toHaveLength(2)
    const a = out.find((s) => s.subagentRunId === 'a')!
    const b = out.find((s) => s.subagentRunId === 'b')!
    expect(a.status).toBe('completed')
    expect(b.status).toBe('running')
  })
})
