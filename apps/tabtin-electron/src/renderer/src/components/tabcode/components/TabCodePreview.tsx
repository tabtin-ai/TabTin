/**
 * TabCode 文件预览 / Diff / Markdown 渲染视图
 *
 * 画布风格：
 * - 文件路径作为轻量面包屑（无背景色条）
 * - 操作按钮 hover 时浮现
 * - 无选中时展示柔和引导
 * - .md：源码 / GitHub 风渲染 / Diff 三态（Git 模式同样可用）
 */

import React, { useState, useEffect, useCallback, useRef, lazy, Suspense, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileCode2, Send, GitCompare, Eye, EyeOff, ChevronRight, Columns2, Code2, Save, Loader2, Check, X,
} from 'lucide-react'
import { sendCodeContextToChat } from '../sendCodeContextToChat'
import { useFileContentWatch, FILE_DELETED_VERSION } from '@hooks/useFileContentWatch'
import { FileKindPreview } from '@components/shared/file-preview/FileKindPreview'
import { MarkdownViewer } from '@components/shared/file-preview/MarkdownViewer'
import { stripPlanMetadata } from '@components/shared/file-preview/localFilePreviewRegistry'
import { TextFileEditor, type TextEditorState } from '@components/shared/file-preview/TextFileEditor'
import type { EditorFindRequest } from '@components/shared/file-preview/editorFindTypes'
import { CodeSelectionToolbar } from '@components/shared/file-preview/CodeSelectionToolbar'
import type { CodeSelectionData } from '@components/shared/file-preview/codeSelection'
import type { FilePreviewData } from '@components/shared/file-preview/types'
import { getBaseName, getMonacoLanguage, isMarkdownFile } from '@components/shared/file-utils'
import { cn } from '@utils/cn'

import type { ViewMode } from './TabCodeToolbar'
import type { DiffMode, DiffStats } from './TabCodeDiffView'
import { relativePath } from '../utils/path'
import type { GitGutterBaseline } from '@components/shared/file-preview/gitGutterDecorations'

const TabCodeDiffView = lazy(() => import('./TabCodeDiffView'))

type MdPanelMode = 'source' | 'rendered' | 'diff'

export interface TabCodePreviewCacheEntry {
  content: string
  kind: FilePreviewData['kind'] | null
  truncated?: boolean
}

export type TabCodePreviewCache = Map<string, TabCodePreviewCacheEntry>

type ContentDropProps = React.HTMLAttributes<HTMLDivElement> & {
  'data-editor-content-dropzone'?: string
}

interface TabCodePreviewProps {
  rootPath: string
  /** 外层 Context 标签是否激活；保活 pane 隐藏时清掉 body 浮层。 */
  isPaneActive?: boolean
  editorSessionKey: string
  editorGroupId: string
  filePath: string | null
  isPinned?: boolean
  initialLine?: number
  initialLineKey?: number
  findRequest?: EditorFindRequest
  isGitRepo: boolean
  /** Git 状态快照版本，用于分支/HEAD 变化后刷新正常预览的基线。 */
  gitStatusRevision?: number
  /** 当前路径的 Git 内容版本，用于使 Diff 已解析缓存失效。 */
  gitContentRevision?: number
  viewMode?: ViewMode
  gitDiffMode?: DiffMode
  /** 当前文件 git 状态（A/?/D/M…），用于 Diff 顶栏 New/Deleted 徽章 */
  fileGitStatus?: string | null
  onClose?: () => void
  onCollapse?: () => void
  onFileSaved?: () => void | Promise<void>
  onEditorStateChange?: (
    sessionKey: string,
    groupId: string,
    filePath: string,
    state: TextEditorState | null,
  ) => void
  /**
   * 当外部删除当前选中文件时回调（譬如 Agent 在终端 mv 走、Finder 删了）。
   * 父组件应当在此回调里清掉 `selectedFile` 状态，避免：
   *  - 面包屑路径条继续显示已删文件路径
   *  - 文件树侧边栏把已删文件标为高亮选中（鬼影）
   */
  onFileDeleted?: () => void
  /** 编辑器正文的拖放边界；文件名和操作工具条不属于该区域。 */
  contentDropProps?: ContentDropProps
  /** 仅覆盖编辑器正文的落点提示。 */
  contentOverlay?: React.ReactNode
  /** 同一个工作区各编辑器组共享，跨组拖动标签时不重新读取文件。 */
  previewCache?: TabCodePreviewCache
  /** 仅 TabCode 编辑器组在文件切换时复用 Monaco 容器。 */
  preserveEditorOnFileChange?: boolean
}

function viewModeToDiffMode(viewMode?: ViewMode, gitDiffMode?: DiffMode): DiffMode {
  if (gitDiffMode) return gitDiffMode
  if (viewMode === 'staged') return 'staged'
  if (viewMode === 'unstaged') return 'unstaged'
  return 'head'
}

export const TabCodePreview: React.FC<TabCodePreviewProps> = ({
  rootPath,
  isPaneActive = true,
  editorSessionKey,
  editorGroupId,
  filePath,
  isPinned = false,
  initialLine,
  initialLineKey,
  findRequest,
  isGitRepo,
  gitStatusRevision = 0,
  gitContentRevision = 0,
  viewMode,
  gitDiffMode,
  fileGitStatus = null,
  onClose,
  onCollapse,
  onFileSaved,
  onEditorStateChange,
  onFileDeleted,
  contentDropProps,
  contentOverlay,
  previewCache,
  preserveEditorOnFileChange = false,
}) => {
  const { t } = useTranslation('tabcode')
  const [content, setContent] = useState<string>('')
  const [contentTruncated, setContentTruncated] = useState(false)
  const [gitGutterBaseline, setGitGutterBaseline] = useState<GitGutterBaseline | null>(null)
  const [gitGutterBaselineKey, setGitGutterBaselineKey] = useState<string | null>(null)
  const gitGutterBaselineCacheRef = useRef(new Map<string, GitGutterBaseline>())
  const [previewKind, setPreviewKind] = useState<FilePreviewData['kind'] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [localDiffMode, setLocalDiffMode] = useState(false)
  const [sideBySide, setSideBySide] = useState(false)
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null)
  const selectionDataRef = useRef<CodeSelectionData | null>(null)
  const [selection, setSelection] = useState<CodeSelectionData | null>(null)
  const hasSelection = Boolean(selection?.text)
  const [editorState, setEditorState] = useState<TextEditorState | null>(null)
  const [mdPanelMode, setMdPanelMode] = useState<MdPanelMode>('source')
  /** staged Diff 场景下渲染侧需读暂存区内容，与磁盘工作区可能不同 */
  const [mdGitRenderContent, setMdGitRenderContent] = useState<string | null>(null)
  const localPreviewCacheRef = useRef<TabCodePreviewCache>(new Map())
  const activePreviewCache = previewCache ?? localPreviewCacheRef.current
  const [contentFilePath, setContentFilePath] = useState<string | null>(null)
  const [contentFileVersion, setContentFileVersion] = useState<number | null>(null)

  useEffect(() => {
    if (isPaneActive) return
    // 选区工具条通过 body portal 挂载，保活 pane 隐藏时不能让旧选区浮层留在新标签上。
    selectionDataRef.current = null
    setSelection(null)
  }, [isPaneActive])

  const handleEditorStateChange = useCallback((nextState: TextEditorState) => {
    setEditorState(nextState)
    if (filePath) onEditorStateChange?.(editorSessionKey, editorGroupId, filePath, nextState)
  }, [editorGroupId, editorSessionKey, filePath, onEditorStateChange])

  const isAutoGitView = Boolean(gitDiffMode) || viewMode === 'staged' || viewMode === 'unstaged'
  const fileVersion = useFileContentWatch(filePath)
  const diffMode = viewModeToDiffMode(viewMode, gitDiffMode)
  const diffContentRevision = diffMode === 'commit' || diffMode === 'branch'
    ? fileVersion
    : `${gitContentRevision}:${fileVersion}`
  const cachedPreview = filePath && fileVersion !== FILE_DELETED_VERSION
    ? activePreviewCache.get(filePath)
    : null
  const currentPreview = cachedPreview
    ?? (contentFilePath === filePath
      ? { content, kind: previewKind, truncated: contentTruncated, version: fileVersion }
      : null)
  const displayContent = currentPreview?.content ?? ''
  const displayPreviewKind = currentPreview?.kind ?? null
  const isTruncated = Boolean(currentPreview?.truncated)
  // null（加载中/初始）按文本路径处理，避免闪一下 viewer fallback。
  const isTextKind = displayPreviewKind === null || displayPreviewKind === 'text'
  const isMarkdown = Boolean(filePath && isMarkdownFile(getBaseName(filePath)))
  const canShowGitDiff = isGitRepo || Boolean(gitDiffMode)

  const showDiff = isTextKind && canShowGitDiff && (
    isMarkdown
      ? mdPanelMode === 'diff'
      : (localDiffMode || isAutoGitView)
  )
  const showMarkdownRendered = isMarkdown && isTextKind && mdPanelMode === 'rendered' && !showDiff
  const gitGutterSourceKey = filePath && rootPath
    ? `${rootPath}\0${relativePath(rootPath, filePath)}\0${gitStatusRevision}`
    : null
  const activeGitGutterBaseline = gitGutterBaselineKey === gitGutterSourceKey
    ? gitGutterBaseline
    : null

  // 正常源码态使用 HEAD 作为 gutter 基线。Diff / Markdown
  // 渲染态不复用该基线，避免两套差异装饰同时存在。
  useEffect(() => {
    const shouldLoadBaseline = Boolean(
      filePath
      && rootPath
      && isGitRepo
      && isTextKind
      && !isTruncated
      && !showDiff
      && !showMarkdownRendered,
    )
    if (!shouldLoadBaseline || !filePath || !rootPath) {
      setGitGutterBaselineKey(null)
      setGitGutterBaseline(null)
      return
    }

    let cancelled = false
    const filePathInRepo = relativePath(rootPath, filePath)
    const cacheKey = `${rootPath}\0${filePathInRepo}\0${gitStatusRevision}`
    const cachedBaseline = gitGutterBaselineCacheRef.current.get(cacheKey)
    if (cachedBaseline) {
      setGitGutterBaselineKey(cacheKey)
      setGitGutterBaseline(cachedBaseline)
      return () => {
        cancelled = true
      }
    }

    // 清空旧文件/旧 revision 的 decoration，直到 HEAD 基线抵达后再恢复。
    setGitGutterBaselineKey(null)
    setGitGutterBaseline(null)
    window.tabtin.git.getFileAtHead(rootPath, filePathInRepo)
      .then((result) => {
        if (cancelled) return
        if (!result || result.success === false) {
          setGitGutterBaseline(null)
          return
        }
        const baseline = {
          content: result.content ?? '',
          revision: gitStatusRevision,
        }
        gitGutterBaselineCacheRef.current.set(cacheKey, baseline)
        setGitGutterBaselineKey(cacheKey)
        setGitGutterBaseline(baseline)
      })
      .catch(() => {
        if (!cancelled) setGitGutterBaseline(null)
      })

    return () => {
      cancelled = true
    }
  }, [
    filePath,
    rootPath,
    isGitRepo,
    gitStatusRevision,
    isTextKind,
    isTruncated,
    showDiff,
    showMarkdownRendered,
  ])

  useEffect(() => {
    if (!filePath || isTextKind) return
    onEditorStateChange?.(editorSessionKey, editorGroupId, filePath, null)
  }, [editorGroupId, editorSessionKey, filePath, isTextKind, onEditorStateChange])

  useEffect(() => () => {
    if (filePath) onEditorStateChange?.(editorSessionKey, editorGroupId, filePath, null)
  }, [editorGroupId, editorSessionKey, filePath, onEditorStateChange])

  // 外部删除鬼影修复：fileVersion=-1 表示磁盘上文件已不存在（pathExists 探测）。
  useEffect(() => {
    if (fileVersion === FILE_DELETED_VERSION && onFileDeleted) {
      onFileDeleted()
    }
  }, [fileVersion, onFileDeleted])

  // 换文件 / 进出 Git Diff 意图时：清手动 Diff，避免非 md 粘滞「此文件无变更」。
  // md：进 Git/Changes 默认 Diff；普通预览默认源码（与 Folder 一致，便于编辑）。
  useEffect(() => {
    setLocalDiffMode(false)
    setDiffStats(null)
    if (!isMarkdown) return
    setMdPanelMode(isAutoGitView ? 'diff' : 'source')
    setMdGitRenderContent(null)
  }, [filePath, isAutoGitView, isMarkdown])

  useEffect(() => {
    if (!filePath) {
      setContent('')
      setContentTruncated(false)
      setPreviewKind(null)
      setEditorState(null)
      setContentFilePath(null)
      setContentFileVersion(null)
      return
    }
    if (fileVersion === FILE_DELETED_VERSION) {
      activePreviewCache.delete(filePath)
      setContent('')
      setContentTruncated(false)
      setPreviewKind(null)
      setContentFilePath(filePath)
      setContentFileVersion(fileVersion)
      setIsLoading(false)
      return
    }
    // 编辑/保存期间只跳过当前文件的磁盘重读；切换到另一标签必须继续读取，
    // 不能继承前一标签的 dirty 状态。
    if (
      contentFilePath === filePath
      && (editorState?.dirty || editorState?.status === 'saving')
    ) return
    let cancelled = false
    setEditorState(null)
    const cached = activePreviewCache.get(filePath)
    if (cached) {
      setIsLoading(false)
      // 缓存来自另一个编辑器组或文件已在本组发生变更时，先无闪烁地显示缓存，
      // 同时在后台校验磁盘内容。这里不能 setContentFilePath，否则会触发 effect
      // cleanup 取消唯一一次校验读盘。
      if (contentFilePath === filePath && contentFileVersion === fileVersion) return
    } else {
      setIsLoading(true)
    }
    window.tabtin.fileSystem.readFilePreview(filePath, { maxBytes: 512 * 1024 })
      .then((result: { data?: FilePreviewData } | null) => {
        if (cancelled) return
        const data: FilePreviewData | undefined = result?.data
        const nextKind = data?.kind ?? null
        const nextContent = data?.kind === 'text' ? (data.content || '') : ''
        activePreviewCache.set(filePath, {
          content: nextContent,
          kind: nextKind,
          truncated: Boolean(data?.truncated),
        })
        setPreviewKind(nextKind)
        setContentTruncated(Boolean(data?.truncated))
        // 仅 text/code 走 Monaco；image/pdf/office 由对应 viewer 按路径加载，
        // 不把二进制内容塞进编辑器（此前所有非文本文件显示乱码的根因）。
        setContent(nextContent)
        setContentFilePath(filePath)
        setContentFileVersion(fileVersion)
      })
      .catch(() => {
        if (!cancelled) {
          setContent('')
          setContentTruncated(false)
          setPreviewKind(null)
        }
      })
      .finally(() => { if (!cancelled) setIsLoading(false) })
    return () => { cancelled = true }
  }, [
    filePath,
    fileVersion,
    editorState?.dirty,
    editorState?.status,
    contentFilePath,
    contentFileVersion,
    activePreviewCache,
  ])

  // Git 渲染预览：staged 读暂存区；其余读工作区（与 Diff modified 侧一致）
  useEffect(() => {
    if (!showMarkdownRendered || !filePath || !rootPath) {
      setMdGitRenderContent(null)
      return
    }
    const diffMode = viewModeToDiffMode(viewMode, gitDiffMode)
    if (!isAutoGitView || diffMode !== 'staged') {
      setMdGitRenderContent(null)
      return
    }

    let cancelled = false
    const filePathInRepo = relativePath(rootPath, filePath)
    window.tabtin.git.getFileAtStaged(rootPath, filePathInRepo)
      .then((r) => {
        if (cancelled) return
        // 失败/空暂存时回退工作区 content，避免预览空白闪一下。
        setMdGitRenderContent(r?.content ?? content)
      })
      .catch(() => {
        if (!cancelled) setMdGitRenderContent(content)
      })
    return () => { cancelled = true }
  }, [showMarkdownRendered, filePath, rootPath, viewMode, gitDiffMode, isAutoGitView, fileVersion, content])

  const language = useMemo(
    () => (filePath ? getMonacoLanguage(getBaseName(filePath)) : 'plaintext'),
    [filePath],
  )

  const markdownDisplayContent = useMemo(() => {
    const raw = mdGitRenderContent !== null ? mdGitRenderContent : displayContent
    return stripPlanMetadata(raw)
  }, [mdGitRenderContent, displayContent])

  const handleSendFile = useCallback(() => {
    if (!filePath || !displayContent) return
    sendCodeContextToChat({
      type: 'code_file',
      resourceId: filePath,
      label: filePath.split('/').pop() || filePath,
      preview: displayContent.slice(0, 2000),
      meta: { filePath, rootPath, language },
    })
  }, [filePath, displayContent, rootPath, language])

  const handleSelectionChange = useCallback((data: CodeSelectionData | null) => {
    selectionDataRef.current = data
    setSelection(data)
  }, [])

  const handleContentChange = useCallback((nextContent: string) => {
    setContent(nextContent)
    // 共享缓存只保存已从磁盘确认的快照。未保存编辑内容属于当前编辑器缓冲，
    // 绝不能传播到同一文件的另一个编辑器组，避免其误保存覆盖磁盘。
  }, [])

  const sendSelectionToChat = useCallback((data: CodeSelectionData) => {
    if (!filePath) return
    const fileName = filePath.split('/').pop() || filePath
    sendCodeContextToChat({
      type: 'code_selection',
      resourceId: `${filePath}:${data.startLine}-${data.endLine}`,
      label: `${fileName}:L${data.startLine}-L${data.endLine}`,
      preview: data.text.slice(0, 2000),
      meta: { filePath, rootPath, startLine: data.startLine, endLine: data.endLine, language },
    })
  }, [filePath, rootPath, language])

  const handleToolbarSendSelection = useCallback(() => {
    const data = selectionDataRef.current
    if (data) sendSelectionToChat(data)
  }, [sendSelectionToChat])

  // 仅换文件时清编辑态；源码、Diff、Markdown 预览互切必须保留 dirty。
  useEffect(() => {
    selectionDataRef.current = null
    setSelection(null)
    setEditorState(null)
  }, [filePath])

  const handleMdPanelMode = useCallback((mode: MdPanelMode) => {
    setMdPanelMode(mode)
    setDiffStats(null)
    if (mode === 'diff') {
      setLocalDiffMode(true)
    } else {
      setLocalDiffMode(false)
    }
  }, [])

  // Diff 下整文件 New / Deleted 顶栏徽章（普通编辑态不打扰）。
  const fileStatusBadge = useMemo(() => {
    if (!showDiff || !fileGitStatus) return null
    if (fileGitStatus === 'A' || fileGitStatus === '?') {
      return { label: t('preview.badgeNew'), className: 'bg-success/15 text-success' }
    }
    if (fileGitStatus === 'D') {
      return { label: t('preview.badgeDeleted'), className: 'bg-destructive/15 text-destructive' }
    }
    return null
  }, [showDiff, fileGitStatus, t])

  // 空状态
  if (!filePath) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <FileCode2 className="h-8 w-8 text-muted-foreground/20 mb-2" strokeWidth={1} />
        <p className="text-body text-muted-foreground/40">{t('preview.selectFile')}</p>
      </div>
    )
  }

  // 面包屑式路径
  const segments = relativePath(rootPath, filePath).split('/')

  const renderSaveStatus = () => {
    if (!isTextKind || showDiff || showMarkdownRendered || !editorState) return null
    const { dirty, status, save } = editorState

    if (status === 'saving') {
      return (
        <span className="flex items-center gap-1 text-caption text-muted-foreground/60 px-1.5 py-0.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('preview.saving')}
        </span>
      )
    }

    if (status === 'saved') {
      return (
        <span className="flex items-center gap-1 text-caption text-success/80 px-1.5 py-0.5">
          <Check className="h-3.5 w-3.5" />
          {t('preview.saved')}
        </span>
      )
    }

    if (!dirty) return null

    return (
      <button
        className="flex items-center gap-1 text-caption px-1.5 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        title={t('preview.save')}
        onClick={save}
      >
        <Save className="h-3.5 w-3.5" />
        {t('preview.save')}
      </button>
    )
  }
  const showEditorSaveStatus = isTextKind && !showDiff && !showMarkdownRendered && !!editorState && (
    editorState.dirty || editorState.status === 'saving' || editorState.status === 'saved'
  )

  const renderMarkdownToggle = () => {
    if (!isMarkdown || !isTextKind) return null
    const modes: Array<{ id: MdPanelMode; label: string; icon: React.ReactNode; enabled: boolean }> = [
      {
        id: 'source',
        label: t('preview.viewSource'),
        icon: <Code2 className="h-2.5 w-2.5" />,
        enabled: true,
      },
      {
        id: 'rendered',
        label: t('preview.viewRendered'),
        icon: <Eye className="h-2.5 w-2.5" />,
        enabled: true,
      },
      {
        id: 'diff',
        label: t('preview.showDiff'),
        icon: <GitCompare className="h-2.5 w-2.5" />,
        enabled: canShowGitDiff,
      },
    ]

    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5 mr-1">
        {modes.filter((m) => m.enabled).map((mode) => (
          <button
            key={mode.id}
            type="button"
            onClick={() => handleMdPanelMode(mode.id)}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded text-caption transition-colors',
              mdPanelMode === mode.id
                ? 'bg-background text-foreground/80 shadow-sm'
                : 'text-muted-foreground/60 hover:text-foreground/80',
            )}
            title={mode.label}
          >
            {mode.icon}
            {mode.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      className="flex flex-col h-full"
      data-preview-cache={cachedPreview ? 'hit' : 'miss'}
    >
      {/* 文件路径 + 操作 — 薄工具条，与下方编辑面贴边 */}
      <div className="group/header flex items-center justify-between px-2 py-1">
        <div className="flex items-center gap-0.5 text-caption text-muted-foreground/60 min-w-0 flex-1">
          {segments.map((seg, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight className="h-2.5 w-2.5 flex-shrink-0 opacity-40" />}
              <span className={`truncate ${
                i === segments.length - 1
                  ? isPinned
                    ? 'text-foreground/80 font-medium'
                    : 'text-foreground/80 font-medium italic'
                  : ''
              }`}>
                {seg}
              </span>
            </React.Fragment>
          ))}
          {fileStatusBadge && (
            <span className={`ml-2 shrink-0 rounded px-1.5 py-0.5 text-caption font-medium ${fileStatusBadge.className}`}>
              {fileStatusBadge.label}
            </span>
          )}
        </div>

        <div className={`flex items-center gap-1 transition-opacity ${
          showEditorSaveStatus || isMarkdown ? 'opacity-100' : 'opacity-0 group-hover/header:opacity-100'
        }`}>
          {renderMarkdownToggle()}

          {/* Diff 统计 */}
          {showDiff && diffStats && (diffStats.insertions > 0 || diffStats.deletions > 0) && (
            <span className="text-caption tabular-nums mr-1 text-muted-foreground/60">
              {diffStats.insertions > 0 && (
                <span className="text-success/80">+{diffStats.insertions}</span>
              )}
              {diffStats.deletions > 0 && (
                <span className="text-destructive/80 ml-0.5">-{diffStats.deletions}</span>
              )}
            </span>
          )}

          {/* Side-by-side：新文件/删文件走空基线统一视图，分栏无效故隐藏 */}
          {showDiff && fileGitStatus !== '?' && fileGitStatus !== 'A' && fileGitStatus !== 'D' && (
            <button
              className={`p-1.5 rounded-md transition-colors ${
                sideBySide
                  ? 'text-primary/80 bg-primary/5'
                  : 'text-muted-foreground/40 hover:text-foreground hover:bg-muted/40'
              }`}
              title={t('preview.sideBySide')}
              onClick={() => setSideBySide(!sideBySide)}
            >
              <Columns2 className="h-3.5 w-3.5" />
            </button>
          )}

          {isGitRepo && !isAutoGitView && isTextKind && !isMarkdown && (
            <button
              className={`p-1.5 rounded-md transition-colors ${
                localDiffMode
                  ? 'text-primary/80 bg-primary/5'
                  : 'text-muted-foreground/40 hover:text-foreground hover:bg-muted/40'
              }`}
              title={localDiffMode ? t('preview.showCode') : t('preview.showDiff')}
              onClick={() => { setLocalDiffMode(!localDiffMode); setDiffStats(null) }}
            >
              {localDiffMode ? <Eye className="h-3.5 w-3.5" /> : <GitCompare className="h-3.5 w-3.5" />}
            </button>
          )}
          {renderSaveStatus()}
          {/* 发送选区 / 发送文件仅对文本有意义；二进制内容发出去是乱码，隐藏。 */}
          {isTextKind && !showMarkdownRendered && (
            <>
              <button
                className={`p-1.5 rounded-md transition-colors ${
                  hasSelection
                    ? 'text-muted-foreground/40 hover:text-foreground hover:bg-muted/40'
                    : 'text-muted-foreground/20 cursor-not-allowed'
                }`}
                title={t('preview.sendSelectionToAgent')}
                onClick={handleToolbarSendSelection}
                disabled={!hasSelection}
              >
                <Code2 className="h-3.5 w-3.5" />
              </button>
              <button
                className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors"
                title={t('preview.sendToAgent')}
                onClick={handleSendFile}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {onCollapse && (
            <button
              type="button"
              className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors"
              title={t('preview.collapse')}
              aria-label={t('preview.collapse')}
              onClick={onCollapse}
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors"
              title={t('preview.close')}
              aria-label={t('preview.close')}
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 代码：贴边沉浸编辑面（主题自管背景，无卡片圆角/灰底）。
          文本/代码走 Monaco：外层不加 overflow-hidden，避免裁掉查找栏 tooltip。
          非文本（图片/PDF/office）保留轻中性底 + overflow-hidden 裁圆角。 */}
      <div
        {...contentDropProps}
        className={cn(
          'flex-1 min-h-0 relative',
          isTextKind && !showMarkdownRendered ? 'tabcode-editor' : 'rounded-lg bg-muted/[0.03] overflow-hidden',
          contentDropProps?.className,
        )}
      >
        {isLoading && (
          <div className="absolute inset-0 z-sticky flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
          </div>
        )}
        {/* 显式 gitDiffMode（DiffCard）不必等 isGitRepo 探针；探针慢时否则会一直停在普通编辑器。
            门禁已收进上方 showDiff（canShowGitDiff = isGitRepo || Boolean(gitDiffMode)）。 */}
        {showDiff ? (
          <Suspense fallback={
            <div className="flex items-center justify-center h-full">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
            </div>
          }>
            <TabCodeDiffView
              rootPath={rootPath}
              filePath={filePath}
              language={language}
              diffMode={diffMode}
              sideBySide={sideBySide}
              contentRevision={diffContentRevision}
              initialLine={initialLine}
              initialLineKey={initialLineKey}
              onDiffStats={setDiffStats}
            />
          </Suspense>
        ) : showMarkdownRendered ? (
          <MarkdownViewer
            content={markdownDisplayContent}
            filePath={filePath}
            className="h-full w-full"
          />
        ) : isTextKind ? (
          <TextFileEditor
            filePath={filePath}
            content={displayContent}
            truncated={isTruncated}
            initialLine={initialLine}
            initialLineKey={initialLineKey}
            findRequest={findRequest}
            onSendSelection={sendSelectionToChat}
            onSelectionChange={handleSelectionChange}
            gitGutterBaseline={activeGitGutterBaseline}
            onStateChange={handleEditorStateChange}
            onSaveSuccess={onFileSaved}
            onChange={handleContentChange}
            labels={{
              truncatedPreview: t('preview.truncatedPreview'),
              largePreviewHint: t('preview.largePreviewHint'),
              saveFailed: t('preview.saveFailed'),
            }}
            className="h-full w-full"
            preserveEditorOnFileChange={preserveEditorOnFileChange}
          />
        ) : (
          <FileKindPreview
            kind={displayPreviewKind as FilePreviewData['kind']}
            filePath={filePath}
            fileName={segments[segments.length - 1] || filePath}
            unsupportedLabel={t('preview.unsupportedType', '此文件类型暂不支持预览')}
          />
        )}
        {contentOverlay}
      </div>

      {isPaneActive && !showDiff && !showMarkdownRendered && (
        <CodeSelectionToolbar
          selection={selection}
          onAddToChat={sendSelectionToChat}
        />
      )}
    </div>
  )
}
