/**
 * CG-001 / CG-002 / CG-008 回归测试 (Daemon 版)
 *
 * CG-001: getDiff(from, to) 两个 commit 间比较时不应调用 addFiles（无写副作用）
 * CG-002: getDiff(from) 对 "当前状态" 应从 shadow index 读取，而非磁盘
 * CG-008: diffRange 语义与 after 读取基准对齐
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    readFile: vi.fn().mockResolvedValue('disk-content-should-not-appear'),
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

vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue(mockGit),
}))

vi.mock('node:fs/promises', () => ({ default: mockFs }))

const mockLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}

import { CheckpointService } from '../src/platform/workspace/checkpoint/CheckpointService.js'

describe('CG-001/CG-002/CG-008: getDiff 数据一致性 (Daemon)', () => {
  let service: CheckpointService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', mockLogger as any)
    ;(service as any).initialized = true
  })

  // ── CG-001 ──

  describe('CG-001: toHash 有值时不调用 addFiles', () => {
    it('两个 commit 间比较不触发 git add', async () => {
      mockGit.diffSummary.mockResolvedValue({ files: [] })

      await service.getDiff('aaa111', 'bbb222')

      expect(mockGit.add).not.toHaveBeenCalled()
    })

    it('toHash 缺省时正常调用 git add', async () => {
      mockGit.diffSummary.mockResolvedValue({ files: [] })

      await service.getDiff('aaa111')

      expect(mockGit.add).toHaveBeenCalledWith(['.', '--ignore-errors'])
    })
  })

  // ── CG-002 ──

  describe('CG-002: after 从 shadow index 读取', () => {
    it('toHash 缺省时 after 通过 git show :path 读取 index', async () => {
      mockGit.diffSummary.mockResolvedValue({
        files: [{ file: 'src/main.ts' }],
      })
      mockGit.show.mockImplementation(async (args: string[]) => {
        if (args[0] === ':src/main.ts') return 'index-content'
        if (args[0] === 'aaa111:src/main.ts') return 'before-content'
        return ''
      })

      const entries = await service.getDiff('aaa111')

      expect(entries).toHaveLength(1)
      expect(entries[0].after).toBe('index-content')
      expect(entries[0].before).toBe('before-content')
    })

    it('toHash 缺省时不从磁盘读取 after', async () => {
      mockGit.diffSummary.mockResolvedValue({
        files: [{ file: 'src/main.ts' }],
      })
      mockGit.show.mockResolvedValue('some-content')

      await service.getDiff('aaa111')

      expect(mockFs.readFile).not.toHaveBeenCalled()
    })

    it('toHash 有值时 after 通过 git show commitHash:path 读取', async () => {
      mockGit.diffSummary.mockResolvedValue({
        files: [{ file: 'src/main.ts' }],
      })
      mockGit.show.mockImplementation(async (args: string[]) => {
        if (args[0] === 'bbb222:src/main.ts') return 'to-commit-content'
        if (args[0] === 'aaa111:src/main.ts') return 'from-commit-content'
        return ''
      })

      const entries = await service.getDiff('aaa111', 'bbb222')

      expect(entries).toHaveLength(1)
      expect(entries[0].after).toBe('to-commit-content')
      expect(entries[0].before).toBe('from-commit-content')
    })
  })

  // ── CG-008 ──

  describe('CG-008: diffRange 语义与 after 基准对齐', () => {
    it('toHash 缺省时 diffSummary 使用单 hash，after 也从 index 读取', async () => {
      mockGit.diffSummary.mockResolvedValue({
        files: [{ file: 'README.md' }],
      })
      mockGit.show.mockResolvedValue('content')

      await service.getDiff('abc000')

      expect(mockGit.diffSummary).toHaveBeenCalledWith(['abc000'])
      const afterShowCall = mockGit.show.mock.calls.find(
        (c: any) => c[0][0] === ':README.md'
      )
      expect(afterShowCall).toBeDefined()
    })

    it('toHash 有值时 diffSummary 使用 from..to 范围', async () => {
      mockGit.diffSummary.mockResolvedValue({ files: [] })

      await service.getDiff('abc000', 'def111')

      expect(mockGit.diffSummary).toHaveBeenCalledWith(['abc000..def111'])
    })

    it('已删除文件在 index 中不存在时 after 为空字符串', async () => {
      mockGit.diffSummary.mockResolvedValue({
        files: [{ file: 'deleted.ts' }],
      })
      mockGit.show.mockImplementation(async (args: string[]) => {
        if (args[0] === ':deleted.ts') throw new Error('not found')
        if (args[0] === 'aaa:deleted.ts') return 'old-content'
        return ''
      })

      const entries = await service.getDiff('aaa')

      expect(entries).toHaveLength(1)
      expect(entries[0].before).toBe('old-content')
      expect(entries[0].after).toBe('')
    })
  })
})
