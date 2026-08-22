import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RIPGREP_DEFAULT_PER_FILE_MAX_COUNT,
  RIPGREP_LOAD_MORE_PER_FILE_MAX_COUNT,
} from '@shared/ripgrep-search-types'
import { useKeywordSearch } from '../useKeywordSearch'

type SearchResponse = Awaited<ReturnType<typeof window.tabtin.fileSystem.ripgrepSearch>>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useKeywordSearch', () => {
  const rootPath = '/workspace/project'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('同时请求文件名与内容匹配，并过滤不能在代码预览中打开的目录结果', async () => {
    const ripgrepSearch = vi.fn(async (): Promise<SearchResponse> => ({
      success: true,
      results: [
        {
          file: `${rootPath}/src/needle.ts`,
          line: 4,
          column: 0,
          text: 'const needle = true',
          matchText: 'needle',
          matchKind: 'content',
        },
        {
          file: `${rootPath}/needle-file.ts`,
          line: 0,
          column: 0,
          text: 'needle-file.ts',
          matchText: 'needle',
          matchKind: 'path',
          isDirectory: false,
        },
        {
          file: `${rootPath}/needle-dir`,
          line: 0,
          column: 0,
          text: 'needle-dir',
          matchText: 'needle',
          matchKind: 'path',
          isDirectory: true,
        },
      ],
    }))
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    await act(async () => {
      await result.current.search('needle')
    })

    expect(ripgrepSearch).toHaveBeenCalledWith(expect.objectContaining({
      cwd: rootPath,
      pattern: 'needle',
      includePathMatches: true,
    }))
    expect(result.current.results.map(group => group.relativePath)).toEqual([
      'src/needle.ts',
      'needle-file.ts',
    ])
    expect(result.current.totalMatches).toBe(2)
  })

  it('快速连续搜索时丢弃较晚返回的旧请求', async () => {
    const oldRequest = deferred<SearchResponse>()
    const newRequest = deferred<SearchResponse>()
    const ripgrepSearch = vi.fn((options: { pattern: string }) => (
      options.pattern === 'old' ? oldRequest.promise : newRequest.promise
    ))
    const ripgrepSearchCancel = vi.fn(async () => ({ success: true, canceled: true }))
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    act(() => {
      void result.current.search('old')
      void result.current.search('new')
    })

    await act(async () => {
      newRequest.resolve({
        success: true,
        results: [{
          file: `${rootPath}/new.ts`,
          line: 1,
          column: 0,
          text: 'new',
          matchText: 'new',
          matchKind: 'content',
        }],
      })
    })
    await waitFor(() => {
      expect(result.current.results[0]?.relativePath).toBe('new.ts')
    })

    await act(async () => {
      oldRequest.resolve({
        success: true,
        results: [{
          file: `${rootPath}/old.ts`,
          line: 1,
          column: 0,
          text: 'old',
          matchText: 'old',
          matchKind: 'content',
        }],
      })
    })

    expect(result.current.results[0]?.relativePath).toBe('new.ts')
  })

  it('透传搜索选项，并消费 ranges/truncated', async () => {
    const ripgrepSearch = vi.fn(async (
      _options: { requestId?: string },
    ): Promise<SearchResponse> => ({
      success: true,
      truncated: true,
      results: [{
        file: `${rootPath}/source.ts`,
        line: 1,
        column: 5,
        text: '中文测试 foo foo',
        matchText: 'foo',
        ranges: [{ start: 5, end: 8 }, { start: 9, end: 12 }],
        matchKind: 'content',
      }],
    }))
    const ripgrepSearchCancel = vi.fn(async () => ({ success: true, canceled: true }))
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    await act(async () => {
      await result.current.search('foo', {
        matchCase: true,
        wholeWord: true,
        isRegex: true,
        glob: '*.ts',
        excludeGlob: '*.test.ts',
        includeIgnored: true,
      })
    })

    expect(ripgrepSearch).toHaveBeenCalledWith(expect.objectContaining({
      pattern: 'foo',
      matchCase: true,
      wholeWord: true,
      isRegex: true,
      glob: '*.ts',
      excludeGlob: '*.test.ts',
      includeIgnored: true,
      includePathMatches: false,
      requestId: expect.any(String),
    }))
    expect(typeof ripgrepSearch.mock.calls[0][0].requestId).toBe('string')
    expect(ripgrepSearch.mock.calls[0][0].requestId.length).toBeGreaterThan(0)
    expect(ripgrepSearch.mock.calls[0][0].requestId.length).toBeLessThanOrEqual(128)
    expect(result.current.results[0]?.matches[0]?.ranges).toHaveLength(2)
    expect(result.current.totalMatches).toBe(2)
    expect(result.current.truncated).toBe(true)
    // 旧主进程只回 truncated 时，内容截断兜底为 true，避免替换门禁漏拦。
    expect(result.current.contentTruncated).toBe(true)
    expect(result.current.pathMatchesTruncated).toBe(false)
  })

  it('分别映射内容截断与路径遍历截断，清空后复位', async () => {
    const ripgrepSearch = vi.fn(async (): Promise<SearchResponse> => ({
      success: true,
      truncated: true,
      contentTruncated: false,
      pathMatchesTruncated: true,
      results: [{
        file: `${rootPath}/source.ts`,
        line: 1,
        column: 0,
        text: 'needle',
        matchText: 'needle',
        matchKind: 'content',
      }],
    }))
    const ripgrepSearchCancel = vi.fn(async () => ({ success: true, canceled: true }))
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    await act(async () => {
      await result.current.search('needle')
    })

    expect(result.current.truncated).toBe(true)
    expect(result.current.contentTruncated).toBe(false)
    expect(result.current.pathMatchesTruncated).toBe(true)

    act(() => {
      result.current.clear()
    })
    expect(result.current.truncated).toBe(false)
    expect(result.current.contentTruncated).toBe(false)
    expect(result.current.pathMatchesTruncated).toBe(false)
  })

  it('有 replacement 预览时按 submatch 展平，保留主进程返回的文本与 byte range', async () => {
    const ripgrepSearch = vi.fn(async (): Promise<SearchResponse> => ({
      success: true,
      results: [{
        file: `${rootPath}/source.ts`,
        line: 1,
        column: 0,
        text: 'foo foo',
        matchText: 'foo',
        matchKind: 'content',
        replacements: [
          {
            byteRange: { start: 0, end: 3 },
            range: { start: 0, end: 3 },
            matchText: 'foo',
            replacement: 'bar',
          },
          {
            byteRange: { start: 4, end: 7 },
            range: { start: 4, end: 7 },
            matchText: 'foo',
            replacement: 'baz',
          },
        ],
      }],
    }))
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel: vi.fn() } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    await act(async () => {
      await result.current.search('foo', { replace: 'bar' })
    })

    expect(result.current.results[0]?.matches).toEqual([
      expect.objectContaining({
        matchText: 'foo',
        replacement: 'bar',
        byteRange: { start: 0, end: 3 },
        ranges: [{ start: 0, end: 3 }],
      }),
      expect.objectContaining({
        matchText: 'foo',
        replacement: 'baz',
        byteRange: { start: 4, end: 7 },
        ranges: [{ start: 4, end: 7 }],
      }),
    ])
    expect(result.current.totalMatches).toBe(2)
  })

  it('取消时调用主进程 cancel channel，且不展示取消错误', async () => {
    const pending = deferred<SearchResponse>()
    const ripgrepSearch = vi.fn(() => pending.promise)
    const ripgrepSearchCancel = vi.fn(async () => ({ success: true, canceled: true }))
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    act(() => {
      void result.current.search('foo')
    })
    await waitFor(() => expect(ripgrepSearch).toHaveBeenCalled())

    act(() => {
      result.current.cancel()
    })

    expect(ripgrepSearchCancel).toHaveBeenCalledWith(expect.any(String))
    expect(result.current.isSearching).toBe(false)
    expect(result.current.error).toBeNull()
    await act(async () => {
      pending.resolve({ success: false, canceled: true, results: [] })
      await Promise.resolve()
    })
  })

  it('空 pattern 会取消并清理正在运行的请求', async () => {
    const pending = deferred<SearchResponse>()
    const ripgrepSearch = vi.fn(() => pending.promise)
    const ripgrepSearchCancel = vi.fn(async () => ({ success: true, canceled: true }))
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    act(() => {
      void result.current.search('foo')
    })
    await waitFor(() => expect(ripgrepSearch).toHaveBeenCalled())
    const requestId = ripgrepSearch.mock.calls[0][0].requestId

    await act(async () => {
      await result.current.search('  ')
    })

    expect(ripgrepSearchCancel).toHaveBeenCalledWith(requestId)
    expect(result.current.isSearching).toBe(false)
    pending.resolve({ success: false, canceled: true, results: [] })
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('新搜索开始时清空旧结果，并生成跨实例唯一 requestId', async () => {
    const first = deferred<SearchResponse>()
    const second = deferred<SearchResponse>()
    const ripgrepSearch = vi.fn((options: { pattern: string; requestId?: string }) =>
      options.pattern === 'first' ? first.promise : second.promise)
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    let firstSearch!: Promise<void>
    act(() => {
      firstSearch = result.current.search('first')
    })
    await waitFor(() => expect(ripgrepSearch).toHaveBeenCalledTimes(1))
    await act(async () => {
      first.resolve({
        success: true,
        results: [{
          file: `${rootPath}/first.ts`,
          line: 1,
          column: 0,
          text: 'first',
          matchText: 'first',
          matchKind: 'content',
        }],
      })
      await firstSearch
    })
    expect(result.current.results).toHaveLength(1)

    act(() => {
      void result.current.search('second')
    })
    await waitFor(() => expect(ripgrepSearch).toHaveBeenCalledTimes(2))
    expect(result.current.results).toEqual([])
    expect(ripgrepSearch.mock.calls[0][0].requestId).not.toBe(
      ripgrepSearch.mock.calls[1][0].requestId,
    )
    await act(async () => {
      second.resolve({ success: true, results: [] })
      await Promise.resolve()
    })
  })

  it('内容匹配行触达 per-file 上限时标记 mayHaveMore，loadMore 单文件再搜', async () => {
    const file = `${rootPath}/busy.ts`
    const initialMatches = Array.from({ length: RIPGREP_DEFAULT_PER_FILE_MAX_COUNT }, (_, index) => ({
      file,
      line: index + 1,
      column: 0,
      text: `foo ${index}`,
      matchText: 'foo',
      matchKind: 'content' as const,
    }))
    const moreMatches = Array.from(
      { length: RIPGREP_DEFAULT_PER_FILE_MAX_COUNT + 10 },
      (_, index) => ({
        file,
        line: index + 1,
        column: 0,
        text: `foo ${index}`,
        matchText: 'foo',
        matchKind: 'content' as const,
      }),
    )
    const ripgrepSearch = vi.fn(async (options: { searchPath?: string }) => {
      if (options.searchPath) {
        return { success: true as const, results: moreMatches }
      }
      return { success: true as const, results: initialMatches }
    })
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel: vi.fn() } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    await act(async () => {
      await result.current.search('foo')
    })

    expect(ripgrepSearch).toHaveBeenCalledWith(expect.objectContaining({
      maxCount: RIPGREP_DEFAULT_PER_FILE_MAX_COUNT,
    }))
    expect(result.current.results[0]?.mayHaveMore).toBe(true)
    expect(result.current.results[0]?.matches).toHaveLength(RIPGREP_DEFAULT_PER_FILE_MAX_COUNT)

    await act(async () => {
      await result.current.loadMoreForFile(file)
    })

    expect(ripgrepSearch).toHaveBeenLastCalledWith(expect.objectContaining({
      searchPath: file,
      maxCount: RIPGREP_LOAD_MORE_PER_FILE_MAX_COUNT,
      includePathMatches: false,
    }))
    expect(result.current.results[0]?.matches).toHaveLength(RIPGREP_DEFAULT_PER_FILE_MAX_COUNT + 10)
    expect(result.current.results[0]?.mayHaveMore).toBe(false)
  })

  it('loadMore 保留路径命中并替换内容命中；恰好满额无更多时会收敛 mayHaveMore', async () => {
    const file = `${rootPath}/mixed.ts`
    const initialMatches = [
      {
        file,
        line: 0,
        column: 0,
        text: 'mixed.ts',
        matchText: 'mixed',
        matchKind: 'path' as const,
      },
      ...Array.from({ length: RIPGREP_DEFAULT_PER_FILE_MAX_COUNT }, (_, index) => ({
        file,
        line: index + 1,
        column: 0,
        text: `foo ${index}`,
        matchText: 'foo',
        matchKind: 'content' as const,
      })),
    ]
    const ripgrepSearch = vi.fn(async (options: { searchPath?: string }) => {
      if (options.searchPath) {
        return {
          success: true as const,
          results: Array.from({ length: RIPGREP_DEFAULT_PER_FILE_MAX_COUNT }, (_, index) => ({
            file,
            line: index + 1,
            column: 0,
            text: `foo ${index}`,
            matchText: 'foo',
            matchKind: 'content' as const,
          })),
        }
      }
      return { success: true as const, results: initialMatches }
    })
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel: vi.fn() } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    await act(async () => {
      await result.current.search('foo')
    })

    expect(result.current.results[0]?.mayHaveMore).toBe(true)
    expect(result.current.results[0]?.matches.some((match) => match.matchKind === 'path')).toBe(true)

    await act(async () => {
      await result.current.loadMoreForFile(file)
    })

    expect(result.current.results[0]?.matches[0]?.matchKind).toBe('path')
    expect(
      result.current.results[0]?.matches.filter((match) => match.matchKind !== 'path'),
    ).toHaveLength(RIPGREP_DEFAULT_PER_FILE_MAX_COUNT)
    expect(result.current.results[0]?.mayHaveMore).toBe(false)
  })

  it('loadMore IPC 失败时设置可见错误，不丢弃既有结果', async () => {
    const file = `${rootPath}/busy.ts`
    const initialMatches = Array.from({ length: RIPGREP_DEFAULT_PER_FILE_MAX_COUNT }, (_, index) => ({
      file,
      line: index + 1,
      column: 0,
      text: `foo ${index}`,
      matchText: 'foo',
      matchKind: 'content' as const,
    }))
    const ripgrepSearch = vi.fn(async (options: { searchPath?: string }) => {
      if (options.searchPath) {
        return {
          success: false as const,
          error: 'searchPath outside cwd',
          errorCode: 'invalid_path',
          results: [],
        }
      }
      return { success: true as const, results: initialMatches }
    })
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel: vi.fn() } },
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() => useKeywordSearch(rootPath))
    await act(async () => {
      await result.current.search('foo')
    })
    await act(async () => {
      await result.current.loadMoreForFile(file)
    })

    expect(result.current.results[0]?.matches).toHaveLength(RIPGREP_DEFAULT_PER_FILE_MAX_COUNT)
    expect(result.current.error).toBe('searchPath outside cwd')
    expect(result.current.errorCode).toBe('load_more_failed')
  })

  it('crypto.randomUUID 不可用时 requestId 仍为非空字符串', async () => {
    const originalCrypto = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const ripgrepSearch = vi.fn(async () => ({ success: true as const, results: [] }))
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { ripgrepSearch, ripgrepSearchCancel: vi.fn() } },
      writable: true,
      configurable: true,
    })

    try {
      const { result } = renderHook(() => useKeywordSearch(rootPath))
      await act(async () => {
        await result.current.search('foo')
      })
      const requestId = ripgrepSearch.mock.calls[0][0].requestId as string
      expect(requestId.startsWith('search-')).toBe(true)
      expect(requestId.length).toBeGreaterThan(0)
      expect(requestId.length).toBeLessThanOrEqual(128)
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        writable: true,
      })
    }
  })
})
