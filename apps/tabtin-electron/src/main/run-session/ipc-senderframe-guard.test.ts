/**
 * SD-018 回归测试 — run-session IPC senderFrame 防护
 *
 * 验证当前仍保留的 run-session 读取类 handler 已通过 guardedHandle
 * 挂上 isTrustedSender 校验。
 *
 * 测试策略：模拟 ipcMain.handle，验证注册时使用了内联 guardedHandle 包装，
 * 不受信任来源的调用被拒绝。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

const mocks = vi.hoisted(() => ({
  handleFn: vi.fn(),
  isTrustedSenderMock: vi.fn(),
  managerMock: {
    getEvents: vi.fn().mockReturnValue([]),
    getRun: vi.fn().mockReturnValue(null),
    listRuns: vi.fn().mockReturnValue([]),
    getRunStats: vi.fn().mockReturnValue({}),
    getStats: vi.fn().mockReturnValue({}),
    createRun: vi.fn().mockReturnValue({ runId: 'r-1', sessionId: 's-1' }),
    addObservation: vi.fn(),
    registerViewLocked: vi.fn(),
    setActiveView: vi.fn(),
    endRun: vi.fn(),
    openTab: vi.fn(),
    switchTab: vi.fn(),
    closeTab: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/app'),
  },
  ipcMain: {
    handle: mocks.handleFn,
    removeHandler: vi.fn(),
  },
}))

vi.mock('../auth', () => ({
  isTrustedSender: (...args: any[]) => mocks.isTrustedSenderMock(...args),
}))

vi.mock('./RunSessionManager', () => ({
  getRunSessionManager: () => mocks.managerMock,
}))

vi.mock('@tabtin/action-tools/tools', () => ({
  requestSnapshotTool: { execute: vi.fn() },
}))

import { registerRunSessionIpcHandlers } from './ipc'

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

describe('SD-018: run-session 读取类 handler senderFrame 防护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerRunSessionIpcHandlers()
  })

  const guardedChannels = ['run-session:get']

  for (const channel of guardedChannels) {
    describe(channel, () => {
      it('不受信任来源 → 应拒绝', async () => {
        mocks.isTrustedSenderMock.mockReturnValue(false)
        const handler = findHandler(channel)
        expect(handler).toBeDefined()

        const event = makeFakeEvent('https://evil.com/')
        const result = await handler!(event, 'test-run-id')

        // Wave 0 + W1 D3 contract: guardedHandle 改返 envelope，
        // 并自动 stamp per-call trace_id。用 toMatchObject 忽略 trace_id
        // 具体值（每次 generate 的 nanoid 不同）。
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized: untrusted origin',
            retryable: false,
          },
        })
        expect(result).toHaveProperty('trace_id')
      })

      it('受信任来源 → 应执行 handler', async () => {
        mocks.isTrustedSenderMock.mockReturnValue(true)
        const handler = findHandler(channel)
        expect(handler).toBeDefined()

        const event = makeFakeEvent('file:///app/index.html')
        const result = await handler!(event, 'test-run-id')

        expect(result).not.toEqual(
          expect.objectContaining({
            error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
          })
        )
      })
    })
  }
})
