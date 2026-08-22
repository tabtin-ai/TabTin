/**
 * ToolUseBlockView — v2 §3.5.1.e ToolUseBlockView 二级 dispatcher。
 *
 * **二级 dispatcher 矩阵**（按 block.name 路由到已注册的工具卡片）：
 *
 *   | family | name 模式 | 视觉 |
 *   |---|---|---|
 *   | File Read | read_file / Read / cat | 文件预览（行号 + head/tail） |
 *   | File Edit | edit_file / write_file / Write / delete_file | diff 视图 |
 *   | Terminal | run_terminal_command / bash / Bash / ssh_execute | 终端模拟 |
 *   | Search | grep_search / glob_search / glob / Grep | 路径 + 匹配行 |
 *   | Web | web_search / historical web fetch aliases / 各 server_tool_use | 卡片式 |
 *   | Widget | show_widget 等 | 内嵌 iframe sandbox |
 *   | MCP | mcp_* | 通用 JSON + MCP server 标识 |
 *   | Task | agent / task / Task | SubagentProgressLink |
 *   | Fallback | 其他 | GenericToolCard |
 *
 * **实现策略**：直接复用 `ToolStepCard`——它已经做了 toolCardRegistry +
 * cardRenderers 二级查找，覆盖所有上述 family。BlockTimeline 只负责把
 * `block.input + entry.pendingInputJson` 翻译成 `ToolStepCard` 的 props。
 *
 * **流式输入 UX**（W4a-L5 推迟硬约束）：
 *   - tool_use.input 在 finalize 前是 `{}`；真实流式参数在 entry.pendingInputJson。
 *   - finalize 后 input 已 JSON.parse 进 block.input。
 *   - 本组件优先用 `entry.pendingInputJson` 走 partial parse 显示流式参数；
 *     fallback 到 block.input。
 *
 * **input_parse_error**（v2 §3.5.1.b case 1）：
 *   - entry.parseError 存在时显示"工具调用参数损坏"标签 + 展开看 partial JSON。
 *
 * **Subagent 路由**（v2 §3.5.1.h "Subagent 进度入口"）：
 *   - name ∈ {agent, task, Task} 时跳过 ToolStepCard，直接渲染 SubagentProgressCard
 *     占位（真正的子 timeline 由 ChatPanel 走 subagent_run_id 处理；本 block
 *     视觉上给 user 一个"链接到子 Agent 工作区"卡片）。
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolUseBlock } from '@tabtin/agent-wire'
import { cn } from '@utils/cn'
import { ShinyText } from '../markdown/ShinyText'
import { SubagentAggregateView } from '../subagent/SubagentAggregateView'
// 子 Agent 单卡渲染已统一到 SubagentAggregateView（对话内 step 形态）。
// 但 agentToolCards.ts 仍把 task/agent 映射到 'SubagentProgressCard' 渲染器，
// 且该映射理论上可被 ToolStepCard 的 registry 查找命中（虽主流程在 isSubagent
// 分支提前 return 不会走到）——保留副作用 import 让 registerCardRenderer 注册
// 不丢失，避免未来某条 registry 路径拿到 null。组件本身仍服务 DEV 预览。
import '../subagent/SubagentProgressCard'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useSessionBlocksRecord } from '@stores/chat/messages/messageBlocks'
import { useTodoTimeline } from '@stores/chat/presentation/useTodoTimeline'
import { useSubagentRun } from '../subagent/useSubagentRun'
import type { SubagentRun } from '../../../stores/chat/shared/types'
import { TEXT, TEXT_COLOR, ICON_SIZE, STEP_ROW } from '../registry/chatDesignTokens'
import {
  getCompactSummary,
  getToolIcon,
} from '../registry/toolCardRegistry'
import { getToolDisplayName } from '../registry/toolDisplayName'
import { resolveIcon } from '../registry/iconMap'
import { isCompleteToolInput } from '../tool/toolCollapsedLabel'
import {
  blockEntryEqual,
  tryParsePartialJson,
  type BlockRendererProps,
  type ContentBlockEntry,
  type SiblingToolResult,
} from './types'
import { SUBAGENT_TOOL_NAMES } from './subagentToolNames'
import { ToolUseRoutedView } from './ToolUseRoutedView'

import { deriveToolUseExecutionState } from './deriveToolUseExecutionState'

/**
 * Subagent 工具名集合——同时被 ToolUseBlockView（单 block 渲染走 SubagentBlockEntry）、
 * BlockTimeline（连续多 block 聚合检测走 SubagentAggregateView，W3）共用。
 *
 * 单源已下沉到叶子模块 `./subagentToolNames`（无 React 依赖），这里 re-export
 * 保持既有 `from './ToolUseBlockView'` 引用路径不破。
 */
export { SUBAGENT_TOOL_NAMES }

function findToolResult(
  sessionBlocks: Record<string, ContentBlockEntry[]> | undefined,
  toolCallId: string,
): {
  type?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  presentation?: { kind: string; data?: Record<string, unknown> }
} | undefined {
  if (!sessionBlocks) return undefined
  for (const messageBlocks of Object.values(sessionBlocks)) {
    for (const e of messageBlocks) {
      const blk = e.block as {
        type?: string
        tool_use_id?: string
        content?: unknown
        is_error?: boolean
        presentation?: { kind: string; data?: Record<string, unknown> }
      } | null
      if (blk?.type === 'tool_result' && blk.tool_use_id === toolCallId) {
        return blk
      }
    }
  }
  return undefined
}

/**
 * Compact 单行视图——用于"信息读取/检索类"工具（read / search / list ...）。
 *
 * **W4.5 §step row 视觉统一**：与 ThinkingBlockView 共享同一套 row 规范——
 *   - 容器：`pl-0 pr-2 py-0.5 my-0.5 rounded-md`（同 thinking；左边缘与正文/卡片对齐）
 *   - 字号：`TEXT.body`（同 thinking；之前用 meta 字号造成两套 step 大小不一）
 *   - icon 颜色：`TEXT_COLOR.faint`（同 thinking 去掉 accent 后的统一灰）
 *   - 动词：`TEXT_COLOR.secondary`，摘要：`TEXT_COLOR.faint`
 * 视觉效果跟紧凑 step 列表一致——所有 step 同字号、
 * 同颜色、同 padding，只用动词 + icon 区分语义。
 *
 * **流式期间 vs 完成态**：
 *   - 流式（`finalized=false`）→ 左侧保持工具 icon，右侧状态文案用 ShinyText
 *   - 完成（`finalized=true`）→ 左侧静态工具 icon，无状态文案
 *   - parseError / partial 异常 → 不进入本组件（外层守门退回 ToolStepCard）
 *
 * 不用 Loader2 替换工具 icon：完成瞬间 icon 会从圆环跳回原图标，视觉突变；
 * 扫光只动文案，icon 全程稳定。
 *
 * **错误态**：tool_use block 自身**没有**成功/失败信号——它只是 LLM 发出的
 * 调用指令，是否成功由对应 tool_result block 决定。完整工具卡通过 sibling /
 * runtime store 读取 result 后显示错误；result block 本身不再单独渲染。
 *
 * **没有展开符号**：read / search / list 完成后没有需要展开的额外内容
 * （tool_result 作为数据块隐藏；想看详情的用户走
 * "查看完整工具结果"路径，未来可加 hover 展开）。
 */
const CompactToolUseRow: React.FC<{
  toolName: string
  input: unknown
  /** start=调用中；running=执行中；done=终态 */
  activity: 'calling' | 'executing' | 'done'
  inputFinalized: boolean
}> = ({ toolName, input, activity, inputFinalized }) => {
  const { t } = useTranslation('chat')
  const label = getToolDisplayName(t, toolName)
  // 参数尚未封口时，partial JSON 在对象和字符串形态间切换；不消费摘要可避免
  // basename / description 在字段边界来回跳变。封口后再一次性显示完整摘要。
  const summary = inputFinalized ? getCompactSummary(toolName, input) : null
  const iconName = getToolIcon(toolName)
  const Icon = resolveIcon(iconName)
  const statusHint = activity === 'calling'
    ? t('blockTimeline.toolUse.calling', { defaultValue: '正在调用…' })
    : activity === 'executing'
      ? t('blockTimeline.toolUse.executing', { defaultValue: '正在执行…' })
      : null

  return (
    <div
      className={cn(STEP_ROW.inline)}
      data-testid="block-tool-use-compact"
      data-tool-name={toolName}
      data-activity={activity}
    >
      <span className={cn('inline-flex shrink-0 items-center justify-center', ICON_SIZE.md)}>
        <Icon className={cn(ICON_SIZE.md, STEP_ROW.icon)} />
      </span>
      <span className={cn('shrink-0', TEXT_COLOR.secondary)}>{label}</span>
      {summary && (
        <span className={cn('min-w-0 flex-1 truncate', TEXT_COLOR.muted)}>{summary}</span>
      )}
      {statusHint && (
        <ShinyText className={cn('shrink-0', TEXT.meta)}>
          {statusHint}
        </ShinyText>
      )}
    </div>
  )
}
CompactToolUseRow.displayName = 'CompactToolUseRow'

/**
 * Subagent 入口的内嵌组件——单独抽出避免主组件 hooks 链路复杂化（subagent
 * 路径需要 useChatRuntimeStore 读 cancel state，但常规 tool_use 路径不需要，
 * 走条件 hook 会破坏 hooks 顺序契约）。
 *
 * **W4c · R1-P1-4 / R2-P1-2 修复**：status 不再单纯按 `entry.finalized` 单趋
 * 映射 completed/running——`tool_use` block finalize 时子 Agent 仍可能在跑
 * （tool_use 只是 LLM 发出的"启动 Task"指令，子 Agent 实际由 backend
 * 异步执行直到自身 message_stop）。改为：
 *   1. 优先读 `subagentRunsBySessionId[sessionId]` 中匹配 subagentRunId 的
 *      真实 SubagentRun.status（pending/running/completed/failed/cancelled）
 *   2. 缺失时（譬如历史回看尚未拉到 subagent state）fallback 到 finalized
 *      映射 → completed/running 的旧行为
 */
const SubagentBlockEntry: React.FC<{
  /**
   * **入参语义**：来自 BlockTimeline 的 `block.id`（= 父 LLM 给的
   * `tool_use.id`，`toolu_xxx`）。**不是**子 Agent 自己的 run UUID。
   *
   * 用 `useSubagentRun` 双向匹配反查到真正的 `SubagentRun`，再用
   * `subagentRun.subagentRunId`（runtime crypto.randomUUID() 生成的真
   * childId）作为下游 cancel IPC / SubagentProgressCard / cancel state
   * 索引的 key——避免把 toolCallId 当 childId 发去 runtime 导致
   * `cancelSubagent` 找不到目标永远 no-op（W4 review P0-B 修复）。
   */
  parentToolCallId: string
  task?: string
  background?: boolean
  sessionId: string | null
  /**
   * 子 Agent run 反查 session（缺省 = sessionId）。子详情面板用虚拟 session 渲染
   * transcript，但孙 Agent 的 run 元数据 keyed 在真实父 chat session 下——必须用它
   * 反查，否则单个孙 Agent 卡片在空的虚拟 session 里永远「连接中」。
   */
  subagentRunSessionId?: string | null
  ownerRunId?: string
  siblingToolResult?: SiblingToolResult
  finalized: boolean
  /** 实时窗口门禁（与聚合路径同口径）：会话是否流式中 */
  isStreaming?: boolean
  /** 实时窗口门禁：是否当前正在产出的 assistant message */
  isLastAssistantMsg?: boolean
}> = ({ parentToolCallId, task, background, sessionId, subagentRunSessionId, ownerRunId, finalized, isStreaming, isLastAssistantMsg }) => {
  const runSessionId = subagentRunSessionId ?? sessionId
  const subagentRun = useSubagentRun(runSessionId, parentToolCallId, ownerRunId)
  const cancelSubagentRun = useChatRuntimeStore((s) => s.cancelSubagentRun)

  // 与聚合路径 SubagentAggregateGroup 同口径的 displayRuns：
  //   - store 命中真实 run → 直接用（cancel 走真 UUID，命中 BudgetTracker）。
  //   - store-miss + 实时窗口（未 finalize / 当前流式 message）→ 合成乐观占位
  //     「启动中」（行 key 绑 parentToolCallId 锚点，SUBAGENT_STARTED 到达后
  //     原地顶替不 remount）。乐观行不可 drill-in / 不可取消（必 no-op）。
  //   - store-miss + 非实时窗口（历史回看 / reload）→ 空 runs + expectedCount=1
  //     交给 skeleton「连接中…」兜底，不拿活跃 spinner 冒充进行中（诚实性 C2/C5）。
  const liveWindow = !!isStreaming && !!isLastAssistantMsg
  const displayRuns = useMemo<SubagentRun[]>(() => {
    if (subagentRun) {
      return [background === true && subagentRun.background !== true
        ? { ...subagentRun, background: true }
        : subagentRun]
    }
    if (!finalized || liveWindow) {
      return [{
        subagentRunId: parentToolCallId,
        parentToolCallId,
        status: 'pending',
        isOptimistic: true,
        ...(background ? { background: true } : {}),
        ...(task ? { task } : {}),
      }]
    }
    return []
  }, [subagentRun, background, finalized, liveWindow, parentToolCallId, task])

  return (
    <div className="my-0.5" data-testid="block-tool-use-subagent">
      <SubagentAggregateView
        // 用 runSessionId（真实父 session）：既让 SubagentAggregateRow 的展开判定
        // 成立，又让 drill-in 的 SubagentInlineDetail 拿到正确 parentSessionId 反查
        // 孙 Agent 的 run + transcript（虚拟 session 拼不出 IPC 路径、也无 run）。
        sessionId={runSessionId}
        runs={displayRuns}
        onCancel={cancelSubagentRun}
        expectedCount={1}
      />
    </div>
  )
}
SubagentBlockEntry.displayName = 'SubagentBlockEntry'

export const ToolUseBlockView: React.FC<BlockRendererProps> = React.memo(
  ({ entry, messageId, sessionId, tabScopeKey, subagentRunSessionId, ownerRunId, siblingToolResult, isStreaming, isLastAssistantMsg, suppressPartialReason, suppressInlineLoading: _suppressInlineLoading = false }) => {
    const { t } = useTranslation('chat')
    const block = entry.block as ToolUseBlock
    const toolName = block.name ?? 'unknown'
    const toolDisplayName = getToolDisplayName(t, toolName)
    const toolCallId = block.id ?? entry.block_id

    // 待办 timeline：从 message.blocks 纯派生。命中已收尾批的 anchor
    // toolCallId 时，本条 todo block 位置渲染完成快照卡。
    const todoTimeline = useTodoTimeline(sessionId)

    // 流式期间真实 input 在 pendingInputJson；finalize 后用 block.input。
    const effectiveInput = useMemo(() => {
      if (entry.finalized) return block.input
      if (entry.pendingInputJson && entry.pendingInputJson.length > 0) {
        return tryParsePartialJson(entry.pendingInputJson)
      }
      return block.input
    }, [entry.finalized, entry.pendingInputJson, block.input])
    const inputFinalized = isCompleteToolInput(entry.finalized, Boolean(entry.partial))

    // ── W4.5 §服务端 ID 命名空间统一：跨 message 反查对应 tool_result ──
    //
    // **设计意图**：tool_use + tool_result 在视觉上合并到一张 ToolStepCard
    // （紧凑 step 列表体感）——edit_file / write_file / bash 等
    // 写操作的卡片**必须**看到 diff / 输出，否则用户对"AI 改了什么 / 命令
    // 输出了什么"零感知。
    //
    // **为什么要跨 message 反查**：W4.5 §服务端 ID 命名空间统一后，daemon
    // 多轮 LLM call 产生 N 条 ChatMessage，tool_use 在 assistant message，
    // tool_result 在紧接的 user message——它们**永远不在同一个 messageId**
    // 下。useChatRuntimeStore 的 contentBlocksBySessionId 按 (sid, mid)
    // 二维索引，找 tool_result 必须扫整个 sid 下所有 message 的 blocks。
    //
    // **selector 性能**：单 session 累计 tool_result blocks 通常 < 100 个，
    // O(N) 扫描 + Zustand selector 命中已有引用即跳过——dev 实测每帧重渲染
    // < 1ms。生产场景里 store 早已 evict 老 message 的 blocks，实际待扫
    // 集合永远在小数量级。
    //
    // **未 finalized 时不查**：流式期间 tool_result 还没到，反查徒劳；
    // 等 entry.finalized 才走查询路径，避免无效 selector 调用。
    //  阶段 6：已提交块在 messages 层。订阅 session 块记录作重算触发器，
    // 块变化时返回新记录引用 → 重扫反查 tool_result（跨消息， 改自裸 version）。
    const blocksRecord = useSessionBlocksRecord(sessionId)
    const storedToolResult = useMemo(() => {
      if (!sessionId || !entry.finalized || !toolCallId) return undefined
      return findToolResult(blocksRecord, toolCallId)
    }, [sessionId, entry.finalized, toolCallId, blocksRecord])

    // `tool_result` 是持久化回放的主来源；实时流里还有一条更早到达的
    // SYSTEM_NOTICE(tool_completed)，里面也带同一份 output。Electron renderer
    // 在 user tool_result message 丢失/尚未入 store 的窗口期，必须能用这条
    // lifecycle event 兜底，否则完成态工具卡会只拿到 input，被 TerminalCard
    // 误显示成 running + 无输出。
    //
    // **2026-05-17 dogfood 事故堵漏（phase=error）**：原版只接受 `phase === 'end'`，
    // 导致 terminal 超时 / 工具抛错（phase='error'）路径下 output 被静默吞掉——
    // TerminalCard 拿到 output=null 退化到"结果正在同步…"占位，完整错误结果
    // （含 `error_kind / hint / stdout` 等）用户永远看不到。错误态的 `event.output`
    // 在 runtime 端就是结构化错误 JSON（runtime.ts `buildToolErrorResult` 输出），
    // TerminalCardRenderer 的 legacy fallback 路径完全能解（识别 `success: false` /
    // `error_kind` 等字段）——这里只需要别再过滤掉。
    //
    // **2026-05-17 streaming tool_progress（B 方案）**：lifecycle event 现在还可能
    // 带 `progress.stdout`（foreground 长跑命令 5s/1KB 节流的 partial snapshot）。
    // 流式期间（entry.finalized=false）原本守门直接 return undefined，这里放宽：
    // finalized=false 时若 lifecycle event 有 progress，包装成 partial output 喂给
    // TerminalCardRenderer 的 legacy fallback，让用户实时看 partial stdout 而不是
    // spinner 黑屏。
    const lifecycleEvent = useChatRuntimeStore((s) => {
      if (!sessionId || !toolCallId) return undefined
      return s.getEffectiveToolEventForSession(sessionId, toolCallId)
    })

    const { phase, decodedOutput, lifecycleDurationMs, lifecycleStartedAt, intent, viewRoute } = useMemo(
      () => deriveToolUseExecutionState({
        entry,
        toolName,
        effectiveInput,
        inputFinalized,
        sessionId,
        toolCallId,
        siblingToolResult,
        storedToolResult,
        lifecycleEvent,
        isStreaming,
        isLastAssistantMsg,
        todoSnapshot: todoTimeline.anchorMap.get(toolCallId),
      }),
      [
        entry,
        toolName,
        effectiveInput,
        inputFinalized,
        sessionId,
        toolCallId,
        siblingToolResult,
        storedToolResult,
        lifecycleEvent,
        isStreaming,
        isLastAssistantMsg,
        todoTimeline.anchorMap,
      ],
    )

    return (
      <ToolUseRoutedView
        route={viewRoute}
        entry={entry}
        toolName={toolName}
        toolDisplayName={toolDisplayName}
        toolCallId={toolCallId}
        effectiveInput={effectiveInput}
        inputFinalized={inputFinalized}
        phase={phase}
        decodedOutput={decodedOutput}
        lifecycleDurationMs={lifecycleDurationMs}
        lifecycleStartedAt={lifecycleStartedAt}
        intent={intent}
        sessionId={sessionId}
        tabScopeKey={tabScopeKey}
        messageId={messageId}
        subagentRunSessionId={subagentRunSessionId}
        ownerRunId={ownerRunId}
        siblingToolResult={siblingToolResult}
        isStreaming={isStreaming}
        isLastAssistantMsg={isLastAssistantMsg}
        suppressPartialReason={suppressPartialReason}
        compactRow={CompactToolUseRow}
        subagentEntry={SubagentBlockEntry}
      />
    )
  },
  blockEntryEqual,
)
ToolUseBlockView.displayName = 'ToolUseBlockView'
