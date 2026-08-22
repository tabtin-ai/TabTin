/**
 * TabData 附件下载（Electron）
 *
 * 禁止 `<a target=_blank>`：跨域 download 无效，且会被主窗口
 * setWindowOpenHandler 转到系统浏览器。
 * 单文件复用 downloadPreviewResource；全部下载并发走主进程 downloadResource
 * （保留原始文件名；downloadBatch IPC 不带 per-url filename）。
 */

import { createElement } from 'react'
import { toast, ToastAction } from '@tabtin/smartsheet-ui'
import type { TFunction } from 'i18next'
import type { TableGridAttachmentDownloadItem } from '@tabtin/table-engine'
import type { TableGridAttachmentAccessContext } from '@tabtin/table-engine'
import { AttachmentApiService } from '@tabtin/table-core'
import { createLogger } from '@/utils/logger'
import { downloadPreviewResource } from '@components/chat/preview/downloadPreviewResource'

const log = createLogger('TabDataAttachmentDownload')

const DOWNLOAD_ALL_CONCURRENCY = 3

async function resolveDownloadUrl(
  item: TableGridAttachmentDownloadItem,
  baseContext?: TableGridAttachmentAccessContext,
): Promise<string> {
  const context = { ...baseContext, ...item.accessContext }
  if (!item.fileId || !context.tableId) {
    return item.url
  }
  const result = await AttachmentApiService.resolveAccessUrl({
    file_id: item.fileId,
    table_id: context.tableId,
    field_id: context.fieldId,
    record_id: context.recordId,
    reference_id: context.referenceId,
  })
  return result.url
}

async function downloadViaMainProcess(
  url: string,
  fileName: string,
): Promise<string | null> {
  const downloadResource = window.tabtin?.resourceDetection?.downloadResource
  if (!downloadResource) return null
  const result = await downloadResource({ url, filename: fileName })
  if (!result?.success || !result.data?.filePath) {
    throw new Error(result?.error || 'downloadResource failed')
  }
  return result.data.filePath as string
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await worker(items[index], index)
      }
    },
  )
  await Promise.all(runners)
  return results
}

export async function downloadTabDataAttachment(
  item: TableGridAttachmentDownloadItem,
  t: TFunction<'chat'>,
  accessContext?: TableGridAttachmentAccessContext,
): Promise<void> {
  const url = await resolveDownloadUrl(item, accessContext)
  await downloadPreviewResource({
    url,
    fileName: item.name,
    t,
    fileId: item.fileId,
  })
}

export async function downloadTabDataAttachmentsBatch(
  items: TableGridAttachmentDownloadItem[],
  t: TFunction<'chat'>,
  accessContext?: TableGridAttachmentAccessContext,
): Promise<void> {
  if (items.length === 1) {
    await downloadTabDataAttachment(items[0], t, accessContext)
    return
  }
  const targets = (
    await Promise.all(items.map(async (item) => {
      if (!item.fileId) return item
      try {
        return {
          ...item,
          url: await resolveDownloadUrl(item, accessContext),
        }
      } catch {
        return item
      }
    }))
  ).filter((item) => Boolean(item.url))
  if (targets.length === 0) return

  toast({
    title: t('preview.downloadStarted', {
      defaultValue: '正在下载 {{name}}…',
      name: t('preview.downloadAllLabel', {
        defaultValue: '{{count}} 个文件',
        count: targets.length,
      }),
    }),
  })

  const settled = await mapWithConcurrency(
    targets,
    DOWNLOAD_ALL_CONCURRENCY,
    async (item) => {
      try {
        const path = await downloadViaMainProcess(
          item.url,
          item.name?.trim() || 'download',
        )
        if (!path) {
          throw new Error('downloadResource unavailable')
        }
        return { ok: true as const, name: item.name, path }
      } catch (err) {
        log.error('batch item failed', {
          name: item.name,
          error: err instanceof Error ? err.message : String(err),
        })
        return { ok: false as const, name: item.name }
      }
    },
  )

  const succeeded = settled.filter((item) => item.ok)
  const failed = settled.length - succeeded.length
  const firstPath = succeeded.find((item) => item.path)?.path

  if (succeeded.length > 0) {
    const message = t('preview.downloadBatchSuccess', {
      defaultValue: '已下载 {{ok}} / {{total}} 个文件',
      ok: succeeded.length,
      total: targets.length,
    })
    const showInFolder = window.tabtin?.showItemInFolder
    if (firstPath && showInFolder) {
      const label = t('preview.showInFolder', { defaultValue: '打开文件位置' })
      toast.success(message, {
        action: createElement(
          ToastAction,
          {
            altText: label,
            onClick: () => {
              void showInFolder(firstPath)
            },
          },
          label,
        ),
        duration: 8000,
      })
    } else {
      toast.success(message)
    }
  }

  if (failed > 0) {
    toast.error(
      t('preview.downloadBatchFailed', {
        defaultValue: '{{count}} 个文件下载失败',
        count: failed,
      }),
    )
  }
}
