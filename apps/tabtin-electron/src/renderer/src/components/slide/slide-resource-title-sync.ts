import type { SpaceContextItem } from '@/services/spaceApi'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useUnifiedResources } from '@/stores/useUnifiedResources'

/**
 * 将演示文稿名称即时回写到统一资源 store 与已打开 tab，避免依赖 WS 才更新标签文案。
 */
export function syncUnifiedResourceTitle(resourceId: string, title: string) {
  const normalizedId = resourceId?.trim()
  const normalizedTitle = title?.trim() ?? ''
  if (!normalizedId) return

  const { resources, resourcesBySpaceId } = useUnifiedResources.getState()
  let didUpdateResources = false
  let didUpdateBuckets = false

  const patchResource = (resource: SpaceContextItem): SpaceContextItem => {
    if ((resource.title || '').trim() === normalizedTitle) return resource
    return {
      ...resource,
      title: normalizedTitle,
      updated_at: new Date().toISOString(),
    }
  }

  const nextResources = resources.map(item => {
    if (item.resource_id !== normalizedId) return item
    const next = patchResource(item)
    if (next !== item) didUpdateResources = true
    return next
  })

  const nextResourcesBySpaceId: Record<string, SpaceContextItem[]> = {}
  for (const [cacheKey, bucket] of Object.entries(resourcesBySpaceId ?? {})) {
    let didUpdateBucket = false
    const nextBucket = bucket.map(resource => {
      if (resource.resource_id !== normalizedId) return resource
      const next = patchResource(resource)
      if (next !== resource) didUpdateBucket = true
      return next
    })
    if (didUpdateBucket) didUpdateBuckets = true
    nextResourcesBySpaceId[cacheKey] = didUpdateBucket ? nextBucket : bucket
  }

  if (didUpdateResources || didUpdateBuckets) {
    useUnifiedResources.setState({
      ...(didUpdateResources ? { resources: nextResources } : {}),
      ...(didUpdateBuckets ? { resourcesBySpaceId: nextResourcesBySpaceId } : {}),
    })
  }

  useSpaceContextTabsStore.getState().syncOpenResourceTabTitle({
    type: 'tabslide',
    id: normalizedId,
    title: normalizedTitle,
  })
}
