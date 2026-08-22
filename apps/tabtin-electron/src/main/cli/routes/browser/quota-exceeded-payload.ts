import {
  buildViewQuotaSummary,
  type ViewQuotaSnapshotItem,
  type ViewQuotaSummary,
} from '../../../view-factory/view-quota-summary'

const MISLEADING_TAB_LIST_SUGGESTION =
  '使用 tabtin browser tab list 查看已有标签并优先复用 --tab-id'

const CURRENT_SPACE_REUSE_SUGGESTION =
  '当前 Space 复用时用 tabtin browser tab list，再 open --tab-id'

export type BrowserQuotaExceededOptions = {
  detail: { quota: ViewQuotaSummary }
  suggestions: string[]
}

export function buildCloseQuotaSuggestions(
  reclaimable: ViewQuotaSummary['reclaimable'],
): string[] {
  if (reclaimable.length === 0) return []

  const ids = reclaimable.slice(0, 3).map(entry => entry.viewId)
  let suggestion = `使用 tabtin browser tab close --tab-id ${ids[0]} 关闭占用后重试`
  if (ids.length > 1) {
    suggestion += `（亦可关闭 ${ids.slice(1).join('、')}）`
  }
  return [suggestion]
}

export function buildBrowserQuotaExceededOptions(input: {
  limit: number
  cleaned?: number
  items: ViewQuotaSnapshotItem[]
  currentCrawlspaceId?: string | null
}): BrowserQuotaExceededOptions {
  const quota = buildViewQuotaSummary({
    limit: input.limit,
    cleaned: input.cleaned ?? 0,
    items: input.items,
    currentCrawlspaceId: input.currentCrawlspaceId,
  })

  const suggestions = [
    ...buildCloseQuotaSuggestions(quota.reclaimable),
    CURRENT_SPACE_REUSE_SUGGESTION,
  ]

  return {
    detail: { quota },
    suggestions,
  }
}

export { MISLEADING_TAB_LIST_SUGGESTION }
