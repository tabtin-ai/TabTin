/**
 * 按组织拉取本机外部档案，并按 Workspace 归组（侧栏挂载用）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useChatStore } from '@stores/chat/useChatStore'
import type { ExternalArchiveIndexEntry } from './externalArchiveTypes'
import { useExternalArchiveIndexStore } from './useExternalArchiveIndexStore'
import { syncExternalOpenedSessions } from './externalOpenedSessionRegistry'
import { ensureSessionAgentLikeNewChat } from './continueExternalArchiveChat'
import { silentRehydrateFromArchive } from './rehydrateExternalOpenedSession'

function normalizeDir(dir: string): string {
  return dir.trim().replace(/\/+$/, '')
}

function matchSpaceId(
  entry: ExternalArchiveIndexEntry,
  spaces: Array<{ id: string; working_dir?: string | null }>,
): string | null {
  if (entry.workspaceId && spaces.some((s) => s.id === entry.workspaceId)) {
    return entry.workspaceId
  }
  if (entry.cwd) {
    const target = normalizeDir(entry.cwd)
    const byCwd = spaces.find(
      (s) => s.working_dir && normalizeDir(s.working_dir) === target,
    )
    if (byCwd) return byCwd.id
  }
  return entry.workspaceId
}

export function useOrganizationExternalArchives(spaces: Array<{
  id: string
  working_dir?: string | null
}>): {
  loading: boolean
  archives: ExternalArchiveIndexEntry[]
  archivesBySpaceId: Record<string, ExternalArchiveIndexEntry[]>
  /** 已绑定展开会话 id——侧栏保活 / 草稿勿复用 */
  boundSessionIds: ReadonlySet<string>
  refresh: () => void
} {
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const indexVersion = useExternalArchiveIndexStore((s) => s.version)
  const [archives, setArchives] = useState<ExternalArchiveIndexEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!organizationId) {
      setArchives([])
      syncExternalOpenedSessions([])
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const api = window.tabtin?.import
        if (!api?.listArchives) {
          if (!cancelled) {
            setArchives([])
            syncExternalOpenedSessions([])
          }
          return
        }
        const list = (await api.listArchives(organizationId)) as ExternalArchiveIndexEntry[]
        if (cancelled) return
        const next = Array.isArray(list) ? list : []
        setArchives(next)
        syncExternalOpenedSessions(next.flatMap((entry) => {
          const openedSessionId = entry.openedSessionId?.trim()
          return openedSessionId
            ? [{
                source: entry.source,
                sourceSessionId: entry.sourceSessionId,
                title: entry.title,
                openedSessionId,
              }]
            : []
        }))
      } catch {
        if (!cancelled) {
          setArchives([])
          syncExternalOpenedSessions([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [organizationId, tick, indexVersion])

  // 会话列表指纹：删会话 / 新展开后要重算「已打开则隐藏档案行」
  const sessionIdsFingerprint = useChatStore((s) => {
    const ids: string[] = []
    for (const list of Object.values(s.sessionsBySpaceId)) {
      for (const session of list ?? []) ids.push(session.id)
    }
    return ids.sort().join('|')
  })

  const boundSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of archives) {
      const openedId = entry.openedSessionId?.trim()
      if (openedId) ids.add(openedId)
    }
    return ids
  }, [archives])

  const archivesBySpaceId = useMemo(() => {
    const map: Record<string, ExternalArchiveIndexEntry[]> = {}
    const chat = useChatStore.getState()
    for (const entry of archives) {
      const spaceId = matchSpaceId(entry, spaces)
      if (!spaceId) continue
      // 无消息档案：不进侧栏（导入侧已过滤；这里兜底历史残留）
      if ((entry.messageCount ?? 0) <= 0) continue
      // 已展开为真会话的：只保留会话行，档案行不再并列（避免同名叠两份）
      const openedId = entry.openedSessionId?.trim()
      if (openedId) {
        const stillThere =
          (chat.sessionsBySpaceId[spaceId] ?? []).some((s) => s.id === openedId)
          || Boolean(chat.getSessionById?.(openedId))
        if (stillThere) continue
      }
      if (!map[spaceId]) map[spaceId] = []
      map[spaceId].push(entry)
    }
    for (const list of Object.values(map)) {
      list.sort((a, b) => Date.parse(b.importedAt) - Date.parse(a.importedAt))
    }
    return map
  }, [archives, spaces, sessionIdsFingerprint])

  // 重启后：已绑定会话静默回灌消息；缺 agent_id 时按新建会话同款补绑
  useEffect(() => {
    if (!organizationId || archives.length === 0) return
    const chat = useChatStore.getState()
    for (const entry of archives) {
      const sessionId = entry.openedSessionId?.trim()
      if (!sessionId) continue
      const spaceId = matchSpaceId(entry, spaces)
      if (!spaceId) continue
      const stillThere =
        (chat.sessionsBySpaceId[spaceId] ?? []).some((s) => s.id === sessionId)
        || Boolean(chat.getSessionById?.(sessionId))
      if (!stillThere) continue
      const session = chat.getSessionById?.(sessionId)
      if (!session?.agent_id) {
        void ensureSessionAgentLikeNewChat(sessionId, spaceId, organizationId)
      }
      // 即使已有 live 消息也要跑：transcript 覆盖可能冲掉横幅/边界（O1 / ）
      void silentRehydrateFromArchive({
        organizationId,
        source: entry.source,
        sourceSessionId: entry.sourceSessionId,
        sessionId,
      })
    }
  }, [archives, organizationId, spaces, sessionIdsFingerprint])

  return { loading, archives, archivesBySpaceId, boundSessionIds, refresh }
}
