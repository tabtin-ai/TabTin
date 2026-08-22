/**
 * FileTree - 文件树组件（虚拟滚动）
 *
 * 将递归树结构平坦化为扁平列表，使用 @tanstack/react-virtual 虚拟滚动。
 * 展开 1000+ 节点的目录树时只渲染可见区域的 DOM 节点。
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useSafeVirtualizer } from '@hooks/useSafeVirtualizer'
import { useFolderWatch } from '@hooks/useFolderWatch'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { useScrollPositionPreserve } from '@hooks/useScrollPositionPreserve'
import { FolderPlus } from 'lucide-react'
import { cn } from '@utils/cn'
import type { FileEntry, FolderContextKind } from './types'
import { FileTreeItem } from './FileTreeItem'
import {
  FileContextMenu,
  RenameInput,
  NewItemInput,
  depthForNewItem,
  useFileTreeDragDrop,
  type FileTreeNewItemState,
} from '@components/shared/file-ops'
import { writeFileTreeChatDragData } from '../hooks/chatContextDragPayload'
import { dirsAffectedByFsChange, getParentPath, normalizePathSeparators } from '@components/shared/file-utils'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog, toast } from '@components/ui'
import { formatDirReadErrorForUser, formatIpcErrorForUser, isExpectedDirReadAccessError } from '@/services/ipc-error'
import { ensureLegacyOk } from '@/services/legacy-result'
import {
  isStalePathAfterDirectoryReload,
  mergeReloadedDirectoryEntries,
  pruneExpandedForReloadedDirectory,
  type FileTreeEntriesMap,
} from './fileTreeCache'
import { getCreateParentPathForEntry } from './fileTreeCreateTarget'
import { filterVisibleFileEntries } from './fileEntryVisibility'

interface FileTreeProps {
  rootPath: string
  kind: FolderContextKind
  refreshToken: number
  selectedFile: string | null
  revealPath?: string
  onSelectFile: (entry: FileEntry) => void
  onRenameFile?: (entry: FileEntry, newName: string) => Promise<boolean>
  onDeleteFile?: (entry: FileEntry) => void
  newItem?: FileTreeNewItemState | null
  onNewItemChange?: (item: FileTreeNewItemState | null) => void
  onCreateFile?: (parentPath: string, name: string) => Promise<boolean>
  onCreateDirectory?: (parentPath: string, name: string) => Promise<boolean>
  onMoveEntry?: (sourcePath: string, targetDirPath: string) => Promise<boolean>
  isSandbox?: boolean
  /** 文件操作（新建/重命名等）后需强制刷新的目录，seq 变化时触发 */
  opsReload?: { seq: number; dirs: string[] }
  /** 根目录 ENOENT / 不可达时通知父面板进入失效态（勿静默空白） */
  onRootMissing?: () => void
  /**
   * 子树路径失效（外部改名/删除）时通知父面板清理 selected / newItem。
   * 传入应视为失效的路径前缀（选中项若等于此前缀或为其子孙则清空）。
   */
  onInvalidatePaths?: (paths: string[]) => void
  className?: string
}

type LoadingSet = Set<string>
type ExpandedSet = Set<string>

interface FlatEntryRow {
  type: 'entry'
  entry: FileEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
}

interface FlatNewInputRow {
  type: 'new-input'
  depth: number
  parentPath: string
}

type FlatRow = FlatEntryRow | FlatNewInputRow

const ROW_HEIGHT = 28
const PADDING_Y = 8
const FILE_TREE_TOAST_OPTIONS = { preferNative: true } as const

const sortEntries = (entries: FileEntry[], locale: string): FileEntry[] => {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }
    return a.name.localeCompare(b.name, locale)
  })
}

function normalizeTreePath(path: string): string {
  const normalized = normalizePathSeparators(path)
  if (normalized === '/') return normalized
  if (/^[A-Za-z]:\/+$/.test(normalized)) return normalized.slice(0, 3)
  return normalized.replace(/\/+$/, '')
}

export const FileTree: React.FC<FileTreeProps> = ({
  rootPath,
  kind,
  refreshToken,
  selectedFile,
  revealPath,
  onSelectFile,
  onRenameFile,
  onDeleteFile,
  newItem,
  onNewItemChange,
  onCreateFile,
  onCreateDirectory,
  onMoveEntry,
  isSandbox: isSandboxProp,
  opsReload,
  onRootMissing,
  onInvalidatePaths,
  className
}) => {
  const { t, i18n } = useTranslation('context')
  // loadDirectory 把条目存到「正斜杠」键下；若 rootPath 仍是 Windows 反斜杠，
  // flatten / isEmpty / loading 用原始键查找会永远 miss → 左侧空白树（Skill 编辑器
  // 在 Windows 上 resolve-path 返回 `C:\...` 时必现）。入口统一 normalize。
  const normalizedRootPath = useMemo(
    () => normalizeTreePath(rootPath),
    [rootPath],
  )
  const normalizedSelectedFile = useMemo(
    () => (selectedFile ? normalizeTreePath(selectedFile) : null),
    [selectedFile],
  )
  const normalizedRevealPath = useMemo(
    () => (revealPath ? normalizeTreePath(revealPath) : undefined),
    [revealPath],
  )
  const [entriesByDir, setEntriesByDir] = useState<FileTreeEntriesMap>({})
  const [expanded, setExpanded] = useState<ExpandedSet>(() => new Set([normalizedRootPath]))
  const [loading, setLoading] = useState<LoadingSet>(new Set())
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  // 不用 window.confirm：同步阻塞会让 ContextMenu 在 confirm 返回前无法关闭，
  // Win Electron 上易导致后续搜索框「IME 能出、字进不了框」。
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null)

  const entriesByDirRef = useRef(entriesByDir)
  entriesByDirRef.current = entriesByDir

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const parentRef = useRef<HTMLDivElement>(null)
  const isSandbox = isSandboxProp ?? kind === 'sandbox'

  const isSandboxProtectedPath = useCallback((path: string) => {
    if (!isSandbox) return false
    const parentDir = getParentPath(path)
    if (parentDir !== normalizedRootPath) return false
    const entry = entriesByDir[normalizedRootPath]?.find((e) => e.path === path)
    return entry?.isDirectory ?? false
  }, [isSandbox, normalizedRootPath, entriesByDir])

  const onRootMissingRef = useRef(onRootMissing)
  onRootMissingRef.current = onRootMissing
  const onInvalidatePathsRef = useRef(onInvalidatePaths)
  onInvalidatePathsRef.current = onInvalidatePaths
  const selectedFileRef = useRef(normalizedSelectedFile)
  selectedFileRef.current = normalizedSelectedFile

  const loadDirectory = useCallback(
    async (dirPath: string, forceReload = false) => {
      const normalizedDirPath = normalizeTreePath(dirPath)
      if (!forceReload && entriesByDirRef.current[normalizedDirPath]) {
        return
      }

      setLoading((prev) => new Set(prev).add(normalizedDirPath))

      try {
        const result = await window.tabtin.fileSystem.readDir(normalizedDirPath)
        ensureLegacyOk(result, 'readDir')
        if (result?.entries) {
          const normalizedEntries = filterVisibleFileEntries(
            (result.entries ?? []).map((entry) => ({
              ...entry,
              path: normalizePathSeparators(entry.path).replace(/\/+$/, ''),
            })),
          )
          const sortedEntries = sortEntries(normalizedEntries, i18n.language)
          setEntriesByDir((prev) => {
            return mergeReloadedDirectoryEntries(prev, normalizedDirPath, sortedEntries)
          })
          setExpanded((prev) => pruneExpandedForReloadedDirectory(prev, normalizedDirPath, sortedEntries))
          // 子树外部 rename：父目录 reload 后旧选中路径已不在 listing → 清选中，避免往幽灵 path 新建
          if (
            isStalePathAfterDirectoryReload(
              selectedFileRef.current,
              normalizedDirPath,
              sortedEntries,
            )
          ) {
            const stale = selectedFileRef.current
            if (stale) onInvalidatePathsRef.current?.([stale])
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const isMissing = message.includes('ENOENT') || message.includes('no such file or directory')
        if (isMissing) {
          setExpanded((prev) => {
            const next = new Set(prev)
            next.delete(normalizedDirPath)
            return next
          })
          setEntriesByDir((prev) => {
            const next = { ...prev }
            delete next[normalizedDirPath]
            for (const key of Object.keys(next)) {
              if (key.startsWith(`${normalizedDirPath}/`)) delete next[key]
            }
            return next
          })
          if (normalizedDirPath === normalizedRootPath) {
            onRootMissingRef.current?.()
          } else {
            onInvalidatePathsRef.current?.([normalizedDirPath])
          }
        } else {
          const formattedMessage = formatDirReadErrorForUser(err, t)
          if (isExpectedDirReadAccessError(err)) {
            toast({
              title: formattedMessage,
              id: 'filetree-dir-read',
              ...FILE_TREE_TOAST_OPTIONS,
            })
          } else {
            toast.error(formattedMessage, { id: 'filetree-dir-read', ...FILE_TREE_TOAST_OPTIONS })
          }
        }
      } finally {
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(normalizedDirPath)
          return next
        })
      }
    },
    [i18n.language, normalizedRootPath, t]
  )

  const loadDirectoryRef = useRef(loadDirectory)
  loadDirectoryRef.current = loadDirectory

  const invalidateDirectories = useCallback((dirs: string[]) => {
    const unique = [...new Set(dirs.filter(Boolean))]
    if (unique.length === 0) return
    setEntriesByDir((prev) => {
      const next = { ...prev }
      for (const dir of unique) {
        delete next[dir]
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${dir}/`)) delete next[key]
        }
      }
      return next
    })
    for (const dir of unique) {
      void loadDirectory(dir, true)
    }
  }, [loadDirectory])

  const invalidateDirectoriesRef = useRef(invalidateDirectories)
  invalidateDirectoriesRef.current = invalidateDirectories

  useEffect(() => {
    // 仅在根路径变化时重置展开/缓存；不要绑 loadDirectory，否则 t 引用抖动会清空→重载死循环。
    setExpanded(new Set([normalizedRootPath]))
    setEntriesByDir({})
  }, [normalizedRootPath])

  useEffect(() => {
    loadDirectory(normalizedRootPath, true)
  }, [normalizedRootPath, loadDirectory])

  useEffect(() => {
    if (opsReload?.dirs.length) {
      invalidateDirectories(
        opsReload.dirs.map(normalizeTreePath),
      )
    }
  }, [opsReload?.seq, opsReload?.dirs, invalidateDirectories])

  useEffect(() => {
    if (refreshToken > 0) {
      expandedRef.current.forEach((dir) => {
        loadDirectoryRef.current(dir, true)
      })
    }
  }, [refreshToken])

  useEffect(() => {
    if (!normalizedRevealPath || !normalizedRevealPath.startsWith(`${normalizedRootPath}/`)) return
    const parentDir = getParentPath(normalizedRevealPath)
    if (!parentDir) return

    const dirs: string[] = [normalizedRootPath]
    const relativeParent = parentDir.slice(normalizedRootPath.length).replace(/^\/+/, '')
    if (relativeParent) {
      let current = normalizedRootPath
      for (const segment of relativeParent.split('/').filter(Boolean)) {
        current = `${current}/${segment}`
        dirs.push(current)
      }
    }

    setExpanded((prev) => {
      const next = new Set(prev)
      for (const dir of dirs) next.add(dir)
      return next
    })
    for (const dir of dirs) {
      void loadDirectoryRef.current(dir)
    }
  }, [normalizedRevealPath, normalizedRootPath])

  useEffect(() => {
    if (!newItem) return
    const parentPath = normalizeTreePath(newItem.parentPath)
    setExpanded((prev) => new Set(prev).add(parentPath))
    void loadDirectory(parentPath, true)
  }, [newItem, loadDirectory])

  useFolderWatch(normalizedRootPath, useCallback((_rootId, events) => {
    if (events.some((e) => e.isRootLost)) {
      onRootMissingRef.current?.()
      return
    }
    const expandedSet = expandedRef.current
    const hasGlobal = events.some((e) => e.isGlobal)
    const dirsToReload = new Set<string>()
    if (hasGlobal) {
      expandedSet.forEach((d) => dirsToReload.add(d))
    } else {
      for (const e of events) {
        for (const dir of dirsAffectedByFsChange(e.parentDir, expandedSet)) {
          dirsToReload.add(dir)
        }
      }
    }
    for (const dir of dirsToReload) {
      void loadDirectoryRef.current(dir, true)
    }
  }, []))

  const toggleExpand = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(dirPath)) {
          next.delete(dirPath)
        } else {
          next.add(dirPath)
          loadDirectory(dirPath)
        }
        return next
      })
    },
    [loadDirectory]
  )

  const handleRevealInFinder = useCallback(async (path: string) => {
    try {
      await window.tabtin.showItemInFolder(path)
    } catch (err) {
      console.error('[FileTree] revealInFinder error:', err)
      toast.error(formatIpcErrorForUser(err, t('errorToast.revealFailed')))
    }
  }, [t])

  const handleOpenWithDefault = useCallback(async (path: string) => {
    try {
      await window.tabtin.openPath(path)
    } catch (err) {
      console.error('[FileTree] openWithDefault error:', err)
      toast.error(formatIpcErrorForUser(err, t('errorToast.openFileFailed')))
    }
  }, [t])

  const startNewItemAt = useCallback((mode: 'file' | 'folder', parentPath: string) => {
    const normalizedParent = normalizeTreePath(parentPath)
    onNewItemChange?.({
      mode,
      parentPath: normalizedParent,
      depth: depthForNewItem(normalizedParent, normalizedRootPath, isSandbox),
    })
  }, [onNewItemChange, normalizedRootPath, isSandbox])

  const handleNewItemSubmit = useCallback(async (name: string) => {
    if (!newItem) return
    const { mode, parentPath } = newItem
    const ok = mode === 'file'
      ? await onCreateFile?.(parentPath, name)
      : await onCreateDirectory?.(parentPath, name)
    if (ok) {
      onNewItemChange?.(null)
    }
  }, [newItem, onCreateFile, onCreateDirectory, onNewItemChange])

  const handleMoveEntry = useCallback(async (sourcePath: string, targetDirPath: string) => {
    const ok = await onMoveEntry?.(sourcePath, targetDirPath)
    if (!ok) return
    const srcParent = getParentPath(sourcePath)
    invalidateDirectoriesRef.current([srcParent, targetDirPath])
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const p of prev) {
        if (p === sourcePath || p.startsWith(`${sourcePath}/`)) {
          next.delete(p)
        }
      }
      return next
    })
  }, [onMoveEntry])

  const { getDragHandlers, getDropHandlers, getRootDropHandlers, isDropTarget, isDragging } = useFileTreeDragDrop({
    onMove: handleMoveEntry,
    canDrag: (path) => !isSandboxProtectedPath(path),
    // ：让文件树项可拖入对话框——写入聊天引用载荷并放宽 effectAllowed。
    onDragStartExtra: useCallback((e: React.DragEvent, node: { path: string; isDirectory: boolean }) => {
      e.dataTransfer.effectAllowed = 'copyMove'
      writeFileTreeChatDragData(e.dataTransfer, node, { rootPath: normalizedRootPath })
    }, [normalizedRootPath]),
  })

  const flatRows = useMemo(() => {
    const rows: FlatRow[] = []
    const normalizedNewItemParent = newItem
      ? normalizeTreePath(newItem.parentPath)
      : null

    const flatten = (dirPath: string, depth: number) => {
      const entries = entriesByDir[dirPath]
      if (!entries) return

      for (const entry of entries) {
        const isExp = expanded.has(entry.path)
        rows.push({
          type: 'entry',
          entry,
          depth,
          isExpanded: isExp,
          isLoading: loading.has(entry.path),
        })
        if (newItem && entry.isDirectory && entry.path === normalizedNewItemParent) {
          rows.push({
            type: 'new-input',
            depth: newItem.depth,
            parentPath: normalizedNewItemParent,
          })
        }
        if (entry.isDirectory && isExp) {
          flatten(entry.path, depth + 1)
        }
      }
    }

    const startDepth = isSandbox ? 0 : 1
    flatten(normalizedRootPath, startDepth)

    if (newItem && normalizedNewItemParent === normalizedRootPath && !rows.some(
      (r) => r.type === 'new-input' && r.parentPath === normalizedRootPath,
    )) {
      rows.unshift({
        type: 'new-input',
        depth: newItem.depth,
        parentPath: normalizedRootPath,
      })
    }

    return rows
  }, [entriesByDir, expanded, loading, normalizedRootPath, isSandbox, newItem])

  const flatRowsRef = useRef(flatRows)
  flatRowsRef.current = flatRows

  const getScrollElement = useCallback(() => parentRef.current, [])
  const estimateSize = useCallback(() => ROW_HEIGHT, [])
  const getItemKey = useCallback(
    (index: number) => {
      const row = flatRowsRef.current[index]
      if (!row) return index
      if (row.type === 'new-input') return `new-input-${row.parentPath}`
      return row.entry.path
    },
    [],
  )

  const { isForeground } = useSpaceActivity()
  const virtualizer = useSafeVirtualizer({
    count: flatRows.length,
    getScrollElement,
    estimateSize,
    overscan: 10,
    paddingStart: PADDING_Y,
    paddingEnd: PADDING_Y,
    getItemKey,
    enabled: isForeground,
  })

  useEffect(() => {
    if (!normalizedSelectedFile) return
    const index = flatRows.findIndex((row) => row.type === 'entry' && row.entry.path === normalizedSelectedFile)
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'center' })
    }
  }, [flatRows, normalizedSelectedFile, virtualizer])

  useScrollPositionPreserve({
    scrollElementRef: parentRef,
    totalSize: virtualizer.getTotalSize(),
    scopeKey: normalizedRootPath,
  })

  const isEmpty = useMemo(() => {
    const rootEntries = entriesByDir[normalizedRootPath]
    return rootEntries && rootEntries.length === 0
  }, [entriesByDir, normalizedRootPath])

  const confirmDeletePending = useCallback(() => {
    if (!pendingDelete || !onDeleteFile) return
    onDeleteFile(pendingDelete)
  }, [onDeleteFile, pendingDelete])

  const restoreTreeFocus = useCallback(() => {
    parentRef.current?.focus({ preventScroll: true })
  }, [])

  const isInitialLoading = loading.has(normalizedRootPath) && !entriesByDir[normalizedRootPath]

  if (isInitialLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}>
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
      </div>
    )
  }

  if (isEmpty && !newItem) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}>
        <div className="flex flex-col items-center gap-1.5">
          <FolderPlus className="h-8 w-8 text-muted-foreground/15" strokeWidth={1} />
          <span className="text-body text-muted-foreground/40">{t('folder.status.emptyFolder')}</span>
        </div>
      </div>
    )
  }

  const rootDropHandlers = onMoveEntry ? getRootDropHandlers(normalizedRootPath) : {}

  const deleteConfirmTitle = pendingDelete
    ? (pendingDelete.isDirectory
        ? t('folder.labels.confirmDeleteDirTitle', { defaultValue: '删除文件夹' })
        : t('folder.labels.confirmDeleteFileTitle', { defaultValue: '删除文件' }))
    : ''
  const deleteConfirmDescription = pendingDelete
    ? (pendingDelete.isDirectory
        ? t('folder.labels.confirmDeleteDir', {
            name: pendingDelete.name,
            defaultValue: `确定删除文件夹 "${pendingDelete.name}" 及其所有内容？`,
          })
        : t('folder.labels.confirmDeleteFile', {
            name: pendingDelete.name,
            defaultValue: `确定删除文件 "${pendingDelete.name}"？`,
          }))
    : ''

  return (
    <>
      <div
        ref={parentRef}
        tabIndex={-1}
        className={cn(
          'scrollbar-hover h-full min-h-0 overflow-y-auto overscroll-contain outline-none',
          onMoveEntry && isDropTarget(normalizedRootPath) && 'bg-primary/5',
          className,
        )}
        {...rootDropHandlers}
      >
        <div
          className="select-none"
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const row = flatRows[virtualItem.index]

            if (row.type === 'new-input') {
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    paddingRight: 4,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <NewItemInput
                    mode={newItem!.mode}
                    depth={row.depth}
                    indentStep={12}
                    indentBase={0}
                    i18nNamespace="context"
                    onSubmit={(name) => { void handleNewItemSubmit(name) }}
                    onCancel={() => onNewItemChange?.(null)}
                  />
                </div>
              )
            }

            const isSelected = normalizedSelectedFile === row.entry.path
            const isRenaming = renamingPath === row.entry.path
            const createParentPath = getCreateParentPathForEntry(row.entry)

            const rowContent = isRenaming && onRenameFile ? (
              <RenameInput
                name={row.entry.name}
                isDirectory={row.entry.isDirectory}
                depth={row.depth}
                indentStep={12}
                indentBase={0}
                i18nNamespace="context"
                onSubmit={(newName) => {
                  void onRenameFile(row.entry, newName).then((ok) => {
                    if (ok) setRenamingPath(null)
                  })
                }}
                onCancel={() => setRenamingPath(null)}
              />
            ) : (
              <FileTreeItem
                entry={row.entry}
                depth={row.depth}
                isExpanded={row.isExpanded}
                isSelected={isSelected}
                isLoading={row.isLoading}
                isDropTarget={row.entry.isDirectory && isDropTarget(row.entry.path)}
                isDragging={isDragging(row.entry.path)}
                onToggle={toggleExpand}
                onSelect={onSelectFile}
                dragHandlers={getDragHandlers({ path: row.entry.path, isDirectory: row.entry.isDirectory })}
                dropHandlers={row.entry.isDirectory ? getDropHandlers(row.entry) : undefined}
              />
            )

            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  paddingRight: 4,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <FileContextMenu
                  entry={row.entry}
                  onRevealInFinder={() => handleRevealInFinder(row.entry.path)}
                  onOpenWithDefault={
                    !row.entry.isDirectory
                      ? () => handleOpenWithDefault(row.entry.path)
                      : undefined
                  }
                  onNewFile={
                    row.entry.isDirectory && createParentPath && onCreateFile
                      ? () => startNewItemAt('file', createParentPath)
                      : undefined
                  }
                  onNewFolder={
                    row.entry.isDirectory && createParentPath && onCreateDirectory
                      ? () => startNewItemAt('folder', createParentPath)
                      : undefined
                  }
                  onRename={onRenameFile ? () => setRenamingPath(row.entry.path) : undefined}
                  onDelete={onDeleteFile ? () => setPendingDelete(row.entry) : undefined}
                >
                  <div>{rowContent}</div>
                </FileContextMenu>
              </div>
            )
          })}
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        title={deleteConfirmTitle}
        description={deleteConfirmDescription}
        confirmText={t('folder.labels.delete', { defaultValue: '删除' })}
        variant="destructive"
        restoreFocusOnClose
        onRestoreFocus={restoreTreeFocus}
        onConfirm={confirmDeletePending}
      />
    </>
  )
}

FileTree.displayName = 'FileTree'
