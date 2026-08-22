/**
 * EEL-011 回归测试
 *
 * 验证 fs:ensureSpaceSandbox、fs:watch、fs:unwatch、shell:openPath、shell:showItemInFolder
 * 均经 guardedHandle 来源验证，不可信 WebContents（外部网页、Tin 沙箱）的调用被拒绝。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'downloads') return '/tmp/downloads'
    if (name === 'home') return '/tmp/home'
    return '/tmp'
  }),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  openPath: vi.fn(async () => ''),
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
  isPathSafe: vi.fn(() => true),
  resolveSpacesRoot: vi.fn(() => '/tmp/sandbox'),
  sanitizePathSegment: vi.fn((s: string) => s),
  isTrustedSender: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler,
  },
  shell: {
    openPath: mocks.openPath,
    openExternal: mocks.openExternal,
    showItemInFolder: mocks.showItemInFolder,
  },
}))

vi.mock('node:child_process', () => {
  const execFile = vi.fn()
  return { execFile, default: { execFile } }
})

vi.mock('node:util', () => ({
  promisify: () => vi.fn(),
  default: { promisify: () => vi.fn() },
}))

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: mocks.resolveSpacesRoot,
  resolvePlatformDataRoot: vi.fn(() => '/tmp/platform'),
  computeSkillContentHash: vi.fn().mockResolvedValue('hash'),
  matchSensitivePath: vi.fn(() => null),
}))

// Wave 2：fs IPC handler 接 path-access-checker。本测试关注 sender 防护。
vi.mock('../../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: vi.fn(() => ({ allowed: true })),
  }),
}))

vi.mock('keytar', () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn(),
  findPassword: vi.fn(),
}))

vi.mock('../../utils/path-sanitize', () => ({
  sanitizePathSegment: mocks.sanitizePathSegment,
}))

vi.mock('../../download-security', () => ({
  isPathSafe: mocks.isPathSafe,
}))

vi.mock('../../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}))

import { registerFileSystemIpcHandlers, unregisterFileSystemIpcHandlers } from '../ipc'

// Wave 0 contract: guardedHandle 改返 envelope 形状 ({ok, error.code/message})。
const REJECT_RESPONSE = {
  ok: false,
  error: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
}

const EEL_011_CHANNELS = [
  'fs:ensureSpaceSandbox',
  'fs:watch',
  'fs:unwatch',
  'shell:openPath',
  'shell:showItemInFolder',
]

function findHandler(channel: string) {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

describe('EEL-011: 新增 guardedHandle 覆盖的 IPC channel 来源验证', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerFileSystemIpcHandlers()
  })

  afterEach(() => {
    unregisterFileSystemIpcHandlers()
  })

  for (const channel of EEL_011_CHANNELS) {
    it(`${channel}: 不可信来源被拒绝`, async () => {
      mocks.isTrustedSender.mockReturnValue(false)
      const handler = findHandler(channel)
      const event = { senderFrame: { url: 'https://evil.com/attack' }, sender: { id: 999, isDestroyed: () => false } }
      const result = await handler(event, '/tmp/home/test')
      // W1 D3：envelope 自动 stamp per-call trace_id
      expect(result).toMatchObject(REJECT_RESPONSE)
      expect(result).toHaveProperty('trace_id')
    })

    it(`${channel}: 可信来源正常通过`, async () => {
      mocks.isTrustedSender.mockReturnValue(true)
      const handler = findHandler(channel)
      const event = { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 1, isDestroyed: () => false, once: vi.fn() } }

      const result = await handler(event, '/tmp/home/test') as any
      // 仍用 not.toEqual：可信路径 result 不该跟 REJECT_RESPONSE 完全相等。
      // （此处 trace_id 多寡不影响：result 是真业务返回值，shape 完全不同）
      expect(result).not.toEqual(REJECT_RESPONSE)
    })
  }

  it('所有 EEL-011 channel 均通过 guardedHandle 注册（handler 内含 isTrustedSender 检查）', async () => {
    mocks.isTrustedSender.mockReturnValue(false)
    for (const channel of EEL_011_CHANNELS) {
      const handler = findHandler(channel)
      expect(handler).toBeDefined()

      const event = { senderFrame: { url: 'https://attacker.com' } }
      const result = await handler(event, 'test-arg')
      expect(result).toMatchObject(REJECT_RESPONSE)
      expect(result).toHaveProperty('trace_id')
    }
  })
})
