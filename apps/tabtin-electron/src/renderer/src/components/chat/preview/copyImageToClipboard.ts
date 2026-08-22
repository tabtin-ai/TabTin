/**
 * 将远程 / 本地图片写入系统剪贴板（image/png）。
 *
 * 远程 http(s) 经 attachmentBlobCache → 主进程 fetchBuffer，避开生产 CSP/CORS；
 * 最终由 Electron 主进程原生剪贴板写入，避免 Chromium 异步 ClipboardItem
 * 在下载完成前丢失用户手势。
 */

import { createLogger } from '@/utils/logger'
import { getAttachmentBuffer } from './attachmentBlobCache'
import { resolveOssFileAccessUrl } from './resolveOssFileAccessUrl'

const log = createLogger('CopyImageClipboard')

/**
 * 图片下载/缓存完成后交给主进程写入系统剪贴板。
 */
export async function copyImageToClipboard(opts: {
  url: string
  fileId?: string
}): Promise<void> {
  const { url, fileId } = opts
  if (!url) throw new Error('Missing image url')
  const writeImage = window.tabtin?.clipboard?.writeImage
  if (!writeImage) {
    throw new Error('Clipboard image write unsupported')
  }

  try {
    const buffer = await getAttachmentBuffer({
      fileId,
      url,
      resolveFreshUrl: fileId
        ? () => resolveOssFileAccessUrl(fileId, { forceRefresh: true })
        : undefined,
    })
    const result = await writeImage(buffer)
    if (!result?.success) throw new Error(result?.error || 'clipboard write failed')
  } catch (error) {
    log.warn('clipboard.write image failed', {
      fileId: fileId || undefined,
      reason: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
