/**
 * 重构来源：packages/agent-runtime/src/tools/show-widget.ts（行 323-432）
 * 拆分时间：2026-04-30
 * 重构原因：show-widget.ts 711 行单文件过大，按职责拆分
 * 职责：从 context.messages 启发式定位当前 show_widget tool_use 的 tool_call_id。
 *       含 module 级 WeakSet `_usedToolUseBlockRefs` 跟踪 used 状态 + 测试出口
 *       `__resetShowWidgetUsedRefsForTests` 让 vitest beforeEach 能清干净跨测试
 *       残留（WeakSet 在 vitest closure 里可能被持有）。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import type {
  Message,
  ContentBlock,
} from '../../engine/contracts/conversation.js';

/**
 * **Widget Wave 2.5（widget RFC §四 4.1 真流式 placeholder 关联）**：
 *
 * 通过 `context.messages` 启发式定位"当前正在执行的 show_widget tool_use"
 * 的 `tool_call_id`，写到 emit 的 RICH_CONTENT block 上——前端 streamMessageHandler
 * 用这字段把 placeholder（首条 args delta 时预创建）替换/合并成 final block，
 * 而不是 push 新 block 让 iframe 重 mount 闪烁。
 *
 * **为什么用启发式而不是直接拿 toolCallId**：tool-orchestration.ts 是禁改文件，
 * 它调用 `executeTool(tool, input, context, timeoutMs)` 时不把 block.id 注入
 * 到 ToolContext。改 tool-system.ts 加 toolCallId 参数也无效——上游 tool-orchestration
 * 不传。所以工具内部只能从 context.messages（已包含本轮 tool_use blocks）启发式
 * 反查。
 *
 * **匹配策略**（按可靠性从高到低）：
 *   1. 找最近一条 assistant 消息里 name === 'show_widget' 且 input.code === 当前
 *      input.code、且 block 引用未被本 finder 之前 used 过的 tool_use block —— `code`
 *      字段是大字符串，多 widget 并行时极不可能完全相同，匹配最可靠
 *   2. 退化：只看 name === 'show_widget' + 未被 used，取**正向第一个**（按
 *      messages 顺序与 query.ts execute 顺序对齐）
 *   3. 都没找到：返回 undefined，前端走 FIFO 启发式 fallback（看 tools 来到顺序）
 *
 * **失败容忍**：找不到 toolCallId 时**不**退化到错误——仍然 emit RICH_CONTENT，
 * 只是 block 不带 tool_call_id。前端 RICH_CONTENT 分流逻辑判断 `tool_call_id`
 * 缺失时走 append 路径，不影响渲染功能；只是流式 placeholder 不会被替换会留个
 * 空壳子（这种情况现实中只在 messages 为空的极端单测里发生）。
 *
 * **Wave 2.5 自修复（技术 Review P0-1）**：用 WeakSet 跟踪已 used 的 tool_use
 * block 引用，避免"两个完全相同 input.code 的 widget 同 turn 出现"时启发式
 * 查找总返回同一 toolCallId → 第一张 placeholder 永远转圈不被替换的双卡 bug。
 *
 * - WeakSet over ContentBlock object refs：messages 数组 GC 时自动清，无内存
 *   泄漏（不需要 size cap / TTL）
 * - 同一 turn 内 N 次 show_widget execute 按 query.ts 主循环顺序依次调用本
 *   函数；每次取走一个未 used 的 tool_use → tool 1 拿 tu_1.id，tool 2 拿
 *   tu_2.id（顺序对齐，不错位）
 *
 * **遍历方向决策**：
 *   - 严格匹配阶段：仍在最近一条 assistant 内做（反向遍历 messages，找到最近
 *     一条 assistant 即停）。这是历史 turn 的 tool_use 不会被本次 execute 误关联
 *     的关键（譬如用户多 turn 都画 widget，messages 里有多 turn 的 tool_use）。
 *   - 在最近一条 assistant 的 blocks 内：**正向遍历**优先匹配未 used 的 tool_use。
 *     query.ts 主循环按 messages.content 出现顺序 execute tools——正向遍历让第 N
 *     次 execute 拿到第 N 个 tool_use 的 id（顺序对齐）。
 */
// `let` 不是 const——`__resetShowWidgetUsedRefsForTests` 会重新分配新 WeakSet
// 让跨测试的 used 状态彻底干净（vitest closure 可能让旧 block ref 被持有）。
let _usedToolUseBlockRefs = new WeakSet<ContentBlock>()

type ShowWidgetToolUseBlock = ContentBlock & {
  type: 'tool_use'
  name: 'show_widget'
  id: string
}

function isUnusedShowWidgetBlock(block: ContentBlock | undefined): block is ShowWidgetToolUseBlock {
  return Boolean(
    block &&
    block.type === 'tool_use' &&
    block.name === 'show_widget' &&
    !_usedToolUseBlockRefs.has(block),
  )
}

function takeShowWidgetBlock(block: ShowWidgetToolUseBlock): string {
  _usedToolUseBlockRefs.add(block)
  return block.id
}

function findExactCodeMatch(blocks: ContentBlock[], inputCode: string): string | undefined {
  for (const block of blocks) {
    if (!isUnusedShowWidgetBlock(block)) continue
    const tuInput = block.input as { code?: unknown } | null | undefined
    if (tuInput && typeof tuInput === 'object' && tuInput.code === inputCode) {
      return takeShowWidgetBlock(block)
    }
  }
  return undefined
}

function findFirstUnusedShowWidget(blocks: ContentBlock[]): string | undefined {
  const block = blocks.find(isUnusedShowWidgetBlock)
  return block ? takeShowWidgetBlock(block) : undefined
}

export function findToolCallIdHeuristically(
  messages: Message[] | undefined,
  inputCode: string,
): string | undefined {
  if (!messages || messages.length === 0) return undefined
  // 反向遍历 messages 数组找最近一条 assistant——保证只在当前 turn 内匹配，
  // 不会回头关联到上一 turn 的历史 tool_use。
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const m = messages[mi]
    if (!m || m.role !== 'assistant') continue
    const blocks = Array.isArray(m.content) ? (m.content as ContentBlock[]) : []
    if (blocks.length === 0) continue
    // 优先：正向遍历，严格匹配 input.code === 当前调用的 code（且 block 未被 used）。
    // 正向遍历 + 未 used 过滤让顺序对齐 query.ts 主循环 execute 顺序——
    // tool 1 拿 tu_1.id，tool 2 拿 tu_2.id（即便两者 input.code 完全相同）。
    const exactMatch = findExactCodeMatch(blocks, inputCode)
    if (exactMatch) return exactMatch
    // 退化：正向遍历取第一个未 used 的 show_widget tool_use（譬如 input.code
    // 流式期与最终 input 不一致 / 本 finder 看到的 messages 还没 commit 当前轮
    // 的 tool_use，仍然按出现顺序对齐）。
    const fallbackMatch = findFirstUnusedShowWidget(blocks)
    if (fallbackMatch) return fallbackMatch
    // 这条 assistant 没 show_widget，继续往前找——但通常是最近一条 assistant
    break
  }
  return undefined
}

/**
 * 测试用：重置 used WeakSet。每个测试 beforeEach 调一次，让本测试看到
 * 的 used 状态都是干净起点（避免上个测试残留的 block ref 在 vitest
 * closure 里被持有进而让本测试的 tool_use 假性"已 used"）。
 *
 * 生产代码 **不** 调本函数——WeakSet 由 GC 在 messages 数组释放时自动清。
 */
export function __resetShowWidgetUsedRefsForTests(): void {
  _usedToolUseBlockRefs = new WeakSet<ContentBlock>()
}
