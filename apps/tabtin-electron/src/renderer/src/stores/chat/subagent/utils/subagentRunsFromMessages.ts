/**
 * subagentRunsFromMessages — 从已加载的 chat_message 派生子 Agent run 索引（聚合卡用）。
 *
 * 替代「读本地 jsonl 索引」的历史恢复路径：子 Agent 的 run 元数据完全可由父消息块恢复，
 * 无需本地 jsonl、无需新增表 / 接口（统一以 chat_message 为 SSoT，跨端 / 云端可恢复）。
 *
 * 派生口径（与 daemon 落库口径对齐）：
 *   - 父 `tool_use`（name ∈ agent/task）：`id`=parentToolCallId；`input` → task/label/model/role；
 *   - 与之配对的 `tool_result`（tool_use_id 相同）：
 *       · 文本里的 `[子 Agent ID: <id>]`（daemon `appendSubagentId` 写入）→ subagentRunId；
 *       · `is_error` → status（failed / completed）；content（去标记）→ summary。
 *   - 主消息与子代理消息都扫：子代理消息里的 agent tool_use 派生孙 Agent run，
 *     让 reload 后冷源能恢复孙 Agent 卡片。
 *   - 无 tool_result（运行中）的 run 这里**不造行**——实时态由 SUBAGENT_* 事件填的 run 覆盖。
 */

import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import type { SubagentRun, SubagentStatus } from '../../shared/types'
import {
  extractSubagentRunIdFromResult,
  stripSubagentIdMarker,
} from '../../messages/utils/contentBlockSemantics'
import {
  SUBAGENT_TOOL_NAMES,
  classifySubagentToolInput,
} from '../../../../components/chat/blocks/subagentToolNames'

/**
 * 取一条消息的内容块——**统一数据层入口**（ 阶段 5）。
 *
 * 口径：直接读 `message.blocks`（运行时 SSoT——实时 flush + 历史入口反序列化统一灌入）。
 * 实时 runtime 里已到达但尚未落库的块（譬如嵌套孙 Agent 的 tool_result marker）经
 * commit 进 message.blocks，与 turnArtifacts / 画板 / 主对话渲染同一份读模型，不再读
 * content_blocks_json。参数保留供单测覆盖。
 */
export type SubagentBlocksResolver = (m: ChatMessage) => readonly MessageBlock[]

const defaultBlocksResolver: SubagentBlocksResolver = (m) =>
  (m.blocks ?? []).map((e) => (e as { block: MessageBlock }).block)

function blockField<T = unknown>(block: MessageBlock, key: string): T | undefined {
  return (block as unknown as Record<string, unknown>)[key] as T | undefined
}

/**
 * 消息的「所属 Agent」（owner）—— `subagent_run_id` 标记本条消息是哪个子 Agent 产出。
 * 空 / undefined = 主 Agent。tool_use↔tool_result 配对必须**限定在同一 owner 内**。
 */
function messageOwner(m: ChatMessage): string {
  const owner = (m as unknown as { subagent_run_id?: unknown }).subagent_run_id
  return typeof owner === 'string' && owner.length > 0 ? owner : ''
}

export function deriveSubagentRunsFromMessages(
  messages: readonly ChatMessage[],
  getBlocks: SubagentBlocksResolver = defaultBlocksResolver,
): SubagentRun[] {
  // tool_use↔tool_result 配对：**按 owner（subagent_run_id）分桶 + 桶内顺序 FIFO**。
  //
  // 背景：provider 发的 tool_use id（如 `agent_0`）只在单个 session 单轮内唯一。群协作
  // 里，主 Agent + 各子 Agent（组长 A/B/C）的消息都落进同一个父会话的 content_blocks，
  // 每个 owner 各自从 `agent_0` 重编号 → 全局撞车。若不分 owner，组长C 的 `agent_0`
  // result 会被错配给 组长B 的 `agent_0` use，角色错乱、部分 run 丢失。
  //
  // 正确口径：配对键 = `owner \0 toolUseId`（tool_use 与其 result 同 owner——result 是
  // 派发方收到的回执）；桶内再按文档顺序 FIFO（第 N 个 use 配第 N 个 result，result 总
  // 在其 use 之后顺序到达）。
  const key = (owner: string, tuid: string): string => `${owner}\u0000${tuid}`
  const resultsByKey = new Map<string, Array<{
    content: unknown
    isError: boolean
    presentation?: { kind?: unknown; data?: Record<string, unknown> }
  }>>()
  for (const m of messages) {
    const blocks = getBlocks(m)
    if (blocks.length === 0) continue
    const owner = messageOwner(m)
    for (const b of blocks) {
      if (blockField<string>(b, 'type') !== 'tool_result') continue
      const tuid = blockField<string>(b, 'tool_use_id')
      if (typeof tuid === 'string') {
        const k = key(owner, tuid)
        const arr = resultsByKey.get(k) ?? []
        arr.push({
          content: blockField(b, 'content'),
          isError: blockField(b, 'is_error') === true,
          presentation: blockField(b, 'presentation'),
        })
        resultsByKey.set(k, arr)
      }
    }
  }
  // 每个 (owner,id) 的消费游标（已配对到第几个 result）。
  const consumeCursor = new Map<string, number>()

  const consumeResultFactsForUse = (k: string): Array<{
    content: unknown
    isError: boolean
    presentation?: { kind?: unknown; data?: Record<string, unknown> }
  }> | undefined => {
    const arr = resultsByKey.get(k)
    if (!arr) return undefined
    const idx = consumeCursor.get(k) ?? 0
    if (idx >= arr.length) return undefined
    const first = arr[idx]
    const subagentRunId = extractSubagentRunIdFromResult(first.content)
    if (!subagentRunId) {
      consumeCursor.set(k, idx + 1)
      return [first]
    }
    const facts = [first]
    let nextIdx = idx + 1
    while (nextIdx < arr.length) {
      const candidate = arr[nextIdx]
      const candidateRunId = extractSubagentRunIdFromResult(candidate.content)
      if (candidateRunId !== subagentRunId) break
      facts.push(candidate)
      nextIdx += 1
    }
    consumeCursor.set(k, nextIdx)
    return facts
  }

  // 同时扫主消息与子代理消息：子代理（child）消息里的 agent tool_use 派生出孙
  // Agent run（reload 后冷源恢复孙卡片），parentToolCallId 即子的 agent tool_use id。
  const runs: SubagentRun[] = []
  const seen = new Set<string>()
  for (const m of messages) {
    const blocks = getBlocks(m)
    if (blocks.length === 0) continue
    const owner = messageOwner(m)

    for (const b of blocks) {
      if (blockField<string>(b, 'type') !== 'tool_use') continue
      const name = blockField<string>(b, 'name')
      if (typeof name !== 'string' || !SUBAGENT_TOOL_NAMES.has(name)) continue
      // 只有 spawn / resume 派生 run。`check_agent_id` 是查询，`wait_agent_ids`
      // 是父 run 等待屏障；两者都不创建子 Agent。unknown 在冷源里保留兼容：
      // 老归档可能缺 input，后续仍必须拿到真实 `[子 Agent ID]` marker 才会成 run。
      const intent = classifySubagentToolInput(blockField(b, 'input'))
      if (intent === 'check' || intent === 'wait') continue
      const parentToolCallId = blockField<string>(b, 'id')
      if (typeof parentToolCallId !== 'string') continue
      const k = key(owner, parentToolCallId)
      const resultFacts = consumeResultFactsForUse(k)
      if (!resultFacts) continue // 运行中（无结果）→ 由 live 事件覆盖
      const result = resultFacts[resultFacts.length - 1]
      const subagentRunId = extractSubagentRunIdFromResult(result.content)
      if (!subagentRunId) continue
      // resume 会复用同一个 subagentRunId；真正区分“这一次工具调用”的是
      // 派发边 parentToolCallId（再加 owner，避免嵌套子 Agent 的 agent_0 撞车）。
      const runKey = key(owner, `${parentToolCallId}\u0000${subagentRunId}`)
      if (seen.has(runKey)) continue
      seen.add(runKey)

      const input = (blockField<Record<string, unknown>>(b, 'input') ?? {}) as Record<string, unknown>
      const presentation = result.presentation
      const presentationKind = presentation?.kind
      let persistedStatus: unknown
      if (presentationKind === 'subagent_result' || presentationKind === 'subagent_dispatch') {
        persistedStatus = presentation?.data?.status
      }
      const legacySummary = stripSubagentIdMarker(result.content)
      const legacyCancelled = legacySummary.startsWith('Sub-agent cancelled by user:')
        || legacySummary.startsWith('Sub-agent cancelled:')
      const backgroundDispatch =
        presentationKind === 'subagent_dispatch'
        || (presentationKind === undefined && input.background === true)
      const archiveStatusSource: SubagentRun['archiveStatusSource'] = presentationKind === 'subagent_result'
        ? 'presentation_result'
        : presentationKind === 'subagent_dispatch'
          ? 'presentation_dispatch'
          : input.background === true
            ? 'legacy_background'
            : 'legacy_result'
      const status: SubagentStatus = persistedStatus === 'cancelled'
        ? 'cancelled'
        : persistedStatus === 'completed'
          ? 'completed'
          : persistedStatus === 'failed'
            ? 'failed'
            : persistedStatus === 'pending' || persistedStatus === 'running' || persistedStatus === 'queued'
              ? 'pending'
              : result.isError
                ? (legacyCancelled ? 'cancelled' : 'failed')
                : backgroundDispatch
                  ? 'pending'
                  : 'completed'
      const startedAt = Date.parse(m.created_at)
      const summary = legacySummary || undefined
      runs.push({
        subagentRunId,
        parentToolCallId,
        // 派发它的上层 Agent（owner）——主派的子为空串，子派的孙为该子的 run id。
        // 让显示层按 owner 作用域反查（parentToolCallId 跨 owner 会撞）。
        dispatchedByRunId: owner,
        status,
        task: typeof input.prompt === 'string' ? input.prompt : undefined,
        label: typeof input.description === 'string' ? input.description : undefined,
        model: typeof input.model === 'string' ? input.model : undefined,
        role: typeof input.role === 'string' ? input.role : undefined,
        // ：冷源恢复模板派发标记。父 tool_use.input 只带 template_id
        // （template_name 未落 input），故这里仅回填 templateId；badge 在只有 id 时
        // 走通用「源自模板」文案（见 SubagentAggregateView）。
        templateId: typeof input.template_id === 'string' ? input.template_id : undefined,
        background: input.background === true ? true : undefined,
        archiveStatusSource,
        summary,
        startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
        ...(result.isError
          ? { errorKind: status === 'cancelled' ? 'cancelled' as const : 'failed' as const, error: summary }
          : {}),
      })
    }
  }
  return runs
}
