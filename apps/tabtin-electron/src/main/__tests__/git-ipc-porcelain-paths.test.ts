import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  execFileAsync: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/home' },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: vi.fn(),
  },
}))

vi.mock('child_process', () => {
  const execFile = vi.fn()
  return { execFile, default: { execFile } }
})

vi.mock('util', () => ({
  promisify: () => mocks.execFileAsync,
  default: { promisify: () => mocks.execFileAsync },
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: { ...actual, statSync: () => ({ isDirectory: () => true }) },
    statSync: () => ({ isDirectory: () => true }),
  }
})

vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: () => ({ allowed: true }),
  }),
}))

vi.mock('../auth', () => ({
  isTrustedSender: () => true,
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { registerGitIpcHandlers } from '../git-ipc'

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((candidate: unknown[]) => candidate[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

/**
 * [#4915] 用真实 Unicode 字符串模拟 `execFile` 在 `-z` 模式下的返回值。
 *
 * Node 的 child_process 默认按 utf8 解码 stdout，因此这里直接拼接真实中文
 * 字符 + `\0` 即可还原 `git status --porcelain=v1 -uall -z` 的输出——不需要
 * 手写 `\346\265\213` 这类八进制转义（那只在**没有** `-z` 且
 * `core.quotepath=true` 时才会出现，正是本 issue 要修的坑）。
 */
const NUL = '\0'

describe('git porcelain path parsing ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerGitIpcHandlers()
  })

  describe('git:status', () => {
    it('解析含中文目录的未跟踪文件为真实相对路径（不带引号/八进制转义）', async () => {
      const raw = ['?? temp/测试/111'].join(NUL) + NUL
      mocks.execFileAsync.mockResolvedValueOnce({ stdout: raw, stderr: '' })

      const result = await getHandler('git:status')({}, '/tmp/home/project') as {
        success: boolean
        files: Record<string, string>
        entries: Record<string, { x: string; y: string; status: string }>
      }

      expect(result.success).toBe(true)
      expect(result.files).toEqual({ 'temp/测试/111': '??' })
      expect(result.entries['temp/测试/111']).toEqual({ x: '?', y: '?', status: '??' })
      expect(Object.keys(result.files)).not.toContain('"temp/测试/111"')

      expect(mocks.execFileAsync).toHaveBeenCalledWith(
        'git',
        ['status', '--porcelain=v1', '-uall', '-z'],
        expect.objectContaining({ cwd: '/tmp/home/project' }),
      )
    })

    it('解析带空格与引号的文件名', async () => {
      const raw = ['?? normal dir/a "quoted" b.txt'].join(NUL) + NUL
      mocks.execFileAsync.mockResolvedValueOnce({ stdout: raw, stderr: '' })

      const result = await getHandler('git:status')({}, '/tmp/home/project') as {
        files: Record<string, string>
      }

      expect(result.files).toEqual({ 'normal dir/a "quoted" b.txt': '??' })
    })

    it('rename 记录只保留新路径作为 key，正确消费掉 -z 协议里的旧路径 token', async () => {
      // `git status --porcelain=v1 -uall -z` 对 rename：`R  <newpath>\0<oldpath>\0`
      const raw = [
        'R  temp/测试/renamed 文件.txt',
        'renameme.txt',
        '?? temp/测试/222.txt',
      ].join(NUL) + NUL
      mocks.execFileAsync.mockResolvedValueOnce({ stdout: raw, stderr: '' })

      const result = await getHandler('git:status')({}, '/tmp/home/project') as {
        files: Record<string, string>
        entries: Record<string, { x: string; y: string; status: string }>
      }

      expect(result.files).toEqual({
        'temp/测试/renamed 文件.txt': 'R',
        'temp/测试/222.txt': '??',
      })
      expect(result.entries['temp/测试/renamed 文件.txt']).toEqual({ x: 'R', y: ' ', status: 'R' })
      // 旧路径不应残留为一条独立记录
      expect(result.files['renameme.txt']).toBeUndefined()
    })

    it('遇到 legacy quoted 八进制转义时仍能兜底解码（防御性 fallback）', async () => {
      // 模拟极端情况：某处仍拿到未走 -z 的旧式 quoted 输出（quotepath 默认开）。
      const raw = '?? "temp/\\346\\265\\213\\350\\257\\225/111"' + NUL
      mocks.execFileAsync.mockResolvedValueOnce({ stdout: raw, stderr: '' })

      const result = await getHandler('git:status')({}, '/tmp/home/project') as {
        files: Record<string, string>
      }

      expect(result.files).toEqual({ 'temp/测试/111': '??' })
    })
  })

  describe('git:fullStatus', () => {
    it('聚合接口同样解析出真实中文路径', async () => {
      mocks.execFileAsync
        .mockResolvedValueOnce({ stdout: 'true', stderr: '' }) // rev-parse --is-inside-work-tree
        .mockResolvedValueOnce({
          stdout: ['# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'].join('\n'),
          stderr: '',
        }) // status --porcelain=2 --branch
        .mockResolvedValueOnce({ stdout: '?? temp/测试/111' + NUL, stderr: '' }) // status -z
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // diff HEAD --numstat
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // diff --numstat
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // diff --cached --numstat

      const result = await getHandler('git:fullStatus')({}, '/tmp/home/project') as {
        status: { files: Record<string, string> }
      }

      expect(result.status.files).toEqual({ 'temp/测试/111': '??' })
    })
  })

  describe('git:stage 与真实路径闭环', () => {
    it('把从 git:status 解析出的真实中文路径原样传给 git add', async () => {
      const statusRaw = '?? temp/测试/111' + NUL
      mocks.execFileAsync.mockResolvedValueOnce({ stdout: statusRaw, stderr: '' })
      const statusResult = await getHandler('git:status')({}, '/tmp/home/project') as {
        files: Record<string, string>
      }
      const [realPath] = Object.keys(statusResult.files)
      expect(realPath).toBe('temp/测试/111')

      mocks.execFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' })
      const stageResult = await getHandler('git:stage')({}, '/tmp/home/project', [realPath])

      expect(stageResult).toEqual({ success: true })
      expect(mocks.execFileAsync).toHaveBeenNthCalledWith(
        2,
        'git',
        ['add', '--', 'temp/测试/111'],
        expect.objectContaining({ cwd: '/tmp/home/project' }),
      )
    })
  })
})
