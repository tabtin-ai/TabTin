import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetActiveRunBindingsForTest,
  bindActiveRun,
  clearInterruptedBinding,
  getActiveRunBinding,
  noteAbortedRunId,
  snapshotInterruptedBinding,
} from '../activeRunBinding'

afterEach(() => {
  __resetActiveRunBindingsForTest()
})

describe('activeRunBinding ', () => {
  it('message_start 绑定 run + assistant；新 turn 不覆盖 interrupted 快照', () => {
    bindActiveRun('sess', { runId: 'run-a', assistantMessageId: 'msg-a' })
    const snap = snapshotInterruptedBinding('sess')
    expect(snap).toEqual({ runId: 'run-a', messageId: 'msg-a' })

    bindActiveRun('sess', { runId: 'run-b', assistantMessageId: 'msg-b' })
    const binding = getActiveRunBinding('sess')
    expect(binding.runId).toBe('run-b')
    expect(binding.activeAssistantMessageId).toBe('msg-b')
    expect(binding.interrupted).toEqual({ runId: 'run-a', messageId: 'msg-a' })
  })

  it('Host abortedRunId 补全快照', () => {
    bindActiveRun('sess', { runId: 'run-a', assistantMessageId: 'msg-a' })
    noteAbortedRunId('sess', 'run-a')
    expect(getActiveRunBinding('sess').interrupted).toEqual({
      runId: 'run-a',
      messageId: 'msg-a',
    })
  })

  it('clearInterruptedBinding 按 runId 收口', () => {
    bindActiveRun('sess', { runId: 'run-a', assistantMessageId: 'msg-a' })
    snapshotInterruptedBinding('sess')
    bindActiveRun('sess', { runId: 'run-b', assistantMessageId: 'msg-b' })
    clearInterruptedBinding('sess', 'run-other')
    expect(getActiveRunBinding('sess').interrupted?.runId).toBe('run-a')
    clearInterruptedBinding('sess', 'run-a')
    expect(getActiveRunBinding('sess').interrupted).toBeNull()
    expect(getActiveRunBinding('sess').runId).toBe('run-b')
  })
})
