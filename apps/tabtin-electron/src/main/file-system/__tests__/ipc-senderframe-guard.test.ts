/**
 * SD-008 / SD-025 / SD-026 / SD-027 回归测试
 *
 * 验证 file-system IPC handler 对不可信来源的调用拒绝。
 * - SD-025: fs:readDir
 * - SD-026: fs:readFilePreview
 * - SD-008: fs:ripgrepSearch
 * - SD-027: shell:openExternal
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
  openPath: vi.fn(),
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

// Wave 2：fs IPC handler 接 path-access-checker。本测试关注 sender 防护，
// 权限放行让 handler 能进入业务路径。
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

// Wave 0 contract: guardedHandle 改返 envelope 形状 ({ok, error.code/message})
// 替代了历史 { success:false, error:string }。任何调用方—包括测试—都按 D-2
// "不兼容老形状"原则统一使用新 envelope。
const REJECT_RESPONSE = {
  ok: false,
  error: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
}

const GUARDED_CHANNELS = [
  'fs:readDir',
  'fs:readFilePreview',
  'fs:renderOfficePreview',
  'fs:ripgrepSearch',
  'fs:ripgrepSearchCancel',
  'fs:replaceInFiles',
  'shell:openExternal',
]

function findHandler(channel: string) {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

describe('SD-008/SD-025/SD-026/SD-027: file-system IPC senderFrame 防护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerFileSystemIpcHandlers()
  })

  afterEach(() => {
    unregisterFileSystemIpcHandlers()
  })

  for (const channel of GUARDED_CHANNELS) {
    it(`${channel}: 不可信来源（外部页面）被拒绝`, async () => {
      mocks.isTrustedSender.mockReturnValue(false)
      const handler = findHandler(channel)
      const event = { senderFrame: { url: 'https://evil.com/attack' } }
      const result = await handler(event, '/tmp/home/test')
      // W1 D3：envelope 现在自动 stamp per-call trace_id；用 toMatchObject
      // 忽略具体值。
      expect(result).toMatchObject(REJECT_RESPONSE)
      expect(result).toHaveProperty('trace_id')
    })
  }

  it('已有 guardedHandle 的 handler（fs:writeFile 等）同样拒绝不可信来源', async () => {
    mocks.isTrustedSender.mockReturnValue(false)
    const writeHandler = findHandler('fs:writeFile')
    const event = { senderFrame: { url: 'https://evil.com' } }
    const result = await writeHandler(event, '/tmp/home/test.txt', 'content')
    expect(result).toMatchObject(REJECT_RESPONSE)
    expect(result).toHaveProperty('trace_id')
  })
})
