import type { ChatSessionTokenUsage } from '@/utils/chatSessionTokenUsage'
import type { ChatSession, ChatMessage } from '@tabtin/chat-client'
import type {
  ContentBlock,
  ContentBlockDeltaPayload,
  MessageStopReason,
  MessageUsage,
} from '@tabtin/agent-wire'
import type {
  AgentModeName,
  AgentStep,
  AssistantEvent,
  ToolEvent,
  RunState,
  SubagentRun,
  LLMCallSnapshot,
} from '../../shared/types'

export interface MessageMeta {
  role: 'assistant' | 'user' | 'system'
  model_id?: string
  model_name?: string
  started_at?: string
  finalized: boolean
  stop_reason?: MessageStopReason
  stop_sequence?: string | null
  usage?: MessageUsage
  subagent_run_id?: string
  persisted_id?: string
  text_summary?: string
}

/**
 * Minimal store interface needed by the stream message handler.
 *
 * Matches the shape of useChatRuntimeStore so that `get` / `set` can point
 * directly to the runtime store without importing the runtime store module.
 */
export interface StreamHandlerStore {
  agentStepsBySessionId: Record<string, AgentStep[]>
  toolEventsBySessionId: Record<string, ToolEvent[]>
  assistantEventsBySessionId: Record<string, AssistantEvent[]>
  subagentRunsBySessionId: Record<string, SubagentRun[]>
  runStateBySessionId: Record<string, RunState>
  agentModeBySessionId: Record<string, AgentModeName>
  cancellingBySessionId: Record<string, boolean>

  updateRunStateForSession: (sessionId: string, partial: Partial<RunState>) => void
  setCancellingForSession: (sessionId: string, cancelling: boolean) => void
  clearActiveSubmittedMessage: (sessionId: string, clientMessageId?: string) => void
  pushAgentStepForSession: (sessionId: string, step: AgentStep) => void
  updateAgentStepForSession: (sessionId: string, id: string, partial: Partial<AgentStep>) => void
  upsertToolEventForSession: (sessionId: string, event: ToolEvent) => void
  getEffectiveToolEventForSession: (sessionId: string, eventId: string) => ToolEvent | undefined
  upsertAssistantEventForSession: (sessionId: string, event: AssistantEvent) => void
  resetAssistantDeltasForSession: (sessionId: string, runId?: string | null) => void
  upsertSubagentRunForSession: (
    sessionId: string,
    run: SubagentRun,
    options?: { allowRevive?: boolean },
  ) => void
  markSubagentRunTerminalForSession: (
    sessionId: string,
    subagentRunId: string,
    status: Extract<SubagentRun['status'], 'completed' | 'failed' | 'cancelled'>,
    source: 'metadata' | 'child_stream' | 'archive',
  ) => void
  appendRichContentBlocks: (sessionId: string, blocks: unknown[]) => void
  upsertRichContentBlocksByToolCallId: (sessionId: string, blocks: unknown[]) => void
  clearRichContentBlocks: (sessionId: string) => void
  markStreamingWidgetsInterruptedAndClearOthers: (
    sessionId: string,
    status: 'cancelled' | 'error' | 'terminated' | 'unknown',
  ) => void
  pushSnapshotForSession: (sessionId: string, snapshot: LLMCallSnapshot) => void

  messageMetaBySessionId: Record<string, Record<string, MessageMeta>>
  contentBlocksLastSeqBySessionId: Record<string, Record<string, number>>
  messageStart: (
    sessionId: string,
    messageId: string,
    meta: Omit<MessageMeta, 'finalized'>,
    seq: number,
  ) => void
  messageDelta: (
    sessionId: string,
    messageId: string,
    delta: { stop_reason?: MessageStopReason; stop_sequence?: string | null },
    usage: MessageUsage | undefined,
    seq: number,
  ) => boolean
  messageStop: (
    sessionId: string,
    messageId: string,
    seq: number,
    opts?: { persistedId?: string; blockIdOverrides?: Record<string, string> },
  ) => void
  contentBlockStart: (
    sessionId: string,
    messageId: string,
    index: number,
    blockId: string,
    block: ContentBlock,
    seq: number,
  ) => void
  contentBlockDelta: (
    sessionId: string,
    messageId: string,
    index: number,
    delta: ContentBlockDeltaPayload,
    seq: number,
  ) => void
  contentBlockStop: (sessionId: string, messageId: string, index: number, seq: number) => void
  clearContentBlocksForSession: (sessionId: string) => void
}

export interface AgentStreamMessage {
  type: string
  payload?: Record<string, unknown>
  [key: string]: unknown
}

export interface StreamHandlerDeps {
  sessionId: string
  spaceId?: string
  spaceName?: string
  sessionTitle?: string
  get: () => StreamHandlerStore
  set: (partial: Partial<StreamHandlerStore> | ((state: StreamHandlerStore) => Partial<StreamHandlerStore>)) => void
  addStreamingSession: (sessionId: string, runId?: string | null) => void
  removeStreamingSession: (
    sessionId: string,
    options?: {
      clearSeqGapSync?: boolean
      runId?: string | null
      dispatchToken?: string | null
    },
  ) => void
  client: {
    sessions: { get: (id: string) => Promise<ChatSession> }
    messages?: { list: (sessionId: string, opts: { limit: number; after?: string }) => Promise<{ messages?: ChatMessage[] } | ChatMessage[]> }
  }
  updateSessionTokenUsageInCaches: (sessionId: string, usage: ChatSessionTokenUsage) => void
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
  onLifecycleEnd: () => void
  syncMessagesFromServer?: () => Promise<void>
}

export interface HandlerContext extends StreamHandlerDeps {
  notifyPrefix: string
}
