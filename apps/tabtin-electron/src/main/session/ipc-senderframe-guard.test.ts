/**
 * SD-022 回归测试 — session IPC senderFrame 防护
 *
 * 验证 session:setCurrentTrace / addTrace / updateTraceStatus
 * 已从裸 ipcMain.handle 改为 guardedHandle（带 isTrustedSender 校验）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

const mocks = vi.hoisted(() => ({
  handleFn: vi.fn(),
  isTrustedSenderMock: vi.fn(),
  managerMock: {
    createSession: vi.fn().mockReturnValue({ sessionId: 's-1' }),
    getSession: vi.fn().mockReturnValue(null),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn().mockReturnValue(true),
    setCurrentTrace: vi.fn(),
    addTrace: vi.fn(),
    updateTraceStatus: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handleFn,
    removeHandler: vi.fn(),
  },
}))

vi.mock('../auth', () => ({
  isTrustedSender: (...args: any[]) => mocks.isTrustedSenderMock(...args),
}))

vi.mock('./SessionManager', () => ({
  getSessionManager: () => mocks.managerMock,
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// Wave 0 contract: guardedHandle 返 envelope 形状（{ ok, error.code/message }）。
const REJECT_RESPONSE = {
  ok: false,
  error: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
} as const

vi.mock('../utils/guarded-handle', () => ({
  guardedHandle: (channel: string, listener: (...args: any[]) => any) => {
    mocks.handleFn(channel, async (event: any, ...args: any[]) => {
      if (!mocks.isTrustedSenderMock(event)) {
        return REJECT_RESPONSE
      }
      return listener(event, ...args)
    })
  },
}))

import { registerSessionIpcHandlers } from './ipc'

function makeFakeEvent(url: string | undefined): IpcMainInvokeEvent {
  return {
    senderFrame: url ? { url } : undefined,
    sender: { id: 1 },
  } as unknown as IpcMainInvokeEvent
}

function findHandler(channel: string): Function | undefined {
  const call = mocks.handleFn.mock.calls.find((c: any[]) => c[0] === channel)
  return call ? call[1] : undefined
}

describe('SD-022: session 写操作 handler senderFrame 防护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerSessionIpcHandlers()
  })

  const guardedChannels = [
    'session:setCurrentTrace',
    'session:addTrace',
    'session:updateTraceStatus',
  ]

  for (const channel of guardedChannels) {
    describe(channel, () => {
      it('不受信任来源 → 应拒绝', async () => {
        mocks.isTrustedSenderMock.mockReturnValue(false)
        const handler = findHandler(channel)
        expect(handler).toBeDefined()

        const event = makeFakeEvent('https://evil.com/')
        const result = await handler!(event, 'session-1', 'trace-1', 'running')

        expect(result).toEqual(REJECT_RESPONSE)
      })

      it('受信任来源 → 应执行并返回成功', async () => {
        mocks.isTrustedSenderMock.mockReturnValue(true)
        const handler = findHandler(channel)
        expect(handler).toBeDefined()

        const event = makeFakeEvent('file:///app/index.html')
        const result = await handler!(event, 'session-1', 'trace-1', 'running')

        expect(result).toEqual({ success: true })
      })
    })
  }
})
