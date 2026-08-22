import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECKPOINT_CREATED_EVENT,
  emitCheckpointCreated,
  onCheckpointCreated,
} from './checkpointEvents'

describe('checkpointEvents', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  it('notifies subscribers when a checkpoint is created', () => {
    const handler = vi.fn()
    cleanups.push(onCheckpointCreated(handler))

    emitCheckpointCreated({
      spacePath: 'C:/work/project',
      commitHash: 'abc123',
      spaceId: 'space-1',
      sessionId: 'session-1',
      messageId: 'message-1',
    })

    expect(handler).toHaveBeenCalledWith({
      spacePath: 'C:/work/project',
      commitHash: 'abc123',
      spaceId: 'space-1',
      sessionId: 'session-1',
      messageId: 'message-1',
    })
  })

  it('ignores unrelated or incomplete browser events', () => {
    const handler = vi.fn()
    cleanups.push(onCheckpointCreated(handler))

    window.dispatchEvent(new Event(CHECKPOINT_CREATED_EVENT))
    window.dispatchEvent(new CustomEvent(CHECKPOINT_CREATED_EVENT, {
      detail: { spacePath: 'C:/work/project' },
    }))

    expect(handler).not.toHaveBeenCalled()
  })
})
