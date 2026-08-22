import type React from 'react'
import type { ChatSession } from '@tabtin/chat-client'
import type { ExecutionDeviceStatus } from '@components/context-space/terminalOverviewModel'

export interface ChatSessionSwitcherProps {
  variant: 'tabs' | 'list'
  /** 侧栏列表用：通常已去掉未发消息的空会话。 */
  sessions: ChatSession[]
  /**
   * 未过滤会话，专供预建空草稿选中态 lookup。
   * 列表把 message_count=0 滤掉后，仍靠这份数据判断「当前已是新任务」。
   * 省略时回退为 sessions。
   */
  draftLookupSessions?: ChatSession[]
  currentSessionId: string | null
  showDraftSession?: boolean
  isLoading?: boolean
  onSelectSession: (sessionId: string) => void | Promise<void>
  onCreateSession?: () => void | Promise<void>
  onRenameSession?: (sessionId: string, title: string) => void | Promise<void>
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  onForkSession?: (sessionId: string) => void | Promise<void>
  onUnforkSession?: (sessionId: string) => void | Promise<void>
  onTogglePin?: (sessionId: string) => void
  pinnedSessionIds?: Set<string>
  className?: string
  style?: React.CSSProperties
  scopeKey?: string | null
  draftBadgeSpaceId?: string | null
  /** `undefined` 时自动推导；`null` 时不高亮任何 Workspace。 */
  workspaceHighlightSpaceId?: string | null
  trackerRunSessions?: ChatSession[]
  trackerRunCount?: number | null
  trackerRunsLoading?: boolean
  trackerRunsError?: string | null
  onExpandTrackerRuns?: () => void
  onRetryTrackerRuns?: () => void
  spaceNameById?: Record<string, string>
  spaceLastActivityById?: Record<string, string | null | undefined>
  spaceSectionTitle?: string
  spaceSectionKeyById?: Record<string, string>
  spaceSectionOrder?: string[]
  spaceSectionTitleByKey?: Record<string, string>
  createSpaceActionBySectionKey?: Record<string, React.ReactNode>
  showWorkspaceSortControlBySectionKey?: Record<string, boolean>
  createSpaceAction?: React.ReactNode
  showWorkspaceSortControl?: boolean
  onOpenSpaceSettings?: (spaceId: string) => void
  onCreateSessionInSpace?: (spaceId: string) => void
  /**
   * 覆盖默认「按 Space id 解析执行设备状态」。
   * Project 沉浸侧栏分组 key 是任务 id / 项目对话桶，须走任务现场口径。
   */
  resolveSpaceDeviceStatus?: (targetSpaceId: string | null) => ExecutionDeviceStatus | null
  canCreateSessionInSpace?: (spaceId: string) => boolean
  listContent?: 'all' | 'sessions' | 'trackerRuns'
  listFooter?: React.ReactNode
  /** 按 Workspace 归组的外部档案（侧栏「外部历史」子组） */
  externalArchivesBySpaceId?: Record<string, Array<{
    source: string
    sourceSessionId: string
    title: string
    messageCount: number
    cwd: string | null
    openedSessionId?: string | null
  }>>
  onOpenExternalArchive?: (archive: {
    source: string
    sourceSessionId: string
  }) => void
  onDeleteExternalArchive?: (archive: {
    source: string
    sourceSessionId: string
    title: string
    openedSessionId?: string | null
  }) => void | Promise<void>
  /**
   * 已由外部档案展开的真会话 id。
   * 本机态：不提供分叉；侧栏「归档」语义改为删除本机外部档案。
   */
  externalOpenedSessionIds?: ReadonlySet<string>
  /** 用 openedSessionId 反查外部档案，供已展开行的删除确认。 */
  resolveExternalArchiveByOpenedSessionId?: (sessionId: string) => {
    source: string
    sourceSessionId: string
    title: string
    openedSessionId?: string | null
  } | null
}
