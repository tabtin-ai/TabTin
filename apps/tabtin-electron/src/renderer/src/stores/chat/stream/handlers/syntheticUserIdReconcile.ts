/** `message_persisted` ACK 的统一消息身份收敛。 */

import type { AgentStreamMessage } from './streamHandlerTypes'
import { getSessionMessagesFacade } from '@/services/agentService/sessionMessages'
import {
  getClientMessageId,
  isRuntimeOriginMessage,
} from '@/stores/chat/domain/messageIdentity'
import { getChatStoreCallbacks } from '../../shared/storeAccessRegistry'

/**
 * 把落库 ACK 的 server_id 收敛回 live 列表。
 *
 * - runtime 起源（`local-*`）：**只 link** `metadata.message_id`，不改壳 id——
 *   流式 `commitBlocks(local-*)` 必须继续命中（与对账 merge 壳以 runtime 为准一致）。
 * - 其它（如 temp-user / synthetic user）：仍 rebind 为 server UUID。
 */
export function reconcilePersistedMessageIds(sessionId: string, event: AgentStreamMessage): void {
  const ids = (event.payload as { message_ids?: Array<{ client_event_id: string; server_id: string }> } | undefined)?.message_ids
  if (!Array.isArray(ids)) return
  const cidToServer = new Map<string, string>()
  for (const e of ids) {
    if (e.server_id && e.client_event_id) cidToServer.set(e.client_event_id, e.server_id)
  }
  if (cidToServer.size === 0) return

  const callbacks = getChatStoreCallbacks()
  if (!callbacks) return

  const rebindPairs: Array<[string, string]> = []
  for (const msg of getSessionMessagesFacade(sessionId).getMessages()) {
    const cid = getClientMessageId(msg) ?? msg.id
    if (!cid) continue
    const serverId = cidToServer.get(cid)
    if (!serverId || msg.id === serverId) continue
    if (isRuntimeOriginMessage(msg)) {
      callbacks.linkServerMessageId(sessionId, msg.id, serverId)
      continue
    }
    rebindPairs.push([msg.id, serverId])
  }
  if (rebindPairs.length > 0) callbacks.rebindMessageIds(sessionId, rebindPairs)
}
