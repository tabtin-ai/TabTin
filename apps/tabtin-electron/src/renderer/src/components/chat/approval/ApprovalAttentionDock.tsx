import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  CornerDownLeft,
  Eye,
  Loader2,
  MessageSquarePlus,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  OVERLAY_SURFACE_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import { useScopedInterval } from '@hooks/spaceActivity'
import type { ApprovalRequestState } from '@stores/chat/shared/types'
import {
  getToolDisplayName,
  type ChatTranslate,
} from '../registry/toolDisplayName'
import {
  ApprovalPanel,
  isApprovalHighRisk,
  resolveApprovalWorkspaceZone,
  type ApprovalActionItem,
  type PerToolApprovalDecision,
} from './ApprovalPanel'

const log = createLogger('ApprovalAttentionDock')
const REJECTION_MESSAGE_MAX = 500

interface ApprovalAttentionDockProps {
  approval: ApprovalRequestState
  onSubmit?: (decisions: PerToolApprovalDecision[]) => void
  isSubmitting?: boolean
  onDismiss?: (reason: 'expired' | 'manual') => void
  composerVisible: boolean
  onToggleComposer: () => void
}

function resolveDeadline(approval: ApprovalRequestState): number | null {
  if (approval.expiresAt) return approval.expiresAt
  if (approval.interruptedAt && approval.approvalTtlSeconds) {
    return (approval.interruptedAt + approval.approvalTtlSeconds) * 1000
  }
  return null
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}:${String(remaining).padStart(2, '0')}`
}

interface ApprovalAttentionView {
  actions: ApprovalActionItem[]
  canResolve: boolean
  hasHighRisk: boolean
  hasOutsideWorkspace: boolean
  hasSensitivePath: boolean
  requiresDetailedReview: boolean
  summary: string
  ownerLabel: string
}

/**
 * ：Dock 一行摘要只展示工具名（如「终端」），不吃 ask_hint /
 * description 里可能出现的整段 JSON args。
 */
function createApprovalAttentionView(
  approval: ApprovalRequestState,
  t: ChatTranslate,
): ApprovalAttentionView {
  const actions = approval.actionRequests as ApprovalActionItem[]
  const hasHighRisk = actions.some(isApprovalHighRisk)
  const hasOutsideWorkspace = actions.some(
    action => resolveApprovalWorkspaceZone(action) === 'outside',
  )
  const hasSensitivePath = actions.some(
    action => resolveApprovalWorkspaceZone(action) === 'sensitive',
  )
  const requiresDetailedReview = actions.length !== 1
    || hasHighRisk
    || hasOutsideWorkspace
    || hasSensitivePath
  const firstAction = actions[0]
  const firstToolLabel = getToolDisplayName(
    t,
    firstAction?.tool_name || firstAction?.name,
  )
  const summary = actions.length > 1
    ? t('approval.attentionDock.multipleSummary', {
        first: firstToolLabel,
        count: actions.length,
        defaultValue: '{{first}} 等 {{count}} 项操作',
      })
    : firstToolLabel

  return {
    actions,
    canResolve: approval.canResolve !== false,
    hasHighRisk,
    hasOutsideWorkspace,
    hasSensitivePath,
    requiresDetailedReview,
    summary,
    ownerLabel: approval.teamSpaceExecution?.executionOwnerDisplayName?.trim()
      || t('approval.executionOwnerFallback', { defaultValue: 'Owner' }),
  }
}

function approvalStatusLabel(
  t: ChatTranslate,
  isExpired: boolean,
  isSubmitting: boolean,
): string {
  if (isExpired) {
    return t('approval.attentionDock.expired', { defaultValue: '审批已过期' })
  }
  if (isSubmitting) {
    return t('approval.attentionDock.submitting', { defaultValue: '正在提交…' })
  }
  return t('approval.attentionDock.title', { defaultValue: '需要确认' })
}

const ReadonlyApprovalDock: React.FC<{
  ownerLabel: string
  t: ChatTranslate
}> = ({ ownerLabel, t }) => (
  <div
    className="relative flex min-h-11 items-center gap-3 overflow-hidden rounded-[12px] bg-background/95 px-3 py-2"
    data-testid="approval-attention-dock"
    role="status"
  >
    <Clock3 className="h-4 w-4 shrink-0 text-warning" aria-hidden />
    <div className="min-w-0 flex-1">
      <p className="truncate text-body font-medium text-foreground">
        {t('approval.attentionDock.waitingOwner', {
          owner: ownerLabel,
          defaultValue: '等待 {{owner}} 审批',
        })}
      </p>
      <p className="truncate text-caption text-muted-foreground/60">
        {t('approval.attentionDock.waitingOwnerHint', {
          defaultValue: '你可以继续输入，消息会在审批处理后发送',
        })}
      </p>
    </div>
  </div>
)

const ApprovalDockStatusIcon: React.FC<{
  isSubmitting: boolean
  hasHighRisk: boolean
}> = ({ isSubmitting, hasHighRisk }) => {
  if (isSubmitting) {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" aria-hidden />
  }
  if (hasHighRisk) {
    return <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
  }
  return <ShieldCheck className="h-4 w-4 shrink-0 text-warning" aria-hidden />
}

const ApprovalDockHeadline: React.FC<{
  view: ApprovalAttentionView
  approval: ApprovalRequestState
  isExpired: boolean
  isSubmitting: boolean
  t: ChatTranslate
}> = ({ view, approval, isExpired, isSubmitting, t }) => (
  <div className="min-w-0 flex-1">
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-body font-medium text-foreground">
        {approvalStatusLabel(t, isExpired, isSubmitting)}
      </span>
      {view.actions.length > 1 && (
        <span className="shrink-0 rounded-interactive bg-muted/60 px-1.5 py-0.5 text-caption text-muted-foreground/80">
          {t('approval.attentionDock.count', {
            count: view.actions.length,
            defaultValue: '{{count}} 项',
          })}
        </span>
      )}
      {view.hasHighRisk && (
        <span className="shrink-0 rounded-interactive bg-muted/60 px-1.5 py-0.5 text-caption text-destructive">
          {t('approval.attentionDock.highRisk', { defaultValue: '高风险' })}
        </span>
      )}
      {view.hasSensitivePath && (
        <span className="shrink-0 rounded-interactive bg-muted/60 px-1.5 py-0.5 text-caption text-destructive">
          {t('approval.zoneSensitive', { defaultValue: '敏感路径' })}
        </span>
      )}
      {view.hasOutsideWorkspace && !view.hasSensitivePath && (
        <span className="shrink-0 rounded-interactive bg-muted/60 px-1.5 py-0.5 text-caption text-warning">
          {t('approval.zoneOutside', { defaultValue: '工作区外' })}
        </span>
      )}
    </div>
    <p className="truncate text-caption text-muted-foreground/60" title={view.summary}>
      {approval.submitError
        ? t('approval.attentionDock.submitError', {
            defaultValue: '提交失败，请查看详情后重试',
          })
        : view.summary}
    </p>
  </div>
)

const ApprovalDetailsPopover: React.FC<{
  approval: ApprovalRequestState
  actions: ApprovalActionItem[]
  ownsDecision: boolean
  detailsOpen: boolean
  setDetailsOpen: (open: boolean) => void
  onSubmit?: (decisions: PerToolApprovalDecision[]) => void
  onDismiss?: (reason: 'expired' | 'manual') => void
  isSubmitting: boolean
  t: ChatTranslate
}> = ({
  approval,
  actions,
  ownsDecision,
  detailsOpen,
  setDetailsOpen,
  onSubmit,
  onDismiss,
  isSubmitting,
  t,
}) => (
  <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
    <PopoverTrigger asChild>
      <button
        type="button"
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1 rounded-interactive px-2',
          'text-body text-muted-foreground transition-colors',
          'hover:bg-foreground/[0.03] hover:text-foreground',
          ownsDecision && 'border border-border/60 bg-background font-medium text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        )}
        title={ownsDecision
          ? t('approval.attentionDock.reviewAndDecide', { defaultValue: '审阅并决定' })
          : t('approval.attentionDock.details', { defaultValue: '查看详情' })}
        aria-label={detailsOpen
          ? t('approval.attentionDock.hideDetails', { defaultValue: '收起详情' })
          : ownsDecision
            ? t('approval.attentionDock.reviewAndDecide', { defaultValue: '审阅并决定' })
            : t('approval.attentionDock.details', { defaultValue: '查看详情' })}
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
        <span
          className={cn(
            !ownsDecision && 'hidden @[340px]/approval-dock:inline',
          )}
        >
          {ownsDecision
            ? t('approval.attentionDock.reviewAndDecide', { defaultValue: '审阅并决定' })
            : t('approval.attentionDock.details', { defaultValue: '详情' })}
        </span>
        <ChevronUp
          className={cn(
            'h-3 w-3 transition-transform',
            !detailsOpen && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
    </PopoverTrigger>
    <PopoverContent
      side="top"
      align="end"
      sideOffset={8}
      className={cn(
        OVERLAY_SURFACE_CLASS,
        'z-dropdown w-[min(38rem,var(--radix-popover-content-available-width))]',
        'max-w-[calc(100vw-1rem)] max-h-[min(64vh,36rem)] overflow-y-auto rounded-interactive p-0',
      )}
    >
      <ApprovalPanel
        sessionId={approval.sessionId}
        actionRequests={actions}
        onSubmit={onSubmit || (() => {})}
        isSubmitting={isSubmitting}
        message={approval.message}
        reviewConfigs={approval.reviewConfigs}
        submitError={approval.submitError}
        interruptedAt={approval.interruptedAt}
        approvalTtlSeconds={approval.approvalTtlSeconds}
        runtimeMode={approval.runtimeMode}
        expiresAt={approval.expiresAt}
        canResolve
        decisionSurface={ownsDecision ? 'panel' : 'external'}
        teamSpaceWaiting={Boolean(approval.teamSpaceExecution)}
        executionOwnerName={approval.teamSpaceExecution?.executionOwnerDisplayName}
        onDismiss={onDismiss ? () => onDismiss('manual') : undefined}
        supportsAlwaysGranularity={approval.approvalSource !== 'platform'}
      />
    </PopoverContent>
  </Popover>
)

const ApprovalDockActions: React.FC<{
  showDecisionActions: boolean
  actionDisabled: boolean
  rejecting: boolean
  rememberChecked: boolean
  rememberScope: 'always' | 'thread'
  showRememberControls: boolean
  showThreadScope: boolean
  showAlwaysScope: boolean
  composerVisible: boolean
  onApprove: () => void
  onRememberCheckedChange: (checked: boolean) => void
  onRememberScopeChange: (scope: 'always' | 'thread') => void
  onReject: () => void
  onToggleComposer: () => void
  t: ChatTranslate
}> = ({
  showDecisionActions,
  actionDisabled,
  rejecting,
  rememberChecked,
  rememberScope,
  showRememberControls,
  showThreadScope,
  showAlwaysScope,
  composerVisible,
  onApprove,
  onRememberCheckedChange,
  onRememberScopeChange,
  onReject,
  onToggleComposer,
  t,
}) => (
  <>
    {showDecisionActions && (
      <>
        <div
          className={cn(
            'inline-flex h-7 shrink-0 items-stretch whitespace-nowrap rounded-interactive',
            showRememberControls && 'border border-border/60 bg-background',
          )}
        >
          {showRememberControls && (
            <button
              type="button"
              onClick={() => onRememberCheckedChange(!rememberChecked)}
              disabled={actionDisabled}
              aria-pressed={rememberChecked}
              data-testid="approval-dock-remember-toggle"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-l-[5px] px-2.5 text-body transition-colors',
                'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground',
                'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                  rememberChecked
                    ? 'border-accent bg-accent text-accent-foreground'
                    : 'border-border bg-background text-transparent',
                )}
              >
                <Check className="h-2.5 w-2.5" strokeWidth={3} />
              </span>
              <span className="hidden @[640px]/approval-dock:inline">
                {(rememberScope === 'thread' && showThreadScope) || !showAlwaysScope
                  ? t('approval.rememberInThread', { defaultValue: '在对话中记住' })
                  : t('approval.rememberInSpace', { defaultValue: '在空间内记住' })}
              </span>
            </button>
          )}

          {showThreadScope && showAlwaysScope && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={actionDisabled}
                  data-testid="approval-dock-remember-scope"
                  aria-label={t('approval.rememberScopeMenu', { defaultValue: '选择记住范围' })}
                  className={cn(
                    'inline-flex items-center px-1 text-muted-foreground transition-colors',
                    'hover:bg-foreground/[0.03] hover:text-foreground',
                    'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  )}
                >
                  <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                sideOffset={6}
                className={cn(
                  OVERLAY_SURFACE_CLASS,
                  'z-dropdown w-36 rounded-interactive p-1',
                )}
              >
                {([
                  { value: 'always' as const, label: t('approval.rememberInSpace', { defaultValue: '在空间内记住' }) },
                  { value: 'thread' as const, label: t('approval.rememberInThread', { defaultValue: '在对话中记住' }) },
                ]).map(option => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={rememberScope === option.value}
                    data-testid={`approval-dock-remember-scope-${option.value}`}
                    onClick={() => onRememberScopeChange(option.value)}
                    className={cn(
                      'flex h-7 w-full items-center justify-between gap-2 rounded-sm px-2',
                      'text-body transition-colors hover:bg-muted/40',
                      rememberScope === option.value ? 'text-foreground' : 'text-foreground/80',
                    )}
                  >
                    {option.label}
                    <Check
                      className={cn(
                        'h-3 w-3 text-accent',
                        rememberScope !== option.value && 'invisible',
                      )}
                    />
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}

          <button
            type="button"
            onClick={onApprove}
            disabled={actionDisabled}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1 bg-accent px-3',
              showRememberControls ? '-m-px rounded-interactive rounded-l-none' : 'rounded-interactive',
              'text-body font-medium text-accent-foreground transition-colors',
              'hover:bg-accent/80 active:scale-[0.98]',
              'disabled:cursor-not-allowed disabled:opacity-60',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            )}
          >
            <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />
            {showRememberControls
              ? t('approval.allow', { defaultValue: '允许' })
              : t('approval.attentionDock.allowOnce', { defaultValue: '允许一次' })}
          </button>
        </div>

        <button
          type="button"
          onClick={onReject}
          disabled={actionDisabled}
          className={cn(
            'inline-flex h-7 shrink-0 items-center rounded-interactive px-2',
            'text-body text-muted-foreground transition-colors',
            'hover:bg-foreground/[0.03] hover:text-destructive active:scale-[0.98]',
            'disabled:cursor-not-allowed disabled:opacity-60',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          )}
        >
          {rejecting
            ? t('approval.attentionDock.confirmReject', { defaultValue: '确认拒绝' })
            : t('approval.reject', { defaultValue: '拒绝' })}
        </button>
      </>
    )}

    <button
      type="button"
      onClick={onToggleComposer}
      aria-label={composerVisible
        ? t('approval.attentionDock.hideComposer', { defaultValue: '收起输入' })
        : t('approval.attentionDock.addInstruction', { defaultValue: '追加指令' })}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-interactive px-2',
        'text-body text-muted-foreground transition-colors',
        'hover:bg-foreground/[0.03] hover:text-foreground active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
      )}
    >
      <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden @[520px]/approval-dock:inline">
        {composerVisible
          ? t('approval.attentionDock.hideComposer', { defaultValue: '收起输入' })
          : t('approval.attentionDock.addInstruction', { defaultValue: '追加指令' })}
      </span>
    </button>
  </>
)

const ApprovalRejectReason: React.FC<{
  visible: boolean
  value: string
  onChange: (value: string) => void
  onCancel: () => void
  t: ChatTranslate
}> = ({ visible, value, onChange, onCancel, t }) => {
  if (!visible) return null
  return (
    <div className="flex min-w-0 items-end gap-2 px-3 pb-2 pl-9">
      <textarea
        value={value}
        onChange={event => onChange(
          event.target.value.slice(0, REJECTION_MESSAGE_MAX),
        )}
        placeholder={t('approval.attentionDock.rejectReason', {
          defaultValue: '可选：告诉 Agent 为什么拒绝',
        })}
        className={cn(
          'min-h-9 min-w-0 flex-1 resize-none rounded-interactive bg-muted/30 px-2.5 py-2',
          'text-body text-foreground placeholder:text-muted-foreground/60',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        )}
        rows={1}
        autoFocus
      />
      <button
        type="button"
        onClick={onCancel}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground"
        aria-label={t('approval.attentionDock.cancelReject', { defaultValue: '取消拒绝' })}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  )
}

export function ApprovalAttentionDock({
  approval,
  onSubmit,
  isSubmitting = false,
  onDismiss,
  composerVisible,
  onToggleComposer,
}: ApprovalAttentionDockProps) {
  const { t } = useTranslation('chat')
  const view = useMemo(
    () => createApprovalAttentionView(approval, t),
    [approval, t],
  )
  const actions = view.actions
  const [detailsOpen, setDetailsOpen] = useState(
    view.requiresDetailedReview || Boolean(approval.submitError),
  )
  const [rejecting, setRejecting] = useState(false)
  const [rejectionMessage, setRejectionMessage] = useState('')
  const [rememberChecked, setRememberChecked] = useState(true)
  const [rememberScope, setRememberScope] = useState<'always' | 'thread'>('always')
  const deadline = useMemo(() => resolveDeadline(approval), [approval])
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(() => (
    deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null
  ))
  const expiredNotifiedRef = useRef(false)

  useEffect(() => {
    setDetailsOpen(view.requiresDetailedReview || Boolean(approval.submitError))
    setRejecting(false)
    setRejectionMessage('')
    setRememberChecked(true)
    setRememberScope('always')
    expiredNotifiedRef.current = false
  }, [
    approval.batchId,
    approval.messageId,
    approval.submitError,
    view.requiresDetailedReview,
  ])

  const updateCountdown = useCallback(() => {
    if (!deadline) {
      setRemainingSeconds(null)
      return
    }
    const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    setRemainingSeconds(next)
    if (next !== 0 || expiredNotifiedRef.current) return
    expiredNotifiedRef.current = true
    log.info('approval_expired', {
      actionCount: actions.length,
      source: approval.approvalSource ?? 'runtime',
    })
    onDismiss?.('expired')
  }, [actions.length, approval.approvalSource, deadline, onDismiss])

  useEffect(() => {
    updateCountdown()
  }, [updateCountdown])

  useScopedInterval(
    updateCountdown,
    deadline && remainingSeconds !== 0 ? 1000 : null,
    { scope: 'hot' },
  )

  const isExpired = remainingSeconds === 0
  const actionDisabled = isSubmitting
    || isExpired
    || !view.canResolve
    || !onSubmit
    || actions.length === 0

  const showThreadScope = useMemo(() => {
    if (actions.length === 0) return true
    return actions.every((action) => {
      const scopes = action.allowed_scopes
      if (!scopes || scopes.length === 0) return true
      return scopes.includes('thread')
    })
  }, [actions])

  const showAlwaysScope = useMemo(() => {
    if (actions.length === 0) return true
    return actions.every((action) => {
      const scopes = action.allowed_scopes
      if (!scopes || scopes.length === 0) return true
      return scopes.includes('always')
    })
  }, [actions])

  const showRememberControls = showThreadScope || showAlwaysScope

  const submitDecision = useCallback((
    decision: 'approve' | 'reject',
    scope: 'once' | 'thread' | 'always' = 'once',
    rejection?: string,
  ) => {
    if (!onSubmit || actionDisabled) return
    const decisions: PerToolApprovalDecision[] = actions.map(action => ({
      request_id: action.request_id,
      tool_call_id: action.tool_call_id,
      decision,
      scope,
      rejection_message: decision === 'reject'
        ? rejection?.trim() || undefined
        : undefined,
    }))
    log.info('approval_decision_submitted', {
      decision,
      scope,
      actionCount: decisions.length,
      surface: 'attention_dock',
    })
    onSubmit(decisions)
  }, [actionDisabled, actions, onSubmit])

  const submitAlwaysAllow = useCallback(async () => {
    if (!onSubmit || actionDisabled) return

    if (approval.approvalSource === 'platform') {
      submitDecision('approve', 'always')
      return
    }

    const secApi = window.tabtin?.agentSecurity
    const decisions: PerToolApprovalDecision[] = await Promise.all(
      actions.map(async (action) => {
        const toolName = action.tool_name || action.name || 'unknown'
        const toolArgs = action.arguments || action.args || {}
        const inWorkspace = resolveApprovalWorkspaceZone(action) === 'inside'
        const subcmd = typeof toolArgs.command === 'string'
          ? (toolArgs.command.trim().split(/\s+/)[0] ?? '_')
          : '_'

        let patternKey: string | undefined
        let scopeDesc: string | undefined

        if (secApi) {
          try {
            const [key, desc] = await Promise.all([
              secApi.buildApprovalKey({
                toolName,
                subcmd,
                input: toolArgs,
                inWorkspace,
                scope: 'scoped',
                kind: 'object',
              }),
              secApi.buildScopeDescription({
                toolName,
                subcmd,
                scope: inWorkspace ? 'workspace-internal' : 'workspace-external',
              }),
            ])
            patternKey = key
            scopeDesc = desc
          } catch { /* best-effort */ }
        }

        return {
          request_id: action.request_id,
          tool_call_id: action.tool_call_id,
          decision: 'approve' as const,
          scope: 'always' as const,
          decision_kind: 'pattern' as const,
          pattern_key: patternKey,
          scope_description: scopeDesc,
        }
      }),
    )

    log.info('approval_decision_submitted', {
      decision: 'approve',
      scope: 'always',
      actionCount: decisions.length,
      surface: 'attention_dock',
    })
    onSubmit(decisions)
  }, [actionDisabled, actions, approval.approvalSource, onSubmit, submitDecision])

  const handleApprove = useCallback(() => {
    if (!rememberChecked || !showRememberControls) {
      submitDecision('approve', 'once')
      return
    }
    if (rememberScope === 'thread' && showThreadScope) {
      submitDecision('approve', 'thread')
      return
    }
    if (showAlwaysScope) {
      void submitAlwaysAllow()
      return
    }
    if (showThreadScope) submitDecision('approve', 'thread')
    else submitDecision('approve', 'once')
  }, [
    rememberChecked,
    rememberScope,
    showAlwaysScope,
    showRememberControls,
    showThreadScope,
    submitAlwaysAllow,
    submitDecision,
  ])

  const handleReject = useCallback(() => {
    if (rejecting) {
      submitDecision('reject', 'once', rejectionMessage)
      return
    }
    setRejecting(true)
  }, [rejecting, rejectionMessage, submitDecision])

  if (!view.canResolve) {
    return <ReadonlyApprovalDock ownerLabel={view.ownerLabel} t={t} />
  }

  return (
    <div
      className="relative overflow-hidden rounded-[12px] bg-background/95 @container/approval-dock"
      data-testid="approval-attention-dock"
    >
      <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 px-3 py-2">
        <ApprovalDockStatusIcon
          isSubmitting={isSubmitting}
          hasHighRisk={view.hasHighRisk}
        />
        <ApprovalDockHeadline
          view={view}
          approval={approval}
          isExpired={isExpired}
          isSubmitting={isSubmitting}
          t={t}
        />

        {remainingSeconds !== null && !isExpired && (
          <span
            className={cn(
              'hidden shrink-0 text-caption tabular-nums text-muted-foreground/60',
              '@[480px]/approval-dock:inline',
              remainingSeconds <= 60 && 'text-destructive/80',
            )}
            aria-label={t('approval.attentionDock.timeLeft', {
              time: formatCountdown(remainingSeconds),
              defaultValue: '剩余 {{time}}',
            })}
          >
            {formatCountdown(remainingSeconds)}
          </span>
        )}

        <div
          className={cn(
            'order-last mt-1.5 flex w-full min-w-0 items-center justify-end gap-1',
            'border-t border-border/30 pt-1.5',
            '@[420px]/approval-dock:order-none @[420px]/approval-dock:mt-0',
            '@[420px]/approval-dock:w-auto @[420px]/approval-dock:border-0',
            '@[420px]/approval-dock:pt-0',
          )}
          data-testid="approval-dock-actions"
        >
          <div className="mr-auto @[420px]/approval-dock:mr-0">
            <ApprovalDetailsPopover
              approval={approval}
              actions={actions}
              ownsDecision={view.requiresDetailedReview}
              detailsOpen={detailsOpen}
              setDetailsOpen={setDetailsOpen}
              onSubmit={onSubmit}
              onDismiss={onDismiss}
              isSubmitting={isSubmitting}
              t={t}
            />
          </div>
          <ApprovalDockActions
            showDecisionActions={!view.requiresDetailedReview}
            actionDisabled={actionDisabled}
            rejecting={rejecting}
            rememberChecked={rememberChecked}
            rememberScope={rememberScope}
            showRememberControls={showRememberControls}
            showThreadScope={showThreadScope}
            showAlwaysScope={showAlwaysScope}
            composerVisible={composerVisible}
            onApprove={handleApprove}
            onRememberCheckedChange={setRememberChecked}
            onRememberScopeChange={(scope) => {
              setRememberScope(scope)
              setRememberChecked(true)
            }}
            onReject={handleReject}
            onToggleComposer={onToggleComposer}
            t={t}
          />
        </div>
      </div>

      <ApprovalRejectReason
        visible={rejecting}
        value={rejectionMessage}
        onChange={setRejectionMessage}
        onCancel={() => {
          setRejecting(false)
          setRejectionMessage('')
        }}
        t={t}
      />
    </div>
  )
}
