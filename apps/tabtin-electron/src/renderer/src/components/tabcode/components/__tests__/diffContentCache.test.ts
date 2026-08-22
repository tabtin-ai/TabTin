import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __getDiffContentInflightForTests,
  __getDiffContentQueueDepthForTests,
  __resetDiffContentCacheForTests,
  DIFF_CONTENT_MAX_CONCURRENCY,
  invalidateDiffContentCache,
  loadDiffContents,
  parseGitDiffMetadata,
} from '../diffContentCache'

describe('diffContentCache', () => {
  afterEach(() => {
    __resetDiffContentCacheForTests()
    vi.restoreAllMocks()
  })

  it('解析仅权限位变化的 Git diff 元数据', () => {
    expect(parseGitDiffMetadata(' mode change 100644 => 100755 tool.sh\n')).toEqual({
      oldMode: '100644',
      newMode: '100755',
    })
    expect(parseGitDiffMetadata('old mode 100644\nnew mode 100755\n')).toEqual({
      oldMode: '100644',
      newMode: '100755',
    })
    expect(parseGitDiffMetadata('create mode 100755\n')).toEqual({
      oldMode: null,
      newMode: '100755',
    })
  })

  it('文本内容相同但 Git 有权限变化时返回元数据', async () => {
    const getFileAtHead = vi.fn(async () => ({ content: 'same\n' }))
    const readFilePreview = vi.fn(async () => ({ data: { content: 'same\n' } }))
    const rawDiff = vi.fn(async () => ({
      success: true,
      diff: 'old mode 100644\nnew mode 100755\n',
    }))
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { getFileAtHead, rawDiff },
        fileSystem: { readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    const result = await loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/tool.sh',
      diffMode: 'head',
      contentRevision: 1,
    })

    expect(result).toEqual({
      left: 'same\n',
      right: 'same\n',
      metadataChange: { oldMode: '100644', newMode: '100755' },
    })
    expect(rawDiff).toHaveBeenCalledWith('/repo', ['HEAD', '--', 'tool.sh'])
  })

  it.each([
    ['staged', ['--cached', '--', 'tool.sh']],
    ['unstaged', ['--', 'tool.sh']],
  ] as const)('%s Diff 使用正确的 Git 范围读取权限元数据', async (diffMode, expectedArgs) => {
    const getFileAtHead = vi.fn(async () => ({ content: 'same\n' }))
    const getFileAtStaged = vi.fn(async () => ({ content: 'same\n' }))
    const readFilePreview = vi.fn(async () => ({ data: { content: 'same\n' } }))
    const rawDiff = vi.fn(async () => ({
      success: true,
      diff: 'old mode 100644\nnew mode 100755\n',
    }))
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { getFileAtHead, getFileAtStaged, rawDiff },
        fileSystem: { readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    await loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/tool.sh',
      diffMode,
      contentRevision: 1,
    })

    expect(rawDiff).toHaveBeenCalledWith('/repo', expectedArgs)
  })

  it('相同版本并发请求去重，只读一次磁盘/Git', async () => {
    const getFileAtHead = vi.fn(async () => ({ content: 'old' }))
    const readFilePreview = vi.fn(async () => ({ data: { content: 'new' } }))
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { getFileAtHead, getFileAtStaged: vi.fn(), getFileAtCommit: vi.fn() },
        fileSystem: { readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    const p1 = loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/a.ts',
      diffMode: 'head',
      contentRevision: 1,
    })
    const p2 = loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/a.ts',
      diffMode: 'head',
      contentRevision: 1,
    })
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toEqual({ left: 'old', right: 'new' })
    expect(b).toEqual(a)
    expect(getFileAtHead).toHaveBeenCalledTimes(1)
    expect(readFilePreview).toHaveBeenCalledTimes(1)
  })

  it('contentRevision 变化会重新加载；invalidate 清掉旧缓存', async () => {
    const getFileAtHead = vi
      .fn()
      .mockResolvedValueOnce({ content: 'v1' })
      .mockResolvedValueOnce({ content: 'v2' })
    const readFilePreview = vi
      .fn()
      .mockResolvedValueOnce({ data: { content: 'w1' } })
      .mockResolvedValueOnce({ data: { content: 'w2' } })
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { getFileAtHead },
        fileSystem: { readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    await loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/a.ts',
      diffMode: 'head',
      contentRevision: 1,
    })
    invalidateDiffContentCache('/repo')
    const next = await loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/a.ts',
      diffMode: 'head',
      contentRevision: 2,
    })
    expect(next).toEqual({ left: 'v2', right: 'w2' })
    expect(getFileAtHead).toHaveBeenCalledTimes(2)
  })

  it('超过并发上限时排队，不一次性打满 IPC', async () => {
    const gates: Array<() => void> = []
    const getFileAtHead = vi.fn(() => new Promise<{ content: string }>((resolve) => {
      gates.push(() => resolve({ content: 'old' }))
    }))
    const readFilePreview = vi.fn(async () => ({ data: { content: 'new' } }))
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { getFileAtHead },
        fileSystem: { readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    const tasks = Array.from({ length: 5 }, (_, i) => loadDiffContents({
      rootPath: '/repo',
      filePath: `/repo/f${i}.ts`,
      diffMode: 'head',
      contentRevision: 1,
    }))

    await new Promise((r) => setTimeout(r, 0))
    expect(__getDiffContentInflightForTests()).toBe(DIFF_CONTENT_MAX_CONCURRENCY)
    expect(__getDiffContentQueueDepthForTests()).toBe(5 - DIFF_CONTENT_MAX_CONCURRENCY)
    expect(getFileAtHead).toHaveBeenCalledTimes(DIFF_CONTENT_MAX_CONCURRENCY)

    // 放行全部
    for (let round = 0; round < 8; round += 1) {
      const pending = gates.splice(0, gates.length)
      pending.forEach((release) => release())
      await new Promise((r) => setTimeout(r, 0))
      if (__getDiffContentInflightForTests() === 0 && __getDiffContentQueueDepthForTests() === 0) break
    }
    await Promise.all(tasks)
    expect(getFileAtHead).toHaveBeenCalledTimes(5)
  })

  it('定位选中的路径优先于普通视口排队项', async () => {
    const gates: Array<() => void> = []
    const started: string[] = []
    const getFileAtHead = vi.fn((_root: string, filePath: string) => new Promise<{ content: string }>((resolve) => {
      started.push(filePath)
      gates.push(() => resolve({ content: filePath }))
    }))
    const readFilePreview = vi.fn(async () => ({ data: { content: 'new' } }))
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { getFileAtHead },
        fileSystem: { readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    const first = loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/normal-0.ts',
      diffMode: 'head',
      contentRevision: 1,
    })
    const second = loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/normal-1.ts',
      diffMode: 'head',
      contentRevision: 1,
    })
    const normal = loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/normal-2.ts',
      diffMode: 'head',
      contentRevision: 1,
    })
    const selected = loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/selected.ts',
      diffMode: 'head',
      contentRevision: 1,
      priority: true,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['normal-0.ts', 'normal-1.ts'])
    gates.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toContain('selected.ts')
    expect(started).not.toContain('normal-2.ts')

    for (let round = 0; round < 8; round += 1) {
      gates.splice(0).forEach((release) => release())
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (__getDiffContentInflightForTests() === 0 && __getDiffContentQueueDepthForTests() === 0) break
    }
    await Promise.all([first, second, normal, selected])
  })

  it('工作区临时读取失败时拒绝加载，不伪装成空内容', async () => {
    const getFileAtHead = vi.fn(async () => ({ content: 'old' }))
    const readFilePreview = vi.fn(async () => {
      throw new Error('temporary IPC failure')
    })
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { getFileAtHead },
        fileSystem: { readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    await expect(loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/a.ts',
      diffMode: 'head',
      contentRevision: 1,
    })).rejects.toThrow('temporary IPC failure')
  })

  it('新文件缺失 HEAD 时 left 为精确空串，不污染成换行', async () => {
    const getFileAtHead = vi.fn(async () => ({ content: '' }))
    const readFilePreview = vi.fn(async () => ({
      data: { content: 'first line\nsecond\n' },
    }))
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { getFileAtHead },
        fileSystem: { readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    const sides = await loadDiffContents({
      rootPath: '/repo',
      filePath: '/repo/brand-new.ts',
      diffMode: 'head',
      contentRevision: 1,
    })
    expect(sides.left).toBe('')
    expect(sides.left).not.toBe('\n')
    expect(sides.right.startsWith('first line')).toBe(true)
  })
})
