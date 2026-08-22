/**
 * contentBlockSemantics —— 对话内容块的**统一语义解读**（读模型地基）。
 *
 * 背景：前端对话数据此前存在「实时 runtime blocks」与「历史 content_blocks_json」
 * 双形态，且 tool_use↔tool_result 配对、消息 owner 归属、`[子 Agent ID]` marker
 * 解析在 9+ 处各自重复实现，稍不同步就「刷新后正常、实时时错乱」。
 *
 * 本模块把这三件事收敛成**唯一实现**，供 stores 层（subagentRunsFromMessages）
 * 与 components 层（BlockTimeline / matchSubagentRuns / turnArtifacts / 画板 等）
 * 共同复用。放在底层 utils，不 import 任何 components，避免循环依赖。
 *
 * 术语：
 *   - `toolUseId` = LLM 原生 tool_use.id（如 `agent_0` / `toolu_xxx`）；同一 owner
 *     单轮内唯一，但**跨 owner（主/子/孙）会重号**。
 *   - `blockId` = 前端 ContentBlockEntry.block_id（daemon/DB 分配，稳定）。
 *   - `owner` = 消息的 `subagent_run_id`（空串=主 Agent），配对必须限定同 owner。
 */

/** 归一的块视图——兼容 native ContentBlock 与老 MessageBlock。 */
export interface SemanticBlock {
  type?: string
  id?: string
  name?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  presentation?: {
    kind: string
    data?: Record<string, unknown>
  }
  block_id?: string
}

export interface PairedToolResult {
  content: unknown
  isError: boolean
  presentation?: {
    kind: string
    data?: Record<string, unknown>
  }
}

const TOOL_RESULT_TYPES = new Set([
  'tool_result',
  'mcp_tool_result',
  'web_search_tool_result',
])

function isToolResult(b: SemanticBlock): boolean {
  return typeof b.type === 'string' && TOOL_RESULT_TYPES.has(b.type)
}

// daemon `appendSubagentId` 往配对 tool_result 尾部写 `\n\n[子 Agent ID: <uuid>]`。
// 这个 uuid 是子 Agent 的 subagentRunId（**全局唯一**），用它反查可避开跨 owner
// 会撞的 parentToolCallId（如多个组长各自第一个派发都是 `agent_0`）。
const SUBAGENT_ID_RE = /\[子 Agent ID:\s*([^\]\s]+)\s*\]/

/**
 * 剥掉审批回执前缀：`<approval_note>...</approval_note>\n\n{payload}`。
 *
 * runtime 给「用户批准 / 始终允许自动放行」的工具 tool_result.content 前置一段
 * `<approval_note>` LLM 元信号（见 agent-runtime `approval-receipt.ts`）。它是给
 * 模型看的运行时信号，不是工具输出——前端渲染/解析前必须剥掉，否则内容不再以
 * `{`/`[` 开头，JSON 解析失败，终端卡会把整段原始串（含 file_history）dump 出来。
 * 非字符串 / 无该前缀时原样返回。
 */
export function stripApprovalNotePrefix(content: string): string {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('<approval_note>')) return content
  const closeTag = '</approval_note>'
  const end = trimmed.indexOf(closeTag)
  if (end === -1) return content
  return trimmed.slice(end + closeTag.length).replace(/^\s+/, '')
}

/** 把 tool_result.content（string | ContentBlock[]）拍平成纯文本。 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
        ? (c as { text: string }).text
        : ''))
      .join('')
  }
  return ''
}

/** 解析 tool_result 里的 `[子 Agent ID: <uuid>]` marker（无则 undefined）。 */
export function extractSubagentRunIdFromResult(content: unknown): string | undefined {
  const m = SUBAGENT_ID_RE.exec(toolResultText(content))
  return m ? m[1] : undefined
}

/** 去掉 `[子 Agent ID: …]` marker，返回摘要正文。 */
export function stripSubagentIdMarker(content: unknown): string {
  return toolResultText(content).replace(SUBAGENT_ID_RE, '').trim()
}

/**
 * 按 tool_use.id 建「工具调用 → 配对 tool_result」映射（**同一 blocks 序列内 FIFO**）。
 *
 * 单序列内同一 tool_use.id 可能出现多次（LLM 重号 / 老数据），第 N 个 tool_use
 * 配第 N 个同 id 的 tool_result（result 总在其 use 之后顺序到达）。跨 owner 撞号
 * 由调用方按 owner 分序列（每条 message 各自的 blocks 天然同 owner）解决。
 *
 * 返回：Map<blockId, PairedToolResult>——键用**发起 tool_use 的 block_id**（稳定、
 * 唯一），让消费者按块反查而不必再处理 id 重号。
 */
export function pairToolResultsByBlock(
  blocks: readonly SemanticBlock[],
): Map<string, PairedToolResult> {
  const resultQueues = new Map<string, PairedToolResult[]>()
  for (const b of blocks) {
    if (!isToolResult(b)) continue
    const tuid = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
    if (!tuid) continue
    const q = resultQueues.get(tuid) ?? []
    q.push({
      content: b.content,
      isError: b.is_error === true,
      ...(b.presentation ? { presentation: b.presentation } : {}),
    })
    resultQueues.set(tuid, q)
  }

  const cursors = new Map<string, number>()
  const byBlockId = new Map<string, PairedToolResult>()
  for (const b of blocks) {
    const toolUseId = toolUseIdOf(b)
    if (!toolUseId) continue
    const blockKey = typeof b.block_id === 'string' && b.block_id.length > 0
      ? b.block_id
      : b.id
    if (typeof blockKey !== 'string' || blockKey.length === 0) continue
    const queue = resultQueues.get(toolUseId)
    if (!queue) continue
    const idx = cursors.get(toolUseId) ?? 0
    if (idx >= queue.length) continue
    byBlockId.set(blockKey, queue[idx])
    cursors.set(toolUseId, idx + 1)
  }
  return byBlockId
}

const TOOL_USE_TYPES = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use'])

/** 该块若为工具调用块，返回其 tool_use.id（native 用 `id`）；否则 undefined。 */
export function toolUseIdOf(b: SemanticBlock): string | undefined {
  if (typeof b.type !== 'string' || !TOOL_USE_TYPES.has(b.type)) return undefined
  return typeof b.id === 'string' && b.id.length > 0 ? b.id : undefined
}

/** 是否工具结果惰性块。 */
export function isToolResultBlock(b: SemanticBlock): boolean {
  return isToolResult(b)
}
