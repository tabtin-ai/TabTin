import { saveExportBlob, type SaveExportResult } from '@/services/tableCoreRuntime'

const WINDOWS_RESERVED_DOWNLOAD_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i
const MAX_DOWNLOAD_FILENAME_LENGTH = 200

export function sanitizeTabdocExportFilename(filename: string): string {
  let sanitized = filename
    .replace(/[\x00-\x1f/\\?%*:|"<>]/g, '_')
    .replace(/\.{2,}/g, '.')
  if (WINDOWS_RESERVED_DOWNLOAD_NAME_RE.test(sanitized)) {
    sanitized = `_${sanitized}`
  }
  if (sanitized.length > MAX_DOWNLOAD_FILENAME_LENGTH) {
    const dotIndex = sanitized.lastIndexOf('.')
    const ext = dotIndex > 0 ? sanitized.slice(dotIndex) : ''
    sanitized = sanitized.slice(0, Math.max(0, MAX_DOWNLOAD_FILENAME_LENGTH - ext.length)) + ext
  }
  return sanitized || 'download'
}

export function saveTabdocExportBlob(blob: Blob, filename: string): Promise<SaveExportResult> {
  return saveExportBlob(blob, sanitizeTabdocExportFilename(filename))
}
