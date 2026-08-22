import type { ChatSession } from '@tabtin/chat-client'

/**
 * 「会话累计」token 统计——计费 / 报表语义。
 *
 * 注意：**不包含** context_tokens 字段（2026-05-10 起废弃，messages-as-truth
 * 改造后由 `chatMessageContextUsage.getCurrentContextTokens` 从 messages 派生）。
 * wire schema 端字段还在以向下兼容老构建，但 renderer 不再消费。
 */
export interface ChatSessionTokenUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  /** 会话累计缓存命中 input tokens（与 input/output 同路径实时累加，）。 */
  cache_read_input_tokens?: number
  /** 会话累计缓存写入 input tokens。 */
  cache_creation_input_tokens?: number
}

// ─── token 字段 SSoT 集合（三视角 review 闭环）─────────────────────────────
//
// ChatSession 上的 token 字段分两类：
//
//   1. **活字段** (`UPDATABLE_MONOTONIC_TOKENS`)
//      用 `updateSessionTokenUsageInCaches` 走 `Math.max(prev, incoming)` 单调
//      写入——拦异步 race 写小值覆盖大值。新增 Anthropic / OpenAI 推的 caching
//      计费字段（譬如 `cache_read_tokens` / `cache_creation_input_tokens` /
//      `reasoning_tokens`）时**只往这个数组里加一项**，三处自动跟上：
//        - 写入路径：`useChatStore.ts` 的 `updateSessionTokenUsageInCaches`
//          import 本数组做 monotonic 循环；
//        - 读取路径：`extractChatSessionTokenUsage` 用本数组循环生成；
//        - 剔除路径：`omitMonotonicTokenFields` 用 `ALL_TOKEN_FIELDS_TO_OMIT`
//          组合（活字段 + 已废弃字段）。
//
//   2. **已废弃字段** (`DEPRECATED_TOKEN_FIELDS`)
//      schema 里还在但 renderer 不消费——`context_tokens` 在 messages-as-truth
//      改造后由 `chatMessageContextUsage.getCurrentContextTokens` 从 messages
//      派生。仍要在"全量 merge freshSession"时剔除，否则服务端旧值会覆盖前端
//      新派生的值（视觉表现：用量数字突然变化）。
//
// 不允许在文件别处再硬编码 `'input_tokens'`/`'output_tokens'`/`'total_tokens'`/
// `'context_tokens'` 等字面字符串——`chatSessionTokenUsage.test.ts` 的 invariant
// 测试会把三处常量关系卡死，散落的硬编码下次重构会失守。

/** 活字段：单调写入 + 读取 + 剔除三路径都用。新增 token 字段往这里加。 */
export const UPDATABLE_MONOTONIC_TOKENS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const

/** 已废弃字段：仅在剔除路径用，防服务端旧值覆盖前端派生。 */
export const DEPRECATED_TOKEN_FIELDS = [
  'context_tokens',
] as const

/**
 * 任何"全量 merge ChatSession 进缓存"路径必须剔除的字段集合。
 *
 * = 活字段（走单调写入路径不能被全量 patch 覆盖）+ 已废弃字段。
 *
 * 当前覆盖调用方：
 *   - `lifecycleHandler.ts` phase==='end' 后 `client.sessions.get` 全量回灌
 *   - `sendMessageAction.ts` `syncSessionMessagesFromServer` 重连后补拉
 */
export const ALL_TOKEN_FIELDS_TO_OMIT = [
  ...UPDATABLE_MONOTONIC_TOKENS,
  ...DEPRECATED_TOKEN_FIELDS,
] as const

/**
 * 从 ChatSession patch 中剔除全部 token 字段，保留其余字段做全量 merge。
 *
 * 配合 `updateSessionTokenUsageInCaches` 的单调写入使用——典型 pattern：
 *
 * ```ts
 * client.sessions.get(sid).then(fresh => {
 *   updateSessionTokenUsageInCaches(sid, extractChatSessionTokenUsage(fresh))
 *   updateSessionInCaches(sid, omitMonotonicTokenFields(fresh))
 * })
 * ```
 *
 * 入参签名是完整 ChatSession（不是 Partial）——本函数为"GET 接口全量返回"
 * 设计；WS 推送的 partial patch 不应该带 token 字段，直接走 `updateSessionInCaches`
 * 即可，不需要本函数。
 */
export function omitMonotonicTokenFields(session: ChatSession): Partial<ChatSession> {
  const rest: Record<string, unknown> = { ...session }
  for (const key of ALL_TOKEN_FIELDS_TO_OMIT) {
    delete rest[key]
  }
  return rest as Partial<ChatSession>
}

/**
 * 兼容读取会话 token 统计字段。
 * 某些构建场景下 ChatSession 类型定义可能暂未包含这些可选字段，
 * 这里统一做运行时安全提取，避免类型漂移导致调用侧编译失败。
 *
 * 内部循环 `UPDATABLE_MONOTONIC_TOKENS`——新增 token 字段时无需改本函数。
 */
export function extractChatSessionTokenUsage(session: ChatSession): ChatSessionTokenUsage {
  const candidate = session as ChatSession & Record<string, unknown>
  const usage: ChatSessionTokenUsage = {}
  for (const key of UPDATABLE_MONOTONIC_TOKENS) {
    const value = candidate[key]
    if (typeof value === 'number') {
      usage[key] = value
    }
  }
  return usage
}
