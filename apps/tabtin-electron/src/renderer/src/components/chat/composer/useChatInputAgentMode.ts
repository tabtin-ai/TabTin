import { useCallback } from 'react'
import { useHotkey, HOTKEYS } from '../../tabcode/utils/hotkeys'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { resolveAgentModeName, SELECTABLE_AGENT_MODES, type AgentModeName } from '../../../stores/chat/shared/types'
import { isConversationDraftScopeKey } from '@/lib/conversationDraftScopeKey'

export function useChatInputAgentMode(
  sessionId: string | null | undefined,
  acceptGlobalInputEvents: boolean,
  draftScopeKey?: string | null,
) {
  const fallbackAgentMode = useChatStore(s => s.agentMode)
  const sessionAgentMode = useChatRuntimeStore(s => (
    sessionId ? s.agentModeBySessionId[sessionId] : undefined
  ))
  const agentMode = resolveAgentModeName(sessionAgentMode, fallbackAgentMode)
  const storeSetAgentMode = useChatStore(s => s.setAgentMode)

  const setAgentMode = useCallback((mode: AgentModeName) => {
    storeSetAgentMode(mode, {
      draftScopeKey: (
        draftScopeKey && isConversationDraftScopeKey(draftScopeKey)
      )
        ? draftScopeKey
        : null,
    })
  }, [storeSetAgentMode, draftScopeKey])

  const cycleAgentMode = useCallback(() => {
    // 与 AgentModeSelector / switch_mode 可提议目标共用 SELECTABLE_AGENT_MODES 单源
    const idx = SELECTABLE_AGENT_MODES.indexOf(agentMode)
    const startIdx = idx >= 0 ? idx : -1
    const next = SELECTABLE_AGENT_MODES[(startIdx + 1) % SELECTABLE_AGENT_MODES.length]
    setAgentMode(next)
  }, [agentMode, setAgentMode])

  useHotkey(HOTKEYS.cycleAgentMode, cycleAgentMode, acceptGlobalInputEvents)

  return { agentMode, setAgentMode }
}
