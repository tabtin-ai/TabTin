/**
 * RemoteFolderPane — 远程只读文件浏览。
 *
 * 本机不是 control_device 时，orchestration 起始页用它替代
 * `RemoteAgentBanner` 占位墙：经 Django 中继向执行设备发 `fs.list_dir` /
 * `fs.read_file_preview`，渲染只读文件树 + 文本/图片预览。
 *
 * 刻意不复用 FileExplorerPane / FileTree：那套组件深度耦合本机 IPC（watch、
 * 新建/改名/删除、拖拽、搜索、编辑保存），远程第一期是纯只读 + 手动刷新，
 * 独立小组件比在本机链路里穿数据源开关更稳（不碰本机行为）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileArchive,
  FileText,
  Loader2,
  Monitor,
  PanelLeft,
  PanelLeftClose,
  RefreshCw,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { WorkdirPaneShell } from '@components/layout/WorkdirPaneShell'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { formatFileSize } from '../utils'
import type { FileEntry } from '../types'
import { useFocusedSurfaceReporter } from '@stores/useFocusedSurfaceStore'
import type { ContextTabKey } from '../../registry/types'
import { writeFileTreeChatDragData } from '../../hooks/chatContextDragPayload'
import {
  RemoteFsError,
  remoteListDir,
  remoteReadFilePreview,
  type RemotePreviewData,
} from './remoteFsClient'

export interface RemoteFolderPaneProps {
  spaceId: string
  /** 执行设备上的 working_dir（仅展示 + 作为树根 key，本机不存在该路径） */
  rootPath: string
  /** 执行设备名（顶部提示条展示） */
  deviceName: string | null
  className?: string
  contextScopeKey?: string | null
  contextTabKey?: ContextTabKey | null
}

const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 500
const DEFAULT_SIDEBAR_WIDTH = 280

function useRemoteErrorText() {
  const { t } = useTranslation('space')
  return useCallback((err: unknown): string => {
    const code = err instanceof RemoteFsError ? err.code : ''
    switch (code) {
      case 'DEVICE_RUNTIME_OFFLINE':
      case 'DEVICE_RUNTIME_UNAVAILABLE':
        return t('remoteFolder.errors.deviceOffline', { defaultValue: '执行设备不在线，无法浏览文件' })
      case 'TASK_TIMEOUT':
        return t('remoteFolder.errors.timeout', { defaultValue: '执行设备响应超时，请稍后重试' })
      case 'PATH_DENIED':
        return t('remoteFolder.errors.pathDenied', { defaultValue: '该路径在执行设备上不可访问' })
      case 'WORKING_DIR_NOT_SET':
        return t('remoteFolder.errors.workingDirNotSet', { defaultValue: '该工作空间还没设置工作空间' })
      case 'PERMISSION_DENIED':
        return t('remoteFolder.errors.permissionDenied', { defaultValue: '没有权限查看该工作空间的文件' })
      default:
        return err instanceof Error && err.message
          ? err.message
          : t('remoteFolder.errors.generic', { defaultValue: '远程读取失败，请重试' })
    }
  }, [t])
}

// ── 文件树 ────────────────────────────────────────────────────────────

interface RemoteTreeProps {
  spaceId: string
  rootPath: string
  refreshToken: number
  selectedPath: string | null
  onSelect: (entry: FileEntry) => void
  onRootError: (message: string | null) => void
}

const RemoteTree: React.FC<RemoteTreeProps> = ({
  spaceId,
  rootPath,
  refreshToken,
  selectedPath,
  onSelect,
  onRootError,
}) => {
  const { t } = useTranslation('space')
  const errorText = useRemoteErrorText()
  const [childrenByDir, setChildrenByDir] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({})
  // 刷新 effect 里读当前展开集合用（不能进依赖数组，否则展开/折叠也会触发重载）
  const expandedRef = React.useRef(expanded)
  expandedRef.current = expanded

  const loadDir = useCallback(async (dirPath: string) => {
    setLoadingDirs((prev) => new Set(prev).add(dirPath))
    setDirErrors((prev) => {
      if (!(dirPath in prev)) return prev
      const next = { ...prev }
      delete next[dirPath]
      return next
    })
    try {
      const { entries } = await remoteListDir(spaceId, dirPath)
      setChildrenByDir((prev) => ({ ...prev, [dirPath]: entries }))
      if (dirPath === rootPath) onRootError(null)
    } catch (err) {
      const message = errorText(err)
      setDirErrors((prev) => ({ ...prev, [dirPath]: message }))
      if (dirPath === rootPath) onRootError(message)
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(dirPath)
        return next
      })
    }
  }, [spaceId, rootPath, errorText, onRootError])

  // 初次 + 手动刷新时重载。刷新清空缓存但保留展开态——已展开的目录必须
  // 一并重载，否则它们会因缓存被清而卡在「加载中…」（loadDir 只在 toggle
  // 时触发）。
  useEffect(() => {
    setChildrenByDir({})
    setDirErrors({})
    void loadDir(rootPath)
    for (const dirPath of expandedRef.current) {
      void loadDir(dirPath)
    }
  }, [rootPath, refreshToken, loadDir])

  const toggleDir = useCallback((entry: FileEntry) => {
    const dirPath = entry.path
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return next
    })
    if (!childrenByDir[dirPath]) {
      void loadDir(dirPath)
    }
  }, [childrenByDir, loadDir])

  const renderEntries = (dirPath: string, depth: number): React.ReactNode => {
    const entries = childrenByDir[dirPath]
    if (!entries) {
      if (dirErrors[dirPath]) {
        return (
          <div className="px-2 py-1 text-caption text-destructive/80" style={{ paddingLeft: 12 + depth * 14 }}>
            {dirErrors[dirPath]}
          </div>
        )
      }
      return (
        <div className="flex items-center gap-1.5 px-2 py-1 text-caption text-muted-foreground/60" style={{ paddingLeft: 12 + depth * 14 }}>
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('remoteFolder.loading', { defaultValue: '加载中…' })}
        </div>
      )
    }
    if (entries.length === 0) {
      return (
        <div className="px-2 py-1 text-caption text-muted-foreground/40" style={{ paddingLeft: 12 + depth * 14 }}>
          {t('remoteFolder.emptyDir', { defaultValue: '（空目录）' })}
        </div>
      )
    }
    return entries.map((entry) => {
      const isExpanded = entry.isDirectory && expanded.has(entry.path)
      return (
        <React.Fragment key={entry.path}>
          <button
            type="button"
            draggable
            className={cn(
              'flex w-full items-center gap-1 rounded px-2 py-[3px] text-left text-body',
              'hover:bg-muted/60 transition-colors',
              selectedPath === entry.path && 'bg-muted text-foreground',
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              if (entry.isDirectory) {
                toggleDir(entry)
              } else {
                onSelect(entry)
              }
            }}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'copy'
              writeFileTreeChatDragData(event.dataTransfer, entry, {
                rootPath,
                spaceId,
                tabType: 'remote_workspace_file',
              })
            }}
          >
            {entry.isDirectory ? (
              isExpanded
                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <FileIcon fileName={entry.name} isDirectory={entry.isDirectory} isOpen={isExpanded} className="h-4 w-4 shrink-0" />
            <span className="truncate">{entry.name}</span>
            {entry.isDirectory && loadingDirs.has(entry.path) && (
              <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
            )}
          </button>
          {isExpanded && renderEntries(entry.path, depth + 1)}
        </React.Fragment>
      )
    })
  }

  return <div className="py-1">{renderEntries(rootPath, 0)}</div>
}

// ── 预览 ────────────────────────────────────────────────────────────

interface RemotePreviewPaneProps {
  entry: FileEntry | null
  preview: RemotePreviewData | null
  isLoading: boolean
  error: string | null
}

const RemotePreviewPane: React.FC<RemotePreviewPaneProps> = ({ entry, preview, isLoading, error }) => {
  const { t } = useTranslation('space')

  if (!entry) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <FileText className="mb-2 h-8 w-8 text-muted-foreground/20" strokeWidth={1} />
        <p className="text-body text-muted-foreground/40">
          {t('remoteFolder.selectFile', { defaultValue: '选择文件以预览' })}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <FileIcon fileName={entry.name} className="h-4 w-4 shrink-0" />
        <span className="truncate text-body text-foreground">{entry.name}</span>
        <span className="ml-auto shrink-0 text-caption text-muted-foreground/60">
          {formatFileSize(preview?.size ?? entry.size)}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <AlertCircle className="mb-2 h-6 w-6 text-destructive/40" strokeWidth={1} />
            <p className="text-body text-destructive/60">{error}</p>
          </div>
        ) : preview?.kind === 'text' ? (
          <div className="h-full">
            {preview.truncated && (
              <div className="border-b border-border/40 bg-muted/40 px-3 py-1 text-caption text-muted-foreground/60">
                {t('remoteFolder.truncatedText', { defaultValue: '文件较大，仅显示开头部分（只读）' })}
              </div>
            )}
            <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-caption leading-relaxed text-foreground/90">
              {preview.content ?? ''}
            </pre>
          </div>
        ) : preview?.kind === 'image' && preview.content ? (
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={`data:${preview.mime ?? 'image/png'};base64,${preview.content}`}
              alt={entry.name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <FileArchive className="mb-2 h-8 w-8 text-muted-foreground/15" strokeWidth={1} />
            <p className="mb-0.5 text-body text-muted-foreground/40">
              {preview?.truncated
                ? t('remoteFolder.tooLarge', { defaultValue: '文件过大，暂不支持远程预览' })
                : t('remoteFolder.unsupportedKind', { defaultValue: '该类型暂不支持远程预览' })}
            </p>
            <p className="text-caption text-muted-foreground/30">{formatFileSize(preview?.size ?? entry.size)}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 主面板 ────────────────────────────────────────────────────────────

export const RemoteFolderPane: React.FC<RemoteFolderPaneProps> = ({
  spaceId,
  rootPath,
  deviceName,
  className,
  contextScopeKey,
  contextTabKey,
}) => {
  const { t } = useTranslation('space')
  const errorText = useRemoteErrorText()
  const [refreshToken, setRefreshToken] = useState(0)
  const [rootError, setRootError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)
  const [preview, setPreview] = useState<RemotePreviewData | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const normalizedRoot = useMemo(() => rootPath.replace(/\/+$/, ''), [rootPath])
  useFocusedSurfaceReporter({
    scopeKey: contextScopeKey,
    tabKey: contextTabKey,
    appType: 'tabfolder',
    rootPath: normalizedRoot,
    focusedFilePath: selectedFile?.isDirectory ? null : selectedFile?.path ?? null,
  })
  const folderTitle = normalizedRoot.split(/[\\/]/).filter(Boolean).pop() || normalizedRoot
  const layoutIdSeed = `remote-${spaceId}`.replace(/[^a-zA-Z0-9_-]/g, '-')

  const handleSelect = useCallback(async (entry: FileEntry) => {
    setSelectedFile(entry)
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(true)
    try {
      const data = await remoteReadFilePreview(spaceId, entry.path)
      setPreview(data)
    } catch (err) {
      setPreviewError(errorText(err))
    } finally {
      setPreviewLoading(false)
    }
  }, [spaceId, errorText])

  const handleRefresh = useCallback(() => {
    setRefreshToken((n) => n + 1)
  }, [])

  return (
    <WorkdirPaneShell
      layoutId={`remote-folder-${layoutIdSeed}`}
      surface="file-explorer"
      sidebarMinWidth={MIN_SIDEBAR_WIDTH}
      sidebarMaxWidth={MAX_SIDEBAR_WIDTH}
      sidebarDefaultWidth={DEFAULT_SIDEBAR_WIDTH}
      className={className}
      sidebarCollapsed={sidebarCollapsed}
      header={
        // WorkdirPaneShell 自带 px-3 py-2 的 header 带，这里不再加 padding
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            className="shrink-0 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            title={
              sidebarCollapsed
                ? t('remoteFolder.expandSidebar', { defaultValue: '展开侧栏' })
                : t('remoteFolder.collapseSidebar', { defaultValue: '折叠侧栏' })
            }
            aria-label={
              sidebarCollapsed
                ? t('remoteFolder.expandSidebar', { defaultValue: '展开侧栏' })
                : t('remoteFolder.collapseSidebar', { defaultValue: '折叠侧栏' })
            }
            aria-pressed={sidebarCollapsed}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" />
            )}
          </button>
          <Monitor className="h-4 w-4 shrink-0 text-muted-foreground/60" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-body text-foreground">{folderTitle}</div>
            <div className="truncate text-caption text-muted-foreground/60">
              {deviceName
                ? t('remoteFolder.subtitleWithDevice', {
                    device: deviceName,
                    defaultValue: '正在浏览「{{device}}」上的文件（只读）',
                  })
                : t('remoteFolder.subtitle', { defaultValue: '正在浏览执行设备上的文件（只读）' })}
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            onClick={handleRefresh}
            title={t('remoteFolder.refresh', { defaultValue: '刷新' })}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      }
      sidebar={
        rootError ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <AlertCircle className="mb-2 h-6 w-6 text-muted-foreground/40" strokeWidth={1} />
            <p className="mb-3 text-body text-muted-foreground/80">{rootError}</p>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-caption text-muted-foreground hover:bg-muted"
              onClick={handleRefresh}
            >
              <RefreshCw className="h-3 w-3" />
              {t('remoteFolder.retry', { defaultValue: '重试' })}
            </button>
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <RemoteTree
              spaceId={spaceId}
              rootPath={normalizedRoot}
              refreshToken={refreshToken}
              selectedPath={selectedFile?.path ?? null}
              onSelect={handleSelect}
              onRootError={setRootError}
            />
          </div>
        )
      }
    >
      <RemotePreviewPane
        entry={selectedFile}
        preview={preview}
        isLoading={previewLoading}
        error={previewError}
      />
    </WorkdirPaneShell>
  )
}

RemoteFolderPane.displayName = 'RemoteFolderPane'
