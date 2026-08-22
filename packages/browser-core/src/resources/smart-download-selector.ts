/**
 * smart-download「从页面挑一个最值得下的媒体资源」的纯选择逻辑（electron-free）。
 *
 * 背景（BR-4）：这套「优先级挑选 + 下载策略判定」原先只内联在 Electron 的
 * resources.ts 里，Daemon 完全没有——无头端只能显式传一个 HLS/DASH 流地址，否则 501，
 * 即「不能从页面挑选」。抽到 browser-core 后双端共用同一份规则：挑同一个目标、
 * 走对应下载策略，永不漂移。各端只负责把自己的资源列表映射成这里的最小候选形状，
 * 以及按返回的 strategy 走自己的下载实现。
 */

/** 媒体类别（仅 smart-download 关心的子集）。 */
export type MediaCategory = 'hls' | 'dash' | 'video' | 'audio' | 'image' | 'other'

/**
 * smart-download 候选资源——双端各自映射到此最小形状。
 * 字段全可选，因为两端来源（Electron 资源中心 / Daemon ResourceTracker + DOM 探测）
 * 能提供的信息不同；选择器只读它需要的几个。
 */
export interface SmartDownloadCandidate {
  /** 资源标识（Electron resourceId / Daemon tracker requestId）；DOM 直采的可能没有。 */
  resourceId?: string
  url?: string
  /** 资源类别；缺省时调用方可先用 {@link classifyMediaResource} 推断后填入。 */
  category?: string
  /** 捕获状态；`'page_bound_blob'` 表示页面内 MediaSource blob（需先 capture 才能下）。 */
  captureStatus?: string
  size?: number
  /** HLS/DASH 的分片：整体排除，不作为挑选目标。 */
  isSegment?: boolean
  /** 资源能力标签；含 `'streamDownload'` 表示应走流式下载。 */
  capabilities?: readonly string[]
  mimeType?: string
}

/** 选中目标后应走的下载策略。 */
export type SmartDownloadStrategy = 'stream' | 'capture-then-download' | 'download'

export interface SmartDownloadSelection {
  target: SmartDownloadCandidate
  strategy: SmartDownloadStrategy
}

export interface SelectSmartDownloadOptions {
  /** 仅在该类别内挑选（对齐 Electron `--category`）。 */
  category?: string
}

const STREAM_CATEGORIES = new Set<string>(['hls', 'dash'])

/**
 * 从 URL / mimeType 推断媒体类别。
 *
 * Daemon 无 Electron 资源中心的统一分类，需自己从 ResourceTracker 条目 / DOM 媒体元素
 * 推断；本函数是 Electron `inferCategoryFromMimeOrUrl` 媒体子集的 electron-free 复刻。
 * 与 Electron 不同的是：无法判定的不强行落到 `'video'`，返回 `'other'` 由选择器自然忽略，
 * 避免把脚本/文档误当视频挑出来。
 */
export function classifyMediaResource(url?: string, mimeType?: string): MediaCategory {
  const mime = mimeType?.toLowerCase() ?? ''
  const u = url?.toLowerCase() ?? ''

  if (mime.includes('mpegurl') || /\.m3u8(\?|#|$)/.test(u)) return 'hls'
  if (mime.includes('dash+xml') || /\.mpd(\?|#|$)/.test(u)) return 'dash'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('image/')) return 'image'
  if (/\.(mp4|webm|flv|mov|avi|mkv|wmv|m4v|3gp|ts)(\?|#|$)/.test(u)) return 'video'
  if (/\.(mp3|aac|ogg|wav|flac|m4a|wma|opus)(\?|#|$)/.test(u)) return 'audio'
  if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif|tiff)(\?|#|$)/.test(u)) return 'image'
  return 'other'
}

function resolveStrategy(target: SmartDownloadCandidate): SmartDownloadStrategy {
  if (target.capabilities?.includes('streamDownload')) return 'stream'
  if (target.captureStatus === 'page_bound_blob') return 'capture-then-download'
  return 'download'
}

/**
 * 从候选里挑「最值得下的那一个」并判定下载策略。
 *
 * 优先级（对齐既有 Electron 行为）：
 *   HLS/DASH 流 > 普通视频（按体积降序）> 页面内 blob 视频 > 音频。
 * 分片（isSegment）整体排除；传 `category` 则只在该类别内挑。
 *
 * @returns 选中目标 + 策略；页面没有可下媒体时返回 `null`。
 */
export function selectSmartDownloadTarget(
  candidates: readonly SmartDownloadCandidate[],
  options: SelectSmartDownloadOptions = {},
): SmartDownloadSelection | null {
  const pool = candidates
    .filter((c) => !c.isSegment)
    .filter((c) => !options.category || c.category === options.category)

  const streams = pool.filter((c) => c.category != null && STREAM_CATEGORIES.has(c.category))
  const videos = pool
    .filter((c) => c.category === 'video' && c.captureStatus !== 'page_bound_blob')
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
  const blobs = pool.filter((c) => c.category === 'video' && c.captureStatus === 'page_bound_blob')
  const audios = pool.filter((c) => c.category === 'audio')

  const target = streams[0] ?? videos[0] ?? blobs[0] ?? audios[0]
  if (!target) return null

  return { target, strategy: resolveStrategy(target) }
}
