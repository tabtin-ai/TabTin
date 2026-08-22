/**
 * ISI-001 / ISI-003 / ISI-004 / ISI-005 / ISI-006 / ISI-014 回归测试
 *
 * - ISI-001 + ISI-004: readBinaryFile 返回独立 ArrayBuffer，不泄漏 Buffer 池数据
 * - ISI-003: readBinaryFile 拒绝超过 50MB 的文件
 * - ISI-005: fs:watch / fs:ensureSpaceSandbox 使用 guardedHandle
 * - ISI-006: readBinaryFile / readFilePreview 在 isPathSafe 前 path.resolve
 * - ISI-014: fs:unwatch 使用 guardedHandle + sender 归属校验
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
  readFile: vi.fn(),
  fsStat: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  fsOpen: vi.fn(),
  existsSync: vi.fn(() => false),
  fsWatch: vi.fn(),
  unlink: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
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

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    stat: (...args: unknown[]) => mocks.fsStat(...args),
    readdir: (...args: unknown[]) => mocks.readdir(...args),
    writeFile: (...args: unknown[]) => mocks.writeFile(...args),
    mkdir: (...args: unknown[]) => mocks.mkdir(...args),
    open: (...args: unknown[]) => mocks.fsOpen(...args),
    unlink: (...args: unknown[]) => mocks.unlink(...args),
    rename: (...args: unknown[]) => mocks.rename(...args),
    rm: (...args: unknown[]) => mocks.rm(...args),
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mocks.existsSync(...args),
    watch: (...args: unknown[]) => mocks.fsWatch(...args),
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

// 路径权限治理 Wave 2：fs IPC handler 接 path-access-checker 替代老
// isPathAllowed / isPathSafe。本测试不验证权限决策（其他维度的 ISI 回归），
// mock checker 让 path 判定可控——通过 mocks.pathAccessCheck 配置每条用例的
// allow/deny。
const pathAccessCheckMock = vi.fn(() => ({ allowed: true } as { allowed: boolean; reason?: { reasonCode: string; message: string } }))
vi.mock('../../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: (...args: unknown[]) => (pathAccessCheckMock as any)(...args),
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
  isPathSafe: (...args: unknown[]) => mocks.isPathSafe(...args),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: (...args: unknown[]) => mocks.isTrustedSender(...args),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
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

function findHandler(channel: string) {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

function makeTrustedEvent(senderId = 1) {
  return {
    senderFrame: { url: 'file:///app/index.html' },
    sender: {
      id: senderId,
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    },
  }
}

function makeUntrustedEvent() {
  return {
    senderFrame: { url: 'https://evil.com/attack' },
    sender: { id: 999 },
  }
}

describe('ISI-001/ISI-003/ISI-004/ISI-005/ISI-006/ISI-014 回归测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isPathSafe.mockImplementation(() => true)
    mocks.resolveSpacesRoot.mockImplementation(() => '/tmp/sandbox')
    mocks.sanitizePathSegment.mockImplementation((s: string) => s)
    mocks.existsSync.mockImplementation(() => false)
    pathAccessCheckMock.mockImplementation(() => ({ allowed: true }))
    registerFileSystemIpcHandlers()
  })

  afterEach(() => {
    unregisterFileSystemIpcHandlers()
  })

  describe('ISI-005 + ISI-014: fs:watch / fs:ensureSpaceSandbox / fs:unwatch 经过 guardedHandle', () => {
    const NEWLY_GUARDED = ['fs:watch', 'fs:ensureSpaceSandbox', 'fs:unwatch']

    for (const channel of NEWLY_GUARDED) {
      it(`${channel}: 不可信来源被拒绝`, async () => {
        mocks.isTrustedSender.mockReturnValue(false)
        const handler = findHandler(channel)
        const event = makeUntrustedEvent()
        const result = await handler(event, '/tmp/home/test')
        // W1 D3：envelope 自动 stamp per-call trace_id
        expect(result).toMatchObject(REJECT_RESPONSE)
        expect(result).toHaveProperty('trace_id')
      })
    }
  })

  describe('ISI-001 + ISI-004: readBinaryFile 返回独立 ArrayBuffer', () => {
    it('返回的 ArrayBuffer 大小等于文件内容，不包含 Buffer 池中其他数据', async () => {
      mocks.isTrustedSender.mockReturnValue(true)

      // 模拟 Node.js Buffer 池：buffer.buffer 远大于实际文件内容
      const pool = new ArrayBuffer(8192)
      const fileContent = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
      new Uint8Array(pool).set(fileContent, 200)
      const pooledBuffer = Buffer.from(pool, 200, 4)

      mocks.fsStat.mockResolvedValue({ size: 4, isDirectory: () => false })
      mocks.readFile.mockResolvedValue(pooledBuffer)

      const handler = findHandler('fs:readBinaryFile')
      const event = makeTrustedEvent()
      const result = (await handler(event, '/tmp/home/test.xlsx')) as any

      expect(result.success).toBe(true)
      expect(result.data.byteLength).toBe(4)
      expect(new Uint8Array(result.data)).toEqual(fileContent)
    })

    it('byteOffset 非零时仍返回正确的数据切片', async () => {
      mocks.isTrustedSender.mockReturnValue(true)

      const pool = new ArrayBuffer(4096)
      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe])
      new Uint8Array(pool).set(data, 500)
      const pooledBuffer = Buffer.from(pool, 500, 6)

      mocks.fsStat.mockResolvedValue({ size: 6, isDirectory: () => false })
      mocks.readFile.mockResolvedValue(pooledBuffer)

      const handler = findHandler('fs:readBinaryFile')
      const result = (await handler(makeTrustedEvent(), '/tmp/home/test.docx')) as any

      expect(result.success).toBe(true)
      expect(result.data.byteLength).toBe(6)
      expect(new Uint8Array(result.data)).toEqual(data)
    })
  })

  describe('ISI-003: readBinaryFile 文件大小限制', () => {
    it('超过 50MB 时返回错误且不读取文件', async () => {
      mocks.isTrustedSender.mockReturnValue(true)

      const hugeSize = 60 * 1024 * 1024
      mocks.fsStat.mockResolvedValue({ size: hugeSize })

      const handler = findHandler('fs:readBinaryFile')
      const result = (await handler(makeTrustedEvent(), '/tmp/home/huge.xlsx')) as any

      expect(result.success).toBe(false)
      expect(result.error).toContain('file too large')
      expect(mocks.readFile).not.toHaveBeenCalled()
    })

    it('恰好 50MB 时允许读取', async () => {
      mocks.isTrustedSender.mockReturnValue(true)

      const exactLimit = 50 * 1024 * 1024
      const fakeBuffer = Buffer.alloc(10)
      mocks.fsStat.mockResolvedValue({ size: exactLimit })
      mocks.readFile.mockResolvedValue(fakeBuffer)

      const handler = findHandler('fs:readBinaryFile')
      const result = (await handler(makeTrustedEvent(), '/tmp/home/exact.xlsx')) as any

      expect(result.success).toBe(true)
      expect(mocks.readFile).toHaveBeenCalled()
    })
  })

  describe('ISI-006: readBinaryFile / readFilePreview 在 path-access-checker 前执行 path.resolve', () => {
    // Wave 2 起：老 isPathSafe 已被 path-access-checker 替代。语义保持——
    // path 必须在权限判定**之前**完成绝对化（防 traversal）。
    it('readBinaryFile: 相对路径被 resolve 后传给 path-access-checker', async () => {
      mocks.isTrustedSender.mockReturnValue(true)
      pathAccessCheckMock.mockImplementation(() => ({
        allowed: false,
        reason: { reasonCode: 'outside_workspace', message: 'denied' },
      }))

      const handler = findHandler('fs:readBinaryFile')
      await handler(makeTrustedEvent(), 'relative/path/file.bin')

      const calledPath = pathAccessCheckMock.mock.calls[0][0] as string
      expect(calledPath).toMatch(/^\//)
      expect(calledPath).not.toBe('relative/path/file.bin')
    })

    it('readFilePreview: 相对路径被 resolve 后传给 path-access-checker', async () => {
      mocks.isTrustedSender.mockReturnValue(true)
      pathAccessCheckMock.mockImplementation(() => ({
        allowed: false,
        reason: { reasonCode: 'outside_workspace', message: 'denied' },
      }))

      const handler = findHandler('fs:readFilePreview')
      await handler(makeTrustedEvent(), 'relative/path/readme.md')

      const calledPath = pathAccessCheckMock.mock.calls[0][0] as string
      expect(calledPath).toMatch(/^\//)
      expect(calledPath).not.toBe('relative/path/readme.md')
    })
  })

  describe('ISI-014: fs:unwatch sender 归属验证', () => {
    it('不同 sender 尝试 unwatch 时被拒绝', async () => {
      mocks.isTrustedSender.mockReturnValue(true)

      const watcherMock = { close: vi.fn() }
      mocks.fsWatch.mockReturnValue(watcherMock)
      mocks.fsStat.mockResolvedValue({ isDirectory: () => true })

      const watchHandler = findHandler('fs:watch')
      const watchEvent = makeTrustedEvent(1)
      const watchResult = (await watchHandler(watchEvent, '/tmp/home/dir')) as any

      expect(watchResult.success).toBe(true)
      const watchId = watchResult.watchId

      // 不同 sender (id=2) 尝试 unwatch → 被拒绝
      const unwatchHandler = findHandler('fs:unwatch')
      const otherSenderEvent = makeTrustedEvent(2)
      const rejectResult = (await unwatchHandler(otherSenderEvent, watchId)) as any

      expect(rejectResult.success).toBe(false)
      expect(rejectResult.error).toContain('access denied')
    })

    it('原始 sender 可以正常 unwatch', async () => {
      mocks.isTrustedSender.mockReturnValue(true)

      mocks.fsWatch.mockReturnValue({ close: vi.fn() })
      mocks.fsStat.mockResolvedValue({ isDirectory: () => true })

      const watchHandler = findHandler('fs:watch')
      const watchEvent = makeTrustedEvent(1)
      const watchResult = (await watchHandler(watchEvent, '/tmp/home/dir')) as any
      const watchId = watchResult.watchId

      const unwatchHandler = findHandler('fs:unwatch')
      const sameEvent = makeTrustedEvent(1)
      const result = (await unwatchHandler(sameEvent, watchId)) as any

      expect(result.success).toBe(true)
    })

    it('不存在的 watchId → 正常返回成功（幂等）', async () => {
      mocks.isTrustedSender.mockReturnValue(true)

      const unwatchHandler = findHandler('fs:unwatch')
      const result = (await unwatchHandler(makeTrustedEvent(), 'non-existent-id')) as any

      expect(result.success).toBe(true)
    })
  })
})
