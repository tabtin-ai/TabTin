import { describe, expect, it } from 'vitest'
import type { ThreadOverviewMessage, Trace } from '@/types/agent-debug'
import {
  buildTraceUserPreviewMap,
  formatRuntimeLabel,
  formatTraceDuration,
  getExecutionRunSubtitle,
  getExecutionRunTitle,
  truncateRunPreview,
} from '../execution-run-labels'

function message(
  overrides: Partial<ThreadOverviewMessage> & Pick<ThreadOverviewMessage, 'role' | 'content'>
): ThreadOverviewMessage {
  return {
    id: 'm1',
    message_kind: 'llm',
    attachments: [],
    trace_id: null,
    agent_run_id: null,
    model_name: null,
    stop_reason: null,
    usage: null,
    error: null,
    subagent_run_id: null,
    created_at: '2026-08-03T09:00:00Z',
    ...overrides,
  }
}

function trace(overrides: Partial<Trace> & Pick<Trace, 'trace_id'>): Trace {
  return {
    id: 1,
    thread_id: 't1',
    session_id: 's1',
    user_id: null,
    graph_type: 'local-runtime',
    status: 'completed',
    started_at: '2026-08-03T09:21:00Z',
    ended_at: '2026-08-03T09:21:12Z',
    duration_ms: 12_000,
    error: null,
    metadata: null,
    ...overrides,
  }
}

describe('execution-run-labels', () => {
  it('截断用户话并生成回复标题', () => {
    expect(truncateRunPreview('生成一篇介绍小猫的文档并导出')).toBe('生成一篇介绍小猫的文档并导出')
    expect(
      truncateRunPreview('这是一段用来验证截断逻辑的非常非常非常非常长的用户输入内容')
    ).toContain('…')

    const map = buildTraceUserPreviewMap([
      message({ role: 'user', content: '你好', trace_id: 'tr-1' }),
      message({ role: 'assistant', content: '嗨', trace_id: 'tr-1' }),
    ])
    expect(getExecutionRunTitle(trace({ trace_id: 'tr-1' }), map)).toBe('回复「你好」')
    expect(getExecutionRunTitle(trace({ trace_id: 'tr-missing' }), map)).toBe('系统拉起 / 续跑')
  })

  it('助手有 trace、用户无 trace 时回看最近用户话', () => {
    const map = buildTraceUserPreviewMap([
      message({ role: 'user', content: '生成价格表 pdf', trace_id: null }),
      message({ role: 'assistant', content: '好的', trace_id: 'tr-2' }),
    ])
    expect(map.get('tr-2')).toBe('生成价格表 pdf')
  })

  it('副标题含时间、耗时与可读运行环境', () => {
    expect(formatRuntimeLabel('local-runtime')).toBe('本机运行')
    expect(formatTraceDuration(trace({ duration_ms: 12_000 }))).toBe('12.0 秒')
    expect(
      formatTraceDuration({
        ...trace({ trace_id: 'tr-run' }),
        status: 'running',
        ended_at: null,
        duration_ms: undefined,
      })
    ).toBe('进行中')
    expect(getExecutionRunSubtitle(trace({ trace_id: 'tr-1' }))).toContain('本机运行')
    expect(getExecutionRunSubtitle(trace({ trace_id: 'tr-1' }))).toContain('秒')
  })
})
