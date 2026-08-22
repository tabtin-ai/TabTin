/**
 * Tabdoc image upload handler (host-agnostic).
 *
 * Uses a TabDoc-owned insert path instead of Novel's placeholder replacement
 * (`Decoration.widget(pos + 1)`), so paste/drop/slash land at the real cursor.
 * The actual upload implementation is injected via TabDocEditorConfig.imageUpload port.
 *
 * Offline fallback: when upload fails due to network issues, the image is
 * returned as a base64 data URL so TabDoc can insert it. Requires
 * `allowBase64: true` on the TipTap Image extension.
 */
import type { EditorView } from '@tiptap/pm/view'
import { toast } from '@tabtin/smartsheet-ui'
import type { TabDocImageUploadPort, TabDocImageUploadResult } from '../ports'
import { insertUploadedImage } from './image-insert'

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string

export type TabDocImageUploadFn = (file: File, view: EditorView, pos: number) => void

interface ImageUploadBatch {
  pendingUploads: number
  insertQueue: Promise<number | null>
  baseInsertPos: number
  selectionRange: { from: number; to: number } | null
  selectionDeleted: boolean
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function isLikelyOfflineError(err: unknown): boolean {
  if (!navigator.onLine) return true
  if (err instanceof TypeError && err.message === 'Failed to fetch') return true
  if (err instanceof DOMException && err.name === 'AbortError') return false
  const msg = err instanceof Error ? err.message : ''
  return /network|offline|ECONNREFUSED|ERR_NETWORK/i.test(msg)
}

function preloadImage(url: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const img = new Image()
    img.src = url
    img.onload = () => resolve(url)
    img.onerror = () => resolve(url)
    setTimeout(() => resolve(url), 5000)
  })
}

/** Upload an image for a document; offline → base64 data URL so the editor can still insert. */
export async function uploadImageWithOfflineFallback(
  file: File,
  port: TabDocImageUploadPort,
  t: TranslateFn,
  opts: { folder: string; module: string; contextType: string; contextId?: string },
): Promise<TabDocImageUploadResult> {
  try {
    const result = await port.upload(file, opts)
    if (result.url && result.fileId) {
      return { ...result, url: await preloadImage(result.url) }
    }
    throw new Error(t('imageUploadFailed'))
  } catch (err) {
    if (isLikelyOfflineError(err)) {
      const dataUrl = await fileToDataUrl(file)
      toast({ title: t('imageOfflineFallback') })
      return { url: dataUrl, fileId: '' }
    }
    throw err
  }
}

function validateImageFile(file: File, port: TabDocImageUploadPort, t: TranslateFn): boolean {
  if (!port.validate) return true
  const result = port.validate(file)
  if (!result.valid) {
    toast({
      title: t(result.reason?.startsWith('fileTooLarge') ? 'imageTooLarge' : 'imageTypeNotSupported', {
        maxSize: result.maxSizeLabel,
      }),
      variant: 'destructive',
    })
    return false
  }
  return true
}

function createTabDocImageUpload(
  port: TabDocImageUploadPort,
  t: TranslateFn,
  opts: { folder: string; module: string; contextType: string; contextId?: string },
): TabDocImageUploadFn {
  let activeBatch: ImageUploadBatch | null = null
  let acceptingCurrentBatch = false

  const createBatch = (view: EditorView, pos: number): ImageUploadBatch => {
    acceptingCurrentBatch = true
    queueMicrotask(() => {
      acceptingCurrentBatch = false
    })

    return {
      pendingUploads: 0,
      insertQueue: Promise.resolve(null),
      baseInsertPos: pos,
      selectionRange: view.state.selection.empty
        ? null
        : { from: view.state.selection.from, to: view.state.selection.to },
      selectionDeleted: false,
    }
  }

  return (file: File, view: EditorView, pos: number): void => {
    if (!validateImageFile(file, port, t)) return

    if (!activeBatch || !acceptingCurrentBatch) {
      activeBatch = createBatch(view, pos)
    }
    const batch = activeBatch
    batch.pendingUploads += 1

    const uploadPromise = uploadImageWithOfflineFallback(file, port, t, opts)
    const insertTask = batch.insertQueue.then(async (nextInsertPos) => {
      const uploaded = await uploadPromise
      let insertPos = nextInsertPos ?? batch.baseInsertPos
      if (!batch.selectionDeleted && batch.selectionRange) {
        const docSize = view.state.doc.content.size
        const from = Math.max(0, Math.min(batch.selectionRange.from, docSize))
        const to = Math.max(from, Math.min(batch.selectionRange.to, docSize))
        if (from < to) {
          view.dispatch(view.state.tr.delete(from, to))
          insertPos = from
          batch.baseInsertPos = from
        }
        batch.selectionDeleted = true
      }
      return insertUploadedImage(view, insertPos, {
        src: uploaded.fileId ? '' : uploaded.url,
        fileId: uploaded.fileId || undefined,
        alt: file.name,
      })
    })

    batch.insertQueue = insertTask.catch(() => null)

    void insertTask
      .catch((err) => {
        toast({
          title: t('imageUploadFailed'),
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        })
      })
      .finally(() => {
        batch.pendingUploads -= 1
        if (batch.pendingUploads === 0 && activeBatch === batch) {
          activeBatch = null
        }
      })
  }
}

export function createUploadFn(
  documentId: string,
  port: TabDocImageUploadPort,
  t: TranslateFn,
): TabDocImageUploadFn {
  return createTabDocImageUpload(port, t, {
    folder: 'tabdoc/images',
    module: 'tabdoc',
    contextType: 'document',
    contextId: documentId,
  })
}

export function createFallbackUploadFn(
  port: TabDocImageUploadPort,
  t: TranslateFn,
): TabDocImageUploadFn {
  return createTabDocImageUpload(port, t, {
    folder: 'tabdoc/images',
    module: 'tabdoc',
    contextType: 'document',
    contextId: `tabdoc_pending_${Date.now()}`,
  })
}

/** Paste clipboard image files at the real selection (no Novel pos+1). */
export function handleImagePaste(
  view: EditorView,
  event: ClipboardEvent,
  uploadFn: TabDocImageUploadFn,
): boolean {
  if (!event.clipboardData?.files.length) return false
  event.preventDefault()
  const [file] = Array.from(event.clipboardData.files)
  const pos = view.state.selection.from
  if (file) uploadFn(file, view, pos)
  return true
}

/**
 * Drop image files at the drop coordinates.
 * Unlike Novel's handleImageDrop, does not subtract 1 (that only compensated
 * UploadImagesPlugin's widget(pos+1)).
 */
export function handleImageDrop(
  view: EditorView,
  event: DragEvent,
  moved: boolean,
  uploadFn: TabDocImageUploadFn,
): boolean {
  if (moved || !event.dataTransfer?.files.length) return false
  event.preventDefault()
  const [file] = Array.from(event.dataTransfer.files)
  const coordinates = view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  })
  if (file) uploadFn(file, view, coordinates?.pos ?? 0)
  return true
}
