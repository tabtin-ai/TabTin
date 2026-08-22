import { useCallback, useRef, useState } from 'react'
import { canMoveEntryToDir } from '@components/shared/file-utils/path-ops'
import { createLogger } from '@/utils/logger'

const log = createLogger('FileTreeDnD')

type FileTreeDragNode = { path: string; isDirectory: boolean }

interface UseFileTreeDragDropOptions {
  onMove: (sourcePath: string, targetDirPath: string) => void | Promise<void>
  canDrag?: (path: string) => boolean
  /**
   * 拖拽开始后的附加装饰：调用方可在此写入聊天上下文引用载荷、放宽
   * `effectAllowed`，使文件树项可被拖入对话框。hook 自身不感知聊天语义。
   */
  onDragStartExtra?: (e: React.DragEvent, node: FileTreeDragNode) => void
}

/**
 * 本地文件树 DnD。
 *
 * Windows/Chromium：dragStart 同步 setState 会取消原生 HTML5 拖拽（与云盘  同根因）。
 * 路径载荷走 ref + text/plain；视觉态（isDragging / dropTarget）延后到 rAF。
 */
export function useFileTreeDragDrop({ onMove, canDrag, onDragStartExtra }: UseFileTreeDragDropOptions) {
  const draggingPathRef = useRef<string | null>(null)
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)

  const onDragStart = useCallback((e: React.DragEvent, node: FileTreeDragNode) => {
    if (canDrag?.(node.path) === false) {
      e.preventDefault()
      log.warn('dragStart blocked by canDrag', { path: node.path })
      return
    }
    // 必须先写 ref + setData；禁止在此处同步 setState（Windows 会取消拖拽）
    draggingPathRef.current = node.path
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', node.path)
    onDragStartExtra?.(e, node)
    log.info('dragStart', { path: node.path, isDirectory: node.isDirectory })
    requestAnimationFrame(() => {
      if (draggingPathRef.current === node.path) {
        setDraggingPath(node.path)
      }
    })
  }, [canDrag, onDragStartExtra])

  const onDragEnd = useCallback(() => {
    const hadPayload = Boolean(draggingPathRef.current)
    draggingPathRef.current = null
    setDraggingPath(null)
    setDropTargetPath(null)
    // 不在此处 setState 以外的同步重渲染路径；视觉清理可同步（拖拽已结束）
    log.info('dragEnd', { hadPayload })
  }, [])

  const getDragHandlers = useCallback((node: FileTreeDragNode) => ({
    draggable: canDrag?.(node.path) !== false,
    onDragStart: (e: React.DragEvent) => onDragStart(e, node),
    onDragEnd,
  }), [canDrag, onDragStart, onDragEnd])

  const getDropHandlers = useCallback((target: { path: string; isDirectory: boolean }) => {
    if (!target.isDirectory) return undefined
    return {
      onDragOver: (e: React.DragEvent) => {
        const src = draggingPathRef.current
        if (!src) return
        if (!canMoveEntryToDir(src, target.path)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setDropTargetPath(target.path)
      },
      onDragLeave: (e: React.DragEvent) => {
        e.stopPropagation()
        setDropTargetPath((prev) => (prev === target.path ? null : prev))
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const src = draggingPathRef.current || e.dataTransfer.getData('text/plain')
        const usedRefFallback = !e.dataTransfer.getData('text/plain')
        draggingPathRef.current = null
        setDraggingPath(null)
        setDropTargetPath(null)
        if (src && canMoveEntryToDir(src, target.path)) {
          log.info('drop on directory', { src, target: target.path, usedRefFallback })
          void onMove(src, target.path)
        } else {
          log.warn('drop on directory rejected', { src: src || null, target: target.path })
        }
      },
    }
  }, [onMove])

  const getRootDropHandlers = useCallback((rootDirPath: string) => ({
    onDragOver: (e: React.DragEvent) => {
      const src = draggingPathRef.current
      if (!src) return
      if (!canMoveEntryToDir(src, rootDirPath)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      setDropTargetPath(rootDirPath)
    },
    onDragLeave: (e: React.DragEvent) => {
      e.stopPropagation()
      setDropTargetPath((prev) => (prev === rootDirPath ? null : prev))
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const src = draggingPathRef.current || e.dataTransfer.getData('text/plain')
      const usedRefFallback = !e.dataTransfer.getData('text/plain')
      draggingPathRef.current = null
      setDraggingPath(null)
      setDropTargetPath(null)
      if (src && canMoveEntryToDir(src, rootDirPath)) {
        log.info('drop on root', { src, rootDirPath, usedRefFallback })
        void onMove(src, rootDirPath)
      } else {
        log.warn('drop on root rejected', { src: src || null, rootDirPath })
      }
    },
  }), [onMove])

  const isDropTarget = useCallback((path: string) => dropTargetPath === path, [dropTargetPath])
  const isDragging = useCallback((path: string) => draggingPath === path, [draggingPath])

  return { getDragHandlers, getDropHandlers, getRootDropHandlers, isDropTarget, isDragging }
}
