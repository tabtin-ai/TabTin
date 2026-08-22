import { useState, useEffect, useMemo, useCallback } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import { useTranslation } from 'react-i18next'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useLlmSnapshotsForSession } from '../hooks/useLlmSnapshotsForSession'
import { useSubagentLlmSnapshots } from '../hooks/useSubagentLlmSnapshots'
import { DEBUG_PANELS_ENABLED } from '@/utils/featureFlags'

const EMPTY_CLOUD_MESSAGES_FOR_SUBAGENT: ChatMessage[] = []

export function useChatInputLlmDebugState(sessionId: string | null | undefined) {
  const { t } = useTranslation('chat')
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false)
  const [debugAgentId, setDebugAgentId] = useState<string>('main')

  const {
    snapshots,
    cloudMessages,
    cloudMessageCount,
  } = useLlmSnapshotsForSession(sessionId)

  const subagentRuns = useChatRuntimeStore(
    useCallback((s) => (sessionId ? s.subagentRunsBySessionId[sessionId] : undefined), [sessionId]),
  )
  const { snapshots: subagentSnapshots } = useSubagentLlmSnapshots(
    sessionId,
    debugAgentId === 'main' ? null : debugAgentId,
  )

  useEffect(() => {
    if (!snapshotModalOpen) setDebugAgentId('main')
  }, [snapshotModalOpen, sessionId])

  const debugAgentOptions = useMemo(() => {
    const opts: Array<{ id: string; label: string }> = [
      { id: 'main', label: t('llmSnapshot.mainAgent', { defaultValue: '主 Agent' }) },
    ]
    for (const run of subagentRuns ?? []) {
      const name = run.role?.trim() || run.label?.trim()
        || `${t('subagent.tab.fallbackTitle', { defaultValue: '子 Agent' })} · ${run.subagentRunId.slice(0, 4)}`
      opts.push({ id: run.subagentRunId, label: name })
    }
    return opts
  }, [subagentRuns, t])

  const effectiveSnapshots = debugAgentId === 'main' ? snapshots : subagentSnapshots
  const effectiveCloudMessages = debugAgentId === 'main' ? cloudMessages : EMPTY_CLOUD_MESSAGES_FOR_SUBAGENT
  const showLlmSnapshotButton = DEBUG_PANELS_ENABLED && !!sessionId

  return {
    snapshotModalOpen,
    setSnapshotModalOpen,
    debugAgentId,
    setDebugAgentId,
    debugAgentOptions,
    effectiveSnapshots,
    effectiveCloudMessages,
    cloudMessageCount,
    showLlmSnapshotButton,
  }
}
