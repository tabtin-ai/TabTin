import {
  deriveFilenameFromOpenIntentUrl,
  resolveOpenIntent,
} from '@shared/open-intent'
import { useResourcePreviewStore } from './useResourcePreviewStore'
import type { PreviewResource } from './types'

export interface LegacyFilePreviewInput {
  url?: string
  filename?: string
  mimeType?: string
  size?: number
  fileId?: string
}

/**
 * Compatibility adapter for legacy chat file blocks that only carry a direct
 * URL. The URL is used as a binary preview source, not as a browser navigation
 * target. AssetReference-backed preview/download endpoints should be resolved
 * here as they become available.
 *
 * Judgment uses shared `resolveOpenIntent`; this function only maps to PreviewResource.
 */
export function resolveLegacyFilePreviewResource(input: LegacyFilePreviewInput): PreviewResource | null {
  const url = input.url?.trim()
  if (!url) return null

  const intent = resolveOpenIntent({
    url,
    filename: input.filename,
    mimeType: input.mimeType,
    assetId: input.fileId,
  })
  if (intent.kind !== 'preview') return null

  const name = input.filename?.trim() || deriveFilenameFromOpenIntentUrl(url)
  return {
    id: `legacy-file:${input.fileId || url}`,
    kind: intent.previewKind,
    url,
    name,
    mimeType: input.mimeType,
    size: input.size,
    fileId: input.fileId,
  }
}

/**
 * Unified intercept for direct https/blob/data file URLs that must open in the
 * chat preview modal (xlsx/xls/csv/pdf/image/…) instead of tabweb BrowserView.
 *
 * Returns true when the preview modal was opened; callers should skip
 * ResourceRouter / openExternal in that case.
 *
 * Open/side-effect stays here; judgment is `resolveOpenIntent`.
 */
export function tryOpenPreviewableDirectUrl(
  href: string,
  options?: Omit<LegacyFilePreviewInput, 'url'>,
): boolean {
  const resource = resolveLegacyFilePreviewResource({
    url: href,
    filename: options?.filename,
    mimeType: options?.mimeType,
    size: options?.size,
    fileId: options?.fileId,
  })
  if (!resource) return false
  return useResourcePreviewStore.getState().open([resource], 0)
}
