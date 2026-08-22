import { getOrganizationTabManager, type ViewMetadata } from '../organization/OrganizationTabManager'
import { getCrawlspaceContextHub } from './CrawlspaceContextHub'

export interface OrganizationViewMetadataSyncInput {
  viewId: string
  crawlspaceId?: string | null
  title?: string
  url?: string
  favicon?: string | null
  runId?: string
  themeColor?: string | null
  isPreview?: boolean
}

function hasOwn<T extends object>(target: T, key: keyof OrganizationViewMetadataSyncInput): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

export function syncWorkspaceViewMetadata(input: OrganizationViewMetadataSyncInput): void {
  const organizationTabManager = getOrganizationTabManager()
  const crawlspaceId = input.crawlspaceId ?? organizationTabManager.getTabByView(input.viewId)

  const workspaceMetaUpdates: Partial<ViewMetadata> = {}
  if (typeof input.title === 'string') {
    workspaceMetaUpdates.title = input.title
  }
  if (typeof input.url === 'string') {
    workspaceMetaUpdates.url = input.url
  }
  if (typeof input.runId === 'string') {
    workspaceMetaUpdates.runId = input.runId
  }
  if (hasOwn(input, 'favicon')) {
    workspaceMetaUpdates.favicon = input.favicon ?? undefined
  }

  if (Object.keys(workspaceMetaUpdates).length > 0) {
    organizationTabManager.updateViewMetadata(input.viewId, workspaceMetaUpdates)
  }

  if (!crawlspaceId) {
    return
  }

  const contextMetaUpdates: {
    title?: string
    url?: string
    favicon?: string | null
    runId?: string
    isPreview?: boolean
    themeColor?: string | null
  } = {}

  if (typeof input.title === 'string') {
    contextMetaUpdates.title = input.title
  }
  if (typeof input.url === 'string') {
    contextMetaUpdates.url = input.url
  }
  if (typeof input.runId === 'string') {
    contextMetaUpdates.runId = input.runId
  }
  if (typeof input.isPreview === 'boolean') {
    contextMetaUpdates.isPreview = input.isPreview
  }
  if (hasOwn(input, 'favicon')) {
    contextMetaUpdates.favicon = input.favicon ?? null
  }
  if (hasOwn(input, 'themeColor')) {
    contextMetaUpdates.themeColor = input.themeColor ?? null
  }

  if (Object.keys(contextMetaUpdates).length === 0) {
    return
  }

  getCrawlspaceContextHub().updateViewMeta(crawlspaceId, input.viewId, contextMetaUpdates)
}
