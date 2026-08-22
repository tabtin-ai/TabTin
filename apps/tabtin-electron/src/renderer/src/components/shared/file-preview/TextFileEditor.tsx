/**
 * TextFileEditor - 文本文件 Monaco 编辑 / 只读预览（Folder、TabCode 共用）
 *
 * 只读与可编辑共用同一处 CodeEditor 挂载；差异仅在提示条、保存缓冲与
 * Monaco options。跳行（initialLine）契约因此只有一条路径，避免双路径漏传。
 */

import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { getBaseName, getMonacoLanguage } from '@components/shared/file-utils'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import { createLogger } from '@/utils/logger'
import type { CodeSelectionData } from './codeSelection'
import type { EditorFindRequest } from './editorFindTypes'
import type { GitGutterBaseline } from './gitGutterDecorations'

const log = createLogger('TextFileEditor')

const CodeEditor = lazy(() =>
  import('@components/shared/file-preview/CodeEditor').then(m => ({ default: m.CodeEditor }))
)

const BASE_EDITOR_OPTIONS: Record<string, unknown> = {
  scrollbar: {
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
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  renderLineHighlight: 'line',
  guides: { indentation: true },
  padding: { top: 12, bottom: 12 },
  lineDecorationsWidth: 8,
  lineNumbersMinChars: 3,
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface TextEditorState {
  dirty: boolean
  status: SaveStatus
  saveError: string | null
  save: () => Promise<boolean>
}

export interface TextFileEditorLabels {
  truncatedPreview: string
  largePreviewHint: string
  saveFailed: string
}

export interface TextFileEditorProps {
  /** 用于 editor key 与默认 save 路径 */
  filePath?: string
  /** 语言检测用文件名；缺省时从 filePath 取 basename */
  fileName?: string
  content: string
  readOnly?: boolean
  truncated?: boolean
  labels?: TextFileEditorLabels
  /** 保存目标路径；缺省时用 filePath */
  savePath?: string
  onStateChange?: (state: TextEditorState) => void
  onSaveSuccess?: () => void | Promise<void>
  initialLine?: number
  initialLineKey?: number
  findRequest?: EditorFindRequest
  onChange?: (value: string) => void
  onSendSelection?: (data: CodeSelectionData) => void
  onSelectionChange?: (data: CodeSelectionData | null) => void
  /** 可选的 Git 基线；默认不显示任何 gutter 变更标记。 */
  gitGutterBaseline?: GitGutterBaseline | null
  editorOptions?: Record<string, unknown>
  className?: string
  /** TabCode 分屏切换时复用 Monaco 容器；普通预览保持按文件重建。 */
  preserveEditorOnFileChange?: boolean
}

const EditorLoading: React.FC = () => (
  <div className="flex items-center justify-center h-full">
    <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
  </div>
)

const READ_ONLY_PREVIEW_HINT = '只读预览，可选中复制内容'

const TruncatedTextPreview: React.FC<{ content: string; truncatedHint: string }> = ({
  content,
  truncatedHint,
}) => (
  <ScrollArea className="h-full">
    <pre className="text-body font-mono whitespace-pre-wrap break-words p-3 leading-relaxed text-foreground/80">
      {content}
    </pre>
    <div className="sticky bottom-0 bg-gradient-to-t from-background to-transparent p-3 text-center">
      <span className="text-caption text-muted-foreground/60 bg-muted/40 px-2 py-0.5 rounded-full">
        {truncatedHint}
      </span>
    </div>
  </ScrollArea>
)

/**
 * 可编辑缓冲：本地 value/dirty + 防抖上游 onChange + 保存。
 * 只读模式不挂此 hook（由外层分支保证）。
 */
function useEditableBuffer({
  editorKey,
  content,
  savePath,
  saveFailedLabel,
  onStateChange,
  onSaveSuccess,
  onChange,
}: {
  editorKey: string
  content: string
  savePath: string
  saveFailedLabel: string
  onStateChange?: (state: TextEditorState) => void
  onSaveSuccess?: () => void | Promise<void>
  onChange?: (value: string) => void
}) {
  const [value, setValue] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const resetTimerRef = useRef<number | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const prevEditorKeyRef = useRef(editorKey)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // 向上冒泡的 onChange 防抖 250ms，减少父组件 setState 抖动；本地 value/dirty
  // 仍同步更新，保存走 valueRef，始终拿最新内容。
  const upstreamTimerRef = useRef<number | null>(null)
  const pendingUpstreamRef = useRef<string | null>(null)
  // 文件 key 变化的首次 render 直接把新文件内容传给子编辑器。父级 layout
  // effect 晚于子级执行，若仍返回旧 state，目标 model 会先装入上一文件内容，
  // 污染 undo 栈后再被二次覆盖。
  const renderedValue = prevEditorKeyRef.current === editorKey ? value : content

  const cancelUpstream = useCallback(() => {
    if (upstreamTimerRef.current != null) {
      window.clearTimeout(upstreamTimerRef.current)
      upstreamTimerRef.current = null
    }
    pendingUpstreamRef.current = null
  }, [])

  const scheduleUpstream = useCallback((next: string) => {
    pendingUpstreamRef.current = next
    if (upstreamTimerRef.current != null) window.clearTimeout(upstreamTimerRef.current)
    upstreamTimerRef.current = window.setTimeout(() => {
      upstreamTimerRef.current = null
      const v = pendingUpstreamRef.current
      pendingUpstreamRef.current = null
      if (v != null) onChangeRef.current?.(v)
    }, 250)
  }, [])

  // 文件切换必须在浏览器绘制前切换本地缓冲，否则稳定 Monaco 会短暂显示上一文件。
  useLayoutEffect(() => {
    const keyChanged = prevEditorKeyRef.current !== editorKey
    prevEditorKeyRef.current = editorKey
    // 文件切换（editorKey 变）→ 总是重置。同一文件时，content 若等于当前 value 说明
    // 是自己编辑被父组件回灌回来的，直接跳过——否则会把 dirty/status 误重置，并触发
    // 一次无谓的 model 重写（正是光标跳头 + undo 丢失的诱因之一）。
    if (!keyChanged && content === valueRef.current) return
    cancelUpstream()
    setValue(content)
    setDirty(false)
    setStatus('idle')
    setSaveError(null)
  }, [content, editorKey, cancelUpstream])

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current)
      }
      if (upstreamTimerRef.current != null) {
        window.clearTimeout(upstreamTimerRef.current)
      }
    }
  }, [])

  const handleSave = useCallback(async (): Promise<boolean> => {
    setStatus('saving')
    setSaveError(null)
    try {
      const result = await window.tabtin.fileSystem.writeFile(savePath, valueRef.current)
      if (result?.success === false) {
        throw new Error(result.error || saveFailedLabel)
      }
      try {
        void Promise.resolve(onSaveSuccess?.()).catch((error) => {
          log.warn('保存后回调执行失败', error)
        })
      } catch (error) {
        log.warn('保存后回调执行失败', error)
      }
      setDirty(false)
      setStatus('saved')
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current)
      }
      resetTimerRef.current = window.setTimeout(() => {
        setStatus('idle')
      }, 1200)
      return true
    } catch (err) {
      setStatus('error')
      setSaveError(formatIpcErrorForUser(err, saveFailedLabel))
      return false
    }
  }, [savePath, saveFailedLabel, onSaveSuccess])

  useEffect(() => {
    onStateChange?.({ dirty, status, saveError, save: handleSave })
  }, [dirty, status, saveError, handleSave, onStateChange])

  const handleChange = useCallback(
    (nextValue: string) => {
      setValue(nextValue)
      setDirty(true)
      setStatus((prev) => (prev !== 'idle' ? 'idle' : prev))
      scheduleUpstream(nextValue)
    },
    [scheduleUpstream],
  )

  return { value: renderedValue, saveError, handleSave, handleChange }
}

interface MonacoHostProps {
  editorKey: string
  value: string
  language: string
  readOnly: boolean
  initialLine?: number
  initialLineKey?: number
  findRequest?: EditorFindRequest
  onSave?: () => void
  onChange?: (value: string) => void
  onSendSelection?: TextFileEditorProps['onSendSelection']
  onSelectionChange?: TextFileEditorProps['onSelectionChange']
  gitGutterBaseline?: GitGutterBaseline | null
  editorOptions?: Record<string, unknown>
  className?: string
  preserveEditorOnFileChange?: boolean
}

/** 唯一 Monaco 挂载点：只读 / 可编辑都走这里，跳行与查找 props 不会分叉丢失。 */
const MonacoHost: React.FC<MonacoHostProps> = ({
  editorKey,
  value,
  language,
  readOnly,
  initialLine,
  initialLineKey,
  findRequest,
  onSave,
  onChange,
  onSendSelection,
  onSelectionChange,
  gitGutterBaseline,
  editorOptions,
  className,
  preserveEditorOnFileChange = false,
}) => {
  const editorClassName = readOnly
    ? className
      ? `${className} readonly-preview-editor`
      : 'h-full w-full readonly-preview-editor'
    : (className ?? 'h-full w-full')

  return (
    <Suspense fallback={<EditorLoading />}>
      <CodeEditor
        key={preserveEditorOnFileChange ? undefined : editorKey}
        modelKey={editorKey}
        value={value}
        language={language}
        readOnly={readOnly}
        className={editorClassName}
        initialLine={initialLine}
        initialLineKey={initialLineKey}
        findRequest={findRequest}
        onSave={onSave}
        onChange={onChange}
        onSendSelection={onSendSelection}
        onSelectionChange={onSelectionChange}
        gitGutterBaseline={gitGutterBaseline}
        editorOptions={
          readOnly
            ? {
                ...BASE_EDITOR_OPTIONS,
                folding: false,
                domReadOnly: true,
                readOnlyMessage: { value: '' },
                ...editorOptions,
              }
            : { ...BASE_EDITOR_OPTIONS, ...editorOptions }
        }
      />
    </Suspense>
  )
}

const ReadOnlyPane: React.FC<{
  editorKey: string
  content: string
  language: string
  initialLine?: number
  initialLineKey?: number
  findRequest?: EditorFindRequest
  onSendSelection?: TextFileEditorProps['onSendSelection']
  onSelectionChange?: TextFileEditorProps['onSelectionChange']
  gitGutterBaseline?: GitGutterBaseline | null
  editorOptions?: Record<string, unknown>
  className?: string
  preserveEditorOnFileChange?: boolean
}> = (props) => (
  <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-3 py-1 text-caption text-destructive/80">
      {READ_ONLY_PREVIEW_HINT}
    </div>
    <div className="min-h-0 flex-1">
      <MonacoHost
        editorKey={props.editorKey}
        value={props.content}
        language={props.language}
        readOnly
        initialLine={props.initialLine}
        initialLineKey={props.initialLineKey}
        findRequest={props.findRequest}
        onSendSelection={props.onSendSelection}
        onSelectionChange={props.onSelectionChange}
        gitGutterBaseline={props.gitGutterBaseline}
        editorOptions={props.editorOptions}
        className={props.className}
        preserveEditorOnFileChange={props.preserveEditorOnFileChange}
      />
    </div>
  </div>
)

const EditablePane: React.FC<{
  editorKey: string
  content: string
  language: string
  savePath: string
  saveFailedLabel: string
  initialLine?: number
  initialLineKey?: number
  findRequest?: EditorFindRequest
  onStateChange?: (state: TextEditorState) => void
  onSaveSuccess?: () => void | Promise<void>
  onChange?: (value: string) => void
  onSendSelection?: TextFileEditorProps['onSendSelection']
  onSelectionChange?: TextFileEditorProps['onSelectionChange']
  gitGutterBaseline?: GitGutterBaseline | null
  editorOptions?: Record<string, unknown>
  className?: string
  preserveEditorOnFileChange?: boolean
}> = ({
  editorKey,
  content,
  language,
  savePath,
  saveFailedLabel,
  initialLine,
  initialLineKey,
  findRequest,
  onStateChange,
  onSaveSuccess,
  onChange,
  onSendSelection,
  onSelectionChange,
  gitGutterBaseline,
  editorOptions,
  className,
  preserveEditorOnFileChange,
}) => {
  const { value, saveError, handleSave, handleChange } = useEditableBuffer({
    editorKey,
    content,
    savePath,
    saveFailedLabel,
    onStateChange,
    onSaveSuccess,
    onChange,
  })

  return (
    <div className="h-full flex flex-col">
      {saveError && (
        <div className="px-3 py-1 text-caption text-destructive/80 bg-destructive/5">
          {saveError}
        </div>
      )}
      <div className="tabcode-editor flex-1 min-h-0">
        <MonacoHost
          editorKey={editorKey}
          value={value}
          language={language}
          readOnly={false}
          initialLine={initialLine}
          initialLineKey={initialLineKey}
          findRequest={findRequest}
          onSave={handleSave}
          onChange={handleChange}
          onSendSelection={onSendSelection}
          onSelectionChange={onSelectionChange}
          gitGutterBaseline={gitGutterBaseline}
          editorOptions={editorOptions}
          className={className}
          preserveEditorOnFileChange={preserveEditorOnFileChange}
        />
      </div>
    </div>
  )
}

export const TextFileEditor: React.FC<TextFileEditorProps> = ({
  filePath,
  fileName,
  content,
  readOnly = false,
  truncated,
  labels,
  savePath,
  onStateChange,
  onSaveSuccess,
  initialLine,
  initialLineKey,
  findRequest,
  onChange,
  onSendSelection,
  onSelectionChange,
  gitGutterBaseline,
  editorOptions,
  className,
  preserveEditorOnFileChange,
}) => {
  const resolvedFileName = fileName ?? (filePath ? getBaseName(filePath) : '')
  const language = getMonacoLanguage(resolvedFileName)
  const editorKey = filePath ?? resolvedFileName

  if (truncated) {
    return (
      <div className="h-full flex flex-col">
        {labels?.truncatedPreview && (
          <div className="px-3 py-1 text-caption text-warning/80 bg-warning/5">
            {labels.truncatedPreview}
          </div>
        )}
        <TruncatedTextPreview
          content={content}
          truncatedHint={labels?.largePreviewHint ?? ''}
        />
      </div>
    )
  }

  if (readOnly) {
    return (
      <ReadOnlyPane
        editorKey={editorKey}
        content={content}
        language={language}
        initialLine={initialLine}
        initialLineKey={initialLineKey}
        findRequest={findRequest}
        onSendSelection={onSendSelection}
        onSelectionChange={onSelectionChange}
        gitGutterBaseline={gitGutterBaseline}
        editorOptions={editorOptions}
        className={className}
        preserveEditorOnFileChange={preserveEditorOnFileChange}
      />
    )
  }

  const resolvedSavePath = savePath ?? filePath
  if (!resolvedSavePath) {
    return null
  }

  return (
    <EditablePane
      editorKey={editorKey}
      content={content}
      language={language}
      savePath={resolvedSavePath}
      saveFailedLabel={labels?.saveFailed ?? 'Save failed'}
      initialLine={initialLine}
      initialLineKey={initialLineKey}
      findRequest={findRequest}
      onStateChange={onStateChange}
      onSaveSuccess={onSaveSuccess}
      onChange={onChange}
      onSendSelection={onSendSelection}
      onSelectionChange={onSelectionChange}
      gitGutterBaseline={gitGutterBaseline}
      editorOptions={editorOptions}
      className={className}
      preserveEditorOnFileChange={preserveEditorOnFileChange}
    />
  )
}

TextFileEditor.displayName = 'TextFileEditor'
