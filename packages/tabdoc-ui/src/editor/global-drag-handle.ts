import { Extension } from '@tiptap/core'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import * as pmView from '@tiptap/pm/view'
import { setBlockMenuTarget } from './block-menu-target'

// Localized fork of tiptap-extension-global-drag-handle@0.1.18.
// Upstream keeps positions inside top-level text blocks unchanged, so dragging
// a long paragraph can serialize only part of the paragraph instead of the
// whole block. TabDoc needs every drag handle drag to start from a block node.
export interface TabDocGlobalDragHandleOptions {
  dragHandleWidth: number
  scrollTreshold: number
  dragHandleSelector?: string
  excludedTags: string[]
  customNodes: string[]
}

function getPmView() {
  try {
    return pmView
  } catch {
    return null
  }
}

function serializeForClipboard(view: EditorView, slice: Slice) {
  const viewWithSerializer = view as EditorView & {
    serializeForClipboard?: (slice: Slice) => { dom: HTMLElement; text: string }
  }
  if (typeof viewWithSerializer.serializeForClipboard === 'function') {
    return viewWithSerializer.serializeForClipboard(slice)
  }

  const proseMirrorView = getPmView() as (typeof pmView & {
    __serializeForClipboard?: (view: EditorView, slice: Slice) => { dom: HTMLElement; text: string }
  }) | null
  if (typeof proseMirrorView?.__serializeForClipboard === 'function') {
    return proseMirrorView.__serializeForClipboard(view, slice)
  }

  throw new Error('No supported clipboard serialization method found.')
}

function absoluteRect(node: Element) {
  const data = node.getBoundingClientRect()
  const modal = node.closest('[role="dialog"]')

  if (modal && window.getComputedStyle(modal).transform !== 'none') {
    const modalRect = modal.getBoundingClientRect()
    return {
      top: data.top - modalRect.top,
      left: data.left - modalRect.left,
      width: data.width,
    }
  }

  return {
    top: data.top,
    left: data.left,
    width: data.width,
  }
}

function nodeDOMAtCoords(
  coords: { x: number; y: number },
  options: TabDocGlobalDragHandleOptions,
) {
  const selectors = [
    'li',
    'p:not(:first-child)',
    'pre',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    ...options.customNodes.map((node) => `[data-type=${node}]`),
  ].join(', ')

  return document
    .elementsFromPoint(coords.x, coords.y)
    .find((elem: Element) =>
      elem.parentElement?.matches?.('.ProseMirror') ||
      elem.matches(selectors),
    )
}

function nodePosAtDOM(
  node: Element,
  view: EditorView,
  options: TabDocGlobalDragHandleOptions,
) {
  const boundingRect = node.getBoundingClientRect()
  return view.posAtCoords({
    left: boundingRect.left + 50 + options.dragHandleWidth,
    top: boundingRect.top + 1,
  })?.inside
}

export function normalizeDragNodePos(pos: number, doc: ProseMirrorNode): number {
  const $pos = doc.resolve(pos)
  if ($pos.depth > 0) return $pos.before($pos.depth)
  return pos
}

function resolveDragNodePosAtDOM(
  node: Element,
  view: EditorView,
  options: TabDocGlobalDragHandleOptions,
): number | null {
  const rawNodePos = nodePosAtDOM(node, view, options)
  if (rawNodePos == null || rawNodePos < 0) return null
  return normalizeDragNodePos(rawNodePos, view.state.doc)
}

export function selectionSpansMultipleBlocks(
  selectionFrom: number,
  selectionTo: number,
  doc: ProseMirrorNode,
): boolean {
  if (selectionFrom === selectionTo) return false

  const startBlockPos = normalizeDragNodePos(selectionFrom, doc)
  const endBlockPos = normalizeDragNodePos(Math.max(selectionFrom, selectionTo - 1), doc)
  return startBlockPos !== endBlockPos
}

export function adjustBlockMoveInsertPos(
  sourceFrom: number,
  sourceTo: number,
  insertPos: number,
): number | null {
  if (insertPos >= sourceFrom && insertPos <= sourceTo) return null

  const adjustedInsertPos = insertPos > sourceTo
    ? insertPos - (sourceTo - sourceFrom)
    : insertPos

  return adjustedInsertPos === sourceFrom ? null : adjustedInsertPos
}

export function TabDocDragHandlePlugin(
  options: TabDocGlobalDragHandleOptions & { pluginKey: string },
) {
  let listType = ''
  let nativeDragStarted = false
  let pointerDragStart: {
    clientX: number
    clientY: number
    draggedNodePos: number
    didMove: boolean
  } | null = null

  function resolveDraggedBlock(
    event: Pick<MouseEvent, 'clientX' | 'clientY'>,
    view: EditorView,
  ): { node: Element; pos: number } | null {
    const node = nodeDOMAtCoords(
      {
        x: event.clientX + 50 + options.dragHandleWidth,
        y: event.clientY,
      },
      options,
    )

    if (!(node instanceof Element)) return null

    const pos = resolveDragNodePosAtDOM(node, view, options)
    if (pos === null) return null

    return {
      node,
      pos,
    }
  }

  function createBlockSelection(doc: ProseMirrorNode, draggedNodePos: number): NodeSelection {
    let selection = NodeSelection.create(doc, draggedNodePos)

    if (
      selection.node.type.isInline ||
      selection.node.type.name === 'tableRow'
    ) {
      const $pos = doc.resolve(selection.from)
      selection = NodeSelection.create(doc, $pos.before())
    }

    return selection
  }

  function handleDragStart(event: DragEvent, view: EditorView) {
    view.focus()

    if (!event.dataTransfer) return

    const draggedBlock = resolveDraggedBlock(event, view)
    if (!draggedBlock) return

    const selection = createBlockSelection(view.state.doc, draggedBlock.pos)
    view.dispatch(view.state.tr.setSelection(selection))

    if (
      view.state.selection instanceof NodeSelection &&
      view.state.selection.node.type.name === 'listItem'
    ) {
      listType = draggedBlock.node.parentElement?.tagName ?? ''
    }

    const slice = view.state.selection.content()
    const { dom, text } = serializeForClipboard(view, slice)

    event.dataTransfer.clearData()
    event.dataTransfer.setData('text/html', dom.innerHTML)
    event.dataTransfer.setData('text/plain', text)
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setDragImage(draggedBlock.node, 0, 0)

    view.dragging = { slice, move: !event.ctrlKey }
  }

  function moveBlockWithPointerFallback(event: MouseEvent, view: EditorView, draggedNodePos: number): boolean {
    const sourceSelection = createBlockSelection(view.state.doc, draggedNodePos)
    const sourceFrom = sourceSelection.from
    const sourceTo = sourceSelection.to
    const draggedNode = sourceSelection.node
    const editorRect = view.dom.getBoundingClientRect()
    const dropNode = nodeDOMAtCoords(
      {
        x: Math.min(
          Math.max(editorRect.left + 50 + options.dragHandleWidth, editorRect.left + 1),
          editorRect.right - 1,
        ),
        y: event.clientY,
      },
      options,
    )

    if (!(dropNode instanceof Element)) return false

    const dropNodePos = nodePosAtDOM(dropNode, view, options)
    if (dropNodePos == null || dropNodePos < 0) return false

    const dropBlockPos = normalizeDragNodePos(dropNodePos, view.state.doc)
    const dropSelection = createBlockSelection(view.state.doc, dropBlockPos)
    const dropRect = dropNode.getBoundingClientRect()
    const insertPos = event.clientY < dropRect.top + dropRect.height / 2
      ? dropSelection.from
      : dropSelection.to
    const adjustedInsertPos = adjustBlockMoveInsertPos(sourceFrom, sourceTo, insertPos)
    if (adjustedInsertPos == null) return false

    const tr = view.state.tr.delete(sourceFrom, sourceTo)
    const $insert = tr.doc.resolve(adjustedInsertPos)
    if (!$insert.parent.canReplaceWith($insert.index(), $insert.index(), draggedNode.type)) {
      return false
    }

    tr.insert(adjustedInsertPos, draggedNode)
    tr.setSelection(NodeSelection.create(tr.doc, adjustedInsertPos))
    tr.scrollIntoView()

    view.dispatch(tr)
    return true
  }

  function safeMoveBlockWithPointerFallback(event: MouseEvent, view: EditorView, draggedNodePos: number): boolean {
    try {
      return moveBlockWithPointerFallback(event, view, draggedNodePos)
    } catch {
      return false
    }
  }

  let dragHandleElement: HTMLElement | null = null

  function hideDragHandle() {
    if (dragHandleElement) setBlockMenuTarget(dragHandleElement, null)
    dragHandleElement?.classList.add('hide')
  }

  function showDragHandle() {
    dragHandleElement?.classList.remove('hide')
  }

  function hideHandleOnEditorOut(event: MouseEvent) {
    if (event.target instanceof Element) {
      const relatedTarget = event.relatedTarget as HTMLElement | null
      const isInsideEditor =
        relatedTarget?.classList.contains('tiptap') ||
        relatedTarget?.classList.contains('drag-handle')

      if (isInsideEditor) return
    }
    hideDragHandle()
  }

  return new Plugin({
    key: new PluginKey(options.pluginKey),
    view: (view) => {
      const handleBySelector = options.dragHandleSelector
        ? document.querySelector<HTMLElement>(options.dragHandleSelector)
        : null
      dragHandleElement = handleBySelector ?? document.createElement('div')
      dragHandleElement.draggable = true
      dragHandleElement.dataset.dragHandle = ''
      dragHandleElement.classList.add('drag-handle')

      function onDragHandleDragStart(e: DragEvent) {
        nativeDragStarted = true
        handleDragStart(e, view)
      }

      function onDragHandleMouseDown(e: MouseEvent) {
        if (e.button !== 0) return
        const draggedBlock = resolveDraggedBlock(e, view)
        if (!draggedBlock) return
        nativeDragStarted = false
        pointerDragStart = {
          clientX: e.clientX,
          clientY: e.clientY,
          draggedNodePos: draggedBlock.pos,
          didMove: false,
        }
      }

      function onDocumentMouseMove(e: MouseEvent) {
        if (!pointerDragStart || nativeDragStarted) return
        const distance = Math.hypot(
          e.clientX - pointerDragStart.clientX,
          e.clientY - pointerDragStart.clientY,
        )
        if (distance < 4) return
        pointerDragStart.didMove = true
        e.preventDefault()
      }

      function onDocumentMouseUp(e: MouseEvent) {
        if (!pointerDragStart) return
        const pointerDrag = pointerDragStart
        pointerDragStart = null
        if (nativeDragStarted || !pointerDrag.didMove) return

        if (safeMoveBlockWithPointerFallback(e, view, pointerDrag.draggedNodePos)) {
          e.preventDefault()
          e.stopPropagation()
        }
        hideDragHandle()
      }

      function onDragHandleDrag(e: DragEvent) {
        hideDragHandle()
        const scrollY = window.scrollY
        if (e.clientY < options.scrollTreshold) {
          window.scrollTo({ top: scrollY - 30, behavior: 'smooth' })
        } else if (window.innerHeight - e.clientY < options.scrollTreshold) {
          window.scrollTo({ top: scrollY + 30, behavior: 'smooth' })
        }
      }

      function onDocumentSelectionChange() {
        if (selectionSpansMultipleBlocks(
          view.state.selection.from,
          view.state.selection.to,
          view.state.doc,
        )) {
          hideDragHandle()
        }
      }

      dragHandleElement.addEventListener('mousedown', onDragHandleMouseDown)
      dragHandleElement.addEventListener('dragstart', onDragHandleDragStart)
      dragHandleElement.addEventListener('drag', onDragHandleDrag)
      document.addEventListener('mousemove', onDocumentMouseMove)
      document.addEventListener('mouseup', onDocumentMouseUp)
      document.addEventListener('selectionchange', onDocumentSelectionChange)
      hideDragHandle()

      if (!handleBySelector) {
        view.dom.parentElement?.appendChild(dragHandleElement)
      }
      view.dom.parentElement?.addEventListener('mouseout', hideHandleOnEditorOut)

      return {
        destroy: () => {
          if (!handleBySelector) {
            dragHandleElement?.remove()
          }
          dragHandleElement?.removeEventListener('mousedown', onDragHandleMouseDown)
          dragHandleElement?.removeEventListener('drag', onDragHandleDrag)
          dragHandleElement?.removeEventListener('dragstart', onDragHandleDragStart)
          document.removeEventListener('mousemove', onDocumentMouseMove)
          document.removeEventListener('mouseup', onDocumentMouseUp)
          document.removeEventListener('selectionchange', onDocumentSelectionChange)
          dragHandleElement = null
          view.dom.parentElement?.removeEventListener('mouseout', hideHandleOnEditorOut)
        },
      }
    },
    props: {
      handleDOMEvents: {
        mousemove: (view, event) => {
          if (!view.editable) return
          if (selectionSpansMultipleBlocks(
            view.state.selection.from,
            view.state.selection.to,
            view.state.doc,
          )) {
            hideDragHandle()
            return
          }

          const node = nodeDOMAtCoords(
            {
              x: event.clientX + 50 + options.dragHandleWidth,
              y: event.clientY,
            },
            options,
          )

          const notDragging = node?.closest('.not-draggable')
          const excludedTagList = options.excludedTags.concat(['ol', 'ul']).join(', ')

          if (
            !(node instanceof Element) ||
            node.matches(excludedTagList) ||
            notDragging
          ) {
            hideDragHandle()
            return
          }

          const compStyle = window.getComputedStyle(node)
          const parsedLineHeight = parseInt(compStyle.lineHeight, 10)
          const lineHeight = Number.isNaN(parsedLineHeight)
            ? parseInt(compStyle.fontSize, 10) * 1.2
            : parsedLineHeight
          const paddingTop = parseInt(compStyle.paddingTop, 10)

          const rect = absoluteRect(node)
          rect.top += (lineHeight - 24) / 2
          rect.top += paddingTop
          if (node.matches('ul:not([data-type=taskList]) li, ol li')) {
            rect.left -= options.dragHandleWidth
          }
          rect.width = options.dragHandleWidth

          if (!dragHandleElement) return

          dragHandleElement.style.left = `${rect.left - rect.width}px`
          dragHandleElement.style.top = `${rect.top}px`
          const nodePos = resolveDragNodePosAtDOM(node, view, options)
          if (nodePos === null) {
            hideDragHandle()
            return
          }
          setBlockMenuTarget(dragHandleElement, { nodePos, node: view.state.doc.nodeAt(nodePos)! })
          showDragHandle()
        },
        keydown: () => {
          hideDragHandle()
        },
        mousewheel: () => {
          hideDragHandle()
        },
        dragstart: (view, event) => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-drag-handle], .drag-handle')) {
            view.dom.classList.add('dragging')
            return
          }
          if (
            !(view.state.selection instanceof NodeSelection) &&
            selectionSpansMultipleBlocks(
              view.state.selection.from,
              view.state.selection.to,
              view.state.doc,
            )
          ) {
            hideDragHandle()
            event.preventDefault()
            event.stopPropagation()
            return true
          }
          view.dom.classList.add('dragging')
        },
        drop: (view, event) => {
          view.dom.classList.remove('dragging')
          hideDragHandle()
          const dropPos = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          })

          if (!dropPos) return

          const droppedNode = view.state.selection instanceof NodeSelection
            ? view.state.selection.node
            : null
          if (!droppedNode) return

          const resolvedPos = view.state.doc.resolve(dropPos.pos)
          const isDroppedInsideList = resolvedPos.parent.type.name === 'listItem'

          if (
            view.state.selection instanceof NodeSelection &&
            view.state.selection.node.type.name === 'listItem' &&
            !isDroppedInsideList &&
            listType === 'OL'
          ) {
            const newList = view.state.schema.nodes.orderedList?.createAndFill(
              null,
              droppedNode,
            )
            const slice = new Slice(Fragment.from(newList), 0, 0)
            view.dragging = { slice, move: !event.ctrlKey }
          }
        },
        dragend: (view) => {
          view.dom.classList.remove('dragging')
          nativeDragStarted = false
          pointerDragStart = null
        },
      },
    },
  })
}

export const TabDocGlobalDragHandle = Extension.create({
  name: 'tabDocGlobalDragHandle',

  addOptions() {
    return {
      dragHandleWidth: 20,
      scrollTreshold: 100,
      excludedTags: [],
      customNodes: [],
    }
  },

  addProseMirrorPlugins() {
    return [
      TabDocDragHandlePlugin({
        pluginKey: 'tabDocGlobalDragHandle',
        dragHandleWidth: this.options.dragHandleWidth,
        scrollTreshold: this.options.scrollTreshold,
        dragHandleSelector: this.options.dragHandleSelector,
        excludedTags: this.options.excludedTags,
        customNodes: this.options.customNodes,
      }),
    ]
  },
})
