/**
 * CodeEditor - Monaco based editor (VS Code like)
 */

import React, { useEffect, useLayoutEffect, useRef } from 'react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import i18n from '@/i18n'
import { configureMonacoWorkers } from '@utils/monaco-setup'
import { useMonacoThemeSync } from '@/hooks/useMonacoThemeSync'
import {
  getMonacoIdeThemeName,
  MONACO_IDE_FONT_FAMILY,
  MONACO_IDE_FONT_SIZE,
  MONACO_IDE_LINE_HEIGHT,
} from '@/utils/monaco-ide-theme'
import type { CodeSelectionData } from './codeSelection'
import type { EditorFindRequest } from './editorFindTypes'
import { EditorFindSession } from './editorFindSession'
import {
  buildGitGutterMarkers,
  type GitGutterBaseline,
} from './gitGutterDecorations'

interface CodeEditorProps {
  /** 稳定编辑器实例内的 Monaco model 身份；切换时换 model，不卸载编辑器 DOM。 */
  modelKey?: string
  value: string
  language: string
  readOnly?: boolean
  initialLine?: number
  initialLineKey?: number
  /** 可复用查找会话意图（工程搜索点结果 / 未来文件内查找） */
  findRequest?: EditorFindRequest
  onSave?: () => void
  onChange?: (value: string) => void
  className?: string
  /** 选中代码后通过快捷键发送选区（Cmd/Ctrl+Shift+L） */
  onSendSelection?: (data: CodeSelectionData) => void
  /** 选区变化回调（null 表示无选区）；含视口锚点供浮动条定位 */
  onSelectionChange?: (data: CodeSelectionData | null) => void
  /** 可选的 Git 基线；仅 TabCode 正常预览传入，其他编辑器保持无装饰。 */
  gitGutterBaseline?: GitGutterBaseline | null
  /** 额外 Monaco 编辑器选项（覆盖默认值） */
  editorOptions?: Record<string, unknown>
}

function readSelectionData(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
): CodeSelectionData | null {
  const sel = editor.getSelection()
  if (!sel || sel.isEmpty()) return null
  const text = model.getValueInRange(sel)
  if (!text) return null

  const startPos = editor.getScrolledVisiblePosition({
    lineNumber: sel.startLineNumber,
    column: sel.startColumn,
  })
  const endPos = editor.getScrolledVisiblePosition({
    lineNumber: sel.endLineNumber,
    column: sel.endColumn,
  })
  const dom = editor.getDomNode()
  let anchor: CodeSelectionData['anchor']
  if (startPos && endPos && dom) {
    const rect = dom.getBoundingClientRect()
    const top = rect.top + Math.min(startPos.top, endPos.top)
    const bottom = rect.top + Math.max(startPos.top + startPos.height, endPos.top + endPos.height)
    const left = rect.left + Math.min(startPos.left, endPos.left)
    const right = rect.left + Math.max(startPos.left, endPos.left)
    anchor = { top, bottom, centerX: (left + right) / 2 }
  }

  return {
    text,
    startLine: sel.startLineNumber,
    endLine: sel.endLineNumber,
    anchor,
  }
}

function buildEditorOptions(readOnly: boolean, editorOptions?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(readOnly && editorOptions?.domReadOnly === undefined ? { domReadOnly: true } : {}),
    ...editorOptions,
    readOnly,
  }
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  modelKey = '__default__',
  value,
  language,
  readOnly = false,
  initialLine,
  initialLineKey,
  findRequest,
  onSave,
  onChange,
  onSendSelection,
  onSelectionChange,
  gitGutterBaseline,
  className,
  editorOptions,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const activeModelKeyRef = useRef(modelKey)
  const findSessionRef = useRef<EditorFindSession | null>(null)
  const findRequestRef = useRef(findRequest)
  findRequestRef.current = findRequest
  const lastFindKeyRef = useRef<number | undefined>(undefined)
  const lastRevealedKeyRef = useRef<number | undefined>(undefined)
  const internalChangeRef = useRef(false)
  // 编辑期间不回灌外部 value（否则会 clobber 用户在途编辑：光标跳头 + undo 栈丢失）。
  // 外部变更在失焦时补齐。valuePropRef 保存最新 value prop，供失焦补齐读取。
  const isFocusedRef = useRef(false)
  const valuePropRef = useRef(value)
  valuePropRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onSendSelectionRef = useRef(onSendSelection)
  onSendSelectionRef.current = onSendSelection
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const gitGutterBaselineRef = useRef(gitGutterBaseline)
  gitGutterBaselineRef.current = gitGutterBaseline
  const gitGutterDecorationIdsRef = useRef<string[]>([])
  const gitGutterRefreshTimerRef = useRef<number | null>(null)
  const refreshGitGutterRef = useRef<() => void>(() => {})

  const clearGitGutterDecorations = useRef(() => {
    const editor = editorRef.current
    if (!editor || gitGutterDecorationIdsRef.current.length === 0) return
    gitGutterDecorationIdsRef.current = editor.deltaDecorations(
      gitGutterDecorationIdsRef.current,
      [],
    )
  })

  const scheduleGitGutterRefresh = useRef(() => {
    if (gitGutterRefreshTimerRef.current !== null) {
      window.clearTimeout(gitGutterRefreshTimerRef.current)
    }
    gitGutterRefreshTimerRef.current = window.setTimeout(() => {
      gitGutterRefreshTimerRef.current = null
      refreshGitGutterRef.current()
    }, 120)
  })

  /**
   * 把最新的外部 value 写入 model —— 用 `pushEditOperations`（可撤销的最小编辑）
   * 而非 `model.setValue()`：后者会**清空 undo 栈并把光标扔回 (1,1)**，正是快速
   * 输入时"光标跳头 + 无法撤销"的根因。仅在 model 与目标值不同时写入。
   */
  const applyExternalValue = useRef(() => {
    const model = modelRef.current
    const editor = editorRef.current
    if (!model || !editor) return
    const next = valuePropRef.current
    if (model.getValue() === next) return
    // 整模替换会错误拉伸旧 find decoration → 看起来像「全文高亮」；先清再写。
    findSessionRef.current?.clear()
    lastFindKeyRef.current = undefined
    internalChangeRef.current = true
    model.pushEditOperations(
      editor.getSelections(),
      [{ range: model.getFullModelRange(), text: next }],
      () => null,
    )
    internalChangeRef.current = false
    scheduleGitGutterRefresh.current()
    const req = findRequestRef.current
    if (req?.query?.trim() && next) {
      requestAnimationFrame(() => {
        const applied = findSessionRef.current?.apply(req)
        if (applied) {
          lastFindKeyRef.current = req.key
          if (req.preferOccurrence?.line) {
            lastRevealedKeyRef.current = req.key
          }
        }
      })
    }
  })

  // 必须早于下方 editor 创建：Monaco worker / 主题配置是实例构造前置条件。
  useLayoutEffect(() => {
    configureMonacoWorkers()
  }, [])

  // TabCode 会在标签切换或跨组移动时按文件 key 重建预览。Monaco 若等浏览器先绘出
  // 空容器再在普通 effect 中挂载，就会留下可见白帧；布局 effect 在提交后、绘制前
  // 同步完成 editor/model 挂载，让用户只看到新文件内容。
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const theme = getMonacoIdeThemeName()

    const model = monaco.editor.createModel(value, language || 'plaintext')
    activeModelKeyRef.current = modelKey
    modelRef.current = model

    const editor = monaco.editor.create(container, {
      model,
      theme,
      fontSize: MONACO_IDE_FONT_SIZE,
      lineHeight: MONACO_IDE_LINE_HEIGHT,
      fontFamily: MONACO_IDE_FONT_FAMILY,
      fontLigatures: true,
      minimap: { enabled: false },
      // 与 Diff 预览对齐：逻辑行不随窗口折行，横向滚动查看长行
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      // Ctrl+F 查找栏及其按钮 tooltip 属于 Monaco overflow widget。默认渲染在编辑器
      // 自身的 overflow 容器内，会被外层 .tabcode-editor 的 overflow-hidden 裁剪，
      // 导致 HoverService 反复重定位 → tooltip 闪动。设为 fixed 后 widget 挂到
      // document.body 定位，逃出裁剪、定位稳定，从根上打断闪动死循环。
      fixedOverflowWidgets: true,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10
      },
      ...buildEditorOptions(readOnly, editorOptions),
    })
    editorRef.current = editor
    findSessionRef.current?.dispose()
    findSessionRef.current = new EditorFindSession(editor)

    refreshGitGutterRef.current = () => {
      const activeEditor = editorRef.current
      const activeModel = modelRef.current
      const baseline = gitGutterBaselineRef.current
      if (!activeEditor || !activeModel || !baseline) {
        clearGitGutterDecorations.current()
        return
      }

      const markers = buildGitGutterMarkers(baseline.content, activeModel.getValue())
      gitGutterDecorationIdsRef.current = activeEditor.deltaDecorations(
        gitGutterDecorationIdsRef.current,
        markers.map(({ lineNumber, kind }) => ({
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            linesDecorationsClassName: `tabtin-git-gutter-${kind}`,
          },
        })),
      )
    }

    const subscription = editor.onDidChangeModelContent(() => {
      if (!internalChangeRef.current) {
        const nextValue = editor.getValue()
        onChangeRef.current?.(nextValue)
      }
      scheduleGitGutterRefresh.current()
    })

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.()
    })

    const emitSelection = () => {
      const activeModel = editor.getModel()
      onSelectionChangeRef.current?.(
        activeModel ? readSelectionData(editor, activeModel) : null,
      )
    }

    editor.addAction({
      id: 'tabtin.sendSelectionToChat',
      label: i18n.t('tabcode:preview.addSelectionToChat', {
        defaultValue: 'Add Selection to Chat',
      }),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL],
      precondition: 'editorHasSelection',
      run: () => {
        const activeModel = editor.getModel()
        const data = activeModel ? readSelectionData(editor, activeModel) : null
        if (data) onSendSelectionRef.current?.(data)
      },
    })

    const focusSub = editor.onDidFocusEditorText(() => {
      isFocusedRef.current = true
    })
    const blurSub = editor.onDidBlurEditorText(() => {
      isFocusedRef.current = false
      // 失焦后补齐编辑期间被推迟的外部变更（如 Agent 改了盘上文件）。
      applyExternalValue.current()
    })

    const selectionSub = editor.onDidChangeCursorSelection(() => {
      emitSelection()
    })
    // 滚动时更新锚点，避免浮动条悬空。
    const scrollSub = editor.onDidScrollChange(() => {
      emitSelection()
    })

    let rafId: number | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        editor.layout()
        emitSelection()
        rafId = null
      })
    })
    resizeObserver.observe(container)

    const clearDecorations = clearGitGutterDecorations.current
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (gitGutterRefreshTimerRef.current !== null) {
        window.clearTimeout(gitGutterRefreshTimerRef.current)
        gitGutterRefreshTimerRef.current = null
      }
      clearDecorations()
      subscription.dispose()
      focusSub.dispose()
      blurSub.dispose()
      selectionSub.dispose()
      scrollSub.dispose()
      resizeObserver.disconnect()
      findSessionRef.current?.dispose()
      findSessionRef.current = null
      editor.dispose()
      modelRef.current?.dispose()
      editorRef.current = null
      modelRef.current = null
    }
  }, [])

  // 文件切换只替换 Monaco model，编辑器 DOM、worker 和渲染面保持挂载。
  // model 不跨文件复用，避免撤销栈或未保存缓冲串到另一个文件。
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor || activeModelKeyRef.current === modelKey) return

    const previousModel = modelRef.current
    const nextModel = monaco.editor.createModel(value, language || 'plaintext')

    internalChangeRef.current = true
    editor.setModel(nextModel)
    internalChangeRef.current = false
    modelRef.current = nextModel
    activeModelKeyRef.current = modelKey
    editor.layout()
    previousModel?.dispose()
    scheduleGitGutterRefresh.current()
  }, [modelKey, value, language])

  useLayoutEffect(() => {
    // 编辑器聚焦（用户正在输入）时不回灌，避免 clobber 在途编辑；失焦时由
    // onDidBlurEditorText 补齐。非聚焦时用 pushEditOperations 写入以保住 undo/光标。
    if (isFocusedRef.current) return
    applyExternalValue.current()
  }, [value])

  useLayoutEffect(() => {
    if (!modelRef.current) return
    monaco.editor.setModelLanguage(modelRef.current, language || 'plaintext')
  }, [language])

  useLayoutEffect(() => {
    if (!gitGutterBaseline) {
      if (gitGutterRefreshTimerRef.current !== null) {
        window.clearTimeout(gitGutterRefreshTimerRef.current)
        gitGutterRefreshTimerRef.current = null
      }
      clearGitGutterDecorations.current()
      return
    }
    scheduleGitGutterRefresh.current()
  }, [gitGutterBaseline])

  useEffect(() => {
    if (!editorRef.current) return
    editorRef.current.updateOptions(buildEditorOptions(readOnly, editorOptions))
  }, [readOnly, editorOptions])

  // 查找会话：有 findRequest 时优先走 session（含高亮）；否则退回纯跳行。
  // key 去重 + value 依赖：内容异步到位后再 apply；用户编辑不会因 value 变化反复跳回。
  useEffect(() => {
    const session = findSessionRef.current
    const editor = editorRef.current
    if (!session || !editor) return

    if (!findRequest?.query?.trim()) {
      if (lastFindKeyRef.current != null) {
        session.clear()
        lastFindKeyRef.current = undefined
      }
      return
    }

    if (lastFindKeyRef.current === findRequest.key) return

    // 空内容：不消费 key，等异步读盘完成后再 apply
    if (!value) return

    requestAnimationFrame(() => {
      if (!findSessionRef.current || !findRequest.query.trim()) return
      if (lastFindKeyRef.current === findRequest.key) return
      const applied = findSessionRef.current.apply(findRequest)
      if (!applied) return
      lastFindKeyRef.current = findRequest.key
      // 查找已负责定位，避免随后 initialLine effect 再抢光标
      if (initialLineKey != null) {
        lastRevealedKeyRef.current = initialLineKey
      }
    })
  }, [findRequest, value, initialLineKey])

  useEffect(() => {
    // 有有效查找请求时由 session 定位，跳过纯行跳转
    if (findRequest?.query?.trim()) return
    if (!editorRef.current || !initialLine || initialLine < 1) return

    const revealKey = initialLineKey ?? initialLine
    if (lastRevealedKeyRef.current === revealKey) return
    // 空内容不消费 key，等读盘完成后再跳行（与 findRequest 同口径）
    if (!value) return

    const line = initialLine
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor || !value) return
      if (lastRevealedKeyRef.current === revealKey) return
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: 1 })
      lastRevealedKeyRef.current = revealKey
    })
  }, [initialLine, initialLineKey, value, findRequest])

  useMonacoThemeSync()

  return <div ref={containerRef} className={className} />
}

CodeEditor.displayName = 'CodeEditor'
