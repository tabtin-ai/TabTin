/**
 * TabCode Diff View — Monaco DiffEditor
 *
 * 支持四种 diffMode：
 * - head: HEAD vs 工作区（默认）
 * - staged: HEAD vs 暂存区
 * - unstaged: 暂存区 vs 工作区
 * - commit: 父提交 vs 指定 commit（需 commitHash + getFileAtCommit）
 *
 * Monaco DiffEditor 实例在挂载时创建一次，切换文件/内容时复用。
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { configureMonacoWorkers } from '@utils/monaco-setup'
import { useMonacoThemeSync } from '@/hooks/useMonacoThemeSync'
import {
  getMonacoIdeThemeName,
  MONACO_IDE_FONT_FAMILY,
  MONACO_IDE_FONT_SIZE,
  MONACO_IDE_LINE_HEIGHT,
} from '@/utils/monaco-ide-theme'
import { useTranslation } from 'react-i18next'
import { FileCode2, AlertTriangle } from 'lucide-react'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import {
  markFirstDiffReady,
  trackMonacoDispose,
  trackMonacoMount,
} from '../../context-space/code-workspace/changesPerfMetrics'
import {
  loadDiffContents,
  type DiffContentRevision,
  type DiffMetadata,
  type DiffMode,
} from './diffContentCache'
import { disposeDiffEditorSafely } from './disposeDiffEditor'
import { EmptyBaselineDiffView } from './EmptyBaselineDiffView'
import {
  isEmptyDiffBaseline,
  summarizeMonacoLineChanges,
} from './tabCodeDiffStats'

export type { DiffMode }

export interface DiffStats {
  insertions: number
  deletions: number
}

export interface DiffReadyInfo {
  hasChanges: boolean
  insertions: number
  deletions: number
}

/**
 * inline Diff 默认会叠：original 行号 + modified 行号 + insert/delete 符号（看起来像 37+）。
 * 关掉 original 行号与 ± 符号，只留 modified 一列数字 + 色条。分栏时两侧各自一列。
 */
function applyDiffEditorDisplayOptions(
  editor: monaco.editor.IStandaloneDiffEditor,
  sideBySide: boolean,
) {
  editor.getModifiedEditor().updateOptions({
    lineNumbers: 'on',
    wordWrap: 'off',
    glyphMargin: false,
    folding: false,
    // 留给 gutter 色条，避免再给 ± 图标占位
    lineDecorationsWidth: 8,
    lineNumbersMinChars: 3,
  })
  if (sideBySide) {
    editor.getOriginalEditor().updateOptions({
      lineNumbers: 'on',
      wordWrap: 'off',
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 8,
      lineNumbersMinChars: 3,
    })
    return
  }
  editor.getOriginalEditor().updateOptions({
    lineNumbers: 'off',
    wordWrap: 'off',
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 0,
    lineNumbersMinChars: 0,
  })
}

interface TabCodeDiffViewProps {
  rootPath: string
  filePath: string
  language: string
  diffMode?: DiffMode
  /** diffMode=commit 时必填：展示 parent..commit 的文件内容。 */
  commitHash?: string
  sideBySide?: boolean
  /** 磁盘 / git 状态修订；外部改文件后递增以重拉左右两侧内容。 */
  contentRevision?: DiffContentRevision
  /** 1-based；内容就绪后滚到 modified 侧该行（DiffCard 变更区）。 */
  initialLine?: number
  initialLineKey?: number
  onDiffStats?: (stats: DiffStats) => void
  /** 内容与行级变更就绪后回调（连续审阅用来省略无差异文件段）。 */
  onDiffReady?: (info: DiffReadyInfo) => void
  /** 折叠未变更区域，只保留 hunks 与少量上下文（默认关）。 */
  hideUnchangedRegions?: boolean
  /**
   * 按内容高度撑开，关掉纵向滚动条（连续审阅外层统一滚动）。
   * 默认 false，避免影响 TabCode 单文件预览。
   */
  autoHeight?: boolean
  /** 定位后的选中文件优先进入 Diff 内容加载队列。 */
  priority?: boolean
}

const AUTO_HEIGHT_MIN = 96
const AUTO_HEIGHT_PAD = 24
const log = createLogger('TabCodeDiffView')

function layoutDiffEditorToContainer(
  editor: monaco.editor.IStandaloneDiffEditor,
  container: HTMLElement,
  height: number,
): void {
  const width = container.clientWidth
  if (width <= 0 || height <= 0) {
    if (container.style.display !== 'none') {
      log.warn('diff editor visible with zero size', { width, height })
    }
    return
  }
  editor.layout({ width, height })
}

const TabCodeDiffView: React.FC<TabCodeDiffViewProps> = ({
  rootPath,
  filePath,
  language,
  diffMode = 'head',
  commitHash,
  sideBySide = false,
  contentRevision = 0,
  initialLine,
  initialLineKey,
  onDiffStats,
  onDiffReady,
  hideUnchangedRegions = false,
  autoHeight = false,
  priority = false,
}) => {
  const { t } = useTranslation('tabcode')
  useMonacoThemeSync()
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const autoHeightRef = useRef(autoHeight)
  autoHeightRef.current = autoHeight
  const filePathRef = useRef(filePath)
  filePathRef.current = filePath
  const sideBySideRef = useRef(sideBySide)
  sideBySideRef.current = sideBySide
  const hideUnchangedRegionsRef = useRef(hideUnchangedRegions)
  hideUnchangedRegionsRef.current = hideUnchangedRegions

  const [originalContent, setOriginalContent] = useState<string | null>(null)
  const [modifiedContent, setModifiedContent] = useState<string | null>(null)
  const [metadataChange, setMetadataChange] = useState<DiffMetadata | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoContentHeight, setAutoContentHeight] = useState(AUTO_HEIGHT_MIN)
  const loadGenerationRef = useRef(0)
  const loadedContentIdentityRef = useRef<string | null>(null)
  const diffGenerationRef = useRef(0)
  const hideUnchangedRegionsReadyRef = useRef(false)
  const pendingAutoHeightRef = useRef(false)
  const originalContentRef = useRef<string | null>(null)
  const modifiedContentRef = useRef<string | null>(null)
  originalContentRef.current = originalContent
  modifiedContentRef.current = modifiedContent
  const priorityRef = useRef(priority)
  priorityRef.current = priority
  const onDiffStatsRef = useRef(onDiffStats)
  onDiffStatsRef.current = onDiffStats
  const onDiffReadyRef = useRef(onDiffReady)
  onDiffReadyRef.current = onDiffReady

  const autoHeightRafRef = useRef<number | null>(null)
  const scheduleAutoHeight = useCallback(() => {
    if (!autoHeightRef.current) return
    if (pendingAutoHeightRef.current) return
    if (autoHeightRafRef.current !== null) return
    autoHeightRafRef.current = requestAnimationFrame(() => {
      autoHeightRafRef.current = null
      if (pendingAutoHeightRef.current) return
      const editor = editorRef.current
      const container = containerRef.current
      if (!editor || !container) return
      const modified = editor.getModifiedEditor()
      const next = Math.max(modified.getContentHeight() + AUTO_HEIGHT_PAD, AUTO_HEIGHT_MIN)
      setAutoContentHeight((prev) => (prev === next ? prev : next))
      layoutDiffEditorToContainer(editor, container, next)
    })
  }, [])
  const layoutEditorNow = useCallback(() => {
    const editor = editorRef.current
    const container = containerRef.current
    if (!editor || !container) return
    if (autoHeightRef.current) {
      scheduleAutoHeight()
      return
    }
    layoutDiffEditorToContainer(editor, container, container.clientHeight)
  }, [scheduleAutoHeight])

  // 根据 diffMode 获取左右两侧内容（带版本键缓存）
  useEffect(() => {
    if (!filePath || !rootPath) return

    const identity = [rootPath, filePath, diffMode, commitHash || ''].join('\0')
    const generation = ++loadGenerationRef.current
    let cancelled = false
    const hasPreviousContent = loadedContentIdentityRef.current === identity
      && originalContentRef.current !== null
      && modifiedContentRef.current !== null
    if (!hasPreviousContent) {
      setOriginalContent(null)
      setModifiedContent(null)
      setMetadataChange(null)
      setAutoContentHeight(AUTO_HEIGHT_MIN)
      setIsLoading(true)
    }
    setError(null)

    const delay = hasPreviousContent ? 80 : 0
    const timer = window.setTimeout(() => {
      void loadDiffContents({
        rootPath,
        filePath,
        diffMode,
        commitHash,
        contentRevision,
        priority: priorityRef.current,
      }).then(({ left, right, metadataChange: nextMetadataChange }) => {
        if (cancelled || generation !== loadGenerationRef.current) return
        loadedContentIdentityRef.current = identity
        setOriginalContent(left)
        setModifiedContent(right)
        setMetadataChange(nextMetadataChange ?? null)
        setIsLoading(false)
        // 不在这里上报 hasChanges：字符串暂等不等于无行级 Diff，
        // 交给 Monaco onDidUpdateDiff / computeStats 作为唯一权威。
      }).catch(err => {
        if (cancelled || generation !== loadGenerationRef.current) return
        setIsLoading(false)
        if (hasPreviousContent) {
          // 后台刷新失败时保留旧预览；仅记录失败，不把已可用的段打回错误态。
          log.warn('background diff refresh failed', { filePath, error: String(err) })
          return
        }
        setError(String(err))
      })
    }, delay)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    filePath,
    rootPath,
    diffMode,
    commitHash,
    contentRevision,
  ])

  // 创建 DiffEditor 实例（只在挂载时创建一次）
  useEffect(() => {
    configureMonacoWorkers()
    const container = containerRef.current
    if (!container) return

    const theme = getMonacoIdeThemeName()
    const mountedFilePath = filePathRef.current
    const mountedSideBySide = sideBySideRef.current

    const diffEditor = monaco.editor.createDiffEditor(container, {
      readOnly: true,
      renderSideBySide: mountedSideBySide,
      // inline 时必须开：否则 Monaco 仍给 original 侧 Math.max(5, …) 宽，
      // 行号左侧会留一条缝，缝里漏出原文首字（<、#、如…）。
      compactMode: !mountedSideBySide,
      theme,
      fontSize: MONACO_IDE_FONT_SIZE,
      lineHeight: MONACO_IDE_LINE_HEIGHT,
      fontFamily: MONACO_IDE_FONT_FAMILY,
      fontLigatures: true,
      minimap: { enabled: false },
      // 与普通预览对齐：逻辑行不随窗口折行，横向滚动查看长行
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      // 同 CodeEditor：查找栏 overflow widget 设为 fixed，逃出 .tabcode-editor 的
      // overflow-hidden 裁剪，避免 tooltip 定位死循环闪动。
      fixedOverflowWidgets: true,
      scrollbar: autoHeight
        ? {
            vertical: 'hidden',
            horizontal: 'auto',
            verticalScrollbarSize: 0,
            horizontalScrollbarSize: 6,
            verticalHasArrows: false,
            horizontalHasArrows: false,
            useShadows: false,
            handleMouseWheel: false,
            horizontalSliderSize: 4,
          }
        : {
            vertical: 'auto',
            horizontal: 'auto',
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
            verticalHasArrows: false,
            horizontalHasArrows: false,
            useShadows: false,
            verticalSliderSize: 4,
            horizontalSliderSize: 4,
          },
      overviewRulerBorder: false,
      // Monaco Diff 默认会再挂 30px 宽的 Diff overview（粗条 + viewport），
      // 与编辑器细滚动条叠成双条。关掉专用 overview，只留 lanes 彩标。
      renderOverviewRuler: false,
      // 连续审阅全展开时也不要 overview 彩条占宽；单文件预览保留。
      overviewRulerLanes: autoHeight ? 0 : 2,
      // false：去掉行旁 ± / < 图标，避免与行号挤成「37+」；增删仍靠行底色 + gutter 色条。
      renderIndicators: false,
      renderLineHighlight: 'line',
      guides: { indentation: true },
      padding: { top: 12, bottom: 12 },
      folding: false,
      lineDecorationsWidth: 8,
      originalEditable: false,
      hideUnchangedRegions: { enabled: false },
    })
    applyDiffEditorDisplayOptions(diffEditor, mountedSideBySide)

    editorRef.current = diffEditor
    trackMonacoMount(mountedFilePath)

    let rafId: number | null = null
    const ro = new ResizeObserver(() => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        if (autoHeightRef.current) {
          scheduleAutoHeight()
        } else {
          diffEditor.layout()
        }
        rafId = null
      })
    })
    ro.observe(container)
    resizeObserverRef.current = ro

    const contentSizeDisposable = autoHeight
      ? diffEditor.getModifiedEditor().onDidContentSizeChange(() => {
          scheduleAutoHeight()
        })
      : null

    return () => {
      ro.disconnect()
      contentSizeDisposable?.dispose()
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (autoHeightRafRef.current !== null) {
        cancelAnimationFrame(autoHeightRafRef.current)
        autoHeightRafRef.current = null
      }
      const originalModel = originalModelRef.current
      const modifiedModel = modifiedModelRef.current
      originalModelRef.current = null
      modifiedModelRef.current = null
      disposeDiffEditorSafely(diffEditor, originalModel, modifiedModel)
      editorRef.current = null
      resizeObserverRef.current = null
      trackMonacoDispose(mountedFilePath)
    }
  }, [autoHeight, scheduleAutoHeight])

  // sideBySide / 折叠未变更区切换时实时更新编辑器选项
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const canEnableHiddenRegions = hideUnchangedRegions
      && (hideUnchangedRegionsReadyRef.current || originalModelRef.current !== null)
    if (canEnableHiddenRegions) hideUnchangedRegionsReadyRef.current = true
    editor.updateOptions({
      renderSideBySide: sideBySide,
      compactMode: !sideBySide,
      wordWrap: 'off',
      hideUnchangedRegions: canEnableHiddenRegions
        ? {
            enabled: true,
            contextLineCount: 3,
            minimumLineCount: 3,
            revealLineCount: 1,
          }
        : { enabled: false },
      scrollbar: autoHeight
        ? {
            vertical: 'hidden',
            horizontal: 'auto',
            verticalScrollbarSize: 0,
            handleMouseWheel: false,
          }
        : {
            vertical: 'auto',
            horizontal: 'auto',
            verticalScrollbarSize: 6,
          },
      overviewRulerLanes: autoHeight ? 0 : 2,
    })
    applyDiffEditorDisplayOptions(editor, sideBySide)
    if (autoHeight) {
      scheduleAutoHeight()
    }
  }, [sideBySide, hideUnchangedRegions, autoHeight, scheduleAutoHeight])

  const useEmptyBaselineView = originalContent !== null
    && modifiedContent !== null
    && originalContent !== modifiedContent
    && (
      isEmptyDiffBaseline(originalContent)
      || isEmptyDiffBaseline(modifiedContent)
    )
  const hasMetadataOnlyChange = originalContent === modifiedContent
    && metadataChange !== null

  const handleEmptyBaselineStats = useCallback((stats: {
    insertions: number
    deletions: number
    hasChanges: boolean
  }) => {
    onDiffStatsRef.current?.({
      insertions: stats.insertions,
      deletions: stats.deletions,
    })
    onDiffReadyRef.current?.(stats)
    if (autoHeightRef.current) markFirstDiffReady()
  }, [])

  // 内容/语言变化时更新 model（复用编辑器实例）
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || originalContent === null || modifiedContent === null) return
    // 空基线走静态行模型，避免 Monaco 空 model 假删/假增
    if (
      isEmptyDiffBaseline(originalContent)
      || isEmptyDiffBaseline(modifiedContent)
    ) {
      return
    }
    const generation = ++diffGenerationRef.current

    const lang = language || 'plaintext'
    pendingAutoHeightRef.current = autoHeightRef.current

    if (!originalModelRef.current || !modifiedModelRef.current) {
      const om = monaco.editor.createModel(originalContent, lang)
      const mm = monaco.editor.createModel(modifiedContent, lang)
      originalModelRef.current = om
      modifiedModelRef.current = mm
      editor.setModel({ original: om, modified: mm })
    } else {
      if (originalModelRef.current.getValue() !== originalContent) {
        originalModelRef.current.setValue(originalContent)
      }
      if (modifiedModelRef.current.getValue() !== modifiedContent) {
        modifiedModelRef.current.setValue(modifiedContent)
      }
      monaco.editor.setModelLanguage(originalModelRef.current, lang)
      monaco.editor.setModelLanguage(modifiedModelRef.current, lang)
    }
    if (!autoHeightRef.current) layoutEditorNow()
    if (hideUnchangedRegionsRef.current && !hideUnchangedRegionsReadyRef.current) {
      hideUnchangedRegionsReadyRef.current = true
      editor.updateOptions({
        hideUnchangedRegions: {
          enabled: true,
          contextLineCount: 3,
          minimumLineCount: 3,
          revealLineCount: 1,
        },
      })
    }

    const computeStats = () => {
      if (generation !== diffGenerationRef.current) return
      let changes: monaco.editor.ILineChange[] | null
      try {
        changes = editor.getLineChanges()
      } catch (error) {
        if (generation === diffGenerationRef.current) {
          log.warn('diff result unavailable during editor lifecycle', {
            filePath: filePathRef.current,
            error: String(error),
          })
        }
        return
      }
      // 计算中：等 onDidUpdateDiff；内容已确认相等时可直接收口，避免永远不回调
      if (changes == null && originalContent !== modifiedContent) return
      const stats = summarizeMonacoLineChanges(changes, originalContent, modifiedContent)
      onDiffStatsRef.current?.({
        insertions: stats.insertions,
        deletions: stats.deletions,
      })
      onDiffReadyRef.current?.({
        hasChanges: stats.hasChanges,
        insertions: stats.insertions,
        deletions: stats.deletions,
      })
      pendingAutoHeightRef.current = false
      // 仅连续审阅（autoHeight）计入 Changes 首帧就绪，避免污染普通预览指标
      if (autoHeightRef.current) markFirstDiffReady()
      if (autoHeightRef.current) scheduleAutoHeight()
    }

    const disposable = editor.onDidUpdateDiff(computeStats)
    computeStats()

    let revealRaf: number | null = null
    if (initialLine && initialLine > 0) {
      const modified = editor.getModifiedEditor()
      // Diff 布局后一帧再滚，避免 reveal 时 viewport 尚未就绪
      revealRaf = requestAnimationFrame(() => {
        modified.revealLineInCenter(initialLine)
        modified.setPosition({ lineNumber: initialLine, column: 1 })
      })
    }

    return () => {
      diffGenerationRef.current += 1
      disposable.dispose()
      if (revealRaf !== null) cancelAnimationFrame(revealRaf)
    }
  }, [originalContent, modifiedContent, language, initialLine, initialLineKey, layoutEditorNow, scheduleAutoHeight])

  const showEditor = !isLoading
    && !error
    && originalContent !== null
    && modifiedContent !== null
    && originalContent !== modifiedContent
    && !useEmptyBaselineView

  useLayoutEffect(() => {
    if (!showEditor) return
    layoutEditorNow()
  }, [showEditor, layoutEditorNow])

  const shellStyle = autoHeight
    ? {
        height: useEmptyBaselineView
          ? 'auto'
          : (showEditor ? autoContentHeight : AUTO_HEIGHT_MIN),
      }
    : undefined

  return (
    <div
      className={cn('relative w-full', autoHeight ? '' : 'h-full')}
      style={shellStyle}
    >
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-sticky">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-sticky text-muted-foreground/60 gap-2">
          <AlertTriangle className="h-6 w-6" />
          <p className="text-body">{error}</p>
        </div>
      )}

      {!isLoading && !error && originalContent === modifiedContent && !hasMetadataOnlyChange && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-sticky text-muted-foreground/40 gap-2">
          <FileCode2 className="h-8 w-8" strokeWidth={1} />
          <p className="text-body">{t('diff.noChanges')}</p>
        </div>
      )}

      {!isLoading && !error && hasMetadataOnlyChange && metadataChange && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-sticky text-muted-foreground/60 gap-2">
          <FileCode2 className="h-8 w-8" strokeWidth={1} />
          <p className="text-body">{t('diff.metadataChanged')}</p>
          <p className="text-caption text-muted-foreground/50">
            {metadataChange.oldMode && metadataChange.newMode
              ? `${metadataChange.oldMode} → ${metadataChange.newMode}`
              : metadataChange.newMode
                ? t('diff.modeCreated', { mode: metadataChange.newMode })
                : t('diff.modeDeleted', { mode: metadataChange.oldMode ?? '' })}
          </p>
          <p className="text-caption text-muted-foreground/50">{t('diff.contentUnchanged')}</p>
        </div>
      )}

      {useEmptyBaselineView && originalContent !== null && modifiedContent !== null ? (
        <div className={cn(autoHeight ? 'w-full' : 'absolute inset-0 overflow-auto')}>
          <EmptyBaselineDiffView
            originalContent={originalContent}
            modifiedContent={modifiedContent}
            filePath={filePath}
            language={language}
            autoHeight={autoHeight}
            onStats={handleEmptyBaselineStats}
          />
        </div>
      ) : null}

      <div
        ref={containerRef}
        className={cn('tabcode-editor w-full', autoHeight ? 'h-full' : 'h-full')}
        style={{
          // 空基线时勿用 visibility:hidden（仍占布局高度，会与静态 Diff 叠出空白滚动）
          display: showEditor ? undefined : 'none',
          height: autoHeight ? '100%' : undefined,
        }}
      />
    </div>
  )
}

export default TabCodeDiffView
