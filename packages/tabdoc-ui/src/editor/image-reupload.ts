/**
 * Tabdoc image re-upload handler (host-agnostic).
 *
 * Scans the editor for images with base64 data URLs (from offline fallback)
 * and re-uploads them when connectivity is restored.
 */
import type { EditorInstance } from 'novel'
import { toast } from '@tabtin/smartsheet-ui'
import type { TabDocImageUploadPort } from '../ports'

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string

function dataUrlToFile(dataUrl: string, filename: string): File | null {
  try {
    const [meta, base64] = dataUrl.split(',')
    if (!meta || !base64) return null
    const mime = meta.match(/:(.*?);/)?.[1] ?? 'image/png'
    const bstr = atob(base64)
    const u8arr = new Uint8Array(bstr.length)
    for (let i = 0; i < bstr.length; i++) {
      u8arr[i] = bstr.charCodeAt(i)
    }
    return new File([u8arr], filename, { type: mime })
  } catch {
    return null
  }
}

export async function reuploadOfflineImages(
  editor: EditorInstance,
  documentId: string | undefined,
  port: TabDocImageUploadPort,
  t: TranslateFn,
): Promise<number> {
  if (!editor?.view) return 0

  const { doc, tr } = editor.state
  const pendingPositions: { pos: number; src: string }[] = []

  doc.descendants((node, pos) => {
    if (node.type.name === 'image' && typeof node.attrs.src === 'string') {
      const src = node.attrs.src as string
      if (src.startsWith('data:image/')) {
        pendingPositions.push({ pos, src })
      }
    }
  })

  if (pendingPositions.length === 0) return 0

  let count = 0

  for (const { pos, src } of pendingPositions) {
    const file = dataUrlToFile(src, `reupload-${Date.now()}.png`)
    if (!file) continue

    try {
      const result = await port.upload(file, {
        folder: 'tabdoc/images',
        module: 'tabdoc',
        contextType: 'document',
        contextId: documentId,
      })
      if (result.url) {
        const currentNode = tr.doc.nodeAt(pos)
        if (currentNode?.type.name === 'image' && currentNode.attrs.src === src) {
          tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, src: result.url })
          count++
        }
      }
    } catch (err) {
      console.warn('[tabdoc] failed to re-upload offline image:', err)
    }
  }

  if (count > 0) {
    editor.view.dispatch(tr)
    toast({
      title: t('imageReuploadSuccess', { defaultValue: `${count} 张离线图片已重新上传` }),
    })
  }

  return count
}
