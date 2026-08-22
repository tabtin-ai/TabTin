/**
 * Run Session 快照与 IPC 契约（主进程 getRun / preload runSession.get / 渲染 run-session-client）
 * Single source：增删字段时须与此处及 RunSessionManager.getRun 赋值保持一致。
 */

export interface RunViewInfo {
  viewId: string
  profile?: string
  partition?: string
  userAgent?: string
  proxy?: Record<string, unknown>
  createdAt: number
  inUse: boolean
  metadata?: Record<string, unknown>
}

export interface RunObservationEvent {
  runId: string
  viewId?: string
  type: string
  timestamp: number
  data?: unknown
  context?: {
    selector?: string
    timeout?: number
    duration?: number
    url?: string
    title?: string
    structure?: {
      ariaTreeNodes?: number
      skeletonSize?: number
      domNodeCount?: number
    }
    snapshot?: {
      url?: string
      title?: string
      accessibility_tree?: string
      xpath_map?: Record<string, string>
      skeleton_html?: string
      screenshot_base64?: string
    }
    diff?: {
      hasChanges?: boolean
      addedCount?: number
      removedCount?: number
      summary?: string
      addedLines?: string[]
      removedLines?: string[]
      targetElementDisappeared?: boolean
    }
    extraction?: {
      fieldCount?: number
      recordCount?: number
      dataSize?: number
    }
    error?: {
      code?: string
      message?: string
      retriable?: boolean
    }
  }
}

/**
 * `RunSessionManager.getRun` 返回值（Map/ring buffer 已序列化为数组）
 */
export interface RunSessionSnapshot {
  runId: string
  sessionId: string
  profile?: string
  activeViewId: string | null
  spaceId: string | null
  crawlspaceId: string | null
  memory: Record<string, unknown>
  createdAt: number
  updatedAt: number
  lastEventAt: number | null
  totalEventCount: number
  views: RunViewInfo[]
  observations: RunObservationEvent[]
}

/** 渲染进程 `runSessionClient.get` / preload `runSession.get` */
export type RunSessionGetResult = RunSessionSnapshot | null
