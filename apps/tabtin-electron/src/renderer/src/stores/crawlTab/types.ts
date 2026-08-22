/**
 * Crawl Tab Store — shared type definitions.
 *
 * Extracted from useCrawlTabStore.ts so that consumers can import
 * types without pulling in the entire store module.
 */

import type { OpenIntentHints } from '@shared/open-intent'

export type CrawlTabKind = 'workspace' | 'normal' | 'temporary'

export interface CrawlspaceConfig {
  crawlspaceId: string
  /**
   * Browser runtime carrier 的归属 scope。
   *
   * Phase 3b：普通 browser view 不再只按 Space 承载；desktop / conversation
   * 标签池各有自己的 crawlspace carrier。`spaceId` 仍表示执行 / 权限来源，
   * `browserScopeKey` 才是用户可见浏览器标签池的运行载体 key。
   */
  browserScopeKey?: string
  spaceId?: string
  projectId?: string
  pluginId?: string
  pluginConfig?: Record<string, any>
  uiConfig?: {
    enableMultiView?: boolean
    showToolbar?: boolean
    showPanel?: boolean
    panelLocked?: boolean
    showTabs?: boolean
    defaultTitle?: string
  }
  profile: string
  partition: string
  runPrefix?: string
  /** 命名 session 标识。有值时表示该 Crawlspace 是 session 隔离的命名实例 */
  sessionName?: string
  /** Session 颜色标识（Firefox 容器风格，用于标签页颜色条区分身份） */
  sessionColor?: string
}

export interface CrawlspaceViewInfo {
  viewId: string
  title: string
  url: string
  favicon?: string
  runId?: string
  resourceSummary?: {
    total: number
    byCategory: Partial<Record<string, number>>
    byCaptureStatus?: Partial<Record<string, number>>
  }
  kind?: 'workspace-view' | 'normal-view'
  crawlspaceId?: string
  isPreview?: boolean
  isClosing?: boolean
  isLoading?: boolean
  themeColor?: string
  hasError?: boolean
  errorDescription?: string
  openIntentHints?: OpenIntentHints
  createdAt: number
  updatedAt?: number
}

export type CrawlspaceViewMetaUpdates = Partial<Pick<
  CrawlspaceViewInfo,
  | 'title'
  | 'url'
  | 'favicon'
  | 'runId'
  | 'kind'
  | 'crawlspaceId'
  | 'isPreview'
  | 'themeColor'
  | 'isLoading'
  | 'hasError'
  | 'errorDescription'
  | 'openIntentHints'
>>

export interface CrawlTabMetadata {
  crawlspaceId?: string
  crawlspaceConfig?: CrawlspaceConfig
  profile?: string
  partition?: string
  runId?: string
  kind?: 'workspace-view' | 'normal-view'
  isPreview?: boolean
  themeColor?: string
  toolbarColor?: string
  [key: string]: unknown
}

export interface CrawlTab {
  id: string
  name: string
  url: string
  createdAt: Date
  updatedAt: Date
  runId?: string
  temporary?: boolean
  autoClose?: boolean
  kind?: CrawlTabKind
  metadata?: CrawlTabMetadata
}

export interface CrawlspacePreviewState {
  previewTabId: string | null
  previewUrl: string
  hasView: boolean
  lastAccessAt: number
}

export type CrawlspaceContextCache = {
  activeViewId: string | null
  viewList: CrawlspaceViewInfo[]
}

export type CrawlspacePersistedViewSeed = {
  viewId: string
  title: string
  url: string
  favicon?: string
  runId?: string
  kind?: 'workspace-view' | 'normal-view'
  crawlspaceId?: string
  isPreview?: boolean
  isActive?: boolean
  createdAt: number
  position?: number
  lastAccessedAt?: number
  /**
   * ：本地 HTML 产物预览（file:// URL）的受限放行根（= 打开时的工作目录）。
   * 重启 / 冷启动恢复重建 view 时随 createView 传回主进程——缺失则 file:// 一律
   * 被安全门禁拒绝，恢复出来的预览 tab 会空白。
   */
  localPreviewRoot?: string
  /**
   * ：无后缀 signed URL 的文件识别 metadata。只和当前 seed.url 绑定，
   * 恢复重建 View 时传回主进程供 Preview Guard 判断。
   */
  openIntentHints?: OpenIntentHints
}

/**
 * Store-level 操作结果（不是 IPC envelope）。字段命名贴合 D-1（envelope = `ok`），
 * 避免与 renderer 内 `result.success === ...` 的旧 IPC 模式混淆，让北极星 grep 干净。
 */
export type CloseCrawlspaceViewResult = {
  ok: boolean
  code:
    | 'closed'
    | 'closed_with_context_prune'
    | 'context_pruned'
    | 'already_closed'
    | 'already_closing'
    | 'ipc_close_failed'
  message?: string
}
