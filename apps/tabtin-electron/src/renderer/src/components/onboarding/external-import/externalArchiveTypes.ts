import type { ImportSourceId } from '@tabtin/cli-server-core'

export interface ExternalArchiveIndexEntry {
  source: ImportSourceId
  sourceSessionId: string
  title: string
  cwd: string | null
  workspaceId: string | null
  importedAt: string
  messageCount: number
  /** 已展开过的真会话；侧栏再次点击应复用 */
  openedSessionId?: string | null
}

export interface ExternalArchiveFocus {
  source: string
  sourceSessionId: string
}
