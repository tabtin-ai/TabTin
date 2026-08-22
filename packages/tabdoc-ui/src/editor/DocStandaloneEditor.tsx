/**
 * DocStandaloneEditor — 宿主无关的可编辑文档编辑器
 *
 * 服务于「公开分享 edit 权限 / 可编辑预览」等没有完整宿主 runtime 的场景，
 * 复用应用内编辑器的同一套块编辑交互，使分享可编辑页与应用内体验一致：
 * - 左侧拖拽手柄（GlobalDragHandle）+ 点击弹出的「转换为 / 复制 / 删除」块菜单（BlockActionMenu）
 * - `/` slash 命令菜单（createSlashCommand，剔除需宿主 runtime 的 database / embedTable 及无上传通道的 image）
 * - 选中文本的气泡格式菜单（DocBubbleMenu + 选择器）
 *
 * 与应用内 DocEditorViewShell 的区别：不依赖 useAppHostClient / 协作 ydoc / 保存状态机，
 * 嵌入块沿用 standaloneEditableExtensions 的占位渲染（不挂 React NodeView）。
 * 内容更新通过 onUpdate 回调上抛，保存由调用方（如 SharedDocPage）负责。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { markdownToPmJson, normalizeMathPmJson } from '@tabtin/doc-editor'
import {
  Separator,
} from '@tabtin/smartsheet-ui'
import {
  EditorCommand,
  EditorCommandEmpty,
  EditorCommandItem,
  EditorCommandList,
  EditorContent,
  EditorRoot,
  handleCommandNavigation,
  type EditorInstance,
} from 'novel'
import {
  TABDOC_DRAG_HANDLE_ID_ATTR,
  createEmptyDocumentPlaceholder,
  createStandaloneEditableExtensions,
  createTabDocDragHandleId,
  getTabDocDragHandleSelector,
} from './extensions'
import {
  TABDOC_SLASH_COMMAND_MENU_CLASS,
  createSlashCommand,
  getSuggestionItems,
  type SlashItemKey,
} from './slash-command'
import { BlockActionMenu, resolveBlockMenuStateFromHandle, type BlockActionMenuState } from './block-action-menu'
import { TableChromeOverlay } from './table-chrome/TableChromeOverlay'
import { TableSelectionDeleteButton } from './table-chrome/TableSelectionDeleteButton'
import { DocBubbleMenu } from './bubble-menu'
import { NodeSelector } from './selectors/node-selector'
import { TextButtons } from './selectors/text-buttons'
import { ColorSelector } from './selectors/color-selector'
import { LinkSelector } from './selectors/link-selector'
import { MathSelector } from './selectors/math-selector'
import { MathFormulaDialog } from './MathFormulaDialog'
import { resolveMathNodeAtEvent } from './resolve-math-node-at-event'

const EMPTY_DOC: Record<string, unknown> = { type: 'doc', content: [] }

// 公开分享 edit 页不具备宿主 runtime / 上传通道，剔除这些 slash 项。
const STANDALONE_SLASH_EXCLUDE: SlashItemKey[] = ['database', 'embedTable', 'image']

function TabDocDragHandleHost({ id }: { id: string }) {
  if (typeof document === 'undefined' || !document.body) return null
  return createPortal(
    <div {...{ [TABDOC_DRAG_HANDLE_ID_ATTR]: id }} />,
    document.body,
  )
}

export interface DocStandaloneEditorProps {
  /** ProseMirror / TipTap JSON（首选，保证与编辑器一致） */
  contentJson?: Record<string, unknown> | null
  /** 退路：仅有 markdown 时转换渲染 */
  contentMarkdown?: string | null
  /** 内容更新回调（用于自动保存） */
  onUpdate?: (editor: EditorInstance) => void
  /** 编辑器内容容器 className */
  className?: string
}

export function DocStandaloneEditor({
  contentJson,
  contentMarkdown,
  onUpdate,
  className,
}: DocStandaloneEditorProps) {
  const { t: rawT } = useTranslation('tabdoc')
  const t = useCallback(
    (key: string, opts?: Record<string, unknown>) => rawT(key, opts) as string,
    [rawT],
  )

  const editorInstanceRef = useRef<EditorInstance | null>(null)
  const dragHandleIdRef = useRef<string>(createTabDocDragHandleId())
  const [blockMenuState, setBlockMenuState] = useState<BlockActionMenuState | null>(null)
  const blockMenuClosedRef = useRef<{ nodePos: number; time: number } | null>(null)

  const [openNode, setOpenNode] = useState(false)
  const [openColor, setOpenColor] = useState(false)
  const [openLink, setOpenLink] = useState(false)

  const [showMathDialog, setShowMathDialog] = useState(false)
  const [mathDialogLatex, setMathDialogLatex] = useState('')
  const [mathDialogEditPos, setMathDialogEditPos] = useState<number | null>(null)

  const openMathDialog = useCallback((initial?: { latex?: string; editPos?: number | null }) => {
    setMathDialogLatex(initial?.latex ?? '')
    setMathDialogEditPos(initial?.editPos ?? null)
    setShowMathDialog(true)
  }, [])

  const handleMathDialogOpenChange = useCallback((open: boolean) => {
    setShowMathDialog(open)
    if (!open) {
      setMathDialogLatex('')
      setMathDialogEditPos(null)
    }
  }, [])

  const content = useMemo<Record<string, unknown>>(() => {
    if (
      contentJson &&
      typeof contentJson === 'object' &&
      Object.keys(contentJson).length > 0
    ) {
      return normalizeMathPmJson(contentJson)
    }
    if (contentMarkdown && contentMarkdown.trim().length > 0) {
      try {
        return normalizeMathPmJson(
          markdownToPmJson(contentMarkdown) as Record<string, unknown>,
        )
      } catch {
        return EMPTY_DOC
      }
    }
    return EMPTY_DOC
  }, [contentJson, contentMarkdown])

  const suggestionItems = useMemo(
    () => getSuggestionItems(t, undefined, {
      onRequestMathFormula: () => openMathDialog(),
    }, { exclude: STANDALONE_SLASH_EXCLUDE }),
    [openMathDialog, t],
  )

  const editorExtensions = useMemo(() => {
    const dragHandleId = dragHandleIdRef.current
    const dragHandleSelector = getTabDocDragHandleSelector(dragHandleId)
    const slash = createSlashCommand(t, undefined, {
      onRequestMathFormula: () => openMathDialog(),
    }, { exclude: STANDALONE_SLASH_EXCLUDE })
    return [
      createEmptyDocumentPlaceholder(t),
      ...createStandaloneEditableExtensions({ dragHandleSelector }),
      slash,
    ]
  }, [openMathDialog, t])

  const editorProps = useMemo(
    () => ({
      editable: () => true,
      handleClick: (_view: unknown, _pos: number, event: MouseEvent): boolean => {
        const editor = editorInstanceRef.current
        if (!editor?.isEditable) return false
        const mathNode = resolveMathNodeAtEvent(editor, event)
        if (!mathNode) return false
        openMathDialog({ latex: mathNode.latex, editPos: mathNode.pos })
        return true
      },
      handleDOMEvents: {
        keydown: (_view: unknown, event: KeyboardEvent) => handleCommandNavigation(event),
      },
    }),
    [openMathDialog],
  )

  // ── 拖拽手柄 → 块操作菜单（与 useDocEditorViewState 同款逻辑，去掉聊天拖拽） ──
  const handleDragHandleClick = useCallback((e: MouseEvent) => {
    const target = e.target as Element
    if (!target) return
    const handle = target.closest(getTabDocDragHandleSelector(dragHandleIdRef.current))
    if (!handle) return
    const interactiveAncestor = target.closest('button, a, input, [role="button"], [role="menuitem"]')
    if (interactiveAncestor && interactiveAncestor !== handle && handle.contains(interactiveAncestor)) return
    const editor = editorInstanceRef.current
    if (!editor?.view) return
    e.preventDefault()
    e.stopPropagation()
    const next = resolveBlockMenuStateFromHandle(editor, handle)
    if (!next) return
    const closedRecently = blockMenuClosedRef.current
    if (closedRecently && closedRecently.nodePos === next.nodePos && Date.now() - closedRecently.time < 300) return
    setBlockMenuState(next)
  }, [])

  const handleBlockMenuClose = useCallback(() => {
    setBlockMenuState((prev) => {
      if (prev) blockMenuClosedRef.current = { nodePos: prev.nodePos, time: Date.now() }
      return null
    })
  }, [])

  useEffect(() => {
    document.addEventListener('click', handleDragHandleClick)
    return () => document.removeEventListener('click', handleDragHandleClick)
  }, [handleDragHandleClick])

  const handleMathConfirm = useCallback((latex: string) => {
    const editor = editorInstanceRef.current
    const next = latex.trim()
    if (!editor || !next) {
      handleMathDialogOpenChange(false)
      return
    }

    if (mathDialogEditPos != null) {
      const pos = mathDialogEditPos
      const node = editor.state.doc.nodeAt(pos)
      const mathNames = new Set(['mathematics', 'mathematicsBlock', 'math'])
      if (node && mathNames.has(node.type.name)) {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: next })
            return true
          })
          .run()
      } else {
        editor.chain().focus().setLatex({ latex: next }).run()
      }
    } else {
      editor.chain().focus().setLatex({ latex: next }).run()
    }

    handleMathDialogOpenChange(false)
  }, [handleMathDialogOpenChange, mathDialogEditPos])

  return (
    <>
      <TabDocDragHandleHost id={dragHandleIdRef.current} />
      <EditorRoot>
        <EditorContent
          immediatelyRender={false}
          initialContent={content as never}
          extensions={editorExtensions}
          editorProps={editorProps}
          className={className ?? 'relative w-full'}
          onCreate={({ editor }: { editor: EditorInstance }) => {
            editorInstanceRef.current = editor
          }}
          onUpdate={onUpdate ? ({ editor }: { editor: EditorInstance }) => onUpdate(editor) : undefined}
        >
          <EditorCommand className={TABDOC_SLASH_COMMAND_MENU_CLASS}>
            <EditorCommandEmpty className="text-muted-foreground px-2">{t('slashNoResults')}</EditorCommandEmpty>
            <EditorCommandList>
              {suggestionItems.map((item) => (
                <EditorCommandItem
                  value={item.title}
                  onCommand={(val) => item.command?.(val as never)}
                  className="hover:bg-accent aria-selected:bg-accent flex w-full items-center space-x-2 rounded-md px-2 py-1 text-left text-body"
                  key={item.title}
                >
                  <div className="border-muted bg-background flex h-10 w-10 items-center justify-center rounded-md border">{item.icon}</div>
                  <div>
                    <p className="font-medium">{item.title}</p>
                    <p className="text-muted-foreground text-body">{item.description}</p>
                  </div>
                </EditorCommandItem>
              ))}
            </EditorCommandList>
          </EditorCommand>

          <DocBubbleMenu
            open={openNode || openColor || openLink}
            onOpenChange={(isOpen) => { if (!isOpen) { setOpenNode(false); setOpenColor(false); setOpenLink(false) } }}
          >
            <Separator orientation="vertical" />
            <NodeSelector open={openNode} onOpenChange={setOpenNode} />
            <Separator orientation="vertical" />
            <TextButtons />
            <Separator orientation="vertical" />
            <ColorSelector open={openColor} onOpenChange={setOpenColor} />
            <Separator orientation="vertical" />
            <LinkSelector open={openLink} onOpenChange={setOpenLink} />
            <Separator orientation="vertical" />
            <MathSelector />
            <TableSelectionDeleteButton />
          </DocBubbleMenu>

          <BlockActionMenu state={blockMenuState} onClose={handleBlockMenuClose} />
          <TableChromeOverlay />
        </EditorContent>
      </EditorRoot>

      <MathFormulaDialog
        open={showMathDialog}
        initialLatex={mathDialogLatex}
        title={t(
          mathDialogEditPos != null ? 'slash.mathEditPrompt' : 'slash.mathPrompt',
          { defaultValue: mathDialogEditPos != null ? 'Edit math formula' : 'Insert math formula' },
        )}
        placeholder={t('slash.mathPlaceholder', { defaultValue: 'Enter LaTeX, e.g. E = mc^2' })}
        previewLabel={t('slash.mathPreview', { defaultValue: 'Preview' })}
        previewEmpty={t('slash.mathPreviewEmpty', { defaultValue: 'Preview appears as you type' })}
        hint={t('slash.mathHint', { defaultValue: 'Ctrl/⌘ + Enter or Esc to insert' })}
        cancelLabel={t('cancel')}
        confirmLabel={t('confirm')}
        onOpenChange={handleMathDialogOpenChange}
        onConfirm={handleMathConfirm}
      />
    </>
  )
}
