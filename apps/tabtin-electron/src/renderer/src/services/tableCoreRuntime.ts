/**
 * Electron 平台文件保存工具
 * saveExportBlob 优先使用原生保存对话框，失败时降级为浏览器下载
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('TableExport')

export type SaveExportResult =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  | { status: 'fallback' }

export async function saveExportBlob(
  blob: Blob,
  filename: string,
): Promise<SaveExportResult> {
  const tabtin = window.tabtin
  if (!tabtin?.showSaveDialog || !tabtin?.fileSystem?.writeBinaryFile) {
    fallbackBrowserDownload(blob, filename)
    return { status: 'fallback' }
  }

  const filePath: string | undefined = await tabtin.showSaveDialog({
    defaultPath: filename,
    defaultDirectory: 'downloads',
    filters: getFiltersForFilename(filename),
  })
  if (!filePath) return { status: 'cancelled' }

  try {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const commaIdx = dataUrl.indexOf(',')
        if (commaIdx === -1) {
          reject(new Error('Invalid data URL from FileReader'))
          return
        }
        resolve(dataUrl.slice(commaIdx + 1))
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })

    const writeResult = await tabtin.fileSystem.writeBinaryFile(filePath, base64)
    if (writeResult?.success === false) {
      throw new Error(writeResult.error || 'Write failed')
    }

    return { status: 'saved', path: filePath }
  } catch (err) {
    log.error('save failed, falling back to browser download:', err)
    fallbackBrowserDownload(blob, filename)
    return { status: 'fallback' }
  }
}

const FORMAT_FILTERS: Record<string, { name: string; extensions: string[] }[]> = {
  csv: [{ name: 'CSV', extensions: ['csv'] }],
  xlsx: [{ name: 'Excel', extensions: ['xlsx'] }],
  json: [{ name: 'JSON', extensions: ['json'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  md: [{ name: 'Markdown', extensions: ['md'] }],
  markdown: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  html: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  htm: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  txt: [{ name: 'Text', extensions: ['txt'] }],
  docx: [{ name: 'Word', extensions: ['docx'] }],
}

function getFiltersForFilename(filename: string): { name: string; extensions: string[] }[] {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return FORMAT_FILTERS[ext] ?? [{ name: 'All Files', extensions: ['*'] }]
}

export const electronSaveBlob = (blob: Blob, filename: string): void => {
  saveExportBlob(blob, filename).catch((err) => {
    log.error('save failed, falling back to browser download:', err)
    fallbackBrowserDownload(blob, filename)
  })
}

const fallbackBrowserDownload = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
