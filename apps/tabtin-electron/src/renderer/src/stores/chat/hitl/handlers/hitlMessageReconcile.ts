/**
 * hitlMessageReconcile — 从持久化 hitl_interaction 消息派生 HITL 面板。
 *
 * ## 单一真相
 *
 * Django `pending_interaction_service` 与 PendingInteraction 同事务落一条
 * `message_kind='hitl_interaction'` 的 ChatMessage（`metadata.hitl` 承载
 * `{ kind, request_key, status, payload, expires_at, ... }`），状态翻转
 * （pending→resolved/expired/cancelled）随消息增量 sync（updated_after 水位）
 * 到达所有端。本模块在消息 sync 落地后运行，按下表把面板收敛到消息真相：
 *
 * | 本地面板 | 同步到的 hitl 消息事实       | 动作                                   |
 * |----------|------------------------------|----------------------------------------|
 * | 无       | status=pending 且未过期      | 开面板（重载 / 晚进入恢复，/#3529）|
 * | 有       | status 终态                  | 清面板 + 记墓碑                        |
 * | 有       | 消息缺失（尚未 sync 到）     | **不动**                               |
 *
 * ## 与被替换的旧对账（ hitlReconcile）的本质区别
 *
 * 旧对账拉 pendingInteractions API 快照，「本地面板的 key 不在快照里 + 开面板超
 * 8s 宽限」即清——**缺失被当成了终态**，本机 IPC 已弹出、服务端落库延迟 / 可见性
 * 过滤导致快照缺失的活审批会被误杀（ 事故）。本模块只对**权威状态的存在**
 * 做动作：pending 开、终态清、缺失不动。不需要宽限，也不需要独立的对账请求。
 *
 * ## 复用而非重造
 *
 * 开/清逻辑与权威 user event 路径（`interaction_requested` / `interaction_resolved`）
 * 完全同构——`metadata.hitl` 存的就是 `serialize_interaction` 同款字段。本模块把
 * 消息事实合成同构 interaction 对象，转调既有 handler，避免第二套映射漂移。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { createLogger } from '@/utils/logger'
import { getHitlStoreAccess } from '../../shared/storeAccessRegistry'
import type { AgentStreamMessage } from '../../stream/handlers/streamHandlerTypes'
import {
  handleApprovalRequestedStreamEvent,
  handlePendingInteractionRequestedEvent,
  handlePendingInteractionTerminalEvent,
  isHitlResolvedKey,
} from './hitlStreamHandlers'

const log = createLogger('HitlMessageReconcile')

const ASK_INTERACTION_KINDS = new Set(['ask_choice', 'ask_form', 'permission_request'])
const APPROVAL_INTERACTION_KIND = 'tool_approval'

/** `metadata.hitl` 的窄视图（Django `_sync_hitl_chat_message` 写入的字段）。 */
interface HitlMessageFact {
  kind: string
  requestKey: string
  status: string
  payload: Record<string, unknown>
  expiresAtMs: number | null
}

function extractHitlFact(msg: ChatMessage): HitlMessageFact | null {
  const meta = msg.metadata
  if (!meta || typeof meta !== 'object') return null
  const hitl = (meta as Record<string, unknown>).hitl
  if (!hitl || typeof hitl !== 'object' || Array.isArray(hitl)) return null
  const h = hitl as Record<string, unknown>
  const kind = typeof h.kind === 'string' ? h.kind : ''
  const requestKey = typeof h.request_key === 'string' ? h.request_key : ''
  const status = typeof h.status === 'string' ? h.status : ''
  if (!kind || !requestKey || !status) return null
  const basePayload = (h.payload && typeof h.payload === 'object' && !Array.isArray(h.payload))
    ? h.payload as Record<string, unknown>
    : {}
  // ：ChatMessage.id 即 hitlMessageId；旧 payload 缺 message_id 时用消息主键回填，
  // 恢复开面板 / 通知定位与实时路径对齐。
  const payload = typeof msg.id === 'string' && msg.id
    ? { ...basePayload, message_id: msg.id }
    : basePayload
  return {
    kind,
    requestKey,
    status,
    payload,
    expiresAtMs: typeof h.expires_at === 'number' ? h.expires_at : null,
  }
}

/** 合成与 `agent.user.interaction_requested/resolved` 同构的事件（复用既有 handler）。 */
function syntheticInteractionEvent(sessionId: string, fact: HitlMessageFact): AgentStreamMessage {
  return {
    type: 'agent.user.interaction_from_message',
    payload: {
      interaction: {
        kind: fact.kind,
        request_key: fact.requestKey,
        status: fact.status,
        session_id: sessionId,
        payload: fact.payload,
      },
    },
  } as AgentStreamMessage
}

/**
 * 消息 sync 落地后调用：把该 session 的 HITL 面板收敛到 hitl_interaction 消息真相。
 *
 * 挂点：`sessionFreshness` 的 sync 成功路径 + `markSessionFresh`（覆盖
 * loadSessionMessages / selectSession 背景 sync / useSessionReconcile 心跳兜底）。
 * 幂等、只读消息缓存，不发请求。
 */
export function reconcileHitlPanelsFromMessages(
  sessionId: string,
  messages: readonly ChatMessage[],
): void {
  if (!sessionId || messages.length === 0) return
  const access = getHitlStoreAccess()
  if (!access) return

  let latestPendingApproval: HitlMessageFact | null = null
  let latestPendingAsk: HitlMessageFact | null = null
  const terminalFacts: HitlMessageFact[] = []

  const now = Date.now()
  for (const msg of messages) {
    if ((msg.message_kind ?? 'llm') !== 'hitl_interaction') continue
    const fact = extractHitlFact(msg)
    if (!fact) continue
    if (fact.status === 'pending') {
      // 本地截止时间已过就是可展示层的权威终态：复用终态 handler
      // 精确清除同 request_key 面板，不等服务端过期扫描回写。
      if (fact.expiresAtMs !== null && fact.expiresAtMs <= now) {
        terminalFacts.push({ ...fact, status: 'expired' })
        continue
      }
      // 用户刚在本机提交（乐观清面板 + 墓碑），消息缓存还没翻到 resolved——不回开。
      if (isHitlResolvedKey(sessionId, fact.requestKey)) continue
      if (fact.kind === APPROVAL_INTERACTION_KIND) latestPendingApproval = fact
      else if (ASK_INTERACTION_KINDS.has(fact.kind)) latestPendingAsk = fact
    } else {
      terminalFacts.push(fact)
    }
  }

  // ── 终态事实：清匹配的本地面板 + 记墓碑 ─────────────────────────────
  // 复用权威终态 user event 的同一处理（匹配判定 / 墓碑 / store patch 全同构）。
  //
  // 只转调 requestKey **精确命中当前打开面板 key** 的事实：消息窗口里的全部历史
  // 终态事实每轮 sync 都会重现，不过滤会 (a) O(N) 空跑 setState、(b) 给全部历史
  // key 记墓碑挤爆 50 上限、(c) 撞上 handlePendingInteractionTerminalEvent 对
  // 无 batchId 面板的宽匹配（`!pending.batchId ||`），让任意历史事实误清活面板。
  // 历史事实的重放防护由「真实 resolved 时刻」写下的墓碑负责，这里不重复承担。
  const state = access.getState()
  const pendingApproval = state.pendingApprovalBySessionId[sessionId]
  const pendingAsk = state.pendingAskUserBySessionId[sessionId]
  const askPanelKeys = new Set(
    [pendingAsk?.interruptId, pendingAsk?.toolCallId, pendingAsk?.messageId].filter(Boolean) as string[],
  )
  for (const fact of terminalFacts) {
    const matchesOpenPanel = fact.kind === APPROVAL_INTERACTION_KIND
      ? !!pendingApproval?.batchId && pendingApproval.batchId === fact.requestKey
      : askPanelKeys.has(fact.requestKey)
    if (!matchesOpenPanel) continue
    handlePendingInteractionTerminalEvent(syntheticInteractionEvent(sessionId, fact))
  }

  // ── pending 事实：本地无面板时恢复打开（重载 / 晚进入 / 换端）────────
  // 本地已有面板（stream 快路径先到）时不动——stream 与消息指向同一 request_key，
  // 覆盖只会打断用户正在操作的面板。
  const postClear = access.getState()
  if (latestPendingApproval && !postClear.pendingApprovalBySessionId[sessionId]) {
    log.info('restore approval panel from persisted hitl message', {
      session: sessionId.slice(0, 8),
      batchId: latestPendingApproval.requestKey,
    })
    handleApprovalRequestedStreamEvent(
      { type: 'agent.stream.approval_requested', payload: latestPendingApproval.payload } as AgentStreamMessage,
      // 恢复语义：不重发系统通知；hitl_interaction 已在列表，不 append 气泡。
      { sessionId, restoredFromPersistedFact: true },
    )
  }
  if (latestPendingAsk && !postClear.pendingAskUserBySessionId[sessionId]) {
    log.info('restore ask panel from persisted hitl message', {
      session: sessionId.slice(0, 8),
      requestKey: latestPendingAsk.requestKey,
    })
    handlePendingInteractionRequestedEvent(syntheticInteractionEvent(sessionId, latestPendingAsk))
  }
}
