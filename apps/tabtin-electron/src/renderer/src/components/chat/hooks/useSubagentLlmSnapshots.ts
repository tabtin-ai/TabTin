/**
 * useSubagentLlmSnapshots — 加载某个子 Agent 的 LLM 调用快照（上下文 debug）。
 *
 * 子 Agent 的每次 LLM 调用上下文由 `fork-query` 落在子 session 的 snapshots.jsonl
 * （sidechain 目录），与主 Agent 的 snapshots.jsonl 分开。本 hook 复用既有 IPC
 * `agent-engine:read-subagent-session`（kind='snapshots'）按 subagentRunId 读取，
 * 再按 (runId, iteration) 去重（调用后带 response 的快照覆盖调用前），产出与主
 * Agent 同型的 `LLMCallSnapshot[]`，直接喂给 `LLMSnapshotPanel` 渲染。
 *
 * `subagentRunId` 为 null（选中「主 Agent」）时不加载、返回空。
 */
import { useEffect, useState } from 'react'
import { useChatStore } from '@/stores/chat/useChatStore'
import type { LLMCallSnapshot } from '@/stores/chat/shared/types'

const EMPTY: LLMCallSnapshot[] = []

/** 与主进程 read-snapshots 同款去重：按 (runId, iteration) 后到覆盖，保持首现顺序。 */
function dedupSnapshots(lines: readonly unknown[]): LLMCallSnapshot[] {
  const byKey = new Map<string, LLMCallSnapshot>()
  const order: string[] = []
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const s = line as LLMCallSnapshot
    if (typeof s.runId !== 'string' || typeof s.iteration !== 'number') continue
    const key = `${s.runId}#${s.iteration}`
    if (!byKey.has(key)) order.push(key)
    byKey.set(key, s)
  }
  return order.map((k) => byKey.get(k)!)
}

/** 反查 session 所属 (organizationId, spaceId)——IPC 走归档路径，历史 session 也能读。 */
function resolveScope(sessionId: string): { organizationId?: string; spaceId?: string } {
  const chatState = useChatStore.getState()
  for (const list of Object.values(chatState.sessionsBySpaceId)) {
    const s = list.find((x) => x.id === sessionId)
    if (s) return { organizationId: s.organization_id, spaceId: s.space_id ?? undefined }
  }
  return {}
}

export function useSubagentLlmSnapshots(
  parentSessionId: string | null | undefined,
  subagentRunId: string | null,
): { snapshots: LLMCallSnapshot[]; loading: boolean } {
  const [snapshots, setSnapshots] = useState<LLMCallSnapshot[]>(EMPTY)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!parentSessionId || !subagentRunId) {
      setSnapshots(EMPTY)
      setLoading(false)
      return
    }
    const bridge = window.tabtin?.agentEngine?.readSubagentSession
    if (!bridge) {
      setSnapshots(EMPTY)
      return
    }
    let cancelled = false
    setLoading(true)
    const scope = resolveScope(parentSessionId)
    bridge({
      parentSessionId,
      subagentRunId,
      kind: 'snapshots',
      organizationId: scope.organizationId,
      spaceId: scope.spaceId,
    })
      .then((res) => {
        if (cancelled) return
        setSnapshots(res?.ok ? dedupSnapshots(res.lines ?? []) : EMPTY)
      })
      .catch(() => {
        if (!cancelled) setSnapshots(EMPTY)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [parentSessionId, subagentRunId])

  return { snapshots, loading }
}
