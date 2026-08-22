/**
 * ViewFactory - 类型定义
 *
 * 统一管理所有 WebContentsView 的创建、显示、销毁逻辑
 */

import type { WebContents, WebContentsView, Rectangle } from 'electron';
import type { CDPConnectionStrategy } from '@tabtin/action-tools/types';
import type { AntiDetectConfig } from '@tabtin/anti-detect';
import type { SessionMode } from '@tabtin/crawl-contracts';

/**
 * View 使用场景（预设配置）
 */
export type ViewProfile =
  | 'user-tab'           // 用户浏览标签：显示在主窗口+侧边栏，永久保存
  | 'agent-workspace'   // Agent 工作区：显示在工作区，不在侧边栏
  | 'background-task'    // 后台任务：完全隐藏，任务完成后自动关闭
  | 'temporary-preview'; // 临时预览：显示在主窗口+侧边栏，任务完成后关闭

/**
 * View 显示模式
 */
export type ViewDisplayMode =
  | 'hidden'       // 完全隐藏（屏幕外）
  | 'embedded'     // 嵌入主窗口
  | 'new-window';  // 新窗口


/**
 * CDP 连接策略
 * 🔥 从 @tabtin/action-tools 导入，避免重复定义
 * - ephemeral: 短暂模式（每次操作后立即断开）
 * - keep-alive: 保活模式（60秒无活动自动断开）⭐ 默认
 * - task-bound: 任务绑定（任务结束自动断开）⭐⭐⭐ 后台任务专用
 * - persistent: 持久模式（不自动断开）
 */
export type { CDPConnectionStrategy };

/**
 * ViewFactory 配置
 */
export interface ViewFactoryConfig {
  /** 使用场景（会自动应用预设配置） */
  profile: ViewProfile;

  /** 唯一标识 */
  id: string;

  /** 初始 URL（可选） */
  url?: string;

  /**
   * 允许导航到用户显式批准的本机/私有地址。
   *
   * 默认 false。仅用于 Personal Plugin 这类本地服务入口；普通 Agent 自动化
   * 仍应经过 SSRF 防护，避免任意访问内网地址。
   */
  allowPrivateHostNavigation?: boolean;

  /**
   * 受限放行 `file://` 导航的根目录（当前 Space 工作目录）。
   *
   * 仅「Agent 本地 HTML 产物在内嵌浏览器预览」这一可信入口创建 view 时写入；
   * 门禁（crawl-view/utils.validateNavigationUrl）据此放行落在该目录内的
   * `file://`，其余一律拒绝。随 view config 持久化，恢复链路自动保持（无状态）。
   */
  localPreviewRoot?: string;

  // === 显示控制 ===

  /** 显示模式（覆盖 profile 默认值） */
  displayMode?: ViewDisplayMode;

  /** 嵌入模式下的位置和大小（覆盖 profile 默认值） */
  bounds?: Rectangle;

  // === 生命周期 ===

  /** 是否持久化到 localStorage（覆盖 profile 默认值） */
  persistent?: boolean;

  /** 任务完成后是否自动关闭（覆盖 profile 默认值） */
  autoClose?: boolean;

  /** 是否保持活跃（用于翻页等场景） */
  keepAlive?: boolean;

  /** 保持活跃的时长（毫秒） */
  keepAliveDuration?: number;

  // === 标签系统 ===

  /** 是否在侧边栏显示标签（覆盖 profile 默认值） */
  showInSidebar?: boolean;

  /** 标签名称（显示在侧边栏） */
  tabName?: string;

  /** 是否通知渲染进程创建标签（默认根据 showInSidebar 决定） */
  notifyRenderer?: boolean;

  // === 任务关联 ===

  /** 关联的任务 ID */
  taskId?: string;

  /** 关联的 App ID（embeddedWeb 等场景下标识来源 App，用于持久化 session 的 partition key） */
  appId?: string;

  /** 关联的 run ID（用于 Session/事件归集） */
  runId?: string;

  /** 归属的 Space ID（资源监控归因首选来源，避免依赖 crawlspaceId 事后反查） */
  spaceId?: string;

  // === CDP 连接策略 ===

  /**
   * CDP 连接策略（覆盖 profile 默认值）
   * 🔥 用于优化快照获取性能
   * @default 根据 profile 决定
   */
  cdpStrategy?: CDPConnectionStrategy;

  // === 反检测配置 ===

  /**
   * 反检测配置（UA/代理/指纹/会话）
   * 🔥 优先级最高：会覆盖 userAgent、proxy 等单独配置
   * 🎯 使用 @tabtin/anti-detect 的 AntiDetectManager 统一管理
   *
   * @example
   * ```typescript
   * antiDetect: {
   *   userAgent: { preset: 'desktop', randomize: false },
   *   proxy: [{ server: 'http://proxy1.com:8080' }],
   *   fingerprint: { canvas: true, webgl: true, webrtc: true }
   * }
   * ```
   */
  antiDetect?: AntiDetectConfig;

  // === 其他选项 ===

  /** 自定义元数据 */
  metadata?: Record<string, any>;

  /**
   * User Agent（如果没有 antiDetect，则使用此配置）
   * ⚠️ 建议使用 antiDetect.userAgent 以享受 UA 池、轮换等高级功能
   */
  userAgent?: string;

  /**
   * 代理配置（如果没有 antiDetect，则使用此配置，仅在主进程 WebContents 层应用）
   * ⚠️ 建议使用 antiDetect.proxy 以享受健康检查、自动切换等高级功能
   */
  proxy?: {
    server: string;       // 如 http://host:port 或 socks5://host:port
    bypass?: string[];    // 绕过列表
    username?: string;
    password?: string;
  };

  /** Session 分区 */
  partition?: string;

  /**
   * Session 隔离模式（覆盖默认的 partition 行为）
   * - inherit: 使用共享 session（默认，forEmbedded）
   * - isolated: 使用独立持久化 session（persist:task-{taskId}）
   * - persistent: 使用持久化隔离 session（persist:marketplace-{appId}），同一 app 跨会话保留登录态
   * - temporary: 使用临时 session（任务结束后销毁）
   * 仅在未指定 partition 时生效
   */
  sessionMode?: SessionMode | 'persistent';
}

/**
 * Profile 预设配置
 */
export interface ProfilePreset {
  displayMode: ViewDisplayMode;
  persistent: boolean;
  autoClose: boolean;
  showInSidebar: boolean;
  cdpStrategy: CDPConnectionStrategy;  // 🆕 CDP 连接策略
  antiDetect?: AntiDetectConfig;  // 🆕 反检测预设配置
  description: string;
}

/**
 * View 句柄（创建后返回）
 */
export interface ViewHandle {
  /** View ID */
  id: string;

  /** WebContentsView 实例 */
  view: WebContentsView;

  /** 是否是复用的 View */
  reused: boolean;

  /** 应用的 Profile */
  profile: ViewProfile;

  /** 最终配置（antiDetect 和 proxy 为可选） */
  config: Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>;
}

/**
 * ViewEntry — ViewFactory 内部存储的纯配置/生命周期数据
 *
 * 运行时状态（url / inUse / lastAccessAt）统一通过 ViewStateRegistry 查询，
 * 不在此结构中保存，以消除双轨维护带来的竞态（CR-002）。
 */
export interface ViewEntry {
  /** View ID */
  id: string;

  /** WebContentsView 实例（ViewFactory 拥有生命周期所有权，discarded 后为 null） */
  view: WebContentsView | null;

  /**
   * : <webview> tag guest 的页面 WebContents（容器对象 = renderer 里的
   * <webview> 元素，主进程不持有；生命周期所有权在 renderer WebviewManager，
   * 主进程经 `destroyed` 事件被动收敛）。与 `view` 互斥：webview guest 条目
   * `view` 恒为 null。
   */
  guestWebContents?: WebContents;

  /**
   * : 容器实现类型。缺省（undefined）= WCV（历史条目零迁移）。
   */
  containerKind?: 'wcv' | 'webview-tag';

  /** 应用的 Profile */
  profile: ViewProfile;

  /** 最终配置（antiDetect 和 proxy 为可选） */
  config: Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>;

  /** 创建时间 */
  createdAt: number;

  /** 是否已添加到主窗口 */
  attachedToMainWindow: boolean;

  /** 是否已通知渲染进程创建标签 */
  tabNotified: boolean;

  /** 子系统注册状态（用于一致性校验） */
  registrations?: ViewRegistrationStatus;

  /** Tab Discarding: 底层 WebContentsView 已释放，但标签仍保留在 UI 中 */
  discarded?: boolean;

  /** Tab Discarding: 被 discard 前的 URL，用于用户点击时重建 View */
  discardedUrl?: string;
}

/**
 * ViewState — 完整 View 状态（ViewEntry + VSR 运行时数据的组合视图）
 *
 * 由 ViewFactory.getViewState() / getAllViewStates() 动态组合，
 * 保持外部 API 向后兼容。
 */
export interface ViewState extends ViewEntry {
  /** 当前 URL（来自 VSR） */
  url: string;

  /** 最后访问时间（来自 VSR.lastAccessTime） */
  lastAccessAt: number;

  /** 是否在使用中（来自 VSR.inUse） */
  inUse: boolean;
}

export type ViewRegistrationStatus = {
  runSession?: boolean;
  workspace?: boolean;
  contextHub?: boolean;
  viewStateRegistry?: boolean;
  resourceManager?: boolean;
  cdpManager?: boolean;
};

/**
 * ViewFactory 选项
 */
export interface ViewFactoryOptions {
  /** 是否启用详细日志 */
  verbose?: boolean;

  /** 最大 View 数量 */
  maxViews?: number;

  /** 空闲超时时间（毫秒） */
  idleTimeout?: number;

  /** 是否启用 View 复用 */
  enableReuse?: boolean;
}

/**
 * 销毁选项
 */
export interface DestroyViewOptions {
  /** 是否强制销毁（忽略 keepAlive） */
  force?: boolean;

  /** 是否立即销毁（不等待动画） */
  immediate?: boolean;

  /** Tab Discarding: 释放底层 WebContentsView 但保留标签 UI，标记为休眠态 */
  discard?: boolean;
}

/**
 * 显示选项
 */
export interface ShowViewOptions {
  /** 位置和大小 */
  bounds?: Rectangle;

  /** 是否自动选中标签 */
  autoSelect?: boolean;
}
