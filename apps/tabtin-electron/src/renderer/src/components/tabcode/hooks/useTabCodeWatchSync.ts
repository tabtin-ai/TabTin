/**
 * useTabCodeWatchSync — 把 fs:watch 事件同步到 TabCodeFileTree 的多份本地状态。
 *
 * **不是通用 hook**：强依赖 headless-tree 的 ItemInstance API、tabcode 特有的
 * git-aware tree epoch 重渲染、useFileSearch 的 Fuse 索引同步语义。所以放在
 * tabcode 子目录而非 `@hooks/`。
 *
 * 收敛动机：原来 TabCodeFileTree.tsx 里 ~115 行的 watch 同步逻辑（pendingEvents
 * 暂存 + 100ms 自防抖 + flushWatchEvents + isGlobal/逐 parent 双分支 + rename
 * 链路 readDir 全量重建）跟 UI 渲染逻辑混在一起，god class 难读。抽出来后
 * 主组件只剩"装树 + 渲染"，watch 同步独立可测。
 *
 * **防抖说明**：本 hook 不再加自防抖——下层 `useFolderWatch` 已内置 200ms
 * 按 root 累积。caller 拿到的 events[] 已经是合并后的批，本 hook 直接消费。
 * 原版 100ms 自防抖是 useFolderWatch 重写前的历史遗留，不必保留。
 *
 * **多状态收尾顺序**：isGlobal 分支跟"逐 parent 分支"都要：
 *   1) 失效 entryCacheRef（dataLoader 下次重读用）
 *   2) 失效 headless-tree 内部 childrenIds 缓存
 *   3) bumpTreeEpoch 让 React 重渲染（tree.getItems() 引用未变，单靠它不会
 *      触发 useMemo 失效——epoch 是显式信号）
 *   4) Fuse 索引同步（全量 invalidateIndex / 按 parent 重建）
 *
 * 顺序很重要——先清缓存再 bump，否则 React 重渲染时 dataLoader 还会拿到旧
 * 缓存值（headless-tree itemId → cached children 这层是同步的）。
 */

import { useCallback, useRef } from 'react'
import type { ItemInstance } from '@headless-tree/core'
import { useFolderWatch, type FolderWatchEvent } from '@hooks/useFolderWatch'
import { isLegacyOk } from '@/services/legacy-result'
import { relativePath } from '../utils/path'
import { normalizePathSeparators } from '@components/shared/file-utils/path-ops'
import { createLogger } from '@/utils/logger'

const log = createLogger('TabCodeWatchSync')

/** 加进 Fuse 索引的 entry——形态对齐 useFileSearch.FileSearchEntry。 */
interface FileEntry {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
}

/**
 * Hook 仅用 tree 的三个最小能力：getItemInstance / getItems / item 上的
 * getId/isExpanded/invalidateChildrenIds。用泛型保留 caller 真实 TData
 * （FileNode）类型，hook 自身不依赖也不窥探 itemData。
 */
interface MinimalTreeApi<TData> {
  getItemInstance: (itemId: string) => ItemInstance<TData> | undefined
  getItems: () => Array<ItemInstance<TData>>
}

export function invalidateVisibleExpandedTree<TData>(tree: MinimalTreeApi<TData>): void {
  tree.getItemInstance('root')?.invalidateChildrenIds()
  for (const item of tree.getItems()) {
    if (item.getId() !== 'root' && item.isExpanded()) {
      item.invalidateChildrenIds()
    }
  }
}

/**
 * tree.dataLoader 用的本地 entry cache。hook 只需要 `delete(path)` 跟 `clear()`
 * 两个方法——刻意不写成 `Map<string, FileNode>` 避免与 caller 的 entry 形状
 * 耦合。`Map<string, FileNode>` 自动满足这个结构子集。
 */
interface EntryCacheLike {
  delete(path: string): unknown
  clear(): void
}

function comparablePath(path: string): string {
  const normalized = normalizePathSeparators(path).replace(/\/+$/, '')
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

export interface UseTabCodeWatchSyncDeps<TData = unknown> {
  /** 监听根；null 时 hook 不启动 watcher。 */
  rootPath: string | null
  tree: MinimalTreeApi<TData>
  entryCacheRef: React.MutableRefObject<EntryCacheLike>
  /** treeRows useMemo 的显式重算信号——`useReducer((x) => x + 1, 0)[1]`。 */
  bumpTreeEpoch: () => void
  /** 全量重建 Fuse 索引；isGlobal 分支用。 */
  invalidateIndex: () => void
  /** 单条 entry 加进 Fuse；rename 链路重建用。 */
  addEntry: (entry: FileEntry) => void
  /** 清掉某 parent 下所有直接子项；rename 链路用。 */
  removeEntriesByParent: (parent: string) => void
  /** 任意文件系统事件批到达后，通知上层刷新 Git 状态等派生信息。 */
  onFileSystemChange?: () => void
}

export function useTabCodeWatchSync<TData>({
  rootPath,
  tree,
  entryCacheRef,
  bumpTreeEpoch,
  invalidateIndex,
  addEntry,
  removeEntriesByParent,
  onFileSystemChange,
}: UseTabCodeWatchSyncDeps<TData>): void {
  const renameRevisionByParentRef = useRef(new Map<string, number>())

  const handleBatch = useCallback(
    async (_rootId: string, events: FolderWatchEvent[]) => {
      if (events.length === 0) return
      const currentRoot = rootPath
      if (!currentRoot) return
      onFileSystemChange?.()

      // isGlobal 与 fullPath 缺失语义等价（main 端 isGlobal=true 时 fullPath
      // 必为 undefined），双条件都接住——前端日志看 isGlobal 字段更直观。
      const hasGlobal = events.some((e) => e.isGlobal || !e.fullPath)
      if (hasGlobal) {
        // OS 队列溢出：main 端拿不到具体路径，只能告诉前端"整棵树需要重扫"。
        // 仅 invalidate root 不够——用户已展开的深层子目录（headless-tree
        // 内部按 itemId 缓存 childrenIds）会保留旧 children list，新增文件
        // 不会出现在树里。这里遍历 visible+isExpanded 的 ItemInstance 全部
        // invalidate，强制 headless-tree 重新拉它们的内容。
        entryCacheRef.current.clear()
        invalidateVisibleExpandedTree(tree)
        bumpTreeEpoch()
        invalidateIndex()
        return
      }

      const affectedParents = new Set<string>()
      const renamedParents = new Set<string>()

      for (const { fullPath, parentDir, eventType } of events) {
        if (!fullPath) continue
        entryCacheRef.current.delete(fullPath)
        affectedParents.add(parentDir)
        if (eventType === 'rename') renamedParents.add(parentDir)
      }

      for (const parent of affectedParents) {
        const parentKey = comparablePath(parent)
        const parentItem = parentKey === comparablePath(currentRoot)
          ? tree.getItemInstance('root')
          : tree.getItemInstance(parent)
            ?? tree.getItems().find((item) => comparablePath(item.getId()) === parentKey)
        parentItem?.invalidateChildrenIds()
      }
      bumpTreeEpoch()

      // rename 链路按 parent 全量重建该目录下的 Fuse 索引
      //
      // 旧实现走 `removeEntry(fullPath)` + 按 readDir 结果 addEntry，但 main
      // 端 `pendingByParent.set(parent, ...)` 会把同一 burst 内多个 rename 合
      // 并成一条，renderer 拿到的 fullPath 是 dest 不是 source —— 删的是新
      // 名字（此刻文件系统里已存在），老名字（source）留在 Fuse 里变成僵尸
      // 条目（搜旧名能搜到点开 404）。
      //
      // 改成"该 parent 下整体重建"：先 removeEntriesByParent 清掉所有旧条目，
      // 再按 readDir 当前真实结果 addEntry，保证 Fuse 索引 = 文件系统真实
      // 状态。
      for (const parent of renamedParents) {
        const parentKey = comparablePath(parent)
        const revision = (renameRevisionByParentRef.current.get(parentKey) ?? 0) + 1
        renameRevisionByParentRef.current.set(parentKey, revision)
        removeEntriesByParent(parent)
        try {
          // contract W2-β: channel `fs:readDir` 在 LEGACY_HANDLERS 内（preload
          // 透传 raw `{success, entries?, error?}`）。rename 后的 parent dir
          // 重读 fail-soft（parent 可能已被删除）—— isLegacyOk 收口。parent
          // 已删时 removeEntriesByParent 已清掉旧条目，readDir 失败走 catch
          // 不再 addEntry，正好达到"该目录下条目清零"的预期。
          const parentDirRes = await window.tabtin.fileSystem.readDir(parent)
          if (!isLegacyOk(parentDirRes) || !parentDirRes.entries) continue
          if (renameRevisionByParentRef.current.get(parentKey) !== revision) {
            // 后续 rename 已开始：当前结果可能是旧快照，丢弃并触发全量重建
            // 收敛索引，避免旧批次在新批次之后写回僵尸条目。
            invalidateIndex()
            continue
          }
          for (const entry of parentDirRes.entries) {
            const name = entry.path.split(/[\\/]/).pop() || entry.path
            addEntry({
              name,
              path: entry.path,
              relativePath: relativePath(currentRoot, entry.path),
              isDirectory: entry.isDirectory,
            })
          }
        } catch (error) {
          // parent 可能已被删除；保留已完成的旧索引清理，不阻塞后续事件批。
          log.warn('rename 后重读父目录失败，跳过搜索索引重建', error)
        }
      }
    },
    [
      rootPath,
      tree,
      entryCacheRef,
      bumpTreeEpoch,
      invalidateIndex,
      addEntry,
      removeEntriesByParent,
      onFileSystemChange,
    ],
  )

  useFolderWatch(rootPath || null, handleBatch)
}
