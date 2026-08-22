import { useCrawlTabStore } from '@/stores/useCrawlTabStore'
import { useTerminalSplitStore } from '@/stores/useTerminalSplitStore'
import { useTerminalSessionStore } from '@components/context-space/sources/terminal'

export function rehomeConversationScopeRuntime(
  fromScopeKey: string | null | undefined,
  toScopeKey: string | null | undefined,
): {
  crawlspaceId: string | null
  terminalSessions: number
  terminalLayouts: number
} {
  const empty = {
    crawlspaceId: null,
    terminalSessions: 0,
    terminalLayouts: 0,
  }
  if (!fromScopeKey?.startsWith('conversation:draft:')) return empty
  if (
    !toScopeKey?.startsWith('conversation:')
    || toScopeKey.startsWith('conversation:draft:')
  ) {
    return empty
  }

  const crawlspaceId = useCrawlTabStore
    .getState()
    .rehomeScopedCrawlspace(fromScopeKey, toScopeKey)
  const terminalSessions = useTerminalSessionStore
    .getState()
    .rehomeScopeSessions(fromScopeKey, toScopeKey)
  const terminalLayouts = useTerminalSplitStore
    .getState()
    .rehomeScopeLayouts(fromScopeKey, toScopeKey)

  return { crawlspaceId, terminalSessions, terminalLayouts }
}
