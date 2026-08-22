import type { RendererCrawlspaceViewMetaUpdates } from '@shared/types/crawlspace'

export function normalizeRendererViewMetaUpdates(
  updates: unknown,
): RendererCrawlspaceViewMetaUpdates | null {
  if (!updates || typeof updates !== 'object') {
    return null
  }

  const candidate = updates as Record<string, unknown>
  const payload: RendererCrawlspaceViewMetaUpdates = {}

  if (typeof candidate.runId === 'string') {
    payload.runId = candidate.runId
  }
  if (typeof candidate.isPreview === 'boolean') {
    payload.isPreview = candidate.isPreview
  }

  return Object.keys(payload).length > 0 ? payload : null
}
