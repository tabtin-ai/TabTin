import React, { useCallback } from 'react'
import { Circle, Loader2, PenLine, ListChecks, Shield, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { useChatStore } from '@/stores/chat/useChatStore'
import {
  isChatSessionRunState,
  useSessionRunProjection,
} from '@/stores/chat/execution/sessionRunProjection'
import { useWsConnectionStore } from '@/stores/useWsConnectionStore'
import { resolveSessionDisplayStatus, type SessionDisplayStatus } from '@/utils/chat-session-status'
import { resolveMessageErrorState } from '../message'
import {
  isBalanceBillingErrorClass,
  isResolvedBalanceBillingErrorMessage,
} from '@/lib/clearBalanceBillingChatErrors'
import type { ChatSession } from '@tabtin/chat-client'
import { SIDEBAR_ROW_STATUS_ICON_CLASS } from '@components/layout/sidebarUi'

interface SessionStatusIconProps {
  session: ChatSession
  className?: string
  /** 会话「完成但未读」时，idle 态用主题色圆点提示（未读圆点提示）。 */
  unread?: boolean
}

const StatusDot: React.FC<{ status: SessionDisplayStatus; unread?: boolean; className?: string }> = ({ status, unread, className }) => {
  const { t } = useTranslation('chat')
  switch (status) {
    case 'streaming':
      // streaming 是"活跃 / 在跑"语义——用 accent 而不是 success 绿。绿色保留给"已完成"语义。
      return <Loader2 className={cn(SIDEBAR_ROW_STATUS_ICON_CLASS, 'text-accent animate-spin', className)} />
    case 'suspended':
      return <Loader2 className={cn(SIDEBAR_ROW_STATUS_ICON_CLASS, 'text-warning/80 animate-spin', className)} />
    case 'pending':
      // pending = 等用户操作（审批 / askUser）→ warning 语义
      return <Circle className={cn(SIDEBAR_ROW_STATUS_ICON_CLASS, 'fill-warning/60 text-warning/80', className)} />
    case 'paused':
      return (
        <Circle
          className={cn(SIDEBAR_ROW_STATUS_ICON_CLASS, 'fill-warning/20 text-warning/80', className)}
          aria-label={t('sessionList.lastRunPaused', { defaultValue: '运行已暂停' })}
        />
      )
    case 'failed':
      // ：最近一轮 Agent 跑挂——destructive 色警告点，与 TrackerSessionIcon
      // 的 run_status==='failed' → text-destructive/80 同款语言。让侧栏能看出"上次
      // 失败了"，区别于正常结束的 idle（CheckCircle2 muted/60）。
      return (
        <AlertCircle
          className={cn(SIDEBAR_ROW_STATUS_ICON_CLASS, 'text-destructive/80', className)}
          aria-label={t('sessionList.lastRunFailed', { defaultValue: '上次运行失败' })}
        />
      )
    case 'draft':
      return <PenLine className={cn(SIDEBAR_ROW_STATUS_ICON_CLASS, 'text-muted-foreground/40', className)} />
    case 'neutral':
      return null
    case 'idle':
      // 「对话已结束（非 streaming/pending）」即完成态。
      // - 未读（Agent 干完但你还没看）→ 主题色圆点提示（未读圆点提示）。
      // - 已读 → 不显示任何图标：完成是列表常态，装饰性图标只会制造噪音。
      // 图标槽位在调用处固定 16px（SIDEBAR_LIST_ICON_SLOT），不影响标题左对齐。
      if (unread) {
        return (
          <span
            className={cn('flex items-center justify-center', SIDEBAR_ROW_STATUS_ICON_CLASS, className)}
            role="img"
            aria-label={t('sessionList.completedUnread', { defaultValue: '运行已完成，未读' })}
          >
            <span className="h-[7px] w-[7px] rounded-full bg-accent" />
          </span>
        )
      }
      return null
  }
}

/**
 * Wave 5 (charter v1.8 §6.7 表达点 #2): 会话列表 icon — Tracker Run 关联会话视觉区分。
 * 不同 run_status 映射不同色调;origin 决定 icon 形状,user_created vs system_preset 必须可视区分。
 * trackerIcon marker for grep validation.
 *
 * P0-5 修复: charter §6.7 #2 是无条件 hard requirement —
 * `user_created` Tracker 与 `system_preset` Tracker 标识需可区分。即使本期不启用
 * system_preset,也必须现在写好,否则 charter 缺口永远在(总控反思 13/14 同源教训)。
 *
 * 视觉策略:
 *   - user_created  → ListChecks  (常规清单图标,与用户手动建的"任务清单"心智一致)
 *   - system_preset → Shield      (盾牌暗示"系统级",视觉与 ListChecks 截然不同)
 */
const TrackerSessionIcon: React.FC<{ runStatus: string; origin: string; className?: string }> = ({
  runStatus,
  origin,
  className,
}) => {
  // 状态色全部 token 化（point-only：tone 落在 icon 文字色上，跟 banner 圆点同语言）
  // running / failed 不再写死 green-500 / red-500；同主题切换会自动适配（accent 蓝 / 玫红 / 橙 等）
  let tone = 'text-muted-foreground/60'
  if (runStatus === 'running' || runStatus === 'in_progress') tone = 'text-success/80'
  else if (runStatus === 'failed' || runStatus === 'error') tone = 'text-destructive/80'
  else if (runStatus === 'success' || runStatus === 'completed') tone = 'text-muted-foreground/80'
  else if (runStatus === 'cancelled' || runStatus === 'canceled') tone = 'text-muted-foreground/60'

  // P0-5: origin 决定 icon 形状(charter §6.7 #2 hard requirement).
  // 注:本期 system_preset 不会出现实例(总控 §1 #5 不做),但 charter 履约就位 —
  // 一旦未来启用,无需再改本组件即可视觉区分。
  const Icon = origin === 'system_preset' ? Shield : ListChecks
  const ariaLabel = origin === 'system_preset' ? '系统自动化任务 Run' : '自动化任务 Run'

  return (
    <Icon
      className={cn(SIDEBAR_ROW_STATUS_ICON_CLASS, tone, className)}
      data-tracker-origin={origin}
      data-testid="tracker-session-icon"
      aria-label={ariaLabel}
    />
  )
}

export const SessionStatusIcon: React.FC<SessionStatusIconProps> = React.memo(({ session, className, unread }) => {
  const runProjection = useSessionRunProjection(session.id)
  const snapshotRunState = isChatSessionRunState(session.run_state) ? session.run_state : null
  const hasRunStateContract = runProjection?.hasServerSnapshot === true
    || Object.prototype.hasOwnProperty.call(session, 'run_state')
  const authoritativeRunState = runProjection?.authoritativeRunState ?? snapshotRunState
  const effectiveRunStatus = runProjection?.localStatus
    ?? authoritativeRunState?.status
    ?? null
  const streaming = runProjection?.busy === true
  const pendingAsk = useChatStore(s => !!s.pendingAskUserBySessionId[session.id])
  const pendingApproval = useChatStore(s => !!s.pendingApprovalBySessionId[session.id])
  const suspendedSessionIds = useWsConnectionStore(s => s.suspendedSessionIds)
  const resolvedBillingFailure = useChatStore(useCallback(
    (s) => {
      if (
        effectiveRunStatus !== 'failed'
        || !isBalanceBillingErrorClass(authoritativeRunState?.error_class)
      ) {
        return false
      }
      return s.messagesBySessionId[session.id]?.some(isResolvedBalanceBillingErrorMessage) === true
    },
    [authoritativeRunState?.error_class, effectiveRunStatus, session.id],
  ))
  const displayRunStatus = resolvedBillingFailure ? 'completed' : effectiveRunStatus

  // 旧后端兼容：没有 run_state 时才从主时间线最后一条 assistant 消息派生失败。
  // 新后端或本地显式终态均直接返回 false，不再让消息启发式参与正确性判断。
  // bugbot 评审：必须跳过带 subagent_run_id 的子 Agent 消息（与 MessageList 的
  // 主时间线隔离一致，见 MessageList.tsx:212）——否则子 Agent 失败 transcript 留在
  // 同一 session 数组末尾时，主时间线最后可见的 assistant 已成功，侧栏却误显 failed。
  const lastAssistantIsError = useChatStore(useCallback(
    (s) => {
      // 有权威 run_state 或本地显式终态时不再扫描消息启发式。尤其用户取消会把
      // assistant 标成 aborted；继续套 error resolver 会误画成 failed。
      if (displayRunStatus || hasRunStateContract) return false
      const msgs = s.messagesBySessionId[session.id]
      if (!msgs || msgs.length === 0) return false
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role !== 'assistant') continue
        if (m.subagent_run_id) continue
        const errState = resolveMessageErrorState(m)
        return !!(errState.errorClass || errState.errorCategory || errState.isErrorMessage || errState.errorMessage)
      }
      return false
    },
    [displayRunStatus, hasRunStateContract, session.id],
  ))

  // Wave 5 (charter v1.8 §6.7 表达点 #2): Tracker Run 关联的 ChatSession 必须有独立视觉标识
  const trackerRun = session.tracker_run
  if (trackerRun) {
    return (
      <TrackerSessionIcon
        runStatus={trackerRun.run_status}
        origin={trackerRun.tracker_origin}
        className={className}
      />
    )
  }

  const status = resolveSessionDisplayStatus(
    session,
    streaming ? { [session.id]: true } : {},
    pendingAsk ? { [session.id]: true } : {},
    pendingApproval ? { [session.id]: true } : {},
    suspendedSessionIds,
    lastAssistantIsError,
    displayRunStatus,
  )

  // 标题生成失败（title_generation_status=failed）不在列表展示：后台会自动重试，
  // 对用户只保留默认标题即可，避免运维态警告噪音。
  const showUnread = displayRunStatus === null || displayRunStatus === 'completed'
  return <StatusDot status={status} unread={showUnread ? unread : false} className={className} />
})
SessionStatusIcon.displayName = 'SessionStatusIcon'
