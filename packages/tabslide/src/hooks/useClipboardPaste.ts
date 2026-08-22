/**
 * useClipboardPaste — 从系统剪贴板粘贴图片/富文本到幻灯片
 *
 * 两条触发路径：
 * 1. document paste 事件 — 用户右键粘贴或浏览器捕获 Ctrl+V
 * 2. tryPasteClipboardImage() / tryPasteClipboardText() — 由 useKeyboard 在 Ctrl+V 时主动调用
 *
 * 不干扰已有的内部元素复制/粘贴（useClipboard）。
 */

import { useCallback, useEffect, useRef } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import {
  hasClipboardImage,
  isEditableTarget,
  extractImageFile,
  readClipboardImageFile,
  createImageElement,
  resolveImageSrc,
  validateImageFile,
} from '../utils/image'
import { sanitizeHtml } from '../utils/sanitize'
import { createElementId } from '../utils/id'
import type { PPTTextElement } from '../types/slides'

const PASTE_TEXT_MAX_WIDTH = 640
const PASTE_TEXT_MIN_HEIGHT = 60
const PASTE_TEXT_MARGIN = 80

export interface UseClipboardPasteOptions {
  onUploadImage?: (file: File) => Promise<string>
  onError?: (type: 'validation' | 'upload' | 'load', message: string) => void
}

export function useClipboardPaste({ onUploadImage, onError }: UseClipboardPasteOptions): {
  tryPasteClipboardImage: () => Promise<boolean>
  tryPasteClipboardText: () => Promise<boolean>
} {
  const busyRef = useRef(false)

  const insertImageFromFile = useCallback(
    async (file: File) => {
      if (busyRef.current) return
      busyRef.current = true

      try {
        const validation = validateImageFile(file)
        if (!validation.valid) {
          onError?.('validation', validation.reason ?? 'invalid')
          return
        }

        const s = useSlideStore.getState()
        if (!s.presentation) return

        const { src, fallback } = await resolveImageSrc(file, onUploadImage)

        if (fallback) {
          onError?.('upload', 'fallback_base64')
        }

        const el = await createImageElement(src, {
          canvasWidth: s.presentation.canvasWidth,
          canvasHeight: s.presentation.canvasHeight,
          offlinePendingUpload: fallback,
        })

        useHistoryStore.getState().pushSnapshot(s.presentation.pages)
        useSlideStore.getState().addElement(el)
        useSlideStore.setState({ selectedElementIds: [el.id] })
      } catch (err) {
        onError?.('load', err instanceof Error ? err.message : 'unknown')
      } finally {
        busyRef.current = false
      }
    },
    [onUploadImage, onError],
  )

  const insertTextElement = useCallback((html: string) => {
    const s = useSlideStore.getState()
    if (!s.presentation) return

    const canvasW = s.presentation.canvasWidth
    const canvasH = s.presentation.canvasHeight
    const width = Math.min(PASTE_TEXT_MAX_WIDTH, canvasW - PASTE_TEXT_MARGIN * 2)
    const x = Math.max(PASTE_TEXT_MARGIN, (canvasW - width) / 2)
    const y = Math.max(PASTE_TEXT_MARGIN, (canvasH - PASTE_TEXT_MIN_HEIGHT) / 3)

    const el: PPTTextElement = {
      id: createElementId(),
      type: 'text',
      x,
      y,
      width,
      height: PASTE_TEXT_MIN_HEIGHT,
      rotate: 0,
      opacity: 1,
      locked: false,
      content: html,
      defaultFontName: s.presentation.theme?.fontName ?? 'Microsoft YaHei',
      defaultColor: s.presentation.theme?.fontColor ?? '#1f2937',
      autoFit: 'resize',
    }

    useHistoryStore.getState().pushSnapshot(s.presentation.pages)
    useSlideStore.getState().addElement(el)
    useSlideStore.setState({ selectedElementIds: [el.id] })
  }, [])

  const tryPasteClipboardImage = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false
    const file = await readClipboardImageFile()
    if (!file) return false
    await insertImageFromFile(file)
    return true
  }, [insertImageFromFile])

  const tryPasteClipboardText = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false

    busyRef.current = true
    try {
      // 优先尝试 read() 获取 text/html
      if (navigator.clipboard.read) {
        try {
          const items = await navigator.clipboard.read()
          for (const item of items) {
            if (item.types.includes('text/html')) {
              const blob = await item.getType('text/html')
              const rawHtml = await blob.text()
              const cleaned = sanitizeHtml(rawHtml)
              if (cleaned.trim()) {
                insertTextElement(cleaned)
                return true
              }
            }
          }
        } catch {
          // read() 可能因权限被拒，回退到 readText()
        }
      }

      // 回退：纯文本
      const text = await navigator.clipboard.readText()
      if (text.trim()) {
        const escaped = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
        const html = escaped
          .split('\n')
          .map((line) => `<p>${line || '<br>'}</p>`)
          .join('')
        insertTextElement(html)
        return true
      }
    } catch {
      // Clipboard API 不可用或用户拒绝权限
    } finally {
      busyRef.current = false
    }

    return false
  }, [insertTextElement])

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (isEditableTarget(e)) return

      // 图片优先
      if (hasClipboardImage(e)) {
        e.preventDefault()
        const file = extractImageFile(e)
        if (file) await insertImageFromFile(file)
        return
      }

      // 富文本 / 纯文本 — busyRef 防止与 tryPasteClipboardText 双重粘贴
      if (busyRef.current) return
      const html = e.clipboardData?.getData('text/html')
      const text = e.clipboardData?.getData('text/plain')
      if (html || text) {
        e.preventDefault()
        busyRef.current = true
        try {
          if (html) {
            const cleaned = sanitizeHtml(html)
            if (cleaned.trim()) {
              insertTextElement(cleaned)
              return
            }
          }
          if (text?.trim()) {
            const escaped = text
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
            const pastedHtml = escaped
              .split('\n')
              .map((line) => `<p>${line || '<br>'}</p>`)
              .join('')
            insertTextElement(pastedHtml)
          }
        } finally {
          busyRef.current = false
        }
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [insertImageFromFile, insertTextElement])

  return { tryPasteClipboardImage, tryPasteClipboardText }
}
