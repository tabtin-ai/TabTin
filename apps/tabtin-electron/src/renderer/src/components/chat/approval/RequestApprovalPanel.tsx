/**
 * RequestApprovalPanel — `request_approval` 工具的 UI 渲染（路径权限治理 W7 / A5 D6 真分立）。
 *
 * 历史：W5 上线三件套时此卡片是 AskUserPanel 内嵌的 RequestApprovalCard 子组件，
 * 走 `intent === 'approve' && onApprovalSubmit` 弱分发。W7 物理拆 3 文件 +
 * AskUserRequestState discriminated union by kind，让外层路由按
 * `state.kind === 'approval'` 直接调本 Panel —— 类型层面挡住跨形访问
 * （TS 编译期保证子组件不能误读 questions / fields 等隔离字段）。
 *
 * 字段 owner：rationale（必有）、riskLevel（必有）、details（可选只读明细）；
 * 其他 base 字段（title / submit 文案 / 错误反显）由顶层 AskUserPanel 透传。
 *
 * 关键决策：本卡片**没有 fillable fields**（与 ask_form 区分）——卡只 approve
 * / decline，提交回 IPC 仅传 `approved` 布尔。modified_fields diff 已删除（W5
 * collapse 时代的死代码，request_approval 永远不带 fillable fields）。
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, AlertTriangle } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import type { AskUserRiskLevel } from '@tabtin/chat-client'
import {
  CARD_RADIUS,
  BORDER,
  TEXT,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'

export interface RequestApprovalPanelProps {
  rationale: string
  riskLevel: AskUserRiskLevel
  title?: string
  details?: unknown
  submitLabel?: string
  declineLabel?: string
  /**
   * 提交回调。注意签名：D6 真分立后只传 approved 布尔，不再有 fieldValues
   * （request_approval 永远不带 fillable fields）。
   */
  onApprovalSubmit: (approved: boolean) => void
  isSubmitting?: boolean
  disabled?: boolean
  submitError?: string
}

// 风险态使用单边框，避免 ring + border 双描边。
const RISK_BORDER: Record<AskUserRiskLevel, string> = {
  safe: '',
  review: 'border-warning/40',
  high: 'border-destructive/60',
}

const RISK_HINT_KEY: Record<AskUserRiskLevel, { key: string; defaultValue: string } | null> = {
  safe: null,
  // 风险提示文案：避免空话（"建议确认后执行"等于没说）。
  // review：提示用户"看一遍参数再走"。
  // high：明示不可逆/外部可见后果，需用户主动确认（M2 引入 long-press 后再细化）。
  review: { key: 'askUser.risk.review.hint', defaultValue: '建议先核对下面的参数，再决定是否执行。' },
  high: { key: 'askUser.risk.high.hint', defaultValue: '这个动作做了就回不去了（会修改外部数据 / 发出消息 / 扣费）。请仔细检查。' },
}

export const RequestApprovalPanel: React.FC<RequestApprovalPanelProps> = ({
  rationale,
  riskLevel,
  title,
  details,
  submitLabel,
  declineLabel,
  onApprovalSubmit,
  isSubmitting = false,
  disabled = false,
  submitError,
}) => {
  const { t } = useTranslation('chat')
  const RiskIcon = riskLevel === 'high' ? AlertTriangle : ShieldCheck
  const riskHint = RISK_HINT_KEY[riskLevel]
  const detailsText = useMemo(() => {
    if (details == null) return null
    if (typeof details === 'string') return details
    try {
      return JSON.stringify(details, null, 2)
    } catch {
      return String(details)
    }
  }, [details])

  return (
    <div
      data-testid="request-approval-panel"
      className={cn(
        CARD_RADIUS, 'relative min-w-0 overflow-hidden border bg-background p-3 space-y-3',
        'chat-motion-approval-enter',
        // 实底对齐 ApprovalPanel：半透明 BG.card 叠在 composer 灰托盘上会透出蒙层。
        riskLevel !== 'safe' ? RISK_BORDER[riskLevel] : BORDER.active,
      )}
    >
      {submitError ? (
        <div className={cn('rounded-md border px-2.5 py-2', 'border-destructive/30 text-destructive', TEXT.meta)}>
          {submitError}
        </div>
      ) : null}

      <div className="flex min-w-0 items-center gap-2">
        <RiskIcon
          className={cn(
            ICON_SIZE.lg, 'flex-shrink-0',
            riskLevel === 'high'
              ? 'text-destructive/80'
              : riskLevel === 'review'
                ? 'text-warning/80'
                : 'text-accent',
          )}
        />
        <span className={cn(TEXT.header, TEXT_COLOR.secondary, 'min-w-0 flex-1 break-words [overflow-wrap:anywhere]')}>
          {title || t('askUser.approvalTitle', { defaultValue: '请确认 Agent 操作' })}
        </span>
        <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded font-normal flex-shrink-0', TEXT.meta, 'bg-accent/10 text-accent')}>
          {t('askUser.intent.approval.badge', { defaultValue: '审批' })}
        </span>
      </div>

      {rationale ? (
        <div className={cn('rounded-md border px-2.5 py-2', BORDER.subtle, 'bg-muted/10')}>
          <p className={cn(TEXT.body, TEXT_COLOR.secondary, 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]')}>
            {rationale}
          </p>
        </div>
      ) : null}

      {riskHint && (
        <div
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border/40 bg-background px-2.5 py-1.5',
            riskLevel === 'high' ? 'text-destructive/80' : 'text-warning/80',
            TEXT.meta,
          )}
        >
          <AlertTriangle className={cn(ICON_SIZE.md, 'flex-shrink-0')} />
          {t(riskHint.key, { defaultValue: riskHint.defaultValue })}
        </div>
      )}

      {detailsText ? (
        <pre className={cn(
          'max-h-48 overflow-auto rounded-md border border-border/40 bg-muted/20 px-2.5 py-2',
          TEXT.meta,
          'text-foreground/80 whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
        )}>
          {detailsText}
        </pre>
      ) : null}

      <div className={cn('flex items-center justify-end gap-2 pt-1 border-t', BORDER.subtle)}>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-7 px-3', TEXT.body, 'text-muted-foreground')}
          onClick={() => onApprovalSubmit(false)}
          disabled={isSubmitting || disabled}
        >
          {declineLabel || t('askUser.intent.approval.decline', { defaultValue: '拒绝' })}
        </Button>
        <Button
          variant={riskLevel === 'high' ? 'destructive' : 'default'}
          size="sm"
          className={cn('h-7 px-4', TEXT.body)}
          onClick={() => onApprovalSubmit(true)}
          disabled={isSubmitting || disabled}
        >
          {isSubmitting
            ? t('askUser.submitting', { defaultValue: '提交中...' })
            : disabled
              ? t('input.wsDisconnected', { defaultValue: '连接已断开' })
              : submitLabel || t('askUser.intent.approval.submit', { defaultValue: '批准' })}
        </Button>
      </div>
    </div>
  )
}
