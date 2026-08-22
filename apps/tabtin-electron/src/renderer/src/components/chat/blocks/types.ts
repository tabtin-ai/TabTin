/**
 * BlockRenderer 公共类型 — 给 BlockTimeline + 8 家族 BlockRenderer 共用。
 *
 * 设计原则（v2 §3.5.1.b ~ §3.5.1.j + W4a 接通契约）：
 *
 * 1. **唯一数据源**：BlockTimeline 接 `ContentBlockEntry[]`（来自
 *    `useContentBlocks(sid, mid)`）。entry 内含 `block` + 流式元数据
 *    （`finalized` / `partial` / `pendingInputJson` / `parseError`）。
 *    BlockRenderer 通过 props.entry.block + props.entry.finalized 决定 UI。
 *
 * 2. **流式期间字段契约**（W4a-L5 推迟硬约束）：
 *    - tool_use.input 在 finalize 前一直是 `{}`；真实流式参数在
 *      `entry.pendingInputJson` 累积（partial JSON 字符串）。BlockRenderer
 *      在 `finalized=false` 时优先用 pendingInputJson 走 partial parse 显示，
 *      并打"正在生成参数…"标记；finalize 后 input 已 parse 进 block.input。
 *    - text.text 在流式期间已经走 `ensureClosedFences()` 收敛（W4a-L17），
 *      BlockRenderer 直接渲染 block.text 即可，无需自己 fence。
 *    - thinking.thinking 流式期间是 raw 文本（finalized 后才解析 markdown，
 *      参考 v2 §3.5.1.d）。
 *
 * 3. **React 渲染契约**（v2 §3.5.1.j 性能基线 4 项）：
 *    - 每个 BlockRenderer 必须用 `React.memo` 包裹。
 *    - 比较函数按 `(block_id, finalized, content_hash)` 而非整 block 对象
 *      ——避免父组件 shallow clone 不变内容时触发 useless re-render。
 *    - delta apply 由 W4a 已实现的 rAF batching 处理；BlockRenderer 不重复
 *      batch。
 *
 * 4. **fallback 链**（v2 §3.5.5）：
 *    - 已知 block.type → 专属 BlockRenderer
 *    - `tabtin_rich_content` + 已知 kind → 专属 RichKindView（dispatcher 内）
 *    - `tabtin_rich_content` + 未知 kind → 渲染 summary 文本
 *    - 未知 type → FallbackBlockView "此内容暂不支持，请在桌面端查看"
 *    - dispatcher 永不 throw，未知 / parseError 一律走 fallback。
 *
 * 5. **W4a-L39 决策（主气泡 vs 子 timeline）→ (a)**：
 *    BlockTimeline 是 assistant message 唯一渲染源。message.content（含
 *    lite-collector inject 的 `lastMain.content`）等同 BlockTimeline 末尾
 *    text block。MessageBubble 不再单独渲染 displayContent——彻底消除
 *    "主气泡 vs timeline 双显"。前 turn 的 text 与 tool_use/tool_result
 *    在 BlockTimeline 内按 LLM 真实产出顺序穿插显示。
 */

import type { MouseEvent } from 'react'
import type { ContentBlock } from '@tabtin/agent-wire'
import { ALL_BLOCK_TYPE_SET } from '@tabtin/agent-wire'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import type { ToolPresentation } from '@stores/chat/shared/types'

export type { ContentBlockEntry }

export interface SiblingToolResult {
  content: unknown
  isError?: boolean
  presentation?: ToolPresentation
}

/** 单个 BlockRenderer 接收的 props（统一签名，便于 dispatcher 调度） */
export interface BlockRendererProps {
  /** ContentBlockEntry —— 含 block 主体 + 流式元数据 */
  entry: ContentBlockEntry
  /** 所属 session id；ToolUse / RichContent 子组件订阅 buffer 需要 */
  sessionId: string | null
  /** 当前 UI 标签组 scope；Markdown 资源链接打开时用来写入正确标签桶。 */
  tabScopeKey?: string | null
  /** 所属 message id；ChartTimeline 主气泡 key 用 */
  messageId: string
  /**
   * 子 Agent run 反查专用 session id（缺省 = `sessionId`）。子 Agent 详情面板
   * 用虚拟 session 渲染 transcript，但「子 Agent 又派的孙 Agent」run 元数据 keyed
   * 在真实父 chat session 下——单个孙 Agent 卡片（SubagentBlockEntry）必须用它反查
   * 才不会落到空的虚拟 session 永远「连接中」。主对话不传。见 BlockTimelineProps。
   */
  subagentRunSessionId?: string | null
  /** 本 message 的 owner（subagent_run_id）——live 反查子 Agent run 的作用域。 */
  ownerRunId?: string
  /** 是否最后一条 assistant message（影响 stalled / spinner 显示等） */
  isLastAssistantMsg?: boolean
  /** 当前是否流式中（lastAssistantMsg && session streaming） */
  isStreaming?: boolean
  /** 消息级错误卡已表达中断时，隐藏 block 级 partial 文案。 */
  suppressPartialReason?: boolean
  /**
   * 会话级等待壳或 Thinking 流式行可见时，隐藏块内 Loader2，
   * 避免与 AgentAwaitingThought / 思考行重复。
   */
  suppressInlineLoading?: boolean
  /**
   * 当前 message 内与 tool_use 同 id 的 tool_result 内容。
   *
   * 主对话实时路径通常通过 runtime store 跨 message 反查 tool_result；子 Agent
   * replay/legacy 路径会把 tool_call.output 拆成同 message 的 tool_use +
   * tool_result，虚拟 session 不写 runtime store，因此需要把本地 sibling result
   * 直接传给 ToolUseBlockView。
   */
  siblingToolResult?: SiblingToolResult
  /**
   * 可选：点击富内容资源 ref 时的导航回调。
   *
   * 「Agent 产物在 Space 内的打开」机制 B：
   * - 第 3 参 `hint`：D2 第 3 层 Agent hint（`block.hint_carrier_app_id`）
   * - 第 4 参 `opts.modifierExternal`：⌘/Ctrl 修饰键短路 D2 第 5 层系统应用
   */
  onResourceNavigate?: (
    resourceType: string,
    resourceId: string,
    hint?: string,
    opts?: { modifierExternal?: boolean },
  ) => void
  /**
   * 可选：右键资源 ref 卡片时的菜单请求回调。让用户在卡片端用同款
   * ResourceLinkContextMenu 切换载体（与 markdown 链接的右键菜单一致）。
   */
  onResourceContextMenu?: (
    e: MouseEvent<HTMLElement>,
    resourceType: string,
    resourceId: string,
    hint?: string,
  ) => void
}

/**
 * BlockRenderer React.memo 通用比较函数。
 *
 * 比较口径（W4c · R6-P1-1 修复后）：(block_id, finalized, partial, partialReason,
 * startedAt, stoppedAt, parseError, pendingInputJson, block 引用)。
 *
 * **W4c 新增字段比较的必要性**：
 *   - `partialReason`：messageStop 默认推断 / watchdog 显式 / lifecycle 注入
 *     可能在 `block` 引用不变的情况下补写——譬如 message_stop 兜底 finalize 时
 *     `applyFinalizeFallback` 返回新对象但 block 字段仍引用相同。BlockRenderer
 *     必须感知 partialReason 变化才能切到"已中断 / 等待响应超时"文案
 *   - `startedAt` / `stoppedAt`：thinking 块的 "Thought for Xs" 在 stoppedAt
 *     stamp 时显示——必须比较以触发重渲染
 *
 * 不变量：父组件 BlockTimeline 不 shallow clone block 子字段；W4a 的 rAF
 * batching 只在真实 delta 写入时整 entry 替换。所以引用相等是真"内容相等"的
 * 充分条件。
 */
export function blockEntryEqual(prev: BlockRendererProps, next: BlockRendererProps): boolean {
  if (prev === next) return true
  if (prev.sessionId !== next.sessionId) return false
  if (prev.tabScopeKey !== next.tabScopeKey) return false
  if (prev.subagentRunSessionId !== next.subagentRunSessionId) return false
  if (prev.messageId !== next.messageId) return false
  if (prev.siblingToolResult !== next.siblingToolResult) return false
  if (prev.isLastAssistantMsg !== next.isLastAssistantMsg) return false
  if (prev.isStreaming !== next.isStreaming) return false
  if (prev.suppressPartialReason !== next.suppressPartialReason) return false
  if (prev.suppressInlineLoading !== next.suppressInlineLoading) return false
  if (prev.onResourceNavigate !== next.onResourceNavigate) return false
  if (prev.onResourceContextMenu !== next.onResourceContextMenu) return false
  const pe = prev.entry
  const ne = next.entry
  if (pe === ne) return true
  if (pe.block_id !== ne.block_id) return false
  if (pe.finalized !== ne.finalized) return false
  if (pe.partial !== ne.partial) return false
  if (pe.partialReason !== ne.partialReason) return false
  if (pe.startedAt !== ne.startedAt) return false
  if (pe.stoppedAt !== ne.stoppedAt) return false
  if (pe.parseError !== ne.parseError) return false
  if (pe.pendingInputJson !== ne.pendingInputJson) return false
  // block 对象本身 — 父组件没 mutate，引用相等即视为内容相等
  return pe.block === ne.block
}

/**
 * 由 dispatcher 拿到的 block.type / kind 信息——decode 出"是否走 fallback"。
 *
 * `dispatcher` 自身按 type 路由，不需要外面手判；该函数仅供单测断言用。
 *
 * **W4c · W4b-P1-1 子项 d 单源契约**：判定集合从 `@tabtin/agent-wire` 的
 * `ALL_BLOCK_TYPE_SET` 派生，与 dispatcher.ts 的 BLOCK_DISPATCH 列表必然
 * 一致——避免老版本"renderer / wire / Django 三处独立维护字符串列表"导致
 * 漏增 case 时 silent fallback。
 */
export function isKnownBlockType(block: ContentBlock | undefined | null): boolean {
  if (!block || typeof block !== 'object' || !('type' in block)) return false
  return ALL_BLOCK_TYPE_SET.has((block as { type: string }).type)
}

/**
 * 流式 input partial JSON 容错解析（W4c · R3-P1-8）。
 *
 * tool_use / mcp_tool_use / server_tool_use 流式期间真实 JSON 在
 * `entry.pendingInputJson` 累积，partial_json 永远是合法 JSON 的前缀但可能
 * 不完整。本函数尝试：
 *   1. 直接 JSON.parse（少数情况下 LLM 已经 yield 完整 JSON 但 stop event
 *      还没到达）
 *   2. 失败则尝试在末尾补 `}` / `}}` / `]` 等闭合符暴力 parse
 *   3. 都失败时返回原始 partial_json 字符串供下游 UI 显示"正在生成参数…"
 *
 * 设计取舍：不引入完整 partial-json 解析器（譬如 anthropic 官方 partial JSON
 * lib），保持极简——成本低 + 解析失败兜底显示原文不会让用户卡住。完整方案
 * 推到 W8 视实测决策。
 */
export function tryParsePartialJson(raw: string | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    const candidates = [raw + '}', raw + '"}', raw + ']', raw + '"]']
    for (const c of candidates) {
      try {
        return JSON.parse(c)
      } catch {
        // continue
      }
    }
    return raw
  }
}

/**
 * partialReason → 用户可见文案的统一映射（W4c · W4a-L12）。
 *
 * 全局共享：所有 BlockRenderer（TextBlockView / ThinkingBlockView /
 * ToolUseBlockView / McpToolBlockView 等）都通过本函数渲染 partial 文案，
 * 保证用户体感一致——不同 block 类型在中断 / 超时 / 截断态下显示**同一**
 * 文案，避免 "text 显示已中断而 thinking/tool 看起来正常完成"的分裂。
 *
 * 三类语义：
 *   - `'stream_interrupted'`：watchdog 路径——daemon 长时间无事件，UI 显示
 *     "等待响应超时"
 *   - `'aborted'`：用户主动 cancel / lifecycle terminated / connection lost
 *     等场景，UI 显示"已中断"
 *   - `'message_stop_fallback'` / undefined：兜底通用文案"…内容被截断"
 */
export function partialReasonText(
  reason: 'stream_interrupted' | 'message_stop_fallback' | 'aborted' | undefined,
  t: (key: string, opts?: { defaultValue: string }) => string,
): string {
  switch (reason) {
    case 'stream_interrupted':
      return t('blockTimeline.partial.streamInterrupted', { defaultValue: '等待响应超时' })
    case 'aborted':
      return t('blockTimeline.partial.aborted', { defaultValue: '已中断' })
    case 'message_stop_fallback':
    default:
      return t('blockTimeline.text.truncated', { defaultValue: '…内容被截断' })
  }
}

/**
 * @deprecated W4c · W4b-P1-1 子项 d：直接使用 `ALL_BLOCK_TYPE_SET`（来自
 * `@tabtin/agent-wire`），本 re-export 仅为不破坏老 import 路径而保留；
 * 任何新代码应直接 `import { ALL_BLOCK_TYPE_SET } from '@tabtin/agent-wire'`。
 */
export const KNOWN_BLOCK_TYPES = ALL_BLOCK_TYPE_SET
