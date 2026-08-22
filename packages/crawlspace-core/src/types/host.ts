import type { PaginationIntervalConfig } from './pagination'

export type OrphanReconcileResult =
  | {
      success: true
      reason?: string
      totalViews?: number
      destroyedViewIds?: string[]
      endedRunIds?: string[]
    }
  | { success: false; error: string }

type CrawlViewBounds = { x: number; y: number; width: number; height: number }

type CrawlViewOptions =
  | {
      profile: string
      kind: 'workspace-view'
      crawlspaceId: string
      partition: string
      isPreview?: boolean
      allowMultiple?: boolean
    }
  | {
      profile: string
      kind: 'normal-view'
      crawlspaceId?: never
      partition?: string
      isPreview?: boolean
      allowMultiple?: boolean
    }

/**
 * CrawlspaceHost - 宿主能力契约（Host Contract）
 *
 * 目标：
 * - 把“Electron 宿主职责”收敛成一个明确接口，避免业务/插件到处散落调用 window/tabtin/ipc。
 * - crawlspace-core 仅依赖该抽象；具体实现由宿主（tabtin-electron）注入。
 */
export interface CrawlspaceHost {
  /**
   * TaskAPI 执行能力（可选）
   * - 用于创建/查询/控制任务执行
   * - 由宿主实现（Electron 中对应 window.tabtin.taskAPI）
   */
  taskApi?: {
    create?: (config: any) => Promise<{ success: boolean; task?: any; error?: string }>
    enqueue?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    get?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    cancel?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    resume?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    // ✅ P0：事件订阅（用于减少轮询延迟与丢状态）
    onStateChange?: (callback: (event: any) => void) => () => void
    resumeWithPagination?: (params: {
      taskId: string
      pages: number
      method: 'click' | 'scroll' | 'both'
      interval?: PaginationIntervalConfig
    }) => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>
    selectRecommendation?: (params: {
      taskId: string
      recommendationId: string
      instruction: string
      selectionType?: 'history' | 'recommendation'
      selectionSource?: string
      schema?: Record<string, unknown>
      metadata?: Record<string, unknown>
      skeletonHtml?: string
    }) => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>
  }

  /**
   * Analytics/Telemetry 订阅（可选）
   * - 用于分页执行日志等实时事件
   */
  analytics?: {
    onPaginationEvent?: (callback: (payload: Record<string, unknown>) => void) => () => void
  }

  /**
   * Run 会话能力（可选）
   * - 用于创建/结束 run（主进程 RunSessionManager）
   * - crawlspace-core 不直接依赖 window.tabtin
   */
  runSession?: {
    create?: (runId: string, sessionId?: string) => Promise<{ success: boolean; error?: string }>
    endRun?: (runId: string, options?: { reason?: string }) => Promise<{ success: boolean; error?: string }>
  }

  /**
   * 导航能力（可选）
   * - 用于 shell 顶部工具栏等通用 UI
   * - ✅ 稳健化：所有导航操作必须显式指定 viewId，避免“依赖 active view”导致误操作
   * - DEPRECATED：保留兼容，内部应代理到 view.*
   */
  navigation?: {
    goBack?: (viewId: string) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }
    goForward?: (viewId: string) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }
    reload?: (
      viewId: string,
      ignoreCache?: boolean
    ) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }
    stop?: (viewId: string) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }
  }

  /**
   * View 能力（可选）
   * - renderer 必须通过该入口操作 WebContentsView，避免直连 crawlViewClient
   */
  view?: {
    /** 返回 skipped（'task-lock' / 'same-url'）表示导航被主进程跳过、页面未变化——调用方不应把地址栏停在目标 URL */
    show?: (
      viewId: string,
      url: string,
      bounds: CrawlViewBounds,
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<{ success: boolean; error?: string; skipped?: string }>
    hide?: (viewId?: string) => Promise<{ success: boolean; error?: string }>
    setViewBounds?: (viewId: string, bounds: CrawlViewBounds) => Promise<{ success: boolean; error?: string }>
    destroy?: (viewId: string) => Promise<{ success: boolean; error?: string }>
    onEvent?: (callback: (event: any) => void) => () => void
    hasView?: (viewId: string) => Promise<{ success: boolean; exists?: boolean; error?: string }>
    touch?: (viewId: string, reason?: string) => Promise<{ success: boolean; touched?: boolean; error?: string }>
    getNavigationState?: (viewId?: string) => Promise<{ success: boolean; state?: any; error?: string }>
    goBack?: (viewId?: string) => Promise<{ success: boolean; error?: string }>
    goForward?: (viewId?: string) => Promise<{ success: boolean; error?: string }>
    reload?: (viewId?: string, ignoreCache?: boolean) => Promise<{ success: boolean; error?: string }>
    stop?: (viewId?: string) => Promise<{ success: boolean; error?: string }>
    executeScript?: (
      code: string,
      viewId?: string,
      url?: string,
      options?: CrawlViewOptions
    ) => Promise<any>
    getProcessedContent?: (
      viewId?: string,
      url?: string,
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<any>
    getHTML?: (
      viewId?: string,
      url?: string,
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<any>
    getPageInfo?: (
      viewId?: string,
      url?: string,
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<any>
    screenshot?: (
      captureOptions?: { format?: 'png' | 'jpeg'; quality?: number },
      viewId?: string,
      url?: string,
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<any>
  }

  /**
   * View 脚本执行能力（可选）
   * - 用于在指定 View 中执行脚本、获取处理后的内容
   * - 支持传递 url/runId/options，确保隐式创建时 profile/partition 正确
   * - DEPRECATED：保留兼容，内部应代理到 view.*
   */
  viewScript?: {
    executeScript?: (
      code: string,
      viewId: string,
      url?: string,
      options?: { profile?: string; partition?: string; crawlspaceId?: string; kind?: string; isPreview?: boolean }
    ) => Promise<any>
    getProcessedContent?: (
      viewId: string,
      url?: string,
      runId?: string,
      options?: { profile?: string; partition?: string; crawlspaceId?: string; kind?: string; isPreview?: boolean }
    ) => Promise<any>
  }

  /**
   * Agent 执行能力（可选）
   * - 用于执行前端动作
   */
  agent?: {
    executeAction?: (params: {
      task_id: string
      action: any
      params: Record<string, any>
    }) => Promise<any>
  }

  /**
   * 关闭工作区 UI（例如：关闭侧边栏标签、取消选中等）。
   *
   * 注意：这应当只处理 UI/宿主层面的“容器关闭”。
   * View/Run 等资源的关闭建议由 crawlspace-core 先行执行（通过 viewManager/runManager），
   * 宿主只负责移除工作区入口与收尾（避免重复销毁导致竞态）。
   */
  closeWorkspaceUI?: (input: {
    crawlspaceId: string
    pluginId?: string
    reason?: string
    destroyViews?: boolean
  }) => void | Promise<void>

  /**
   * renderer 重载兜底：对齐并清理主进程孤儿资源（views/runs）。
   */
  reconcileOrphans?: (input: {
    // 兼容字段：历史上仅传 tabs[]（注意：新模型中 workspace 内部 view 不在 tabs[]）
    knownTabIds?: string[]
    // 推荐字段：显式传递所有已知 viewId（包含 workspace 内部 view、preview view 等）
    knownViewIds?: string[]
    // 推荐字段：显式传递已知 workspaceId（避免依赖命名规则）
    knownWorkspaceIds?: string[]
    reason?: string
  }) => Promise<OrphanReconcileResult>
}

export const NOOP_HOST: CrawlspaceHost = {}
