/**
 * Cost metadata builder — PRD-04 Wave 5 任务 1。
 *
 * 把 DONE.usage / AssistantEvent.usage 中的费用 / token 分项统一展开成
 * `ChatMessage.metadata` 用的扁平 key-value 结构，消除 3 处重复实现（TD-1 / TD-2）：
 *
 *   1. `packages/agent-runtime/src/engine/query.ts` · `buildTerminalAssistantPayload`
 *      — runtime 在 5 种终态 yield `agent.stream.assistant` phase=final 时构造
 *      payload.metadata；Django `relay_message_writer._upsert_chat_message` 据此
 *      把 metadata 幂等写入 MySQL `ChatMessage.metadata`。两个宿主（Electron/
 *      Daemon）都只是透传这个事件，M2.5 方案 B 后两端自动对齐——这是 Daemon
 *      模式 ChatMessage.metadata 不再永远为空的关键路径。
 *
 *   2. `apps/tabtin-electron/src/renderer/src/stores/chat/actions/sendMessageAction.ts`
 *      · onDone — renderer 端收到本地 runtime DONE 事件后，把同样的字段扁平化
 *      到 renderer 内存态 LocalChatMessage.metadata，驱动 MessageCostLabel /
 *      TokenUsageRing 实时刷新（独立于 relay 写库路径）。
 *
 * 输出合同（与 `ChatMessage.metadata` 一一对应）：
 * - `credits_consumed`: usage.cost_usd > 0 时写入
 * - `charge_failed`: usage.charge_status === 'failed' 时标 true
 * - `is_byok`: usage.charge_status === 'byok_exempt' 时标 true
 * - `input_tokens / output_tokens`: 基础 token 计数
 * - `cache_read_input_tokens / cache_creation_input_tokens`: cache 分项（turn 累加）
 * - `reasoning_tokens`: 深度思考 token
 * - `compact_input_tokens / compact_output_tokens`: 摘要压缩 token
 * - `last_input_tokens / last_cache_read_input_tokens / last_cache_creation_input_tokens`:
 *   **最近一次 LLM 调用** 的 usage 分项（context-ring 用）；
 *   与 turn 累加字段语义不同——前者是「当前上下文规模」，
 *   后者是「本轮总消耗」。renderer `chatMessageContextUsage` 优先读 last_*。
 *
 * 注意事项：
 * - 输入故意用 `unknown` 类型守卫而非强绑 `UsageReport`——wire 层 schema 变化不影响本 utility。
 * - 只展开"当前产品决策保留的分项"，未来新增字段需同步更新此函数 + 三处调用方。
 * - 空输入 / 非对象输入 → 返回空对象（调用方据 `Object.keys(metadata).length` 判断是否写 metadata）。
 */

import type { UsageReport } from '@tabtin/agent-wire';

/**
 * 从 usage 对象提取成本 / token 分项，扁平化为 ChatMessage.metadata 结构。
 *
 * @param usage 可能来自 runtime DONE 事件、assistant final 事件、也可能是 undefined。
 * @returns 字段名已对齐 ChatMessage.metadata 的 Record；非对象输入返回 `{}`。
 */
export function projectUsageMetadata(
  usage: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (!usage || typeof usage !== 'object') {
    return result;
  }

  const u = usage as Record<string, unknown>;

  if (typeof u.cost_usd === 'number' && u.cost_usd > 0) {
    result.credits_consumed = u.cost_usd;
  }

  const chargeStatus = u.charge_status;
  if (chargeStatus === 'failed') {
    result.charge_failed = true;
  } else if (chargeStatus === 'byok_exempt') {
    result.is_byok = true;
  }

  // 数值型 token 分项：有则透传，缺/非法则跳过（调用方按需兜底）。
  //
  // **这是产品决策的字段子集**——`UsageReport`（contracts/agent）还有其他
  // 数值字段（如 by_model 子结构、cost_usd 等已上方单独处理），刻意不展开。
  // 加 `_AssertSubset` 静态校验：list 里出现 `UsageReport` 不存在的 key 时
  // 编译期红线，避免 wire schema 改名后这里悄悄失同步（context_tokens 那次
  // 漏迁就是这种 silent fallback 累积出的事故）。
  const numberKeys = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
    'compact_input_tokens',
    'compact_output_tokens',
    // context-ring：最近一次 LLM 调用的 usage 分项
    'last_input_tokens',
    'last_cache_read_input_tokens',
    'last_cache_creation_input_tokens',
  ] as const;
  type _AssertSubset = (typeof numberKeys)[number] extends keyof UsageReport ? true : never;
  // 上方 type 别名仅用于编译期断言，运行时不存在；无需运行期使用
  void (null as unknown as _AssertSubset);

  for (const key of numberKeys) {
    const value = u[key];
    if (typeof value === 'number') {
      result[key] = value;
    }
  }

  return result;
}
