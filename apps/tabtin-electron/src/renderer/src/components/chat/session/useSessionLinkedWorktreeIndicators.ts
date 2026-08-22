/**
 * 会话列表编排层：订阅 active 会话代码根绑定，按仓库缓存 worktree list，
 * 产出 sessionId → linked worktree 展示模型。
 *
 * 重启后 renderer 镜像为空：对已加载 sessionIds 去重后批量 hydrate 一次，
 * 再复用 worktree cache + indicator 解析。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSession } from '@tabtin/chat-client'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'
import { hydrateSessionCodeRoots } from '@/services/sessionCodeRootBinding'
import {
  loadWorktreesForSessionRoot,
  peekCachedWorktreesForSessionRoot,
} from './sessionLinkedWorktreeCache'
import {
  resolveSessionLinkedWorktreeIndicator,
  type SessionLinkedWorktreeIndicator,
} from './resolveSessionLinkedWorktreeIndicator'

type SessionRef = Pick<ChatSession, 'id' | 'forked_from_id'>

export function useSessionLinkedWorktreeIndicators(
  sessions: ReadonlyArray<SessionRef>,
): Readonly<Record<string, SessionLinkedWorktreeIndicator>> {
  const bindingsBySessionId = useSessionBoundCodeRootStore((s) => s.bindingsBySessionId)
  const getBinding = useSessionBoundCodeRootStore((s) => s.getBinding)
  const [cacheEpoch, setCacheEpoch] = useState(0)
  /** 已发起过 hydration 的 sessionId，避免列表重复渲染打多次 IPC。 */
  const hydratedIdsRef = useRef<Set<string>>(new Set())

  const sessionIdsKey = useMemo(
    () => [...new Set(sessions.map((s) => s.id).filter(Boolean))].sort().join('\0'),
    [sessions],
  )

  useEffect(() => {
    if (!sessionIdsKey) return
    const sessionIds = sessionIdsKey.split('\0').filter(Boolean)
    const pending = sessionIds.filter((id) => !hydratedIdsRef.current.has(id))
    if (pending.length === 0) return

    let cancelled = false
    void (async () => {
      // 成功后再标记；IPC 未就绪时不钉死，允许会话列表稍后重试
      const count = await hydrateSessionCodeRoots(pending)
      if (cancelled) return
      const available = typeof window.tabtin?.agent?.listSessionCodeRoots === 'function'
      if (available || count > 0) {
        for (const id of pending) hydratedIdsRef.current.add(id)
      }
      setCacheEpoch((value) => value + 1)
    })()

    return () => {
      cancelled = true
    }
  }, [sessionIdsKey])

  const rootPathKey = useMemo(() => {
    const paths = new Set<string>()
    for (const session of sessions) {
      const binding = getBinding(session.id, {
        parentSessionId: session.forked_from_id,
      })
      if (binding?.status === 'active' && binding.rootPath.trim()) {
        paths.add(binding.rootPath)
      }
    }
    return [...paths].sort().join('\0')
  }, [sessions, bindingsBySessionId, getBinding])

  useEffect(() => {
    if (!rootPathKey) return
    let cancelled = false
    const uniquePaths = rootPathKey.split('\0').filter(Boolean)

    void (async () => {
      await Promise.all(uniquePaths.map((rootPath) => loadWorktreesForSessionRoot(rootPath)))
      // 无论本次是否新拉 IPC：完成后 bump，避免「请求写入模块缓存但被取消 → 永不刷新」
      if (!cancelled) {
        setCacheEpoch((value) => value + 1)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [rootPathKey])

  return useMemo(() => {
    const result: Record<string, SessionLinkedWorktreeIndicator> = {}
    for (const session of sessions) {
      const binding = getBinding(session.id, {
        parentSessionId: session.forked_from_id,
      })
      if (!binding || binding.status !== 'active') continue
      const worktrees = peekCachedWorktreesForSessionRoot(binding.rootPath)
      const indicator = resolveSessionLinkedWorktreeIndicator({ binding, worktrees })
      if (indicator) {
        result[session.id] = indicator
      }
    }
    return result
  }, [sessions, bindingsBySessionId, getBinding, cacheEpoch])
}
