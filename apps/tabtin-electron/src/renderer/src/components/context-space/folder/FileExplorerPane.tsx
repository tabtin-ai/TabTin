/**
 * FileExplorerPane - 文件浏览器主面板
 *
 * 文件树 + 预览：
 * - 左侧文件树
 * - 右侧文件预览
 * - 支持目录展开/折叠
 * - 实时监听文件系统变更
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { FileEntry, FilePreviewData, FolderContextKind } from './types'
import { FolderHeader, type GitFlowSwitchProps } from './FolderHeader'
import { FileTree } from './FileTree'
import { FilePreview, type FilePreviewHandle } from './FilePreview'
import { FolderSearch } from './FolderSearch'
import { LocalDirPathMissing, type LocalDirRelocateMode } from './LocalDirPathMissing'
import { useLocalDirRootHealth } from './useLocalDirRootHealth'
import { isCodeFile, isTextFile, isOfficeFile, getBaseName } from './utils'
import { useFileContentWatch, FILE_DELETED_VERSION } from '@hooks/useFileContentWatch'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { WorkdirPaneShell } from '@components/layout/WorkdirPaneShell'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import { isOfficeOwnerLockFile } from './fileEntryVisibility'
import {
  useFileTreeActions,
  depthForNewItem,
  type FileTreeNewItemState,
} from '@components/shared/file-ops'
import { getParentPath, joinPath, normalizePathSeparators } from '@components/shared/file-utils'
import { useFocusedSurfaceReporter } from '@stores/useFocusedSurfaceStore'
import type { ContextTabKey } from '../registry/types'

export interface FileExplorerPaneProps {
  rootPath: string
  kind: FolderContextKind
  title: string
  className?: string
  /** 文件夹打开后需要在左侧树和右侧预览中定位的文件路径 */
  revealPath?: string
  /** 搜索模式是否激活（第三步集成时启用） */
  searchActive?: boolean
  /** 由 `LocalDirAutoPane` 托管时传入——目录是 Git 仓库时让用户重新打开 Git 流程模式。 */
  gitFlowSwitch?: GitFlowSwitchProps
  spaceId?: string | null
  relocateMode?: LocalDirRelocateMode
  onUserRelocate?: (newPath: string) => void | Promise<void>
  contextScopeKey?: string | null
  contextTabKey?: ContextTabKey | null
}

const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 500
const DEFAULT_SIDEBAR_WIDTH = 280
const MAX_EDIT_BYTES = 2 * 1024 * 1024

export const FileExplorerPane: React.FC<FileExplorerPaneProps> = ({
  rootPath,
  kind,
  title,
  revealPath,
  className,
  gitFlowSwitch,
  spaceId,
  relocateMode = 'workspace',
  onUserRelocate,
  contextScopeKey,
  contextTabKey,
}) => {
  const { t } = useTranslation('context')
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)
  const [preview, setPreview] = useState<FilePreviewData | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchActive, setSearchActive] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [newItem, setNewItem] = useState<FileTreeNewItemState | null>(null)
  const [opsReload, setOpsReload] = useState<{ seq: number; dirs: string[] }>({ seq: 0, dirs: [] })
  const [previewPaneOpen, setPreviewPaneOpen] = useState(true)

  const lastSelectedPath = useRef<string | null>(null)
  const filePreviewRef = useRef<FilePreviewHandle>(null)
  const fileVersion = useFileContentWatch(selectedFile?.isDirectory ? null : selectedFile?.path ?? null)
  const normalizedRootPath = useMemo(
    () => normalizePathSeparators(rootPath).replace(/\/+$/, ''),
    [rootPath],
  )
  const normalizedRevealPath = useMemo(
    () => (revealPath ? normalizePathSeparators(revealPath) : undefined),
    [revealPath],
  )
  const layoutIdSeed = `${kind}-${normalizedRootPath}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const { status: rootHealth, retry: retryRootHealth, markMissing } = useLocalDirRootHealth(normalizedRootPath)

  useFocusedSurfaceReporter({
    scopeKey: contextScopeKey,
    tabKey: contextTabKey,
    appType: 'tabfolder',
    rootPath: rootHealth === 'missing' ? null : normalizedRootPath,
    focusedFilePath:
      previewPaneOpen && selectedFile && !selectedFile.isDirectory
        ? selectedFile.path
        : null,
  })

  const clearPreviewSelection = useCallback(() => {
    lastSelectedPath.current = null
    setSelectedFile(null)
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(false)
  }, [])

  const handleInvalidatePaths = useCallback((paths: string[]) => {
    const prefixes = paths.map((p) => normalizePathSeparators(p).replace(/\/+$/, '')).filter(Boolean)
    if (prefixes.length === 0) return
    setNewItem((current) => {
      if (!current) return current
      const parent = normalizePathSeparators(current.parentPath).replace(/\/+$/, '')
      return prefixes.some((prefix) => parent === prefix || parent.startsWith(`${prefix}/`))
        ? null
        : current
    })
    setSelectedFile((current) => {
      if (!current) return current
      const selected = normalizePathSeparators(current.path).replace(/\/+$/, '')
      if (prefixes.some((prefix) => selected === prefix || selected.startsWith(`${prefix}/`))) {
        lastSelectedPath.current = null
        setPreview(null)
        setPreviewError(null)
        setPreviewLoading(false)
        return null
      }
      return current
    })
  }, [])

  // 加载文件预览
  const loadPreview = useCallback(async (entry: FileEntry) => {
    if (isOfficeOwnerLockFile(entry)) {
      clearPreviewSelection()
      return
    }

    if (entry.isDirectory) {
      setSelectedFile(entry)
      setPreview(null)
      setPreviewError(null)
      lastSelectedPath.current = entry.path
      return
    }

    // 跳过相同文件
    if (lastSelectedPath.current === entry.path) {
      return
    }
    lastSelectedPath.current = entry.path

    setSelectedFile(entry)
    setPreviewPaneOpen(true)
    setPreviewLoading(true)
    setPreviewError(null)
    setPreview(null)

    try {
      const shouldLoadMore = isTextFile(entry.name) || isCodeFile(entry.name) || isOfficeFile(entry.name)
      // contract W2-β：旧 envelope `{success, data, error}` 改为 invokeIpc 直接返
      // `{ data }` 或 throw —— catch 块统一文案；FileExplorerPane 是次要预览路径，
      // 失败显示带 trace 末 6 位的提示，方便用户截图给开发者。
      const result = await window.tabtin.fileSystem.readFilePreview(entry.path, {
        maxBytes: shouldLoadMore ? MAX_EDIT_BYTES : undefined
      })
      if (result?.data) {
        setPreview(result.data)
      } else {
        setPreviewError(t('folder.errors.previewUnavailable'))
      }
    } catch (err) {
      console.error('[FileExplorerPane] loadPreview error:', err)
      setPreviewError(formatIpcErrorForUser(err, t('folder.errors.previewFailed')))
    } finally {
      setPreviewLoading(false)
    }
  }, [clearPreviewSelection, t])

  useEffect(() => {
    if (selectedFile && isOfficeOwnerLockFile(selectedFile)) {
      clearPreviewSelection()
    }
  }, [clearPreviewSelection, selectedFile])

  useEffect(() => {
    if (fileVersion === 0 || !selectedFile || selectedFile.isDirectory) return
    // 文件被外部删除：清掉选中和预览，防止鬼影（同 FolderHomePane 同款决策）。
    if (fileVersion === FILE_DELETED_VERSION) {
      lastSelectedPath.current = null
      setSelectedFile(null)
      setPreview(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }
    const filePath = selectedFile.path
    let cancelled = false
    setPreviewLoading(true)
    const shouldLoadMore = isTextFile(selectedFile.name) || isCodeFile(selectedFile.name) || isOfficeFile(selectedFile.name)
    window.tabtin.fileSystem.readFilePreview(filePath, {
      maxBytes: shouldLoadMore ? MAX_EDIT_BYTES : undefined,
    })
      .then((result) => {
        if (cancelled) return
        // 静默 fail-soft：fileVersion change 触发的 reload，失败保留上次预览（同 FolderHomePane 同款决策）。
        if (result?.data) setPreview(result.data)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPreviewLoading(false) })
    return () => { cancelled = true }
  }, [fileVersion, selectedFile])

  /** 用户主动换文件 / 进目录前：有未保存改动则先确认，取消则保持当前预览。 */
  const confirmLeaveCurrentPreview = useCallback(async () => {
    return (await filePreviewRef.current?.requestLeave()) ?? true
  }, [])

  const handleSelectFile = useCallback(
    async (entry: FileEntry) => {
      if (!entry.isDirectory && lastSelectedPath.current === entry.path) {
        setPreviewPaneOpen(true)
        return
      }
      // 当前已有选中项时才拦截；首次打开无需确认。
      if (lastSelectedPath.current != null && !(await confirmLeaveCurrentPreview())) return
      if (!entry.isDirectory) setPreviewPaneOpen(true)
      await loadPreview(entry)
    },
    [confirmLeaveCurrentPreview, loadPreview]
  )

  const handleClosePreview = useCallback(() => {
    setPreviewPaneOpen(false)
  }, [])

  useEffect(() => {
    if (!normalizedRevealPath || !normalizedRevealPath.startsWith(`${normalizedRootPath}/`)) return
    const entry: FileEntry = {
      name: normalizedRevealPath.split('/').pop() || normalizedRevealPath,
      path: normalizedRevealPath,
      isDirectory: false,
      size: 0,
      modifiedAt: null,
    }
    lastSelectedPath.current = null
    void loadPreview(entry)
  }, [loadPreview, normalizedRevealPath, normalizedRootPath])

  // 刷新文件树
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    setRefreshToken((prev) => prev + 1)
    // 给个短暂延迟以显示刷新动画
    setTimeout(() => {
      setIsRefreshing(false)
    }, 300)
  }, [])

  const isSandbox = kind === 'sandbox'

  const { createFile, createDirectory, rename, moveToDirectory, deleteItem } = useFileTreeActions({
    rootPath: normalizedRootPath,
    onRefresh: (parentPaths) => {
      const dirs = [...new Set((Array.isArray(parentPaths) ? parentPaths : [parentPaths]).filter(Boolean))]
      setOpsReload((s) => ({ seq: s.seq + 1, dirs }))
      setRefreshToken((p) => p + 1)
    },
    i18nNamespace: 'context',
    showSuccessToast: false,
  })

  // sandbox 根节点保护：沙箱根目录下的顶层目录不允许重命名/删除
  const resolveCreateParentPath = useCallback((): string => {
    if (!selectedFile) return normalizedRootPath
    if (selectedFile.isDirectory) return selectedFile.path
    return getParentPath(selectedFile.path) || normalizedRootPath
  }, [selectedFile, normalizedRootPath])

  const startNewItem = useCallback((mode: 'file' | 'folder') => {
    const parentPath = resolveCreateParentPath()
    setNewItem({
      mode,
      parentPath,
      depth: depthForNewItem(parentPath, normalizedRootPath, kind === 'sandbox'),
    })
  }, [resolveCreateParentPath, normalizedRootPath, kind])

  const isSandboxProtected = useCallback((entry: FileEntry) => {
    if (!isSandbox) return false
    const parentDir = getParentPath(entry.path)
    return parentDir === normalizedRootPath && entry.isDirectory
  }, [isSandbox, normalizedRootPath])

  // 搜索结果选中
  const handleSearchSelect = useCallback(async (filePath: string, _line?: number, isDirectory?: boolean) => {
    // Windows 下 ripgrep 返回的 filePath 用 `\` 分隔（C:\Users\foo\bar\baz.txt），
    // 之前 split('/') 不会切，name 会变成整个路径，FilePreview header 里铺一长串。
    // 走 getBaseName（split(/[\\/]/)）兼容两个平台。path 仍传原始 filePath，
    // 主进程 path.resolve 会自己处理分隔符。
    const entry: FileEntry = { name: getBaseName(filePath) || filePath, path: filePath, isDirectory: Boolean(isDirectory), size: 0, modifiedAt: null }
    if (!entry.isDirectory && lastSelectedPath.current === entry.path) {
      setPreviewPaneOpen(true)
      return
    }
    if (lastSelectedPath.current != null && !(await confirmLeaveCurrentPreview())) return
    await loadPreview(entry)
  }, [confirmLeaveCurrentPreview, loadPreview])

  // 在 Finder 中打开
  const handleOpenInFinder = useCallback(async () => {
    try {
      // contract W2-β: 走 window.tabtin 抽象，channel 仍在 LEGACY_HANDLERS 透传。
      await window.tabtin.openPath(normalizedRootPath)
    } catch (err) {
      console.error('[FileExplorerPane] openInFinder error:', err)
      toast.error(t('errorToast.revealFailed'))
    }
  }, [normalizedRootPath, t])

  const handleStartNewFile = useCallback(() => {
    if (rootHealth === 'missing') return
    startNewItem('file')
  }, [rootHealth, startNewItem])

  const handleStartNewFolder = useCallback(() => {
    if (rootHealth === 'missing') return
    startNewItem('folder')
  }, [rootHealth, startNewItem])

  if (rootHealth === 'missing') {
    return (
      <LocalDirPathMissing
        rootPath={normalizedRootPath}
        relocateMode={kind === 'sandbox' ? 'workspace' : relocateMode}
        spaceId={spaceId}
        onRetry={() => {
          clearPreviewSelection()
          setNewItem(null)
          retryRootHealth()
          setRefreshToken((prev) => prev + 1)
        }}
        onUserRelocate={kind === 'user' ? onUserRelocate : undefined}
      />
    )
  }

  return (
    <WorkdirPaneShell
      layoutId={`file-explorer-${layoutIdSeed}`}
      surface="file-explorer"
      sidebarMinWidth={MIN_SIDEBAR_WIDTH}
      sidebarMaxWidth={MAX_SIDEBAR_WIDTH}
      sidebarDefaultWidth={DEFAULT_SIDEBAR_WIDTH}
      className={className}
      contentVisible={previewPaneOpen}
      preserveSidebarOnContentToggle
      sidebarCollapsed={sidebarCollapsed}
      header={
        <FolderHeader
          rootPath={normalizedRootPath}
          kind={kind}
          title={title}
          isRefreshing={isRefreshing}
          onRefresh={handleRefresh}
          onOpenInFinder={handleOpenInFinder}
          onStartNewFile={handleStartNewFile}
          onStartNewFolder={handleStartNewFolder}
          onToggleSearch={() => {
            setSidebarCollapsed(false)
            setSearchActive(prev => !prev)
          }}
          searchActive={searchActive}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(prev => !prev)}
          gitFlowSwitch={gitFlowSwitch}
        />
      }
      sidebar={
        searchActive ? (
          <FolderSearch
            rootPath={normalizedRootPath}
            onSelectResult={handleSearchSelect}
            onClose={() => setSearchActive(false)}
          />
        ) : (
          <FileTree
            rootPath={normalizedRootPath}
            kind={kind}
            refreshToken={refreshToken}
            selectedFile={selectedFile?.path ?? null}
            revealPath={normalizedRevealPath}
            onSelectFile={handleSelectFile}
            newItem={newItem}
            onNewItemChange={setNewItem}
            onCreateFile={createFile}
            onCreateDirectory={createDirectory}
            isSandbox={isSandbox}
            opsReload={opsReload}
            onRootMissing={markMissing}
            onInvalidatePaths={handleInvalidatePaths}
            onMoveEntry={async (sourcePath, targetDirPath) => {
              const ok = await moveToDirectory(sourcePath, targetDirPath)
              if (ok && selectedFile?.path === sourcePath) {
                const newPath = joinPath(targetDirPath, selectedFile.name)
                lastSelectedPath.current = null
                void loadPreview({ ...selectedFile, path: newPath })
              }
              return ok
            }}
            onRenameFile={async (entry, newName) => {
              if (isSandboxProtected(entry)) {
                toast.error(t('folder.errors.sandboxProtected', { defaultValue: '沙箱系统目录不可修改' }))
                return false
              }
              const ok = await rename(entry.path, newName)
              if (ok && selectedFile?.path === entry.path) {
                const parentDir = getParentPath(entry.path)
                const newPath = joinPath(parentDir, newName)
                const updatedEntry: FileEntry = { ...entry, name: newName, path: newPath }
                lastSelectedPath.current = null
                void loadPreview(updatedEntry)
              }
              return ok
            }}
            onDeleteFile={async (entry) => {
              if (isSandboxProtected(entry)) {
                toast.error(t('folder.errors.sandboxProtected', { defaultValue: '沙箱系统目录不可修改' }))
                return
              }
              await deleteItem(entry.path, entry.isDirectory)
              if (selectedFile?.path === entry.path) {
                setSelectedFile(null)
                setPreview(null)
                lastSelectedPath.current = null
              }
            }}
          />
        )
      }
    >
      <FilePreview
        ref={filePreviewRef}
        entry={selectedFile}
        preview={preview}
        isLoading={previewLoading}
        error={previewError}
        onClosePreview={handleClosePreview}
        className="h-full"
      />
    </WorkdirPaneShell>
  )
}

FileExplorerPane.displayName = 'FileExplorerPane'
