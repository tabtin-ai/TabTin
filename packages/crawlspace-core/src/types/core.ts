/**
 * Crawlspace Core - 基础类型定义
 */

// ==================== 基础类型 ====================
export type CrawlspaceId = string
export type RunId = string
export type ViewId = string
export type ProfileName = string

/**
 * View 信息
 */
export interface ViewInfo {
  viewId: ViewId
  url: string
  title: string
  favicon?: string
  // 🆕 可选：用于将 View 绑定到某次 Run（renderer 侧 EmbeddedCrawlView.show 会透传到主进程）
  runId?: RunId
  // 🆕 可选：标记 View 类型（工作区内视图/普通视图）
  kind?: 'workspace-view' | 'normal-view'
  // 🆕 可选：归属的 crawlspace（便于 profile/partition 及 orphan 清理判定）
  crawlspaceId?: CrawlspaceId
  // 🆕 可选：标记是否为预览视图
  isPreview?: boolean
  // 🆕 可选：标记是否处于关闭流程
  isClosing?: boolean
  // 🆕 可选：页面主题色 (meta theme-color)
  themeColor?: string
  // 🆕 导航状态
  isLoading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  createdAt: number
  /** 标签生命周期状态（用于 UI 指示器：休眠/加载中/错误） */
  status?: 'active' | 'deferred' | 'loading' | 'error'
}

/**
 * Crawlspace 配置
 */
export interface CrawlspaceConfig {
  crawlspaceId: CrawlspaceId
  profile: ProfileName
  pluginId?: string
  runPrefix?: string
}

/**
 * Run 管理器返回值
 */
export interface RunManagerReturn {
  runId: RunId | null
  ensureRun: () => Promise<RunId | null>
  cleanupRun: () => Promise<void>
}

/**
 * View 管理器返回值
 */
export interface ViewManagerReturn {
  views: ViewInfo[]
  activeViewId: ViewId | null
  isContextDriven?: boolean
  createView: (url: string, title?: string) => Promise<ViewId | null>
  switchView: (viewId: ViewId) => Promise<void>
  closeView: (viewId: ViewId) => Promise<void>
  updateView: (viewId: ViewId, updates: Partial<ViewInfo>) => Promise<void>
  setActiveView: (viewId: ViewId | null) => void
}

// ==================== 任务相关类型 ====================
import type { TaskStage, TaskState, FullTaskConfig } from './task'
import type { PaginationIntervalConfig } from './pagination'

/**
 * 执行控制器返回值
 */
export interface CrawlspaceExecuteReturn {
  taskState: TaskState
  currentStage: TaskStage
  isExecuting: boolean
  isPaused: boolean
  execute: (config: FullTaskConfig) => Promise<{ success: boolean; error?: string }>
  cancel: () => Promise<void>
  resume: () => Promise<void>
  resumeWithPagination: (pages: number, method: 'click' | 'scroll' | 'both', interval?: PaginationIntervalConfig) => Promise<void>
  resumeWithRecommendation: (id: string, instruction: string) => Promise<void> // ✅ 新增：使用推荐恢复
  selectRecommendation: (id: string, instruction: string) => Promise<void>
  goToNextStage: (targetStage?: 'config' | 'executing' | 'mapping' | 'completed') => void // ✅ 阶段切换（可选指定目标阶段）
  getElapsedTime: () => number // ✅ 新增：获取运行时长（毫秒）
  exportExecutionTrace: () => object // ✅ 新增：导出执行追踪
}
