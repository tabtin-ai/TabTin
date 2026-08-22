/**
 * SubagentAggregateView — 子 Agent「对话内派发标记」
 *
 * ## 形态：阅读流里的轻量派发条目
 *
 * Chat 的主体验是阅读。这里不做独立 widget，只在主叙事里插入轻量条目：
 * 任务标题 + 角色/模型/进展摘要；完整 transcript 就地展开看。
 *   - **对话内（本组件）**：派发了什么、谁在做、进展到哪；点行就地展开执行流。
 *   - **chip 堆叠条**（输入框上方）：此刻谁在跑——补充身份级实时感。
 *
 * ## 活跃态活动感
 *
 * 完全静态的派发行会让用户误以为卡死；常显「stop」又像任务已停。对齐工具
 * step：图标保持静态，活跃进展用 ShinyText 扫光（有扫光就不转圈）；stop
 * 仅 hover / focus / 取消中显现。
 *
 * ## 交互沿革
 *
 * 2026-06-07：点行从 app 级 modal 改为行内就地展开（手风琴单选）。
 * 单/多子 Agent 都走本组件，视觉一致。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, PanelRight, Square } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import type { SubagentRun } from '../../../stores/chat/shared/types'
import { TEXT, TEXT_COLOR, ICON_SIZE, MOTION } from '../registry/chatDesignTokens'
import { MARKER_STATUS_GLYPH, MARKER_STATUS_FALLBACK, SUBAGENT_ACTIVE_STATUSES } from './subagentMarkerStatus'
import { useSubagentCancelState } from './useSubagentCancelState'
import { getToolDisplayName, type ChatTranslate } from '../registry/toolDisplayName'
import { useModelDisplayName } from '../model/useModelDisplayName'
import { SubagentInlineDetail } from './SubagentInlineDetail'
import { useSubagentDisclosure } from './SubagentDisclosureContext'
import { SubagentStickyHeaderShell } from './SubagentStickyStackContext'
import { useSubagentTemplateMeta } from '../hooks/useSubagentTemplateNames'
import { useSpaceStore } from '@stores/useSpaceStore'
import { ShinyText } from '../markdown/ShinyText'
import { SubagentOrchestrationIcon } from './SubagentOrchestrationIcon'
import { useSpaceIdForSession } from '../hooks/useSpaceIdForSession'
import { openSubagentTab } from './openSubagentTab'
import { useRunningSubagentElapsed } from './useRunningSubagentElapsed'

/** 行入场动画时长（与 chat-motion-subagent-enter / D-state 对齐）。 */
const SUBAGENT_ENTER_MS = Number.parseFloat(MOTION.state)

function rowMotionKey(run: SubagentRun): string {
  return run.parentToolCallId ?? run.subagentRunId
}

// 活跃三态（仍在跑 / 排队，可被 stop 按钮制止；终态不显 stop）走 subagentMarkerStatus
// 单一来源 SUBAGENT_ACTIVE_STATUSES（P2-3），不再本地另写一份。

/** 2 个或以上即用聚合视图（单个仍走 SubagentBlockEntry，但同样渲染本组件）。 */
export const AGGREGATE_THRESHOLD = 2

const TEXT_TRUNCATE_LIMIT = 96

function compactText(value: string | undefined, limit = TEXT_TRUNCATE_LIMIT): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * 模板 badge 默认色——对齐 `SubAgentPanel` 颜色选择器的默认值 `#6366f1`：模板未显式
 * 配置 display_color（历史模板 / 没点色板）时用它，保证「源自模板」的 badge 始终带色。
 */
const DEFAULT_TEMPLATE_BADGE_COLOR = '#6366f1'

/**
 * 由模板 display_color（6 位 hex）生成 badge 内联样式：低透明度同色底 + 同色字。
 * 非法 / 空色返回 undefined（调用方回退中性 muted 样式）。
 */
const HEX6_RE = /^#[0-9a-fA-F]{6}$/
function badgeTintFromHex(color: string | undefined): { backgroundColor: string; color: string } | undefined {
  if (!color || !HEX6_RE.test(color)) return undefined
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  return { backgroundColor: `rgba(${r}, ${g}, ${b}, 0.16)`, color }
}

function getStatusLabel(t: ChatTranslate, status: SubagentRun['status']): string {
  const fallback: Record<SubagentRun['status'], string> = {
    pending: '已派发',
    queued: '排队中',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return t(`subagent.inline.status.${status}`, {
    defaultValue: fallback[status],
  })
}

function formatDuration(ms: number | undefined): string | undefined {
  if (!Number.isFinite(ms) || !ms || ms < 0) return undefined
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

function buildProgressText(run: SubagentRun, t: ChatTranslate): string {
  if (run.isOptimistic) {
    return t('subagent.inline.progressStarting', {
      defaultValue: '等待子 Agent 接入',
    })
  }

  if (run.status === 'queued') {
    return t('subagent.inline.progressQueued', {
      defaultValue: '等待空闲执行槽',
    })
  }

  if (run.status === 'pending') {
    return t('subagent.inline.progressPending', { defaultValue: '等待结果' })
  }

  if (run.status === 'running') {
    const stepText =
      run.stepCount && run.stepCount > 0
        ? t('subagent.steps', {
            count: run.stepCount,
            defaultValue: `${run.stepCount} 步`,
          })
        : undefined
    const toolText = run.latestTool ? getToolDisplayName(t, run.latestTool) : undefined
    const toolInput = compactText(run.latestToolInput, 56)
    const activeToolText = toolText ? (toolInput ? `${toolText} · ${toolInput}` : toolText) : undefined
    const duration = formatDuration(run.elapsedMs)
    return [stepText, activeToolText, duration].filter(Boolean).join(' · ') || t('subagent.inline.progressRunning', { defaultValue: '正在执行' })
  }

  if (run.status === 'completed') {
    const summary = compactText(run.summary, 72)
    if (summary) return summary
    const stepText =
      run.stepCount && run.stepCount > 0
        ? t('subagent.steps', {
            count: run.stepCount,
            defaultValue: `${run.stepCount} 步`,
          })
        : undefined
    const duration = formatDuration(run.stats?.duration_ms ?? run.elapsedMs)
    return [stepText, duration].filter(Boolean).join(' · ') || t('subagent.inline.progressCompleted', { defaultValue: '任务已完成' })
  }

  if (run.status === 'failed') {
    return (
      compactText(run.error, 72) ||
      t('subagent.inline.progressFailed', {
        defaultValue: '执行失败，点开查看原因',
      })
    )
  }

  return t('subagent.inline.progressCancelled', { defaultValue: '已停止执行' })
}

/* ─── 单行（清单里的一个已派发子任务） ────────────────────────────────── */

interface SubagentDispatchRowProps {
  run: SubagentRun
  sessionId: string | null
  /**
   * 已解析的模板名——命中 Space 模板派发时展示为 badge（父组件按 templateId 反查，
   * 含 live）。解析不到（ad-hoc / 模板已删）为 undefined，不显 badge。
   */
  templateBadge?: string
  /** 模板配置的显示颜色（hex，可空）——染 badge；无有效色回退中性 muted。 */
  templateBadgeColor?: string
  /** 该行执行流是否已就地展开（手风琴单选，由父组件裁决） */
  isExpanded: boolean
  /** 当前会话所属工作区；存在时才允许把子任务直接提升为工作台标签。 */
  spaceId: string | null
  /**
   * 点击行 → toggle 就地展开/收起该子 Agent 的执行流。
   * 乐观占位行（子 session 未落盘）不可展开；sessionId 为 null 时父组件 no-op。
   */
  onToggle: (subagentRunId: string) => void
  /**
   * 仅「本次会话中新出现的行」为 true——挂上 chat-motion-subagent-enter。
   * 历史回放 / 重新展开列表不得重播入场。
   */
  motionEnter?: boolean
}

const SubagentDispatchRow: React.FC<SubagentDispatchRowProps> = React.memo(({ run, sessionId, templateBadge, templateBadgeColor, isExpanded, spaceId, onToggle, motionEnter = false }) => {
  const { t } = useTranslation('chat')
  const glyph = MARKER_STATUS_GLYPH[run.status] || MARKER_STATUS_FALLBACK
  const badgeTint = badgeTintFromHex(templateBadgeColor)

  const assignee = run.role?.trim()
  // agent.description → runtime label，是主 Agent 生成的短标题；prompt/task 是完整交底，
  // 不默认顶到标题上，避免在阅读流里塞大段 prompt。
  const fallbackTitle = `${t('subagent.tab.fallbackTitle', { defaultValue: '子 Agent' })} · ${run.subagentRunId.slice(0, 4)}`
  const isOptimistic = !!run.isOptimistic
  const title = compactText(run.label, 72) || (isOptimistic ? compactText(run.task, 72) : undefined) || compactText(assignee, 72) || fallbackTitle
  // run.model 是模型 id（runtime 解析出的 childModel）；解析成显示名再截断。
  const modelText = compactText(useModelDisplayName(run.model), 44)
  const statusText = getStatusLabel(t, run.status)
  const displayElapsedMs = useRunningSubagentElapsed({
    anchorKey: run.subagentRunId,
    status: run.status,
    startedAt: run.startedAt,
    elapsedMs: run.elapsedMs,
  })
  const progressText = buildProgressText({ ...run, elapsedMs: displayElapsedMs }, t)
  // 身份 / 模型保持静态；状态 + 进展在活跃态用 ShinyText 扫光（对齐工具 step）。
  const backgroundLabel = run.background === true
    ? t('subagent.inline.background', { defaultValue: '后台' })
    : undefined
  const identityParts = [backgroundLabel, assignee && assignee !== title ? assignee : undefined, modelText].filter(Boolean)
  const statusProgressText = [statusText, progressText].filter(Boolean).join(' · ')
  const isActive = SUBAGENT_ACTIVE_STATUSES.has(run.status)
  // 不可展开的两种情况：① 乐观占位行（子 session 还没落盘，无可看内容）；
  // ② sessionId 为 null（草稿态，SubagentDetailPane 拼不出 IPC 路径）。
  // 不可展开时不显 chevron、不可点，避免「看着能点、点了没反应」的误导。
  const expandable = !isOptimistic && !!sessionId
  const canOpenInWorkbench = !isExpanded && !isOptimistic && !!sessionId && !!spaceId
  const hasRowActions = canOpenInWorkbench || (isActive && !isOptimistic) || expandable

  // 最后手段控制：活跃态行尾 stop——静息隐身，hover / focus / 取消中才显现
  //（避免常显 stop 被误读成「任务已停」#5377）。复用
  // useSubagentCancelState 双源判定（本 run 维度取消 OR 整 turn stop）。
  const { cancelSubagentRun, isCancelling } = useSubagentCancelState(run.subagentRunId, sessionId)
  const keepRowActionsInFlow = isExpanded || isCancelling
  const stopLabel = t('subagent.inline.stopAria', {
    task: title,
    defaultValue: `制止子 Agent：${title}`,
  })

  const handleRowClick = useCallback(() => {
    if (!expandable) return
    onToggle(run.subagentRunId)
  }, [onToggle, run.subagentRunId, expandable])

  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      // 别冒泡到行级 drill-in——stop 是独立动作。
      e.stopPropagation()
      if (isCancelling) return
      void cancelSubagentRun(run.subagentRunId)
    },
    [cancelSubagentRun, run.subagentRunId, isCancelling],
  )

  const handleOpenInWorkbench = useCallback(
    (e: React.MouseEvent) => {
      // 工作台打开与行内展开是两个平级入口，不能让点击继续冒泡触发手风琴。
      e.stopPropagation()
      if (!sessionId || !spaceId) return
      void openSubagentTab({
        parentSessionId: sessionId,
        subagentRunId: run.subagentRunId,
        spaceId,
        displayName: run.role?.trim() || run.label?.trim() || undefined,
        label: run.label,
        task: run.task,
        parentToolCallId: run.parentToolCallId,
        speakerId: run.speakerId,
      })
    },
    [run, sessionId, spaceId],
  )

  return (
    <div
      role={expandable ? 'button' : undefined}
      tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? isExpanded : undefined}
      onClick={expandable ? handleRowClick : undefined}
      onKeyDown={
        expandable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleRowClick()
              }
            }
          : undefined
      }
      className={cn(
        'group/row w-full min-w-0 rounded-md py-0.5 pr-1 text-left transition-colors',
        expandable ? 'cursor-pointer' : 'cursor-default',
        // hover / 展开都不染背景——只靠标题文字提亮（见下方标题 className）与行尾
        // chevron 显现来表达悬停 / 打开，配合下方就地展开区标识当前打开的行。
        // 入场：仅新行一次性生长；活跃态持续动效仍只留给下方 ShinyText（L2）。
        motionEnter && 'chat-motion-subagent-enter',
      )}
      data-testid={`subagent-inline-row-${run.subagentRunId}`}
      data-subagent-run-id={run.subagentRunId}
      data-subagent-status={run.status}
      data-subagent-background={run.background === true || undefined}
      data-subagent-optimistic={isOptimistic || undefined}
      data-subagent-expanded={isExpanded || undefined}
      data-motion-enter={motionEnter || undefined}
      aria-busy={isOptimistic || undefined}
    >
      <div className="min-w-0">
        {/* 标题行：状态图标与标题同处一行并垂直居中（items-center），保证图标
              与标题精确对齐；副标题（meta）缩进到标题文字下方对齐。 */}
        <div className="relative flex min-w-0 items-center gap-2">
          <glyph.Icon className={cn('shrink-0', ICON_SIZE.status, glyph.tone)} />
          <div className={cn(TEXT.header, 'min-w-0 flex-1 truncate transition-colors group-hover/row:text-foreground', isExpanded ? 'text-foreground' : 'text-foreground/90')}>{title}</div>
          {hasRowActions && (
            <div
              className={cn(
                'flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100',
                keepRowActionsInFlow
                  ? 'relative pointer-events-auto opacity-100'
                  : 'pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 bg-background opacity-0 group-hover/row:pointer-events-auto focus-within:pointer-events-auto',
              )}
              data-testid={`subagent-inline-actions-${run.subagentRunId}`}
            >
              {canOpenInWorkbench && (
                <button
                  type="button"
                  onClick={handleOpenInWorkbench}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="shrink-0 rounded-interactive p-1 text-muted-foreground/60 transition-colors hover:bg-muted/20 hover:text-foreground"
                  data-testid={`subagent-inline-open-workbench-${run.subagentRunId}`}
                  title={t('subagent.tab.openInWorkbench', { defaultValue: '在工作台标签打开' })}
                  aria-label={t('subagent.tab.openInWorkbench', { defaultValue: '在工作台标签打开' })}
                >
                  <PanelRight className={ICON_SIZE.md} />
                </button>
              )}
              {isActive && !isOptimistic && (
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={isCancelling}
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors',
                    isCancelling ? 'cursor-default' : 'hover:text-destructive',
                  )}
                  data-testid={`subagent-inline-stop-${run.subagentRunId}`}
                  aria-label={stopLabel}
                  title={stopLabel}
                >
                  {isCancelling
                    ? <Loader2 className={cn(ICON_SIZE.sm, 'animate-spin')} aria-hidden />
                    : <Square className={cn(ICON_SIZE.sm, 'fill-current')} aria-hidden />}
                </button>
              )}
              {/* 展开指示与相邻操作共用显隐容器，避免三个控件分批出现。 */}
              {expandable && (
                <span className="shrink-0" aria-hidden>
                  {isExpanded ? (
                    <ChevronDown className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'transition-colors group-hover/row:text-foreground/80')} />
                  ) : (
                    <ChevronRight className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'transition-colors group-hover/row:text-foreground/80')} />
                  )}
                </span>
              )}
            </div>
          )}
        </div>
        <div className={cn('flex min-w-0 items-center gap-1.5 pl-[1.375rem] text-caption text-muted-foreground/60', motionEnter && 'chat-motion-meta-enter')}>
          {templateBadge && (
            <span
              className={cn('shrink-0 rounded px-1.5 py-px font-medium', badgeTint ? '' : 'bg-muted/60 text-muted-foreground/80')}
              style={badgeTint}
              data-testid={`subagent-template-badge-${run.subagentRunId}`}
            >
              {templateBadge}
            </span>
          )}
          {identityParts.length > 0 && <span className="shrink-0 truncate">{identityParts.join(' · ')}</span>}
          {identityParts.length > 0 && statusProgressText && (
            <span className="shrink-0" aria-hidden>
              ·
            </span>
          )}
          {statusProgressText &&
            (isActive ? (
              <ShinyText allowConcurrent className="min-w-0 truncate">
                {statusProgressText}
              </ShinyText>
            ) : (
              <span className="min-w-0 truncate">{statusProgressText}</span>
            ))}
        </div>
      </div>
    </div>
  )
})
SubagentDispatchRow.displayName = 'SubagentDispatchRow'

/* ─── Skeleton 占位行（历史回看 store-miss 兜底，静态不转） ──────────────── */

const SubagentSkeletonRow: React.FC = React.memo(() => {
  const { t } = useTranslation('chat')
  const Glyph = MARKER_STATUS_FALLBACK.Icon
  return (
    <div className="flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 pr-2" data-testid="subagent-skeleton-row" aria-busy="true">
      <Glyph className={cn('h-3.5 w-3.5 shrink-0', TEXT_COLOR.faint)} />
      <span className="min-w-0 flex-1 truncate text-body italic text-muted-foreground/40">{t('subagent.aggregate.connecting', { defaultValue: '连接中…' })}</span>
    </div>
  )
})
SubagentSkeletonRow.displayName = 'SubagentSkeletonRow'

/* ─── 主组件 ───────────────────────────────────────────────────────────── */

interface SubagentAggregateViewProps {
  sessionId: string | null
  runs: SubagentRun[]
  /**
   * @deprecated live 取消已搬去 chip / 执行流 modal——本组件是静态派发标记，
   * 不再渲染取消入口。保留入参仅为兼容 BlockTimeline / SubagentBlockEntry 既有
   * 调用签名（传入即忽略）。
   */
  onCancel?: (subagentRunId: string) => void
  /**
   * @deprecated 对话内 step 形态无头部可折叠（整组折叠语义已移除）。
   */
  defaultCollapsed?: boolean
  /** 调用方期望的子任务总数——反查窗口期补 skeleton，避免计数 lie。 */
  expectedCount?: number
}

const ROW_COLLAPSE_THRESHOLD = 8
const ROW_COLLAPSE_VISIBLE = 5

export const SubagentAggregateView: React.FC<SubagentAggregateViewProps> = ({ sessionId, runs, expectedCount }) => {
  const { t } = useTranslation('chat')
  const executionSpaceId = useSpaceIdForSession(sessionId)

  // 模板 badge 解析：名字优先用 live run 自带的 templateName，否则用 templateId 反查
  // 当前 Space 模板列表；显示颜色（display_color）一律按 templateId 反查（run 不带色）。
  // 只要有带 templateId 的 run 就触发拉取（含 live——它虽有名但没色）。
  const templateSpaceId = useSpaceStore((s) => s.selectedSpace?.id)
  const needsTemplateResolve = runs.some((r) => !!r.templateId?.trim())
  const templateMeta = useSubagentTemplateMeta(templateSpaceId, needsTemplateResolve)
  const resolveTemplateBadge = useCallback(
    (run: SubagentRun): { name: string; color?: string } | undefined => {
      const id = run.templateId?.trim()
      const meta = id ? templateMeta.get(id) : undefined
      const name = run.templateName?.trim() || meta?.name
      if (!name) return undefined
      // 模板未配置颜色（历史模板 / 没点色板）→ 用默认色，保证 badge 始终带色。
      return {
        name,
        color: meta?.color?.trim() || DEFAULT_TEMPLATE_BADGE_COLOR,
      }
    },
    [templateMeta],
  )

  const displayCount = Math.max(runs.length, expectedCount ?? runs.length)
  const skeletonCount = Math.max(0, displayCount - runs.length)

  const [showAllRows, setShowAllRows] = useState(false)
  const shouldCollapseRows = displayCount >= ROW_COLLAPSE_THRESHOLD && !showAllRows
  const hiddenRowCount = shouldCollapseRows ? Math.max(0, displayCount - ROW_COLLAPSE_VISIBLE) : 0
  const toggleRowsExpanded = useCallback(() => setShowAllRows((p) => !p), [])

  // 就地展开：点某行 → 在该行正下方展开该子 Agent 的完整执行流（SubagentDetailPane）。
  // 手风琴单选——expandedRunId 记当前展开的 run，点同一行收起、点另一行切换；一次
  // 只展开一个，避免多个固定高面板同时占高 + 同时跑实时订阅。
  // sessionId 为 null（草稿态）时不可展开——SubagentDetailPane 拼不出 IPC 路径。
  const disclosureOwnerKey = [sessionId ?? 'draft', runs[0]?.dispatchedByRunId ?? 'main', runs[0]?.parentToolCallId ?? runs[0]?.subagentRunId ?? 'subagent-group'].join(':')
  const { expandedRunId, toggle: toggleDisclosure, collapse: collapseDisclosure } = useSubagentDisclosure(disclosureOwnerKey)
  const handleToggle = useCallback(
    (subagentRunId: string) => {
      if (!sessionId) return
      toggleDisclosure(subagentRunId)
    },
    [sessionId, toggleDisclosure],
  )

  const visibleRuns = shouldCollapseRows ? runs.slice(0, ROW_COLLAPSE_VISIBLE) : runs

  // 入场动效：首屏已有行视为历史（不播）；之后新增的行才挂 enter class。
  // 「展开剩余」只是显隐，不重播——seen 在首帧已收录全部 runs。
  const seenRowKeysRef = useRef<Set<string> | null>(null)
  const enterTimersRef = useRef(new Map<string, number>())
  const [enteringKeys, setEnteringKeys] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const keys = runs.map(rowMotionKey)
    if (seenRowKeysRef.current == null) {
      seenRowKeysRef.current = new Set(keys)
      return
    }
    const fresh = keys.filter((key) => !seenRowKeysRef.current!.has(key))
    if (fresh.length === 0) return
    for (const key of fresh) seenRowKeysRef.current.add(key)
    setEnteringKeys((prev) => {
      const next = new Set(prev)
      for (const key of fresh) next.add(key)
      return next
    })
    for (const key of fresh) {
      const timer = window.setTimeout(() => {
        enterTimersRef.current.delete(key)
        setEnteringKeys((prev) => {
          if (!prev.has(key)) return prev
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }, SUBAGENT_ENTER_MS)
      enterTimersRef.current.set(key, timer)
    }
  }, [runs])
  useEffect(
    () => () => {
      for (const timer of enterTimersRef.current.values()) window.clearTimeout(timer)
      enterTimersRef.current.clear()
    },
    [],
  )

  return (
    <div className="group/agg" data-testid="subagent-aggregate-view">
      {/* 叙事锚点：派发了 N 个子任务——与「思考」折叠行同款静态样式（图标 + 次级文字、
          text-body）。它是不可点的叙事标记，故用 div 而非 button，与下方子任务列表
          卡片在视觉上分开。 */}
      <div className="flex items-center gap-1.5 py-0.5 text-body" data-testid="subagent-dispatch-header">
        <SubagentOrchestrationIcon />
        <span className="min-w-0 truncate text-muted-foreground/60">
          {t('subagent.dispatch.header', {
            count: displayCount,
            defaultValue: `派发了 ${displayCount} 个子任务`,
          })}
        </span>
      </div>

      {/* 子任务列表卡片：维持卡片样式（近白底 + 边框），圆角加大到 rounded-xl；
          与上方派发头分开（mt-1）。 */}
      <div
        className={cn(
          'mt-0.5 rounded-2xl px-2.5 py-2',
          // 更显眼 + 更白：浅色用干净的近白卡片面（bg-card，去掉 muted 的灰调）；
          // 深色用一层提亮的白色蒙版（foreground 在深色是浅色，低透明度叠出更亮的面板）。
          'bg-card dark:bg-foreground/[0.08]',
        )}
        data-testid="subagent-aggregate-list"
      >
        <div className="space-y-1">
          {visibleRuns.map((run) => {
            const isExpanded = expandedRunId === run.subagentRunId
            const badge = resolveTemplateBadge(run)
            const motionKey = rowMotionKey(run)
            const motionEnter = enteringKeys.has(motionKey)
            return (
              // key 用 parentToolCallId 锚点（组内唯一 + optimistic→real 稳定不 remount）；
              // 跨 owner 撞车已由 BlockTimeline 的 sibling→subagentRunId 反查在「选哪些 run
              // 进本组」时解决，组内不会再有重复锚点。缺 parentToolCallId 时退化 subagentRunId。
              <div key={motionKey}>
                {/* ：嵌套孙代理时按 sticky stack 累加 top，避免多层 top-0 重叠 */}
                <SubagentStickyHeaderShell
                  sticky={isExpanded}
                  className={cn(isExpanded && 'bg-card dark:bg-background')}
                  nested={
                    isExpanded && sessionId ? (
                      <SubagentInlineDetail
                        subagentRunId={run.subagentRunId}
                        parentSessionId={sessionId}
                        parentToolCallId={run.parentToolCallId}
                        onClose={collapseDisclosure}
                      />
                    ) : undefined
                  }
                >
                  <SubagentDispatchRow
                    run={run}
                    sessionId={sessionId}
                    templateBadge={badge?.name}
                    templateBadgeColor={badge?.color}
                    isExpanded={isExpanded}
                    spaceId={executionSpaceId}
                    onToggle={handleToggle}
                    motionEnter={motionEnter}
                  />
                </SubagentStickyHeaderShell>
              </div>
            )
          })}
          {!shouldCollapseRows && Array.from({ length: skeletonCount }).map((_, idx) => <SubagentSkeletonRow key={`skeleton-${idx}`} />)}
        </div>

        {/* 超量折叠：≥8 行默认只显前 5，其余「展开剩余 N 个」。 */}
        {displayCount >= ROW_COLLAPSE_THRESHOLD && (
          <button
            type="button"
            onClick={toggleRowsExpanded}
            className="mt-0.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-caption text-muted-foreground/60 transition-colors hover:bg-muted/20 hover:text-foreground"
            data-testid="subagent-aggregate-rows-toggle"
            aria-expanded={showAllRows}
          >
            {showAllRows ? (
              <>
                <ChevronDown className="h-3 w-3" />
                {t('subagent.aggregate.rowsCollapse', { defaultValue: '收起' })}
              </>
            ) : (
              <>
                <ChevronRight className="h-3 w-3" />
                {t('subagent.aggregate.rowsExpand', {
                  count: hiddenRowCount,
                  defaultValue: `展开剩余 ${hiddenRowCount} 个`,
                })}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

SubagentAggregateView.displayName = 'SubagentAggregateView'
