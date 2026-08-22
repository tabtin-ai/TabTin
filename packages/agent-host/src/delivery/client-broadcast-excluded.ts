import { StreamEvents } from '@tabtin/agent-wire'

/**
 * 与 `packages/agent-runtime` 的 `AUDIT_CAP_STREAM_EVENT_TYPE` 同值。
 * 不从此处 import runtime：避免 agent-host ↔ capability 循环初始化导致
 * Set 在模块求值时吃到 undefined。
 */
const AUDIT_CAP_STREAM_EVENT_TYPE = 'agent.stream.audit_cap' as const

/**
 * 本地 IPC / AgentRealtime 客户端广播排除列表。
 *
 * 与 Django `relay_handler` 的 broadcast skip 对齐：
 * - `persist_message`：仅持久化
 * - `llm_snapshot`：含内部 prompt / schema，仅上云
 * - `audit_cap`：runtime 审计面包屑，仍经 DeliveryCoordinator → relay 落 TraceEvent，
 *   但不送给 Electron renderer（renderer 已无 UI 消费方）
 *
 * `audit_cap` 不在 agent-wire 客户端表面常量里（ 清理），但 LocalAgent 仍会
 * 经 `createRelayAuditWriter` emit；必须在本机 broadcast 边界拦截，否则绕过 Django
 * RELAY 直达 renderer，变成 unknown event 噪声。
 *
 * **同步约束**：改本列表时必须同步
 * `apps/tabtin_django/.../ws/handlers/relay_handler.py` 的 short_name 排除元组
 * （`persist_message` / `llm_snapshot` / `audit_cap`）；跨语言无共享常量。
 */
export const CLIENT_BROADCAST_EXCLUDED_STREAM_TYPES: ReadonlySet<string> = new Set([
  StreamEvents.PERSIST_MESSAGE,
  StreamEvents.LLM_SNAPSHOT,
  StreamEvents.LLM_USAGE,
  AUDIT_CAP_STREAM_EVENT_TYPE,
])

export function isClientBroadcastExcludedStreamType(eventType: string): boolean {
  return CLIENT_BROADCAST_EXCLUDED_STREAM_TYPES.has(eventType)
}
