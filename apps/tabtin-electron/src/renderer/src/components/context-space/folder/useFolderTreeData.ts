/**
 * useFolderTreeData - 多根文件树状态管理 Hook
 *
 * 把 FileTree 单根状态（entriesByDir / fileExpanded / loading / watcher）
 * 扩展为多根共管，供 FolderHomePane 的统一虚拟列表使用。
 *
 * 设计要点：
 * - 只依赖根列表的 id/rootPath/kind，不感知根节点的展开/折叠（那是 FolderHomePane 的关注点）
 * - roots 变化时自动初始化新根、清理已移除根的状态和 watcher
 * - 返回 flatRowsByRoot（useMemo 计算），外部直接消费，无需再调扁平化函数
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@components/ui'
import type { FileEntry, FolderContextKind } from './types'
import { ensureLegacyOk } from '@/services/legacy-result'
import { formatDirReadErrorForUser, isExpectedDirReadAccessError } from '@/services/ipc-error'
import { useFolderWatch, type FolderWatchRootSpec } from '@hooks/useFolderWatch'
import { filterVisibleFileEntries } from './fileEntryVisibility'

const FILE_TREE_TOAST_OPTIONS = { preferNative: true } as const

export interface RootInput {
  id: string
  rootPath: string
  kind: FolderContextKind
}

interface RootState {
  entriesByDir: Record<string, FileEntry[]>
  /** 文件树内部展开的目录（区别于根节点展开，后者由 FolderHomePane 管理） */
  fileExpanded: Set<string>
  loading: Set<string>
  errorsByDir: Record<string, string | undefined>
}

export interface FlatFileRow {
  rootId: string
  entry: FileEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
}

const sortEntries = (entries: FileEntry[], locale: string): FileEntry[] =>
  [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, locale)
  })

const createRootState = (rootPath?: string): RootState => ({
  entriesByDir: {},
  fileExpanded: new Set(rootPath ? [rootPath] : []),
  loading: new Set(),
  errorsByDir: {},
})

const clearDirError = (
  errorsByDir: Record<string, string | undefined>,
  dirPath: string,
): Record<string, string | undefined> => {
  if (!errorsByDir[dirPath]) return errorsByDir
  const next = { ...errorsByDir }
  delete next[dirPath]
  return next
}

export function useFolderTreeData(roots: RootInput[]) {
  const [states, setStates] = useState<Record<string, RootState>>({})
  const { i18n, t } = useTranslation('context')

  const statesRef = useRef(states)
  statesRef.current = states

  const loadDir = useCallback(
    async (rootId: string, dirPath: string, force = false) => {
      if (!force && statesRef.current[rootId]?.entriesByDir[dirPath]) return

      setStates(prev => {
        const root = prev[rootId] ?? createRootState()
        return {
          ...prev,
          [rootId]: {
            ...root,
            loading: new Set(root.loading).add(dirPath),
            errorsByDir: clearDirError(root.errorsByDir, dirPath),
          },
        }
      })

      try {
        const result = await window.tabtin.fileSystem.readDir(dirPath)
        ensureLegacyOk(result, 'readDir')
        setStates(prev => {
          const root = prev[rootId] ?? createRootState()
          const nextLoading = new Set(root.loading)
          nextLoading.delete(dirPath)
          const entries = filterVisibleFileEntries(Array.isArray(result.entries) ? result.entries : [])
          return {
            ...prev,
            [rootId]: {
              ...root,
              entriesByDir: {
                ...root.entriesByDir,
                [dirPath]: sortEntries(entries, i18n.language),
              },
              loading: nextLoading,
              errorsByDir: clearDirError(root.errorsByDir, dirPath),
            },
          }
        })
      } catch (err) {
        const message = formatDirReadErrorForUser(err, t)
        if (isExpectedDirReadAccessError(err)) {
          toast({ title: message, id: 'filetree-dir-read', ...FILE_TREE_TOAST_OPTIONS })
        } else {
          toast.error(message, { id: 'filetree-dir-read', ...FILE_TREE_TOAST_OPTIONS })
        }
        setStates(prev => {
          const root = prev[rootId] ?? createRootState()
          const nextLoading = new Set(root.loading)
          nextLoading.delete(dirPath)
          return {
            ...prev,
            [rootId]: {
              ...root,
              loading: nextLoading,
              errorsByDir: {
                ...root.errorsByDir,
                [dirPath]: message,
              },
            },
          }
        })
      }
    },
    [i18n.language, t],
  )

  const loadDirRef = useRef(loadDir)
  loadDirRef.current = loadDir

  // 根列表变化时：清理已移除的根，初始化新增的根
  useEffect(() => {
    const rootIds = new Set(roots.map(r => r.id))

    setStates(prev => {
      let changed = false
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        if (!rootIds.has(id)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })

    for (const root of roots) {
      if (!statesRef.current[root.id]) {
        setStates(prev => ({
          ...prev,
          [root.id]: {
            ...createRootState(root.rootPath),
          },
        }))
        void loadDirRef.current(root.id, root.rootPath, true)
      }
    }
  }, [roots])

  // **目录自动更新**（路径权限治理 / dogfood 反馈修复）：
  //
  // 多根 watcher 启动 / watchId 路由 / per-root 200ms 防抖 / unmount 防孤儿
  // 全部下沉到 `useFolderWatch`——之前这里 inline 一百多行样板，且上一波
  // dogfood "侧边栏不自动更新" 的 bug 就是从 main 端 `dirPath` 字段误用、
  // 本处自己 dirname 推算两边语义不一致里长出来的。
  //
  // 本处只剩**状态层判断**——hook 不感知 fileExpanded 状态，所以"哪些事件
  // 该刷哪些目录"必须 caller 自己决定：
  //   - 常规事件：用 `parentDir` 命中 fileExpanded 才刷
  //   - `isGlobal=true`（OS 队列溢出，macOS MustScanSubDirs / Linux
  //     IN_Q_OVERFLOW）：main 端拿不到具体路径，必须重扫该 root 全部已展开
  //     目录
  //
  // callback 收到的 events[] 已被 hook 按 root 路由 + 200ms 防抖合并（语义
  // 见 useFolderWatch jsdoc）。
  const watchSpecs = useMemo<FolderWatchRootSpec[]>(
    () => roots.map(r => ({ id: r.id, rootPath: r.rootPath })),
    [roots],
  )

  useFolderWatch(
    watchSpecs,
    useCallback((rootId, events) => {
      const state = statesRef.current[rootId]
      if (!state) return

      const dirsToReload = new Set<string>()
      const hasGlobal = events.some(e => e.isGlobal)
      if (hasGlobal) {
        state.fileExpanded.forEach(dir => dirsToReload.add(dir))
      } else {
        for (const e of events) {
          if (state.fileExpanded.has(e.parentDir)) dirsToReload.add(e.parentDir)
        }
      }
      for (const dir of dirsToReload) {
        void loadDirRef.current(rootId, dir, true)
      }
    }, []),
  )

  const toggleFileExpand = useCallback((rootId: string, dirPath: string) => {
    setStates(prev => {
      const root = prev[rootId]
      if (!root) return prev
      const next = new Set(root.fileExpanded)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
        void loadDirRef.current(rootId, dirPath)
      }
      return { ...prev, [rootId]: { ...root, fileExpanded: next } }
    })
  }, [])

  const refreshRoot = useCallback((rootId: string) => {
    const root = statesRef.current[rootId]
    if (!root) return
    root.fileExpanded.forEach(dir => void loadDirRef.current(rootId, dir, true))
  }, [])

  /** 扁平化每个根的文件条目，供统一虚拟列表消费 */
  const flatRowsByRoot = useMemo(() => {
    const result: Record<string, FlatFileRow[]> = {}
    for (const root of roots) {
      const state = states[root.id]
      if (!state) {
        result[root.id] = []
        continue
      }
      const rows: FlatFileRow[] = []
      const startDepth = root.kind === 'sandbox' ? 0 : 1

      const flatten = (dirPath: string, depth: number) => {
        const entries = state.entriesByDir[dirPath]
        if (!entries) return
        for (const entry of entries) {
          const isExp = state.fileExpanded.has(entry.path)
          rows.push({
            rootId: root.id,
            entry,
            depth,
            isExpanded: isExp,
            isLoading: state.loading.has(entry.path),
          })
          if (entry.isDirectory && isExp) flatten(entry.path, depth + 1)
        }
      }

      flatten(root.rootPath, startDepth)
      result[root.id] = rows
    }
    return result
  }, [roots, states])

  return { states, toggleFileExpand, refreshRoot, flatRowsByRoot }
}
