import type { ChatSession } from '@tabtin/chat-client'
import type { GroupKey } from '@/utils/chat-session-sort'

export type CollapsibleGroupKey =
  | GroupKey
  | `space:${string}`
  | `section:${string}`
  | `fork:${string}`
  | `external:${string}`

export type ExternalArchiveListItem = {
  source: string
  sourceSessionId: string
  title: string
  messageCount: number
  cwd: string | null
  openedSessionId?: string | null
}

export type SessionListVirtualItem =
  | {
      type: 'header'
      key: CollapsibleGroupKey
      label: string
      count: number | null
      collapsed: boolean
      externalArchiveCount?: number
    }
  | { type: 'space_section_header'; sectionKey?: string; count?: number; collapsed?: boolean }
  | {
      type: 'session'
      session: ChatSession
      nested?: boolean
      /** fork 相对父会话的深度；>0 表示挂在父对话下 */
      forkDepth?: number
      /** 有直接 fork 子会话时可折叠 */
      forkBranch?: { collapsed: boolean; childCount: number }
    }
  | {
      type: 'external_archive'
      spaceId: string
      archive: ExternalArchiveListItem
    }
  | { type: 'tracker_loading' }
  | { type: 'tracker_error'; message: string }

export type PushSessionFn = (session: ChatSession, nested?: boolean) => void
