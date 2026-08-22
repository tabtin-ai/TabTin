/**
 * TabCode 文件树 — headless-tree 驱动
 *
 * 特性：
 * - material-icon-theme 文件/文件夹图标（300+ 文件类型 + 50+ 特殊文件夹）
 * - headless-tree 状态管理（内置缓存失效、选择、无障碍）
 * - 本地文件名+路径模糊搜索（150ms 防抖，Escape 清除）
 * - 文件 CRUD（新建/重命名/删除 — 行内输入 + 右键菜单 + 文件名校验）
 * - Git 状态着色 + stage/unstage/discard 操作
 * - 钉住文件快速访问
 * - F2 重命名 / Delete 删除 键盘快捷键
 */

import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useReducer } from 'react'
import { useTranslation } from 'react-i18next'
import { useSafeVirtualizer } from '@hooks/useSafeVirtualizer'
import { invalidateVisibleExpandedTree, useTabCodeWatchSync } from '../hooks/useTabCodeWatchSync'
import {
  asyncDataLoaderFeature,
  selectionFeature,
  type ItemInstance,
} from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import {
  ChevronRight,
  ChevronDown,
  Send,
  Copy,
  ExternalLink,
  Pin,
  PinOff,
  GitCommitHorizontal,
  Undo2,
  Trash2,
  File as FileIcon_Lucide,
  Folder,
  Pencil,
  Plus,
  Minus,
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuDivider,
  toast,
} from '@tabtin/smartsheet-ui'
import { sendCodeContextToChat } from '../sendCodeContextToChat'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { cn } from '@utils/cn'
import { ROW_HEIGHT, TREE_INDENT } from '../utils/constants'
import { FileTreeToolbar } from './FileTreeToolbar'
import { NewItemInput } from './NewItemInput'
import { RenameInput } from './RenameInput'
import { DeleteConfirmDialog } from './DeleteConfirmDialog'
import { TabCodeConfirmDialog } from './TabCodeConfirmDialog'
import { useTabCodeStore, type TabCodePinnedItem } from '../hooks/useTabCodeStore'
import { useFileTreeActions, useFileTreeDragDrop } from '@components/shared/file-ops'
import { writeFileTreeChatDragData } from '@components/context-space/hooks/chatContextDragPayload'
import { useFileSearch } from '../hooks/useFileSearch'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { useScrollPositionPreserve } from '@hooks/useScrollPositionPreserve'
import { basename, relativePath } from '../utils/path'
import { getFileTreeContextMenuModel, type FileTreeContextSource } from '../utils/fileTreeContextMenu'
import {
  findDescendantGitTreeStatus,
  findGitTreeStatus,
} from '../utils/gitFilteredTree'
import {
  buildCompactGitChangeTree,
  flattenCompactGitChangeTree,
  type CompactGitChangeTreeRow,
} from '../utils/gitCompactTree'
import {
  isFileTreeNodeSelected,
  resolveNewItemParentPath,
  shouldRenderNewItemFallback,
  type FileTreeSelection,
} from '../utils/fileTreeSelection'
import { logGitActionFailure } from '../utils/gitActionDiagnostics'
import type { ViewMode } from './TabCodeToolbar'
import type { DiffMode } from './TabCodeDiffView'
import { ensureLegacyOk, isLegacyOk } from '@/services/legacy-result'
import { formatGitErrorForToast } from './git-workflow/gitErrorMessage'

export type { GitFileStatus } from '@shared/git-types'
import type { GitFileStatus } from '@shared/git-types'

export type GitStatusMap = Map<string, GitFileStatus>

interface FileNode {
  id: string
  name: string
  path: string
  isDirectory: boolean
}

interface TabCodeFileTreeProps {
  rootPath: string
  selectedFile: string | null
  onOpenQuickOpen: () => void
  /** 由持久化 IDE 会话恢复的已展开目录。 */
  initialExpandedDirs?: string[]
  /** 用户改变目录展开状态后回写会话。 */
  onExpandedDirsChange?: (paths: string[]) => void
  onFileSelect: (path: string) => void
  onGitChangeFileSelect?: (path: string, diffMode: DiffMode) => void
  onFileDoubleClick?: (path: string) => void
  gitStatus: GitStatusMap
  stagedStatus: GitStatusMap
  unstagedStatus: GitStatusMap
  viewMode: ViewMode
  isGitRepo?: boolean
  onGitActionComplete?: () => void
  onFileSystemChange?: () => void
}

const EMPTY_PINNED_ITEMS: TabCodePinnedItem[] = []

// Git 状态着色：未跟踪绿名、冲突红、修改黄、删除红、已暂存新增绿。
const GIT_COLORS: Record<string, string> = {
  M: 'text-warning',
  A: 'text-success',
  D: 'text-destructive/80',
  U: 'text-destructive',
  R: 'text-info',
  C: 'text-info',
  '?': 'text-success',
}

const GIT_DOT_COLORS: Record<string, string> = {
  M: 'bg-warning/60',
  A: 'bg-success/60',
  D: 'bg-destructive/60',
  U: 'bg-destructive/60',
  R: 'bg-info/60',
  C: 'bg-info/60',
  '?': 'bg-success/60',
}

const SELECTED_ROW_CLASS = 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20'

function getGitStatusBadge(status: GitFileStatus | string | null): { label: string; color: string } | null {
  if (!status) return null
  // 未跟踪：绿名 + U；冲突 porcelain U：红名 + U
  if (status === '?') return { label: 'U', color: GIT_COLORS['?'] }
  return { label: status, color: GIT_COLORS[status] ?? '' }
}

function getGitStatusDotColor(status: GitFileStatus | string | null): string | null {
  if (!status) return null
  return GIT_DOT_COLORS[status] ?? 'bg-muted-foreground/60'
}

function findCompactGitDirectoryStatus(entry: CompactGitChangeTreeRow): string | null {
  if (entry.type !== 'directory') return null
  const findStatus = (children: typeof entry.children): string | null => {
    for (const child of children) {
      if (child.type === 'file' && child.status) return child.status
      if (child.type === 'directory') {
        const status = findStatus(child.children)
        if (status) return status
      }
    }
    return null
  }
  return findStatus(entry.children)
}

function activateRowFromKeyboard(event: React.KeyboardEvent, action: () => void): void {
  if (event.target !== event.currentTarget) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  action()
}

function runInlineGitAction(event: React.MouseEvent, action: () => void): void {
  event.preventDefault()
  event.stopPropagation()
  action()
}

interface GitInlineActionButtonProps {
  label: string
  onAction: () => void
  disabled?: boolean
  children: React.ReactNode
}

function GitInlineActionButton({
  label,
  onAction,
  disabled = false,
  children,
}: GitInlineActionButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => runInlineGitAction(event, onAction)}
    >
      {children}
    </button>
  )
}

interface GitActionResult {
  success?: boolean
  error?: unknown
  skippedPaths?: string[]
  skippedCount?: number
}



// ── 右键菜单状态 ──
interface CtxMenuState {
  open: boolean
  pos: { x: number; y: number } | null
  node: FileNode | null
  source: FileTreeContextSource | null
}

type NewItemState = { mode: 'file' | 'folder'; parentPath: string; depth: number } | null
type GitChangeSectionId = 'staged' | 'unstaged'

// ── 组件 ──
export const TabCodeFileTree: React.FC<TabCodeFileTreeProps> = ({
  rootPath,
  selectedFile,
  onOpenQuickOpen,
  initialExpandedDirs = [],
  onExpandedDirsChange,
  onFileSelect,
  onGitChangeFileSelect,
  onFileDoubleClick,
  gitStatus,
  stagedStatus,
  unstagedStatus,
  viewMode,
  isGitRepo = false,
  onGitActionComplete,
  onFileSystemChange,
}) => {
  const { t } = useTranslation('tabcode')
  const entryCacheRef = useRef(new Map<string, FileNode>())
  const rootPathRef = useRef(rootPath)
  const selectedFileRef = useRef(selectedFile)

  useEffect(() => { rootPathRef.current = rootPath }, [rootPath])
  useEffect(() => { selectedFileRef.current = selectedFile }, [selectedFile])

  const [newItem, setNewItem] = useState<NewItemState>(null)
  const [selectedNode, setSelectedNode] = useState<FileTreeSelection | null>(
    selectedFile ? { path: selectedFile, isDirectory: false } : null,
  )
  const [renameNode, setRenameNode] = useState<FileNode | null>(null)
  const [deleteNode, setDeleteNode] = useState<FileNode | null>(null)
  const [ctx, setCtx] = useState<CtxMenuState>({ open: false, pos: null, node: null, source: null })
  const [discardTarget, setDiscardTarget] = useState<FileNode | null>(null)
  const [collapsedGitDirectoryIds, setCollapsedGitDirectoryIds] = useState<Set<string>>(() => new Set())
  const [collapsedGitSectionIds, setCollapsedGitSectionIds] = useState<Set<GitChangeSectionId>>(() => new Set())

  useEffect(() => {
    setSelectedNode(selectedFile ? { path: selectedFile, isDirectory: false } : null)
  }, [rootPath, selectedFile])

  const pinnedItems = useTabCodeStore(s => s.pinnedItemsByRootPath[rootPath] ?? EMPTY_PINNED_ITEMS)
  const togglePinItem = useTabCodeStore(s => s.togglePinItem)
  const unpinItem = useTabCodeStore(s => s.unpinItem)

  const virtualizerRef = useRef<{ scrollToIndex: (index: number, opts?: object) => void } | null>(null)
  const treeRowsRef = useRef<{ type: string; data?: { path: string }; depth?: number }[]>([])

  // tree epoch —— 强制 treeRows useMemo 重算的显式信号。
  //
  // **headless-tree useTree 在 React 19 下的 setState bail-out 兼容性 bug**：
  // useTree 内部对 React 做了适配，但 mainFeature.setState 实现上只是把 state
  // 引用透给 React setState（不调 makeStateUpdater 给的 updater 函数）。state
  // 对象在 dataLoader 异步完成后被 mutate，但引用不变 → React Object.is bail
  // out → **不会触发重渲染**，列表卡在空状态。
  //
  // 唯一能可靠驱动 React 重渲染的途径就是从外部触发——`useReducer((x) => x + 1)`
  // 每次 dispatch 都返新数字，必触发 re-render。下面 useTree config 里的
  // `onLoadedChildren` 会在 dataLoader 完成填充 children 后调一次，进而
  // bumpTreeEpoch 把更新推给 React（详见 useTree 那段的注释）。
  //
  // 提到 useTree 之前定义是因为 useTree config 要引用 bumpTreeEpoch。
  const [treeEpoch, bumpTreeEpoch] = useReducer((x: number) => x + 1, 0)
  const pendingExpandedRestoreRef = useRef(new Set<string>())
  const expandedRestoreIdentityRef = useRef<string | null>(null)
  const expandedDirPathsRef = useRef<string[]>(initialExpandedDirs)
  const expandedRestoreRetryRef = useRef(0)

  // ── headless-tree ──
  const tree = useTree<FileNode>({
    rootItemId: 'root',
    getItemName: (item: ItemInstance<FileNode>) => item.getItemData()?.name ?? '',
    isItemFolder: (item: ItemInstance<FileNode>) => item.getItemData()?.isDirectory ?? false,
    scrollToItem: (item: ItemInstance<FileNode>) => {
      const path = item.getItemData()?.path
      if (!path) return
      const index = treeRowsRef.current.findIndex(r => r.type === 'item' && r.data?.path === path)
      if (index >= 0) virtualizerRef.current?.scrollToIndex(index, { align: 'start', behavior: 'auto' })
    },
    /**
     * dataLoader 完成 children 加载时触发——**这是修首次打开列表为空 dogfood
     * bug 的关键回调**。
     *
     * 背景：headless-tree 1.6.3 里 useTree 适配层把 `mainFeature.setState`
     * 实现成"忽略 updater + 透 state 引用给 React setState"，加上 createTree
     * 内部对 state 直接 mutate（`applySubStateUpdate` / loadingItemChildrens
     * 等），React Object.is 比较看到同一引用就 bail out 不重渲染。结果是
     * `dataLoader.getChildren('root')` 完成后 itemInstances 已被 rebuildItemMeta
     * 填充，但 React 不知道有变化 → tree.getItems() 仍读老快照 → treeRows
     * useMemo 不重算 → 列表为空，必须用户点刷新才能看见目录。
     *
     * onLoadedChildren 是 headless-tree 在每次 children 加载完成后调用的
     * lifecycle hook，紧跟 `tree.rebuildTree()`。这里我们 dispatch 一次
     * useReducer 强制 React 重渲染，让 treeRows useMemo 在 deps（含 treeEpoch）
     * 变化时重新求值，拿到 itemInstances 的新内容。
     *
     * 这条 fix 比"mount 时 invalidate"靠谱：
     *   - mount-time invalidate 会在 dataLoader **完成之前**就触发一次重渲染
     *     （tree.getItems() 当时还是空），渲染完之后 dataLoader 完成又 bail out
     *   - onLoadedChildren 精确卡在数据**已就位**的瞬间，重渲染时 tree.getItems()
     *     已有内容
     *
     * 任何节点（不仅 root）展开后异步加载完成都会触发——所以子目录展开也能
     * 正确显示，无需 caller 端额外补偿。
     */
    onLoadedChildren: () => {
      bumpTreeEpoch()
    },
    dataLoader: {
      getItem: async (itemId: string): Promise<FileNode> => {
        if (itemId === 'root') {
          return { id: 'root', name: basename(rootPathRef.current), path: rootPathRef.current, isDirectory: true }
        }
        const cached = entryCacheRef.current.get(itemId)
        if (cached) return cached
        const name = itemId.split('/').pop() ?? itemId
        return { id: itemId, name, path: itemId, isDirectory: false }
      },
      // 用 `getChildrenWithData` 而不是 `getChildren`：headless-tree 1.6.3 的
      // async dataLoader 流程是「先存 childrenIds → rebuildTree → 各子项的
      // itemData 由 React 渲染时 setTimeout 异步加载」。子项 itemData 在第一次
      // re-render 时还是 undefined，treeRows 里的 `if (!data) continue` 会把
      // 它们全部跳过 → 列表显示为空，必须等下一次刷新（onLoadedChildren 重
      // 触发 bumpTreeEpoch）才会出现条目，对应 dogfood "新项目首次空树要刷新"。
      //
      // 改用 getChildrenWithData：库里 `if ("getChildrenWithData" in dataLoader)`
      // 分支会把每个 child 的 itemData 同步塞进 `dataRef.current.itemData[id]`
      // 再调 onLoadedChildren + rebuildTree，紧接着的重渲染就能拿到真实 data。
      // readDir 本来就一次返了完整 entries，正好顺手填上。
      getChildrenWithData: async (itemId: string): Promise<{ id: string; data: FileNode }[]> => {
        const dirPath = itemId === 'root' ? rootPathRef.current : itemId
        try {
          // contract W2-β: channel `fs:readDir` 在 LEGACY_HANDLERS 内（preload 透传）。
          // tree-view 单条 readDir 失败 → 仍返空数组让该节点显示为空目录（fail-soft），
          // 不阻塞整棵树渲染。用 isLegacyOk 把字面 success 收口到 helper。
          //
          // 不做名字过滤：code 模块一律显示所有 entries（与常见代码编辑器一致）
          // （包括 .cursor / .vscode / .git / node_modules 等）。性能/可读性是
          // 用户自己用 .gitignore 或者折叠节点处理的事，不该在 UI 层硬藏。
          // 搜索索引另有性能黑名单（SEARCH_INDEX_SKIP_NAMES），那是另一码事。
          const dirRes = await window.tabtin.fileSystem.readDir(dirPath)
          if (!isLegacyOk(dirRes) || !dirRes.entries) return []
          const result: { id: string; data: FileNode }[] = []
          for (const e of dirRes.entries) {
            const node: FileNode = { id: e.path, name: e.name, path: e.path, isDirectory: e.isDirectory }
            entryCacheRef.current.set(e.path, node)
            result.push({ id: e.path, data: node })
          }
          return result
        } catch (err) {
          console.warn('[TabCodeFileTree] readDir failed:', dirPath, err)
          return []
        }
      },
    },
    features: [asyncDataLoaderFeature, selectionFeature],
  })

  const reportExpandedDirs = useCallback(() => {
    // 记录用户意图而非读取 headless-tree 的异步内部状态：后者在 `expand()`
    // resolve 后仍可能未提交，曾导致持久化写回空数组。
    if (pendingExpandedRestoreRef.current.size > 0) return
    onExpandedDirsChange?.(expandedDirPathsRef.current)
  }, [onExpandedDirsChange])

  const updateExpandedDirs = useCallback((update: (paths: string[]) => string[]) => {
    expandedDirPathsRef.current = [...new Set(update(expandedDirPathsRef.current))]
    reportExpandedDirs()
  }, [reportExpandedDirs])

  // 恢复时逐层展开：只有父项实际加载到 tree 后才会尝试展开子项。
  // 因此已删除/改名路径不会对不存在的目录发 readDir，更不会把错误冒到用户。
  useEffect(() => {
    const restoreIdentity = `${rootPath}\0${initialExpandedDirs.join('\0')}`
    if (expandedRestoreIdentityRef.current !== restoreIdentity) {
      expandedRestoreIdentityRef.current = restoreIdentity
      pendingExpandedRestoreRef.current = new Set(initialExpandedDirs)
      expandedDirPathsRef.current = [...new Set(initialExpandedDirs)]
      expandedRestoreRetryRef.current = 0
    }

    const pendingPaths = [...pendingExpandedRestoreRef.current]
      .sort((a, b) => a.split('/').length - b.split('/').length)
    const item = tree.getItems().find((candidate) => {
      const path = candidate.getItemData()?.path
      return path ? pendingPaths.includes(path) : false
    })
    if (!item) {
      // 根目录的异步 children 加载与 headless-tree 的实例 rebuild 不在同一
      // React tick；缺实例时短暂重试，等真实 tree node 就绪再展开。
      if (pendingExpandedRestoreRef.current.size > 0 && expandedRestoreRetryRef.current < 20) {
        expandedRestoreRetryRef.current += 1
        const timer = window.setTimeout(bumpTreeEpoch, 100)
        return () => window.clearTimeout(timer)
      }
      return
    }

    const nextPath = item.getItemData()?.path
    if (!nextPath) return
    expandedRestoreRetryRef.current = 0
    pendingExpandedRestoreRef.current.delete(nextPath)
    if (item.isExpanded()) {
      reportExpandedDirs()
      return
    }

    item.expand()
    // 子项加载完成会通过 onLoadedChildren() 再次 bump，届时继续恢复下一层。
    bumpTreeEpoch()
  }, [rootPath, initialExpandedDirs, tree, treeEpoch, reportExpandedDirs])

  // 切换最近项目（rootPath 变化）时清 entryCache + invalidate root。
  //
  // **首次 mount 不需要这里做事**——useTree 内部会自己启动 dataLoader 拉
  // root children，完成后 onLoadedChildren 触发 bumpTreeEpoch 让 React 重渲染
  // （见上方 useTree 的 onLoadedChildren 注释）。
  //
  // 但**切换项目**时需要这条 effect：上一个项目的 entry 缓存里残留着旧路径
  // 的 FileNode 数据，新项目 dataLoader 拉到同名子目录时可能复用旧节点导致
  // 渲染错位。invalidateChildrenIds 让 headless-tree 内部 dataRef 失效，
  // 重新走一遍 dataLoader → onLoadedChildren → bumpTreeEpoch 链路。
  //
  // **mount 时 prevRootRef.current === rootPath 不触发**——把 mount 留给
  // useTree 自己的初始化流程；只有真正切换项目才进 if 分支。
  const prevRootRef = useRef(rootPath)
  useEffect(() => {
    if (prevRootRef.current !== rootPath) {
      entryCacheRef.current.clear()
      tree.getItemInstance('root')?.invalidateChildrenIds()
    }
    prevRootRef.current = rootPath
  }, [rootPath, tree])

  // Quick Open 与文件树共享这份索引；文件树自身不再维护独立搜索结果视图。
  const { invalidateIndex, addEntry, removeEntriesByParent } = useFileSearch({
    rootPath,
    searchTerm: '',
  })

  // 文件系统变更监听：useFolderWatch 包揽 watch 启动 / 失败 fallback / unwatch
  // / 200ms 防抖；useTabCodeWatchSync 在其上做 tabcode 特有的同步——entryCache
  // 失效、headless-tree 节点 invalidate、Fuse 索引按 parent 重建。这两层加
  // 起来取代了原先 100+ 行的 inline pending/flush/timer 逻辑。
  useTabCodeWatchSync({
    rootPath: rootPath || null,
    tree,
    entryCacheRef,
    bumpTreeEpoch,
    invalidateIndex,
    addEntry,
    removeEntriesByParent,
    onFileSystemChange,
  })

  // ── 文件操作 ──
  const { createFile, createDirectory, rename, moveToDirectory, deleteItem, isDeleting } = useFileTreeActions({
    rootPath,
    onRefresh: async (parentPaths: string | string[]) => {
      const paths = Array.isArray(parentPaths) ? parentPaths : [parentPaths]
      for (const parentPath of paths) {
        const item = parentPath === rootPath
          ? tree.getItemInstance('root')
          : tree.getItemInstance(parentPath)
        item?.invalidateChildrenIds()
      }
      bumpTreeEpoch()
      invalidateIndex()
    },
  })

  // ── 钉住 ──
  const pinnedPathSet = useMemo(() => new Set(pinnedItems.map(i => i.path)), [pinnedItems])

  const unstagedGitChangeRows = useMemo(() => {
    if (viewMode === 'all') return []
    const tree = buildCompactGitChangeTree(rootPath, Array.from(unstagedStatus.entries()).map(([path, status]) => ({
      path,
      status,
    })))
    return flattenCompactGitChangeTree(tree, collapsedGitDirectoryIds)
  }, [rootPath, viewMode, unstagedStatus, collapsedGitDirectoryIds])

  const stagedGitChangeRows = useMemo(() => {
    if (viewMode === 'all') return []
    const tree = buildCompactGitChangeTree(rootPath, Array.from(stagedStatus.entries()).map(([path, status]) => ({
      path,
      status,
    })))
    return flattenCompactGitChangeTree(tree, collapsedGitDirectoryIds)
  }, [rootPath, viewMode, stagedStatus, collapsedGitDirectoryIds])

  const toggleGitDirectory = useCallback((id: string) => {
    setCollapsedGitDirectoryIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleGitSection = useCallback((id: GitChangeSectionId) => {
    setCollapsedGitSectionIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── 虚拟滚动 ──
  type TreeRow =
    | { type: 'item'; item: ItemInstance<FileNode>; data: FileNode }
    | { type: 'new-input'; depth: number }

  const scrollRef = useRef<HTMLDivElement>(null)
  const treeVirtualRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)

  const treeRows = useMemo<TreeRow[]>(() => {
    if (viewMode !== 'all') return []
    const rows: TreeRow[] = []
    for (const item of tree.getItems()) {
      const data = item.getItemData()
      if (!data || item.getId() === 'root') continue
      rows.push({ type: 'item', item, data })
      if (newItem && data.isDirectory && data.path === newItem.parentPath) {
        rows.push({ type: 'new-input', depth: item.getItemMeta().level + 1 })
      }
    }
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, viewMode, newItem, treeEpoch, tree.getItems().length])
  const hasInlineNewItemRow = treeRows.some(row => row.type === 'new-input')
  const isTreeExpanded = viewMode === 'all' && tree.getState().expandedItems.length > 0

  useLayoutEffect(() => {
    const el = treeVirtualRef.current
    if (!el) return
    const m = el.offsetTop
    if (m !== scrollMargin) setScrollMargin(m)
  }, [treeRows.length, scrollMargin])

  // react-virtual 3.13+ 要求 getItemKey 稳定，inline 函数会
  // 让测量缓存反复失效触发死循环。用 useCallback 永久稳定，treeRows 通过
  // 已有的 treeRowsRef 访问。
  treeRowsRef.current = treeRows

  const getScrollElement = useCallback(() => scrollRef.current, [])
  const estimateSize = useCallback(() => ROW_HEIGHT, [])
  const getItemKey = useCallback((i: number) => {
    const row = treeRowsRef.current[i]
    if (!row) return `__missing-${i}__`
    if (row.type === 'item') return row.data?.path ?? `__item-${i}__`
    return `__new-input-${row.depth}__`
  }, [])

  // hot-spaces 治理：见 `hooks/useScrollPositionPreserve.ts` 文件头注释。
  const { isForeground } = useSpaceActivity()
  const virtualizer = useSafeVirtualizer({
    count: treeRows.length,
    getScrollElement,
    estimateSize,
    scrollMargin,
    overscan: 20,
    getItemKey,
    enabled: isForeground,
  })
  virtualizerRef.current = virtualizer

  useScrollPositionPreserve({
    scrollElementRef: scrollRef,
    totalSize: virtualizer.getTotalSize(),
    scopeKey: rootPath,
  })

  // ── 事件处理 ──
  const closeCtx = useCallback(() => setCtx({ open: false, pos: null, node: null, source: null }), [])

  const handleRightClick = useCallback((e: React.MouseEvent, node: FileNode, source: FileTreeContextSource) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedNode({ path: node.path, isDirectory: node.isDirectory })
    setCtx({ open: true, pos: { x: e.clientX, y: e.clientY }, node, source })
  }, [])

  const handleSend = useCallback(async (filePath: string) => {
    try {
      const r = await window.tabtin.fileSystem.readFilePreview(filePath, { maxBytes: 4096 })
      sendCodeContextToChat({
        type: 'code_file', resourceId: filePath,
        label: basename(filePath),
        preview: r?.data?.content?.slice(0, 2000) || filePath,
        meta: { filePath, rootPath },
      })
    } catch {
      sendCodeContextToChat({
        type: 'code_file', resourceId: filePath,
        label: basename(filePath),
        meta: { filePath, rootPath },
      })
    }
  }, [rootPath])

  const handleCopy = useCallback((p: string) => { navigator.clipboard.writeText(p) }, [])
  const handleCopyRelative = useCallback((p: string) => {
    navigator.clipboard.writeText(relativePath(rootPath, p))
  }, [rootPath])
  const handleReveal = useCallback((p: string) => {
    window.tabtin.showItemInFolder(p).catch(() => {})
  }, [])

  const handleTogglePin = useCallback((node: FileNode) => {
    togglePinItem(rootPath, { path: node.path, name: node.name, isDirectory: node.isDirectory })
  }, [rootPath, togglePinItem])

  const runGitPathAction = useCallback(async ({
    action,
    relPaths,
    run,
    successTitle,
    successDescription,
  }: {
    action: string
    relPaths: string[]
    run: () => Promise<GitActionResult | null | undefined>
    successTitle: string
    successDescription: string
  }) => {
    try {
      const result = await run()
      if (result?.success) {
        const skippedCount = result.skippedCount ?? result.skippedPaths?.length ?? 0
        const description = skippedCount > 0
          ? (action.startsWith('unstage')
              ? t('gitFlow.unstageSkippedDenied', { count: skippedCount })
              : t('gitFlow.stageSkippedDenied', { count: skippedCount }))
          : successDescription
        toast({ title: successTitle, description })
        onGitActionComplete?.()
      } else {
        logGitActionFailure(action, rootPath, relPaths, result?.error)
        toast({ title: t('contextMenu.gitActionFailed'), description: formatGitErrorForToast(result, t) })
      }
    } catch (error) {
      logGitActionFailure(action, rootPath, relPaths, error)
      toast({ title: t('contextMenu.gitActionFailed'), description: formatGitErrorForToast(error, t) })
    }
  }, [rootPath, t, onGitActionComplete])

  const handleStageNode = useCallback(async (node: FileNode) => {
    const rel = relativePath(rootPath, node.path)
    await runGitPathAction({
      action: 'stage-file-tree-node',
      relPaths: [rel],
      run: () => window.tabtin.git.stageFiles(rootPath, [rel]),
      successTitle: t('contextMenu.stageSuccessTitle'),
      successDescription: t('contextMenu.stageSuccessDesc', { name: node.name }),
    })
  }, [rootPath, t, runGitPathAction])

  const handleUnstageNode = useCallback(async (node: FileNode) => {
    const rel = relativePath(rootPath, node.path)
    await runGitPathAction({
      action: 'unstage-file-tree-node',
      relPaths: [rel],
      run: () => window.tabtin.git.unstageFiles(rootPath, [rel]),
      successTitle: t('contextMenu.unstageSuccessTitle'),
      successDescription: t('contextMenu.unstageSuccessDesc', { name: node.name }),
    })
  }, [rootPath, t, runGitPathAction])

  const handleStageAllChanges = useCallback(async () => {
    const relPaths = Array.from(unstagedStatus.keys()).map(path => relativePath(rootPath, path))
    if (relPaths.length === 0) return
    await runGitPathAction({
      action: 'stage-git-change-section',
      relPaths,
      run: () => window.tabtin.git.stageFiles(rootPath, relPaths),
      successTitle: t('contextMenu.stageSuccessTitle'),
      successDescription: t('toolbar.unstagedCount', { count: relPaths.length }),
    })
  }, [rootPath, unstagedStatus, t, runGitPathAction])

  const handleUnstageAllChanges = useCallback(async () => {
    const relPaths = Array.from(stagedStatus.keys()).map(path => relativePath(rootPath, path))
    if (relPaths.length === 0) return
    await runGitPathAction({
      action: 'unstage-git-change-section',
      relPaths,
      run: () => window.tabtin.git.unstageFiles(rootPath, relPaths),
      successTitle: t('contextMenu.unstageSuccessTitle'),
      successDescription: t('toolbar.stagedCount', { count: relPaths.length }),
    })
  }, [rootPath, stagedStatus, t, runGitPathAction])

  const handleDiscardNode = useCallback((node: FileNode) => {
    setDiscardTarget(node)
  }, [])

  const doDiscard = useCallback(async () => {
    const node = discardTarget
    if (!node) return
    setDiscardTarget(null)
    try {
      const rel = relativePath(rootPath, node.path)
      const result = await window.tabtin.git.discardFiles(rootPath, [rel])
      if (result?.success) {
        toast({ title: t('contextMenu.discardSuccessTitle'), description: t('contextMenu.discardSuccessDesc', { name: node.name }) })
        onGitActionComplete?.()
      } else {
        logGitActionFailure('discard-file-tree-node', rootPath, [rel], result?.error)
        toast({ title: t('contextMenu.gitActionFailed'), description: formatGitErrorForToast(result, t) })
      }
    } catch (error) {
      logGitActionFailure('discard-file-tree-node', rootPath, [relativePath(rootPath, node.path)], error)
      toast({ title: t('contextMenu.gitActionFailed'), description: formatGitErrorForToast(error, t) })
    }
  }, [discardTarget, rootPath, t, onGitActionComplete])

  const handleMoveEntry = useCallback(async (sourcePath: string, targetDirPath: string) => {
    const oldSelected = selectedFileRef.current
    const ok = await moveToDirectory(sourcePath, targetDirPath)
    if (!ok) return
    entryCacheRef.current.delete(sourcePath)
    const fileName = sourcePath.split('/').pop() ?? ''
    const newPath = `${targetDirPath.replace(/\/$/, '')}/${fileName}`
    entryCacheRef.current.delete(newPath)
    tree.getItemInstance(sourcePath)?.invalidateChildrenIds()
    tree.getItemInstance(targetDirPath)?.invalidateChildrenIds()
    bumpTreeEpoch()
    invalidateIndex()
    if (oldSelected === sourcePath) onFileSelect(newPath)
  }, [moveToDirectory, tree, invalidateIndex, onFileSelect])

  const { getDragHandlers, getDropHandlers, getRootDropHandlers, isDropTarget, isDragging } = useFileTreeDragDrop({
    onMove: handleMoveEntry,
    // ：让文件树项可拖入对话框——写入聊天引用载荷并放宽 effectAllowed。
    onDragStartExtra: useCallback((e: React.DragEvent, node: { path: string; isDirectory: boolean }) => {
      e.dataTransfer.effectAllowed = 'copyMove'
      writeFileTreeChatDragData(e.dataTransfer, node, { rootPath })
    }, [rootPath]),
  })

  const resolveNewDepth = useCallback((parentPath: string) => {
    if (parentPath === rootPath) return 0
    const item = tree.getItemInstance(parentPath)
    return (item?.getItemMeta().level ?? 0) + 1
  }, [rootPath, tree])

  // 新建文件/文件夹
  const handleNewFile = useCallback(async (parentPath: string, depth: number) => {
    const parentItem = parentPath === rootPath
      ? tree.getItemInstance('root')
      : tree.getItemInstance(parentPath)
    if (parentItem && !parentItem.isExpanded()) await parentItem.expand()
    if (parentPath !== rootPath) {
      updateExpandedDirs((paths) => [...paths, parentPath])
    }
    reportExpandedDirs()
    setNewItem({ mode: 'file', parentPath, depth })
  }, [rootPath, tree, reportExpandedDirs, updateExpandedDirs])

  const handleNewFolder = useCallback(async (parentPath: string, depth: number) => {
    const parentItem = parentPath === rootPath
      ? tree.getItemInstance('root')
      : tree.getItemInstance(parentPath)
    if (parentItem && !parentItem.isExpanded()) await parentItem.expand()
    if (parentPath !== rootPath) {
      updateExpandedDirs((paths) => [...paths, parentPath])
    }
    reportExpandedDirs()
    setNewItem({ mode: 'folder', parentPath, depth })
  }, [rootPath, tree, reportExpandedDirs, updateExpandedDirs])

  const handleNewItemSubmit = useCallback(async (name: string) => {
    if (!newItem) return
    const { mode, parentPath } = newItem
    try {
      if (mode === 'file') {
        const ok = await createFile(parentPath, name)
        if (!ok) return
        const filePath = `${parentPath}/${name}`
        const exists = await window.tabtin.fileSystem.readFilePreview(filePath, { maxBytes: 1 })
        if (exists.success) onFileSelect(filePath)
      } else {
        const ok = await createDirectory(parentPath, name)
        if (!ok) return
      }
      setNewItem(null)
    } catch { /* errors already handled in useFileTreeActions */ }
  }, [newItem, createFile, createDirectory, onFileSelect])

  const handleNewItemCancel = useCallback(() => {
    setNewItem(null)
  }, [])

  // 重命名
  const handleRenameSubmit = useCallback(async (newName: string) => {
    if (!renameNode) return
    const oldPath = renameNode.path
    const parentPath = oldPath.split('/').slice(0, -1).join('/') || rootPath
    const newPath = `${parentPath}/${newName}`
    setRenameNode(null)
    const ok = await rename(oldPath, newName)
    if (ok && selectedFileRef.current === oldPath) onFileSelect(newPath)
  }, [renameNode, rootPath, rename, onFileSelect])

  // 删除
  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteNode) return
    const wasSelected = selectedFileRef.current === deleteNode.path
    const isDir = deleteNode.isDirectory
    await deleteItem(deleteNode.path, isDir)
    setDeleteNode(null)
    if (wasSelected) {
      // 无法直接清除 selectedFile，通过选择一个空路径
      // 让父组件处理（预览面板会 fallback）
    }
  }, [deleteNode, deleteItem])

  const handleCollapseAll = useCallback(() => {
    // 不注册 expandAllFeature，避免带回“全部展开”快捷键；直接清空完整展开状态，
    // 同时覆盖被已折叠祖先隐藏、当前不在 treeRows 中的后代目录。
    tree.applySubStateUpdate('expandedItems', [])
    tree.rebuildTree()
    bumpTreeEpoch()
    updateExpandedDirs(() => [])
  }, [tree, updateExpandedDirs])

  // 刷新
  const handleRefresh = useCallback(() => {
    entryCacheRef.current.clear()
    invalidateVisibleExpandedTree(tree)
    bumpTreeEpoch()
    invalidateIndex()
    onFileSystemChange?.()
  }, [tree, invalidateIndex, onFileSystemChange])

  // 钉住节点点击
  const pinnedOpenIntentRef = useRef(new Set<string>())
  const handlePinnedNodeClick = useCallback(async (
    pinnedItem: TabCodePinnedItem,
    openAsTab = false,
  ) => {
    if (openAsTab) pinnedOpenIntentRef.current.add(pinnedItem.path)
    try {
      // contract W2-β: pinned-node existence check —— fs:readDir / fs:readFilePreview
      // 在 LEGACY_HANDLERS 内。失败 = pinned 项已不存在（被删 / 移动），主动 unpin
      // 是 fail-soft 行为；用 ensureLegacyOk 转 throw 走 catch 块统一处理（exhaustive
      // 而不是各分支重复）。
      if (pinnedItem.isDirectory) {
        const dirRes = await window.tabtin.fileSystem.readDir(pinnedItem.path)
        ensureLegacyOk(dirRes, 'pinned node readDir')
      } else {
        const previewRes = await window.tabtin.fileSystem.readFilePreview(pinnedItem.path, { maxBytes: 1 })
        ensureLegacyOk(previewRes, 'pinned node readFilePreview')
      }
    } catch {
      pinnedOpenIntentRef.current.delete(pinnedItem.path)
      unpinItem(rootPath, pinnedItem.path)
      toast({ title: t('fileTree.pinnedRemovedTitle'), description: t('fileTree.pinnedRemovedDesc', { name: pinnedItem.name }) })
      return
    }
    setSelectedNode({ path: pinnedItem.path, isDirectory: pinnedItem.isDirectory })
    if (!pinnedItem.isDirectory) {
      const shouldOpenAsTab = openAsTab || pinnedOpenIntentRef.current.has(pinnedItem.path)
      if (shouldOpenAsTab && onFileDoubleClick) onFileDoubleClick(pinnedItem.path)
      else onFileSelect(pinnedItem.path)
    }
    if (openAsTab) pinnedOpenIntentRef.current.delete(pinnedItem.path)
  }, [rootPath, unpinItem, t, onFileSelect, onFileDoubleClick])

  // ── 键盘快捷键 ──
  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent, node: FileNode) => {
    if (e.key === 'F2') {
      e.preventDefault()
      setRenameNode(node)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      setDeleteNode(node)
    }
  }, [])

  // ── 渲染单个 headless-tree 节点（每行严格一个元素，适配虚拟滚动）──
  const renderTreeItem = useCallback((item: ItemInstance<FileNode>) => {
    const data = item.getItemData()
    if (!data || item.getId() === 'root') return null
    const isFolder = data.isDirectory
    const isExpanded = item.isExpanded()
    const level = item.getItemMeta().level
    const selected = isFileTreeNodeSelected(selectedNode, data.path)
    // 必须直接读 gitStatus prop：原先经 useEffect 同步的 ref 会在 status
    // 到达后的那一帧仍是旧 Map，且 effect 更新 ref 不会再触发重渲染，
    // 表现为顶栏「N 文件变更」已有数、目录树却一直没有颜色/字母徽章。
    const st = findGitTreeStatus(data.path, gitStatus.entries())
    const stBadge = getGitStatusBadge(st)
    const descendantStatus = isFolder
      ? findDescendantGitTreeStatus(data.path, gitStatus.entries())
      : null
    const descendantBadge = getGitStatusBadge(descendantStatus)
    const descendantDotColor = isFolder
      ? getGitStatusDotColor(descendantStatus)
      : null

    if (renameNode?.path === data.path) {
      return (
        <RenameInput
          name={data.name}
          isDirectory={isFolder}
          depth={level}
          onSubmit={handleRenameSubmit}
          onCancel={() => setRenameNode(null)}
        />
      )
    }

    const dragHandlers = getDragHandlers({ path: data.path, isDirectory: isFolder })
    const dropHandlers = isFolder
      ? getDropHandlers({ path: data.path, isDirectory: true })
      : undefined

    return (
      <button
        {...item.getProps()}
        {...dragHandlers}
        {...dropHandlers}
        className={`
          flex items-center w-full text-left
          text-body leading-[18px]
          rounded-md mx-1 transition-colors duration-75
          ${selected
            ? SELECTED_ROW_CLASS
            : 'text-foreground/80 hover:bg-muted/30 hover:text-foreground'
          }
          ${st === 'D' ? 'line-through opacity-40' : ''}
          ${isFolder && isDropTarget(data.path) ? 'ring-1 ring-primary/40 bg-primary/8' : ''}
          ${isDragging(data.path) ? 'opacity-40' : ''}
        `}
        style={{ paddingLeft: level * TREE_INDENT, height: ROW_HEIGHT, width: 'calc(100% - 8px)' }}
        role="treeitem"
        aria-expanded={isFolder ? isExpanded : undefined}
        aria-selected={selected}
        onClick={(e) => {
          e.stopPropagation()
          setSelectedNode({ path: data.path, isDirectory: isFolder })
          if (isFolder) {
            if (isExpanded) {
              updateExpandedDirs((paths) => (
                paths.filter((path) => path !== data.path && !path.startsWith(`${data.path}/`))
              ))
              item.collapse()
            } else {
              updateExpandedDirs((paths) => [...paths, data.path])
              item.expand()
              bumpTreeEpoch()
            }
          } else {
            onFileSelect(data.path)
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (!isFolder && onFileDoubleClick) {
            onFileDoubleClick(data.path)
          }
        }}
        onContextMenu={(e) => handleRightClick(e, data, 'tree')}
        onKeyDown={(e) => handleTreeKeyDown(e, data)}
      >
        <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
          {isFolder && (
            isExpanded
              ? <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
              : <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          )}
        </span>

        <FileIcon
          fileName={data.name}
          isDirectory={isFolder}
          isOpen={isExpanded}
          className="h-3.5 w-3.5 shrink-0 mr-1"
        />

        <span className={`min-w-0 flex-1 truncate ${
          isFolder ? descendantBadge?.color ?? '' : stBadge?.color ?? ''
        }`}>{data.name}</span>

        {isFolder && descendantDotColor && (
          <span className={`ml-1 mr-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${descendantDotColor}`} />
        )}
        {!isFolder && stBadge && (
          <span className={`flex-shrink-0 ml-1 mr-1 text-caption font-semibold ${stBadge.color} opacity-80`}>
            {stBadge.label}
          </span>
        )}
      </button>
    )
  }, [
    gitStatus, selectedNode, renameNode,
    onFileSelect, onFileDoubleClick, handleRightClick, handleTreeKeyDown,
    handleRenameSubmit, updateExpandedDirs,
    getDragHandlers, getDropHandlers, isDropTarget, isDragging,
  ])

  const renderGitChangeRow = useCallback((entry: CompactGitChangeTreeRow, sectionId: GitChangeSectionId) => {
    const depth = entry.depth + 1

    if (entry.type === 'directory') {
      const collapsed = collapsedGitDirectoryIds.has(entry.id)
      const dotColor = getGitStatusDotColor(findCompactGitDirectoryStatus(entry))
      const directoryPath = `${rootPath.replace(/[\\/]+$/, '')}/${entry.id}`
      const selected = isFileTreeNodeSelected(selectedNode, directoryPath)
      const node: FileNode = {
        id: directoryPath,
        name: entry.name,
        path: directoryPath,
        isDirectory: true,
      }

      return (
        <div
          key={entry.id}
          role="button"
          tabIndex={0}
          className={`
            group/git-row flex w-full items-center rounded-md mx-1 text-left text-body leading-[18px] transition-colors duration-75
            ${selected ? SELECTED_ROW_CLASS : 'text-foreground/80 hover:bg-muted/30 hover:text-foreground'}
          `}
          style={{ paddingLeft: depth * TREE_INDENT, height: ROW_HEIGHT, width: 'calc(100% - 8px)' }}
          aria-current={selected ? 'true' : undefined}
          onClick={() => {
            setSelectedNode({ path: directoryPath, isDirectory: true })
            toggleGitDirectory(entry.id)
          }}
          onKeyDown={(event) => activateRowFromKeyboard(event, () => {
            setSelectedNode({ path: directoryPath, isDirectory: true })
            toggleGitDirectory(entry.id)
          })}
        >
          <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
            {collapsed
              ? <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
              : <ChevronDown className="h-3 w-3 text-muted-foreground/60" />}
          </span>
          <FileIcon
            fileName={entry.name.split('/').pop() || entry.name}
            isDirectory
            isOpen={!collapsed}
            className="h-3.5 w-3.5 shrink-0 mr-1"
          />
          <span className="min-w-0 flex-1 truncate text-foreground/80">{entry.name}</span>
          <span className="ml-1 mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/git-row:opacity-100 group-focus-within/git-row:opacity-100">
            {sectionId === 'unstaged' ? (
              <>
                <GitInlineActionButton
                  label={t('contextMenu.discardChanges')}
                  onAction={() => handleDiscardNode(node)}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </GitInlineActionButton>
                <GitInlineActionButton
                  label={t('contextMenu.stageFile')}
                  onAction={() => void handleStageNode(node)}
                >
                  <Plus className="h-3.5 w-3.5" />
                </GitInlineActionButton>
              </>
            ) : (
              <GitInlineActionButton
                label={t('contextMenu.unstageFile')}
                onAction={() => void handleUnstageNode(node)}
              >
                <Minus className="h-3.5 w-3.5" />
              </GitInlineActionButton>
            )}
          </span>
          {dotColor && (
            <span className={`ml-1 mr-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotColor}`} />
          )}
        </div>
      )
    }

    const selected = isFileTreeNodeSelected(selectedNode, entry.path)
    const stBadge = getGitStatusBadge(entry.status)
    const node: FileNode = {
      id: entry.path,
      name: entry.name,
      path: entry.path,
      isDirectory: false,
    }
    const selectGitChangeFile = () => {
      setSelectedNode({ path: entry.path, isDirectory: false })
      if (onGitChangeFileSelect) onGitChangeFileSelect(entry.path, sectionId)
      else onFileSelect(entry.path)
    }
    return (
      <div
        key={entry.path}
        role="button"
        tabIndex={0}
        className={`
          group/git-row flex w-full items-center rounded-md mx-1 text-left text-body leading-[18px] transition-colors duration-75
          ${selected ? SELECTED_ROW_CLASS : 'text-foreground/80 hover:bg-muted/30 hover:text-foreground'}
        `}
        style={{ paddingLeft: depth * TREE_INDENT, height: ROW_HEIGHT, width: 'calc(100% - 8px)' }}
        aria-current={selected ? 'true' : undefined}
        onClick={selectGitChangeFile}
        onKeyDown={(event) => activateRowFromKeyboard(event, selectGitChangeFile)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          selectGitChangeFile()
        }}
        onContextMenu={(e) => handleRightClick(e, node, 'tree')}
      >
        <span className="w-4 h-4 flex items-center justify-center flex-shrink-0" />
        <FileIcon fileName={entry.name} isDirectory={false} className="h-3.5 w-3.5 shrink-0 mr-1" />
        <span className="min-w-0 flex-1 truncate text-body">{entry.name}</span>
        <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/git-row:opacity-100 group-focus-within/git-row:opacity-100">
          <GitInlineActionButton
            label={t('contextMenu.openFile')}
            onAction={selectGitChangeFile}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </GitInlineActionButton>
          {sectionId === 'unstaged' ? (
            <>
              <GitInlineActionButton
                label={t('contextMenu.discardChanges')}
                onAction={() => handleDiscardNode(node)}
              >
                <Undo2 className="h-3.5 w-3.5" />
              </GitInlineActionButton>
              <GitInlineActionButton
                label={t('contextMenu.stageFile')}
                onAction={() => void handleStageNode(node)}
              >
                <Plus className="h-3.5 w-3.5" />
              </GitInlineActionButton>
            </>
          ) : (
            <GitInlineActionButton
              label={t('contextMenu.unstageFile')}
              onAction={() => void handleUnstageNode(node)}
            >
              <Minus className="h-3.5 w-3.5" />
            </GitInlineActionButton>
          )}
        </span>
        {stBadge && (
          <span className={`shrink-0 ml-1 mr-1 text-caption font-semibold ${stBadge.color} opacity-80`}>
            {stBadge.label}
          </span>
        )}
      </div>
    )
  }, [
    collapsedGitDirectoryIds,
    selectedNode,
    onFileSelect,
    onGitChangeFileSelect,
    handleRightClick,
    toggleGitDirectory,
    t,
    rootPath,
    handleStageNode,
    handleUnstageNode,
    handleDiscardNode,
  ])

  const renderGitChangeSection = useCallback((
    sectionId: GitChangeSectionId,
    label: string,
    count: number,
    rows: CompactGitChangeTreeRow[],
  ) => {
    const collapsed = collapsedGitSectionIds.has(sectionId)
    const actionLabel = sectionId === 'staged' ? t('contextMenu.unstageFile') : t('contextMenu.stageFile')
    const runSectionAction = sectionId === 'staged' ? handleUnstageAllChanges : handleStageAllChanges

    return (
      <div key={sectionId} className="mb-2 last:mb-0">
        <div
          role="button"
          tabIndex={0}
          className="group/git-section mx-1 flex w-[calc(100%-8px)] items-center rounded-md text-left text-body leading-[18px] text-foreground/80 transition-colors duration-75 hover:bg-muted/30 hover:text-foreground"
          style={{ height: ROW_HEIGHT }}
          onClick={() => toggleGitSection(sectionId)}
          onKeyDown={(event) => activateRowFromKeyboard(event, () => toggleGitSection(sectionId))}
          aria-expanded={!collapsed}
        >
          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
            <ChevronRight
              className={cn(
                'h-3 w-3 text-muted-foreground/60 transition-transform duration-200 ease-out motion-reduce:transition-none',
                !collapsed && 'rotate-90',
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="ml-1 mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/git-section:opacity-100 group-focus-within/git-section:opacity-100">
            <GitInlineActionButton
              label={actionLabel}
              disabled={count === 0}
              onAction={() => void runSectionAction()}
            >
              {sectionId === 'staged'
                ? <Minus className="h-3.5 w-3.5" />
                : <Plus className="h-3.5 w-3.5" />}
            </GitInlineActionButton>
          </span>
          <span className="mr-1 text-caption tabular-nums text-muted-foreground/80">{count}</span>
        </div>
        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
            collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
          )}
          aria-hidden={collapsed}
        >
          <div className={cn('min-h-0 overflow-hidden', collapsed && 'pointer-events-none')}>
            <div className="flex flex-col gap-0.5">
              {rows.map(row => renderGitChangeRow(row, sectionId))}
            </div>
          </div>
        </div>
      </div>
    )
  }, [
    collapsedGitSectionIds,
    renderGitChangeRow,
    toggleGitSection,
    t,
    handleStageAllChanges,
    handleUnstageAllChanges,
  ])

  // ── 右键菜单信息 ──
  const isCtxPinned = ctx.node ? pinnedPathSet.has(ctx.node.path) : false
  const isCtxStaged = ctx.node ? stagedStatus.has(ctx.node.path) : false
  const isCtxUnstaged = ctx.node ? unstagedStatus.has(ctx.node.path) : false
  const ctxMenuModel = ctx.node && ctx.source ? getFileTreeContextMenuModel(ctx.node, ctx.source) : null
  const newItemParentPath = resolveNewItemParentPath(rootPath, selectedNode)
  const showNewItemFallback = shouldRenderNewItemFallback(
    Boolean(newItem),
    viewMode === 'all',
    hasInlineNewItemRow,
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 搜索 + 操作工具栏 */}
      <FileTreeToolbar
        onOpenQuickOpen={onOpenQuickOpen}
        onNewFile={() => handleNewFile(newItemParentPath, resolveNewDepth(newItemParentPath))}
        onNewFolder={() => handleNewFolder(newItemParentPath, resolveNewDepth(newItemParentPath))}
        viewMode={viewMode}
        isTreeExpanded={isTreeExpanded}
        onCollapseAll={handleCollapseAll}
        onRefresh={handleRefresh}
      />

      <div
        ref={scrollRef}
        className={cn(
          'scrollbar-hover min-h-0 flex-1 overflow-y-auto select-none',
          isDropTarget(rootPath) && 'bg-primary/5',
        )}
        {...getRootDropHandlers(rootPath)}
      >
        <div className="py-1 px-1">
          {/* 钉住区 */}
          {pinnedItems.length > 0 && (
            <>
              <div className="mx-1 mb-1 flex items-center gap-1 px-1 text-caption uppercase tracking-wide text-muted-foreground/55">
                <Pin className="h-3 w-3" />
                <span>{t('fileTree.pinned')}</span>
              </div>
              {pinnedItems.map(item => {
                const selected = isFileTreeNodeSelected(selectedNode, item.path)
                return (
                  <button
                    key={item.path}
                    className={`
                      flex items-center w-full text-left text-body leading-[18px] rounded-md mx-1 transition-colors duration-75
                      ${selected ? SELECTED_ROW_CLASS : 'text-foreground/80 hover:bg-muted/30 hover:text-foreground'}
                    `}
                    style={{ paddingLeft: 0, height: ROW_HEIGHT, width: 'calc(100% - 8px)' }}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => handlePinnedNodeClick(item)}
                    onDoubleClick={() => handlePinnedNodeClick(item, true)}
                    onContextMenu={(e) => handleRightClick(e, { id: item.path, ...item }, 'pinned')}
                  >
                    <span className="w-4 h-4 flex items-center justify-center flex-shrink-0" />
                    <FileIcon fileName={item.name} isDirectory={item.isDirectory} className="h-3.5 w-3.5 shrink-0 mr-1" />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <Pin className="h-3 w-3 mr-1 text-primary/45 flex-shrink-0" />
                  </button>
                )
              })}
              <div className="mx-2 my-2 h-px bg-border/30" />
            </>
          )}

          {/* 根级、Git 视图或无法匹配树节点时的兜底输入 */}
          {newItem && showNewItemFallback && (
            <NewItemInput
              mode={newItem.mode}
              depth={newItem.depth}
              onSubmit={handleNewItemSubmit}
              onCancel={handleNewItemCancel}
            />
          )}

          {/* Git 视图 vs 树模式（虚拟滚动） */}
          {viewMode !== 'all' ? (
            <div>
              {renderGitChangeSection('staged', t('toolbar.staged'), stagedStatus.size, stagedGitChangeRows)}
              {renderGitChangeSection('unstaged', t('toolbar.unstaged'), unstagedStatus.size, unstagedGitChangeRows)}
            </div>
          ) : (
            <div
              {...tree.getContainerProps()}
              ref={(el: HTMLDivElement | null) => {
                ;(treeVirtualRef as React.MutableRefObject<HTMLDivElement | null>).current = el
                tree.registerElement?.(el as HTMLElement)
              }}
              className="outline-none relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map(vItem => {
                const row = treeRows[vItem.index]
                return (
                  <div
                    key={vItem.key}
                    className="absolute left-0 top-0 w-full"
                    style={{
                      height: vItem.size,
                      transform: `translateY(${vItem.start - scrollMargin}px)`,
                    }}
                  >
                    {row.type === 'new-input' ? (
                      <NewItemInput
                        mode={newItem!.mode}
                        depth={row.depth}
                        onSubmit={handleNewItemSubmit}
                        onCancel={handleNewItemCancel}
                      />
                    ) : (
                      renderTreeItem(row.item)
                    )}
                  </div>
                )
              })}
            </div>
          )}

        </div>
      </div>

      {/* 右键菜单 */}
      <ContextMenu open={ctx.open} onClose={closeCtx} anchorPosition={ctx.pos || undefined}>
        {ctx.node && !ctx.node.isDirectory && (
          <>
            <ContextMenuItem icon={<Send className="h-3.5 w-3.5" />} label={t('contextMenu.sendToAgent')} onClick={() => handleSend(ctx.node!.path)} />
            <ContextMenuDivider />
          </>
        )}
        {ctx.node && (
          <>
            {ctxMenuModel?.canCreateChildren && ctxMenuModel.newItemParentPath && (
              <>
                {/* 新建 */}
                <ContextMenuItem
                  icon={<FileIcon_Lucide className="h-3.5 w-3.5" />}
                  label={t('fileOps.newFile')}
                  onClick={() => handleNewFile(ctxMenuModel.newItemParentPath!, resolveNewDepth(ctxMenuModel.newItemParentPath!))}
                />
                <ContextMenuItem
                  icon={<Folder className="h-3.5 w-3.5" />}
                  label={t('fileOps.newFolder')}
                  onClick={() => handleNewFolder(ctxMenuModel.newItemParentPath!, resolveNewDepth(ctxMenuModel.newItemParentPath!))}
                />
                <ContextMenuDivider />
              </>
            )}

            {/* 路径操作 */}
            <ContextMenuItem icon={<Copy className="h-3.5 w-3.5" />} label={t('contextMenu.copyPath')} onClick={() => handleCopy(ctx.node!.path)} />
            <ContextMenuItem icon={<Copy className="h-3.5 w-3.5" />} label={t('fileOps.copyRelativePath')} onClick={() => handleCopyRelative(ctx.node!.path)} />
            <ContextMenuItem icon={<ExternalLink className="h-3.5 w-3.5" />} label={t('contextMenu.revealInFinder')} onClick={() => handleReveal(ctx.node!.path)} />
            <ContextMenuDivider />

            {/* 重命名 / 删除 */}
            <ContextMenuItem icon={<Pencil className="h-3.5 w-3.5" />} label={t('fileOps.rename')} onClick={() => setRenameNode(ctx.node!)} />
            <ContextMenuItem icon={<Trash2 className="h-3.5 w-3.5 text-destructive" />} label={t('fileOps.delete')} onClick={() => setDeleteNode(ctx.node!)} />

            {/* Git 操作 */}
            {isGitRepo && (isCtxStaged || isCtxUnstaged) && (
              <>
                <ContextMenuDivider />
                {isCtxUnstaged && (
                  <ContextMenuItem icon={<GitCommitHorizontal className="h-3.5 w-3.5" />} label={t('contextMenu.stageFile')} onClick={() => handleStageNode(ctx.node!)} />
                )}
                {isCtxStaged && (
                  <ContextMenuItem icon={<Undo2 className="h-3.5 w-3.5" />} label={t('contextMenu.unstageFile')} onClick={() => handleUnstageNode(ctx.node!)} />
                )}
                {isCtxUnstaged && !ctx.node!.isDirectory && (
                  <ContextMenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label={t('contextMenu.discardChanges')} onClick={() => handleDiscardNode(ctx.node!)} />
                )}
              </>
            )}

            {/* 钉住 */}
            <ContextMenuDivider />
            <ContextMenuItem
              icon={isCtxPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              label={isCtxPinned ? t('contextMenu.unpin') : t('contextMenu.pin')}
              onClick={() => handleTogglePin(ctx.node!)}
            />
          </>
        )}
      </ContextMenu>

      {/* 删除确认 */}
      {deleteNode && (
        <DeleteConfirmDialog
          open={Boolean(deleteNode)}
          name={deleteNode.name}
          isDirectory={deleteNode.isDirectory}
          isDeleting={isDeleting}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteNode(null)}
        />
      )}

      {/* 丢弃确认 */}
      <TabCodeConfirmDialog
        open={Boolean(discardTarget)}
        onOpenChange={(v) => { if (!v) setDiscardTarget(null) }}
        title={t('contextMenu.discardChanges')}
        description={t('contextMenu.confirmDiscard', { name: discardTarget?.name || '' })}
        variant="destructive"
        confirmLabel={t('contextMenu.discardChanges')}
        onConfirm={() => void doDiscard()}
      />
    </div>
  )
}
