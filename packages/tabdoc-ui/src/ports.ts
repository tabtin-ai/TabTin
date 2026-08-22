/**
 * TabDoc Editor Ports — 宿主无关的能力接口
 *
 * 各宿主（Electron / Web / AdminDash）实现这些接口，
 * 通过 TabDocEditorConfigProvider 注入到共享编辑器组件中。
 */

// ── 图片上传 ──

export interface TabDocImageUploadResult {
  url: string
  /** Stable FileRecord id; private image rendering and sharing use this binding. */
  fileId: string
  /** Stable object key for non-ProseMirror properties such as document covers. */
  fileKey?: string
}

export interface TabDocImageUploadOptions {
  folder?: string
  module?: string
  contextType?: string
  contextId?: string
}

export interface TabDocImageUploadPort {
  upload(file: File, options: TabDocImageUploadOptions): Promise<TabDocImageUploadResult>
  validate?(file: File): { valid: boolean; reason?: string; maxSizeLabel?: string }
}

// ── HTML 嵌入块上传 ──
//
// 与图片上传对称，但块需要 fileId（编辑回路 source of truth）+ url（access_url，渲染用）两个返回值，
// 而图片只需要 url。宿主可选实现；未注入时前端不显示 HTML slash 项 / 不拦截 .html 拖拽（公开分享页等）。

export interface TabDocHtmlUploadResult {
  /**
   * Legacy public access URL. New private uploads  should return empty string;
   * rendering goes through fileId + HtmlArtifactLoader.
   */
  url: string
  /** OSS FileRecord id，写入 htmlBlock.fileId，作为编辑回路的 source of truth */
  fileId: string
}

export interface TabDocHtmlUploadOptions {
  documentId?: string
}

export interface TabDocHtmlUploadPort {
  upload(file: File, options: TabDocHtmlUploadOptions): Promise<TabDocHtmlUploadResult>
  validate?(file: File): { valid: boolean; reason?: string; maxSizeLabel?: string }
}

// ── 认证 ──

export interface TabDocAuthPort {
  getAccessToken(): Promise<string | null>
  refreshAccessToken?(): Promise<string | null>
  getCurrentUser(): TabDocCurrentUser | null
}

export interface TabDocCurrentUser {
  id: string
  nickname?: string | null
  username?: string | null
  email?: string | null
}

// ── 协作配置 ──

export interface TabDocCollabConfig {
  wsUrl: string
  enabled: boolean
  onStoreFailed?: (error: unknown) => void
}

// ── 文档事件流（旧链路 fallback） ──

export interface TabDocEventStreamEvent {
  event: string
  data: Record<string, unknown>
}

export interface TabDocEventStreamPort {
  subscribe(
    documentId: string,
    onEvent: (event: TabDocEventStreamEvent) => void,
  ): TabDocEventStreamSubscription
}

export interface TabDocEventStreamSubscription {
  readonly status: string
  unsubscribe(): void
}

// ── 运行时监控（可选） ──

export interface TabDocRuntimeMonitorPort {
  createInstanceId(): string
  register(instanceId: string, meta: Record<string, unknown>): void
  update(instanceId: string, meta: Record<string, unknown>): void
  unregister(instanceId: string): void
  publishMetrics(instanceId: string, metrics: Record<string, unknown>): void
}

// ── 聚合配置 ──

export interface TabDocEditorConfig {
  auth: TabDocAuthPort
  collab: TabDocCollabConfig
  imageUpload: TabDocImageUploadPort
  /** HTML 嵌入块上传能力（可选）。未注入时前端不暴露 HTML 插入入口。 */
  htmlUpload?: TabDocHtmlUploadPort
  eventStream?: TabDocEventStreamPort
  runtimeMonitor?: TabDocRuntimeMonitorPort
  apiBaseUrl: string
  dragTypeMeta?: string
  chatContextDragType?: string
  /** 跨应用文件引用拖入文档的 MIME（如 application/x-tabtin-file-ref） */
  fileRefDragType?: string
}
