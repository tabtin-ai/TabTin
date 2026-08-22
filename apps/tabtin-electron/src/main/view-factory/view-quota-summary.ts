/**
 * view-quota-summary — View 配额占用摘要（纯函数）
 *
 * 供 QUOTA_EXCEEDED 错误 detail.quota 填充：used、by_profile、reclaimable。
 * 只消费只读快照，不依赖 Electron / ViewFactory 运行时。
 */

import { isQuotaReclaimableProfile } from './lifecycle'

export type ViewQuotaProfile =
  | 'user-tab'
  | 'agent-workspace'
  | 'background-task'
  | 'temporary-preview'
  | string

export interface ViewQuotaSnapshotItem {
  viewId: string
  profile: ViewQuotaProfile
  title?: string
  url?: string
  crawlspaceId?: string
  discarded?: boolean
}

export interface ViewQuotaSummary {
  limit: number
  used: number
  cleaned: number
  by_profile: Record<string, number>
  reclaimable: Array<{
    viewId: string
    profile: string
    title?: string
    url?: string
    in_current_space: boolean
  }>
}

function isInCurrentSpace(
  itemCrawlspaceId: string | undefined,
  currentCrawlspaceId: string | null | undefined,
): boolean {
  if (currentCrawlspaceId == null || currentCrawlspaceId === '') {
    return false
  }
  return itemCrawlspaceId === currentCrawlspaceId
}

function toReclaimableEntry(
  item: ViewQuotaSnapshotItem,
  currentCrawlspaceId?: string | null,
): ViewQuotaSummary['reclaimable'][number] {
  return {
    viewId: item.viewId,
    profile: item.profile,
    title: item.title,
    url: item.url,
    in_current_space: isInCurrentSpace(item.crawlspaceId, currentCrawlspaceId),
  }
}

export function buildViewQuotaSummary(input: {
  limit: number
  cleaned: number
  items: ViewQuotaSnapshotItem[]
  currentCrawlspaceId?: string | null
  reclaimableLimit?: number
}): ViewQuotaSummary {
  const {
    limit,
    cleaned,
    items,
    currentCrawlspaceId,
    reclaimableLimit = 10,
  } = input

  const activeItems = items.filter(item => !item.discarded)
  const used = activeItems.length

  const by_profile: Record<string, number> = {}
  for (const item of activeItems) {
    by_profile[item.profile] = (by_profile[item.profile] ?? 0) + 1
  }

  const reclaimable: ViewQuotaSummary['reclaimable'] = []

  for (const item of activeItems) {
    if (reclaimable.length >= reclaimableLimit) break
    if (item.profile === 'user-tab') continue
    if (!isQuotaReclaimableProfile(item.profile)) continue
    reclaimable.push(toReclaimableEntry(item, currentCrawlspaceId))
  }

  if (reclaimable.length < reclaimableLimit) {
    for (const item of activeItems) {
      if (reclaimable.length >= reclaimableLimit) break
      if (item.profile !== 'user-tab') continue
      reclaimable.push(toReclaimableEntry(item, currentCrawlspaceId))
    }
  }

  return {
    limit,
    used,
    cleaned,
    by_profile,
    reclaimable,
  }
}
