import { useMemo } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import {
  buildPriorTurnArtifactsByEndIndex,
  buildTurnArtifactsByEndIndex,
  resolveToolEventResult,
  type AgentToolContentResolver,
  type ResolvedToolResult,
  type SessionToolResultResolver,
  type SubagentDeliverablesResolver,
  type TurnArtifactCollectOptions,
} from '../../turn/turnArtifacts'
import type { AgentToolDeliverable } from '../../turn/turnArtifactFromAgentTool'

export function useMessageListTurnArtifacts(
  sessionId: string | null | undefined,
  messages: ChatMessage[],
) {
  const toolEvents = useChatRuntimeStore((s) => (sessionId ? s.toolEventsBySessionId[sessionId] : undefined))
  const subagentRuns = useChatRuntimeStore((s) => (sessionId ? s.subagentRunsBySessionId[sessionId] : undefined))

  // 会话级工具结果 resolver（方案 C）：产物聚合按 tool_use_id 从 toolEvents 取
  // canonical 结果（含 file_history），与工具卡同源。
  const sessionToolResult = useMemo<SessionToolResultResolver | undefined>(() => {
    if (!toolEvents || toolEvents.length === 0) return undefined
    const byId = new Map<string, ResolvedToolResult>()
    for (const ev of toolEvents) {
      if (ev.phase !== 'end' && ev.phase !== 'error') continue
      const resolved = resolveToolEventResult(ev.output, ev.phase === 'error')
      if (resolved) byId.set(ev.id, resolved)
    }
    return byId.size > 0 ? (id: string) => byId.get(id) : undefined
  }, [toolEvents])

  // ：agent 工具文本结果（含交付物标签）——实时尚未 co-locate 时从 toolEvents 补。
  const agentToolContent = useMemo<AgentToolContentResolver | undefined>(() => {
    if (!toolEvents || toolEvents.length === 0) return undefined
    const byId = new Map<string, string>()
    for (const ev of toolEvents) {
      if (ev.toolName !== 'agent') continue
      if (ev.phase !== 'end' && ev.phase !== 'error') continue
      if (typeof ev.output === 'string' && ev.output.trim()) {
        byId.set(ev.id, ev.output)
        continue
      }
      if (ev.output && typeof ev.output === 'object') {
        try {
          const serialized = JSON.stringify(ev.output)
          if (serialized.includes('tabtin-subagent-deliverables')) {
            byId.set(ev.id, serialized)
          }
        } catch {
          // ignore
        }
      }
    }
    return byId.size > 0 ? (id: string) => byId.get(id) : undefined
  }, [toolEvents])

  // ：后台子晚完成 → SubagentRun.deliverables 按 parentToolCallId 补入派发轮。
  const subagentDeliverables = useMemo<SubagentDeliverablesResolver | undefined>(() => {
    if (!subagentRuns || subagentRuns.length === 0) return undefined
    const byParent = new Map<string, AgentToolDeliverable[]>()
    for (const run of subagentRuns) {
      if (run.status !== 'completed') continue
      const parentId = run.parentToolCallId
      if (!parentId || !Array.isArray(run.deliverables) || run.deliverables.length === 0) continue
      const parsed = run.deliverables.filter((item): item is AgentToolDeliverable => {
        if (!item || typeof item !== 'object') return false
        const rec = item as Record<string, unknown>
        if (typeof rec.artifact_kind === 'string') {
          return rec.artifact_kind === 'local_file'
            || rec.artifact_kind === 'oss_file'
            || rec.artifact_kind === 'platform_resource'
        }
        return rec.kind === 'widget' && typeof rec.widget_id === 'string'
      })
      if (parsed.length === 0) continue
      const prev = byParent.get(parentId) ?? []
      byParent.set(parentId, prev.concat(parsed))
    }
    return byParent.size > 0 ? (id: string) => byParent.get(id) ?? [] : undefined
  }, [subagentRuns])

  // 本轮产物 badge：与子详情 header 同口径（role → label）。
  const resolveSubagentDisplayName = useMemo(() => {
    if (!subagentRuns || subagentRuns.length === 0) return undefined
    const byParent = new Map<string, string>()
    for (const run of subagentRuns) {
      const parentId = run.parentToolCallId
      if (!parentId || byParent.has(parentId)) continue
      const name = (run.role || run.label || '').trim()
      if (!name) continue
      byParent.set(parentId, name)
    }
    return byParent.size > 0 ? (id: string) => byParent.get(id) : undefined
  }, [subagentRuns])

  const turnArtifactOptions = useMemo<TurnArtifactCollectOptions>(
    () => ({
      sessionToolResult,
      agentToolContent,
      subagentDeliverables,
      resolveSubagentDisplayName,
    }),
    [sessionToolResult, agentToolContent, subagentDeliverables, resolveSubagentDisplayName],
  )

  return useMemo(
    () => ({
      turnArtifactsByEndIndex: buildTurnArtifactsByEndIndex(messages, undefined, turnArtifactOptions),
      priorTurnArtifactsByEndIndex: buildPriorTurnArtifactsByEndIndex(messages, undefined, turnArtifactOptions),
    }),
    [messages, turnArtifactOptions],
  )
}
