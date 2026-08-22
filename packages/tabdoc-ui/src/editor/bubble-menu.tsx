import { EditorBubble, removeAIHighlight, useEditor } from 'novel'
import { BubbleMenu as TiptapBubbleMenu } from '@tiptap/react'
import {
  Fragment,
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from 'react'
import { isNodeSelection } from '@tiptap/core'
import { OVERLAY_SURFACE_CLASS, cn } from '@tabtin/smartsheet-ui'
import { TABDOC_FLOATING_MENU_SURFACE_CLASS } from './floating-menu-surface'
import { isImageNodeSelection } from './image-selection-menu'

const BUBBLE_MENU_SAFE_INSET = 8
const KEYBOARD_SELECTION_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
])

type EditorBubbleTippyOptions = NonNullable<ComponentProps<typeof EditorBubble>['tippyOptions']>
type EditorBubbleTippyInstance = Parameters<NonNullable<EditorBubbleTippyOptions['onShow']>>[0]
type EditorBubbleShouldShow = NonNullable<ComponentProps<typeof EditorBubble>['shouldShow']>

interface DocBubbleMenuProps {
  children: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  boundaryRef?: RefObject<HTMLElement | null>
}

interface DocImageBubbleMenuProps {
  children: ReactNode
  boundaryRef?: RefObject<HTMLElement | null>
}

function getBubbleMenuBoundary(
  boundaryRef: RefObject<HTMLElement | null> | undefined,
  editorElement: Element | null | undefined,
): HTMLElement | null {
  return (
    boundaryRef?.current ??
    (editorElement?.closest('[data-tabdoc-bubble-boundary]') as HTMLElement | null)
  )
}

function constrainBubbleMenuToBoundary(
  instance: EditorBubbleTippyInstance,
  boundary: HTMLElement,
) {
  const currentPopperOptions = instance.props.popperOptions
  const modifiers = currentPopperOptions?.modifiers ?? []
  const maxWidth = Math.max(0, boundary.clientWidth - BUBBLE_MENU_SAFE_INSET * 2)

  instance.setProps({
    maxWidth,
    popperOptions: {
      ...currentPopperOptions,
      modifiers: [
        ...modifiers.filter(modifier => modifier.name !== 'preventOverflow'),
        {
          name: 'preventOverflow',
          options: {
            boundary,
            padding: BUBBLE_MENU_SAFE_INSET,
          },
        },
      ],
    },
  })
  void instance.popperInstance?.update()
}

/**
 * Bubble menu for the doc editor.
 * Renders selector children (NodeSelector, TextButtons, ColorSelector, LinkSelector)
 * inside a floating bubble that appears on text selection.
 */
export const DocBubbleMenu = ({
  children,
  open,
  onOpenChange,
  boundaryRef,
}: DocBubbleMenuProps) => {
  const { editor } = useEditor()
  const tippyInstanceRef = useRef<EditorBubbleTippyInstance | null>(null)
  // A secondary click can synthesize a range on macOS. Preserve whether the
  // user already had a selection before the browser applies that default.
  const secondaryClickStartedRef = useRef(false)
  const suppressContextMenuSelectionRef = useRef(false)

  useEffect(() => {
    if (!editor) return
    const editorElement = editor.view.dom

    const handleMouseDown = (event: MouseEvent) => {
      const isSecondaryClick =
        event.button === 2 || (event.button === 0 && event.ctrlKey)
      if (!isSecondaryClick) {
        secondaryClickStartedRef.current = false
        suppressContextMenuSelectionRef.current = false
        return
      }

      secondaryClickStartedRef.current = true
      suppressContextMenuSelectionRef.current = editor.state.selection.empty
    }
    const handleContextMenu = () => {
      if (!secondaryClickStartedRef.current) {
        suppressContextMenuSelectionRef.current = editor.state.selection.empty
      }
      secondaryClickStartedRef.current = false
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const opensContextMenu =
        event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
      if (opensContextMenu) {
        secondaryClickStartedRef.current = true
        suppressContextMenuSelectionRef.current = editor.state.selection.empty
        return
      }

      secondaryClickStartedRef.current = false
      const startsKeyboardSelection =
        (event.shiftKey && KEYBOARD_SELECTION_KEYS.has(event.key)) ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a')
      if (startsKeyboardSelection) suppressContextMenuSelectionRef.current = false
    }

    editorElement.addEventListener('mousedown', handleMouseDown, true)
    editorElement.addEventListener('contextmenu', handleContextMenu, true)
    editorElement.addEventListener('keydown', handleKeyDown, true)

    return () => {
      editorElement.removeEventListener('mousedown', handleMouseDown, true)
      editorElement.removeEventListener('contextmenu', handleContextMenu, true)
      editorElement.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [editor])

  const shouldShow = useCallback<EditorBubbleShouldShow>(
    ({ editor: activeEditor, state }) => {
      const { selection } = state
      if (
        !activeEditor.isEditable ||
        activeEditor.isActive('image') ||
        isNodeSelection(selection)
      ) {
        return false
      }

      return (
        open || (!selection.empty && !suppressContextMenuSelectionRef.current)
      )
    },
    [open],
  )

  useEffect(() => {
    if (!open && editor) removeAIHighlight(editor)
  }, [open, editor])

  useEffect(() => {
    const boundary = getBubbleMenuBoundary(boundaryRef, editor?.view.dom)
    if (!boundary || typeof ResizeObserver === 'undefined') return

    const updateConstraint = () => {
      if (tippyInstanceRef.current) {
        constrainBubbleMenuToBoundary(tippyInstanceRef.current, boundary)
      }
    }
    const resizeObserver = new ResizeObserver(updateConstraint)
    resizeObserver.observe(boundary)
    updateConstraint()

    return () => resizeObserver.disconnect()
  }, [boundaryRef, editor])

  if (!editor) return null

  return (
    <EditorBubble
      shouldShow={shouldShow}
      tippyOptions={{
        // Keep the toolbar above the selection even when nested popovers open.
        // Switching placement on `open` caused the whole bar to jump below the text.
        placement: 'top',
        offset: [0, 10],
        // Keep React's delegated events connected while Tippy re-parents the toolbar.
        appendTo: () =>
          getBubbleMenuBoundary(boundaryRef, editor.view.dom) ?? document.body,
        onShow: instance => {
          tippyInstanceRef.current = instance
          const boundary = getBubbleMenuBoundary(boundaryRef, editor.view.dom)
          if (boundary) constrainBubbleMenuToBoundary(instance, boundary)
        },
        onDestroy: instance => {
          if (tippyInstanceRef.current === instance) tippyInstanceRef.current = null
        },
        onHidden: () => {
          onOpenChange(false)
          editor.chain().unsetHighlight().run()
        },
      }}
      className={cn(
        TABDOC_FLOATING_MENU_SURFACE_CLASS,
        'tabdoc-bubble-menu z-dropdown flex w-fit max-w-full flex-wrap overflow-visible rounded-md',
        OVERLAY_SURFACE_CLASS,
      )}
    >
      <Fragment>{children}</Fragment>
    </EditorBubble>
  )
}

/**
 * 图片使用 NodeSelection，而 novel 的 EditorBubble 会主动排除图片和节点选区。
 * 单独提供图片操作层，避免把文字格式按钮错误地应用到图片节点。
 */
export const DocImageBubbleMenu = ({
  children,
  boundaryRef,
}: DocImageBubbleMenuProps) => {
  const { editor } = useEditor()
  const tippyInstanceRef = useRef<EditorBubbleTippyInstance | null>(null)

  if (!editor) return null

  return (
    <TiptapBubbleMenu
      editor={editor}
      pluginKey="tabdocImageBubbleMenu"
      shouldShow={({ editor: currentEditor, state }) => (
        currentEditor.isEditable && isImageNodeSelection(state.selection)
      )}
      tippyOptions={{
        placement: 'top',
        offset: [0, 10],
        appendTo: () =>
          getBubbleMenuBoundary(boundaryRef, editor.view.dom) ?? document.body,
        onShow: instance => {
          tippyInstanceRef.current = instance
          const boundary = getBubbleMenuBoundary(boundaryRef, editor.view.dom)
          if (boundary) constrainBubbleMenuToBoundary(instance, boundary)
        },
        onDestroy: instance => {
          if (tippyInstanceRef.current === instance) tippyInstanceRef.current = null
        },
      }}
      className={cn(
        TABDOC_FLOATING_MENU_SURFACE_CLASS,
        'tabdoc-image-bubble-menu z-dropdown flex w-fit max-w-full overflow-visible rounded-md',
        OVERLAY_SURFACE_CLASS,
      )}
    >
      {children}
    </TiptapBubbleMenu>
  )
}
