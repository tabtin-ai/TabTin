export const MAX_COMMENT_IMAGES = 9

export type CommentComposerImageStatus = 'pending' | 'uploading' | 'ready' | 'error'

export interface CommentComposerImageDraft {
  localId: string
  file: File
  previewUrl: string
  status: CommentComposerImageStatus
  fileId?: string
  error?: string
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

export function canSubmitCommentComposer(input: {
  body: string
  images: readonly CommentComposerImageDraft[]
}): boolean {
  const hasBody = input.body.trim().length > 0
  const readyImages = input.images.filter((img) => img.status === 'ready' && img.fileId)
  const hasBusy = input.images.some((img) => img.status === 'pending' || img.status === 'uploading')
  const hasError = input.images.some((img) => img.status === 'error')
  if (hasBusy || hasError) return false
  return hasBody || readyImages.length > 0
}

export function mergeCommentComposerImages(
  current: readonly CommentComposerImageDraft[],
  incoming: readonly File[],
  createPreviewUrl: (file: File) => string = defaultPreviewUrl,
): { next: CommentComposerImageDraft[]; rejected: number } {
  const next = [...current]
  let rejected = 0
  for (const file of incoming) {
    if (!isImageFile(file)) {
      rejected += 1
      continue
    }
    if (next.length >= MAX_COMMENT_IMAGES) {
      rejected += 1
      continue
    }
    next.push({
      localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      previewUrl: createPreviewUrl(file),
      status: 'pending',
    })
  }
  return { next, rejected }
}

export function revokeCommentComposerPreviewUrl(url: string | null | undefined): void {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  if (url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // ignore
    }
  }
}

export function clearCommentComposerImages(
  current: readonly CommentComposerImageDraft[],
): CommentComposerImageDraft[] {
  for (const img of current) {
    revokeCommentComposerPreviewUrl(img.previewUrl)
  }
  return []
}

export function removeCommentComposerImage(
  current: readonly CommentComposerImageDraft[],
  localId: string,
): CommentComposerImageDraft[] {
  const target = current.find((img) => img.localId === localId)
  if (target) revokeCommentComposerPreviewUrl(target.previewUrl)
  return current.filter((img) => img.localId !== localId)
}

export function markCommentComposerImage(
  current: readonly CommentComposerImageDraft[],
  localId: string,
  patch: Partial<Pick<CommentComposerImageDraft, 'status' | 'fileId' | 'error' | 'previewUrl'>>,
): CommentComposerImageDraft[] {
  return current.map((img) => (img.localId === localId ? { ...img, ...patch } : img))
}

export function readyAttachmentIds(images: readonly CommentComposerImageDraft[]): string[] {
  return images
    .filter((img) => img.status === 'ready' && img.fileId)
    .map((img) => img.fileId!)
}

function defaultPreviewUrl(file: File): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(file)
  }
  return ''
}

export function collectImageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  if (data.files?.length) {
    for (let i = 0; i < data.files.length; i += 1) {
      const file = data.files.item(i)
      if (file) files.push(file)
    }
  }
  return files
}
