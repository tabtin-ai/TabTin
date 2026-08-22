import { describe, expect, it } from 'vitest'
import { resolveUserSendStatusOnSendRejection } from '../messageStatusUpdates'

describe('resolveUserSendStatusOnSendRejection · ', () => {
  it('abort → sent（不标发送失败）', () => {
    const err = new Error('The user aborted a request.')
    err.name = 'AbortError'
    expect(resolveUserSendStatusOnSendRejection(err, false)).toBe('sent')
  })

  it('IpcStreamAbortedError → sent', () => {
    const err = new Error('IpcStream session x aborted')
    err.name = 'IpcStreamAbortedError'
    expect(resolveUserSendStatusOnSendRejection(err, false)).toBe('sent')
  })

  it('已送达后的真错误 → sent', () => {
    expect(resolveUserSendStatusOnSendRejection(new Error('boom'), true)).toBe('sent')
  })

  it('未送达的真错误 → failed', () => {
    expect(resolveUserSendStatusOnSendRejection(new Error('remote stream error'), false)).toBe('failed')
  })

  it('文案含 abort 的普通错误不算取消', () => {
    expect(
      resolveUserSendStatusOnSendRejection(new Error('PTY connection aborted by remote host'), false),
    ).toBe('failed')
  })
})
