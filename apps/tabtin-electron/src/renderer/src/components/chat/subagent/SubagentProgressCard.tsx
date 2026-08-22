/**
 * SubagentProgressCard — 子 Agent「派发标记」单卡（registry 兜底路径）
 *
 * 轻量派发条目：状态字形 + 标题 + 模型 + 进展摘要；点行就地展开完整执行流
 *（SubagentInlineDetail）。对话主路径走 SubagentAggregateView；本组件是
 * ToolStepCard registry 兜底，视觉对齐主路径（含  活跃态活动感）。
 *
 * Also registers a CardRendererProps adapter for the registry.
 */

import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { useSubagentCancelState } from './useSubagentCancelState'
import type { CardRendererProps } from '../registry/types'
import type { SubagentCardData } from '@tabtin/chat-client'
import { CARD_RADIUS, CARD_HEADER_PADDING, TEXT, TEXT_COLOR, ICON_SIZE } from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { SpeakerBadge } from '../message'
import { MARKER_STATUS_GLYPH, MARKER_STATUS_FALLBACK, SUBAGENT_ACTIVE_STATUSES } from './subagentMarkerStatus'
import { getToolDisplayName, type ChatTranslate } from '../registry/toolDisplayName'
import { useModelDisplayName } from '../model/useModelDisplayName'
import { SubagentInlineDetail } from './SubagentInlineDetail'
import { useSubagentDisclosure } from './SubagentDisclosureContext'
import { SubagentStickyHeaderShell } from './SubagentStickyStackContext'
import { ShinyText } from '../markdown/ShinyText'
import { useRunningSubagentElapsed } from './useRunningSubagentElapsed'

/**
 * P0-2：失败分类（cancelled/timeout/failed）。卡片自身不再渲染本地化错误详情
 * （已移到 modal 的 SubagentDetailPane 失败摘要 banner），但 prop 保留供调用方
 * 透传、未来其他消费方使用。
 */
type SubagentErrorKind = 'cancelled' | 'timeout' | 'failed'

interface ToolStep {
  tool_name: string
  tool_call_id?: string
  success: boolean
  elapsed_ms: number
  input_summary?: string
  output_summary?: string
  input_detail?: string
  output_detail?: string
  error?: string | null
}

interface SubagentProgressCardProps {
  subagentRunId: string
  label?: string
  task?: string
  model?: string
  appId?: string
  /** PRD 06 §5.1.2：关联的 speaker_id，用于查询 SpeakerBadge 身份 */
  speakerId?: string
  /** 所属 session，SpeakerBadge 按 session 隔离查询 */
  sessionId?: string | null
  /**
   * W1 三视角 review · P1 修复 3：'unknown' 中性兜底——tool_use(agent) 已 finalize
   * 但本地 store 拿不到对应 SubagentRun（刷新前事件未持久化 / 历史回放索引未拉 /
   * daemon 异常未发 COMPLETED）。兜 'unknown' 显示中性灰 + "状态同步中"，不夸大
   * 也不掩盖；并隐藏 drill-in（没东西可看）。
   *
   * W4：'queued' —— 子 Agent 进 BudgetTracker 排队等 active 槽位。
   */
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  startedAt?: number
  endedAt?: number
  summary?: string
  error?: string
  /** P0-2：失败分类，供调用方透传（卡片自身不再渲染本地化错误，详情见 modal） */
  errorKind?: SubagentErrorKind
  /** P0-2：timeout 分支专用（详情渲染已移到 modal） */
  timeoutMs?: number
  stats?: {
    duration_ms?: number
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    /** PRD-04 Wave 5 任务 4：子 Agent 累计消耗积分（来自 BudgetTracker scope credits） */
    credits_consumed?: number
  }
  stepCount?: number
  latestTool?: string
  latestToolInput?: string
  latestSuccess?: boolean
  /**
   * W1 三视角 review · P0 修复 2：当前 latestTool 的生命阶段。
   * - 'pending'   → 工具刚启动，未出结果（头部用 spinner，不显示 ✓/✗）
   * - 'completed' → 已完成成功
   * - 'failed'    → 已完成失败
   * 缺省 → 走旧逻辑（按 latestSuccess 显示 ✓/✗），兼容旧 daemon。
   */
  latestToolStatus?: 'pending' | 'completed' | 'failed'
  toolHistory?: ToolStep[]
  elapsedMs?: number
  onCancel?: (subagentRunId: string) => void
  /**
   * W4c · W4b P1-b：服务端 ACK 前的"取消中"状态——本卡片显示文字而不是 X 按钮。
   * 由 SubagentProgressCardRenderer 从 store 读取并透传。null/undefined 等价 false。
   */
  isCancelling?: boolean
}

const TEXT_TRUNCATE_LIMIT = 96

function compactText(value: string | undefined, limit = TEXT_TRUNCATE_LIMIT): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function getStatusLabel(t: ChatTranslate, status: SubagentProgressCardProps['status']): string {
  const fallback: Record<SubagentProgressCardProps['status'], string> = {
    pending: '已派发',
    queued: '排队中',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    unknown: '状态同步中',
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

function buildProgressText(props: SubagentProgressCardProps, t: ChatTranslate): string {
  if (props.status === 'queued') {
    return t('subagent.inline.progressQueued', {
      defaultValue: '等待空闲执行槽',
    })
  }
  if (props.status === 'pending') {
    return t('subagent.inline.progressPending', { defaultValue: '等待结果' })
  }
  if (props.status === 'running') {
    const stepText =
      props.stepCount && props.stepCount > 0
        ? t('subagent.steps', {
            count: props.stepCount,
            defaultValue: `${props.stepCount} 步`,
          })
        : undefined
    const toolText = props.latestTool ? getToolDisplayName(t, props.latestTool) : undefined
    const toolInput = compactText(props.latestToolInput, 56)
    const activeToolText = toolText ? (toolInput ? `${toolText} · ${toolInput}` : toolText) : undefined
    const duration = formatDuration(props.elapsedMs)
    return [stepText, activeToolText, duration].filter(Boolean).join(' · ') || t('subagent.inline.progressRunning', { defaultValue: '正在执行' })
  }
  if (props.status === 'completed') {
    const summary = compactText(props.summary, 72)
    if (summary) return summary
    const stepText =
      props.stepCount && props.stepCount > 0
        ? t('subagent.steps', {
            count: props.stepCount,
            defaultValue: `${props.stepCount} 步`,
          })
        : undefined
    const duration = formatDuration(props.stats?.duration_ms ?? props.elapsedMs)
    return [stepText, duration].filter(Boolean).join(' · ') || t('subagent.inline.progressCompleted', { defaultValue: '任务已完成' })
  }
  if (props.status === 'failed') {
    return (
      compactText(props.error, 72) ||
      t('subagent.inline.progressFailed', {
        defaultValue: '执行失败，点开查看原因',
      })
    )
  }
  if (props.status === 'cancelled') {
    return t('subagent.inline.progressCancelled', {
      defaultValue: '已停止执行',
    })
  }
  return t('subagent.inline.progressUnknown', { defaultValue: '正在同步状态' })
}

/* ─── 主组件 ─────────────────────────────────────────────────── */

export const SubagentProgressCard: React.FC<SubagentProgressCardProps> = (props) => {
  const { subagentRunId, label, task, model, appId, speakerId, sessionId, status } = props
  const { t } = useTranslation('chat')
  const glyph = MARKER_STATUS_GLYPH[status] || MARKER_STATUS_FALLBACK
  const StatusIcon = glyph.Icon

  // agent.description → runtime label，是主 Agent 生成的短标题；prompt/task 不默认顶
  // 到标题上，避免在阅读流里塞大段 prompt。
  const displayLabel = compactText(label, 72) || appId || `${t('subagent.tab.fallbackTitle', { defaultValue: '子 Agent' })} · ${subagentRunId.slice(0, 4)}`
  // model 是模型 id（runtime 解析出的 childModel）；解析成显示名再截断。
  const modelText = compactText(useModelDisplayName(model), 44)
  const statusText = getStatusLabel(t, status)
  const displayElapsedMs = useRunningSubagentElapsed({
    anchorKey: subagentRunId,
    status,
    startedAt: props.startedAt,
    elapsedMs: props.elapsedMs,
  })
  const progressText = buildProgressText({ ...props, elapsedMs: displayElapsedMs }, t)
  const isActive = SUBAGENT_ACTIVE_STATUSES.has(status)
  const statusProgressText = [statusText, progressText].filter(Boolean).join(' · ')

  /**
   * inline 展开：点击整行（或右侧 chevron）在卡片正下方就地展开该子 Agent 与主
   * 对话同款的完整执行流（复用 SubagentInlineDetail / SubagentDetailPane）。
   * 'unknown'（没东西可看）/ sessionId 为 null（草稿态，拼不出 IPC 路径）→ 不可展开。
   */
  const canExpand = status !== 'unknown' && !!sessionId
  const disclosureOwnerKey = `${sessionId ?? 'draft'}:single:${subagentRunId}`
  const { expandedRunId, toggle: toggleDisclosure, collapse: collapseDisclosure } = useSubagentDisclosure(disclosureOwnerKey)
  const expanded = expandedRunId === subagentRunId
  const handleToggle = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!canExpand) return
    toggleDisclosure(subagentRunId)
  }

  return (
    <div className={cn(CARD_RADIUS, TEXT.body)}>
      {/* ：与 AggregateView 共用 sticky stack，嵌套时累加 top */}
      <SubagentStickyHeaderShell
        sticky={expanded}
        className={cn(expanded && 'bg-card dark:bg-background')}
        nested={
          expanded && canExpand && sessionId ? (
            <SubagentInlineDetail subagentRunId={subagentRunId} parentSessionId={sessionId} onClose={collapseDisclosure} />
          ) : undefined
        }
      >
        <div
          role={canExpand ? 'button' : undefined}
          tabIndex={canExpand ? 0 : undefined}
          aria-expanded={canExpand ? expanded : undefined}
          aria-disabled={!canExpand || undefined}
          className={cn(
            'flex w-full min-w-0 select-none items-start gap-2',
            CARD_HEADER_PADDING.x,
            'py-1 text-left',
            canExpand ? 'cursor-pointer hover:bg-muted/15' : 'cursor-default',
            expanded && 'bg-muted/15',
            CARD_RADIUS,
          )}
          data-subagent-status={status}
          data-subagent-expanded={expanded || undefined}
          onClick={canExpand ? () => handleToggle() : undefined}
          onKeyDown={
            canExpand
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleToggle()
                  }
                }
              : undefined
          }
        >
          {/* 状态字形静态；活跃感交给下方进展 ShinyText（有扫光不转圈）。 */}
          <StatusIcon className={cn(ICON_SIZE.status, 'mt-0.5 flex-shrink-0', glyph.tone)} />

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn(TEXT.header, TEXT_COLOR.secondary, 'min-w-0 truncate')}>{displayLabel}</span>
              {speakerId && <SpeakerBadge sessionId={sessionId} speakerId={speakerId} />}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground/60">
              {modelText && <span className="shrink-0 truncate">{modelText}</span>}
              {modelText && statusProgressText && (
                <span className="shrink-0" aria-hidden>
                  ·
                </span>
              )}
              {statusProgressText &&
                (isActive ? (
                  <ShinyText className="min-w-0 truncate">{statusProgressText}</ShinyText>
                ) : (
                  <span className="min-w-0 truncate">{statusProgressText}</span>
                ))}
            </div>
          </div>

          {/*
           * 展开指示：除 'unknown' 外都给 chevron（收起指右、展开指下，平滑旋转）。
           * 没 sessionId 时 disabled——SubagentDetailPane 需要 parentSessionId 拼 IPC 路径。
           * 整行也可点（onClick handleToggle），此按钮是显式 affordance，
           * stopPropagation 防与整行点击重复触发。
           */}
          {status !== 'unknown' && (
            <button
              type="button"
              className={cn(
                'p-0.5 rounded transition-colors flex-shrink-0',
                !canExpand ? `${TEXT_COLOR.faint} opacity-40 cursor-not-allowed` : `${TEXT_COLOR.faint} hover:bg-muted/40 hover:text-foreground`,
              )}
              onClick={handleToggle}
              disabled={!canExpand}
              aria-label={expanded ? t('subagent.inline.collapse', { defaultValue: '收起' }) : t('subagent.inline.expand', { defaultValue: '展开执行流' })}
              title={
                !canExpand
                  ? t('subagent.drawer.viewFullDisabledNoSession', {
                      defaultValue: '需要会话上下文才能打开',
                    })
                  : expanded
                    ? t('subagent.inline.collapse', { defaultValue: '收起' })
                    : t('subagent.inline.expand', { defaultValue: '展开执行流' })
              }
              data-testid="subagent-card-drill-in"
            >
              <ChevronDown className={cn(ICON_SIZE.md, 'transition-transform duration-200', !expanded && '-rotate-90')} />
            </button>
          )}
        </div>
      </SubagentStickyHeaderShell>
    </div>
  )
}

/**
 * CardRendererProps adapter — used by the card registry when rendering
 * SubagentProgressCard through the generic ToolStepCard expansion path.
 *
 * W4c · R3-P1-7：通过共享 hook `useSubagentCancelState` 读 cancel handler +
 * isCancelling 双源——避免与 SubagentBlockEntry（blocks/ToolUseBlockView）双源
 * selector 逻辑漂移。
 */
const SubagentProgressCardRenderer: React.FC<CardRendererProps> = ({ input, output, durationMs }) => {
  const raw = (output ?? input ?? {}) as Record<string, unknown>
  const kwargs = (raw.kwargs ?? raw) as Record<string, unknown>
  const subagentData = (kwargs as unknown as SubagentCardData) ?? {}
  const subagentRunId = String(subagentData.subagent_run_id ?? kwargs.subagent_run_id ?? '')
  // 从 kwargs / subagentData 推主 session id（card 实例可拿到的最近线索）。
  const sessionId = (kwargs.session_id as string | undefined) ?? ((subagentData as unknown as Record<string, unknown>).session_id as string | undefined) ?? null

  const { cancelSubagentRun, isCancelling } = useSubagentCancelState(subagentRunId, sessionId)

  return (
    <SubagentProgressCard
      subagentRunId={subagentRunId}
      label={String(subagentData.label ?? kwargs.label ?? '')}
      task={subagentData.task as string | undefined}
      model={((subagentData as unknown as Record<string, unknown>).model as string | undefined) ?? (kwargs.model as string | undefined)}
      appId={(kwargs.app_id as string | undefined) ?? undefined}
      sessionId={sessionId}
      status={(subagentData.status as SubagentProgressCardProps['status']) ?? 'pending'}
      startedAt={(subagentData.started_at ?? kwargs.started_at) as number | undefined}
      endedAt={(subagentData.ended_at ?? kwargs.ended_at) as number | undefined}
      summary={subagentData.summary as string | undefined}
      error={subagentData.error as string | undefined}
      stepCount={subagentData.step_count as number | undefined}
      latestTool={subagentData.latest_tool as string | undefined}
      latestToolInput={(subagentData as unknown as Record<string, unknown>).latest_tool_input as string | undefined}
      latestSuccess={(kwargs.latest_success as boolean | undefined) ?? undefined}
      toolHistory={subagentData.tool_history as ToolStep[] | undefined}
      stats={subagentData.stats}
      elapsedMs={durationMs}
      onCancel={cancelSubagentRun}
      isCancelling={isCancelling}
    />
  )
}

SubagentProgressCardRenderer.displayName = 'SubagentProgressCardRenderer'

registerCardRenderer('SubagentProgressCard', SubagentProgressCardRenderer)
