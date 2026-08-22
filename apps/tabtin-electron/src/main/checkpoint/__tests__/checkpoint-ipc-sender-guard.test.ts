/**
 * IES-001 回归测试 — checkpoint IPC senderFrame 防护
 *
 * 验证 checkpoint:init / commit / initial / restore / diff / gc / destroy
 * 已从裸 ipcMain.handle 改为 guardedHandle（带 isTrustedSender 校验），
 * 不受信任来源的调用被直接拒绝。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

const mocks = vi.hoisted(() => ({
  handleFn: vi.fn(),
  isTrustedSenderMock: vi.fn(),
  serviceMock: {
    init: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue('abc123'),
    getInitialCommitHash: vi.fn().mockResolvedValue('root000'),
    restore: vi.fn().mockResolvedValue(undefined),
    getDiff: vi.fn().mockResolvedValue([]),
    gc: vi.fn().mockResolvedValue(undefined),
  },
  destroyMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test' },
  ipcMain: {
    handle: mocks.handleFn,
    removeHandler: vi.fn(),
  },
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

vi.mock('../../auth', () => ({
  isTrustedSender: (...args: any[]) => mocks.isTrustedSenderMock(...args),
}))

vi.mock('../auth', () => ({
  isTrustedSender: (...args: any[]) => mocks.isTrustedSenderMock(...args),
}))

// 路径权限治理 Wave 2：checkpoint IPC 接 path-access-checker 替代老
// isProjectPathSafe / isPathSafe。本测试关注 senderFrame 防护，权限默认放行。
vi.mock('../../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: vi.fn(() => ({ allowed: true })),
  }),
}))

vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: vi.fn(() => ({ allowed: true })),
  }),
}))

vi.mock('../CheckpointService', () => ({
  getCheckpointService: () => mocks.serviceMock,
  destroyCheckpointService: (...args: any[]) => mocks.destroyMock(...args),
}))

// Wave 0 contract: guardedHandle 拒绝路径返 envelope 形状（{ ok, error.code, ... }）。
const REJECT_RESPONSE = {
  ok: false,
  error: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
} as const

vi.mock('../../utils/guarded-handle', () => ({
  guardedHandle: (channel: string, listener: (...args: any[]) => any) => {
    mocks.handleFn(channel, async (event: any, ...args: any[]) => {
      if (!mocks.isTrustedSenderMock(event)) {
        return REJECT_RESPONSE
      }
      return listener(event, ...args)
    })
  },
}))

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

import { registerCheckpointIpcHandlers } from '../checkpoint-ipc'

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

describe('IES-001: checkpoint:* IPC handler senderFrame 防护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerCheckpointIpcHandlers()
  })

  const allChannels = [
    'checkpoint:init',
    'checkpoint:commit',
    'checkpoint:initial',
    'checkpoint:restore',
    'checkpoint:diff',
    'checkpoint:gc',
    'checkpoint:destroy',
  ]

  it('所有 7 个 checkpoint channel 应被注册', () => {
    const registeredChannels = mocks.handleFn.mock.calls.map((c: any[]) => c[0])
    for (const ch of allChannels) {
      expect(registeredChannels).toContain(ch)
    }
  })

  for (const channel of allChannels) {
    describe(channel, () => {
      it('不受信任来源 → 应拒绝并返回 Unauthorized', async () => {
        mocks.isTrustedSenderMock.mockReturnValue(false)
        const handler = findHandler(channel)
        expect(handler).toBeDefined()

        const event = makeFakeEvent('https://evil.com/attack')
        const result = await handler!(event, '/Users/test/project', 'abc123', 'def456')

        expect(result).toEqual(REJECT_RESPONSE)
      })

      it('受信任来源 → 应正常执行', async () => {
        mocks.isTrustedSenderMock.mockReturnValue(true)
        const handler = findHandler(channel)
        expect(handler).toBeDefined()

        const event = makeFakeEvent('file:///app/index.html')
        const result = await handler!(event, '/Users/test/project', 'abc123', 'def456')

        expect(result).toBeDefined()
        expect(result.success).toBe(true)
      })
    })
  }

  describe('破坏性操作的额外防护验证', () => {
    it('checkpoint:restore — 恶意来源不应触发 service.restore()', async () => {
      mocks.isTrustedSenderMock.mockReturnValue(false)
      const handler = findHandler('checkpoint:restore')!
      const event = makeFakeEvent('https://evil.com/')

      await handler(event, '/Users/test/project', 'abc123')

      expect(mocks.serviceMock.restore).not.toHaveBeenCalled()
    })

    it('checkpoint:destroy — 恶意来源不应触发 destroyCheckpointService()', async () => {
      mocks.isTrustedSenderMock.mockReturnValue(false)
      const handler = findHandler('checkpoint:destroy')!
      const event = makeFakeEvent('https://evil.com/')

      await handler(event, '/Users/test/project')

      expect(mocks.destroyMock).not.toHaveBeenCalled()
    })

    it('checkpoint:commit — 恶意来源不应触发 service.commit()', async () => {
      mocks.isTrustedSenderMock.mockReturnValue(false)
      const handler = findHandler('checkpoint:commit')!
      const event = makeFakeEvent('https://evil.com/')

      await handler(event, '/Users/test/project')

      expect(mocks.serviceMock.commit).not.toHaveBeenCalled()
    })
  })
})
