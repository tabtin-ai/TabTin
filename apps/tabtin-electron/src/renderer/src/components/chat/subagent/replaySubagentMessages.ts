/**
 * replaySubagentMessages — 把子 Agent 的 messages.jsonl envelope 流重放为
 * ChatMessage[]，给 MessageList 渲染。
 *
 * 背景（PRD v3.1 dogfood 修订）：
 * 上一轮 W2 抽屉 + 本轮 v3 Pane 都用「行号 + role + summary」开发者视图渲染
 * jsonl，跟主对话 ChatPanel 形态完全不一致。子 Agent 详情应是「同样 chat
 * 视图，只是开在新 tab 里」。
 *
 * 本函数是替代方案的核心：jsonl envelope 流跟主对话 runtime 推的流 schema
 * **完全一样**（agent.stream.message_start / content_block_start / _delta /
 * _stop / message_stop），所以只要 reduce 成 ChatMessage[] 喂给 MessageList，
 * 用户看到的就是和主对话同款的消息气泡 / 思考块 / 工具调用卡片。
 *
 * 为什么不复用 contentBlockHandler？
 * contentBlockHandler 是 780 行、跟 useChatStore / useChatRuntimeStore 紧
 * 耦合的 dispatcher（实时流转）。子 Agent 详情是 _一次性回放_ jsonl，pure
 * function 更简洁、可测、不污染主对话 store。
 *
 * 支持的 envelope event：
 * - agent.stream.message_start：新 ChatMessage
 * - agent.stream.content_block_start：新 MessageBlock（thinking / text / tool_use）；
 *   tool_result 块特殊处理——按 tool_use_id 把结果回填到对应 tool_use 卡片
 *   （见 attachToolResultToCall），不单独成块
 * - agent.stream.content_block_delta：累积 thinking_delta / text_delta / input_json_delta
 * - agent.stream.content_block_stop：JSON.parse 累积的 input_json
 * - agent.stream.message_stop：no-op（消息完结，仅边界标记）
 *
 * 不支持的 envelope（暂不渲染）：
 * - system_notice / subagent_progress 等（runtime 元事件，无对应 ChatMessage）
 */

import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import type { ContentBlock } from '@tabtin/agent-wire'
import { applyReplayEnvelopeEventWithHandlers } from './replayEnvelopeHandlers'

interface EnvelopeLine {
  type?: string
  timestamp?: string
  payload?: {
    event_type?: string
    message_id?: string
    role?: 'user' | 'assistant' | 'system'
    index?: number
    arrival_seq?: number
    //  元字段统一：message_start 携带的 LLM 元信息，与主 Agent/历史消息同构。
    model_id?: string | null
    model_name?: string | null
    message_kind?: string
    started_at?: string
    // message_delta 携带的 usage（cumulative）+ 错误信息。
    usage?: Record<string, unknown>
    error_info_json?: Record<string, unknown>
    block?: {
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
      // tool_result 块专用：result 回填到对应 tool_use 卡片（按 tool_use_id 配对）。
      // content 是完整序列化字符串（不走 delta），is_error 标失败。
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      partial_json?: string
      // message_delta.delta.stop_reason（Anthropic schema 放这里，不在 message_stop）。
      stop_reason?: string | null
    }
    _seq?: number
  }
}

// content_blocks_json 中的 block 在累积期需要的中间字段；产出到 .blocks 时映射成
// ContentBlockEntry 的流式元数据（pendingInputJson / finalized），再从持久 json 剥掉。
interface AccumulatingBlock extends MessageBlock {
  _partialJson?: string
  /** content_block_stop 到达 → true；流式期为 false（供 .blocks 的 finalized）。 */
  _finalized?: boolean
  /** 原始 envelope index；数组自身保持 dense，避免非连续 index 造 JS 空洞。 */
  _replayIndex?: number
}

function mapEnvelopeBlockToMessageBlock(
  envBlock: NonNullable<NonNullable<EnvelopeLine['payload']>['block']>,
): AccumulatingBlock {
  const type = envBlock.type
  if (type === 'thinking') {
    return { type: 'thinking', thinking: envBlock.thinking ?? '' } as AccumulatingBlock
  }
  if (type === 'text') {
    return { type: 'text', text: envBlock.text ?? '' } as AccumulatingBlock
  }
  if (type === 'tool_use') {
    // 保持 Anthropic native 形态（tool_use），与 cold（chat_message.content_blocks_json）
    // 完全同构——两个数据源（实时 live / 历史 cold）交给 BlockTimeline 用**同一套**
    // 配对逻辑（pairToolResultsByBlock）渲染。input 在 content_block_stop 时从累积的
    // input_json_delta parse 出来。
    // native tool_use 不在 MessageBlock 的老 type 枚举里；cold（chat_message）同样把
    // native 塞进 MessageBlock[] 靠运行时结构，这里 cast 对齐。
    return {
      type: 'tool_use',
      id: envBlock.id ?? '',
      name: envBlock.name ?? 'unknown',
      input: envBlock.input ?? {},
    } as unknown as AccumulatingBlock
  }
  // 未知 block 类型：降级为 text，让用户至少看到 raw 输出
  return { type: 'text', text: `[未知 block: ${type ?? '?'}]` } as AccumulatingBlock
}

/**
 * 把 tool_result envelope 块作为 **native `tool_result` 块** append 到发起它的
 * tool_use 所在 message（同 message），使 live 产出的消息与 cold（chat_message）
 * 结构完全一致：`tool_use` + `tool_result` 同处一条 assistant 消息、native 形态。
 *
 * 背景：子 Agent envelope 流里 tool_result 到达时在一条独立 user 消息的 content
 * block 里（`{ type:'tool_result', tool_use_id, content, is_error }`，content 是完整
 * 序列化字符串、不走 delta）。若原样留在那条 user 消息，tool_use（assistant）与
 * tool_result（user）就跨 message，而子 Agent 详情用虚拟 session、BlockTimeline 只做
 * 同 message 配对（siblingToolResult），跨 message 配不上 → 工具卡拿不到结果。
 * cold 侧 daemon reassembler 已把两者合并进同一 message，所以这里对齐同款：把
 * tool_result 合并回 tool_use 所在 message，但用 **native tool_result 块**（不再转成
 * 老 tool_call 回填 output）——block 匹配逻辑与 cold / 主对话完全一致。
 *
 * **配对到「首个未配对」的同 id tool_use message（FIFO）**：provider 的 tool_use id
 * （如 `agent_0`）只在单轮内唯一，同一子 Agent 跨多轮再派孙 Agent 会重复出现多个
 * `agent_0`。result 总在其 tool_use 之后顺序到达，append 到「首个尚无同 id tool_result」
 * 的 message，即正确的那一个。找不到（极少见乱序 / id 不匹配）则丢弃，不渲染噪声。
 */
/** 给块盖上 runtime 权威排序键（arrival_seq + arrived_at），与主 Agent content block 同构。
 * arrival_seq 由 daemon `ensureArrivalSeq` 统一分配、挂在 `payload.arrival_seq`——只读不造；
 * 缺失（理论不会）则不盖，交给 materialize 的 created_at 兜底。 */
function stampArrival(block: MessageBlock, arrivalSeq: number | undefined, arrivedAt: string): void {
  if (typeof arrivalSeq !== 'number' || !Number.isFinite(arrivalSeq)) return
  ;(block as MessageBlock & { arrival_seq?: number; arrived_at?: string }).arrival_seq = arrivalSeq
  ;(block as MessageBlock & { arrival_seq?: number; arrived_at?: string }).arrived_at = arrivedAt
}

function appendToolResultBlock(
  state: ReplayState,
  envBlock: NonNullable<NonNullable<EnvelopeLine['payload']>['block']>,
  arrivalSeq: number | undefined,
  arrivedAt: string,
): void {
  const toolUseId = typeof envBlock.tool_use_id === 'string' ? envBlock.tool_use_id : ''
  if (!toolUseId) return
  for (const id of state.messagesOrder) {
    const blocks = state.messagesById.get(id)?.content_blocks_json
    if (!blocks) continue
    const hasUse = blocks.some(
      b => (b as { type?: string }).type === 'tool_use' && (b as { id?: string }).id === toolUseId,
    )
    if (!hasUse) continue
    const alreadyPaired = blocks.some(
      b => (b as { type?: string }).type === 'tool_result'
        && (b as { tool_use_id?: string }).tool_use_id === toolUseId,
    )
    if (alreadyPaired) continue // 该 message 的该 id 已配 → 找下一个（跨轮同 id FIFO）
    const resultBlock = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: envBlock.content,
      is_error: envBlock.is_error === true,
    } as unknown as MessageBlock
    stampArrival(resultBlock, arrivalSeq, arrivedAt)
    blocks.push(resultBlock)
    return
  }
}

export interface ReplayResult {
  messages: ChatMessage[]
  /** 第一条 user message 的 index；前面的全部视为「父对话继承上下文」 */
  firstUserMessageIndex: number
}

/**
 * 增量 reducer 的内部状态（事件流的中间态，不直接给 UI 用）。
 *
 * 拆分动机（PRD §4.18）：原来 reducer 只 export batch 入口 `replaySubagentMessages`，
 * 子 Agent 详情数据流唯一路径是「jsonl 落盘 → IPC 读 → batch reduce」。改造后
 * 增加「runtime 实时事件 → live store 增量 reduce」第二条路径，store 需要持有
 * reducer 状态机；如果 store 每次 push 都重新 batch reduce 完整事件流，事件量
 * 大时 O(N²) 影响交互流畅度。
 *
 * 拆开后两路径都用同一个 `applyEnvelopeEvent` 单事件 reducer：
 *   - batch（jsonl）：`lines.reduce(applyEnvelopeEvent, createInitialReplayState())`
 *   - 增量（live）：store 维护 ReplayState 实例，每个新事件 in-place apply
 */
export interface ReplayState {
  messagesById: Map<string, ChatMessage>
  messagesOrder: string[]
}

export function createInitialReplayState(): ReplayState {
  return {
    messagesById: new Map(),
    messagesOrder: [],
  }
}

/**
 * 把一个 envelope event 应用到 state（in-place 修改）。
 *
 * **关键设计：in-place 修改**
 *   ChatMessage 对象本身可变（content_blocks_json[] 是 array，delta 时追加文本）。
 *   live store 调用方应在每次 apply 后用 `selectReplayMessages(state)` 派生新 array
 *   引用，让 React selector 触发 re-render。状态机本身不分配新对象（性能优化）。
 *
 * **幂等**：message_start 同 messageId 重复到达不会创建新消息（防 jsonl 半截损坏 /
 * 网络重发）。
 *
 * 返回 state 引用（方便链式 reduce），不返回新对象。
 */
export function applyEnvelopeEvent(state: ReplayState, rawEvent: unknown): ReplayState {
  const line = rawEvent as EnvelopeLine
  const type = line?.type
  const payload = line?.payload
  if (!type || !payload) return state
  const messageId = payload.message_id
  if (!messageId) return state

  applyReplayEnvelopeEventWithHandlers({
    state,
    line,
    messageId,
    payload,
    mapEnvelopeBlockToMessageBlock,
    appendToolResultBlock,
    stampArrival,
  })

  return state
}

/**
 * 从 ReplayState 派生最终 ChatMessage[]（每条 message 的 content 字段填纯文本汇总）。
 *
 * 注意每次调用都新建 array（不复用），让 selector 引用变化能触发 React re-render。
 * 单个 ChatMessage 对象本身仍是状态机内部引用，调用方不应当修改。
 *
 * **关键：必须克隆 `content_blocks_json`（数组 + 每个 block）成不可变快照。**
 *
 * `applyEnvelopeEvent` 为性能在 state 里 **in-place 修改** block（block.text /
 * block.thinking 逐 delta 追加），并保持 `content_blocks_json` 数组引用恒定不变。
 * 若本函数直接 `{...m}` 透传该数组引用，则 token-by-token 实时流场景下会出现
 * 「子 Agent 详情只显示首个 token（譬如「范围」）」的 bug：
 *
 *   下游 `MessageBubble.contentBlocks` 是以 `message.content_blocks_json` **引用**
 *   + `content_blocks_json.length` 为依赖的 useMemo（历史回放走 legacyAdapter
 *   分支）。两个 block（thinking + text）到齐后，数组引用恒定、length 恒为 2，
 *   useMemo 依赖永不变化 → 冻结在「text block 刚出现那一刻」的快照（通常只有
 *   首个 delta），后续 in-place 追加的文本永远刷不进 UI。
 *
 * 每次 select 产出 **全新数组 + 全新 block 对象**，让 `content_blocks_json` 引用
 * 随每个 delta 变化，下游 useMemo 正常重算，实时刷新到最新累积文本。顺带剥掉
 * 内部累积字段 `_partialJson`（不该外泄给渲染层）。
 */
export function selectReplayMessages(state: ReplayState): ChatMessage[] {
  return state.messagesOrder
    .map(id => state.messagesById.get(id))
    .filter((m): m is ChatMessage => m != null)
    .map(m => {
      const accBlocks = (m.content_blocks_json ?? []) as AccumulatingBlock[]
      const snapshotBlocks: MessageBlock[] = []
      // 直接产出带**流式元数据**的 ContentBlockEntry[]（不走 adaptLegacy——它强制
      // finalized=true 且丢 pendingInputJson，会让子代理块「看着已完成、参数等 stop
      // 才出」）。finalized 按块的 _finalized，tool_use 未完成时带 pendingInputJson，
      // 与主 Agent 引擎产出的块流式语义完全一致（BlockTimeline / ToolUseBlockView 同款渲染）。
      const blocks: ContentBlockEntry[] = accBlocks.map((acc, index) => {
        const { _partialJson, _finalized, _replayIndex, ...rest } = acc as AccumulatingBlock
        const block = rest as unknown as ContentBlock
        snapshotBlocks.push(block as unknown as MessageBlock)
        const type = (block as { type?: string }).type
        const isToolUse = type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use'
        const isResult = type === 'tool_result' || type === 'mcp_tool_result'
        const toolId = (block as { id?: string }).id
        const entry: ContentBlockEntry = {
          index,
          block_id: isToolUse && toolId ? toolId : `sub-${m.id}-${index}`,
          block,
          // 结果块原子到达即完成；其余块看 _finalized（content_block_stop 前为流式）。
          finalized: _finalized === true || isResult,
          partial: false,
        }
        // 流式期 tool_use 参数：暴露累积的 partial JSON，让卡片走 partial parse 实时显示。
        if (isToolUse && typeof _partialJson === 'string' && _partialJson.length > 0) {
          entry.pendingInputJson = _partialJson
        }
        return entry
      })
      const content = snapshotBlocks
        .filter(b => b.type === 'text')
        .map(b => (b as { text?: string }).text ?? '')
        .join('\n')
      return {
        // `...m` 透传 message_start/message_delta 抽取的全部元字段（model_id /
        // model_name / message_kind / stop_reason / usage_json / error_info_json）。
        ...m,
        content_blocks_json: snapshotBlocks,
        // ：子代理 transcript 挂带流式元数据的 `blocks`（SSoT 读模型），与主对话
        // 同源同款流式渲染；每次 select 换新引用触发响应式刷新。
        blocks,
        content,
        // 顶层冗余 text_summary 与主 Agent/历史消息对齐（会话列表预览 / 兜底渲染读它）。
        text_summary: content || m.text_summary,
      }
    })
    // 丢弃「只承载 tool_result（已回填到工具卡）」而本身空的 user 消息——否则工具
    // 调用之间会冒出空 user 气泡。assistant 空消息保留（live 流式 message_start 后、
    // 首块到达前的占位，下一拍就有内容）。
    .filter(m => {
      if (m.role !== 'user') return true
      const hasBlocks = (m.content_blocks_json?.length ?? 0) > 0
      const hasText = typeof m.content === 'string' && m.content.trim().length > 0
      return hasBlocks || hasText
    })
}

export function replaySubagentMessages(lines: unknown[]): ReplayResult {
  const state = createInitialReplayState()
  for (const rawLine of lines) {
    applyEnvelopeEvent(state, rawLine)
  }
  const messages = selectReplayMessages(state)

  // P2-13 / dogfood Q3：第一条 user message 是「子 Agent 真正开始工作」的分界点；
  // 前面全部视为父对话继承上下文，UI 折叠默认收起
  const firstUserMessageIndex = messages.findIndex(m => m.role === 'user')

  return { messages, firstUserMessageIndex }
}

// 注：曾有 `mergeReplayMessages(jsonl, live)` 合并双源（review C.1）。已于
// 2026-05-29 移除——subagent messages.jsonl 的 message_id 是 SessionStorage
// 合成的 `local-...`，与 live 的真实 envelope id 永不相等，按 id 去重失效会导致
// 同一条回复重复显示。#8846：SubagentDetailPane 按可见步完整度二选一（归档更完整
// 则用归档；禁止「有残缺 live 就丢掉磁盘」），见 selectSubagentDetailMessages。
