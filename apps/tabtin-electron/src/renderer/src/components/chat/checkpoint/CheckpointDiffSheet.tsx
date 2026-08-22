/**
 * CheckpointDiffSheet — 全屏 diff 预览弹窗
 *
 * 左侧文件列表，右侧 Monaco DiffEditor，底部确认/取消。
 * Monaco 实例在弹窗打开时创建，关闭时销毁。
 */

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { configureMonacoWorkers } from '@utils/monaco-setup'
import { useMonacoThemeSync } from '@/hooks/useMonacoThemeSync'
import {
  getMonacoIdeThemeName,
  MONACO_IDE_FONT_FAMILY,
  MONACO_IDE_FONT_SIZE,
  MONACO_IDE_LINE_HEIGHT,
} from '@/utils/monaco-ide-theme'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'

import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { X, FileCode2 } from 'lucide-react'

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', swift: 'swift', cs: 'csharp', cpp: 'cpp', c: 'cpp', h: 'cpp',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
  json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml',
  md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  php: 'php', ini: 'ini', toml: 'ini', cfg: 'ini',
}

function guessLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANG[ext] || 'plaintext'
}

export interface DiffFileEntry {
  path: string
  status: 'added' | 'modified' | 'deleted'
  before?: string
  after?: string
}

interface CheckpointDiffSheetProps {
  files: DiffFileEntry[]
  selectedIdx: number
  onSelectFile: (idx: number) => void
  onConfirmRollback: () => void
  onClose: () => void
  canRollback: boolean
}

const statusIcon: Record<string, string> = { added: '+', modified: 'M', deleted: '-' }
const statusColor: Record<string, string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-destructive',
}

const CheckpointDiffSheet: React.FC<CheckpointDiffSheetProps> = ({
  files,
  selectedIdx,
  onSelectFile,
  onConfirmRollback,
  onClose,
  canRollback,
}) => {
  const { t } = useTranslation('chat')
  // Wave 4：modal/sheet 类——切走 hot Space 时 portal 容器整体不可见且禁交互，
  // 但**组件不 unmount**——Monaco editor 实例和模型一起活下来，selectedIdx / scroll
  // 位置全部保留。切回时只解除 invisible / pointer-events-none，立即看到原视图。
  const { isForeground } = useSpaceActivity()
  useMonacoThemeSync()
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const [ready, setReady] = useState(false)

  const selectedFile = files[selectedIdx]

  // Wave 4：仅前台 Space 监听 Esc——后台 hot Space 的 sheet 即使 DOM 仍挂载
  // 也不应截获前台 Space 的 Esc。
  useEffect(() => {
    if (!isForeground) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [onClose, isForeground])

  useEffect(() => {
    configureMonacoWorkers()
    const container = containerRef.current
    if (!container) return

    const theme = getMonacoIdeThemeName()

    const diffEditor = monaco.editor.createDiffEditor(container, {
      readOnly: true,
      renderSideBySide: false,
      theme,
      fontSize: MONACO_IDE_FONT_SIZE,
      lineHeight: MONACO_IDE_LINE_HEIGHT,
      fontFamily: MONACO_IDE_FONT_FAMILY,
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      scrollbar: {
        vertical: 'auto', horizontal: 'auto',
        verticalScrollbarSize: 6, horizontalScrollbarSize: 6,
        verticalHasArrows: false, horizontalHasArrows: false,
        useShadows: false, verticalSliderSize: 4, horizontalSliderSize: 4,
      },
      overviewRulerBorder: false,
      // 与 TabCodeDiffView 对齐：关掉默认 30px Diff overview，避免与细滚动条叠成双条。
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      renderLineHighlight: 'line',
      guides: { indentation: true },
      padding: { top: 8, bottom: 8 },
      folding: false,
      lineDecorationsWidth: 8,
      originalEditable: false,
    })
    editorRef.current = diffEditor

    let rafId: number | null = null
    const ro = new ResizeObserver(() => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        diffEditor.layout()
        rafId = null
      })
    })
    ro.observe(container)

    setReady(true)

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      ro.disconnect()
      const originalModel = originalModelRef.current
      const modifiedModel = modifiedModelRef.current
      if (originalModel) originalModel.dispose()
      if (modifiedModel) modifiedModel.dispose()
      originalModelRef.current = null
      modifiedModelRef.current = null
      diffEditor.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !ready || !selectedFile) return

    const lang = guessLanguage(selectedFile.path)
    const before = selectedFile.before ?? ''
    const after = selectedFile.after ?? ''

    if (!originalModelRef.current || !modifiedModelRef.current) {
      const om = monaco.editor.createModel(before, lang)
      const mm = monaco.editor.createModel(after, lang)
      originalModelRef.current = om
      modifiedModelRef.current = mm
      editor.setModel({ original: om, modified: mm })
    } else {
      originalModelRef.current.setValue(before)
      modifiedModelRef.current.setValue(after)
      monaco.editor.setModelLanguage(originalModelRef.current, lang)
      monaco.editor.setModelLanguage(modifiedModelRef.current, lang)
    }
  }, [selectedFile, ready])

  // Wave 4：modal 类——切走 hot Space 时 portal 容器加 invisible / aria-hidden
  // / pointer-events-none 三重不可见，但**不 unmount**——Monaco editor 实例不被
  // dispose、selectedIdx / scrollTop 全部保留，切回继续看原文件原位置，免重建
  // 重新加载（300ms 白屏 + scroll 重置 = 用户感知很差）。
  // dialog 内的破坏性确认 CTA：软色面（destructive/10）是刻意比满饱和红更克制的
  // 确认态，属设计契约允许的「dialog 内小面积告警色面」例外。
  // eslint-disable-next-line tabtin/no-chat-design-violations -- dialog 破坏性确认 CTA 的克制软色面，非横幅/卡片大色块
  const confirmRollbackClass = 'h-7 px-3 rounded-interactive text-body font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:opacity-40 transition-colors'

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-above-global flex items-center justify-center p-6',
        !isForeground && 'invisible pointer-events-none',
      )}
      aria-hidden={!isForeground || undefined}
    >
      <div className="flex h-full max-h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border/40 bg-background shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40">
        <div className="flex items-center gap-2">
          <FileCode2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-body font-medium">{t('checkpoint.diffPreviewTitle')}</span>
          <span className="text-body text-muted-foreground">
            {files.length} {files.length === 1 ? t('checkpoint.diffFileSingular', 'file') : t('checkpoint.diffFilePlural', 'files')}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted/40 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body: file list + editor */}
      <div className="flex flex-1 min-h-0">
        {/* File list sidebar */}
        <div className="w-56 flex-shrink-0 border-r border-border/40 overflow-y-auto bg-muted/5">
          {files.map((f, idx) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onSelectFile(idx)}
              className={cn(
                'flex min-w-0 w-full items-center gap-2 px-3 py-1.5 text-left text-caption font-mono hover:bg-muted/30 transition-colors',
                idx === selectedIdx && 'bg-accent/10 text-accent-foreground',
              )}
            >
              <span className={cn('w-3 flex-shrink-0 text-center font-bold', statusColor[f.status])}>
                {statusIcon[f.status]}
              </span>
              <span className="min-w-0 flex-1 truncate">{f.path.split('/').pop()}</span>
            </button>
          ))}
        </div>

        {/* Monaco Diff Editor */}
        <div className="flex-1 relative min-w-0">
          {selectedFile && (
            <div className="absolute top-0 left-0 right-0 z-sticky min-w-0 truncate border-b border-border/20 bg-muted/5 px-3 py-1 font-mono text-caption text-muted-foreground/60">
              {selectedFile.path}
            </div>
          )}
          <div
            ref={containerRef}
            className="absolute inset-0 pt-6"
          />
          {(!selectedFile || (!selectedFile.before && !selectedFile.after)) && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40 text-body">
              {t('checkpoint.diffNoContent')}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border/40">
        <button
          type="button"
          onClick={onClose}
          className="h-7 px-3 rounded-md text-body text-muted-foreground hover:bg-muted/30 transition-colors"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirmRollback}
          disabled={!canRollback}
          className={confirmRollbackClass}
        >
          {t('checkpoint.confirmRollback')}
        </button>
      </div>
      </div>
    </div>,
    document.body,
  )
}

export default CheckpointDiffSheet
