/**
 * useImageDrop — 拖放图片文件到幻灯片画布
 *
 * 支持：
 * - 从 OS 文件管理器拖入图片文件
 * - 多文件拖放（水平排列，间距 20px）
 * - 有 onUploadImage 时上传到 OSS，无则 fallback 为 base64
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import {
  isImageFile,
  createImageElement,
  resolveImageSrc,
  validateImageFile,
} from '../utils/image'

export interface UseImageDropOptions {
  onUploadImage?: (file: File) => Promise<string>
  onError?: (type: 'validation' | 'upload' | 'load', message: string) => void
}

export interface ImageDropState {
  isDragOver: boolean
}

export function useImageDrop(
  canvasRef: React.RefObject<HTMLElement | null>,
  { onUploadImage, onError }: UseImageDropOptions,
): ImageDropState {
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const handleFiles = useCallback(
    async (imageFiles: File[]) => {
      const s = useSlideStore.getState()
      if (!s.presentation) return

      const validFiles = imageFiles.filter((file) => {
        const v = validateImageFile(file)
        if (!v.valid) {
          onError?.('validation', v.reason ?? 'invalid')
          return false
        }
        return true
      })
      if (validFiles.length === 0) return

      useHistoryStore.getState().pushSnapshot(s.presentation.pages)

      const cw = s.presentation.canvasWidth || 1280
      const ch = s.presentation.canvasHeight || 720
      const GAP = 20
      let cursorX: number | undefined
      const insertedIds: string[] = []

      for (const file of validFiles) {
        try {
          const { src, fallback } = await resolveImageSrc(file, onUploadImage)
          if (fallback) {
            onError?.('upload', 'fallback_base64')
          }
          const el = await createImageElement(src, {
            canvasWidth: cw,
            canvasHeight: ch,
            offlinePendingUpload: fallback,
          })

          if (cursorX !== undefined) {
            el.x = cursorX
          }
          cursorX = el.x + el.width + GAP

          useSlideStore.getState().addElement(el)
          insertedIds.push(el.id)
        } catch (err) {
          onError?.('load', err instanceof Error ? err.message : 'unknown')
        }
      }

      if (insertedIds.length > 0) {
        useSlideStore.setState({ selectedElementIds: insertedIds })
      }
    },
    [onUploadImage, onError],
  )

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragOver(true)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current--
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0
        setIsDragOver(false)
      }
    }

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDragOver(false)

      const dt = e.dataTransfer
      if (!dt?.files?.length) return

      const imageFiles = Array.from(dt.files).filter(isImageFile)
      if (imageFiles.length === 0) return

      await handleFiles(imageFiles)
    }

    el.addEventListener('dragenter', handleDragEnter)
    el.addEventListener('dragover', handleDragOver)
    el.addEventListener('dragleave', handleDragLeave)
    el.addEventListener('drop', handleDrop)

    return () => {
      el.removeEventListener('dragenter', handleDragEnter)
      el.removeEventListener('dragover', handleDragOver)
      el.removeEventListener('dragleave', handleDragLeave)
      el.removeEventListener('drop', handleDrop)
    }
  }, [canvasRef, handleFiles])

  return { isDragOver }
}
