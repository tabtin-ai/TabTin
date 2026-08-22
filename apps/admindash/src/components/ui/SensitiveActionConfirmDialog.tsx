import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'

interface SensitiveActionConfirmDialogProps {
  open: boolean
  title: string
  targetLabel: string
  impact: string
  confirmText?: string
  confirmButtonLabel?: string
  extraContent?: ReactNode
  blockedReason?: string
  loading?: boolean
  onCancel: () => void
  onConfirm: (payload: { reason: string; ticket_id: string }) => void
}

export function getSensitiveActionConfirmState(
  reason: string,
  typedConfirm: string,
  confirmText?: string,
  blockedReason?: string
): { disabled: boolean; hint: string } {
  if (blockedReason) {
    return { disabled: true, hint: blockedReason }
  }

  const missingReason = !reason.trim()
  const missingTypedConfirm = Boolean(confirmText && typedConfirm !== confirmText)

  if (missingReason && missingTypedConfirm) {
    return {
      disabled: true,
      hint: `请填写操作原因，并在二次确认框输入“${confirmText}”`,
    }
  }
  if (missingReason) return { disabled: true, hint: '请填写操作原因' }
  if (missingTypedConfirm) {
    return {
      disabled: true,
      hint: `请在二次确认框输入“${confirmText}”`,
    }
  }
  return { disabled: false, hint: '' }
}

export function SensitiveActionConfirmDialog({
  open,
  title,
  targetLabel,
  impact,
  confirmText,
  confirmButtonLabel,
  extraContent,
  blockedReason,
  loading = false,
  onCancel,
  onConfirm,
}: SensitiveActionConfirmDialogProps) {
  const dialogId = useId()
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [typedConfirm, setTypedConfirm] = useState('')

  useEffect(() => {
    if (!open) {
      setReason('')
      setTicketId('')
      setTypedConfirm('')
    }
  }, [open])

  if (!open) return null

  const confirmState = getSensitiveActionConfirmState(
    reason,
    typedConfirm,
    confirmText,
    blockedReason
  )
  const reasonInputId = `${dialogId}-reason`
  const ticketInputId = `${dialogId}-ticket`
  const typedConfirmInputId = `${dialogId}-typed-confirm`

  // Portal 到 body，并高于 Dialog(z-50)，避免被编辑弹窗焦点锁挡住输入
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <dialog
        open
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        className="w-full max-w-lg rounded-lg border bg-background p-5 shadow-lg"
      >
        <h2 id={`${dialogId}-title`} className="text-subtitle font-semibold">
          {title}
        </h2>
        <div className="mt-3 rounded-md border bg-muted/30 p-3 text-body">
          <div>操作对象：{targetLabel}</div>
          <div className="mt-1 text-muted-foreground">{impact}</div>
        </div>
        {extraContent ? <div className="mt-4">{extraContent}</div> : null}
        <label className="mt-4 block text-body font-medium" htmlFor={reasonInputId}>
          原因 <span className="text-destructive">*</span>
        </label>
        <Textarea
          id={reasonInputId}
          className="mt-2"
          value={reason}
          autoFocus
          onChange={(event) => setReason(event.target.value)}
          placeholder="请说明操作原因"
        />
        <label className="mt-4 block text-body font-medium" htmlFor={ticketInputId}>
          工单号
        </label>
        <Input
          id={ticketInputId}
          className="mt-2"
          value={ticketId}
          onChange={(event) => setTicketId(event.target.value)}
          placeholder="可选，建议填写客户工单或内部审批单"
        />
        {confirmText ? (
          <>
            <label className="mt-4 block text-body font-medium" htmlFor={typedConfirmInputId}>
              二次确认
            </label>
            <Input
              id={typedConfirmInputId}
              className="mt-2"
              value={typedConfirm}
              onChange={(event) => setTypedConfirm(event.target.value)}
              placeholder={`请输入 ${confirmText}`}
            />
          </>
        ) : null}
        {confirmState.hint ? (
          <output className="mt-3 block text-caption text-amber-700">
            按钮暂不可用：{confirmState.hint}
          </output>
        ) : (
          <output className="mt-3 block text-caption text-emerald-700">
            确认信息已填写，可以执行操作。
          </output>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" disabled={loading} onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={loading || confirmState.disabled}
            onClick={() => onConfirm({ reason, ticket_id: ticketId })}
            title={confirmState.hint || undefined}
          >
            {loading ? '执行中...' : confirmButtonLabel || '确认执行'}
          </Button>
        </div>
      </dialog>
    </div>,
    document.body
  )
}
