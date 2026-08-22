export interface ResourceDetectionSummarySnapshot {
  total: number
  byCategory: Partial<Record<string, number>>
  byCaptureStatus?: Partial<Record<string, number>>
}

export interface CrawlspaceViewSnapshot {
  viewId: string
  title?: string
  url?: string
  favicon?: string
  runId?: string
  themeColor?: string
  isActive: boolean
  isClosing?: boolean
  isLoading?: boolean
  isPreview?: boolean
  /** 页面加载是否失败 */
  hasError?: boolean
  /** 错误描述（用于 UI 展示） */
  errorDescription?: string
  createdAt?: number
  updatedAt: number
  /** 检测到的网络资源统计摘要 */
  resourceSummary?: ResourceDetectionSummarySnapshot
}

export interface CrawlspaceContextSnapshot {
  crawlspaceId: string
  activeViewId?: string | null
  viewCount: number
  views: CrawlspaceViewSnapshot[]
  updatedAt: number
}

export type CrawlspaceContextDiffView = {
  viewId: string
  fields: {
    title?: string
    url?: string
    favicon?: string
    runId?: string
    themeColor?: string
    isLoading?: boolean
    isActive?: boolean
    isClosing?: boolean
    isPreview?: boolean
    hasError?: boolean
    errorDescription?: string
    createdAt?: number
    updatedAt?: number
    /** 检测到的网络资源统计摘要 */
    resourceSummary?: ResourceDetectionSummarySnapshot
  }
}

export type CrawlspaceContextDiff = {
  crawlspaceId: string
  updatedAt: number
  activeViewId: string | null
  viewCount: number
  views: CrawlspaceContextDiffView[]
  removedViews?: string[]
}

export type CrawlspaceContextEventSource = {
  on(event: 'changed', listener: (snapshot: CrawlspaceContextSnapshot) => void): void
  on(event: 'context-diff', listener: (diff: CrawlspaceContextDiff) => void): void
  off(event: 'changed', listener: (snapshot: CrawlspaceContextSnapshot) => void): void
  off(event: 'context-diff', listener: (diff: CrawlspaceContextDiff) => void): void
}
