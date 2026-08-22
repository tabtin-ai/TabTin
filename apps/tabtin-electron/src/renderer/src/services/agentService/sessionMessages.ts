/**
 * agentService / sessionMessages — 一条会话消息列表的统一门面。
 *
 * 把「读消息真相 + 服务端合并 + epoch/restoring 门控 +
 * 结构性变更登记 + 自发回退广播抑制」收敛到一处。所有服务端 → 本地的写回路径
 * （sessionFreshness / sessionCrudSlice / checkpointSlice）都经此门面取用。
 *
 * ## 为什么独立成叶子模块（不放进 hub/index）
 *
 * hub/index 静态 import 了 streamMessageHandler（重依赖，其 handler 链会回指
 * checkpointSlice / sessionFreshness 等）。若消费方从 hub/index 取门面就会成环
 * （madge 守卫）。本模块只依赖叶子（messageWriteGate / messageSyncAction /
 * storeAccessRegistry），任何消费方都可安全静态 import；SessionController.messages
 * 也委托到这里，出入站共用同一份门面定义。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import {
  mergeAuthoritativeServerReplace,
  mergeMessagesFromServer,
  type MergeResult,
} from '@/stores/chat/domain/messageSyncAction'
import {
  commitServerMerge,
  consumeSelfRollbackBroadcast,
  expectSelfRollbackBroadcast,
  getMessagesEpoch,
  readSessionMessages,
  recordStructuralMutation,
  type ServerMergeOutcome,
} from './messageWriteGate'

/**
 * 单条会话消息列表的门面。集中「合并函数选择 + 写入门控 +
 * 结构性变更登记 + 自发回退广播抑制」。
 *
 * 合并方法**显式接收 `current`**：读当前列表是 store 侧调用方的职责（它们直接持
 * `get()`）。`getMessages()` 作为独立读访问器，供无 store 直接
 * 访问的外部消费方（如 SessionController）取消息，不承担 merge 的 current 来源。
 */
export interface SessionMessagesFacade {
  /** 读取本会话当前消息真相列表（无则空数组）。经 messageWriteGate 注入的 reader。 */
  getMessages: () => ChatMessage[]
  /** 服务端 sync 发起 fetch 前捕获 epoch，与 `commitServerMerge` 配对。 */
  captureEpoch: () => number
  /** 服务端 sync 写回唯一入口（epoch + restoring 门控）。 */
  commitServerMerge: (fetchEpoch: number, apply: () => void) => ServerMergeOutcome
  /** 本地结构性变更登记（回退截断 / unrevert 恢复）。 */
  recordStructuralMutation: (label: string) => void
  /** 发起端 rollback/unrevert API 成功后登记，抑制自发广播的整页重拉。 */
  expectSelfRollbackBroadcast: () => void
  /** ROLLBACK/UNREVERT 广播到达时消费期望；命中 = 本机自发，跳过重拉。 */
  consumeSelfRollbackBroadcast: () => boolean
  /**  对账唯一 merge：本地为底 identity upsert。 */
  mergeDelta: (current: ChatMessage[], fresh: ChatMessage[]) => MergeResult
  /** 结构性截断（回退；非对账）。轮末列表写回不得走此路径。 */
  mergeAuthoritativeReplace: (current: ChatMessage[], serverMessages: ChatMessage[]) => ChatMessage[]
}

/** 取指定 session 的消息门面（无状态，随用随建）。 */
export function getSessionMessagesFacade(sessionId: string): SessionMessagesFacade {
  return {
    getMessages: () => readSessionMessages(sessionId),
    captureEpoch: () => getMessagesEpoch(sessionId),
    commitServerMerge: (fetchEpoch, apply) => commitServerMerge(sessionId, fetchEpoch, apply),
    recordStructuralMutation: (label) => recordStructuralMutation(sessionId, label),
    expectSelfRollbackBroadcast: () => expectSelfRollbackBroadcast(sessionId),
    consumeSelfRollbackBroadcast: () => consumeSelfRollbackBroadcast(sessionId),
    mergeDelta: (current, fresh) => mergeMessagesFromServer(current, fresh),
    mergeAuthoritativeReplace: (current, serverMessages) =>
      mergeAuthoritativeServerReplace(serverMessages, current),
  }
}
