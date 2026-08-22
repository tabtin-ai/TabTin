/**
 * 下载模块共享类型定义
 *
 * 被主进程（download-manager）和渲染进程（useDownloadStore）共同引用，
 * 确保 IPC 通信两端的类型一致性。
 */

// ==================== 普通下载 ====================

export type DownloadStatus = 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'paused'

export interface DownloadItemData {
  id: string
  name: string
  url: string
  savePath: string
  status: DownloadStatus
  size: { received: number; total: number }
  mimeType: string
  startTime: number
  endTime?: number
  speed: number
  canResume: boolean
  viewId?: string
  /**
   * 已完成下载对应的磁盘文件当前是否仍存在。
   * 由主进程在 getAll 时探测填充（仅对 completed 项有意义）；
   * undefined 表示未探测/无需探测，UI 按「可用」处理。
   */
  fileAvailable?: boolean
  /**
   * 下载来源。undefined = 浏览器原生下载（will-download 拦截）；
   * 'external' = 资源中心 / Agent 工具等经 ResourceDownloadService 完成后补登记的下载，
   * 登记时即为 completed 态。渲染层对 external 静音全局 toast（发起方自行提示）。
   */
  origin?: 'external'
}

// ==================== 流下载（HLS） ====================

export enum StreamErrorCode {
  ENCRYPTED_STREAM = 'ENCRYPTED_STREAM',
  LIVE_STREAM = 'LIVE_STREAM',
  NO_SEGMENTS = 'NO_SEGMENTS',
  NO_QUALITY_MATCH = 'NO_QUALITY_MATCH',
  SEGMENT_FAILED = 'SEGMENT_FAILED',
  DOWNLOAD_TIMEOUT = 'DOWNLOAD_TIMEOUT',
  HTTP_ERROR = 'HTTP_ERROR',
  DOWNLOAD_ABORTED = 'DOWNLOAD_ABORTED',
  MERGE_FAILED = 'MERGE_FAILED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PARSE_ERROR = 'PARSE_ERROR',
}

export type StreamDownloadPhase = 'resolving' | 'downloading' | 'merging' | 'completed' | 'failed'

export interface StreamDownloadItemData {
  id: string
  name: string
  url: string
  resourceId?: string
  savePath: string
  status: StreamDownloadPhase
  size: { received: number; total: number }
  segments: { done: number; total: number }
  speed: number
  percent: number
  duration?: number
  startTime: number
  endTime?: number
  error?: string
}

export interface StreamProgressEvent {
  downloadId: string
  url?: string
  resourceId?: string
  phase: StreamDownloadPhase
  downloadedSegments: number
  totalSegments: number
  downloadedBytes: number
  speed: number
  percent: number
  duration?: number
  outputPath?: string
  totalSize?: number
  error?: string
  errorCode?: StreamErrorCode
}

export interface StreamCompletedEvent {
  downloadId: string
  filePath: string
  size: number
  duration?: number
  segmentCount: number
  elapsedMs: number
  name: string
  url: string
  resourceId?: string
}

export interface StreamFailedEvent {
  downloadId: string
  url: string
  resourceId?: string
  error: string
  errorCode?: StreamErrorCode
}

// ==================== IPC 结果 ====================

export type DownloadIPCResult =
  { downloads?: DownloadItemData[]; cleared?: number; count?: number; aborted?: boolean }

// ==================== IPC 通道定义 ====================

export const DownloadIPCChannels = {
  // 渲染进程 → 主进程（invoke）
  getAll: 'download:getAll',
  pause: 'download:pause',
  resume: 'download:resume',
  cancel: 'download:cancel',
  open: 'download:open',
  showInFolder: 'download:showInFolder',
  removeItem: 'download:removeItem',
  retry: 'download:retry',
  deleteFile: 'download:deleteFile',
  clearCompleted: 'download:clearCompleted',
  streamCancel: 'download:stream:cancel',
  getActiveCount: 'download:getActiveCount',

  // 主进程 → 渲染进程（on/send）
  onStarted: 'download:started',
  onProgress: 'download:progress',
  onCompleted: 'download:completed',
  onStreamProgress: 'download:stream:progress',
  onStreamCompleted: 'download:stream:completed',
  onStreamFailed: 'download:stream:failed',
} as const

export type DownloadIPCChannel = typeof DownloadIPCChannels[keyof typeof DownloadIPCChannels]

export interface DownloadIPCPayloads {
  [DownloadIPCChannels.getAll]: { request: void; response: DownloadIPCResult }
  [DownloadIPCChannels.pause]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.resume]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.cancel]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.open]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.showInFolder]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.removeItem]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.retry]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.deleteFile]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.clearCompleted]: { request: void; response: DownloadIPCResult }
  [DownloadIPCChannels.streamCancel]: { request: string; response: DownloadIPCResult }
  [DownloadIPCChannels.onStarted]: { payload: DownloadItemData }
  [DownloadIPCChannels.onProgress]: { payload: DownloadItemData }
  [DownloadIPCChannels.onCompleted]: { payload: DownloadItemData }
  [DownloadIPCChannels.onStreamProgress]: { payload: StreamProgressEvent }
  [DownloadIPCChannels.onStreamCompleted]: { payload: StreamCompletedEvent }
  [DownloadIPCChannels.onStreamFailed]: { payload: StreamFailedEvent }
}

// ==================== 类型别名 ====================

/** 主进程侧使用 */
export type DownloadInfo = DownloadItemData
/** 渲染进程侧使用 */
export type DownloadItem = DownloadItemData
