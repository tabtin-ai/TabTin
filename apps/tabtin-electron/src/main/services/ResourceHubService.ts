import { createHash } from 'crypto'
import { EventEmitter } from 'events'

import type {
  MediaElementInfo,
  ResourceAuthContextRef,
  ResourceCapability,
  ResourceCaptureStatus,
  ResourceCategory,
  ResourceContentRef,
  ResourceDetectionSummary,
  ResourceErrorInfo,
  ResourceRecord,
  ResourceSource,
  StreamInfo
} from '@tabtin/action-tools/types'

export interface ResourceHubFilter {
  category?: ResourceCategory
  captureStatus?: ResourceCaptureStatus
  capability?: ResourceCapability
  hideSegments?: boolean
  limit?: number
}

interface ViewResourceStore {
  viewId: string
  pageUrl?: string
  resources: Map<string, ResourceRecord>
  resourceIdByUrl: Map<string, string>
  /** RP-004: per-category resource ID index for O(1) filtered queries */
  byCategory: Map<string, Set<string>>
  /** RP-004: per-captureStatus resource ID index */
  byCaptureStatus: Map<string, Set<string>>
  /** RP-005: incrementally maintained summary – avoids O(N) recomputation */
  summary: ResourceDetectionSummary
}

interface UpsertResourceInput {
  resourceId?: string
  url: string
  resolvedUrl?: string
  viewId: string
  pageUrl?: string
  sessionPartition?: string
  category?: ResourceCategory
  mimeType?: string
  size?: number
  statusCode?: number
  method?: string
  referrer?: string
  requestHeaders?: Record<string, string>
  timestamp?: number
  source?: ResourceSource
  streamInfo?: StreamInfo
  mediaElementInfo?: MediaElementInfo
  duration?: number
  dimensions?: ResourceRecord['dimensions']
  captureStatus?: ResourceCaptureStatus
  capabilities?: ResourceCapability[]
  contentRef?: ResourceContentRef
  authContextRef?: ResourceAuthContextRef
  lastError?: ResourceErrorInfo
}

function inferCategoryFromMimeOrUrl(
  url: string,
  mimeType?: string,
  mediaElementInfo?: MediaElementInfo
): ResourceCategory {
  const normalizedMime = mimeType?.toLowerCase()
  const normalizedUrl = url.toLowerCase()

  if (normalizedMime?.includes('mpegurl') || normalizedUrl.includes('.m3u8')) return 'hls'
  if (normalizedMime?.includes('dash+xml') || normalizedUrl.includes('.mpd')) return 'dash'
  if (normalizedMime?.startsWith('video/')) return 'video'
  if (normalizedMime?.startsWith('audio/')) return 'audio'
  if (normalizedMime?.startsWith('image/')) return 'image'
  if (normalizedMime?.startsWith('font/')) return 'font'
  if (
    normalizedMime === 'application/pdf'
    || normalizedMime?.includes('msword')
    || normalizedMime?.includes('officedocument')
  ) {
    return 'document'
  }

  if (mediaElementInfo?.tagName === 'audio') return 'audio'
  if (mediaElementInfo?.tagName === 'img') return 'image'

  if (/\.(mp4|webm|flv|mov|avi|mkv|wmv|m4v|3gp|ts)(\?|#|$)/i.test(normalizedUrl)) return 'video'
  if (/\.(mp3|aac|ogg|wav|flac|m4a|wma|opus)(\?|#|$)/i.test(normalizedUrl)) return 'audio'
  if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif|tiff)(\?|#|$)/i.test(normalizedUrl)) return 'image'
  if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(normalizedUrl)) return 'font'

  return 'video'
}

function buildAuthContextRef(input: UpsertResourceInput): ResourceAuthContextRef | undefined {
  const headerNames = Object.keys(input.requestHeaders ?? {})
  const requiresHeaders = headerNames.length > 0 || Boolean(input.referrer)
  if (!requiresHeaders && !input.viewId) {
    return undefined
  }

  return {
    viewId: input.viewId,
    pageUrl: input.pageUrl,
    sessionPartition: input.sessionPartition,
    requiresSession: true,
    requiresHeaders,
    headerNames: headerNames.length > 0 ? headerNames : undefined
  }
}

function mergeRequestHeaders(
  existing?: Record<string, string>,
  incoming?: Record<string, string>
): Record<string, string> | undefined {
  if (existing && incoming) {
    return {
      ...existing,
      ...incoming
    }
  }
  return incoming ?? existing
}

function resolveCaptureStatus(record: ResourceRecord): ResourceCaptureStatus {
  if (record.lastError) return 'failed'

  if (record.contentRef?.kind === 'file_path' && record.contentRef.filePath) {
    return 'downloaded'
  }

  const candidateUrl = record.resolvedUrl || record.url
  const isBlobLike = candidateUrl.startsWith('blob:') || Boolean(record.mediaElementInfo?.usesMediaSource)
  if (isBlobLike && !record.contentRef?.data && !record.contentRef?.filePath) {
    return 'page_bound_blob'
  }

  if ((record.category === 'hls' || record.category === 'dash') && (record.streamInfo || record.contentRef?.kind === 'text')) {
    return 'stream_manifest'
  }

  if (record.contentRef?.data) {
    return 'content_cached'
  }

  return 'metadata_only'
}

function hasPreview(record: ResourceRecord): boolean {
  return ['image', 'video', 'audio', 'document', 'hls', 'dash'].includes(record.category)
}

function resolveCapabilities(record: ResourceRecord): ResourceCapability[] {
  const capabilities = new Set<ResourceCapability>()

  if (hasPreview(record)) capabilities.add('preview')

  const candidateUrl = record.resolvedUrl || record.url
  if (
    record.captureStatus === 'content_cached'
    || record.captureStatus === 'downloaded'
    || record.captureStatus === 'page_bound_blob'
    || /^(https?:|blob:|file:)/i.test(candidateUrl)
  ) {
    capabilities.add('download')
  }

  if (['image', 'video', 'audio', 'document', 'hls', 'dash'].includes(record.category)) {
    capabilities.add('import')
    capabilities.add('sendToAgent')
  }

  if (record.category === 'hls' || record.category === 'dash') {
    capabilities.add('parse')
    capabilities.add('streamDownload')
  }

  return Array.from(capabilities)
}

/** 流媒体分片 URL 的常见 pattern */
const SEGMENT_URL_PATTERNS = [
  /\/seg[-_]?\d+\.(mp4|m4s|m4v|ts)(\?|#|$)/i,
  /\/init[-_]?\w*\.(mp4|m4s)(\?|#|$)/i,
  /\/chunk[-_]?\d+/i,
  /\/fragment[-_]?\d+/i,
  /\/segment[-_]?\d+/i,
  /\/range\/\d+-\d+/i,
  /\/(video|audio)[-_]?\d+\.(m4s|mp4)(\?|#|$)/i,
]

function detectSegmentInfo(
  url: string,
  category: ResourceCategory,
  store: ViewResourceStore
): { isSegment: boolean; parentManifestUrl?: string } {
  if (category !== 'video' && category !== 'audio') {
    return { isSegment: false }
  }

  const matchesPattern = SEGMENT_URL_PATTERNS.some(p => p.test(url))
  if (!matchesPattern) {
    return { isSegment: false }
  }

  let parentManifestUrl: string | undefined
  try {
    const urlBase = new URL(url).origin + new URL(url).pathname.replace(/\/[^/]+$/, '/')
    for (const [existingUrl, existingId] of store.resourceIdByUrl) {
      const existing = store.resources.get(existingId)
      if (!existing) continue
      if (existing.category === 'hls' || existing.category === 'dash') {
        try {
          const manifestBase = new URL(existingUrl).origin
          if (urlBase.startsWith(manifestBase)) {
            parentManifestUrl = existingUrl
            break
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return { isSegment: true, parentManifestUrl }
}

const SUMMARY_THROTTLE_MS = 100

function* resolveIds(resources: Map<string, ResourceRecord>, ids: Set<string>): Generator<ResourceRecord> {
  for (const id of ids) {
    const r = resources.get(id)
    if (r) yield r
  }
}

function summaryFingerprint(s: ResourceDetectionSummary): string {
  let fp = String(s.total)
  const catEntries = Object.entries(s.byCategory).sort()
  for (let i = 0; i < catEntries.length; i++) {
    fp += `,c${catEntries[i][0]}:${catEntries[i][1]}`
  }
  const statusEntries = Object.entries(s.byCaptureStatus ?? {}).sort()
  for (let i = 0; i < statusEntries.length; i++) {
    fp += `,s${statusEntries[i][0]}:${statusEntries[i][1]}`
  }
  return fp
}

export class ResourceHubService extends EventEmitter {
  private stores = new Map<string, ViewResourceStore>()
  /** 全局 resourceId → viewId 索引，将 findResourceById 从 O(N×M) 降至 O(1) */
  private resourceIdIndex = new Map<string, string>()
  /** per-viewId throttle timers for summary-changed */
  private summaryThrottleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** RP-006: last emitted summary fingerprint per viewId – suppress redundant emissions */
  private lastEmittedSummaryFp = new Map<string, string>()

  registerView(viewId: string, pageUrl?: string): void {
    const existing = this.stores.get(viewId)
    if (existing) {
      if (pageUrl) existing.pageUrl = pageUrl
      return
    }

    this.stores.set(viewId, {
      viewId,
      pageUrl,
      resources: new Map(),
      resourceIdByUrl: new Map(),
      byCategory: new Map(),
      byCaptureStatus: new Map(),
      summary: { total: 0, byCategory: {}, byCaptureStatus: {} }
    })
  }

  unregisterView(viewId: string): void {
    const store = this.stores.get(viewId)
    if (store) {
      this.flushSummaryThrottle(viewId)
      for (const resourceId of store.resources.keys()) {
        this.resourceIdIndex.delete(resourceId)
      }
      this.stores.delete(viewId)
      this.lastEmittedSummaryFp.delete(viewId)
      this.emit('view-cleared', viewId)
    }
  }

  clearView(viewId: string, pageUrl?: string): void {
    const store = this.ensureStore(viewId, pageUrl)
    this.flushSummaryThrottle(viewId)
    for (const resourceId of store.resources.keys()) {
      this.resourceIdIndex.delete(resourceId)
    }
    store.resources.clear()
    store.resourceIdByUrl.clear()
    store.byCategory.clear()
    store.byCaptureStatus.clear()
    store.summary = { total: 0, byCategory: {}, byCaptureStatus: {} }
    if (pageUrl !== undefined) {
      store.pageUrl = pageUrl
    }
    this.lastEmittedSummaryFp.delete(viewId)
    this.emit('summary-changed', viewId, this.getSummary(viewId))
  }

  setPageUrl(viewId: string, pageUrl?: string): void {
    const store = this.ensureStore(viewId, pageUrl)
    store.pageUrl = pageUrl
  }

  getResources(viewId: string, filter?: ResourceHubFilter): ResourceRecord[] {
    const store = this.stores.get(viewId)
    if (!store) return []

    let usedCategoryIdx = false
    let usedStatusIdx = false
    let source: Iterable<ResourceRecord>

    if (filter?.category) {
      const ids = store.byCategory.get(filter.category)
      if (!ids || ids.size === 0) return []
      source = resolveIds(store.resources, ids)
      usedCategoryIdx = true
    } else if (filter?.captureStatus) {
      const ids = store.byCaptureStatus.get(filter.captureStatus)
      if (!ids || ids.size === 0) return []
      source = resolveIds(store.resources, ids)
      usedStatusIdx = true
    } else {
      source = store.resources.values()
    }

    const results: ResourceRecord[] = []
    for (const r of source) {
      if (!usedCategoryIdx && filter?.category && r.category !== filter.category) continue
      if (!usedStatusIdx && filter?.captureStatus && r.captureStatus !== filter.captureStatus) continue
      if (filter?.capability && !r.capabilities.includes(filter.capability!)) continue
      if (filter?.hideSegments && r.isSegment) continue
      results.push(r)
    }

    results.sort((a, b) => b.timestamp - a.timestamp)
    // 无 --limit：缺省返回全部资源，不做有损截断；仅当显式传 limit 才截。
    return filter?.limit ? results.slice(0, filter.limit) : results
  }

  getSummary(viewId: string, filter?: Omit<ResourceHubFilter, 'limit'>): ResourceDetectionSummary {
    const store = this.stores.get(viewId)
    if (!store) {
      return { total: 0, byCategory: {}, byCaptureStatus: {} }
    }
    if (filter?.category || filter?.captureStatus || filter?.capability || filter?.hideSegments) {
      const summary: ResourceDetectionSummary = { total: 0, byCategory: {}, byCaptureStatus: {} }
      const byCaptureStatus = summary.byCaptureStatus!
      for (const resource of store.resources.values()) {
        if (filter.category && resource.category !== filter.category) continue
        if (filter.captureStatus && resource.captureStatus !== filter.captureStatus) continue
        if (filter.capability && !resource.capabilities.includes(filter.capability)) continue
        if (filter.hideSegments && resource.isSegment) continue
        summary.total += 1
        summary.byCategory[resource.category] = (summary.byCategory[resource.category] ?? 0) + 1
        byCaptureStatus[resource.captureStatus] = (byCaptureStatus[resource.captureStatus] ?? 0) + 1
      }
      return summary
    }
    return { ...store.summary, byCategory: { ...store.summary.byCategory }, byCaptureStatus: { ...store.summary.byCaptureStatus } }
  }

  getPageUrl(viewId: string): string | undefined {
    return this.stores.get(viewId)?.pageUrl
  }

  getResource(viewId: string, resourceId: string): ResourceRecord | null {
    const store = this.stores.get(viewId)
    if (!store) return null
    return store.resources.get(resourceId) ?? null
  }

  findResourceById(resourceId: string): ResourceRecord | null {
    const viewId = this.resourceIdIndex.get(resourceId)
    if (!viewId) return null
    return this.stores.get(viewId)?.resources.get(resourceId) ?? null
  }

  findResourceLocation(resourceId: string): { viewId: string; resource: ResourceRecord } | null {
    const viewId = this.resourceIdIndex.get(resourceId)
    if (!viewId) return null
    const resource = this.stores.get(viewId)?.resources.get(resourceId)
    if (!resource) return null
    return { viewId, resource }
  }

  getResourceByUrl(viewId: string, url: string): ResourceRecord | null {
    const store = this.stores.get(viewId)
    if (!store) return null
    const resourceId = store.resourceIdByUrl.get(url)
    if (!resourceId) return null
    return store.resources.get(resourceId) ?? null
  }

  resolveResource(viewId: string, input: { resourceId?: string; url?: string }): ResourceRecord | null {
    if (input.resourceId) {
      return this.getResource(viewId, input.resourceId)
    }
    if (input.url) {
      return this.getResourceByUrl(viewId, input.url)
    }
    return null
  }

  upsertResource(input: UpsertResourceInput): ResourceRecord {
    const store = this.ensureStore(input.viewId, input.pageUrl)
    const lookupUrl = input.resolvedUrl || input.url
    const existingId = input.resourceId || store.resourceIdByUrl.get(lookupUrl) || store.resourceIdByUrl.get(input.url)
    const existing = existingId ? store.resources.get(existingId) : undefined
    const pageUrl = input.pageUrl ?? store.pageUrl
    const requestHeaders = mergeRequestHeaders(existing?.requestHeaders, input.requestHeaders)
    const referrer = input.referrer ?? existing?.referrer
    const sessionPartition = input.sessionPartition ?? existing?.authContextRef?.sessionPartition

    const category = input.category || existing?.category || inferCategoryFromMimeOrUrl(lookupUrl, input.mimeType, input.mediaElementInfo)
    const resourceId = existing?.resourceId || existing?.id || input.resourceId || this.generateResourceId(input.viewId, lookupUrl)

    const next: ResourceRecord = {
      id: resourceId,
      resourceId,
      url: input.url || existing?.url || lookupUrl,
      resolvedUrl: input.resolvedUrl ?? existing?.resolvedUrl,
      category,
      mimeType: input.mimeType ?? existing?.mimeType,
      size: input.size ?? existing?.size,
      statusCode: input.statusCode ?? existing?.statusCode ?? 200,
      method: input.method ?? existing?.method ?? 'GET',
      referrer,
      requestHeaders,
      timestamp: input.timestamp ?? existing?.timestamp ?? Date.now(),
      viewId: input.viewId,
      pageUrl,
      source: input.source ?? existing?.source,
      streamInfo: input.streamInfo ?? existing?.streamInfo,
      mediaElementInfo: input.mediaElementInfo ?? existing?.mediaElementInfo,
      duration: input.duration ?? existing?.duration ?? input.mediaElementInfo?.duration ?? existing?.mediaElementInfo?.duration,
      dimensions: input.dimensions ?? existing?.dimensions ?? {
        width: input.mediaElementInfo?.videoWidth ?? existing?.mediaElementInfo?.videoWidth,
        height: input.mediaElementInfo?.videoHeight ?? existing?.mediaElementInfo?.videoHeight
      },
      captureStatus: existing?.captureStatus ?? 'metadata_only',
      capabilities: existing?.capabilities ?? [],
      contentRef: input.contentRef ?? existing?.contentRef,
      authContextRef: input.authContextRef
        ?? buildAuthContextRef({
          ...input,
          pageUrl,
          referrer,
          requestHeaders,
          sessionPartition
        })
        ?? existing?.authContextRef,
      lastError: input.lastError ?? existing?.lastError,
      isSegment: existing?.isSegment,
      parentManifestUrl: existing?.parentManifestUrl,
      segmentIndex: existing?.segmentIndex,
    }

    next.captureStatus = input.captureStatus ?? resolveCaptureStatus(next)
    next.capabilities = input.capabilities ?? resolveCapabilities(next)

    if (!next.isSegment) {
      const segInfo = detectSegmentInfo(next.url, next.category, store)
      if (segInfo.isSegment) {
        next.isSegment = true
        next.parentManifestUrl = segInfo.parentManifestUrl
      }
    }

    this.updateIndexesAndSummary(store, resourceId, existing ?? null, next)

    store.resources.set(resourceId, next)
    store.resourceIdByUrl.set(next.url, resourceId)
    if (next.resolvedUrl) {
      store.resourceIdByUrl.set(next.resolvedUrl, resourceId)
    }
    this.resourceIdIndex.set(resourceId, input.viewId)

    this.emit('resource-upserted', next)
    this.throttledSummaryChanged(input.viewId)
    return next
  }

  attachCapturedContent(
    viewId: string,
    url: string,
    content: {
      mimeType?: string
      size?: number
      category?: ResourceCategory
      source?: ResourceSource
      pageUrl?: string
      contentRef: ResourceContentRef
    }
  ): ResourceRecord {
    return this.upsertResource({
      viewId,
      url,
      pageUrl: content.pageUrl,
      mimeType: content.mimeType,
      size: content.size,
      category: content.category,
      source: content.source,
      contentRef: content.contentRef
    })
  }

  updateStreamInfo(viewId: string, input: { resourceId?: string; url?: string }, streamInfo: StreamInfo): ResourceRecord | null {
    const resource = this.resolveResource(viewId, input)
    if (!resource) return null

    return this.upsertResource({
      viewId,
      resourceId: resource.resourceId,
      url: resource.url,
      resolvedUrl: resource.resolvedUrl,
      streamInfo
    })
  }

  markDownloaded(viewId: string, input: { resourceId?: string; url?: string }, download: {
    filePath: string
    size: number
    mimeType?: string
  }): ResourceRecord | null {
    const resource = this.resolveResource(viewId, input)
    if (!resource) return null

    return this.upsertResource({
      viewId,
      resourceId: resource.resourceId,
      url: resource.url,
      resolvedUrl: resource.resolvedUrl,
      size: download.size,
      mimeType: download.mimeType ?? resource.mimeType,
      contentRef: {
        kind: 'file_path',
        filePath: download.filePath,
        size: download.size,
        mimeType: download.mimeType ?? resource.mimeType,
        capturedAt: Date.now()
      },
      captureStatus: 'downloaded'
    })
  }

  setError(viewId: string, input: { resourceId?: string; url?: string }, error: ResourceErrorInfo): ResourceRecord | null {
    const resource = this.resolveResource(viewId, input)
    if (!resource) return null

    return this.upsertResource({
      viewId,
      resourceId: resource.resourceId,
      url: resource.url,
      resolvedUrl: resource.resolvedUrl,
      lastError: error,
      captureStatus: 'failed'
    })
  }

  /**
   * Per-viewId throttle: coalesce rapid-fire upserts into a single
   * summary-changed emission per SUMMARY_THROTTLE_MS window.
   * RP-006: suppress emission when summary fingerprint hasn't changed.
   */
  private throttledSummaryChanged(viewId: string): void {
    if (this.summaryThrottleTimers.has(viewId)) return
    const timer = setTimeout(() => {
      this.summaryThrottleTimers.delete(viewId)
      const summary = this.getSummary(viewId)
      const fp = summaryFingerprint(summary)
      if (this.lastEmittedSummaryFp.get(viewId) === fp) return
      this.lastEmittedSummaryFp.set(viewId, fp)
      this.emit('summary-changed', viewId, summary)
    }, SUMMARY_THROTTLE_MS)
    this.summaryThrottleTimers.set(viewId, timer)
  }

  /** Flush pending throttled summary for a viewId (used by clearView / unregister). */
  private flushSummaryThrottle(viewId: string): void {
    const timer = this.summaryThrottleTimers.get(viewId)
    if (timer) {
      clearTimeout(timer)
      this.summaryThrottleTimers.delete(viewId)
    }
  }

  private ensureStore(viewId: string, pageUrl?: string): ViewResourceStore {
    const existing = this.stores.get(viewId)
    if (existing) {
      if (pageUrl !== undefined) {
        existing.pageUrl = pageUrl
      }
      return existing
    }

    const store: ViewResourceStore = {
      viewId,
      pageUrl,
      resources: new Map(),
      resourceIdByUrl: new Map(),
      byCategory: new Map(),
      byCaptureStatus: new Map(),
      summary: { total: 0, byCategory: {}, byCaptureStatus: {} }
    }
    this.stores.set(viewId, store)
    return store
  }

  /**
   * RP-004/005: incrementally update per-view category/status indexes and
   * the cached summary counters when a resource is created or updated.
   */
  private updateIndexesAndSummary(
    store: ViewResourceStore,
    resourceId: string,
    existing: ResourceRecord | null,
    next: ResourceRecord
  ): void {
    const summary = store.summary
    if (!summary.byCaptureStatus) summary.byCaptureStatus = {}

    if (existing) {
      store.byCategory.get(existing.category)?.delete(resourceId)
      store.byCaptureStatus.get(existing.captureStatus)?.delete(resourceId)

      if (summary.byCategory[existing.category]) {
        summary.byCategory[existing.category]!--
        if (summary.byCategory[existing.category] === 0) delete summary.byCategory[existing.category]
      }
      if (summary.byCaptureStatus[existing.captureStatus]) {
        summary.byCaptureStatus[existing.captureStatus]!--
        if (summary.byCaptureStatus[existing.captureStatus] === 0) delete summary.byCaptureStatus[existing.captureStatus]
      }
    } else {
      summary.total++
    }

    let catSet = store.byCategory.get(next.category)
    if (!catSet) { catSet = new Set(); store.byCategory.set(next.category, catSet) }
    catSet.add(resourceId)

    let statusSet = store.byCaptureStatus.get(next.captureStatus)
    if (!statusSet) { statusSet = new Set(); store.byCaptureStatus.set(next.captureStatus, statusSet) }
    statusSet.add(resourceId)

    summary.byCategory[next.category] = (summary.byCategory[next.category] || 0) + 1
    summary.byCaptureStatus[next.captureStatus] = (summary.byCaptureStatus[next.captureStatus] || 0) + 1
  }

  private generateResourceId(viewId: string, url: string): string {
    return createHash('md5').update(`${viewId}:${url}`).digest('hex').substring(0, 12)
  }
}

let instance: ResourceHubService | null = null

export function getResourceHubService(): ResourceHubService {
  if (!instance) {
    instance = new ResourceHubService()
  }
  return instance
}

export function resetResourceHubService(): void {
  instance = null
}
