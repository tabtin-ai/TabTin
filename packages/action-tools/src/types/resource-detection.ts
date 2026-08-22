/**
 * 资源检测 / 资源中台共享类型定义
 *
 * 目标：
 * - 用统一的 ResourceRecord 表达浏览器资源
 * - 同时兼容旧的 DetectedResource / get_detected_resources 接口
 * - 让 UI / Tool / CLI / Crawl Import 共享同一套 resourceId 与能力模型
 */

// ========== 分类枚举 ==========

export type ResourceCategory =
  | 'video'
  | 'hls'
  | 'dash'
  | 'audio'
  | 'image'
  | 'font'
  | 'document'

export type ResourceSource =
  | 'network'
  | 'dom_probe'
  | 'cdp_capture'
  | 'task_capture'
  | 'manual_capture'
  | 'webrequest_capture'

export type ResourceCaptureStatus =
  | 'metadata_only'
  | 'content_cached'
  | 'page_bound_blob'
  | 'stream_manifest'
  | 'downloaded'
  | 'unsupported'
  | 'failed'

export type ResourceCapability =
  | 'preview'
  | 'download'
  | 'import'
  | 'sendToAgent'
  | 'parse'
  | 'streamDownload'

export type ResourceContentKind = 'data_url' | 'text' | 'file_path'

// ========== 附属模型 ==========

export interface StreamInfo {
  /** 是否为 master playlist（包含多质量流） */
  isMasterPlaylist?: boolean
  /** 可用的质量级别 */
  variants?: StreamVariant[]
  /** 总时长（秒），仅 VOD */
  duration?: number
  /** 分片数量 */
  segmentCount?: number
  /** 是否为直播流 */
  isLive?: boolean
  /** 是否包含 DRM 加密 */
  isEncrypted?: boolean
}

export interface StreamVariant {
  bandwidth: number
  resolution?: string
  url: string
  codecs?: string
}

/**
 * 页面 DOM 中 video/audio/img 元素的运行时信息
 */
export interface MediaElementInfo {
  tagName: 'video' | 'audio' | 'img'
  /** 当前播放源 URL（可能是 blob:） */
  currentSrc?: string
  /** <source> 元素的 src 列表 */
  sources?: string[]
  /** 视频宽度 */
  videoWidth?: number
  /** 视频高度 */
  videoHeight?: number
  /** 时长（秒） */
  duration?: number
  /** 是否正在使用 MediaSource API */
  usesMediaSource?: boolean
  /** 海报图 URL */
  poster?: string
}

export interface ResourceDimensions {
  width?: number
  height?: number
}

export interface ResourceContentRef {
  kind: ResourceContentKind
  /**
   * data_url / text 直接存入 data
   * file_path 走 filePath
   */
  data?: string
  filePath?: string
  size?: number
  mimeType?: string
  capturedAt?: number
}

export interface ResourceAuthContextRef {
  viewId?: string
  pageUrl?: string
  sessionPartition?: string
  requiresSession?: boolean
  requiresHeaders?: boolean
  headerNames?: string[]
}

export interface ResourceErrorInfo {
  code?: string
  message: string
  retryable?: boolean
}

// ========== 核心资源模型 ==========

export interface ResourceRecord {
  /**
   * 兼容旧字段：id === resourceId
   * 老调用方仍然可以继续读 id，新链路统一使用 resourceId
   */
  id: string
  resourceId: string
  url: string
  resolvedUrl?: string
  category: ResourceCategory
  mimeType?: string
  size?: number
  statusCode: number
  method: string
  referrer?: string
  requestHeaders?: Record<string, string>
  timestamp: number
  viewId: string
  pageUrl?: string
  source?: ResourceSource
  streamInfo?: StreamInfo
  mediaElementInfo?: MediaElementInfo
  duration?: number
  dimensions?: ResourceDimensions
  captureStatus: ResourceCaptureStatus
  capabilities: ResourceCapability[]
  contentRef?: ResourceContentRef
  authContextRef?: ResourceAuthContextRef
  /** 是否为流媒体分片（如 DASH segment、HLS TS 分片） */
  isSegment?: boolean
  /** 所属的 manifest 资源 URL（当 isSegment 为 true 时有意义） */
  parentManifestUrl?: string
  /** 分片在流中的序号 */
  segmentIndex?: number
  lastError?: ResourceErrorInfo
}

/**
 * 兼容旧命名：既有调用方仍沿用 DetectedResource
 */
export type DetectedResource = ResourceRecord

export interface ResourceDetectionSummary {
  total: number
  byCategory: Partial<Record<ResourceCategory, number>>
  byCaptureStatus?: Partial<Record<ResourceCaptureStatus, number>>
}

// ========== Tool Input/Output ==========

export interface GetDetectedResourcesInput {
  /** Run ID（用于关联视图） */
  runId: string
  /** 指定 viewId（可选，默认使用 run 的活跃视图） */
  viewId?: string
  /** 按类别过滤 */
  category?: ResourceCategory
  /** 按捕获状态过滤 */
  captureStatus?: ResourceCaptureStatus
  /** 按能力过滤 */
  capability?: ResourceCapability
  /** 最大返回数量，默认 100 */
  limit?: number
  /** 是否同时触发 DOM 媒体探测（发现 video/audio/blob 资源） */
  probeMedia?: boolean
  /** 是否隐藏 HLS/DASH 等流媒体分片 */
  hideSegments?: boolean
  /** 由 runtime 注入的 Electron View ID */
  crawlTabId?: string
}

export interface GetDetectedResourcesOutput {
  success: boolean
  data?: {
    resources: ResourceRecord[]
    summary: ResourceDetectionSummary
    viewId: string
    pageUrl?: string
  }
  error?: string
}

export interface ListResourcesInput extends GetDetectedResourcesInput {}

export interface ListResourcesOutput extends GetDetectedResourcesOutput {}

export interface InspectResourceInput {
  resourceId: string
  viewId?: string
  crawlTabId?: string
}

export interface InspectResourceOutput {
  success: boolean
  data?: {
    resource: ResourceRecord
  }
  error?: string
}

export interface CaptureResourceInput {
  resourceId?: string
  url?: string
  viewId?: string
  crawlTabId?: string
  force?: boolean
}

export interface CaptureResourceOutput {
  success: boolean
  data?: {
    resource: ResourceRecord
    captured: boolean
  }
  error?: string
}

// ========== 下载工具类型 ==========

export interface DownloadResourceInput {
  /** resourceId 优先，其次使用 url */
  resourceId?: string
  /** 资源 URL（兼容旧接口） */
  url?: string
  /** 自定义文件名（可选，不含路径） */
  filename?: string
  /** 自定义请求头（用于防盗链等） */
  headers?: Record<string, string>
  /** 主进程内部调用可直接传 viewId */
  viewId?: string
  /** 由 runtime 注入的 Electron View ID */
  crawlTabId?: string
}

export interface DownloadResourceOutput {
  success: boolean
  data?: {
    filePath: string
    size: number
    mimeType?: string
    resourceId?: string
  }
  error?: string
}

// ========== M3U8 / Stream 解析类型 ==========

export interface ParseM3U8Input {
  resourceId?: string
  /** m3u8 URL */
  url?: string
  headers?: Record<string, string>
  viewId?: string
  crawlTabId?: string
}

export interface ParseM3U8Output {
  success: boolean
  data?: {
    streamType?: 'hls' | 'dash'
    isMasterPlaylist: boolean
    variants?: StreamVariant[]
    segments?: M3U8Segment[]
    duration?: number
    isLive: boolean
    resourceId?: string
    /** DASH: init segment URL（fMP4 初始化段） */
    initSegmentUrl?: string
    /** DASH: 是否存在独立音频轨 */
    hasAudioTrack?: boolean
    /** DASH: 是否包含 DRM 加密（ContentProtection） */
    isEncrypted?: boolean
  }
  error?: string
}

export interface ParseStreamInput extends ParseM3U8Input {}

export interface ParseStreamOutput extends ParseM3U8Output {}

export interface M3U8Segment {
  url: string
  duration: number
  sequence: number
}

// ========== 流下载工具类型 ==========

export interface DownloadStreamInput {
  resourceId?: string
  /** m3u8 URL */
  url?: string
  /** 质量选择：'best'(默认) | 'worst' | 分辨率关键词如 '720p'、'1080p' */
  quality?: 'best' | 'worst' | string
  filename?: string
  outputPath?: string
  headers?: Record<string, string>
  concurrency?: number
  viewId?: string
  crawlTabId?: string
  signal?: AbortSignal
}

export interface DownloadStreamOutput {
  success: boolean
  data?: {
    filePath: string
    size: number
    duration?: number
    segmentCount: number
    elapsedMs: number
    resourceId?: string
  }
  error?: string
}

export interface DownloadBatchInput {
  resourceIds?: string[]
  urls?: string[]
  headers?: Record<string, string>
  concurrency?: number
  viewId?: string
  crawlTabId?: string
}

export interface DownloadBatchOutput {
  success: boolean
  data?: {
    total: number
    succeeded: number
    failed: number
    results: Array<{
      url: string
      resourceId?: string
      success: boolean
      data?: { filePath: string; size: number; mimeType: string }
      error?: string
    }>
  }
  error?: string
}
