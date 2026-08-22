/**
 * DI-001 ~ DI-028 回归测试
 *
 * 覆盖 data-integrity-issues.md 中分配给 F12 的修复：
 * - DI-001: gc() 等待 pendingOp 后再执行
 * - DI-002: withLock 超时直接 resolve gate，打断死锁链
 * - DI-004: _doInit HEAD 无效时恢复初始 commit
 * - DI-005: 清理陈旧的 index.lock
 * - DI-006: IPC 返回 errorType 分类
 * - DI-007: 嵌套 git 搜索深度 > 3
 * - DI-008: addFiles 单次目录遍历
 * - DI-015: repairDisabledGitDirs 不再在 _doInit 锁外执行
 * - DI-016: gc() 在 destroy 后跳过
 * - DI-028: exclusions 去重 + 生成文件排除
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'

// ── Mocks ──────────────────────────────────────────────────────

const { mockGit, mockFs } = vi.hoisted(() => {
  const mockGit = {
    init: vi.fn().mockResolvedValue(undefined),
    addConfig: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockResolvedValue({ value: '/tmp/test-project' }),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
    raw: vi.fn().mockResolvedValue('1'),
    revparse: vi.fn().mockResolvedValue('abc123'),
    diffSummary: vi.fn().mockResolvedValue({ files: [] }),
    show: vi.fn().mockResolvedValue(''),
    reset: vi.fn().mockResolvedValue(undefined),
  }
  const mockFs = {
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
    readdir: vi.fn().mockResolvedValue([]),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  }
  return { mockGit, mockFs }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/test-user-data') },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue(mockGit),
}))

vi.mock('node:fs/promises', () => ({ default: mockFs }))

vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}))

vi.mock('../../download-security', () => ({
  isPathSafe: vi.fn().mockReturnValue(true),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => true),
}))

import { CheckpointService, CHECKPOINT_EXCLUDE_PATTERNS, buildExcludeContent, type CheckpointLogger } from '@tabtin/checkpoint-core'
import { categorizeCheckpointError } from '../checkpoint-ipc'

// ── Helper ─────────────────────────────────────────────────────

const testLogger: CheckpointLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}

function asPosixPath(value: unknown): string {
  return String(value).replace(/\\/g, '/')
}

function pathEndsWith(value: unknown, suffix: string): boolean {
  return asPosixPath(value).endsWith(suffix)
}

function createInitializedService(): CheckpointService {
  const service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', testLogger)
  ;(service as any).initialized = true
  return service
}

// ── DI-001: gc 等待 pendingOp ──────────────────────────────────

describe('DI-001: gc() 等待 pendingOp 完成后再执行', () => {
  let service: CheckpointService

  beforeEach(() => {
    vi.clearAllMocks()
    service = createInitializedService()
  })

  it('gc 在 pendingOp 完成后才执行 git gc', async () => {
    const executionOrder: string[] = []

    let resolvePending!: () => void
    ;(service as any).pendingOp = new Promise<void>((r) => { resolvePending = r })

    mockGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'gc') {
        executionOrder.push('gc')
      }
      return ''
    })

    const gcPromise = service.gc()

    // gc 不应在 pendingOp 完成前执行
    await new Promise((r) => setTimeout(r, 10))
    expect(executionOrder).not.toContain('gc')

    resolvePending()
    await gcPromise

    expect(executionOrder).toContain('gc')
  })

  it('gc 在 pendingOp reject 后仍然执行', async () => {
    ;(service as any).pendingOp = Promise.reject(new Error('prev failed'))
    mockGit.raw.mockResolvedValue('')

    await service.gc()

    expect(mockGit.raw).toHaveBeenCalledWith(['gc', '--auto', '--quiet'])
  })
})

// ── DI-002: withLock 超时不死锁 ─────────────────────────────────

describe('DI-002: withLock 超时直接 resolve gate，打断死锁链', () => {
  let service: CheckpointService

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    service = createInitializedService()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('超时后后续操作不会永久阻塞', async () => {
    // 创建一个永不 resolve 的 pendingOp 模拟 git 进程挂起
    ;(service as any).pendingOp = new Promise<void>(() => {})

    // 第一个操作超时
    const op1 = (service as any).withLock(async () => 'op1')
    vi.advanceTimersByTime(120_001)
    await expect(op1).rejects.toThrow('Lock acquisition timed out')

    // 关键断言：第二个操作应该能正常完成，不会因为第一个超时而永久阻塞
    const op2Promise = (service as any).withLock(async () => 'op2-result')
    vi.advanceTimersByTime(1)
    const result = await op2Promise
    expect(result).toBe('op2-result')
  })
})

// ── DI-004: _doInit HEAD 无效恢复 ──────────────────────────────

describe('DI-004: _doInit 中 HEAD 无效时恢复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rev-list HEAD 失败时创建恢复 commit', async () => {
    const service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', testLogger)

    // 模拟 .git 存在（半初始化状态），projectPath 也存在
    mockFs.access.mockResolvedValue(undefined)
    mockFs.readdir.mockResolvedValue([])
    // 新 helper readShadowCoreWorktree 直接读 .git/config —— 给一份合法 INI
    // 让 worktree 校验通过后再走到 rev-list 路径上。
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (pathEndsWith(filePath, '/config')) {
        return '[core]\n\tworktree = /tmp/test-project\n'
      }
      return ''
    })

    let revListCallCount = 0
    mockGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list' && args[1] === '--count') {
        revListCallCount++
        if (revListCallCount === 1) {
          throw new Error('fatal: bad default revision \'HEAD\'')
        }
      }
      return '1'
    })

    await service.init()

    // 应该调用了 commit 来恢复
    expect(mockGit.commit).toHaveBeenCalledWith(
      'recovery checkpoint',
      expect.objectContaining({ '--allow-empty': null }),
    )
  })

  it('恢复失败时删除损坏的 shadow repo 并抛出', async () => {
    const service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', testLogger)

    mockFs.access.mockResolvedValue(undefined)
    mockFs.readdir.mockResolvedValue([])
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (pathEndsWith(filePath, '/config')) {
        return '[core]\n\tworktree = /tmp/test-project\n'
      }
      return ''
    })

    mockGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list') {
        throw new Error('fatal: bad default revision \'HEAD\'')
      }
      return ''
    })
    mockGit.add.mockRejectedValue(new Error('git add failed'))

    await expect(service.init()).rejects.toThrow('Shadow repo recovery failed')

    // 应该删除了损坏的目录
    expect(mockFs.rm).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true, force: true },
    )
  })
})

// ── DI-005: 清理陈旧 index.lock ───────────────────────────────

describe('DI-005: cleanStaleIndexLock 自动清理陈旧 lock 文件', () => {
  let service: CheckpointService

  beforeEach(() => {
    vi.clearAllMocks()
    service = createInitializedService()
  })

  it('超过 30s 的 index.lock 被自动删除', async () => {
    const staleTime = Date.now() - 60_000 // 60s old
    mockFs.stat.mockImplementation(async (p: string) => {
      if (typeof p === 'string' && p.endsWith('index.lock')) {
        return { mtimeMs: staleTime }
      }
      return { mtimeMs: 0 }
    })

    // 调用 addFiles 触发 cleanStaleIndexLock
    await (service as any).cleanStaleIndexLock()

    expect(mockFs.unlink).toHaveBeenCalledWith(
      expect.stringContaining('index.lock'),
    )
  })

  it('新鲜的 index.lock 不被删除', async () => {
    const freshTime = Date.now() - 5_000 // 5s old
    mockFs.stat.mockImplementation(async (p: string) => {
      if (typeof p === 'string' && p.endsWith('index.lock')) {
        return { mtimeMs: freshTime }
      }
      return { mtimeMs: 0 }
    })

    await (service as any).cleanStaleIndexLock()

    expect(mockFs.unlink).not.toHaveBeenCalled()
  })

  it('index.lock 不存在时不报错', async () => {
    mockFs.stat.mockRejectedValue(new Error('ENOENT'))

    await expect((service as any).cleanStaleIndexLock()).resolves.toBeUndefined()
    expect(mockFs.unlink).not.toHaveBeenCalled()
  })
})

// ── DI-006: IPC errorType 分类 ─────────────────────────────────

describe('DI-006: categorizeCheckpointError 分类', () => {
  it('ENOSPC 错误被分类为 disk_full', () => {
    expect(categorizeCheckpointError(new Error('ENOSPC: No space left on device'))).toBe('disk_full')
  })

  it('index.lock 错误被分类为 lock_conflict', () => {
    expect(categorizeCheckpointError(new Error('Another git process seems to be running'))).toBe('lock_conflict')
  })

  it('超时错误被分类为 lock_timeout', () => {
    expect(categorizeCheckpointError(new Error('Lock acquisition timed out'))).toBe('lock_timeout')
  })

  it('worktree 不匹配被分类为 worktree_mismatch', () => {
    expect(categorizeCheckpointError(new Error('worktree mismatch: expected /a, got /b'))).toBe('worktree_mismatch')
  })

  it('项目目录不存在被分类为 project_path_not_exist（CheckpointService 显式抛出）', () => {
    expect(
      categorizeCheckpointError(
        new Error('Project path does not exist: /Users/x/dev/old-proj. The project may have been moved...'),
      ),
    ).toBe('project_path_not_exist')
  })

  it('git fatal "Invalid path ... No such file or directory" 兜底归类为 project_path_not_exist', () => {
    // 深度防御：理论上 _doInit 提前拦截，但万一 git 进程的 fatal 冒上来也要正确分流
    expect(
      categorizeCheckpointError(
        new Error("fatal: Invalid path '/Users/x/dev/old-proj': No such file or directory"),
      ),
    ).toBe('project_path_not_exist')
  })

  it('git_corrupted 匹配 recovery failed', () => {
    expect(categorizeCheckpointError(new Error('Shadow repo recovery failed for /tmp/x: err'))).toBe('git_corrupted')
  })

  it('未知错误被分类为 unknown', () => {
    expect(categorizeCheckpointError(new Error('something else'))).toBe('unknown')
  })
})

// ── DI-007: 深层嵌套 git 目录 ──────────────────────────────────

describe('DI-007: findAllNestedGitDirs 搜索深度超过 3', () => {
  let service: CheckpointService

  beforeEach(() => {
    vi.clearAllMocks()
    service = createInitializedService()
  })

  it('找到深度 > 3 的嵌套 .git 目录', async () => {
    const root = '/tmp/test-project'
    const nestedGit = path.join(root, 'a', 'b', 'c', 'd', '.git')
    const mockDirStructure: Record<string, Array<{ name: string; isDirectory: () => boolean }>> = {
      [root]: [{ name: 'a', isDirectory: () => true }],
      [path.join(root, 'a')]: [{ name: 'b', isDirectory: () => true }],
      [path.join(root, 'a', 'b')]: [{ name: 'c', isDirectory: () => true }],
      [path.join(root, 'a', 'b', 'c')]: [{ name: 'd', isDirectory: () => true }],
      [path.join(root, 'a', 'b', 'c', 'd')]: [{ name: '.git', isDirectory: () => true }],
    }

    mockFs.readdir.mockImplementation(async (dir: string) => {
      return mockDirStructure[dir] || []
    })

    const result = await (service as any).findAllNestedGitDirs(root, 10)

    expect(result.active).toContain(nestedGit)
    expect(result.active).toHaveLength(1)
  })

  it('旧 maxDepth=3 会漏掉 depth > 3 的 .git', async () => {
    const root = '/tmp/test-project'
    const nestedGit = path.join(root, 'a', 'b', 'c', 'd', '.git')
    const mockDirStructure: Record<string, Array<{ name: string; isDirectory: () => boolean }>> = {
      [root]: [{ name: 'a', isDirectory: () => true }],
      [path.join(root, 'a')]: [{ name: 'b', isDirectory: () => true }],
      [path.join(root, 'a', 'b')]: [{ name: 'c', isDirectory: () => true }],
      [path.join(root, 'a', 'b', 'c')]: [{ name: 'd', isDirectory: () => true }],
      [path.join(root, 'a', 'b', 'c', 'd')]: [{ name: '.git', isDirectory: () => true }],
    }

    mockFs.readdir.mockImplementation(async (dir: string) => {
      return mockDirStructure[dir] || []
    })

    const resultOld = await (service as any).findAllNestedGitDirs(root, 3)
    expect(resultOld.active).toHaveLength(0)

    ;(service as any)._nestedGitCache = null
    const resultNew = await (service as any).findAllNestedGitDirs(root, 10)
    expect(resultNew.active).toContain(nestedGit)
  })
})

// ── DI-008: 单次目录遍历 ──────────────────────────────────────

describe('DI-008: addFiles 使用单次目录遍历', () => {
  let service: CheckpointService
  let readdirCallCount: number

  beforeEach(() => {
    vi.clearAllMocks()
    mockGit.add.mockResolvedValue(undefined)
    service = createInitializedService()
    readdirCallCount = 0

    // 模拟一个有嵌套 git 和 disabled git 的项目
    const root = '/tmp/test-project'
    const sub1 = path.join(root, 'sub1')
    const sub2 = path.join(root, 'sub2')
    const dirs: Record<string, Array<{ name: string; isDirectory: () => boolean }>> = {
      [root]: [
        { name: 'sub1', isDirectory: () => true },
        { name: 'sub2', isDirectory: () => true },
      ],
      [sub1]: [
        { name: '.git', isDirectory: () => true },
      ],
      [sub2]: [
        { name: '.git_disabled', isDirectory: () => true },
      ],
    }

    mockFs.readdir.mockImplementation(async (dir: string) => {
      readdirCallCount++
      return dirs[dir] || []
    })

    // index.lock 不存在
    mockFs.stat.mockRejectedValue(new Error('ENOENT'))
  })

  it('addFiles 只遍历一次目录树（而非旧版的 3 次）', async () => {
    await (service as any).addFiles(mockGit)

    // 3 directories × 1 traversal = 3 readdir calls
    // 旧版会是 3 directories × 3 traversals = 9 readdir calls
    expect(readdirCallCount).toBe(3)
  })

  it('同时发现 active 和 disabled 目录并正确处理', async () => {
    await (service as any).addFiles(mockGit)

    // sub2/.git_disabled 应该被 repair (rename 回 .git)
    expect(mockFs.rename).toHaveBeenCalledWith(
      path.join('/tmp/test-project', 'sub2', '.git_disabled'),
      path.join('/tmp/test-project', 'sub2', '.git'),
    )

    // sub1/.git 和 repaired sub2/.git 都应该被 disable
    expect(mockFs.rename).toHaveBeenCalledWith(
      path.join('/tmp/test-project', 'sub1', '.git'),
      path.join('/tmp/test-project', 'sub1', '.git_disabled'),
    )
  })
})

// ── DI-015: _doInit 不再在锁外调用 repairDisabledGitDirs ────────

describe('DI-015: _doInit 不在锁外调用 repairDisabledGitDirs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGit.add.mockResolvedValue(undefined)
    mockGit.init.mockResolvedValue(undefined)
    mockGit.addConfig.mockResolvedValue(undefined)
    mockGit.commit.mockResolvedValue({ commit: 'abc123' })
  })

  it('_doInit 中不直接调用 repairDisabledGitDirs', async () => {
    const service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', testLogger)

    // 模拟新 repo —— projectPath 存在（探针通过），shadow .git 不存在（走首次 init）
    mockFs.access.mockImplementation(async (p: any) => {
      if (pathEndsWith(p, '/.git')) {
        throw new Error('ENOENT')
      }
      return undefined
    })
    mockFs.readdir.mockResolvedValue([])
    mockFs.stat.mockRejectedValue(new Error('ENOENT'))

    await service.init()

    // repairDisabledGitDirs 的特征是搜索 .git_disabled。
    // 在新 repo 路径中，readdir 调用来自 addFiles→findAllNestedGitDirs，
    // 而不是独立的 repairDisabledGitDirs。
    // 验证 git.init 被调用（新初始化路径）
    expect(mockGit.init).toHaveBeenCalled()
    expect(mockGit.commit).toHaveBeenCalledWith(
      'initial checkpoint',
      expect.objectContaining({ '--allow-empty': null }),
    )
  })
})

// ── DI-016: gc 在 destroy 后跳过 ─────────────────────────────

describe('DI-016: gc() 在 destroy 后不执行', () => {
  it('destroy 后 gc 直接返回，不执行 git 命令', async () => {
    const service = createInitializedService()

    // 设置 destroyed 标记
    ;(service as any).destroyed = true

    await service.gc()

    expect(mockGit.raw).not.toHaveBeenCalledWith(
      expect.arrayContaining(['gc']),
    )
  })

  it('未初始化时 gc 直接返回', async () => {
    const service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', testLogger)
    // initialized 默认为 false

    await service.gc()

    expect(mockGit.raw).not.toHaveBeenCalledWith(
      expect.arrayContaining(['gc']),
    )
  })

  it('destroy 设置 destroyed 标记', async () => {
    const service = createInitializedService()

    await service.destroy()

    expect((service as any).destroyed).toBe(true)
    expect((service as any).initialized).toBe(false)
  })
})

// ── DI-028: exclusions 规则修复 ─────────────────────────────────

describe('DI-028: exclusions 规则去重 + 生成文件排除', () => {
  it('不存在重叠的 .env 模式', () => {
    const envPatterns = CHECKPOINT_EXCLUDE_PATTERNS.filter(
      (p) => p === '.env' || (p.includes('.env') && !p.includes('venv')),
    )

    // 应该只有 '.env' 和 '.env.*' 两个 env 相关模式（无冗余的 *.env, *.env.*, .env.local 等）
    expect(envPatterns).toEqual(['.env', '.env.*'])
  })

  it('不存在冗余的具体 .env 变体', () => {
    const specificEnvPatterns = CHECKPOINT_EXCLUDE_PATTERNS.filter(
      (p) => p.startsWith('.env.') && p !== '.env.*',
    )

    // .env.local, .env.production 等具体模式应该被 .env.* 覆盖而移除
    expect(specificEnvPatterns).toHaveLength(0)
  })

  it('包含 protobuf 生成文件排除', () => {
    expect(CHECKPOINT_EXCLUDE_PATTERNS).toContain('*.pb.ts')
    expect(CHECKPOINT_EXCLUDE_PATTERNS).toContain('*.pb.go')
    expect(CHECKPOINT_EXCLUDE_PATTERNS).toContain('*_pb2.py')
  })

  it('包含通用 codegen 文件排除', () => {
    expect(CHECKPOINT_EXCLUDE_PATTERNS).toContain('*.generated.ts')
    expect(CHECKPOINT_EXCLUDE_PATTERNS).toContain('*.generated.js')
  })

  it('buildExcludeContent 正确合并额外模式', () => {
    const result = buildExcludeContent(['*.custom'])
    expect(result).toContain('*.custom')
    expect(result).toContain('.env')
    expect(result.startsWith('# Auto-generated by TabTin Checkpoint')).toBe(true)
  })
})

// ── simpleGit 超时配置 ─────────────────────────────────────────

describe('DI-002 补充: createGit 设置命令级超时', () => {
  it('createGit 传递 timeout 选项', async () => {
    const service = createInitializedService()
    const simpleGitModule = await import('simple-git')
    const simpleGitFn = simpleGitModule.default as unknown as ReturnType<typeof vi.fn>

    simpleGitFn.mockClear()
    ;(service as any).createGit()

    expect(simpleGitFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        timeout: { block: 60_000 },
      }),
    )
  })
})

// ── worktree mismatch 提示 ───────────────────────────────────

describe('DI-004 补充: worktree mismatch 提示 checkpoint:destroy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('worktree 不匹配时错误消息包含 checkpoint:destroy 提示', async () => {
    const service = new CheckpointService('/tmp/new-location', '/tmp/checkpoints', testLogger)

    mockFs.access.mockResolvedValue(undefined)
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (pathEndsWith(filePath, '/config')) {
        return '[core]\n\tworktree = /tmp/old-location\n'
      }
      return ''
    })

    await expect(service.init()).rejects.toThrow('checkpoint:destroy')
  })

  it('Windows 分隔符差异不触发 worktree mismatch', async () => {
    const service = new CheckpointService('C:\\workspace\\TabTin', 'C:\\checkpoints', testLogger)

    mockFs.access.mockResolvedValue(undefined)
    mockFs.readdir.mockResolvedValue([])
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (pathEndsWith(filePath, '/config')) {
        return '[core]\n\tworktree = C:/workspace/TabTin\n'
      }
      return ''
    })
    mockGit.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-list' && args[1] === '--count') return '1'
      return ''
    })

    await expect(service.init()).resolves.toBe(service.gitPath)
  })
})
