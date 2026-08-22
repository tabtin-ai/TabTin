import type { TabdocDocument } from '@tabtin/tabdoc-ui/api-client'
import type { ResourceWsEvent } from '@/stores/useUnifiedResources'

export const TABDOC_RESOURCE_TYPE = 'tabdoc'

function isNewerUpdatedAt(nextUpdatedAt: string, currentUpdatedAt: string | null | undefined): boolean {
  if (!currentUpdatedAt) return true
  const nextTime = Date.parse(nextUpdatedAt)
  const currentTime = Date.parse(currentUpdatedAt)
  if (!Number.isFinite(nextTime) || !Number.isFinite(currentTime)) {
    return nextUpdatedAt !== currentUpdatedAt
  }
  return nextTime > currentTime
}

function isUnsignedLocalObjectUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.pathname.endsWith('/api/services/oss/local-object') && !url.searchParams.has('signature')
  } catch {
    return false
  }
}

export function buildTabDocDocumentPatchFromResourceEvent(
  event: ResourceWsEvent,
  currentDocument?: Pick<TabdocDocument, 'updated_at' | 'cover_image'> | null,
): Partial<TabdocDocument> | null {
  if (event.type !== 'resource_updated') return null
  if (typeof event.updated_at === 'string' && !isNewerUpdatedAt(event.updated_at, currentDocument?.updated_at)) {
    return null
  }

  const patch: Partial<TabdocDocument> = {}
  if (typeof event.title === 'string') {
    patch.title = event.title
  }
  if (event.status === 'active' || event.status === 'archived') {
    patch.status = event.status
  }
  if (typeof event.updated_at === 'string') {
    patch.updated_at = event.updated_at
  }

  const metadata = event.metadata
  if (metadata && typeof metadata === 'object') {
    if (metadata.parent_id === null || typeof metadata.parent_id === 'string') {
      patch.parent_id = metadata.parent_id
    }
    if (typeof metadata.icon === 'string') {
      patch.icon = metadata.icon
    }
    if (
      typeof metadata.cover_image === 'string'
      && !(isUnsignedLocalObjectUrl(metadata.cover_image) && currentDocument?.cover_image)
    ) {
      patch.cover_image = metadata.cover_image
    }
    if (Array.isArray(metadata.tags) && metadata.tags.every(tag => typeof tag === 'string')) {
      patch.tags = metadata.tags
    }
  }

  return Object.keys(patch).length > 0 ? patch : null
}
