const PPTX_EXPORT_FORMAT = 'pptx'
const DOWNLOAD_LINK_CLEANUP_MS = 10_000
const PPTX_EXPORT_RETRY_CONFIG = {
  maxRetries: 2,
  retryDelay: 1000,
  retryBackoff: 2,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
}

export interface BackendPptxExportResult {
  downloadUrl: string
  filename: string
}

type ExportRequestFn = <T>(
  config: Record<string, unknown>,
  retryConfig?: Record<string, unknown>,
) => Promise<T>

export async function requestBackendPptxExport(
  projectId: string,
  request: ExportRequestFn,
): Promise<BackendPptxExportResult> {
  const result = await request<{ download_url?: unknown; filename?: unknown }>({
    method: 'POST',
    url: `/tabslide/projects/${projectId}/export/`,
    data: { format: PPTX_EXPORT_FORMAT },
  }, PPTX_EXPORT_RETRY_CONFIG)

  if (typeof result.download_url !== 'string' || result.download_url.trim() === '') {
    throw new Error('missing download_url')
  }

  const filename = typeof result.filename === 'string' && result.filename.trim()
    ? result.filename
    : `${projectId}.pptx`

  return {
    downloadUrl: result.download_url,
    filename,
  }
}

export function downloadFromUrl(downloadUrl: string, filename: string): void {
  const a = document.createElement('a')
  a.href = downloadUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
  }, DOWNLOAD_LINK_CLEANUP_MS)
}
