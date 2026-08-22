import { useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, type EditorInstance } from 'novel'
import { useTranslation } from 'react-i18next'
import { useFloating, autoUpdate, offset, flip, shift } from '@floating-ui/react'
import {
  Check,
  CheckSquare,
  Code,
  Copy,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  TextIcon,
  TextQuote,
  MessageSquarePlus,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { NodeSelection } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { turnSelectionIntoList } from './list-conversion'
import { captureBlockMenuTarget, resolveCapturedBlockMenuTarget } from './block-menu-target'

// The block the drag handle was clicked on (state.nodePos) — NOT the editor's
// current text selection. `node` is the node at nodePos; for a list/quote the
// drag handle resolves to the inner paragraph, so `types` also carries the
// ancestor chain to recognize the wrapping container.
interface ClickedBlock {
  node: ProseMirrorNode
  types: Set<string>
}

// When the clicked block sits inside one of these, the menu highlights the
// container (list / quote) rather than the inner paragraph.
const containerTypes = ['taskList', 'taskItem', 'bulletList', 'orderedList', 'blockquote']
const inContainer = (block: ClickedBlock) => containerTypes.some((t) => block.types.has(t))

interface TurnIntoItem {
  nameKey: string
  icon: LucideIcon
  command: (editor: ReturnType<typeof useEditor>['editor']) => void
  // Whether this conversion is the clicked block's current type. Judged from
  // the clicked block, not the cursor — so the checkmark tracks the block the
  // menu operates on.
  isActive: (block: ClickedBlock) => boolean
}

const turnIntoItems: TurnIntoItem[] = [
  {
    nameKey: 'node.text',
    icon: TextIcon,
    command: (editor) => editor?.chain().focus().clearNodes().run(),
    isActive: (b) => b.node.type.name === 'paragraph' && !inContainer(b),
  },
  {
    nameKey: 'node.heading1',
    icon: Heading1,
    command: (editor) =>
      editor?.chain().focus().clearNodes().toggleHeading({ level: 1 }).run(),
    isActive: (b) => b.node.type.name === 'heading' && b.node.attrs.level === 1,
  },
  {
    nameKey: 'node.heading2',
    icon: Heading2,
    command: (editor) =>
      editor?.chain().focus().clearNodes().toggleHeading({ level: 2 }).run(),
    isActive: (b) => b.node.type.name === 'heading' && b.node.attrs.level === 2,
  },
  {
    nameKey: 'node.heading3',
    icon: Heading3,
    command: (editor) =>
      editor?.chain().focus().clearNodes().toggleHeading({ level: 3 }).run(),
    isActive: (b) => b.node.type.name === 'heading' && b.node.attrs.level === 3,
  },
  {
    nameKey: 'node.todoList',
    icon: CheckSquare,
    command: (editor) => {
      if (editor) turnSelectionIntoList(editor, 'taskList')
    },
    isActive: (b) => b.types.has('taskList') || b.types.has('taskItem'),
  },
  {
    nameKey: 'node.bulletList',
    icon: List,
    command: (editor) => {
      if (editor) turnSelectionIntoList(editor, 'bulletList')
    },
    isActive: (b) => b.types.has('bulletList'),
  },
  {
    nameKey: 'node.numberedList',
    icon: ListOrdered,
    command: (editor) => {
      if (editor) turnSelectionIntoList(editor, 'orderedList')
    },
    isActive: (b) => b.types.has('orderedList'),
  },
  {
    nameKey: 'node.quote',
    icon: TextQuote,
    command: (editor) =>
      editor?.chain().focus().clearNodes().toggleBlockquote().run(),
    isActive: (b) => b.types.has('blockquote'),
  },
  {
    nameKey: 'node.code',
    icon: Code,
    command: (editor) =>
      editor?.chain().focus().clearNodes().toggleCodeBlock().run(),
    isActive: (b) => b.node.type.name === 'codeBlock',
  },
]

function resolveClickedBlock(
  editor: NonNullable<ReturnType<typeof useEditor>['editor']>,
  nodePos: number,
): ClickedBlock | null {
  const { doc } = editor.state
  if (nodePos < 0 || nodePos >= doc.content.size) return null
  const node = doc.nodeAt(nodePos)
  if (!node) return null
  const types = new Set<string>([node.type.name])
  const $pos = doc.resolve(nodePos)
  for (let depth = $pos.depth; depth >= 0; depth--) types.add($pos.node(depth).type.name)
  return { node, types }
}

export interface BlockActionMenuState {
  nodePos: number
  node: ProseMirrorNode
  // 拖拽手柄的视口坐标矩形（getBoundingClientRect 快照）。菜单以它为锚点定位，
  // 底/侧空间不足时由 floating-ui 翻转、平移，所以需要完整矩形而非单点。
  anchorRect: { top: number; left: number; bottom: number; right: number; width: number; height: number }
}

// 菜单相对手柄底边的间距 / 距视口边缘的最小留白。提取为命名常量，避免散落的魔法数字。
const MENU_GAP = 4
const VIEWPORT_PADDING = 8

// 从被点击的拖拽手柄推导块菜单状态：解析手柄对应的块位置 + 记录手柄矩形。
// 两处宿主（DocEditorViewShell 经 useDocEditorViewState、DocStandaloneEditor）此前
// 各写一份相同逻辑，这里收口为单一实现，避免坐标计算漂移。
export function resolveBlockMenuStateFromHandle(
  editor: EditorInstance,
  handle: Element,
): BlockActionMenuState | null {
  const handleRect = handle.getBoundingClientRect()
  const { doc } = editor.state
  const hasCapturedTarget = handle.hasAttribute('data-block-pos')
  const capturedTarget = captureBlockMenuTarget(handle)
  let nodePos: number

  if (hasCapturedTarget) {
    if (capturedTarget === null) return null
    const captured = resolveCapturedBlockMenuTarget(capturedTarget, doc)
    if (captured === null) return null
    nodePos = captured
  } else {
    const posInfo = editor.view.posAtCoords({
      left: handleRect.right + 1,
      top: handleRect.top + handleRect.height / 2,
    })
    if (!posInfo) return null
    const pos = posInfo.inside < 0 ? posInfo.pos : posInfo.inside
    const $pos = doc.resolve(pos)
    nodePos = $pos.depth > 0 ? $pos.before($pos.depth) : pos
  }
  if (nodePos < 0 || nodePos >= doc.content.size || !doc.nodeAt(nodePos)) return null
  return {
    nodePos,
    node: doc.nodeAt(nodePos)!,
    anchorRect: {
      top: handleRect.top,
      left: handleRect.left,
      bottom: handleRect.bottom,
      right: handleRect.right,
      width: handleRect.width,
      height: handleRect.height,
    },
  }
}

interface BlockActionMenuProps {
  state: BlockActionMenuState | null
  onClose: () => void
  /** 宿主接入评论：选中当前块后回调 */
  onComment?: (nodePos: number) => void
}

export function BlockActionMenu({ state, onClose, onComment }: BlockActionMenuProps) {
  const { editor } = useEditor()
  const { t } = useTranslation('tabdoc')
  const menuRef = useRef<HTMLDivElement>(null)

  // 用 floating-ui 统一定位：以手柄矩形为虚拟参考元素，bottom-start 起始，
  // flip 在底部空间不足时翻转到上方、shift 在左右溢出时回拉。strategy:'fixed'
  // 配合 floating-ui 的包含块计算，规避 transform 祖先导致的 fixed 偏移陷阱。
  const anchorRect = state?.anchorRect
  const virtualReference = useMemo(() => {
    if (!anchorRect) return null
    const rect: DOMRect = {
      x: anchorRect.left,
      y: anchorRect.top,
      top: anchorRect.top,
      left: anchorRect.left,
      bottom: anchorRect.bottom,
      right: anchorRect.right,
      width: anchorRect.width,
      height: anchorRect.height,
      toJSON: () => '',
    }
    return { getBoundingClientRect: () => rect }
  }, [anchorRect])

  const { refs, floatingStyles } = useFloating({
    open: !!state,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(MENU_GAP), flip({ padding: VIEWPORT_PADDING }), shift({ padding: VIEWPORT_PADDING })],
    whileElementsMounted: autoUpdate,
  })

  useEffect(() => {
    if (virtualReference) refs.setReference(virtualReference)
  }, [virtualReference, refs])

  const setFloatingRef = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node
      refs.setFloating(node)
    },
    [refs],
  )

  useEffect(() => {
    if (!state) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside, true)
    document.addEventListener('keydown', handleEscape, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true)
      document.removeEventListener('keydown', handleEscape, true)
    }
  }, [state, onClose])

  const handleTurnInto = useCallback(
    (item: TurnIntoItem) => {
      if (!editor || state == null) return
      try {
        const { doc } = editor.state
        if (state.nodePos >= 0 && state.nodePos < doc.content.size) {
          const node = doc.nodeAt(state.nodePos)
          if (node === state.node) {
            const sel = NodeSelection.create(doc, state.nodePos)
            editor.view.dispatch(editor.state.tr.setSelection(sel))
            item.command(editor)
          }
        }
        onClose()
      } catch {
        onClose()
      }
    },
    [editor, state, onClose],
  )

  const handleDelete = useCallback(() => {
    if (!editor || state == null) return
    try {
      const { doc, tr } = editor.state
      if (state.nodePos >= 0 && state.nodePos < doc.content.size) {
        const node = doc.nodeAt(state.nodePos)
        if (node === state.node) {
          editor.view.dispatch(tr.delete(state.nodePos, state.nodePos + node.nodeSize))
        }
      }
    } catch {
      // position invalid, silently fail
    }
    onClose()
  }, [editor, state, onClose])

  const handleDuplicate = useCallback(() => {
    if (!editor || state == null) return
    try {
      const { doc, tr } = editor.state
      if (state.nodePos >= 0 && state.nodePos < doc.content.size) {
        const node = doc.nodeAt(state.nodePos)
        if (node === state.node) {
          const newAttrs = { ...node.attrs }
          delete newAttrs.blockId
          delete newAttrs.id
          const newNode = node.type.create(newAttrs, node.content, node.marks)
          const insertPos = state.nodePos + node.nodeSize
          editor.view.dispatch(tr.insert(insertPos, newNode))
        }
      }
    } catch {
      // fallback: no-op
    }
    onClose()
  }, [editor, state, onClose])

  const handleComment = useCallback(() => {
    if (!editor || state == null || !onComment) return
    try {
      const { doc } = editor.state
      if (state.nodePos >= 0 && state.nodePos < doc.content.size) {
        const node = doc.nodeAt(state.nodePos)
        if (node === state.node) {
          const sel = NodeSelection.create(doc, state.nodePos)
          editor.view.dispatch(editor.state.tr.setSelection(sel))
        }
      }
      if (doc.nodeAt(state.nodePos) === state.node) onComment(state.nodePos)
    } catch {
      // position invalid
    }
    onClose()
  }, [editor, onClose, onComment, state])

  if (!state || !editor) return null

  const block = resolveClickedBlock(editor, state.nodePos)
  const activeItem = block ? turnIntoItems.find((item) => item.isActive(block)) : undefined
  // Turn-into runs clearNodes()+toggle, valid only on a text block / text
  // container. On a structural node (e.g. table) it corrupts the node —
  // prosemirror-tables then throws "reading 'eq'" from a later plugin
  // transaction, surfacing as the editor error boundary. So hide the section
  // for non-convertible blocks.
  const convertible = !!block && (block.node.type.isTextblock || !!activeItem)

  const menu = (
    <div
      ref={setFloatingRef}
      className="border-border bg-popover text-popover-foreground z-global w-52 rounded-lg border p-1.5 shadow-lg"
      style={floatingStyles}
    >
      {convertible && (
        <>
          <div className="text-muted-foreground px-2 py-1 text-body font-medium">
            {t('blockAction.turnInto', { defaultValue: '转换为' })}
          </div>
          {turnIntoItems.map((item) => (
            <button
              key={item.nameKey}
              type="button"
              onClick={() => handleTurnInto(item)}
              className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-body"
            >
              <div className="flex items-center gap-2">
                <item.icon className="h-4 w-4 shrink-0 opacity-70" />
                <span>{t(item.nameKey)}</span>
              </div>
              {activeItem?.nameKey === item.nameKey && (
                <Check className="text-primary h-3.5 w-3.5" />
              )}
            </button>
          ))}

          <div className="bg-border my-1 h-px" />
        </>
      )}

      {onComment ? (
        <button
          type="button"
          onClick={handleComment}
          data-testid="block-action-comment"
          className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body"
        >
          <MessageSquarePlus className="h-4 w-4 shrink-0 opacity-70" />
          <span>{t('blockAction.comment', { defaultValue: '添加评论' })}</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={handleDuplicate}
        className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body"
      >
        <Copy className="h-4 w-4 shrink-0 opacity-70" />
        <span>{t('blockAction.duplicate', { defaultValue: '复制块' })}</span>
      </button>
      <button
        type="button"
        onClick={handleDelete}
        className="hover:bg-destructive/10 text-destructive flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body"
      >
        <Trash2 className="h-4 w-4 shrink-0" />
        <span>{t('blockAction.delete', { defaultValue: '删除块' })}</span>
      </button>
    </div>
  )

  return createPortal(menu, document.body)
}
