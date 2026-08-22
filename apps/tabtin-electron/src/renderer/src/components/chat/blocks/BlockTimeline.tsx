/**
 * BlockTimeline — Anthropic ContentBlock 时间轴主容器（v2 §3.5.1.b / .i / .j）。
 *
 * **职责**：
 *   1. 接收 `ContentBlockEntry[]`（流式：来自 useContentBlocks；历史：来自
 *      legacyBlocksAdapter），按 index 顺序渲染每个 block
 *   2. 每个 block 通过 dispatcher 路由到 8 家族 BlockRenderer
 *   3. 用 React.memo 包裹，比较口径按 (block_id, finalized, content_hash)——
 *      避免父组件 shallow clone 时全量 re-render，性能基线第 1 项 < 8ms commit
 *   4. ErrorBoundary 在 BlockRenderer 抛错时降级为 FallbackBlockView——保证
 *      单 block 损坏不影响其他 block 渲染
 *   5. **W3（2026-05-26）**：聚合连续 ≥2 个 subagent tool_use block 为
 *      SubagentAggregateView，替代多张 SubagentProgressCard 纵向叠放——
 *      检测在 `groupConsecutiveSubagentBlocks`，渲染单元改为 union
 *      `RenderUnit = single | subagentGroup`，保持原 block 时序不打乱
 *
 * **不在本组件做的事情**（避免职责膨胀）：
 *   - rAF batching：W4a 已在 useChatRuntimeStore.flushRuntimeBatch 实现；
 *     BlockTimeline 接到 props.blocks 时引用已经是 batched 后的 stable snapshot
 *   - collapse 派生（v2 §3.5.1.i collapseConsecutiveReadSearch 等）：
 *     W4b 先不实施 collapse（v2 §3.5.1.i 是 P2 优化），保留扩展位
 *   - 滚动锁：MessageList 层负责（v2 §3.5.1.j），BlockTimeline 不感知滚动
 *
 * **W4a-L39 决策**：assistant message 唯一渲染源——MessageBubble 不再独立
 * 渲染 message.content，BlockTimeline 末尾的 text block 就是 lastMain.content
 * （lite-collector 已合并所有 turn 的 blocks）。
 */

import React, { useCallback, useMemo, useRef } from 'react'
import { ErrorBoundary } from '../../common/ErrorBoundary'
import { FallbackBlockView } from './FallbackBlockView'
import { getBlockRenderer } from './dispatcher'
import {
  AGGREGATE_THRESHOLD,
  SubagentAggregateView,
} from '../subagent/SubagentAggregateView'
import { CollapsibleToolCardGroup } from '../tool/CollapsibleToolCardGroup'
import { TOOL_CARD_GROUP } from '../registry/chatDesignTokens'
import { getToolDescriptor } from '../registry/toolCardRegistry'
import { useSubagentRuns } from '../subagent/useSubagentRuns'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useTodoTimeline } from '@stores/chat/presentation/useTodoTimeline'
import { useSessionBlocksRecord } from '@stores/chat/messages/messageBlocks'
import { useTurnEndLayout } from '../viewport/TurnEndLayoutContext'
import {
  SUBAGENT_TOOL_NAMES,
  classifySubagentToolInput,
  getSubagentCheckId,
  isSubagentDispatchInput,
} from './subagentToolNames'
import { isPanelOnlyTool } from './compactInlineTools'
import { tryParsePartialJson } from './types'
import {
  parseSubagentCheckPresentation,
  type SubagentCheckStatus,
} from './toolUseBlockViewLogic'
import {
  SubagentCheckStatusRow,
  type SubagentCheckDisplayItem,
} from './SubagentCheckStatusRow'
import {
  pairToolResultsByBlock,
  type SemanticBlock,
} from '../../../stores/chat/messages/utils/contentBlockSemantics'
import type { BlockRendererProps, ContentBlockEntry, SiblingToolResult } from './types'
import type { SubagentRun, ToolPresentation } from '../../../stores/chat/shared/types'
import {
  registerBlockTimelineRenderer,
  type BlockTimelineRendererProps,
} from '../message/blockTimelineRendererRegistry'

export type BlockTimelineProps = BlockTimelineRendererProps

/**
 * 单个 entry 的 memoized 渲染单元——以 entry 引用 + finalized 双判等
 * （父组件 BlockTimeline 不变更 entry 引用即不 re-render，性能基线必要）。
 */
const BlockTimelineItem: React.FC<{
  entry: ContentBlockEntry
  sessionId: string | null
  tabScopeKey?: string | null
  subagentRunSessionId?: string | null
  ownerRunId?: string
  messageId: string
  siblingToolResult?: SiblingToolResult
  isLastAssistantMsg?: boolean
  isStreaming?: boolean
  suppressPartialReason?: boolean
  suppressInlineLoading?: boolean
  onResourceNavigate?: BlockRendererProps['onResourceNavigate']
  onResourceContextMenu?: BlockRendererProps['onResourceContextMenu']
}> = React.memo(
  ({ entry, sessionId, tabScopeKey, subagentRunSessionId, ownerRunId, messageId, siblingToolResult, isLastAssistantMsg, isStreaming, suppressPartialReason, suppressInlineLoading, onResourceNavigate, onResourceContextMenu }) => {
    const block = entry.block as { type?: string } | null
    const blockType = block?.type
    const Renderer = getBlockRenderer(blockType)
    return (
      <ErrorBoundary
        resetKeys={[entry.block_id, entry.finalized]}
        fallback={<FallbackBlockView blockType={blockType} error="render-error" />}
      >
        <Renderer
          entry={entry}
          sessionId={sessionId}
          tabScopeKey={tabScopeKey}
          subagentRunSessionId={subagentRunSessionId}
          ownerRunId={ownerRunId}
          messageId={messageId}
          siblingToolResult={siblingToolResult}
          isLastAssistantMsg={isLastAssistantMsg}
          isStreaming={isStreaming}
          suppressPartialReason={suppressPartialReason}
          suppressInlineLoading={suppressInlineLoading}
          onResourceNavigate={onResourceNavigate}
          onResourceContextMenu={onResourceContextMenu}
        />
      </ErrorBoundary>
    )
  },
  (prev, next) => {
    if (prev === next) return true
    if (prev.entry !== next.entry) return false
    if (prev.sessionId !== next.sessionId) return false
    if (prev.tabScopeKey !== next.tabScopeKey) return false
    if (prev.subagentRunSessionId !== next.subagentRunSessionId) return false
    if (prev.ownerRunId !== next.ownerRunId) return false
    if (prev.messageId !== next.messageId) return false
    if (prev.siblingToolResult !== next.siblingToolResult) return false
    if (prev.isLastAssistantMsg !== next.isLastAssistantMsg) return false
    if (prev.isStreaming !== next.isStreaming) return false
    if (prev.suppressPartialReason !== next.suppressPartialReason) return false
    if (prev.suppressInlineLoading !== next.suppressInlineLoading) return false
    if (prev.onResourceNavigate !== next.onResourceNavigate) return false
    if (prev.onResourceContextMenu !== next.onResourceContextMenu) return false
    return true
  },
)
BlockTimelineItem.displayName = 'BlockTimelineItem'

/* ─── W3 聚合检测 ─────────────────────────────────────────────────────── */

/**
 * 渲染单元 union——把"单 block"和"连续 subagent block 组"两种渲染形态
 * 抹平到同一序列，让最外层 map 仍按时序输出，不打乱原 block 顺序。
 *
 * - `kind: 'single'`：普通 block，走 BlockTimelineItem（dispatcher 路由）
 * - `kind: 'subagentGroup'`：连续的 subagent tool_use
 *   block，走 SubagentAggregateGroup（内嵌 useSubagentRuns + AggregateView）
 *
 * 设计取舍：组内 entries 引用一并存进 unit，让 group key 稳定可派生（取首
 * block_id 作 key），避免每帧重新 group 时 React reconciler 失误。
 */
type RenderUnit =
  | { kind: 'single'; entry: ContentBlockEntry }
  | { kind: 'subagentGroup'; entries: ContentBlockEntry[] }
  | { kind: 'subagentCheckGroup'; entries: ContentBlockEntry[] }
  | { kind: 'toolGroup'; entries: ContentBlockEntry[] }

/**
 * 连续步骤折叠阈值：超过此数量（即 ≥4 个）的连续步骤（普通工具卡 + 思考）
 * 自动收进 CollapsibleToolCardGroup（完全折叠 / 完全展开两态），避免长任务
 * 十几张卡刷屏；实时与历史数据一致生效。subagent 卡走 SubagentAggregateView
 * 单独聚合，不在此列。阈值见 `TOOL_CARD_GROUP.collapseThreshold`（当前 3，即 ≥4 步收起）。
 */

/**
 * 判定单个 entry 是否为 subagent **派发** tool_use block（已 finalized 或仍流式都算）。
 *
 * 检测口径：block.type === 'tool_use' && SUBAGENT_TOOL_NAMES 命中 name **且**
 * input 是派发/续跑意图（查询与等待都不是派发，见 isSubagentDispatchInput）。
 * 流式期间 name 已经定下来（content_block_start 一次性给），不会随后变更，
 * 所以 finalize 前已能正确分组——避免子 Agent 刚启动就闪屏切换聚合 vs 单
 * 卡视图。input 流式期在 pendingInputJson，与 extractSubagentTaskFromBlock 同口径解析。
 *
 * ：`check_agent_id` 纯状态查询不算派发块；后台等待协议：
 * `wait_agent_ids` 只挂起父 run，也不创建子 run。两者都不能进入聚合卡。
 */
function getSubagentBlockInput(entry: ContentBlockEntry): unknown {
  const block = entry.block as { input?: unknown } | null
  let input: unknown = block?.input
  if (!entry.finalized && entry.pendingInputJson && entry.pendingInputJson.length > 0) {
    input = tryParsePartialJson(entry.pendingInputJson)
  }
  return input
}

function isSubagentToolEntry(entry: ContentBlockEntry): boolean {
  const block = entry.block as { type?: string; name?: string; input?: unknown } | null
  if (!block || block.type !== 'tool_use') return false
  return typeof block.name === 'string' && SUBAGENT_TOOL_NAMES.has(block.name)
}

function isSubagentBlockEntry(entry: ContentBlockEntry): boolean {
  return isSubagentToolEntry(entry) && isSubagentDispatchInput(getSubagentBlockInput(entry))
}

function isSubagentCheckBlockEntry(entry: ContentBlockEntry): boolean {
  return isSubagentToolEntry(entry)
    && classifySubagentToolInput(getSubagentBlockInput(entry)) === 'check'
}

function collectConsecutiveCheckEntries(
  blocks: readonly ContentBlockEntry[],
  start: number,
  isInert: (entry: ContentBlockEntry) => boolean,
): { entries: ContentBlockEntry[]; nextIndex: number } {
  const entries = [blocks[start]]
  let nextIndex = start + 1
  while (nextIndex < blocks.length) {
    if (isSubagentCheckBlockEntry(blocks[nextIndex])) {
      entries.push(blocks[nextIndex])
      nextIndex++
      continue
    }
    if (isInert(blocks[nextIndex])) {
      nextIndex++
      continue
    }
    break
  }
  return { entries, nextIndex }
}

/**
 * 把 entries 数组聚合成 RenderUnit[]；每段连续 subagent tool_use 都从第一张卡起
 * 进入同一个 subagentGroup，后续追加不替换已挂载的首卡子树。
 *
 * **关键不变量**（W3 北极星）：聚合**绝不**改变非 subagent block 的相对
 * 位置——譬如 `[text, agent, agent, text2, agent]` 应聚出
 * `[single(text), group(agent,agent), single(text2), single(agent)]`，
 * text2 仍在两组 agent 之间，最后那个孤立 agent 走单卡渲染。
 *
 * **"连续"判定**：纯位置连续（同一 entries 数组中相邻 index）。同一 messageId
 * 内的 entries 是由 useContentBlocks 按 index 升序给出的，所以位置连续等价
 * 于"父 LLM 在一轮 assistant message 里连发的几个 task 工具调用"——这与
 * D4 ASCII 图"主 Agent 一次性派 N 个子 Agent 并行"的真实场景一致。
 *
 * 跨 messageId 的连续不在本函数考虑：BlockTimeline 接收的 blocks 始终来自
 * 同一 messageId，所以"跨 message 连续 subagent"在数据层根本不会出现在
 * 同一 BlockTimeline 实例内。
 *
 * 导出供单测断言（聚合逻辑的正确性是 W3 北极星 #2，必须可独立验证）。
 */
export function groupConsecutiveSubagentBlocks(
  blocks: readonly ContentBlockEntry[],
  isInert: (entry: ContentBlockEntry) => boolean = isInertResultEntry,
  stabilizeSingleSubagent = false,
): RenderUnit[] {
  const units: RenderUnit[] = []
  let i = 0
  const n = blocks.length
  while (i < n) {
    const entry = blocks[i]
    if (isSubagentCheckBlockEntry(entry)) {
      const { entries: groupEntries, nextIndex } =
        collectConsecutiveCheckEntries(blocks, i, isInert)
      if (groupEntries.length > 1) {
        units.push({ kind: 'subagentCheckGroup', entries: groupEntries })
      } else {
        units.push({ kind: 'single', entry })
      }
      i = nextIndex
      continue
    }
    if (!isSubagentBlockEntry(entry)) {
      units.push({ kind: 'single', entry })
      i++
      continue
    }
    // 起一个 subagent 连续段——往后扫，只收 subagent tool_use 块。
    //
    // 关键修复（子代理串进主时间线根因）：连续段里夹杂的 `tool_result` 是惰性块
    // （ToolResultBlockView 渲染为 null，仅被 buildSiblingToolResultMap 按 tool_use_id
    // 消费），**不打断连续段、也不计入聚合组 entries**——与第二趟 collapse
    // 的 isInertResultEntry 同口径。否则块级时间线物化让 tool_result 紧贴各
    // tool_use（[agent,result,agent,result,…]）时，subagent tool_use 不再位置相邻，
    // 聚合卡碎裂、子代理产物散进主流。结果块不混入 entries 还能避免被
    // SubagentAggregateGroup.toolCallEntries 误按 block_id 当成一个 toolCall。
    const groupEntries: ContentBlockEntry[] = [entry]
    let j = i + 1
    while (j < n) {
      if (isSubagentBlockEntry(blocks[j])) {
        groupEntries.push(blocks[j])
        j++
        continue
      }
      if (isInert(blocks[j])) {
        j++
        continue
      }
      break
    }
    // 历史单子代理仍走 `SubagentBlockEntry`：它负责 archive reconcile。只有
    // 当前流式末条的首卡提前进聚合容器，第二张到达时才能只追加行、不替换子树。
    if (groupEntries.length >= AGGREGATE_THRESHOLD || stabilizeSingleSubagent) {
      units.push({ kind: 'subagentGroup', entries: groupEntries })
    } else {
      for (const groupEntry of groupEntries) {
        units.push({ kind: 'single', entry: groupEntry })
      }
    }
    i = j
  }
  return units
}

/**
 * 计入折叠数量的「连续步骤」——普通工具卡（`tool_use` / `mcp_tool_use` 且非
 * subagent）**或思考块**（thinking / redacted_thinking）。
 *
 * 思考也算入连续段：真实 / 历史对话里 Agent 常「思考→调工具→再思考→再调」
 * 交错，若思考打断连续段就凑不够阈值、长任务仍刷屏。
 *
 * subagent 卡不在此列——已由 groupConsecutiveSubagentBlocks 单独聚合。
 */
function isCollapsibleStepEntry(entry: ContentBlockEntry): boolean {
  const block = entry.block as { type?: string; name?: string } | null
  if (!block) return false
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return true
  if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
    if (typeof block.name === 'string' && SUBAGENT_TOOL_NAMES.has(block.name)) return false
    // ：panel-only 工具（todo）不是「步骤」——非 anchor 的渲染为 null、
    // anchor 渲染为独立的待办完成卡，二者都不应被折叠进「N 个步骤」组。
    if (typeof block.name === 'string' && isPanelOnlyTool(block.name)) return false
    return true
  }
  return false
}

/**
 * 应留在主时间线的工具结果。
 *
 * 文件修改对比是本轮交付结果，不属于可被「执行详情」收纳的过程步骤。使用注册表
 * renderer 能力识别，避免在时间线里重复维护 edit_file / apply_patch 等工具名。
 */
export function isPrimaryToolOutcomeEntry(
  entry: ContentBlockEntry,
  presentation?: ToolPresentation,
): boolean {
  const block = entry.block as { type?: string; name?: string } | null
  if (
    (block?.type !== 'tool_use' && block?.type !== 'mcp_tool_use')
    || typeof block.name !== 'string'
  ) return false
  return getToolDescriptor(block.name)?.renderer === 'DiffCard'
    || presentation?.kind === 'media_image_generation'
}

/**
 * 折叠摘要「N 个步骤」的**可见步数**——思考块 + 一次工具调用都算一步。
 *
 * 明确**不计**：
 *   - 结果块（tool_result / mcp_tool_result）：结果是工具调用的一部分，且以
 *     null 子节点混在 children 里，按 children 数会与 tool_use 重复计（ live 修）。
 *
 * 这里刻意复用 `isCollapsibleStepEntry`：用户看到的是「思考 + 工具调用」这一串
 * 相邻执行步骤，而不是只看到工具调用次数。
 */
function countVisibleSteps(entries: readonly ContentBlockEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (isCollapsibleStepEntry(entry)) count++
  }
  return count
}

function hasThinkingStep(entries: readonly ContentBlockEntry[]): boolean {
  return entries.some((entry) => {
    const block = entry.block as { type?: string } | null
    return block?.type === 'thinking' || block?.type === 'redacted_thinking'
  })
}

/**
 * 连续段里的「惰性块」——`tool_result` / `mcp_tool_result` / 空 text：
 * **不打断连续段、也不计入卡片数**。
 *
 * 关键修复（历史折叠失效根因）：历史回放经 adaptLegacyBlocksToContentBlocks
 * 把 content_blocks_json 还原成 ContentBlockEntry[]，其中每个 tool_use 后紧跟
 * 它的 tool_result，二者在 blocks 数组里交错。结果块本身只是 sibling 数据
 * （由对应工具卡消费），若把它当「非步骤」就会割裂工具卡连续段、导致历史
 * 数据永远凑不够阈值。故让结果块被连续段「吸入」但不参与计数。
 */
function isInertResultEntry(entry: ContentBlockEntry): boolean {
  const block = entry.block as { type?: string; text?: string } | null
  if (
    block?.type === 'tool_result'
    || block?.type === 'mcp_tool_result'
    || block?.type === 'web_search_tool_result'
  ) return true
  return block?.type === 'text' && !block.text?.trim()
}

/**
 * 第二趟分组：在 subagent 聚合产出的 units 上，把**连续**的普通工具卡 single
 * 单元（> TOOL_CARD_GROUP.collapseThreshold 个）折叠成一个 toolGroup。
 *
 * 关键不变量：只合并相邻的 `single + 普通工具卡`，任何非工具卡单元（text /
 * thinking / subagentGroup / tool_result 等）都会打断连续段——保持原时序，
 * 不把跨越叙述文本的工具卡硬凑到一起。
 *
 * **总是成组**：连续的「可折叠步骤 + 惰性结果块」一律归入同一个 `toolGroup`
 * 单元（成员只增不减、key = 组首 block_id 稳定）。是否显示组头、折叠时是否露出
 * 最后一条（进行中尾步），都由 `CollapsibleToolCardGroup` 按 `count`/`activeTailId`
 * 决定——**不再**用「> 阈值才建组」或「把尾步拎到组外平铺」来改变结构。
 *
 * 这样追加新 block / 尾步 settle 时，前面的工具卡**不换父节点、不 remount**，
 * 折叠状态与渲染都被隔离（ 家族：结构稳定化）。
 *
 * 导出供单测断言。
 */
export function collapseConsecutiveToolCards(
  units: RenderUnit[],
  isInert: (entry: ContentBlockEntry) => boolean = isInertResultEntry,
  isPrimaryOutcome: (entry: ContentBlockEntry) => boolean = isPrimaryToolOutcomeEntry,
): RenderUnit[] {
  const out: RenderUnit[] = []
  let i = 0
  const n = units.length
  while (i < n) {
    const u = units[i]
    // DiffCard 是本轮交付结果，作为独立卡片留在主时间线；其余连续执行步骤才进入
    // 「执行详情」。结果卡同时充当分组边界，避免两侧步骤被跨结果合并。
    if (
      u.kind !== 'single'
      || !isCollapsibleStepEntry(u.entry)
      || isPrimaryOutcome(u.entry)
    ) {
      out.push(u)
      i++
      continue
    }
    // 向后吸入连续的「步骤 + 惰性结果块」，全部归入一个组（成员 append-only）。
    let j = i + 1
    const entries: ContentBlockEntry[] = [u.entry]
    while (j < n) {
      const next = units[j]
      if (next.kind !== 'single') break
      if (isPrimaryOutcome(next.entry)) break
      if (isCollapsibleStepEntry(next.entry) || isInert(next.entry)) {
        entries.push(next.entry)
        j++
        continue
      }
      break
    }
    out.push({ kind: 'toolGroup', entries })
    i = j
  }
  return out
}

// tool_use↔tool_result 的 FIFO 配对收敛到统一 contentBlockSemantics；这里只做
// ContentBlockEntry（外层 block_id + 内层 block）→ SemanticBlock 的形态适配。
function buildSiblingToolResultByBlockId(
  blocks: readonly ContentBlockEntry[],
): Map<string, SiblingToolResult> {
  const semantic = blocks.map((e) => ({
    ...(e.block as Record<string, unknown>),
    block_id: e.block_id,
  })) as SemanticBlock[]
  return pairToolResultsByBlock(semantic) as Map<string, SiblingToolResult>
}

function toolUseIdsWithSiblingResults(blocks: readonly ContentBlockEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const candidate of blocks) {
    const candidateBlock = candidate.block as { type?: string; tool_use_id?: string } | null
    if (
      (
        candidateBlock?.type === 'tool_result'
        || candidateBlock?.type === 'mcp_tool_result'
        || candidateBlock?.type === 'web_search_tool_result'
      )
      && typeof candidateBlock.tool_use_id === 'string'
    ) {
      ids.add(candidateBlock.tool_use_id)
    }
  }
  return ids
}

// daemon `appendSubagentId` 往配对 tool_result 尾部写 `[子 Agent ID: <uuid>]` —— 见
// extractSubagentRunIdFromResult（matchSubagentRuns.ts）。

/**
 * 聚合组的内嵌渲染组件——单独抽出隔离 hooks 链路（useSubagentRuns 是 zustand
 * useShallow selector，每个 group 实例独立订阅自己的 toolCallIds，避免顶层
 * BlockTimeline 增加 selector 复杂度 + 让 group 数变化时 hooks 顺序违规）。
 *
 * 数据流：
 *   1. entries → tool_use block.id 数组（= 父 LLM 给的 toolu_xxx）
 *   2. useSubagentRuns 按 toolCallIds 反查到真实 SubagentRun[]（按入参顺序）
 *   3. displayRuns：真实 run + 实时窗口下的乐观占位（见下方 live-window 注释）
 *   4. cancelSubagentRun 直接从 store 取——SubagentAggregateView 内部循环
 *      cancel cancellable runs（已排除乐观占位行）
 *
 * **runs 缺失处理**（2026-05-29 起，「连接中闪烁」根治后）：
 *   - **实时窗口**（block 流式中，或当前流式 message）：反查不到的 toolCallId
 *     用 tool_use(agent) 块本地合成乐观占位行（status='pending' / 「启动中」），
 *     列表第一帧就齐全，不再走 skeleton —— 消除整行替换闪烁。
 *   - **非实时窗口**（历史回看 / reload 后 subagents.jsonl 未 reconcile）：
 *     缺位不合成乐观行，交给 SubagentAggregateView 的 skeleton 兜底（reconcile
 *     到达即填真行）——避免把「store 暂时没数据」误显成活跃的「启动中」。
 */
/**
 * 从 tool_use(agent) block 提取任务摘要——与单卡 `ToolUseBlockView.effectiveInput`
 * 同口径：流式期（未 finalize）读 `pendingInputJson` 的 partial JSON，finalize
 * 后读 `block.input`。让乐观占位行在流式头几帧就能显示任务描述，而不是只剩
 * 一截 cryptic id（tool call 一出现就有 task 标题）。
 *
 * `prompt` → 子任务正文（task）；`description` → 简短标签（label）。与
 * agent-tool.ts emit SUBAGENT_STARTED 时的 task/label 字段同源，保证乐观
 * 占位与真实 run 顶替时文案连续。
 */
function extractSubagentTaskFromBlock(
  entry: ContentBlockEntry | undefined,
): { task?: string; label?: string; model?: string; background?: boolean } {
  if (!entry) return {}
  let input: unknown = (entry.block as { input?: unknown } | null)?.input
  if (!entry.finalized && entry.pendingInputJson && entry.pendingInputJson.length > 0) {
    input = tryParsePartialJson(entry.pendingInputJson)
  }
  if (!input || typeof input !== 'object') return {}
  const rec = input as Record<string, unknown>
  const task = typeof rec.prompt === 'string' && rec.prompt.length > 0 ? rec.prompt : undefined
  const label = typeof rec.description === 'string' && rec.description.length > 0 ? rec.description : undefined
  const model = typeof rec.model === 'string' && rec.model.length > 0 ? rec.model : undefined
  const background = rec.background === true || rec.run_in_background === true
  return { task, label, model, background }
}

const SubagentAggregateGroup: React.FC<{
  entries: readonly ContentBlockEntry[]
  sessionId: string | null
  /** 子 Agent run 反查 session（缺省 = sessionId）——见 BlockTimelineProps.subagentRunSessionId */
  runSessionId?: string | null
  /** 父级透传：会话是否流式中（乐观占位的「实时窗口」门禁之一） */
  isStreaming?: boolean
  /** 父级透传：是否最后一条 assistant message（乐观占位门禁之二） */
  isLastAssistantMsg?: boolean
  /** 本 message 的 owner（subagent_run_id）——live 反查按此作用域，避开 parentToolCallId 跨 owner 撞车。 */
  ownerRunId?: string
}> = React.memo(({ entries, sessionId, runSessionId, isStreaming, isLastAssistantMsg, ownerRunId }) => {
  // toolCallEntries: 保留 (block.id, entry) 配对——顺序与 entries 物理顺序严格一致。
  const toolCallEntries = useMemo(
    () => entries
      .map((e) => ({ id: (e.block as { id?: string } | null)?.id ?? e.block_id, entry: e }))
      .filter((t): t is { id: string; entry: ContentBlockEntry } =>
        typeof t.id === 'string' && t.id.length > 0),
    [entries],
  )

  // 反查键用父 tool_use id：同一个子 Agent 会话可被 resume 多次，childId 是会话身份，
  // 不是某次派活运行身份。parentToolCallId 结合 ownerRunId 才能稳定定位当前卡片。
  const resolvedEntries = useMemo(
    () => toolCallEntries.map(({ id, entry }) => ({ blockId: id, lookupId: id, entry })),
    [toolCallEntries],
  )
  const lookupIds = useMemo(() => resolvedEntries.map((r) => r.lookupId), [resolvedEntries])

  // 反查 run 用 runSessionId（子详情面板=真实父 session）；缺省退化 sessionId。
  // ownerRunId 作用域：按 parentToolCallId 反查时靠它避开嵌套子 Agent 的 agent_0 撞名。
  const realRuns = useSubagentRuns(runSessionId ?? sessionId, lookupIds, ownerRunId)
  const cancelSubagentRun = useChatRuntimeStore((s) => s.cancelSubagentRun)

  // ── 乐观补行（2026-05-29 dogfood「连接中闪烁」根治）──────────────────
  //
  // 旧实现：runs = realRuns（反查窗口期 < entries.length），列表用 skeleton
  // 「连接中…」骨架行补足——后端 SUBAGENT_STARTED relay 回来才整行替换成
  // 真行，制造 ~1s 闪烁。根因是「行的存在」被绑死在后端事件上，而非主流里
  // 实时可见的 tool_use(agent) 块。
  //
  // 新实现：对反查不到的 toolCallId，本地用 tool_use(agent) 块合成乐观占位
  // run（status='pending' / 「启动中」+ 任务摘要），让列表第一帧就齐全。锚点
  // = parentToolCallId（= toolCallId），SUBAGENT_STARTED 到达后 realRuns 命
  // 中同锚点顶替占位；SubagentAggregateView 行 key 绑锚点保持稳定不 remount。
  // 与单卡 SubagentBlockEntry 已有的乐观范式一致：tool call 即建卡。
  //
  // **live-window 门禁（三视角 review P0 修复）**：乐观占位**只在实时窗口**合成
  // ——即 block 还在流式（未 finalize），或这是当前正在产出的 message
  // （isStreaming && isLastAssistantMsg）。否则（历史回看 / reload 后 archive
  // 尚未 reconcile / store 被 200 截断 / 详情面板孙 run 永久 miss）**不合成**，
  // 把缺位交给 skeleton 兜底（reconcile 到达即填真行）——避免把「store 暂时
  // 没数据」诚实性地误显成活跃的「启动中」转圈（比旧 skeleton 更 lie）。单卡
  // SubagentBlockEntry 同款门禁：finalize 且非实时窗口走 'unknown'（状态同步中）。
  const liveWindow = !!isStreaming && !!isLastAssistantMsg
  const displayRuns = useMemo<SubagentRun[]>(() => {
    const bySubagentRunId = new Map<string, SubagentRun>()
    const parentQueues = new Map<string, SubagentRun[]>()
    for (const r of realRuns) {
      bySubagentRunId.set(r.subagentRunId, r)
      if (r.parentToolCallId) {
        const q = parentQueues.get(r.parentToolCallId) ?? []
        q.push(r)
        parentQueues.set(r.parentToolCallId, q)
      }
    }
    const parentCursor = new Map<string, number>()
    const out: SubagentRun[] = []
    for (const { blockId, lookupId, entry } of resolvedEntries) {
      let real = bySubagentRunId.get(lookupId)
      if (!real) {
        const q = parentQueues.get(blockId)
        if (q) {
          const idx = parentCursor.get(blockId) ?? 0
          if (idx < q.length) {
            real = q[idx]
            parentCursor.set(blockId, idx + 1)
          }
        }
      }
      const { task, label, model, background } = extractSubagentTaskFromBlock(entry)
      if (real) {
        out.push(background === true && real.background !== true
          ? { ...real, background: true }
          : real)
        continue
      }
      // store-miss：仅实时窗口（block 未 finalize，或当前流式 message）才乐观补行；
      // 历史 / 终态 store-miss 跳过 → 由下方 expectedCount 驱动 skeleton 兜底。
      const inLiveWindow = !entry.finalized || liveWindow
      if (!inLiveWindow) continue
      out.push({
        subagentRunId: blockId,
        parentToolCallId: blockId,
        status: 'pending',
        isOptimistic: true,
        ...(background ? { background: true } : {}),
        ...(task ? { task } : {}),
        ...(label ? { label } : {}),
        ...(model ? { model } : {}),
      })
    }
    return out
  }, [realRuns, resolvedEntries, liveWindow])

  return (
    <div className="my-1.5" data-testid="block-subagent-aggregate">
      <SubagentAggregateView
        // 用 runSessionId（真实父 session）：drill-in 的 SubagentInlineDetail 据此
        // 反查孙 Agent run + transcript；主对话场景 runSessionId === sessionId 不变。
        sessionId={runSessionId ?? sessionId}
        runs={displayRuns}
        onCancel={cancelSubagentRun}
        // expectedCount 仍透传：实时窗口下 displayRuns 已乐观补齐（skeletonCount=0，
        // 「连接中…」不触发）；非实时窗口 store-miss 时 displayRuns < expectedCount，
        // 由 skeleton 兜底显示 loading，等 reconcile 填真行（历史诚实性）。
        expectedCount={toolCallEntries.length}
      />
    </div>
  )
})
SubagentAggregateGroup.displayName = 'SubagentAggregateGroup'

function readCheckPresentation(
  presentation: SiblingToolResult['presentation'] | undefined,
): { childId: string | null; label?: string; status?: SubagentCheckStatus } {
  return parseSubagentCheckPresentation(presentation)
}

function checkItemFromPresentation(
  presented: ReturnType<typeof readCheckPresentation>,
  fallbackChildId: string | null,
): SubagentCheckDisplayItem {
  return {
    childId: presented.childId ?? fallbackChildId,
    ...(presented.label ? { label: presented.label } : {}),
    ...(presented.status ? { status: presented.status } : {}),
  }
}

function isSettledCheck(
  sibling: SiblingToolResult | undefined,
  eventPhase: 'start' | 'end' | 'error' | undefined,
): boolean {
  return sibling != null || eventPhase === 'end' || eventPhase === 'error'
}

function buildSubagentCheckSnapshot(
  entry: ContentBlockEntry,
  siblingToolResultsByBlockId: Map<string, SiblingToolResult>,
  eventsById: Map<string, {
    phase: 'start' | 'end' | 'error'
    presentation?: SiblingToolResult['presentation']
  }>,
): { item: SubagentCheckDisplayItem; settled: boolean; hasError: boolean } {
  const block = entry.block as { id?: string } | null
  const toolCallId = block?.id ?? entry.block_id
  const sibling = siblingToolResultsByBlockId.get(entry.block_id)
  const event = eventsById.get(toolCallId)
  const presented = readCheckPresentation(sibling?.presentation ?? event?.presentation)
  return {
    item: checkItemFromPresentation(
      presented,
      getSubagentCheckId(getSubagentBlockInput(entry)),
    ),
    settled: isSettledCheck(sibling, event?.phase),
    hasError: sibling?.isError === true || event?.phase === 'error',
  }
}

const SubagentCheckGroup: React.FC<{
  entries: readonly ContentBlockEntry[]
  sessionId: string | null
  siblingToolResultsByBlockId: Map<string, SiblingToolResult>
}> = React.memo(({ entries, sessionId, siblingToolResultsByBlockId }) => {
  const sessionBlocksRecord = useSessionBlocksRecord(sessionId)
  const historicalSiblingResults = useMemo(
    () => buildSiblingToolResultByBlockId(
      Object.values(sessionBlocksRecord ?? {}).flat(),
    ),
    [sessionBlocksRecord],
  )
  const resolvedSiblingResults = useMemo(() => {
    if (historicalSiblingResults.size === 0) return siblingToolResultsByBlockId
    return new Map([...historicalSiblingResults, ...siblingToolResultsByBlockId])
  }, [historicalSiblingResults, siblingToolResultsByBlockId])
  const toolEvents = useChatRuntimeStore((state) =>
    sessionId ? state.toolEventsBySessionId[sessionId] : undefined,
  )
  const eventsById = useMemo(
    () => new Map((toolEvents ?? []).map((event) => [event.id, event])),
    [toolEvents],
  )
  const snapshots = useMemo(
    () => entries.map((entry) =>
      buildSubagentCheckSnapshot(entry, resolvedSiblingResults, eventsById)),
    [entries, eventsById, resolvedSiblingResults],
  )
  const visibleSnapshots = useMemo(
    () => snapshots.filter((snapshot) => snapshot.item.status !== 'already_checked'),
    [snapshots],
  )

  return (
    <SubagentCheckStatusRow
      items={visibleSnapshots.map((snapshot) => snapshot.item)}
      isChecking={visibleSnapshots.some((snapshot) => !snapshot.settled)}
      hasError={visibleSnapshots.some((snapshot) => snapshot.hasError)}
    />
  )
})
SubagentCheckGroup.displayName = 'SubagentCheckGroup'

export const BlockTimeline: React.FC<BlockTimelineProps> = React.memo(
  function BlockTimeline(props) {
    return (
      <ErrorBoundary
        resetKeys={[props.messageId, props.blocks]}
        fallback={<FallbackBlockView error="timeline-render-error" />}
      >
        <BlockTimelineInner {...props} />
      </ErrorBoundary>
    )
  },
)
BlockTimeline.displayName = 'BlockTimeline'

const BlockTimelineInner: React.FC<BlockTimelineProps> = React.memo(
  function BlockTimelineInner({ blocks, sessionId, tabScopeKey = null, subagentRunSessionId, ownerRunId, messageId, isLastAssistantMsg, isStreaming, suppressPartialReason, suppressInlineLoading, onResourceNavigate, onResourceContextMenu }) {
    const { shouldHoldThinkingPreviewBudget } = useTurnEndLayout()
    // 引用稳定化（渲染隔离）：每次 commit 都会重建整个 Map + 新的 {content,isError}
    // 对象，会击穿 BlockTimelineItem / SubagentAggregateGroup 的引用相等 memo，让未变
    // 工具卡也重渲染。这里按 block_id 与上轮逐条比对，未变的**复用旧对象引用**；整表
    // 无变化时连 Map 引用一起复用——追加新 block 不再连带重渲染前面的工具卡。
    const prevSiblingResultsRef = useRef<Map<string, SiblingToolResult>>(new Map())
    const siblingToolResultsByBlockId = useMemo(() => {
      const next = buildSiblingToolResultByBlockId(blocks ?? [])
      const prev = prevSiblingResultsRef.current
      let changed = next.size !== prev.size
      const stable = new Map<string, SiblingToolResult>()
      for (const [id, val] of next) {
        const old = prev.get(id)
        if (
          old
          && old.isError === val.isError
          && old.content === val.content
          && old.presentation === val.presentation
        ) {
          stable.set(id, old)
        } else {
          stable.set(id, val)
          changed = true
        }
      }
      const result = changed ? stable : prev
      prevSiblingResultsRef.current = result
      return result
    }, [blocks])
    const toolUseIdsWithResults = useMemo(
      () => toolUseIdsWithSiblingResults(blocks ?? []),
      [blocks],
    )

    // 本 session 已进入终态（拿到结果 / 报错）的工具 id 集合——实时流里工具
    // 完成先经 SYSTEM_NOTICE(tool_completed/failed) 写入 lifecycle event store，
    // 比 user tool_result content block 更早到达，是判定「工具是否拿到结果」的
    // 主来源；与单卡 ToolUseBlockView 的 phase 推导同源，避免组内外完成判定打架。
    const toolEvents = useChatRuntimeStore((s) =>
      sessionId ? s.toolEventsBySessionId[sessionId] : undefined,
    )
    const settledToolIds = useMemo(() => {
      const ids = new Set<string>()
      if (toolEvents) {
        for (const ev of toolEvents) {
          if (ev.phase === 'end' || ev.phase === 'error') ids.add(ev.id)
        }
      }
      return ids
    }, [toolEvents])

    // 步骤「是否已拿到结果」：
    //   - 思考块没有外部结果，finalize（参数流结束）即视为完成
    //   - 工具块需参数流已结束 + lifecycle 终态或已有 sibling 结果块
    const isStepSettled = useCallback(
      (entry: ContentBlockEntry): boolean => {
        const block = entry.block as { type?: string; id?: string } | null
        if (!block) return false
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          return entry.finalized
        }
        if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
          if (!entry.finalized) return false
          const toolId = typeof block.id === 'string' ? block.id : undefined
          if (!toolId) return false
          return settledToolIds.has(toolId) || toolUseIdsWithResults.has(toolId)
        }
        return entry.finalized
      },
      [settledToolIds, toolUseIdsWithResults],
    )

    // 「进行中的末尾步骤」block_id：仅当本 message 是流式产出的最后一条时，取最末
    // 一个步骤——若它仍在执行（未拿到结果）就是要留在折叠组外的活跃尾步骤；否则
    // （已完成 / 末尾是正文 / 历史回放）为空，整段照常折叠。只认末尾这一步，避免
    // 中间步骤结果滞后导致整组被打散。
    const activeTailId = useMemo<string | null>(() => {
      if (!isStreaming || !isLastAssistantMsg) return null
      const arr = blocks ?? []
      for (let k = arr.length - 1; k >= 0; k--) {
        const e = arr[k]
        if (isInertResultEntry(e)) continue
        if (isCollapsibleStepEntry(e)) {
          return isStepSettled(e) ? null : (e.block_id ?? null)
        }
        return null
      }
      return null
    }, [blocks, isStreaming, isLastAssistantMsg, isStepSettled])

    // ：待办完成卡 anchor 集合（从 message.blocks 纯派生）。分组时——
    //   - anchor todo（渲染完成卡）：非惰性 → 打断折叠段、独立成卡可见；
    //   - 非 anchor todo（渲染 null）：视作惰性块 → 吸入折叠段、不打断、不计数，
    //     避免一个隐藏块把周围真实步骤挤出折叠组。
    const todoTimeline = useTodoTimeline(sessionId)
    const isInertEntry = useCallback(
      (entry: ContentBlockEntry): boolean => {
        if (isInertResultEntry(entry)) return true
        const b = entry.block as { type?: string; name?: string; id?: string } | null
        if (b?.type === 'tool_use' && typeof b.name === 'string' && isPanelOnlyTool(b.name)) {
          const id = typeof b.id === 'string' && b.id.length > 0 ? b.id : entry.block_id
          return !todoTimeline.anchorMap.has(id)
        }
        return false
      },
      [todoTimeline],
    )

    // 生图不是普通终端过程：执行中要在回答正文展示生成卡，完成后由正式图片产物
    // 接管。展示语义可能先从 lifecycle 双通道到达，也可能只随 tool_result 历史块
    // 恢复，因此两路都参与判定；不能从 command 文本反推。
    const lifecyclePresentationByToolId = useMemo(() => {
      const byId = new Map<string, ToolPresentation>()
      for (const event of toolEvents ?? []) {
        if (event.presentation) byId.set(event.id, event.presentation)
      }
      return byId
    }, [toolEvents])
    const isPrimaryOutcomeEntry = useCallback(
      (entry: ContentBlockEntry): boolean => {
        const block = entry.block as { id?: string } | null
        const presentation = siblingToolResultsByBlockId.get(entry.block_id)?.presentation
          ?? (typeof block?.id === 'string'
            ? lifecyclePresentationByToolId.get(block.id)
            : undefined)
        return isPrimaryToolOutcomeEntry(entry, presentation)
      },
      [lifecyclePresentationByToolId, siblingToolResultsByBlockId],
    )

    // 聚合检测放 useMemo——blocks 引用稳定（W4a rAF batching 保证）时
    // RenderUnit[] 也稳定，下方 map 的 key/props 不会无故变更。
    const units = useMemo(
      () =>
        collapseConsecutiveToolCards(
          groupConsecutiveSubagentBlocks(
            blocks ?? [],
            isInertEntry,
            !!isStreaming && !!isLastAssistantMsg,
          ),
          isInertEntry,
          isPrimaryOutcomeEntry,
        ),
      [blocks, isInertEntry, isPrimaryOutcomeEntry, isStreaming, isLastAssistantMsg],
    )

    if (!blocks || blocks.length === 0) return null

    return (
      <div className="flex flex-col gap-0.5" data-testid="block-timeline">
        {units.map(
          // RenderUnit 是刻意集中在此处的穷举 dispatcher；分支数随一等展示语义增长。
          // eslint-disable-next-line complexity
          (unit, idx) => {
          if (unit.kind === 'subagentCheckGroup') {
            const firstId = unit.entries[0]?.block_id || `subagent-check-group-${idx}`
            return (
              <SubagentCheckGroup
                key={`subagent-check-group:${firstId}`}
                entries={unit.entries}
                sessionId={sessionId}
                siblingToolResultsByBlockId={siblingToolResultsByBlockId}
              />
            )
          }
          if (unit.kind === 'subagentGroup') {
            // key 取首 entry 的 block_id——组内 entries 顺序不变时 key 稳定
            const firstId = unit.entries[0]?.block_id || `subagent-group-${idx}`
            return (
              <SubagentAggregateGroup
                key={`subagent-group:${firstId}`}
                entries={unit.entries}
                sessionId={sessionId}
                runSessionId={subagentRunSessionId}
                isStreaming={isStreaming}
                isLastAssistantMsg={isLastAssistantMsg}
                ownerRunId={ownerRunId}
              />
            )
          }
          if (unit.kind === 'toolGroup') {
            const firstId = unit.entries[0]?.block_id || `tool-group-${idx}`
            const renderEntry = (entry: ContentBlockEntry) => (
                <BlockTimelineItem
                  key={entry.block_id || `idx-${entry.index}`}
                  entry={entry}
                  sessionId={sessionId}
                  tabScopeKey={tabScopeKey}
                  subagentRunSessionId={subagentRunSessionId}
                  ownerRunId={ownerRunId}
                  messageId={messageId}
                  siblingToolResult={siblingToolResultsByBlockId.get(entry.block_id)}
                  isLastAssistantMsg={isLastAssistantMsg}
                  isStreaming={isStreaming}
                  suppressPartialReason={suppressPartialReason}
                  suppressInlineLoading={suppressInlineLoading}
                  onResourceNavigate={onResourceNavigate}
                  onResourceContextMenu={onResourceContextMenu}
                />
              )
            // 连续工具步永远归入本组（成员 append-only、key 稳定）。组头是否显示、
            // 折叠时是否露出最后一条，由组按 count / activeTail 决定——结构不随流式
            // 重组，前面卡不 remount（ 家族：渲染隔离）。
            // showLastWhenCollapsed：本组末条正是进行中尾步时，折叠也露出它实时可见。
            const lastEntry = unit.entries[unit.entries.length - 1]
            const showLastWhenCollapsed = activeTailId != null && lastEntry?.block_id === activeTailId
            // 实时执行也要立即显示连续折叠组头；活跃尾步由 showLastWhenCollapsed
            // 外露，避免用户看到一串独立的「思考/工具」卡。turn-end 期间只关闭
            // size layout，避免高度动画扰动贴底跟随。
            // 活跃 run：禁 framer size layout，避免高度动画扰动滚动。
            // 不传 holdVisibleSteps——invisible 占位会在折叠后留下等大空白；
            // 高度回收交给 turn-end closing spacer / Thinking 预算。
            // showLastWhenCollapsed 语义不变。
            const disableSizeLayout = !!isLastAssistantMsg && (
              !!isStreaming || shouldHoldThinkingPreviewBudget
            )
            return (
              <CollapsibleToolCardGroup
                key={`tool-group:${firstId}`}
                groupKey={firstId}
                threshold={hasThinkingStep(unit.entries) ? 1 : TOOL_CARD_GROUP.collapseThreshold}
                count={countVisibleSteps(unit.entries)}
                deferCollapse={false}
                showLastWhenCollapsed={showLastWhenCollapsed}
                disableSizeLayout={disableSizeLayout}
              >
                {unit.entries.map(renderEntry)}
              </CollapsibleToolCardGroup>
            )
          }
          const entry = unit.entry
          return (
            <BlockTimelineItem
              key={entry.block_id || `idx-${entry.index}`}
              entry={entry}
              sessionId={sessionId}
              tabScopeKey={tabScopeKey}
              subagentRunSessionId={subagentRunSessionId}
              ownerRunId={ownerRunId}
              messageId={messageId}
              siblingToolResult={siblingToolResultsByBlockId.get(entry.block_id)}
              isLastAssistantMsg={isLastAssistantMsg}
              isStreaming={isStreaming}
              suppressPartialReason={suppressPartialReason}
              suppressInlineLoading={suppressInlineLoading}
              onResourceNavigate={onResourceNavigate}
              onResourceContextMenu={onResourceContextMenu}
            />
          )
          },
        )}
      </div>
    )
  },
)
BlockTimelineInner.displayName = 'BlockTimelineInner'

registerBlockTimelineRenderer(BlockTimeline)
