/**
 * 回退/展示用语义消息计数与用户轮正向分界。
 *
 * 口径（方案 A）：
 * - 只计真实用户消息（`isRegularUserMessage`）与 Agent（assistant）消息；
 * - 相邻 assistant 合并为 1 条（中间可夹内部注入 / tool_artifact / hitl）；
 * - 不再按 `agent_run_id` 拆开相邻 Agent。
 *
 * 内部注入行（context / memory / rules / todo / recall / reminder / diagnostics …）
 * 及伪用户行（compaction / push / skill_invoke 等）不计入。
 *
 * 用户轮分界用正向谓词 `isRegularUserMessage`：专用 message_kind 一律不算；
 * `llm` 桶内只排除 runtime 作者轴（非 user 的 triggered_by、skill_invoke）。
 */
import type { ChatMessage } from '@tabtin/chat-client'

const LEGACY_USER_CONTEXT_INJECTION_KINDS = new Set([
  'environment_context',
  'agent_profile_context',
  'system_prompt_context',
  'external_archive_context',
  'memory_recall',
  'project_rules',
  'mode_reminder',
  'mode_transition_reminder',
  'todo_state',
  'todo_completion_nudge',
  'relevant_recall',
  'lsp_diagnostics',
  'tool_eviction_notice',
  'continuation',
])
const TOOL_ARTIFACT_KIND = 'tool_artifact'
const HITL_INTERACTION_KIND = 'hitl_interaction'
/** 人从输入框发出的消息在协议上的默认 kind（缺省同此）。 */
const USER_TURN_MESSAGE_KIND = 'llm'
/** 人发消息的默认 triggered_by；缺省视为人。 */
const USER_TRIGGERED_BY = 'user'
const SKILL_INVOKE_SOURCE = 'skill_invoke'

const INTERNAL_INJECTION_MARKERS = [
  '__context_injector__',
  '__historical_context__',
  '__memory_injector__',
  '__agent_profile_injector__',
  '__historical_agent_profile__',
  '__lsp_diagnostics_injector__',
  '__tool_eviction_notice__',
  '__mode_reminder_injector__',
  '__mode_transition_reminder__',
  '__todo_state_injector__',
  '__todo_completion_nudge__',
  '__project_rules_injector__',
  '__relevant_recall_injector__',
  '__continuation_marker__',
]

function messageText(message: ChatMessage): string {
  const summary = typeof message.text_summary === 'string' ? message.text_summary : ''
  if (summary.trim()) return summary.trimStart()
  if (typeof message.content === 'string') return message.content.trimStart()
  return ''
}

function readMetadataRecord(message: ChatMessage): Record<string, unknown> | null {
  const meta = message.metadata
  return meta && typeof meta === 'object' ? meta as Record<string, unknown> : null
}

function hasLocalInternalMarker(message: ChatMessage, marker: string): boolean {
  const meta = readMetadataRecord(message)
  const markers = meta?.internalMarkers
  if (Array.isArray(markers) && markers.includes(marker)) return true
  return (message as unknown as Record<string, unknown>)[marker] === true
}

/**
 * 判定 context_injection：对用户不可见、进 Agent 上下文的注入行（语义计数用）。
 *
 * - `environment_context` / `agent_profile_context` / `system_prompt_context`
 *   （及 legacy wrapper 正文）
 * - shared-fork / handoff 物化的 briefing / 契约（含历史 `role=system` 脏数据）
 */
export function isContextInjectionMessage(message: ChatMessage): boolean {
  const meta = readMetadataRecord(message)
  if (meta?.share_briefing === true || meta?.share_contract === true) return true
  if (message.role !== 'user' && message.role !== 'system') return false
  const kind = message.message_kind ?? USER_TURN_MESSAGE_KIND
  if (LEGACY_USER_CONTEXT_INJECTION_KINDS.has(kind)) return true
  if (INTERNAL_INJECTION_MARKERS.some((marker) => hasLocalInternalMarker(message, marker))) return true
  const text = messageText(message)
  return /^<context\s+type="(?:environment|agent-profile|external-archive)"/.test(text)
    || /^<identity\b/.test(text)
}

/**
 * 用户轮分界（正向）：人从输入框发出的消息。
 *
 * - 专用 `message_kind`（compaction_summary / context / …）一律否
 * - `llm` 桶内：`triggered_by` 缺省或 `user`，且 `source` 不是 `skill_invoke`
 * - 不读附件、reply_to、正文是否为空、referenced wrapper
 */
export function isRegularUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  if (isContextInjectionMessage(message)) return false
  if ((message.message_kind ?? USER_TURN_MESSAGE_KIND) !== USER_TURN_MESSAGE_KIND) return false
  const meta = readMetadataRecord(message)
  const triggeredBy = meta?.triggered_by
  if (triggeredBy !== undefined && triggeredBy !== USER_TRIGGERED_BY) return false
  if (meta?.source === SKILL_INVOKE_SOURCE) return false
  return true
}

/**
 * UI 主时间线的 legacy user 消息白名单。
 *
 * 当前 live 主路径已在 stream handler 把内部注入 / skill / push 等系统作者事件
 * 物化为 `role=system`，最终展示由 system 白名单控制。这里仅防御旧落库、
 * 跨端历史或脏数据里残留的 `role=user + 专用 message_kind` 被当成普通用户气泡。
 */
export function isRenderableUserMessage(message: ChatMessage): boolean {
  return isRegularUserMessage(message)
}

/**
 * @deprecated 分轮/导航请用 `isRegularUserMessage`。
 * 保留为「role=user 且非真实用户轮」的薄反义，避免旧调用点语义漂移。
 */
export function isSyntheticUserMessage(message: ChatMessage): boolean {
  return message.role === 'user' && !isRegularUserMessage(message)
}

/** 统计用户真实输入的 user 消息条数。 */
export function countSemanticUserMessages(messages: readonly ChatMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (isRegularUserMessage(message)) {
      count += 1
    }
  }
  return count
}

function isTurnTransparentAssistant(message: ChatMessage): boolean {
  // tool_artifact 并入所属 Agent 轮；hitl_interaction是审批/追问持久化
  // 事实，UI 隐藏，不构成用户感知的轮次——与 Django semantic_message_count 同口径。
  const kind = message.message_kind ?? USER_TURN_MESSAGE_KIND
  return message.role === 'assistant' && (kind === TOOL_ARTIFACT_KIND || kind === HITL_INTERACTION_KIND)
}

function isCountableAssistant(message: ChatMessage): boolean {
  return message.role === 'assistant' && !isTurnTransparentAssistant(message)
}

/** 按用户感知的「轮次/条」计数，而非 DB 原始行数。 */
export function countSemanticMessages(messages: readonly ChatMessage[]): number {
  let count = 0
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    if (isContextInjectionMessage(msg) || isTurnTransparentAssistant(msg)) {
      i += 1
      continue
    }
    if (isCountableAssistant(msg)) {
      count += 1
      i += 1
      while (i < messages.length) {
        const nxt = messages[i]!
        if (isContextInjectionMessage(nxt) || isTurnTransparentAssistant(nxt)) {
          i += 1
          continue
        }
        if (isCountableAssistant(nxt)) {
          i += 1
          continue
        }
        break
      }
      continue
    }
    if (isRegularUserMessage(msg)) {
      count += 1
      i += 1
      continue
    }
    // 伪用户 / system / 其它角色：不计
    i += 1
  }
  return count
}
