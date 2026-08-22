/**
 *  Wave1：createSubagentCompletionPayload 契约单测。
 */

import { describe, expect, it } from 'vitest'
import {
  createSubagentCompletionPayload,
  terminalStatusToLifecycle,
  SubagentCompletionEnvelopeSchema,
} from '../src/subagent-completion.js'

describe('createSubagentCompletionPayload', () => {
  it('strips empty deliverables and keeps required fields', () => {
    const envelope = createSubagentCompletionPayload({
      subagent_run_id: 'child-1',
      label: 'research',
      status: 'completed',
      summary: 'done',
      duration_ms: 1200,
      deliverables: [],
      step_count: 3,
      background: true,
      stats: { duration_ms: 1200, total_tokens: 40 },
    })

    expect(envelope).toEqual({
      subagent_run_id: 'child-1',
      label: 'research',
      status: 'completed',
      summary: 'done',
      duration_ms: 1200,
      step_count: 3,
      background: true,
      stats: { duration_ms: 1200, total_tokens: 40 },
    })
    expect(envelope).not.toHaveProperty('deliverables')
    expect(SubagentCompletionEnvelopeSchema.parse(envelope)).toEqual(envelope)
  })

  it('keeps non-empty deliverables', () => {
    const envelope = createSubagentCompletionPayload({
      subagent_run_id: 'child-2',
      label: 'write',
      status: 'failed',
      summary: 'boom',
      duration_ms: 10,
      error_kind: 'failed',
      deliverables: [{ kind: 'file', path: '/tmp/a' }],
    })
    expect(envelope.deliverables).toEqual([{ kind: 'file', path: '/tmp/a' }])
    expect(envelope.error_kind).toBe('failed')
  })
})

describe('terminalStatusToLifecycle', () => {
  it('maps timeout to failed for UI lifecycle', () => {
    expect(terminalStatusToLifecycle('timeout')).toBe('failed')
    expect(terminalStatusToLifecycle('cancelled')).toBe('cancelled')
    expect(terminalStatusToLifecycle('completed')).toBe('completed')
  })
})
