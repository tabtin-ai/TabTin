/**
 * 发送派发前的输入解析与派发相关小工具（原 sendMessageHelpers 拆出）。
 *
 * 覆盖：执行 Space / Agent 解析、附件序列化、checkpoint 锚点定位、成员额度错误
 * 上报、done usage → live usage 转换、Vite env 读取，以及远程网关响应类型。都是
 * 围绕「把一次发送派发出去」所需的输入/输出小件。
 */
import type { ChatMessage, ChatSession } from '@tabtin/chat-client'
import type { ChatAttachment } from '../../../../components/chat/types'
import type { SerializableAttachment } from '../../../useChatRuntimeStore'
import type { EnvKillSwitchReader } from '@tabtin/agent-runtime/history'
import {
  findAssistantAfterPendingUser,
  isCheckpointAnchorAssistant,
  type CheckpointPendingContext,
} from '../../checkpoint/handlers/checkpointAnchor'
import { resolveProjectExecutionWorkspace } from '@/utils/projectExecutionTarget'
import { useBillingStore } from '../../../useBillingStore'

const MEMBER_LIMIT_CATEGORIES = new Set([
  'member_budget',
  'member_monthly_limit',
  'member_daily_limit',
  'member_model_restricted',
])

export function checkMemberLimitError(category: string | undefined): void {
  if (!category || !MEMBER_LIMIT_CATEGORIES.has(category)) return
  const reasonMap: Record<
    string,
    'member_monthly_limit' | 'member_daily_limit' | 'member_model_restricted'
  > = {
    member_daily_limit: 'member_daily_limit',
    member_model_restricted: 'member_model_restricted',
  }
  const reason = reasonMap[category] ?? 'member_monthly_limit'
  useBillingStore.getState().setMemberLimitReached(true, reason)
}

export function toSerializableAttachments(
  atts?: ChatAttachment[],
): SerializableAttachment[] | undefined {
  if (!atts || atts.length === 0) return undefined
  return atts.map(a => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    type: a.type,
    fileId: a.fileId,
    remoteUrl: a.remoteUrl,
    previewUrl: a.previewUrl,
  }))
}

export function resolveLocalCheckpointAnchorId(
  messages: ChatMessage[],
  checkpointCtx: CheckpointPendingContext,
  aiMessageId: string,
): string | null {
  const afterUser = findAssistantAfterPendingUser(messages, checkpointCtx)
  if (afterUser) return afterUser.id

  if (aiMessageId) {
    const currentAssistant = messages.find(message => (
      message.id === aiMessageId && isCheckpointAnchorAssistant(message)
    ))
    if (currentAssistant) return currentAssistant.id
  }

  return null
}

export function resolveExecutionSpaceForSend<
  TSpace extends {
    id?: string | null
    type?: string | null
    project_id?: string | null
    execution_space_id?: string | null
  },
>(
  space: TSpace | null | undefined,
  spaces: TSpace[],
): TSpace | null | undefined {
  return resolveProjectExecutionWorkspace(space, spaces) ?? space
}

export function buildLiveUsageJsonFromDoneUsage(
  usage: unknown,
): Record<string, number> | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  if (typeof u.last_input_tokens !== 'number') return null
  const n = (key: string): number => {
    const v = u[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
  }
  return {
    input_tokens: n('last_input_tokens'),
    cache_read_input_tokens: n('last_cache_read_input_tokens'),
    cache_creation_input_tokens: n('last_cache_creation_input_tokens'),
    output_tokens: n('output_tokens'),
  }
}

export function createViteEnvReader(key: string): EnvKillSwitchReader {
  return () => {
    try {
      const raw = (import.meta as unknown as { env?: Record<string, unknown> }).env?.[key]
      return typeof raw === 'string' ? raw : undefined
    } catch { return undefined }
  }
}

export type RemoteGatewayResponse = {
  ok: boolean
  type: string
  payload?: {
    message_id?: string | null
    error_code?: string
    error_message?: string
    message?: string
    /** ：服务端当前执行态快照（可选，旧后端可能缺失） */
    run_state?: unknown
  }
  error?: {
    code?: string
    message?: string
  }
}

export function resolveSessionForSend(
  store: {
    sessions: ChatSession[]
    getSessionById?: (sessionId: string) => ChatSession | undefined
  },
  sessionId: string,
): ChatSession | undefined {
  return store.sessions.find((session) => session.id === sessionId)
    ?? store.getSessionById?.(sessionId)
}
