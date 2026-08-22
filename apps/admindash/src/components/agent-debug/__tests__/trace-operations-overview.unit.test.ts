import { describe, expect, it } from 'vitest'
import type { Event, Trace } from '@/types/agent-debug'
import { getKeyProcessStepMeta } from '../trace-operations-overview'

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    trace_id: 'tr-1',
    parent_event_id: null,
    seq: 1,
    event_type: 'node',
    name: 'user_message',
    started_at: '2026-08-03T06:26:04.000Z',
    ended_at: null,
    duration_ms: null,
    input: null,
    output: null,
    error: null,
    usage: null,
    ...overrides,
  }
}

describe('getKeyProcessStepMeta', () => {
  it('有 duration_ms 时显示耗时', () => {
    expect(getKeyProcessStepMeta(makeEvent({ duration_ms: 1500 }), 'completed')).toBe('1.5 秒')
  })

  it('整轮仍在跑且步骤无结束信息时显示尚未结束', () => {
    expect(getKeyProcessStepMeta(makeEvent(), 'running')).toBe('尚未结束')
  })

  it('整轮已完成但步骤无 duration 时不误标尚未结束', () => {
    expect(getKeyProcessStepMeta(makeEvent(), 'completed')).toBe('无单独耗时')
    expect(getKeyProcessStepMeta(makeEvent(), 'error')).toBe('无单独耗时')
  })

  it('有 ended_at 时可从时间戳推算耗时', () => {
    const label = getKeyProcessStepMeta(
      makeEvent({
        started_at: '2026-08-03T06:26:04.000Z',
        ended_at: '2026-08-03T06:26:06.500Z',
        duration_ms: null,
      }),
      'completed' satisfies Trace['status']
    )
    expect(label).toBe('2.5 秒')
  })
})
