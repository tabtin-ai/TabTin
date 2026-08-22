import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import type { ResourceMonitorTrackedItem } from './model'

/** 与 notificationNavigation 一致：跳转前先退出全屏设置，避免目标被设置页遮挡。 */
export function closeSettingsForResourceMonitorNavigation(): void {
  const settings = useSettingsSpaceStore.getState()
  if (settings.isOpen) {
    settings.closeSettings()
  }
}

export function resolveCrawlspaceIdForItem(item: ResourceMonitorTrackedItem): string | null {
  if (item.crawlspaceId) return item.crawlspaceId
  if (!item.spaceId) return null
  return useCrawlTabStore.getState().getSpaceCrawlspace?.(item.spaceId)?.id ?? null
}
