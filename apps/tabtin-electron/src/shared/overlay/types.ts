export type OverlayToastPayload = {
  type: 'toast'
  id?: string
  title?: string
  description?: string
  variant?: 'default' | 'destructive' | 'success' | 'warning'
  /** ms；0 = 常驻。IPC 前须规范化，禁止传 Infinity（结构化克隆可能丢精度）。 */
  duration?: number
  viewport?: {
    centerX: number
    width: number
  }
}

/** 主窗 → toast 子窗：跨窗口 update / destroy（统一 Message 模块）。 */
export type OverlayToastControlPayload = {
  type: 'toast-control'
  action: 'update' | 'destroy' | 'destroy-all'
  id?: string
  title?: string
  description?: string
  variant?: 'default' | 'destructive' | 'success' | 'warning'
  duration?: number
}

export type OverlayGlobalSearchPayload = {
  type: 'global-search'
  open: boolean
  organizationId?: string | null
  activeSpaceId?: string | null
  /**
   * 主 renderer 算好的前台标签 scope key（desktop:workteam:... / conversation:...）。
   * 子窗口内 store 是独立副本，spaces / currentSessionId 均为空，无法自行解析——
   * 必须由主窗口随 activeSpaceId 一起推送。
   */
  tabScopeKey?: string | null
}

export type OverlayConfirmPayload = {
  type: 'confirm'
  requestId: string
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export type OverlayConfirmResultPayload = {
  type: 'confirm-result'
  requestId: string
  confirmed: boolean
}

export type OverlayUpdatePromptStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export type OverlayUpdatePromptInfo = {
  version?: string
  mandatory?: boolean
  releaseNotes?: string
  release_notes?: string
  fileSize?: number
  file_size?: number
  files?: Array<{ size?: number }>
}

export type OverlayUpdatePromptState = {
  currentVersion?: string
  status: OverlayUpdatePromptStatus
  downloadProgress?: number
  updateInfo?: OverlayUpdatePromptInfo | null
  errorMessage?: string
}

export type OverlayUpdatePromptPayload = {
  type: 'update-prompt'
  open: boolean
  state?: OverlayUpdatePromptState
}

export type OverlayUpdatePromptActionPayload = {
  type: 'update-prompt-action'
  action: 'dismiss' | 'open-settings' | 'download' | 'install'
}

export type OverlayAnchorRect = {
  x: number
  y: number
  width: number
  height: number
}

/** 通知面板：锚定铃铛下方、无蒙层；数据由子窗口自拉（带 organizationId），动作回传主 renderer 执行。 */
export type OverlayNotificationPayload = {
  type: 'notification'
  open: boolean
  anchor?: OverlayAnchorRect
  organizationId?: string | null
  /** 主窗口当前界面语言，overlay 独立 i18n 实例打开时对齐。 */
  locale?: string | null
  /**
   * 主 renderer 尚未被服务端持久通知接管的本地镜像。
   * modal renderer 有独立 Zustand 实例，打开面板时必须显式同步，避免入口角标有未读、列表为空。
   */
  localNotifications?: unknown[]
}

/**
 * 主窗收到新通知后刷新已打开的 overlay 列表。
 * 不改变 open 状态；面板未开时子窗口可忽略，仅 invalidate 缓存。
 */
export type OverlayNotificationRefreshPayload = {
  type: 'notification-refresh'
  organizationId?: string | null
}

/** 通知面板内的动作：子窗口收集 → 主 renderer 执行（store/query/mutation/导航在主窗口）。 */
export type OverlayNotificationActionPayload = {
  type: 'notification-action'
  /** open-center | navigate | mark-read | view-artifact | view-run-detail | open-invitation | select-invitation | mark-all-read */
  kind: string
  /** NotificationItem / Invitation 等纯数据（跨进程序列化） */
  notif?: unknown
  invitation?: unknown
  appId?: string
  trackerId?: string
}

export type OverlayPushPayload =
  | OverlayToastPayload
  | OverlayToastControlPayload
  | OverlayGlobalSearchPayload
  | OverlayConfirmPayload
  | OverlayUpdatePromptPayload
  | OverlayNotificationPayload
  | OverlayNotificationRefreshPayload

export type OverlayRendererMessage =
  | OverlayPushPayload
  | OverlayConfirmResultPayload
  | OverlayUpdatePromptActionPayload
  | { type: 'ready' }
