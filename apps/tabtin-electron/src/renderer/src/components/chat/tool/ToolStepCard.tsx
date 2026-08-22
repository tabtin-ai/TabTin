/**
 * ToolStepCard — 工具调用详情卡片
 *
 * 可展开卡片，通过注册表（registry）查找工具的标签、图标、摘要和渲染器。
 * 新增工具类型无需修改此文件，只需在 toolCardRegistry.ts 中注册。
 *
 * 对应规范: docs/agent-chat/component-spec.md
 */

import React, { useEffect, useMemo, useRef } from 'react'
import { useBlockExpanded, blockExpandKey } from '@stores/chat/presentation/blockUiPrefs'
import {
  Wrench, ChevronDown, ChevronRight,
  ShieldAlert, Layers,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import {
  getToolDescriptor,
  getCompactSummary as registryGetSummary,
  extractToolOutput,
} from '../registry/toolCardRegistry'
import { getToolDisplayName } from '../registry/toolDisplayName'
import { getCardRenderer } from '../registry/cardRenderers'
import { resolveIcon } from '../registry/iconMap'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import {
  CARD_RADIUS,
  CHAT_STEP_TEXT,
  TEXT,
  TEXT_COLOR,
  BG,
  DIFF,
  ICON_SIZE,
  STEP_ROW,
  SUNKEN_SHELL,
  TAG,
} from '../registry/chatDesignTokens'
import '../cards/TerminalCard'
import '../cards/SSHCard'
import '../cards/DiffCard'
import '../cards/SqlResultCard'
import '../cards/GenericToolCard'
import '../cards/CodeSearchCard'
import '../cards/FileReadCard'
import '../cards/WebSearchCard'
import '../cards/WebFetchCard'
import '../cards/FileWriteCard'
import '../cards/FileDeleteCard'
import '../cards/RecordOpCard'
import '../cards/UpdateByFilterPreviewCard'
import '../cards/PhoneScreenshotCard'
import '../cards/ScreenshotCard'
import '../cards/DocSearchCard'
import '../cards/VideoTimelineCard'
import '../cards/MemoryCard'
import '../cards/TodoCard'
import { isBackgroundTerminalTask } from '../cards/TerminalCard'
import { getCollapsedToolLabel } from './toolCollapsedLabel'
import { ShinyText } from '../markdown/ShinyText'

import { formatDuration } from '../utils/format'

/* ─── Props ──────────────────────────────────────────────────────── */

interface ToolStepCardProps {
  id: string
  toolName: string
  /** start=调用中（参数流）；running=执行中（已封口等结果）；end/error=终态 */
  phase: 'start' | 'running' | 'end' | 'error'
  inputSummary?: string
  /** Agent 对本次调用的用户可见目的；无具体参数摘要时作为折叠行兜底。 */
  intent?: string
  outputSummary?: string
  durationMs?: number
  /** 工具参数是否已完整落入 block.input；未封口时不显示 partial 参数摘要。 */
  inputFinalized?: boolean
  input?: unknown
  output?: unknown
  error?: string | null
  /**
   * Wave 2h C-1：grace 期被跳过的工具（`IterationBudget` 达终结轮）。
   * 传入后卡片切成"温和"态：Clock 黄色图标替代 XCircle 红色，
   * 与"工具失败"区分开。
   */
  budgetSkipped?: boolean
  /**
   * Wave 2h C-2 / Wave 3：runtime error_kind（budget_skipped / aborted_by_user /
   * execute_error / ...）。对齐 AgentSteps 里的软错误判定逻辑。
   */
  errorKind?: string
  /**
   * PRD 08 W14（L-31）：FR-09 注入扫描命中。runtime 在 fence head 加
   * `suspicious="true"`；UI 在标题区显示一个小盾牌 badge + tooltip，让
   * 用户感知到安全护栏已经介入（透明度），而不是只让 LLM 单方面知道。
   * 设计参考：低饱和 warning 色，不抢主信息流；hover 解释意图。
   */
  suspicious?: boolean
  /**
   * 该工具调用所属的 chat session id；流式卡片（FileWriteCard 等）需要它来订阅
   * `tool_call_args_delta` buffer。透传给 CardRenderer，不强制（历史回放可空）。
   */
  sessionId?: string | null
  /**
   * 工具开始时间（Date.now ms）。给 TerminalCard 这类长跑工具显示 elapsed
   * heartbeat：命令尚无 stdout 时，也能显示「运行中 12s，暂无输出」。
   */
  startedAt?: number
  /**
   * 当前 UI 标签组 scope（`conversation:<id>` / `desktop:...`）。透传给 CardRenderer，
   * 让 TerminalCard 的「查看终端」把 tab 开进面板实际在读的桶（见 CardRendererProps）。
   */
  tabScopeKey?: string | null
}

interface DefaultToolCardBodyProps {
  input?: unknown
  output?: unknown
  outputSummary?: string
  error?: string | null
  paramsLabel: string
  resultLabel: string
}

interface DiffStats {
  insertions: number
  deletions: number
}

function countDiffLines(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function resolveDiffStats(data: unknown): DiffStats | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const diff = data as {
    kind?: unknown
    old_lines?: unknown
    new_lines?: unknown
    hunks?: unknown
  }
  if (diff.kind !== 'diff') return null

  if (Array.isArray(diff.hunks) && diff.hunks.length > 0) {
    return diff.hunks.reduce<DiffStats>((stats, hunk) => {
      if (!hunk || typeof hunk !== 'object' || Array.isArray(hunk)) return stats
      const item = hunk as { old_lines?: unknown; new_lines?: unknown }
      return {
        insertions: stats.insertions + countDiffLines(item.new_lines),
        deletions: stats.deletions + countDiffLines(item.old_lines),
      }
    }, { insertions: 0, deletions: 0 })
  }

  return {
    insertions: countDiffLines(diff.new_lines),
    deletions: countDiffLines(diff.old_lines),
  }
}

const DefaultToolCardBody: React.FC<DefaultToolCardBodyProps> = ({
  input,
  output,
  outputSummary,
  error,
  paramsLabel,
  resultLabel,
}) => (
  <>
    {input ? (
      <div>
        <div className={cn(TEXT.label, TEXT_COLOR.muted, 'mb-0.5')}>
          {paramsLabel}
        </div>
        <ScrollArea className="max-h-[80px]">
          <pre className={cn(TEXT.code, TEXT_COLOR.secondary, BG.header, CARD_RADIUS, 'px-2 py-1 whitespace-pre-wrap')}>
            {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
          </pre>
        </ScrollArea>
      </div>
    ) : null}
    {error ? (
      <div className={cn(CHAT_STEP_TEXT, TEXT_COLOR.error, BG.error, CARD_RADIUS, 'px-2 py-1 [overflow-wrap:anywhere]')}>
        {error}
      </div>
    ) : null}
    {outputSummary ? (
      <div>
        <div className={cn(TEXT.label, TEXT_COLOR.muted, 'mb-0.5')}>
          {resultLabel}
        </div>
        <div className={cn(CHAT_STEP_TEXT, TEXT_COLOR.secondary)}>{outputSummary}</div>
      </div>
    ) : output ? (
      <div>
        <div className={cn(TEXT.label, TEXT_COLOR.muted, 'mb-0.5')}>
          {resultLabel}
        </div>
        <ScrollArea className="max-h-[80px]">
          <pre className={cn(TEXT.code, TEXT_COLOR.secondary, BG.header, CARD_RADIUS, 'px-2 py-1 whitespace-pre-wrap')}>
            {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
          </pre>
        </ScrollArea>
      </div>
    ) : null}
  </>
)

/* ─── 主组件 ─────────────────────────────────────────────────────── */

const ToolStepCardImpl = ({
  id,
  toolName,
  phase,
  outputSummary,
  intent,
  durationMs,
  inputFinalized = true,
  input,
  output,
  error,
  suspicious,
  sessionId,
  startedAt,
  tabScopeKey,
}: ToolStepCardProps) => {
  const { t } = useTranslation('chat')
  const descriptor = getToolDescriptor(toolName)
  const isCalling = phase === 'start'
  const isExecuting = phase === 'running'
  // 失败判定唯一来源：父层传入的 phase==='error'（lifecycle / tool_result 已收敛）。
  // 不在此另开 errorKind / budgetSkipped 第二套判断，避免与折叠行信号打架。
  const isFailed = phase === 'error'
  // 普通执行步骤默认折叠为一行（只显示摘要行，详情按需点开）——**报错也保持折叠**、
  // 不再自动展开占屏（用户拍板  live）。「可疑命中」(suspicious) 仍自动展开，
  // 让安全护栏第一时间可见；DiffCard 则在折叠行保留文件摘要，详情按需展开，避免
  // 连续编辑把会话撑满，最终改动由会话末尾 Review Card 汇总展示。
  //
  // 通过注册表的 renderer 能力判定，不绑 edit_file / apply_patch 等具体工具名；
  // 后续接入新的结构化编辑工具时会自动沿用同一展示契约。
  const defaultExpanded = !!suspicious
  // 展开态提到 store（按工具 id）——虚拟列表 remount 后仍能读回，不再「后续消息刷新
  // 导致展开态丢失」。
  const [expanded, setExpanded] = useBlockExpanded(id ? blockExpandKey(id) : null, defaultExpanded)
  // suspicious 自动展开：仅在 defaultExpanded **真正翻转**时应用，
  // 不在 mount/remount 时用 defaultExpanded 覆盖用户存下的展开态。
  const prevDefaultExpandedRef = useRef(defaultExpanded)
  useEffect(() => {
    if (prevDefaultExpandedRef.current !== defaultExpanded) {
      prevDefaultExpandedRef.current = defaultExpanded
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded, setExpanded])
  const label = getToolDisplayName(t, toolName)
  const statusHint = isCalling
    ? t('blockTimeline.toolUse.calling', { defaultValue: '正在调用…' })
    : isExecuting
      ? t('blockTimeline.toolUse.executing', { defaultValue: '正在执行…' })
      : null

  const ToolIcon = descriptor
    ? resolveIcon(descriptor.icon)
    : Wrench

  const compactSummary = useMemo(
    () => {
      const registrySummary = inputFinalized ? registryGetSummary(toolName, input, output) : null
      return toolName === 'run_terminal_command'
        ? intent ?? registrySummary ?? null
        : registrySummary ?? intent ?? null
    },
    [toolName, input, output, inputFinalized, intent],
  )

  // **流式期间也尝试解出 structuredData**：edit_file 等工具的 input 已包含
  // `path / old_string / new_string`（LLM 流式输出），`extractDiff` 同时支持
  // `old_lines` 数组形态和 `old_string` 字符串形态——所以 phase=start 阶段
  // 喂 input 给 extractor 就能解出 partial diff，让 DiffCardRenderer 在流式
  // 中实时画 diff（流式 diff 体感）。
  //
  // 完成态文本 output 不应遮蔽 input 中的结构化参数。Git 模式 apply_patch 的
  // tool_result 是摘要字符串，而逐文件 unified diff 位于 input.changes。
  const structuredData = useMemo(
    () => toolName === 'apply_patch'
      ? extractToolOutput(toolName, output) ?? extractToolOutput(toolName, input)
      : extractToolOutput(toolName, output ?? input),
    [toolName, output, input],
  )

  const rendererName = descriptor?.renderer ?? 'GenericToolCard'
  const CardRenderer = getCardRenderer(rendererName)
  const diffStats = useMemo(
    () => rendererName === 'DiffCard' ? resolveDiffStats(structuredData) : null,
    [rendererName, structuredData],
  )
  const genericParamsLabel = t('card.generic_params')
  const genericResultLabel = t('card.generic_result')
  const renderCardBody = () => CardRenderer ? (
    <CardRenderer
      id={id}
      toolName={toolName}
      phase={phase}
      input={input}
      output={output}
      data={structuredData}
      durationMs={durationMs}
      intent={intent}
      startedAt={startedAt}
      error={error}
      sessionId={sessionId}
      tabScopeKey={tabScopeKey}
    />
  ) : (
    <DefaultToolCardBody
      input={input}
      output={output}
      outputSummary={outputSummary}
      error={error}
      paramsLabel={genericParamsLabel}
      resultLabel={genericResultLabel}
    />
  )

  // 统一「终端式」呈现（所有工具卡同款）：
  //   - 折叠行：工具图标始终保留（运行中不换 Loader2）+ 描述 + 扫光状态文案，
  //     右侧可选 duration + 按需 chevron；不带边框 / 成功无庆祝色。
  //   - 失败（phase=error）：折叠行一眼可见——黄点（bg-warning）一次性 pop
  //     （chat-motion-failure-pop）；仍默认折叠，详情点开看。
  //     不再叠「失败」文案标。
  //   - 展开：下沉卡片容器（无边框 + 统一下沉底色 + 无内高光），内部交给
  //     CardRenderer 渲染纯内容（各卡 body 已去掉自带外壳）。
  //   - 可疑命中仍在折叠行保留盾牌 badge（安全护栏可见）。
  const collapsedLabel = getCollapsedToolLabel({
    input,
    inputFinalized,
    compactSummary,
    intent,
    fallbackLabel: label,
  })

  // ：后台任务（run_terminal_command wait_ms=0）在**折叠行**就加「后台」
  // 徽标——折叠/展开都常驻顶部，一眼区分前台/后台（展开态的 TerminalCard header
  // 不再重复徽标，仅显示运行状态）。仅对终端卡判定，其它工具不受影响。
  const isBackgroundTask = rendererName === 'TerminalCard' && isBackgroundTerminalTask(input, output)

  return (
    <div>
      <button
        type="button"
        className={STEP_ROW.button}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {isFailed ? (
          <span
            className={cn(
              'chat-motion-failure-pop h-1.5 w-1.5 shrink-0 rounded-full bg-warning',
            )}
            data-testid="tool-step-failure-dot"
            aria-hidden
          />
        ) : null}
        <ToolIcon className={cn(ICON_SIZE.md, 'shrink-0', STEP_ROW.icon)} />
        <span className={STEP_ROW.label}>
          {collapsedLabel}
        </span>
        {diffStats && (diffStats.insertions > 0 || diffStats.deletions > 0) && (
          <span
            data-testid="tool-step-diff-stats"
            className={cn('inline-flex shrink-0 items-center gap-1.5 font-mono tabular-nums', TEXT.meta)}
            aria-label={t('card.diffStats', {
              defaultValue: '新增 {{insertions}} 行，删除 {{deletions}} 行',
              insertions: diffStats.insertions,
              deletions: diffStats.deletions,
            })}
          >
            {diffStats.insertions > 0 && <span className={DIFF.addText}>+{diffStats.insertions}</span>}
            {diffStats.deletions > 0 && <span className={DIFF.removeText}>-{diffStats.deletions}</span>}
          </span>
        )}
        {statusHint && (
          <ShinyText
            className={cn('shrink-0', TEXT.meta)}
            data-testid="tool-step-status-hint"
            data-status={isCalling ? 'calling' : 'executing'}
          >
            {statusHint}
          </ShinyText>
        )}
        {isBackgroundTask && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded font-medium',
              TAG.bg,
              TAG.text,
              TEXT.meta,
            )}
            data-testid="tool-step-background-badge"
          >
            <Layers className={ICON_SIZE.sm} aria-hidden />
            <span>{t('card.background_task', { defaultValue: '后台' })}</span>
          </span>
        )}
        {suspicious && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded',
              'text-warning/80 border border-warning/30',
              TEXT.meta,
            )}
            title={t('toolError.suspiciousBadgeTooltip')}
            aria-label={t('toolError.suspiciousBadgeAria')}
          >
            <ShieldAlert className={ICON_SIZE.sm} aria-hidden />
            <span>{t('toolError.suspiciousBadge')}</span>
          </span>
        )}
        {/* 下拉箭头：保持在末尾，按需显示（hover / 展开） */}
        <span
          className={cn(
            'shrink-0 transition-opacity',
            expanded ? 'opacity-100' : 'opacity-0 group-hover/step:opacity-100',
          )}
        >
          {expanded
            ? <ChevronDown className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'transition-colors group-hover/step:text-foreground')} />
            : <ChevronRight className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'transition-colors group-hover/step:text-foreground')} />}
        </span>
      </button>

      {expanded && (
        <div className="mt-0.5">
          <div className={cn(CARD_RADIUS, 'overflow-hidden', BG.codeSunken, SUNKEN_SHELL)}>
            {renderCardBody()}
            {/* 耗时收进展开卡片底部（折叠行不再显示），右对齐灰字 */}
            {durationMs !== undefined && (
              <div className={cn('flex justify-end px-2.5 py-1', TEXT.meta, TEXT_COLOR.faint)}>
                <span className="tabular-nums">
                  {t('card.duration', { defaultValue: '耗时' })} {formatDuration(durationMs)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// memo 防御：父级（ToolUseBlockView，已 blockEntryEqual）重跑但本卡 props 未变时不下钻。
export const ToolStepCard = React.memo(ToolStepCardImpl)
ToolStepCard.displayName = 'ToolStepCard'
