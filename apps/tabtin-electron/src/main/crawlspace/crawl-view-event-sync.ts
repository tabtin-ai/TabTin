import type { CrawlViewEventData, CrawlViewExternalListener } from '../crawl-view-events'
import { syncWorkspaceViewMetadata } from './view-metadata-sync'

type RegisterExternalListener = (listener: CrawlViewExternalListener) => (() => void) | undefined

export function connectCrawlspaceViewEventSync(
  registerExternalListener: RegisterExternalListener,
): (() => void) | undefined {
  return registerExternalListener((event: CrawlViewEventData) => {
    const viewId = event.data?.viewId as string | undefined
    if (!viewId) {
      return
    }

    if (event.type === 'theme-color:changed') {
      syncWorkspaceViewMetadata({
        viewId,
        themeColor: event.data?.themeColor ?? null,
      })
    }
  })
}
