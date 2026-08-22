/**
 * Offline image re-upload — scans all slide pages for image elements with
 * `offlinePendingUpload` flag and re-uploads base64 data URIs to the backend.
 *
 * Called from SlideEditorHost on `online` event after network reconnection.
 * Runs serially to avoid concurrent store mutations.
 */

import { useSlideStore } from '../store/slide'

function dataUriToFile(dataUri: string, mtype?: string): File {
  const commaIdx = dataUri.indexOf(',')
  if (commaIdx === -1) throw new Error('Invalid data URI: missing comma separator')

  const header = dataUri.slice(0, commaIdx)
  const payload = dataUri.slice(commaIdx + 1)
  const mime = mtype || header.match(/data:(.*?)[;,]/)?.[1] || 'image/png'

  if (!header.includes('base64')) {
    throw new Error('Only base64 data URIs are supported for re-upload')
  }

  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  const ext = mime.split('/')[1] || 'png'
  return new File([bytes], `reupload-${Date.now()}.${ext}`, { type: mime })
}
import type { PPTImageElement, PPTElement } from '../types/slides'

interface PendingItem {
  elementId: string
  src: string
}

function collectPendingItems(): PendingItem[] {
  const { presentation } = useSlideStore.getState()
  if (!presentation) return []

  const items: PendingItem[] = []
  for (const page of presentation.pages) {
    for (const el of page.elements) {
      if (
        el.type === 'image' &&
        (el as PPTImageElement).offlinePendingUpload &&
        (el as PPTImageElement).src.startsWith('data:')
      ) {
        items.push({ elementId: el.id, src: (el as PPTImageElement).src })
      }
    }
  }
  return items
}

async function reuploadItem(
  item: PendingItem,
  uploadFn: (file: File) => Promise<string>,
): Promise<boolean> {
  try {
    const file = dataUriToFile(item.src)
    const url = await uploadFn(file)
    if (!url) return false

    useSlideStore.setState((state) => {
      if (!state.presentation) return state

      let found = false
      const pages = state.presentation.pages.map((page) => {
        const idx = page.elements.findIndex((e) => e.id === item.elementId)
        if (idx === -1) return page

        const el = page.elements[idx]
        if (el.type !== 'image' || !(el as PPTImageElement).offlinePendingUpload) return page

        found = true
        const { offlinePendingUpload: _, ...rest } = el as PPTImageElement
        const elements: PPTElement[] = [...page.elements]
        elements[idx] = { ...rest, src: url } as PPTImageElement
        return { ...page, elements }
      })

      if (!found) return state
      return {
        ...state,
        presentation: { ...state.presentation, pages },
        isDirty: true,
        saveStatus: 'unsaved' as const,
        saveError: null,
      }
    })

    return true
  } catch {
    return false
  }
}

export interface ReuploadResult {
  success: number
  total: number
}

/**
 * Re-upload all offline-cached base64 images in the slide presentation.
 * Runs serially to avoid concurrent store mutations.
 *
 * @param uploadFn  Upload a File and return its remote URL.
 * @param scheduleSave  Optional callback invoked after at least one image is
 *                      successfully re-uploaded, so the host can persist the
 *                      updated presentation to the server.
 */
export async function reuploadOfflineImages(
  uploadFn: (file: File) => Promise<string>,
  scheduleSave?: () => void,
): Promise<ReuploadResult> {
  const items = collectPendingItems()
  if (items.length === 0) return { success: 0, total: 0 }

  let successCount = 0
  for (const item of items) {
    const ok = await reuploadItem(item, uploadFn)
    if (ok) successCount++
  }

  if (successCount > 0 && scheduleSave) {
    scheduleSave()
  }

  return { success: successCount, total: items.length }
}
