/**
 * useFileSearch — Fuse 索引同步行为回归测试
 *
 * 重点覆盖 dogfood "rename 后旧名仍能搜到" 这条 bug 的修复路径：
 *   - removeEntriesByParent 按 parent 清掉直接子项（不递归）
 *   - rename 后 "先 removeEntriesByParent + 再 addEntry" 整体语义：旧名搜不到、新名搜得到
 *
 * 不复测 invalidateIndex/全量重建/防抖，那些走 buildSharedIndex 路径的行为
 * 由 fs:watch 集成测试覆盖（main 端事件 → renderer 兜底重扫）。
 *
 * 测试技巧：sharedIndex 是模块级单例（per rootPath），每个测试用唯一 rootPath
 * 隔离（避免上一个测试遗留状态影响下一个）。所有 act 都安排在 build 完成之后
 * （waitFor 等 sentinel 搜出结果作为 build 完成信号）—— 否则 build 后期把
 * `index.entries = newArray` 覆盖会吞掉 act 中的 addEntry。
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileSearch } from '../useFileSearch'

interface Entry {
  name: string
  path: string
  isDirectory: boolean
}

const setupReadDir = (entriesByDir: Record<string, Entry[]>) => {
  const readDir = vi.fn(async (dirPath: string) => {
    const entries = entriesByDir[dirPath]
    if (!entries) return { success: false, error: 'ENOENT' }
    return { success: true, entries }
  })
  Object.defineProperty(window, 'tabtin', {
    value: { fileSystem: { readDir } },
    writable: true,
    configurable: true,
  })
  return readDir
}

let testCounter = 0
const uniqueRoot = () => `/tmp/proj-${++testCounter}`

describe('useFileSearch — Fuse 索引同步', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('addEntry 后能搜到新加的条目', async () => {
    const ROOT = uniqueRoot()
    setupReadDir({
      [ROOT]: [{ name: '__sentinel__', path: `${ROOT}/__sentinel__`, isDirectory: false }],
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: '__sentinel__' } },
    )

    // 等 build 完成（搜到 sentinel 证明 fuse 已初始化）
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/__sentinel__`)).toBe(true)
    })

    act(() => {
      result.current.addEntry({
        name: 'foo.ts',
        path: `${ROOT}/src/foo.ts`,
        relativePath: 'src/foo.ts',
        isDirectory: false,
      })
    })

    rerender({ term: 'foo' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/foo.ts`)).toBe(true)
    })
  })

  it('removeEntriesByParent 清掉指定父目录下的直接子项', async () => {
    const ROOT = uniqueRoot()
    setupReadDir({
      [ROOT]: [{ name: '__sentinel__', path: `${ROOT}/__sentinel__`, isDirectory: false }],
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: '__sentinel__' } },
    )
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/__sentinel__`)).toBe(true)
    })

    act(() => {
      result.current.addEntry({
        name: 'a.ts',
        path: `${ROOT}/src/a.ts`,
        relativePath: 'src/a.ts',
        isDirectory: false,
      })
      result.current.addEntry({
        name: 'b.ts',
        path: `${ROOT}/src/b.ts`,
        relativePath: 'src/b.ts',
        isDirectory: false,
      })
      result.current.addEntry({
        name: 'README.md',
        path: `${ROOT}/README.md`,
        relativePath: 'README.md',
        isDirectory: false,
      })
    })

    // 先验证全部能搜到（baseline）—— 也证明 add 后 fuse 真的更新了
    rerender({ term: 'a.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/a.ts`)).toBe(true)
    })
    rerender({ term: 'README' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/README.md`)).toBe(true)
    })

    act(() => {
      result.current.removeEntriesByParent(`${ROOT}/src`)
    })

    // 重新搜 a.ts —— 应该被清掉
    rerender({ term: 'foo-zzzz' })
    rerender({ term: 'a.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/a.ts`)).toBe(false)
    })

    // 搜 README —— 应该还在（不同 parent，不受影响）
    rerender({ term: 'foo-yyyy' })
    rerender({ term: 'README' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/README.md`)).toBe(true)
    })
  })

  it('removeEntriesByParent 兼容 Windows 反斜杠路径', async () => {
    const ROOT = `C:\\workspace\\proj-${++testCounter}`
    setupReadDir({
      [ROOT]: [{ name: '__sentinel__', path: `${ROOT}\\__sentinel__`, isDirectory: false }],
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: '__sentinel__' } },
    )
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}\\__sentinel__`)).toBe(true)
    })

    act(() => {
      result.current.addEntry({
        name: 'old.ts',
        path: `${ROOT}\\src\\old.ts`,
        relativePath: 'src/old.ts',
        isDirectory: false,
      })
    })

    rerender({ term: 'old.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}\\src\\old.ts`)).toBe(true)
    })

    act(() => {
      result.current.removeEntriesByParent(`${ROOT.toLowerCase()}\\SRC`)
    })

    rerender({ term: 'no-match' })
    rerender({ term: 'old.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}\\src\\old.ts`)).toBe(false)
    })
  })

  it('removeEntriesByParent 不会误删孙子节点（精确"直接子项"判据）', async () => {
    const ROOT = uniqueRoot()
    setupReadDir({
      [ROOT]: [{ name: '__sentinel__', path: `${ROOT}/__sentinel__`, isDirectory: false }],
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: '__sentinel__' } },
    )
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/__sentinel__`)).toBe(true)
    })

    act(() => {
      // 直接子项
      result.current.addEntry({
        name: 'index.ts',
        path: `${ROOT}/src/index.ts`,
        relativePath: 'src/index.ts',
        isDirectory: false,
      })
      // 孙子节点（src/components 下）
      result.current.addEntry({
        name: 'Button.tsx',
        path: `${ROOT}/src/components/Button.tsx`,
        relativePath: 'src/components/Button.tsx',
        isDirectory: false,
      })
    })

    act(() => {
      result.current.removeEntriesByParent(`${ROOT}/src`)
    })

    // index.ts 应该被删
    rerender({ term: 'index.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/index.ts`)).toBe(false)
    })

    // Button.tsx 应该还在（它是 src/components 的直接子项，不是 src 的直接子项）
    rerender({ term: 'Button' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/components/Button.tsx`)).toBe(true)
    })
  })

  it('rename 链路：先 removeEntriesByParent + 再 addEntry，旧名搜不到、新名搜得到', async () => {
    const ROOT = uniqueRoot()
    setupReadDir({
      [ROOT]: [{ name: '__sentinel__', path: `${ROOT}/__sentinel__`, isDirectory: false }],
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: '__sentinel__' } },
    )
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/__sentinel__`)).toBe(true)
    })

    // 模拟 main 端把同 parent 内的 rename burst 合并：renderer 拿到的 fullPath
    // 是 dest（new.ts）而不是 source（old.ts）。仅靠 removeEntry(fullPath) 删
    // 的是新名字，老名字会变僵尸——这是 dogfood bug 的根因。
    //
    // 修复方案：rename 链路改为"按 parent 全量重建"。本测试模拟这个流程。
    act(() => {
      result.current.addEntry({
        name: 'old.ts',
        path: `${ROOT}/src/old.ts`,
        relativePath: 'src/old.ts',
        isDirectory: false,
      })
      result.current.addEntry({
        name: 'sibling.ts',
        path: `${ROOT}/src/sibling.ts`,
        relativePath: 'src/sibling.ts',
        isDirectory: false,
      })
    })

    // baseline：old.ts 现在应该能搜到
    rerender({ term: 'old.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/old.ts`)).toBe(true)
    })

    // rename 后流程：先按 parent 清，再按 readDir 真实结果重建
    act(() => {
      result.current.removeEntriesByParent(`${ROOT}/src`)
      result.current.addEntry({
        name: 'new.ts',
        path: `${ROOT}/src/new.ts`,
        relativePath: 'src/new.ts',
        isDirectory: false,
      })
      result.current.addEntry({
        name: 'sibling.ts',
        path: `${ROOT}/src/sibling.ts`,
        relativePath: 'src/sibling.ts',
        isDirectory: false,
      })
    })

    // 旧名搜不到（修复点）
    rerender({ term: 'old.tsX' })
    rerender({ term: 'old.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/old.ts`)).toBe(false)
    })

    // 新名搜得到
    rerender({ term: 'new.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/new.ts`)).toBe(true)
    })

    // sibling 也在（重建后被加回来）
    rerender({ term: 'sibling' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/sibling.ts`)).toBe(true)
    })
  })

  it('removeEntriesByParent 对不存在的 parent 是 no-op', async () => {
    const ROOT = uniqueRoot()
    setupReadDir({
      [ROOT]: [{ name: '__sentinel__', path: `${ROOT}/__sentinel__`, isDirectory: false }],
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: '__sentinel__' } },
    )
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/__sentinel__`)).toBe(true)
    })

    act(() => {
      result.current.addEntry({
        name: 'a.ts',
        path: `${ROOT}/src/a.ts`,
        relativePath: 'src/a.ts',
        isDirectory: false,
      })
    })

    act(() => {
      result.current.removeEntriesByParent(`${ROOT}/nonexistent`)
    })

    rerender({ term: 'a.ts' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/a.ts`)).toBe(true)
    })
  })

  it('removeEntry 仍正常工作（保留向后兼容）', async () => {
    const ROOT = uniqueRoot()
    setupReadDir({
      [ROOT]: [{ name: '__sentinel__', path: `${ROOT}/__sentinel__`, isDirectory: false }],
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: '__sentinel__' } },
    )
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/__sentinel__`)).toBe(true)
    })

    act(() => {
      result.current.addEntry({
        name: 'foo.ts',
        path: `${ROOT}/src/foo.ts`,
        relativePath: 'src/foo.ts',
        isDirectory: false,
      })
    })

    act(() => {
      result.current.removeEntry(`${ROOT}/src/foo.ts`)
    })

    rerender({ term: 'foo' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/src/foo.ts`)).toBe(false)
    })
  })

  /**
   * Race 回归：build 期间 addEntry 不应被 build 完成时的 entries 替换吞掉。
   *
   * 旧版（修复前）链路：
   *   1. caller 渲染 hook → buildSharedIndex 启动，await readDir
   *   2. caller 在 build 进行中 addEntry：fuse=null 走 push 到旧 entries
   *   3. readDir resolve → build 用 readDir 结果新建 entries 数组覆盖
   *      `index.entries`，第 2 步的 push 丢失
   *   4. caller 搜不到刚 add 的条目（要等下次 watch event 兜底刷新才回来）
   *
   * 新版用 `pendingDuringBuild` 缓冲 build 期间的 push，build 收尾时按 path
   * 去重 merge 进新 entries → race window 内 push 的条目永不丢。
   *
   * 测试技巧：用受控 promise 让 readDir 卡住，模拟 race window；在窗口内
   * addEntry 一条 readDir 不会返的"额外"条目；resolve 后验证它还在。
   */
  it('build 进行中 addEntry 不丢失（pendingDuringBuild merge）', async () => {
    const ROOT = uniqueRoot()
    let resolveReadDir!: (v: { success: boolean; entries?: Entry[] }) => void
    const readDir = vi.fn(async (dirPath: string) => {
      // 只对 root 目录卡住——避免子目录递归请求也被同一个 promise 卡住造成
      // 死锁；不过 race fix 只需 root 一层就够（root 是 build 第一个 await）。
      if (dirPath === ROOT) {
        return new Promise<{ success: boolean; entries?: Entry[] }>((r) => {
          resolveReadDir = r
        })
      }
      return { success: false, error: 'ENOENT' }
    })
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { readDir } },
      writable: true,
      configurable: true,
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: 'race-zzz-no-match' } },
    )

    // 等 build 启动并卡在 await readDir(ROOT)
    await waitFor(() => {
      expect(readDir).toHaveBeenCalledWith(ROOT)
    })

    // race window 内 addEntry：fuse 还没 build，走 push + 入 pendingDuringBuild
    act(() => {
      result.current.addEntry({
        name: 'race-target.ts',
        path: `${ROOT}/race-target.ts`,
        relativePath: 'race-target.ts',
        isDirectory: false,
      })
    })

    // 让 readDir 返回："真实"目录内只有 sentinel，不含 race-target
    resolveReadDir({
      success: true,
      entries: [{ name: '__sentinel__', path: `${ROOT}/__sentinel__`, isDirectory: false }],
    })

    // 等 fuse 真的 ready：sentinel 能被搜到
    rerender({ term: '__sentinel__' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/__sentinel__`)).toBe(true)
    })

    // 关键断言：race window 内 addEntry 的条目应该被 merge 保留，不被吞
    rerender({ term: 'race-target' })
    await waitFor(() => {
      expect(result.current.results.some((r) => r.path === `${ROOT}/race-target.ts`)).toBe(true)
    })
  })

  /**
   * race fix 的 dedup：build 期间 push 的条目若刚好与 readDir 结果撞 path，
   * 不能出现重复（merge 用 Set<path> 去重）。
   */
  it('build 期间 push 与 readDir 结果撞 path 不重复', async () => {
    const ROOT = uniqueRoot()
    let resolveReadDir!: (v: { success: boolean; entries?: Entry[] }) => void
    const readDir = vi.fn(async (dirPath: string) => {
      if (dirPath === ROOT) {
        return new Promise<{ success: boolean; entries?: Entry[] }>((r) => {
          resolveReadDir = r
        })
      }
      return { success: false, error: 'ENOENT' }
    })
    Object.defineProperty(window, 'tabtin', {
      value: { fileSystem: { readDir } },
      writable: true,
      configurable: true,
    })

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) =>
        useFileSearch({ rootPath: ROOT, searchTerm: term, debounceMs: 0 }),
      { initialProps: { term: 'no-match' } },
    )

    await waitFor(() => {
      expect(readDir).toHaveBeenCalledWith(ROOT)
    })

    // race window 里抢先 add 一条与即将 readDir 出来的条目同 path
    act(() => {
      result.current.addEntry({
        name: 'collide.ts',
        path: `${ROOT}/collide.ts`,
        relativePath: 'collide.ts',
        isDirectory: false,
      })
    })

    resolveReadDir({
      success: true,
      entries: [{ name: 'collide.ts', path: `${ROOT}/collide.ts`, isDirectory: false }],
    })

    rerender({ term: 'collide' })
    await waitFor(() => {
      const matches = result.current.results.filter((r) => r.path === `${ROOT}/collide.ts`)
      expect(matches).toHaveLength(1)
    })
  })

  it('fuzzy-path 有精确子串命中时不混入近似名称噪音', async () => {
    const ROOT = uniqueRoot()
    setupReadDir({
      [ROOT]: [
        { name: 'index.ts', path: `${ROOT}/index.ts`, isDirectory: false },
        { name: 'indox.ts', path: `${ROOT}/indox.ts`, isDirectory: false },
        { name: 'unrelated.ts', path: `${ROOT}/index-folder/unrelated.ts`, isDirectory: false },
      ],
    })

    const { result } = renderHook(() => useFileSearch({
      rootPath: ROOT,
      searchTerm: 'index',
      debounceMs: 0,
    }))

    await waitFor(() => {
      expect(result.current.results.map(entry => entry.name)).toEqual(['index.ts'])
    })
  })

  it('普通关键词不因命中父目录名而召回目录下所有无关文件', async () => {
    const ROOT = uniqueRoot()
    setupReadDir({
      [ROOT]: [
        { name: 'chat', path: `${ROOT}/chat`, isDirectory: true },
        { name: 'ChatPanel.tsx', path: `${ROOT}/ChatPanel.tsx`, isDirectory: false },
      ],
      [`${ROOT}/chat`]: [
        { name: 'unrelated.ts', path: `${ROOT}/chat/unrelated.ts`, isDirectory: false },
      ],
    })

    const { result } = renderHook(() => useFileSearch({
      rootPath: ROOT,
      searchTerm: 'chat',
      debounceMs: 0,
    }))

    await waitFor(() => {
      expect(result.current.results.map(entry => entry.path)).toEqual([
        `${ROOT}/chat`,
        `${ROOT}/ChatPanel.tsx`,
      ])
    })
    expect(result.current.results.some(entry => entry.name === 'unrelated.ts')).toBe(false)
  })
})
