/**
 * useSubagentDetailTranscript — 子代理详情 transcript 数据源
 *
 * 从 SubagentDetailPane 抽出：live + runtime 归档 bootstrap / 选源 / loading·error。
 * Pane 只负责 header 与 MessageList 渲染。
 */

import { useCallback, useEffect, useMemo } from 'react'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import type { ChatMessage } from '@tabtin/chat-client'
import { useChatStore } from '../../../stores/chat/useChatStore'
import {
  useSubagentLiveStore,
  selectLiveMessagesByRunId,
} from '../../../stores/subagentLive'
import { useSubagentSessionStore } from '../../../stores/subagentSession'
import { replaySubagentMessages } from './replaySubagentMessages'
import { selectSubagentDetailMessages } from './selectSubagentDetailMessages'
import {
  adaptTranscriptToChatMessages,
  type ReconstructedTranscriptMessage,
} from '../../../services/localTranscript'

const EMPTY_CHAT_MESSAGES: ChatMessage[] = []

export function replayArchivedSubagentMessages(
  lines: unknown[] | undefined,
  format: 'transcript' | 'envelopes' | undefined,
  subagentRunId: string,
): ChatMessage[] {
  if (!lines) return EMPTY_CHAT_MESSAGES
  if (format === 'transcript') {
    return adaptTranscriptToChatMessages(
      lines as ReconstructedTranscriptMessage[],
      subagentRunId,
    )
  }
  return replaySubagentMessages(lines).messages
}

export interface UseSubagentDetailTranscriptInput {
  subagentRunId: string
  parentSessionId: string
  isPaneActive: boolean
  /** run.status；用于终态 forceRefresh 与 file_missing 抑制 */
  status: string
}

export interface UseSubagentDetailTranscriptResult {
  messages: ChatMessage[]
  firstUserMessageIndex: number
  isLoading: boolean
  error: string | undefined
  handleRefresh: () => void
}

export function useSubagentDetailTranscript(
  input: UseSubagentDetailTranscriptInput,
): UseSubagentDetailTranscriptResult {
  const { subagentRunId, parentSessionId, isPaneActive, status } = input

  const liveMessages = useSubagentLiveStore(s => selectLiveMessagesByRunId(s, subagentRunId))
  const loadSubagentSession = useSubagentSessionStore(s => s.loadSubagentSession)
  const archiveEntry = useSubagentSessionStore(s => s.subagentSessionDataBySubId[subagentRunId])
  const archiveLines = archiveEntry?.messages?.lines
  const archiveFormat = archiveEntry?.messages?.format
  const archiveLoading = archiveEntry?.loading?.messages === true
  const archiveError = archiveEntry?.error?.messages

  const parentSessionMessages = useChatStore(
    s => s.messagesBySessionId[parentSessionId] ?? EMPTY_CHAT_MESSAGES,
  )
  const loadSessionMessages = useChatStore(s => s.loadSessionMessages)
  const organizationId = useChatStore(s => s.getSessionById(parentSessionId)?.organization_id ?? null)
  const spaceId = useChatStore(s => resolveSessionScopeId(s.getSessionById(parentSessionId)))
  const sessionsHydrated = useChatStore(s => s.sessionsHydrated)

  const scopeOpts = useMemo(
    () => ({
      organizationId: organizationId ?? undefined,
      spaceId: spaceId ?? undefined,
    }),
    [organizationId, spaceId],
  )

  // 归档 bootstrap：active pane 一律拉一次（5s TTL）。不能「有 live 就跳过」。
  useEffect(() => {
    if (!isPaneActive || !sessionsHydrated) return
    void loadSubagentSession(parentSessionId, subagentRunId, 'messages', scopeOpts)
  }, [
    isPaneActive,
    sessionsHydrated,
    parentSessionId,
    subagentRunId,
    scopeOpts,
    loadSubagentSession,
  ])

  // 跨端弱兜底：父 session API 消息未加载时拉一次（非本机权威）。
  useEffect(() => {
    if (!isPaneActive || !sessionsHydrated) return
    if (parentSessionMessages.length === 0) {
      void loadSessionMessages(parentSessionId)
    }
  }, [
    isPaneActive,
    sessionsHydrated,
    parentSessionMessages.length,
    loadSessionMessages,
    parentSessionId,
  ])

  // 终态再刷一次归档。
  useEffect(() => {
    if (!isPaneActive || !sessionsHydrated) return
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled'
    if (!isTerminal) return
    void loadSubagentSession(parentSessionId, subagentRunId, 'messages', {
      forceRefresh: true,
      ...scopeOpts,
    })
  }, [
    isPaneActive,
    sessionsHydrated,
    status,
    parentSessionId,
    subagentRunId,
    scopeOpts,
    loadSubagentSession,
  ])

  const handleRefresh = useCallback(() => {
    void loadSubagentSession(parentSessionId, subagentRunId, 'messages', {
      forceRefresh: true,
      ...scopeOpts,
    })
  }, [loadSubagentSession, parentSessionId, subagentRunId, scopeOpts])

  const archiveMessages = useMemo(
    () => replayArchivedSubagentMessages(archiveLines, archiveFormat, subagentRunId),
    [archiveFormat, archiveLines, subagentRunId],
  )

  // 详情归档就绪 → seed：只把缺页子消息追加进父 store，绝不覆盖已有行
  //（live/archive id 体系不同，按 id merge 会重复或打回 live；#8846）。
  // 写入后由 merge 边界有条件 project 孙 run，不在 hook 里直接 upsert。
  useEffect(() => {
    if (!isPaneActive || archiveMessages.length === 0) return
    useChatStore.getState().mergeSubagentMessages(
      parentSessionId,
      (dm) => ({
        ...dm,
        subagent_run_id: dm.subagent_run_id ?? subagentRunId,
        agent_run_id: dm.agent_run_id ?? subagentRunId,
      }),
      archiveMessages,
      'seed',
    )
  }, [isPaneActive, parentSessionId, subagentRunId, archiveMessages])

  const apiMessages = useMemo(
    () => parentSessionMessages
      .filter(m => m.subagent_run_id === subagentRunId)
      .slice()
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [parentSessionMessages, subagentRunId],
  )

  const { messages, firstUserMessageIndex } = useMemo(() => {
    const selected = selectSubagentDetailMessages(liveMessages, archiveMessages)
    if (selected.length > 0) {
      return {
        messages: selected,
        firstUserMessageIndex: selected.findIndex((m) => m.role === 'user'),
      }
    }
    return {
      messages: apiMessages,
      firstUserMessageIndex: apiMessages.findIndex((m) => m.role === 'user'),
    }
  }, [liveMessages, archiveMessages, apiMessages])

  const hasRenderableData = liveMessages.length > 0
    || archiveMessages.length > 0
    || messages.length > 0
  const isLoading = !hasRenderableData && (archiveLoading || !sessionsHydrated)
  const isRunningLike = status === 'running' || status === 'queued' || status === 'pending'
  const error: string | undefined = (() => {
    if (hasRenderableData) return undefined
    if (!archiveError) return undefined
    if (archiveError === 'file_missing' && isRunningLike) return undefined
    return archiveError
  })()

  return {
    messages,
    firstUserMessageIndex,
    isLoading,
    error,
    handleRefresh,
  }
}
