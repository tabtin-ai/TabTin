/**
 * 通知模块共享类型 — 主进程/preload/渲染进程公用
 */

type NavigateTargetBase = {
  organizationId?: string
  spaceId?: string
}

/**
 * Wave 6 续作 P0-3 (charter §4.4 "看产物 1 步可达"):
 *   通用产物定位字段。后端 envelope 把 GoalRun.context.agent_result 解析后
 *   透传到这里;前端 navigateToTarget(agentspace-app) 路径把它放进 openResourceTab
 *   的 meta,各 app 自己决定怎么用(tabmemo→memoId、tabdata→recordIds、
 *   tabdoc→docId、tabslide→slideId、tabcode→codePath …)。
 */
export type ArtifactRef = {
  artifactId?: string
  memoId?: string
  recordIds?: string[]
  docId?: string
  slideId?: string
  codePath?: string
  // 其它未来字段:扩 ArtifactRef,不要回 record/`Record<string,unknown>`
}

export type NavigateTarget =
  | (NavigateTargetBase & {
      type: 'chat-session'
      id: string
      /** 可选：进入会话后定位并高亮该消息 */
      messageId?: string
      /** 会话实际执行所在的 Workspace；Project 会话仍需要它做执行归属。 */
      workspaceId?: string
      /** Project 会话的展示/协作作用域，优先于 workspaceId 做导航。 */
      projectId?: string
    })
  // Tracker 模块波次 4 Stage 2 一刀切：仅保留 ``tracker``。产品未上线，
  // 历史 ``goal`` / ``agenda`` union 成员已删除（详见上游 PRD §0 / 决策 6）。
  | (NavigateTargetBase & {
      type: 'tracker'
      id: string
      /** 可选：打开 Tracker 后定位到具体 Run */
      runId?: string
      /** 可选：进入该 Run 对应的执行记录会话 */
      sessionId?: string
    })
  | (NavigateTargetBase & { type: 'im-conversation'; id: string })
  | (NavigateTargetBase & { type: 'im-contacts'; id: 'incoming' | 'outgoing' })
  | (NavigateTargetBase & { type: 'extension'; id: string; route?: string })
  | (NavigateTargetBase & { type: 'notification-panel'; id: string })
  | (NavigateTargetBase & { type: 'settings'; id: string; route?: string })
  | (NavigateTargetBase & {
      type: 'agentspace-app'
      id: string
      route?: string
      /**
       * Wave 6 续作 P0-3:产物定位元信息。如有,navigateToTarget 会把它
       * 放入 openResourceTab 的 meta,各 app 容器读取后跳具体产物。
       */
      artifactRef?: ArtifactRef
    })
  /**
   * Wave 4(分享与协作者邀请):被邀请人收到 ``type='resource_shared'`` 通知后
   * 的跳转目标。resourceType 决定走 tabdoc / tabdata handler;``id`` 即 docId
   * / tableId(后端 Wave 2 metadata.resource_id)。``action`` 'removed' /
   * 'auto_removed' 不应到达这里——resolver 应返回 undefined,由 store 层走 toast 分支。
   */
  | (NavigateTargetBase & {
      type: 'resource-shared'
      id: string
      resourceType: 'doc' | 'table'
      resourceTitle?: string
      /** TabData 协作通知可精确打开一条记录的评论面板。 */
      recordId?: string
      /** TabDoc 协作通知可精确打开评论线程。 */
      threadId?: string
      commentId?: string
      openComments?: boolean
    })

/**
 * Toast 回退策略。
 *
 * - boolean 是历史 Download / Update 契约，true 保留所有旧回退路径；
 * - desktop-unavailable 仅补偿 Desktop 通道不可用，不绕过总开关、DND、
 *   限流或去重等用户意图。
 */
export type ToastFallbackPolicy = boolean | 'desktop-unavailable'

export interface NotificationPayload {
  type: string
  title: string
  body: string
  priority?: 'urgent' | 'high' | 'normal' | 'low'
  organizationId?: string
  spaceId?: string
  sessionId?: string
  metadata?: Record<string, unknown>
  onClick?: 'focus' | 'navigate'
  navigateTo?: NavigateTarget
  silent?: boolean
  desktopDelivery?: 'never' | 'unfocused' | 'always'
  /** 服务端已持久化或明确不进 Center 时，禁止再生成本地镜像卡。 */
  mirrorToCenter?: boolean
  /** Desktop 未实际投递时，由主进程按策略回退应用内 Toast。 */
  toastFallback?: ToastFallbackPolicy
  /** 来源窗口确实聚焦时抑制；由主进程用 BrowserWindow 原生状态终局裁决。 */
  suppressWhenSourceWindowFocused?: boolean
  /** 原生焦点确认抑制后，通知来源窗口同步该会话已读。 */
  markSessionViewedWhenSuppressed?: boolean
}

export type NotificationPermissionKind =
  | 'authorized'
  | 'denied'
  | 'not-determined'
  | 'provisional'
  | 'restricted'
  | 'unknown'
  | 'unsupported'

export interface NotificationPermissionStatus {
  supported: boolean
  granted: boolean
  status: NotificationPermissionKind
  source: 'system-preferences' | 'fallback'
  platform: NodeJS.Platform
}

export interface DndSchedule {
  start: string
  end: string
  days: number[]
}

export interface CategoryOverride {
  desktopEnabled?: boolean
  soundEnabled?: boolean
  dockBadgeEnabled?: boolean
  /**
   * 桌面横幅投递策略。未设置时沿用 desktopEnabled + presenter 既有前台抑制规则。
   * Agent 任务结果用它表达「从不 / 仅应用失焦 / 始终」。
   */
  desktopDelivery?: 'never' | 'unfocused' | 'always'
}

/**
 * 账号级通知偏好。
 *
 * 设计说明：这一份偏好对当前登录用户在本机的所有 organization 一致生效。
 * 历史上曾按 organizationId 分桶存储，导致同一个用户切团队会看到不同
 * 「桌面横幅/声音/免打扰」配置——这不符合用户心智（"我要不要被打扰"
 * 是个人决定，不取决于在哪个团队工作）。已在 2026-05 治理时收敛到账号级。
 */
export interface NotificationPrefs {
  enabled: boolean
  desktopEnabled: boolean
  dockBadgeEnabled: boolean
  soundEnabled: boolean
  dndEnabled: boolean
  dndSchedule?: DndSchedule
  categoryOverrides: Record<string, CategoryOverride>
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  desktopEnabled: true,
  dockBadgeEnabled: true,
  soundEnabled: true,
  dndEnabled: false,
  categoryOverrides: {},
}

/** 通知类型 → 分类 key 的映射表（prefix 不带尾部 `.`） */
export const CATEGORY_MAP: [string, string][] = [
  ['organization', 'organization'],
  ['invite_accepted', 'organization'],
  ['member_added', 'organization'],
  ['member_removed', 'organization'],
  ['role_changed', 'organization'],
  ['ownership_transfer', 'organization'],
  ['resource_shared', 'collaboration'],
  ['resource_access_request', 'collaboration'],
  ['tabdoc.comment', 'collaboration'],
  ['tabdata.comment', 'collaboration'],
  ['tabdata.record.user_assigned', 'collaboration'],
  ['account', 'account'],
  ['balance_low', 'account'],
  ['cash_recharged', 'account'],
  ['agent.task.completed', 'agent.task.result'],
  ['agent.task.error', 'agent.task.result'],
  ['agent.task.interrupted', 'agent.task.interruption'],
  ['agent.task.session_interrupted', 'agent.task.interruption'],
  ['agent.hitl', 'agent.hitl'],
  ['tracker.run', 'tracker.run'],
  ['im', 'im'],
  ['download', 'download'],
  ['extension', 'extension'],
  ['extension_event', 'extension'],
  ['system.update', 'system.update'],
]

export function resolveCategoryKey(type: string): string | undefined {
  for (const [prefix, key] of CATEGORY_MAP) {
    if (type === prefix || type.startsWith(prefix + '.')) {
      return key
    }
  }
  return undefined
}
