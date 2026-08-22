import { describe, expect, it } from 'vitest'
import {
  classifySessionReadResponse,
  mergeSessionReadOutboxEntry,
  type SessionReadOutboxEntry,
} from './sessionReadReceipt'

const entry = (
  sequence: number,
  revision: number,
  mutationId: string,
): SessionReadOutboxEntry => ({
  sessionId: 'session-1',
  throughRunId: `run-${sequence}`,
  throughRunSequence: sequence,
  throughRevision: revision,
  mutationId,
})

describe('sessionReadReceipt outbox', () => {
  it('同一会话离线期间只保留最大的读游标', () => {
    expect(mergeSessionReadOutboxEntry(entry(4, 8, 'new'), entry(3, 99, 'old')).mutationId)
      .toBe('new')
    expect(mergeSessionReadOutboxEntry(entry(4, 8, 'old'), entry(4, 9, 'new')).mutationId)
      .toBe('new')
  })

  it('仅网络和 5xx 重试，4xx 永久收敛', () => {
    expect(classifySessionReadResponse(undefined)).toBe('retry')
    expect(classifySessionReadResponse(503)).toBe('retry')
    expect(classifySessionReadResponse(409)).toBe('permanent')
    expect(classifySessionReadResponse(404)).toBe('permanent')
    expect(classifySessionReadResponse(429)).toBe('permanent')
    expect(classifySessionReadResponse(200)).toBe('success')
  })
})
