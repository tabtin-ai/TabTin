/**
 * 本地文件搜索 hook：
 * - Quick Open：文件名模糊搜索；只有显式输入 `/` 或 `\` 时才按相对路径精确搜索
 * per-rootPath 共享索引：多个消费者（FileTree + QuickOpen）共用同一份缓存和 Fuse 实例，
 * 避免重复目录遍历。索引在最后一个消费者卸载后自动清理。
 *
 * 增量同步原则（addEntry/removeEntry/removeEntriesByParent）：
 *   - Fuse 7.x 的 `add()` / `remove()` 会直接 mutate 它持有的 docs 数组；
 *     而我们通过 `new Fuse(entries)` 把 `index.entries` 传进 fuse，因此
 *     build 完成后 `index.entries` 与 fuse 内部 `_docs` 是同一个数组。
 *   - 这意味着 fuse 存在时只走 fuse.add/remove 即可，**不要**再手动
 *     push/splice 一次，否则会出现重复 entry / dedup 失效。
 *   - fuse 还没 build 出来时（fuse=null），fallback 走手动 push/splice 让
 *     fallback 搜索能命中。**race 修复**：build 进行中收到的 addEntry 会
 *     被记到 `pendingDuringBuild`，build 完成时按 path 去重 merge 进新的
 *     entries 数组——这样 watch event flush 之前不会出现"刚 push 的条目
 *     被 build 完成时整体替换吞掉"。
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Fuse, { type IFuseOptions } from 'fuse.js'
import { SEARCH_INDEX_SKIP_NAMES } from '../utils/constants'
import { relativePath } from '../utils/path'
import { isLegacyOk } from '@/services/legacy-result'
import {
  isPathInside,
  normalizePathSeparators,
} from '@components/shared/file-utils/path-ops'

export interface FileSearchEntry {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
}

interface UseFileSearchProps {
  rootPath: string | null
  searchTerm: string
  debounceMs?: number
  maxResults?: number
}

const FUSE_OPTIONS: IFuseOptions<FileSearchEntry> = {
  // 普通关键词只模糊匹配 basename。把 relativePath 放进 Fuse 会让查询恰好命中
  // 某个父目录名时，把该目录下几百个“文件名不相关”的文件全部召回。
  keys: ['name'],
  threshold: 0.28,
  distance: 100,
  includeScore: true,
  minMatchCharLength: 2,
  shouldSort: true,
}

interface SharedIndex {
  entries: FileSearchEntry[]
  fuse: Fuse<FileSearchEntry> | null
  refCount: number
  building: boolean
  cancel: (() => void) | null
  pendingRebuild: boolean
  /**
   * build 进行中（fuse 还没创建）caller 调 addEntry 推到 entries 的条目，
   * 同步追加到这里。build 完成的"index.entries = entries"会丢掉这些写入，
   * 所以在替换前要按 path 去重 merge 回去。null = 未在 build 中。
   */
  pendingDuringBuild: FileSearchEntry[] | null
}

const sharedIndexes = new Map<string, SharedIndex>()

/**
 * 判断某条 entry 是否应当跳过索引——单一真相源。
 *
 * 不只看 `entry.name`：watcher（useTabCodeWatchSync）rename 链路拿到的是
 * 已经发生变化的具体文件路径，例如 `/proj/node_modules/foo/index.js`——
 * 它的 name 是 `index.js` 不会命中黑名单，但路径中含 `node_modules`
 * 这一段，进索引就是污染。所以这里走"路径中任何一段命中黑名单 → 跳过"
 * 的语义。
 *
 * buildSharedIndex 自己的 BFS 在进入目录前就检查过 name，已经不会下钻
 * 到 `node_modules` 内部，所以那里继续用单层 name 检查更直观；这个
 * helper 主要给 addEntry 用，守住外部传入条目的边界。
 */
function shouldSkipForIndex(rootPath: string, entryPath: string, entryName: string): boolean {
  if (SEARCH_INDEX_SKIP_NAMES.has(entryName)) return true
  if (!isPathInside(rootPath, entryPath)) return false
  const rel = relativePath(rootPath, entryPath)
  if (!rel) return false
  for (const seg of rel.split('/')) {
    if (SEARCH_INDEX_SKIP_NAMES.has(seg)) return true
  }
  return false
}

function getOrCreateIndex(rootPath: string): SharedIndex {
  let index = sharedIndexes.get(rootPath)
  if (!index) {
    index = {
      entries: [],
      fuse: null,
      refCount: 0,
      building: false,
      cancel: null,
      pendingRebuild: false,
      pendingDuringBuild: null,
    }
    sharedIndexes.set(rootPath, index)
  }
  return index
}

async function buildSharedIndex(rootPath: string): Promise<void> {
  const index = getOrCreateIndex(rootPath)
  if (index.building) {
    index.pendingRebuild = true
    return
  }
  index.building = true
  index.pendingRebuild = false
  // race fix: 在 build 期间 addEntry 走 push 分支时同步追加到这个列表，build
  // 完成时按 path 去重 merge 进新的 entries（防止 `index.entries = entries`
  // 整体替换吞掉这次 push）。
  index.pendingDuringBuild = []

  let cancelled = false
  index.cancel = () => { cancelled = true }

  const entries: FileSearchEntry[] = []
  const queue = [rootPath]

  while (queue.length > 0 && entries.length < 10000) {
    const dir = queue.shift()!
    try {
      // contract W2-β: channel `fs:readDir` 在 LEGACY_HANDLERS 内（preload
      // 透传 raw `{success, entries?, error?}`）。这里是后台索引构建——单条目录
      // 读取失败不阻断整体（fail-soft），不走 ensureLegacyOk 转 throw 保留原
      // silent skip 语义。用 isLegacyOk 把 `success` 字面统一收口到 helper。
      const dirRes = await window.tabtin.fileSystem.readDir(dir)
      if (!isLegacyOk(dirRes) || !dirRes.entries || cancelled) continue
      for (const entry of dirRes.entries) {
        // 跳过依赖/缓存/系统垃圾——这是性能保护（10000 条配额留给源代码），
        // 不是 UI 隐藏。常量注释见 utils/constants.ts。
        if (SEARCH_INDEX_SKIP_NAMES.has(entry.name)) continue
        const rel = relativePath(rootPath, entry.path)
        entries.push({
          name: entry.name,
          path: entry.path,
          relativePath: rel,
          isDirectory: entry.isDirectory,
        })
        if (entry.isDirectory) queue.push(entry.path)
      }
    } catch { /* skip unreadable dirs */ }
  }

  if (!cancelled) {
    // race fix: build 期间收到的 push 写入按 path 去重合并进 readDir 结果。
    // readDir 是源头真相 → 同 path 出现时优先保留 readDir 那份；pending 仅
    // 补 build 还没扫到（或新建）的条目。
    const pending = index.pendingDuringBuild ?? []
    if (pending.length > 0) {
      const seenPaths = new Set(entries.map((e) => e.path))
      for (const extra of pending) {
        if (!seenPaths.has(extra.path)) {
          entries.push(extra)
          seenPaths.add(extra.path)
        }
      }
    }
    index.entries = entries
    index.fuse = new Fuse(entries, FUSE_OPTIONS)
  }
  index.building = false
  index.cancel = null
  index.pendingDuringBuild = null

  if (index.pendingRebuild && !cancelled) {
    index.pendingRebuild = false
    return buildSharedIndex(rootPath)
  }
}

export function useFileSearch({
  rootPath,
  searchTerm,
  debounceMs = 150,
  maxResults = 200,
}: UseFileSearchProps) {
  const [results, setResults] = useState<FileSearchEntry[]>([])
  const [isFetching, setIsFetching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    if (!rootPath) return
    const index = getOrCreateIndex(rootPath)
    index.refCount++

    if (index.entries.length === 0 && !index.building) {
      buildSharedIndex(rootPath).then(() => setEpoch((e) => e + 1))
    }

    return () => {
      index.refCount--
      if (index.refCount <= 0) {
        index.cancel?.()
        sharedIndexes.delete(rootPath)
      }
    }
  }, [rootPath])

  const invalidateIndex = useCallback(() => {
    if (!rootPath) return
    const index = getOrCreateIndex(rootPath)
    index.cancel?.()
    index.entries = []
    index.fuse = null
    buildSharedIndex(rootPath).then(() => setEpoch((e) => e + 1))
  }, [rootPath])

  const addEntry = useCallback((entry: FileSearchEntry) => {
    if (!rootPath) return
    // watcher 链路（useTabCodeWatchSync）rename 后的 readDir 会走到这里，
    // 它没经过 buildSharedIndex 的 BFS 黑名单——所以由 addEntry 自己守住
    // 边界。例如 `node_modules/foo/index.js` 这类条目应当被挡掉，避免污
    // 染 Fuse 索引。helper 的判定语义见 shouldSkipForIndex 注释。
    if (shouldSkipForIndex(rootPath, entry.path, entry.name)) return
    const index = getOrCreateIndex(rootPath)
    if (index.entries.some((e) => e.path === entry.path)) return
    if (index.fuse) {
      // fuse.add 同时会 push 到 index.entries（fuse 持有同一引用）
      index.fuse.add(entry)
    } else {
      index.entries.push(entry)
      // race fix: build 进行中 fuse=null，push 是写到旧的 entries 数组，
      // build 完成时整体替换会丢；同步追加到 pendingDuringBuild，让
      // buildSharedIndex 收尾处把它合并进新的 entries。
      if (index.building && index.pendingDuringBuild) {
        index.pendingDuringBuild.push(entry)
      }
    }
  }, [rootPath])

  const removeEntry = useCallback((filePath: string) => {
    if (!rootPath) return
    const index = getOrCreateIndex(rootPath)
    if (index.fuse) {
      index.fuse.remove((doc) => doc.path === filePath)
    } else {
      const idx = index.entries.findIndex((e) => e.path === filePath)
      if (idx !== -1) index.entries.splice(idx, 1)
    }
  }, [rootPath])

  /**
   * 清掉某个父目录下所有"直接子项"（不递归到孙子层）。
   *
   * 设计动机：rename 链路下 main 端把 burst 内多个 rename 按 parent 合并成
   * 一条 PendingEvent，renderer 拿到的 fullPath 是 dest 不是 source。仅靠
   * `removeEntry(fullPath)` 删的是新名字，老名字（source）会留在 Fuse 索引
   * 里变成僵尸条目（搜旧名能搜到、点开 404）。
   *
   * 调用方应当：先 `removeEntriesByParent(parent)` 清旧，再用 readDir 拿到
   * 当前真实 entries `addEntry` 回去——保证索引内该 parent 下的条目 = 当前
   * 文件系统真实状态。
   *
   * "直接子项"判据：先把 Windows 反斜杠归一为 `/`，再判断 path 以
   * `parentDir + '/'` 开头，且去掉前缀后不再含 `/`。这与 readDir 返回的
   * entries 语义对齐（readDir 不递归），跨 parent 的孙子节点不会被误删。
   */
  const removeEntriesByParent = useCallback((parentDir: string) => {
    if (!rootPath) return
    const index = getOrCreateIndex(rootPath)
    const normalizedParent = normalizePathSeparators(parentDir).replace(/\/+$/, '')
    const isWindowsPath = /^[a-zA-Z]:\//.test(normalizedParent) || normalizedParent.startsWith('//')
    const comparableParent = isWindowsPath ? normalizedParent.toLowerCase() : normalizedParent
    const prefix = comparableParent + '/'
    const isDirectChild = (entryPath: string) => {
      const normalizedPath = normalizePathSeparators(entryPath)
      const comparableEntryPath = isWindowsPath ? normalizedPath.toLowerCase() : normalizedPath
      if (!comparableEntryPath.startsWith(prefix)) return false
      const rest = comparableEntryPath.slice(prefix.length)
      return rest.length > 0 && !rest.includes('/')
    }
    if (index.fuse) {
      index.fuse.remove((doc) => isDirectChild(doc.path))
    } else {
      for (let i = index.entries.length - 1; i >= 0; i--) {
        if (isDirectChild(index.entries[i].path)) {
          index.entries.splice(i, 1)
        }
      }
    }
  }, [rootPath])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    const term = searchTerm.trim()
    if (!term) {
      setResults([])
      setIsFetching(false)
      return
    }
    if (!rootPath) return

    setIsFetching(true)
    let cancelled = false
    debounceRef.current = setTimeout(() => {
      const index = sharedIndexes.get(rootPath)
      if (index?.fuse) {
        const lower = term.toLocaleLowerCase()
        const isPathQuery = /[\\/]/.test(term)
        const exactMatches = index.entries.filter(
          entry => entry.name.toLocaleLowerCase().includes(lower)
            || (isPathQuery && entry.relativePath.toLocaleLowerCase().includes(lower)),
        )
        if (exactMatches.length > 0) {
          setResults(exactMatches.slice(0, maxResults))
        } else if (term.length >= 2) {
          const matched = index.fuse.search(term, { limit: maxResults })
            .filter(result => (result.score ?? 1) <= 0.28)
          setResults(matched.map((result) => result.item))
        } else {
          setResults([])
        }
      } else if (index) {
        const lower = term.toLowerCase()
        const matched = index.entries
          .filter(
            (e) =>
              e.name.toLowerCase().includes(lower) ||
              e.relativePath.toLowerCase().includes(lower),
          )
          .slice(0, maxResults)
        setResults(matched)
      }
      setIsFetching(false)
      debounceRef.current = null
    }, debounceMs)

    return () => {
      cancelled = true
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // epoch triggers re-search when index rebuilds
  }, [searchTerm, debounceMs, maxResults, rootPath, epoch])

  const hasQuery = useMemo(() => searchTerm.trim().length > 0, [searchTerm])

  return { results, isFetching, hasQuery, invalidateIndex, addEntry, removeEntry, removeEntriesByParent }
}
