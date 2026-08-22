import { createElement } from 'react'
import { toast, ToastAction } from '@tabtin/smartsheet-ui'
import type { TFunction } from 'i18next'
import { saveExportBlob } from '@/services/tableCoreRuntime'

function isRendererReadableDownloadUrl(url: string): boolean {
  return (
    url.startsWith('blob:') ||
    url.startsWith('data:') ||
    url.startsWith('tabtin-file:')
  )
}

function isRemoteHttpDownloadUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

async function downloadViaMainProcess(url: string, fileName: string) {
  const downloadResource = window.tabtin?.resourceDetection?.downloadResource
  if (!downloadResource) return null

  const result = await downloadResource({ url, filename: fileName })
  if (!result?.success || !result.data?.filePath) {
    throw new Error(result?.error || 'downloadResource failed')
  }
  return result.data.filePath as string
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

async function persistBlob(blob: Blob, fileName: string) {
  // 与 Agent 预览 downloadPreviewResource 对齐：优先静默落 ~/Downloads/TabTin
  try {
    const dataUrl = await blobToDataUrl(blob)
    const mainPath = await downloadViaMainProcess(dataUrl, fileName || 'download')
    if (mainPath) {
      return { kind: 'saved' as const, path: mainPath }
    }
  } catch (err) {
    console.warn('[TabChat] Silent blob save failed, falling back to save dialog:', err)
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

function showSavedToast(fileName: string, filePath: string | undefined, t: TFunction) {
  const tabtin = window.tabtin
  const message = t('fileDownloadSuccess', { fileName })
  if (filePath && tabtin?.showItemInFolder) {
    const label = t('fileDownloadShowInFolder')
    toast.success(message, {
      action: createElement(
        ToastAction,
        {
          altText: label,
          onClick: () => {
            void tabtin.showItemInFolder?.(filePath)
          },
        },
        label,
      ),
      duration: 6000,
    })
    return
  }
  toast.success(message)
}

/** 下载 IM 附件并在 Electron 内给出明确反馈 */
export async function downloadImAttachment(params: {
  url: string
  fileName: string
  t: TFunction
}): Promise<
  | { status: 'saved'; path?: string }
  | { status: 'cancelled' }
  | { status: 'failed' }
> {
  const { url, fileName, t } = params
  const safeName = fileName || 'download'
  const remoteHttp = isRemoteHttpDownloadUrl(url)

  try {
    const mainPath = await downloadViaMainProcess(url, safeName)
    if (mainPath) {
      showSavedToast(safeName, mainPath, t)
      return { status: 'saved', path: mainPath }
    }
    if (remoteHttp) {
      toast({
        title: t('fileDownloadFailed'),
        description: t('fileUnavailableDesc'),
        variant: 'destructive',
      })
      return { status: 'failed' }
    }
  } catch (err) {
    console.warn('[TabChat] Main-process download failed, falling back:', err)
    if (remoteHttp) {
      // ：打包态勿裸 fetch 远程 URL
      console.error('[TabChat] Attachment download failed (remote, no renderer fallback):', err)
      toast({
        title: t('fileDownloadFailed'),
        description: t('fileUnavailableDesc'),
        variant: 'destructive',
      })
      return { status: 'failed' }
    }
  }

  try {
    const blobResult = await downloadViaBlob(url, safeName)
    if (blobResult.kind === 'cancelled') return { status: 'cancelled' }
    if (blobResult.kind === 'saved') {
      showSavedToast(safeName, blobResult.path, t)
      return { status: 'saved', path: blobResult.path }
    }
    toast.success(t('fileDownloadStarted', { fileName: safeName }))
    return { status: 'saved' }
  } catch (err) {
    console.error('[TabChat] Attachment download failed:', err)
    toast({
      title: t('fileDownloadFailed'),
      description: t('fileUnavailableDesc'),
      variant: 'destructive',
    })
    return { status: 'failed' }
  }
}
