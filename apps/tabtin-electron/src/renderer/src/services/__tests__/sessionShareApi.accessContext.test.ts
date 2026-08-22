import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiRequestMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: apiRequestMock,
  getAuthToken: vi.fn().mockResolvedValue('token'),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import {
  getSharedExecutionStatus,
  sharedCollaborationChat,
  sharedChat,
  sharedFilePreview,
} from '../sessionShareApi'

describe('sessionShareApi exact share access context', () => {
  beforeEach(() => {
    apiRequestMock.mockReset()
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, message: '', code: 0, data: {} },
    })
  })

  it('binds every shared capability request to the current share id', async () => {
    await getSharedExecutionStatus('session-1', 'share / 1')
    await sharedChat('session-1', 'share-1', '继续执行')
    await sharedFilePreview('session-1', 'artifacts/report.pdf', 'share-1')

    expect(String(apiRequestMock.mock.calls[0][0].url)).toContain(
      '/chat/sessions/session-1/shared-execution-status?share_id=share%20%2F%201',
    )
    expect(JSON.parse(apiRequestMock.mock.calls[1][0].body)).toEqual({
      text: '继续执行',
      share_id: 'share-1',
    })
    expect(JSON.parse(apiRequestMock.mock.calls[2][0].body)).toEqual({
      path: 'artifacts/report.pdf',
      share_id: 'share-1',
      timeout_seconds: 25,
    })
  })

  it('sends v2 collaboration messages through the Gateway with version and epoch', async () => {
    const gatewaySend = vi.fn().mockResolvedValue({
      ok: true,
      type: 'chat.send_message.ok',
      payload: { message_id: 'message-1', trace_id: 'trace-1' },
    })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { agentEngine: { gatewaySend } },
    })

    await expect(sharedCollaborationChat(
      'session-1',
      'share-1',
      4,
      2,
      '继续执行',
    )).resolves.toMatchObject({ message_id: 'message-1', error_category: null })

    expect(gatewaySend).toHaveBeenCalledWith({
      messageType: 'chat.send_message',
      payload: expect.objectContaining({
        session_id: 'session-1',
        message: '继续执行',
        collaboration_id: 'share-1',
        collaboration_version: 4,
        access_epoch: 2,
        client_event_id: expect.any(String),
      }),
    })
  })
})
