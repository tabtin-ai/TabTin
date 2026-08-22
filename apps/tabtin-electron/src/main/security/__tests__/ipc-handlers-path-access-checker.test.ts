/**
 * 路径权限治理 Wave 2 · 集成测试
 *
 * 覆盖目标："fs:* / git / checkpoint IPC handler 都通过 path-access-checker
 * 做权限判定"——checker 拒绝时各 handler 返回 success: false（语义对齐）。
 *
 * 此测试取代了 W2 之前 "isPathAllowed deny-list enforcement" 一系列细节
 * 测试（eel-005 / eel-006-018 / eel-013 / eel-014-space-deny-paths）——它们
 * 验证的是老 helper 实现细节，path-access-checker 收敛后不再有意义。
 *
 * 当前测试通过 mock path-access-checker 让特定路径返回 deny，验证：
 *   1. fs:* 写/读/删 IPC handler 把 deny 翻译成 success: false
 *   2. git IPC handler validateCwd 在 deny 时拒绝
 *   3. checkpoint IPC handler 在 deny 时返回 PATH_ERROR
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
  openPath: vi.fn().mockResolvedValue(''),
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
  execFileAsync: vi.fn(),
  resolveSpacesRoot: vi.fn(() => '/tmp/sandbox'),
  resolvePlatformDataRoot: vi.fn(() => '/tmp/platform'),
  computeSkillContentHash: vi.fn().mockResolvedValue('hash'),
  sanitizePathSegment: vi.fn((s: string) => s),
  isTrustedSender: vi.fn(() => true),
  pathAccessCheck: vi.fn(() => ({ allowed: true })),
  /**
   * 控制 `getDefaultPathAccessChecker()` 是否在调用时 throw。
   * 默认返回 `null` 走正常 stub checker；测试想覆盖「初始化失败」分支
   * 时设 `mockReturnValueOnce(new Error(...))` 即可。
   */
  pathCheckerInitError: vi.fn<() => Error | null>(() => null),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler,
    on: vi.fn(),
    removeAllListeners: vi.fn(),
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

vi.mock('child_process', () => {
  const execFile = vi.fn()
  return { execFile, default: { execFile } }
})

vi.mock('node:util', () => ({
  promisify: () => mocks.execFileAsync,
  default: { promisify: () => mocks.execFileAsync },
}))

vi.mock('util', () => ({
  promisify: () => mocks.execFileAsync,
  default: { promisify: () => mocks.execFileAsync },
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    default: { ...actual, statSync: mocks.statSync },
    statSync: mocks.statSync,
  }
})

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: mocks.resolveSpacesRoot,
  resolvePlatformDataRoot: mocks.resolvePlatformDataRoot,
  computeSkillContentHash: mocks.computeSkillContentHash,
  matchSensitivePath: vi.fn(() => null),
}))

//  批次 13：space 路径 helper 出口从 engine barrel 收敛到包入口。
vi.mock('@tabtin/agent-runtime', () => ({
  resolveSpaceWorkspaceRoot: vi.fn(() => '/tmp/sandbox/wt/spaces/space-1'),
  resolveSpaceSkillsDir: vi.fn(() => '/tmp/platform/wt/spaces/space-1/skills'),
}))

vi.mock('../ripgrep-bundle-path', () => ({
  getBundledRipgrepPath: () => '/usr/bin/rg',
}))

vi.mock('../../utils/path-sanitize', () => ({
  sanitizePathSegment: mocks.sanitizePathSegment,
}))

vi.mock('../../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}))

vi.mock('../path-access-checker', () => ({
  getDefaultPathAccessChecker: () => {
    const initErr = mocks.pathCheckerInitError()
    if (initErr) throw initErr
    return { check: mocks.pathAccessCheck }
  },
}))

vi.mock('keytar', () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn(),
  findPassword: vi.fn(),
}))

vi.mock('../../checkpoint/CheckpointService', () => ({
  getCheckpointService: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue('abc123'),
    getInitialCommitHash: vi.fn().mockResolvedValue('root000'),
    restore: vi.fn().mockResolvedValue(undefined),
    getDiff: vi.fn().mockResolvedValue([]),
    listCommits: vi.fn().mockResolvedValue([]),
    gc: vi.fn().mockResolvedValue(undefined),
    getDiskUsage: vi.fn().mockResolvedValue({ sizeBytes: 0, sizeHuman: '0 B' }),
    writeTree: vi.fn().mockResolvedValue('tree-hash'),
    getDiffSummary: vi.fn().mockResolvedValue({ files: [], summary: { changed: 0, insertions: 0, deletions: 0 } }),
    getAffectedPaths: vi.fn().mockResolvedValue([]),
  })),
  destroyCheckpointService: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tabtin/shared', () => ({
  getCheckpointsRoot: () => '/tmp/checkpoints',
}))

vi.mock('@tabtin/storage-manager', () => ({
  getBucket: () => null,
  registerStorageBucket: vi.fn(),
}))

vi.mock('@tabtin/checkpoint-core', () => ({
  parseShadowCoreWorktreeFromConfig: vi.fn(() => null),
}))

// 共享 mock logger：source 里 `const log = createLogger('FileSystemIPC')` 只在模块
// 加载时调一次，返回同一对象，测试据此断言诊断日志（含底层 stack）确实落到了 logger。
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('../../logger', () => ({
  createLogger: () => mockLog,
}))

import {
  registerFileSystemIpcHandlers,
  unregisterFileSystemIpcHandlers,
} from '../../file-system/ipc'
import { registerGitIpcHandlers } from '../../git-ipc'
import { registerCheckpointIpcHandlers } from '../../checkpoint/checkpoint-ipc'

const DENIED_REASON = {
  reasonCode: 'outside_workspace' as const,
  message: 'Path /var/elsewhere is outside your workspace.',
}

function denyFor(filePath: string) {
  return {
    allowed: false,
    reason: { ...DENIED_REASON, message: `denied: ${filePath}` },
  }
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

describe('Wave 2 · fs:* IPC handler 接 path-access-checker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerFileSystemIpcHandlers()
  })

  afterEach(() => {
    unregisterFileSystemIpcHandlers()
  })

  it('fs:readDir checker 拒绝 → success:false + actionable message', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/elsewhere'))
    const handler = getHandler('fs:readDir')
    const result = (await handler({}, '/var/elsewhere')) as any
    expect(result.success).toBe(false)
    expect(result.error).toContain('denied:')
  })

  it('fs:readDir checker 初始化 throw → 不 leak 底层 stack，给可操作文案', async () => {
    // 真实场景：path-access-checker.ts 漏写 createRequire / packaged ESM
    // 主进程里裸 `require()` 时抛 ReferenceError。该错误会冒泡到
    // checkAndFormat 里——历史上直接被 catch 拿 .message 塞进 result.error，
    // 用户文件树上看到的就是 "require is not defined" 这种底层堆栈文本。
    // 修复后应识别为「权限服务初始化失败」给出 actionable 文案。
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.pathCheckerInitError.mockReturnValueOnce(
      new ReferenceError('require is not defined'),
    )
    const handler = getHandler('fs:readDir')
    const result = (await handler({}, '/tmp/home/proj')) as any
    expect(result.success).toBe(false)
    expect(result.error).toContain('权限服务初始化失败')
    expect(result.error).not.toContain('require is not defined')
    expect(result.error).not.toContain('ReferenceError')
    // 详细 stack 进 main 日志（createLogger）供开发者定位，而非 console/用户可见错误。
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('path-access-checker 初始化失败'),
      expect.stringContaining('require is not defined'),
    )
    consoleErrSpy.mockRestore()
  })

  it('fs:readFilePreview checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/secret'))
    const handler = getHandler('fs:readFilePreview')
    const result = (await handler({}, '/var/secret')) as any
    expect(result.success).toBe(false)
  })

  it('fs:writeFile checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/x.txt'))
    const handler = getHandler('fs:writeFile')
    const result = (await handler({}, '/var/x.txt', 'data')) as any
    expect(result.success).toBe(false)
  })

  it('fs:rename 双路径 checker 拒绝任一 → success:false', async () => {
    mocks.pathAccessCheck
      .mockReturnValueOnce({ allowed: true })   // oldPath ok
      .mockReturnValueOnce(denyFor('/var/new'))  // newPath denied
    const handler = getHandler('fs:rename')
    const result = (await handler({}, '/tmp/home/old', '/var/new')) as any
    expect(result.success).toBe(false)
  })

  it('fs:deleteFile checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/important'))
    const handler = getHandler('fs:deleteFile')
    const result = (await handler({}, '/var/important')) as any
    expect(result.success).toBe(false)
  })

  it('fs:ripgrepSearch checker 拒绝 cwd → success:false + results=[]', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/secret-dir'))
    const handler = getHandler('fs:ripgrepSearch')
    const result = (await handler({}, {
      cwd: '/var/secret-dir',
      pattern: 'foo',
    })) as any
    expect(result.success).toBe(false)
    expect(result.results).toEqual([])
  })

  it('shell:openPath checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/secret'))
    const handler = getHandler('shell:openPath')
    const result = (await handler({}, '/var/secret')) as any
    expect(result.success).toBe(false)
  })

  it('shell:showItemInFolder checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/secret'))
    const handler = getHandler('shell:showItemInFolder')
    const result = (await handler({}, '/var/secret')) as any
    expect(result.success).toBe(false)
  })

  it('clipboard:writeFile checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/secret-video.mp4'))
    const handler = getHandler('clipboard:writeFile')
    const result = (await handler({}, '/var/secret-video.mp4')) as any
    expect(result.success).toBe(false)
  })

  it('fs:computeSkillContentHash checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/skills'))
    const handler = getHandler('fs:computeSkillContentHash')
    const result = (await handler({}, '/var/skills')) as any
    expect(result.success).toBe(false)
  })

  it('fs:readBinaryFile checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValueOnce(denyFor('/var/bin'))
    const handler = getHandler('fs:readBinaryFile')
    const result = (await handler({}, '/var/bin')) as any
    expect(result.success).toBe(false)
  })

  it('checker 全部 allow → fs handler 走业务逻辑（不被 checker 拦）', async () => {
    // 验证 handler 流程没死锁——业务路径仍能进入到下一层（最终因为 stat 等
    // 失败，但 success/error 不来自 checker）。
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    const handler = getHandler('fs:readFilePreview')
    const result = (await handler({}, '/tmp/home/non-existent-file')) as any
    expect(result.success).toBe(false)
    // error 来自 fs 层而非 checker
    expect(result.error).not.toMatch(/denied:/)
  })
})

describe('Wave 2 · git IPC handler 接 path-access-checker (validateCwd)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerGitIpcHandlers()
  })

  it('validateCwd checker 拒绝 → git:status 返回 invalid working directory', async () => {
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/non-workspace-repo'))
    const handler = getHandler('git:status')
    const result = (await handler({}, '/var/non-workspace-repo')) as any
    expect(result.success).toBe(false)
    expect(result.error).toBe('invalid working directory')
  })

  it('validateCwd checker 拒绝 → git:branch 返回 invalid working directory', async () => {
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/non-workspace-repo'))
    const handler = getHandler('git:branch')
    const result = (await handler({}, '/var/non-workspace-repo')) as any
    expect(result.error).toBe('invalid working directory')
    expect(result.branch).toBe('')
  })

  it('git:isRepo checker 拒绝 → success:true + isRepo:false（非异常）', async () => {
    // git:isRepo 设计上对 invalid cwd 返 isRepo:false（不抛错），仅
    // 用于探针类查询。
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/non-workspace-repo'))
    const handler = getHandler('git:isRepo')
    const result = (await handler({}, '/var/non-workspace-repo')) as any
    expect(result.success).toBe(true)
    expect(result.isRepo).toBe(false)
  })
})

// ─── Wave 2 第二轮独立验证 P1-Q2：validateCwd 按 action 区分 ───────────

describe('Wave 2 P1-Q2 · validateCwd 按 action 区分（write 命令撞 deny WRITE 列表）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerGitIpcHandlers()
  })

  // 模拟"cwd 'read' 通过 / 'write' 拒绝"——例如 cwd 路径在 deny WRITE 路径
  // 前缀（假想 deny WRITE 含 `~/.config/sensitive/`，cwd 落进去）。这条测试
  // 钉死"validateCwd 按 action 真实区分"，避免后续误改回 hardcode 'read'。
  function setReadOnlyCwd(): void {
    mocks.pathAccessCheck.mockImplementation((p: string, action: string) => {
      if (action === 'write') {
        return {
          allowed: false,
          reason: { reasonCode: 'deny_list', message: 'denied write to ' + p },
        }
      }
      return { allowed: true }
    })
  }

  it('git:status（read）允许；git:commit（write）拒——validateCwd action 区分', async () => {
    setReadOnlyCwd()
    const cwd = '/tmp/home/sensitive-project'

    // status 走 'read' → 闯过 validateCwd
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '' })
    const statusResult = (await getHandler('git:status')({}, cwd)) as any
    expect(statusResult.success).toBe(true)

    // commit 走 'write' → 撞 deny → CWD_ERROR
    const commitResult = (await getHandler('git:commit')({}, cwd, 'msg')) as any
    expect(commitResult.success).toBe(false)
    expect(commitResult.error).toBe('invalid working directory')
  })

  it('git:checkout（write）撞 deny → 拒（不调 git）', async () => {
    setReadOnlyCwd()
    const result = (await getHandler('git:checkout')({}, '/tmp/proj', { branch: 'main' })) as any
    expect(result.success).toBe(false)
    expect(result.error).toBe('invalid working directory')
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it('git:pull / git:fetch / git:push（write）撞 deny → 拒', async () => {
    setReadOnlyCwd()
    const pullResult = (await getHandler('git:pull')({}, '/tmp/proj')) as any
    expect(pullResult.success).toBe(false)
    const fetchResult = (await getHandler('git:fetch')({}, '/tmp/proj')) as any
    expect(fetchResult.success).toBe(false)
    const pushResult = (await getHandler('git:push')({}, '/tmp/proj')) as any
    expect(pushResult.success).toBe(false)
  })

  it('git:discardFiles（write）撞 deny → 拒（不调 git）', async () => {
    setReadOnlyCwd()
    const result = (await getHandler('git:discardFiles')(
      {},
      '/tmp/proj',
      ['file.txt'],
    )) as any
    expect(result.success).toBe(false)
    expect(result.error).toBe('invalid working directory')
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it('git:stash list（read）允许；git:stash save（write）拒——sub-action 区分', async () => {
    setReadOnlyCwd()
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '' })
    const listResult = (await getHandler('git:stash')({}, '/tmp/proj', 'list')) as any
    expect(listResult.success).toBe(true)

    const saveResult = (await getHandler('git:stash')({}, '/tmp/proj', 'save')) as any
    expect(saveResult.success).toBe(false)
    expect(saveResult.error).toBe('invalid working directory')
  })

  it('git:worktreeCreate（write）撞 deny → 拒', async () => {
    setReadOnlyCwd()
    const result = (await getHandler('git:worktreeCreate')(
      {},
      '/tmp/proj',
      { path: '/tmp/wt' },
    )) as any
    expect(result.success).toBe(false)
  })
})

// ─── Wave 2 第二轮独立验证 P1-Q1：paths 列表撞 deny WRITE pattern ────

describe('Wave 2 P1-Q1 · paths 撞 deny WRITE pattern 时拒（绕过 deny 列表的核心修复）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerGitIpcHandlers()
  })

  // 模拟 path-access-checker 对"basename 为 .env 的路径"返 deny_list（与
  // DEFAULT_DENY_WRITE_PATTERNS 行为对齐），cwd 自身正常放行。
  function setDenyWritePathContains(needle: string): void {
    mocks.pathAccessCheck.mockImplementation((p: string, action: string) => {
      if (action === 'write' && p.includes(needle)) {
        return {
          allowed: false,
          reason: {
            reasonCode: 'deny_list',
            message: `Path '${p}' is blocked by write deny list (pattern: .env)`,
          },
        }
      }
      return { allowed: true }
    })
  }

  it('git:discardFiles 含 .env → 拒，error 透传 deny_list 信息（核心 P1-Q1 场景）', async () => {
    setDenyWritePathContains('.env')
    const result = (await getHandler('git:discardFiles')(
      {},
      '/tmp/proj',
      ['.env'],
    )) as any
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/deny list|\.env/i)
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it('git:discardFiles 多 paths 任一 .env 命中 → 整批拒', async () => {
    setDenyWritePathContains('.env')
    const result = (await getHandler('git:discardFiles')(
      {},
      '/tmp/proj',
      ['src/foo.ts', '.env', 'lib/bar.ts'],
    )) as any
    expect(result.success).toBe(false)
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it('git:discardFiles 全部 paths 不含 .env → 整批通过', async () => {
    setDenyWritePathContains('.env')
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '' })
    const result = (await getHandler('git:discardFiles')(
      {},
      '/tmp/proj',
      ['src/foo.ts', 'lib/bar.ts'],
    )) as any
    expect(result.success).toBe(true)
    expect(result.discardedCount).toBe(2)
  })

  it('git:stage 仅含 .env → 拒（防止把 .env 暴露到 git 历史）', async () => {
    setDenyWritePathContains('.env')
    const result = (await getHandler('git:stage')({}, '/tmp/proj', ['.env'])) as any
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/deny list|\.env/i)
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it('git:stage 根目录组混有 .env 与普通文件 → 跳过 deny、暂存其余', async () => {
    setDenyWritePathContains('.env')
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '' })
    const result = (await getHandler('git:stage')(
      {},
      '/tmp/proj',
      ['.env', 'README.md', 'package.json'],
    )) as any
    expect(result.success).toBe(true)
    expect(result.skippedPaths).toEqual(['.env'])
    expect(result.skippedCount).toBe(1)
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(1)
    const gitArgs = mocks.execFileAsync.mock.calls[0]?.[1] as string[]
    expect(gitArgs).toEqual(['add', '--', 'README.md', 'package.json'])
  })

  it('git:unstage 仅含 .env → 拒（与 stage 对称）', async () => {
    setDenyWritePathContains('.env')
    const result = (await getHandler('git:unstage')({}, '/tmp/proj', ['.env'])) as any
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/deny list|\.env/i)
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it('git:unstage 混有 .env 与普通文件 → 跳过 deny、取消其余', async () => {
    setDenyWritePathContains('.env')
    // unstage 可能先探测 unborn / restore；这里允许任意 git 调用次数，只断言最终成功与 skipped
    mocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    const result = (await getHandler('git:unstage')(
      {},
      '/tmp/proj',
      ['.env', 'README.md'],
    )) as any
    expect(result.success).toBe(true)
    expect(result.skippedPaths).toEqual(['.env'])
    expect(mocks.execFileAsync).toHaveBeenCalled()
  })

  it('git:stage 全部 path 不含 deny pattern → 整批通过', async () => {
    setDenyWritePathContains('.env')
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '' })
    const result = (await getHandler('git:stage')({}, '/tmp/proj', ['src/x.ts'])) as any
    expect(result.success).toBe(true)
    expect(result.skippedPaths).toBeUndefined()
  })

  it('git:stage 不带 paths（add -A）→ 仅检查 cwd write 权限', async () => {
    setDenyWritePathContains('.env')
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '' })
    const result = (await getHandler('git:stage')({}, '/tmp/proj', undefined)) as any
    // cwd '/tmp/proj' 不含 .env，pass; paths 列表为空跳过 checkPathsWriteAccess
    expect(result.success).toBe(true)
  })
})

describe('Wave 2 · checkpoint IPC handler 接 path-access-checker（Review P1-2 补充）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerCheckpointIpcHandlers()
  })

  it('checkpoint:init checker 拒绝 → success:false + 透传 actionable message（B1 修）', async () => {
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/elsewhere/proj'))
    const handler = getHandler('checkpoint:init')
    const result = (await handler({}, '/var/elsewhere/proj')) as any
    expect(result.success).toBe(false)
    // B1 修：reason.message 必须透传，不能被 'invalid project path' 五字常量吞掉
    expect(result.error).toContain('denied:')
  })

  it('checkpoint:commit checker 拒绝 → success:false + commitHash:null + 透传 message', async () => {
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/elsewhere/proj'))
    const handler = getHandler('checkpoint:commit')
    const result = (await handler({}, '/var/elsewhere/proj')) as any
    expect(result.success).toBe(false)
    expect(result.commitHash).toBeNull()
    expect(result.error).toContain('denied:')
  })

  it('checkpoint:diff（read-only 操作）也按 write 检查 → 拒（语义内聚 P2-1）', async () => {
    // checkpoint 注释里明确：listCommits / diff 等 read-only 操作也按 write
    // 走最严语义。本测试钉死这条反直觉行为，下个 Agent 看到 'write' 改成
    // 'read' 时会被这条测试拦下。
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/elsewhere/proj'))
    const handler = getHandler('checkpoint:diff')
    const result = (await handler({}, '/var/elsewhere/proj', 'abc', 'def')) as any
    expect(result.success).toBe(false)
    expect(result.diffs).toEqual([])
  })

  it('checkpoint:listCommits checker 拒绝 → commits:[]', async () => {
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/elsewhere/proj'))
    const handler = getHandler('checkpoint:listCommits')
    const result = (await handler({}, '/var/elsewhere/proj')) as any
    expect(result.success).toBe(false)
    expect(result.commits).toEqual([])
  })

  it('checkpoint:restore checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/elsewhere/proj'))
    const handler = getHandler('checkpoint:restore')
    const result = (await handler({}, '/var/elsewhere/proj', 'abc123')) as any
    expect(result.success).toBe(false)
  })

  it('checkpoint:gc checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/elsewhere/proj'))
    const handler = getHandler('checkpoint:gc')
    const result = (await handler({}, '/var/elsewhere/proj')) as any
    expect(result.success).toBe(false)
  })

  it('checkpoint:destroy checker 拒绝 → success:false', async () => {
    mocks.pathAccessCheck.mockReturnValue(denyFor('/var/elsewhere/proj'))
    const handler = getHandler('checkpoint:destroy')
    const result = (await handler({}, '/var/elsewhere/proj')) as any
    expect(result.success).toBe(false)
  })

  it('checker 全部 allow → checkpoint handler 走业务路径', async () => {
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    const handler = getHandler('checkpoint:init')
    const result = (await handler({}, '/tmp/proj')) as any
    expect(result.success).toBe(true)
  })

  it('空 projectPath → 早 return（不调 checker）', async () => {
    const handler = getHandler('checkpoint:init')
    const result = (await handler({}, '')) as any
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/required/)
  })
})

// ─── git:isRepo · 仓库根探测语义────────────────────────────────

describe('git:isRepo · 目录本身是否为 Git 仓库根', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statSync.mockReturnValue({ isDirectory: () => true })
    mocks.pathAccessCheck.mockReturnValue({ allowed: true })
    registerGitIpcHandlers()
  })

  it('show-toplevel 与 cwd 一致 → isRepo:true（仓库根）', async () => {
    const repoRoot = '/tmp/home/project'
    mocks.execFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` }
      return { stdout: '' }
    })

    const handler = getHandler('git:isRepo')
    const result = (await handler({}, repoRoot)) as { success: boolean; isRepo: boolean }
    expect(result).toEqual({ success: true, isRepo: true })
  })

  it('show-toplevel 为祖先目录 → isRepo:false（仓库子目录）', async () => {
    const repoRoot = '/tmp/home/project'
    const subDir = '/tmp/home/project/apps/demo'
    mocks.execFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: `${repoRoot}\n` }
      return { stdout: '' }
    })

    const handler = getHandler('git:isRepo')
    const result = (await handler({}, subDir)) as { success: boolean; isRepo: boolean }
    expect(result).toEqual({ success: true, isRepo: false })
  })

  it('rev-parse 失败（不在任何仓库内）→ isRepo:false', async () => {
    mocks.execFileAsync.mockRejectedValue(new Error('not a git repository'))

    const handler = getHandler('git:isRepo')
    const result = (await handler({}, '/tmp/plain-folder')) as { success: boolean; isRepo: boolean }
    expect(result).toEqual({ success: true, isRepo: false })
  })
})
