import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NodeViewProps } from '@tiptap/react'
import { NodeViewWrapper } from '@tiptap/react'

import { useHtmlBlockAccess } from '../html-block/HtmlBlockAccessContext'
import { useImageAssetLoaderOptional, useImageAssetPreviewOptional } from './ImageAssetLoaderContext'

const MIN_IMAGE_WIDTH = 80
const RESIZE_KEYBOARD_STEP = 16

type ResizeSide = 'left' | 'right'

function imageWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

export const ImageAssetView: React.FC<NodeViewProps> = ({
  node,
  selected,
  updateAttributes,
  editor,
  getPos,
}) => {
  const access = useHtmlBlockAccess()
  const loader = useImageAssetLoaderOptional()
  const preview = useImageAssetPreviewOptional()
  const attrs = node.attrs ?? {}
  const fileId = typeof attrs.fileId === 'string' ? attrs.fileId.trim() : ''
  const legacySrc = typeof attrs.src === 'string' ? attrs.src : ''
  const [resolvedSrc, setResolvedSrc] = useState(legacySrc)
  const initialWidth = imageWidth(attrs.width)
  const [previewWidth, setPreviewWidth] = useState<number | null>(initialWidth)
  const previewWidthRef = useRef<number | null>(initialWidth)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const wasSelectedOnPointerDownRef = useRef(false)
  const resizeSessionRef = useRef<{
    pointerId: number
    side: ResizeSide
    startX: number
    startWidth: number
  } | null>(null)
  const requestKey = useMemo(
    () => [fileId, access.documentId, access.shareId, access.password, access.revokeEpoch].join(':'),
    [fileId, access.documentId, access.shareId, access.password, access.revokeEpoch],
  )

  useEffect(() => {
    if (!fileId || !loader) {
      setResolvedSrc(legacySrc)
      return
    }
    const controller = new AbortController()
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const result = await loader({
          fileId,
          documentId: access.documentId,
          shareId: access.shareId,
          password: access.password,
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        setResolvedSrc(result.url)
        if (result.expiresIn && result.expiresIn > 60) {
          refreshTimer = setTimeout(load, Math.max(30, result.expiresIn * 0.8) * 1000)
        }
      } catch {
        if (!controller.signal.aborted) setResolvedSrc('')
      }
    }
    void load()
    return () => {
      controller.abort()
      if (refreshTimer) clearTimeout(refreshTimer)
    }
  }, [requestKey, fileId, legacySrc, loader, access.documentId, access.shareId, access.password])

  useEffect(() => {
    if (resizeSessionRef.current) return
    const nextWidth = imageWidth(attrs.width)
    previewWidthRef.current = nextWidth
    setPreviewWidth(nextWidth)
  }, [attrs.width])

  const maxResizeWidth = useCallback(() => {
    const image = imageRef.current
    if (!image) return Number.POSITIVE_INFINITY
    // ReactNodeViewRenderer inserts an inline `.react-renderer` wrapper whose
    // width is the image's current width. Using it as the limit makes growing
    // the image impossible. Resolve the nearest block/content width instead.
    const container = image.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, .ProseMirror')
    const containerWidth = container?.getBoundingClientRect().width
    return containerWidth && containerWidth > 0 ? containerWidth : Number.POSITIVE_INFINITY
  }, [])

  const setClampedPreviewWidth = useCallback((width: number) => {
    const nextWidth = Math.min(maxResizeWidth(), Math.max(MIN_IMAGE_WIDTH, width))
    previewWidthRef.current = nextWidth
    setPreviewWidth(nextWidth)
    return nextWidth
  }, [maxResizeWidth])

  const commitWidth = useCallback((width: number) => {
    const nextWidth = Math.round(setClampedPreviewWidth(width))
    updateAttributes({ width: nextWidth, height: null })
  }, [setClampedPreviewWidth, updateAttributes])

  const handleResizePointerDown = useCallback((side: ResizeSide, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !imageRef.current) return
    const measuredWidth = imageRef.current.getBoundingClientRect().width
    if (measuredWidth <= 0) return
    resizeSessionRef.current = {
      pointerId: event.pointerId,
      side,
      startX: event.clientX,
      startWidth: measuredWidth,
    }
    previewWidthRef.current = measuredWidth
    setPreviewWidth(measuredWidth)
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    const delta = session.side === 'left'
      ? session.startX - event.clientX
      : event.clientX - session.startX
    setClampedPreviewWidth(session.startWidth + delta)
    event.preventDefault()
  }, [setClampedPreviewWidth])

  const handleResizePointerEnd = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    resizeSessionRef.current = null
    if (
      typeof event.currentTarget.hasPointerCapture === 'function'
      && event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    commitWidth(previewWidthRef.current ?? session.startWidth)
    event.preventDefault()
    event.stopPropagation()
  }, [commitWidth])

  const handleResizeKeyDown = useCallback((side: ResizeSide, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const measuredWidth = previewWidthRef.current ?? imageRef.current?.getBoundingClientRect().width
    if (!measuredWidth) return
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const sideDirection = side === 'right' ? direction : -direction
    commitWidth(measuredWidth + sideDirection * RESIZE_KEYBOARD_STEP)
    event.preventDefault()
    event.stopPropagation()
  }, [commitWidth])

  const handleImagePointerDown = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    // ProseMirror selects the node during pointerdown, before the ensuing click.
    // Capture the state at the start of the gesture so one click cannot both
    // select the image and open its preview.
    wasSelectedOnPointerDownRef.current = selected
    if (!selected && event.button === 0 && typeof getPos === 'function') {
      const pos = getPos()
      if (typeof pos === 'number') editor?.commands.setNodeSelection(pos)
    }
  }, [editor, getPos, selected])

  const handleImageClick = useCallback(() => {
    const shouldPreview = wasSelectedOnPointerDownRef.current
    wasSelectedOnPointerDownRef.current = false
    if (!shouldPreview) return
    preview?.({
      url: resolvedSrc,
      fileId: fileId || undefined,
      name: typeof attrs.alt === 'string' && attrs.alt.trim() ? attrs.alt : 'image',
    })
  }, [attrs.alt, fileId, preview, resolvedSrc])

  const resizeHandle = (side: ResizeSide) => (
    <button
      type="button"
      className={`tabdoc-image-resize-handle tabdoc-image-resize-handle--${side}`}
      data-resize-side={side}
      style={{
        top: '50%',
        transform: 'translateY(-50%)',
        ...(side === 'left'
          ? { left: 'calc(-0.75rem - 3px)' }
          : { right: 'calc(-0.75rem - 3px)' }),
      }}
      aria-label={side === 'left' ? '从左侧调整图片宽度' : '从右侧调整图片宽度'}
      aria-valuemin={MIN_IMAGE_WIDTH}
      aria-valuenow={Math.round(previewWidth ?? initialWidth ?? MIN_IMAGE_WIDTH)}
      aria-orientation="horizontal"
      role="slider"
      tabIndex={0}
      contentEditable={false}
      onPointerDown={(event) => handleResizePointerDown(side, event)}
      onPointerMove={handleResizePointerMove}
      onPointerUp={handleResizePointerEnd}
      onPointerCancel={handleResizePointerEnd}
      onKeyDown={(event) => handleResizeKeyDown(side, event)}
    />
  )

  return (
    <NodeViewWrapper
      as="span"
      className={`tabdoc-image-node-view ${selected ? 'ProseMirror-selectednode' : ''}`}
      style={{ width: previewWidth ? `${previewWidth}px` : undefined }}
    >
      {resolvedSrc ? (
        <>
          <img
            ref={imageRef}
            src={resolvedSrc}
            alt={typeof attrs.alt === 'string' ? attrs.alt : ''}
            title={typeof attrs.title === 'string' ? attrs.title : undefined}
            className="rounded-lg border border-muted"
            style={{ width: previewWidth ? '100%' : undefined }}
            draggable
            data-drag-handle
            onPointerDown={handleImagePointerDown}
            onClick={handleImageClick}
          />
          {selected ? (
            <>
              {resizeHandle('left')}
              {resizeHandle('right')}
            </>
          ) : null}
        </>
      ) : (
        <span className="inline-block rounded border border-muted px-2 py-1 text-caption text-muted-foreground">
          图片不可用
        </span>
      )}
    </NodeViewWrapper>
  )
}
