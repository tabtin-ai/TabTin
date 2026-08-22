/**
 * 预览 Lightbox 下载：跨域 URL 上 `<a download>` 会被 Chromium 忽略，
 * 必须走主进程 / blob 落盘，并给用户明确反馈（成功 + 打开位置）。
 *
 * 打包态（origin=`tabtin-file://app`，webSecurity=true，生产 CSP connect-src
 * 白名单）下，renderer 裸 `fetch(https://…)` 常被 CSP/CORS 拦截。
 * http(s) 只走主进程 `downloadResource`；blob/data/tabtin-file 才允许 renderer fetch。
 */

import { createElement } from 'react'
import { toast, ToastAction } from '@tabtin/smartsheet-ui'
import type { TFunction } from 'i18next'
import { saveExportBlob } from '@/services/tableCoreRuntime'
import { createLogger } from '@/utils/logger'
import { svgCodeToPngBlob } from '../richContent/widget/svgCodeToPngBlob'
import { resolveOssFileAccessUrl } from './resolveOssFileAccessUrl'
import type { PreviewResource } from './types'

const log = createLogger('PreviewDownload')

/** renderer 可读、且不依赖生产 CSP connect-src 白名单的 URL */
export function isRendererReadableDownloadUrl(url: string): boolean {
  return (
    url.startsWith('blob:') ||
    url.startsWith('data:') ||
    url.startsWith('tabtin-file:')
  )
}

export function isRemoteHttpDownloadUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

async function downloadViaMainProcess(url: string, fileName: string): Promise<string | null> {
  const downloadResource = window.tabtin?.resourceDetection?.downloadResource
  if (!downloadResource) return null

  const result = await downloadResource({ url, filename: fileName })
  if (!result?.success || !result.data?.filePath) {
    throw new Error(result?.error || 'downloadResource failed')
  }
  return result.data.filePath as string
}

async function downloadRemoteResource(
  url: string,
  fileName: string,
  fileId?: string,
): Promise<string | null> {
  try {
    return await downloadViaMainProcess(url, fileName)
  } catch (initialError) {
    if (!fileId) throw initialError
    const freshUrl = await resolveOssFileAccessUrl(fileId, { forceRefresh: true })
    return downloadViaMainProcess(freshUrl, fileName)
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Failed to encode blob as data URL'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * blob/data 落盘：优先主进程静默写入 ~/Downloads/TabTin（与 https 一致）；
 * 主进程不可用时才回退 saveExportBlob（会弹系统「存储为」）。
 */
async function persistBlob(blob: Blob, fileName: string) {
  if (blob.size <= 0) {
    throw new Error('Empty download payload')
  }

  try {
    const dataUrl = await blobToDataUrl(blob)
    const mainPath = await downloadViaMainProcess(dataUrl, fileName || 'download')
    if (mainPath) {
      return { kind: 'saved' as const, path: mainPath }
    }
  } catch (err) {
    log.warn('silent main-process blob save failed, falling back to save dialog:', err)
  }

  const saveResult = await saveExportBlob(blob, fileName || 'download')
  if (saveResult.status === 'cancelled') {
    return { kind: 'cancelled' as const }
  }
  if (saveResult.status === 'saved') {
    return { kind: 'saved' as const, path: saveResult.path }
  }
  return { kind: 'fallback' as const }
}

async function downloadViaBlob(url: string, fileName: string) {
  if (!isRendererReadableDownloadUrl(url)) {
    throw new Error('Remote URL requires main-process download')
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const blob = await response.blob()
  return persistBlob(blob, fileName)
}

function showSavedToast(fileName: string, filePath: string | undefined, t: TFunction<'chat'>) {
  const message = t('preview.downloadSuccess', {
    defaultValue: '已下载 {{name}}',
    name: fileName,
  })
  const showInFolder = window.tabtin?.showItemInFolder
  if (filePath && showInFolder) {
    const label = t('preview.showInFolder', { defaultValue: '打开文件位置' })
    toast.success(message, {
      description: t('preview.downloadSavedTo', {
        defaultValue: '已保存到本地',
        path: filePath,
      }),
      action: createElement(
        ToastAction,
        {
          altText: label,
          onClick: () => {
            void showInFolder(filePath)
          },
        },
        label,
      ),
      duration: 8000,
    })
    return
  }
  toast.success(message)
}

function showDownloadFailedToast(fileName: string, t: TFunction<'chat'>) {
  toast.error(
    t('preview.downloadFailed', {
      defaultValue: '下载失败：{{name}}',
      name: fileName,
    }),
  )
}

export type PreviewDownloadResult = 'saved' | 'cancelled' | 'failed'

/** 下载预览资源并 toast 反馈；成功时可一键打开所在文件夹。 */
export async function downloadPreviewResource(params: {
  url: string
  fileName: string
  t: TFunction<'chat'>
  fileId?: string
}): Promise<PreviewDownloadResult> {
  const { url, fileName, t, fileId } = params
  const safeName = fileName?.trim() || 'download'

  if (!url) {
    toast.error(t('preview.downloadFailed', { defaultValue: '下载失败', name: safeName }))
    return 'failed'
  }

  toast({
    title: t('preview.downloadStarted', {
      defaultValue: '正在下载 {{name}}…',
      name: safeName,
    }),
  })

  const remoteHttp = isRemoteHttpDownloadUrl(url)

  // 主进程 ClientRequest 只支持 http(s)；blob/data/tabtin-file 直接走 renderer 落盘（ 0KB）
  if (remoteHttp) {
    try {
      const mainPath = await downloadRemoteResource(url, safeName, fileId)
      if (mainPath) {
        showSavedToast(safeName, mainPath, t)
        return 'saved'
      }
      log.error('downloadResource unavailable for remote URL')
      showDownloadFailedToast(safeName, t)
      return 'failed'
    } catch (err) {
      // ：勿再走 renderer fetch(https)——CSP/CORS 在 packaged 下会二次失败
      log.error('download failed (remote, no renderer fallback):', err)
      showDownloadFailedToast(safeName, t)
      return 'failed'
    }
  }

  try {
    const blobResult = await downloadViaBlob(url, safeName)
    if (blobResult.kind === 'cancelled') {
      toast({
        title: t('preview.downloadCancelled', { defaultValue: '已取消下载' }),
      })
      return 'cancelled'
    }
    if (blobResult.kind === 'saved') {
      showSavedToast(safeName, blobResult.path, t)
      return 'saved'
    }
    // browser fallback：无法拿到路径，仍提示已触发下载
    toast.success(
      t('preview.downloadTriggered', {
        defaultValue: '已开始下载 {{name}}（请到浏览器/系统下载目录查看）',
        name: safeName,
      }),
    )
    return 'saved'
  } catch (err) {
    log.error('download failed:', err)
    showDownloadFailedToast(safeName, t)
    return 'failed'
  }
}

/**
 * 内存中已有 Blob/二进制时直接落盘，避免再绕 blob: URL → 主进程 net.request。
 */
export async function downloadPreviewBlob(params: {
  blob: Blob
  fileName: string
  t: TFunction<'chat'>
}): Promise<PreviewDownloadResult> {
  const { blob, fileName, t } = params
  const safeName = fileName?.trim() || 'download'

  if (!blob || blob.size <= 0) {
    showDownloadFailedToast(safeName, t)
    return 'failed'
  }

  toast({
    title: t('preview.downloadStarted', {
      defaultValue: '正在下载 {{name}}…',
      name: safeName,
    }),
  })

  try {
    const blobResult = await persistBlob(blob, safeName)
    if (blobResult.kind === 'cancelled') {
      toast({
        title: t('preview.downloadCancelled', { defaultValue: '已取消下载' }),
      })
      return 'cancelled'
    }
    if (blobResult.kind === 'saved') {
      showSavedToast(safeName, blobResult.path, t)
      return 'saved'
    }
    toast.success(
      t('preview.downloadTriggered', {
        defaultValue: '已开始下载 {{name}}（请到浏览器/系统下载目录查看）',
        name: safeName,
      }),
    )
    return 'saved'
  } catch (err) {
    log.error('blob download failed:', err)
    showDownloadFailedToast(safeName, t)
    return 'failed'
  }
}

/**
 * 图示卡下载：优先烤图 URL；否则 SVG/Mermaid 转 PNG 落盘；HTML 无可靠静态图则提示不可用。
 */
export async function downloadWidgetPreview(params: {
  resource: PreviewResource
  t: TFunction<'chat'>
}): Promise<PreviewDownloadResult> {
  const { resource, t } = params
  const safeName = (resource.name?.trim() || 'widget').replace(/\.[^.]+$/, '') + '.png'
  const imageUrl = resource.imageUrl || resource.url

  if (imageUrl) {
    return downloadPreviewResource({ url: imageUrl, fileName: safeName, t })
  }

  if (resource.format === 'html') {
    toast.error(
      t('preview.widgetDownloadHtmlUnsupported', {
        defaultValue: 'HTML 图示暂不支持下载为图片，请右键复制源码或在新窗口打开',
      }),
    )
    return 'failed'
  }

  const code = resource.code?.trim()
  if (!code) {
    toast.error(t('preview.downloadFailed', { defaultValue: '下载失败', name: safeName }))
    return 'failed'
  }

  toast({
    title: t('preview.downloadStarted', {
      defaultValue: '正在下载 {{name}}…',
      name: safeName,
    }),
  })

  try {
    const isDark = document.documentElement.classList.contains('dark')
    const blob = await svgCodeToPngBlob(code, isDark ? 'dark' : 'light')
    if (!blob) {
      toast.error(
        t('preview.widgetDownloadConvertFailed', {
          defaultValue: '图示转图片失败，请稍后重试',
        }),
      )
      return 'failed'
    }
    const saveResult = await saveExportBlob(blob, safeName)
    if (saveResult.status === 'cancelled') {
      toast({
        title: t('preview.downloadCancelled', { defaultValue: '已取消下载' }),
      })
      return 'cancelled'
    }
    if (saveResult.status === 'saved') {
      showSavedToast(safeName, saveResult.path, t)
      return 'saved'
    }
    toast.success(
      t('preview.downloadTriggered', {
        defaultValue: '已开始下载 {{name}}（请到浏览器/系统下载目录查看）',
        name: safeName,
      }),
    )
    return 'saved'
  } catch (err) {
    log.error('widget download failed:', err)
    showDownloadFailedToast(safeName, t)
    return 'failed'
  }
}
