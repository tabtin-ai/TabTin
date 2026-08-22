/**
 * fs:watch 事件分发回归测试
 *
 * 修复"在子目录新建文件后侧边栏不更新"的核心改动是把 `fs:watch-event`
 * payload 字段从 `dirPath`（语义"watch 根"）改名 `parentDir`（语义"实际父目录"），
 * 同时按 parentDir 分组分发（一次 burst 里多个父目录都能各发一条事件）。
 *
 * 这组测试模拟 fs.watch 回调，验证：
 *   - parentDir = path.dirname(rootPath + filename)
 *   - rootPath 字段保留监听根（前端按 watchId/根筛选）
 *   - 防抖期内同父目录多次变化只发最后一条；不同父目录各发一条
 *   - filename 为空时 parentDir 退化到 rootPath（极端兼容路径）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'home') return '/tmp/home'
    if (name === 'downloads') return '/tmp/downloads'
    return '/tmp'
  }),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  isTrustedSender: vi.fn(() => true),
  fsStat: vi.fn(),
  fsWatch: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler,
  },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}))

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    stat: (...args: unknown[]) => mocks.fsStat(...args),
    readdir: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    open: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
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
  resolveSpacesRoot: vi.fn(() => '/tmp/sandbox'),
  resolvePlatformDataRoot: vi.fn(() => '/tmp/platform'),
  computeSkillContentHash: vi.fn(),
  matchSensitivePath: vi.fn(() => null),
}))

vi.mock('keytar', () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn(),
  findPassword: vi.fn(),
}))

vi.mock('../../utils/path-sanitize', () => ({
  sanitizePathSegment: (s: string) => s,
}))

vi.mock('../../download-security', () => ({
  isPathSafe: vi.fn(() => true),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: (...args: unknown[]) => mocks.isTrustedSender(...args),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}))

vi.mock('../../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: vi.fn(() => ({ allowed: true })),
  }),
}))

import { registerFileSystemIpcHandlers, unregisterFileSystemIpcHandlers } from '../ipc'

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

describe('fs:watch 事件分发（dogfood 修复：子目录新增文件不刷新）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.fsStat.mockResolvedValue({ isDirectory: () => true })
    registerFileSystemIpcHandlers()
  })

  afterEach(() => {
    vi.useRealTimers()
    unregisterFileSystemIpcHandlers()
  })

  /**
   * 拿到 fs.watch 的 callback —— 测试通过它模拟"文件系统真的有变化"
   * 触发 main 端事件分发逻辑。
   */
  async function startWatch(rootPath: string, sender = makeTrustedEvent(1).sender) {
    let capturedCb: ((eventType: string, filename: string | null) => void) | null = null
    mocks.fsWatch.mockImplementation((_root: string, _opts: any, cb: any) => {
      capturedCb = cb
      return { close: vi.fn() }
    })
    const handler = findHandler('fs:watch')
    const event = { senderFrame: { url: 'file:///app/index.html' }, sender }
    const result = (await handler(event, rootPath, { recursive: true })) as any
    return { watchId: result.watchId as string, fire: capturedCb!, sender }
  }

  it('子目录变化时 parentDir = 子目录绝对路径（不再是 root）', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    fire('rename', 'src/components/foo.tsx')
    vi.advanceTimersByTime(200)

    expect(sender.send).toHaveBeenCalledTimes(1)
    const [channel, payload] = sender.send.mock.calls[0]
    expect(channel).toBe('fs:watch-event')
    expect(payload.parentDir).toBe(path.resolve('/tmp/home/proj/src/components'))
    expect(payload.rootPath).toBe(path.resolve('/tmp/home/proj'))
    expect(payload.fullPath).toBe(path.resolve('/tmp/home/proj/src/components/foo.tsx'))
    expect(payload.eventType).toBe('rename')
    expect(payload.isGlobal).toBe(false)
  })

  it('防抖期内同父目录多次变化只发最后一条', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    fire('change', 'src/a.ts')
    fire('change', 'src/a.ts')
    fire('rename', 'src/a.ts')
    vi.advanceTimersByTime(200)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send.mock.calls[0][1].eventType).toBe('rename')
    expect(sender.send.mock.calls[0][1].fullPath).toBe(path.resolve('/tmp/home/proj/src/a.ts'))
  })

  it('同父目录 rename 后跟 change 时保留 rename 语义', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    fire('rename', 'src/old.ts')
    fire('change', 'src/new.ts')
    vi.advanceTimersByTime(200)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send.mock.calls[0][1].eventType).toBe('rename')
  })

  it('防抖期内不同父目录各发一条事件（dogfood 核心修复）', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    fire('rename', 'src/a.ts')
    fire('rename', 'tests/b.test.ts')
    fire('rename', 'docs/c.md')
    vi.advanceTimersByTime(200)

    expect(sender.send).toHaveBeenCalledTimes(3)
    const parentDirs = sender.send.mock.calls.map((c: any[]) => c[1].parentDir).sort()
    expect(parentDirs).toEqual([
      path.resolve('/tmp/home/proj/docs'),
      path.resolve('/tmp/home/proj/src'),
      path.resolve('/tmp/home/proj/tests'),
    ])
  })

  it('根级直接变化时 parentDir = rootPath', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    fire('rename', 'README.md')
    vi.advanceTimersByTime(200)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send.mock.calls[0][1].parentDir).toBe(path.resolve('/tmp/home/proj'))
    expect(sender.send.mock.calls[0][1].rootPath).toBe(path.resolve('/tmp/home/proj'))
  })

  it('filename 为空时 parentDir 退化到 rootPath + isGlobal=true（OS 队列溢出）', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    fire('change', '')
    vi.advanceTimersByTime(200)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send.mock.calls[0][1].parentDir).toBe(path.resolve('/tmp/home/proj'))
    expect(sender.send.mock.calls[0][1].fullPath).toBeUndefined()
    // isGlobal=true 让前端知道"main 端拿不到具体路径，需要重扫所有展开目录"
    expect(sender.send.mock.calls[0][1].isGlobal).toBe(true)
  })

  it('正常 filename 路径 isGlobal=false（前端只刷父目录即可）', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    fire('rename', 'README.md')
    vi.advanceTimersByTime(200)

    expect(sender.send.mock.calls[0][1].isGlobal).toBe(false)
  })

  it('node_modules / .git / dist 等黑名单段下的变化直接丢弃', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    // 各种用户视图层基本不会展开的大目录
    fire('change', 'node_modules/some-pkg/index.js')
    fire('change', 'node_modules/.pnpm/lock')
    fire('change', '.git/objects/ab/cdef')
    fire('change', 'dist/bundle.js')
    fire('change', 'build/main.o')
    fire('change', '__pycache__/foo.pyc')
    fire('change', '.venv/lib/python3.11/site.py')
    fire('change', 'src/sub/.next/cache/x')
    vi.advanceTimersByTime(200)

    // 全部丢弃，0 条 IPC
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('黑名单不会误伤同名文件（精确段匹配）', async () => {
    const { fire, sender } = await startWatch('/tmp/home/proj')

    // 用户文件名以黑名单词开头但不是独立段，应放行
    fire('rename', 'node_modules.md')        // 文件名包含 node_modules 不应丢
    fire('rename', 'docs/build-guide.md')    // 文件名以 build 开头不应丢
    fire('rename', 'src/dist-utils.ts')      // 文件名包含 dist 不应丢
    vi.advanceTimersByTime(200)

    expect(sender.send).toHaveBeenCalledTimes(3)
  })

  it('多个 watcher 共存时事件按各自 watchId 分发，互不串', async () => {
    const senderA = makeTrustedEvent(1).sender
    const senderB = makeTrustedEvent(2).sender
    const { watchId: idA, fire: fireA } = await startWatch('/tmp/home/A', senderA)
    const { watchId: idB, fire: fireB } = await startWatch('/tmp/home/B', senderB)

    fireA('change', 'sub/x.ts')
    fireB('change', 'sub/y.ts')
    vi.advanceTimersByTime(200)

    expect(senderA.send).toHaveBeenCalledTimes(1)
    expect(senderA.send.mock.calls[0][1].watchId).toBe(idA)
    expect(senderA.send.mock.calls[0][1].rootPath).toBe(path.resolve('/tmp/home/A'))

    expect(senderB.send).toHaveBeenCalledTimes(1)
    expect(senderB.send.mock.calls[0][1].watchId).toBe(idB)
    expect(senderB.send.mock.calls[0][1].rootPath).toBe(path.resolve('/tmp/home/B'))
  })

  describe('MAX_WATCHERS 限流', () => {
    /**
     * MAX_WATCHERS_PER_SENDER 实际值是 80，但单测构造 80 个 watcher 太重。
     * 只验证"超过该 sender 的上限就拒绝、其他 sender 仍可启动"的关键行为。
     * 全局上限 200 的覆盖留给手测 / dogfood。
     */
    it('单 sender 触线后拒绝，其他 sender 仍可启动', async () => {
      const senderA = makeTrustedEvent(1).sender
      const senderB = makeTrustedEvent(2).sender

      // sender 1 起 80 个 watcher（per-sender 上限）
      mocks.fsWatch.mockImplementation(() => ({ close: vi.fn() }))
      const handler = findHandler('fs:watch')
      const eventA = { senderFrame: { url: 'file:///app/index.html' }, sender: senderA }
      const eventB = { senderFrame: { url: 'file:///app/index.html' }, sender: senderB }

      // 80 个全成功（用不同 path 避免 main 端潜在去重——目前没去重，但保险写）
      for (let i = 0; i < 80; i++) {
        const r = (await handler(eventA, `/tmp/home/proj-${i}`)) as any
        expect(r.success).toBe(true)
      }

      // 第 81 个：sender 1 触线，拒
      const overLimit = (await handler(eventA, '/tmp/home/proj-overflow')) as any
      expect(overLimit.success).toBe(false)
      expect(overLimit.error).toMatch(/per-sender/)

      // sender 2 起 1 个：仍能成功（per-sender 隔离）
      const otherSender = (await handler(eventB, '/tmp/home/other')) as any
      expect(otherSender.success).toBe(true)
    })

    it('cleanup 后 sender 配额释放', async () => {
      const senderA = makeTrustedEvent(1).sender
      mocks.fsWatch.mockImplementation(() => ({ close: vi.fn() }))
      const handler = findHandler('fs:watch')
      const unwatchHandler = findHandler('fs:unwatch')
      const event = { senderFrame: { url: 'file:///app/index.html' }, sender: senderA }

      // 起 80 个占满
      const ids: string[] = []
      for (let i = 0; i < 80; i++) {
        const r = (await handler(event, `/tmp/home/p-${i}`)) as any
        ids.push(r.watchId)
      }

      // 触线
      const blocked = (await handler(event, '/tmp/home/x')) as any
      expect(blocked.success).toBe(false)

      // 释放一个
      await unwatchHandler(event, ids[0])

      // 再起一个：成功
      const ok = (await handler(event, '/tmp/home/y')) as any
      expect(ok.success).toBe(true)
    })
  })
})
