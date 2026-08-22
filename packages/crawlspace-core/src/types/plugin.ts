/**
 * Crawlspace Plugin System - Type Definitions
 *
 * 插件系统类型定义，用于实现"统一基座 + 模式插件"架构
 */

import type { ReactNode } from 'react'
import type { CrawlspaceExecuteReturn, RunId, ViewId, ViewInfo } from './core'
import type { CrawlspaceHost } from './host'

// ==================== Schema Provider ====================
export interface SchemaProviderContext {
  url: string
  // 预留扩展，例如 spaceId/userId
}

export type SchemaProviderResult =
  | { schema: Record<string, unknown>; workflowId?: string; metadata?: Record<string, unknown> }
  | { kind: 'pause'; reason: string; data?: unknown }

export type SchemaProvider = (ctx: SchemaProviderContext) => Promise<SchemaProviderResult>

// ==================== Profile / View 模式 ====================
export interface ViewProfile {
  id: string
  config?: Record<string, unknown>
}

export interface PauseEvent {
  reason: string
  data?: unknown
}

export type ViewDisplayMode = 'embedded' | 'hidden' | 'popup'

/**
 * 插件配置
 */
export interface CrawlspacePluginConfig {
  /** 插件唯一标识 */
  id: string

  /** 显示名称（例如：'极速抓取', '智能网页结构分析'） */
  name: string

  /** 插件描述 */
  description?: string

  /** 插件图标 */
  icon?: ReactNode

  /** 插件版本 */
  version: string

  /** 插件作者 */
  author?: string
}

/**
 * 插件上下文
 *
 * 提供给插件的运行时上下文，包含所有基础设施访问接口
 */
export interface CrawlspaceContext {
  // ==================== Run 管理 ====================

  /** Run Manager — 统一的 Run 生命周期管理 */
  runManager: {
    runId: RunId | null
    ensureRun: () => Promise<RunId | null>
    cleanupRun: () => Promise<void>
  }

  // ==================== View 管理 ====================

  /** View Manager — 统一的视图生命周期管理 */
  viewManager: {
    views: ViewInfo[]
    activeViewId: ViewId | null
    createView: (url: string, title?: string) => Promise<ViewId | null>
    switchView: (viewId: ViewId) => Promise<void>
    closeView: (viewId: ViewId) => Promise<void>
    updateView: (viewId: ViewId, updates: Partial<ViewInfo>) => Promise<void>
    setActiveView: (viewId: ViewId | null) => void
  }

  // ==================== 工作空间信息 ====================

  /** Crawlspace ID */
  crawlspaceId: string

  /** 是否激活 */
  isActive: boolean

  /** 用户 ID（可选） */
  userId?: string

  /** 执行控制（可选，供插件使用） */
  exec?: CrawlspaceExecuteReturn

  /** 插件自定义透传参数 */
  pluginProps?: Record<string, any>

  /** 宿主能力（推荐使用，避免散落调用） */
  host?: CrawlspaceHost

  /** 关闭插件面板/标签（可选，由宿主实现） */
  closePlugin?: (pluginId: string) => void
}

/**
 * 插件生命周期钩子
 */
export interface CrawlspacePluginLifecycle {
  /**
   * 插件激活时调用（工作空间切换到此插件）
   */
  onActivate?: (context: CrawlspaceContext) => void | Promise<void>

  /**
   * 插件停用时调用（工作空间切换到其他插件 / Shell 主动关闭）。
   *
   * ⚠️ Wave 3.3 后路径不一致（已知技术债）：
   * - **Shell 主动 close**（plugin 通过 `closePlugin` 触发）：onDeactivate 调
   * - **外部 close**（用户右键 tab / 跨 Space 关闭 / `requestCloseWorkspace`
   *   直达 store handler）：onDeactivate **不调**
   *
   * 当前 0 plugin 实现 onDeactivate，所以路径分裂没有实际影响。如果未来某
   * plugin 需要"被关时一定要触发"的副作用（如埋点、远端 unsubscribe），优
   * 先用 React effect cleanup（plugin 自己的组件 unmount 时跑）；onDeactivate
   * 不是可靠的"被关"hook。
   *
   * 治理方向（待 Wave 3.4+ 决策）：要么删除该 hook，要么把调用搬到 store
   * close handler 内统一触发（需要 plugin context 抽象重设计）。
   */
  onDeactivate?: (context: CrawlspaceContext) => void | Promise<void>

  /**
   * Run 创建后调用
   */
  onRunCreated?: (context: CrawlspaceContext, runId: RunId) => void | Promise<void>

  /**
   * Run 清理前调用
   */
  onRunCleanup?: (context: CrawlspaceContext, runId: RunId) => void | Promise<void>

  /**
   * View 创建后调用
   */
  onViewCreated?: (context: CrawlspaceContext, viewId: ViewId) => void | Promise<void>

  /**
   * View 关闭前调用
   */
  onViewClosed?: (context: CrawlspaceContext, viewId: ViewId) => void | Promise<void>
}

/**
 * 插件 UI 渲染接口
 */
export interface CrawlspacePluginUI {
  /**
   * 渲染主面板（下方）
   *
   * @param context - 插件上下文
   * @param pluginProps - 从 Shell 传递的额外参数（可选）
   * @returns React 组件
   *
   * @example
   * ```tsx
   * renderPanel: (context, pluginProps) => {
   *   return <MyPluginPanel context={context} {...pluginProps} />
   * }
   * ```
   */
  renderPanel: (context: CrawlspaceContext, pluginProps?: Record<string, any>) => ReactNode

  /**
   * 渲染工具栏扩展按钮（可选）
   *
   * @param context - 插件上下文
   * @returns React 组件（通常是按钮组）
   *
   * @example
   * ```tsx
   * renderToolbarActions: (context) => {
   *   return (
   *     <>
   *       <Button onClick={() => startCrawl()}>开始抓取</Button>
   *       <Button onClick={() => stopCrawl()}>停止</Button>
   *     </>
   *   )
   * }
   * ```
   */
  renderToolbarActions?: (context: CrawlspaceContext) => ReactNode

  /**
   * 渲染侧边栏（可选）
   *
   * @param context - 插件上下文
   * @returns React 组件
   */
  renderSidebar?: (context: CrawlspaceContext) => ReactNode
}

/**
 * 插件执行接口
 */
export interface CrawlspacePluginExecution {
  /**
   * 执行抓取任务
   *
   * @param context - 插件上下文
   * @param config - 任务配置（由插件自定义）
   * @returns Promise
   *
   * @example
   * ```tsx
   * onExecute: async (context, config) => {
   *   await context.runManager.ensureRun()
   *   const viewId = await context.viewManager.createView(config.url)
   *   // 执行抓取逻辑...
   * }
   * ```
   */
  onExecute?: (context: CrawlspaceContext, config?: Record<string, unknown>) => Promise<void>

  /**
   * 暂停任务
   */
  onPause?: (context: CrawlspaceContext) => void | Promise<void>

  /**
   * 恢复任务
   */
  onResume?: (context: CrawlspaceContext) => void | Promise<void>

  /**
   * 取消任务
   */
  onCancel?: (context: CrawlspaceContext) => void | Promise<void>
}

/**
 * Crawlspace 插件完整接口
 *
 * 所有抓取模式都应实现此接口
 */
export interface CrawlspacePlugin
  extends CrawlspacePluginLifecycle,
          CrawlspacePluginUI,
          CrawlspacePluginExecution {
  /** 插件配置 */
  config: CrawlspacePluginConfig

  /** 默认 View Profile（可选） */
  profile?: ViewProfile | string

  /** Run ID 前缀 */
  runPrefix?: string

  /** Schema 生成入口 */
  schemaProvider?: SchemaProvider

  /** Workflow 选择逻辑 */
  workflowSelector?: (config: Record<string, unknown>) => string

  /** 视图显示模式 */
  displayMode?: ViewDisplayMode

  /** 默认配置 */
  defaultConfig?: Record<string, any>
}

/**
 * 插件注册表类型
 */
export interface ICrawlspaceRegistry {
  /** 注册插件 */
  register(plugin: CrawlspacePlugin): void

  /** 注销插件 */
  unregister(pluginId: string): void

  /** 获取插件 */
  get(pluginId: string): CrawlspacePlugin | undefined

  /** 获取所有插件 */
  getAll(): CrawlspacePlugin[]

  /** 检查插件是否存在 */
  has(pluginId: string): boolean
}
