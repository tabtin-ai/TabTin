import { useEffect, useMemo } from 'react'
import { useScopedUnifiedResources, useUnifiedResources } from '@/stores/useUnifiedResources'
import type { SpaceContextItem as ContextItem } from '@/services/spaceApi'
import { useSpaceViewPrefsStore, type ResourceScope } from '@stores/useSpaceViewPrefsStore'
import { getEffectiveScopeForResourceType } from '@/components/context-space/resourceScope'

/**
 * 按 item_type 从 useUnifiedResources 筛选资源，自带 useMemo 缓存。
 *
 * 当 WS 推送 resource_created / resource_updated / resource_archived 时，
 * useUnifiedResources.resources 会更新 → 此 hook 自动返回最新的过滤结果。
 */
export function useResourcesByType(spaceId: string, type: string): {
  items: ContextItem[]
  isLoading: boolean
  error: string | null
  scope: ResourceScope
} {
  const requestedScope = useSpaceViewPrefsStore(s => s.getPrefs(spaceId).resourceScope)
  const scope = getEffectiveScopeForResourceType(requestedScope, type)
  const { resources, isLoading, error } = useScopedUnifiedResources(spaceId, scope)
  const loadResources = useUnifiedResources(s => s.load)

  useEffect(() => {
    if (!spaceId || scope !== 'organization') return
    void loadResources(spaceId, false, 'organization')
  }, [loadResources, scope, spaceId])

  const items = useMemo(
    () => resources.filter((r) => r.item_type === type && !r.is_archived),
    [resources, type],
  )

  return { items, isLoading, error, scope }
}
