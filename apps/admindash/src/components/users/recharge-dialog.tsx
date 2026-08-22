import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { rechargeUserWallet } from '@/api/users'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface RechargeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string
  userName: string
  walletCredits: number | null
  onSuccess: (message: string) => void
  onError: (message: string) => void
}

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function RechargeDialog({
  open,
  onOpenChange,
  userId,
  userName,
  walletCredits,
  onSuccess,
  onError,
}: RechargeDialogProps) {
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'input' | 'confirm'>('input')

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setAmount('')
      setDescription('')
      setError(null)
      setStep('input')
    }
    onOpenChange(nextOpen)
  }

  const handleConfirmStep = () => {
    const parsed = Number.parseInt(amount, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('请输入有效的充值金额（正整数）')
      return
    }
    if (parsed > 100000) {
      setError('单次充值不能超过 100,000 credits')
      return
    }
    if (amount.includes('.')) {
      setError('充值金额必须为整数')
      return
    }
    setError(null)
    setStep('confirm')
  }

  const handleRecharge = async () => {
    const parsed = Number.parseInt(amount, 10)
    setSubmitting(true)
    setError(null)
    try {
      const res = await rechargeUserWallet(userId, {
        amount: parsed,
        description: description.trim() || undefined,
      })
      onSuccess(
        `${res.message}（余额 ${res.credits_before.toLocaleString()} → ${res.credits_after.toLocaleString()}）`
      )
      handleOpenChange(false)
    } catch (err: unknown) {
      setError(resolveErrorMessage(err, '充值失败'))
      setStep('input')
      onError(resolveErrorMessage(err, '充值失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>管理员充值</DialogTitle>
          <DialogDescription>
            为 {userName} 充值 credits
            {walletCredits != null ? `（当前余额 ${walletCredits.toLocaleString()} credits）` : ''}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        ) : null}

        {step === 'input' ? (
          <>
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 text-body font-medium">充值数量（credits）</div>
                <Input
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  placeholder="请输入充值 credits 数量，如 1000"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value)
                    setError(null)
                  }}
                  disabled={submitting}
                />
                <div className="mt-1 text-caption text-muted-foreground">
                  单次最多充值 100,000 credits
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-body font-medium">备注说明（可选）</div>
                <Input
                  placeholder="如：活动赠送、补偿充值等"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={submitting}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                取消
              </Button>
              <Button
                onClick={handleConfirmStep}
                disabled={!amount || Number.parseInt(amount, 10) <= 0}
              >
                下一步
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="rounded-md border bg-warning/10 px-4 py-3 text-body">
              <div className="font-medium text-warning">请确认以下充值信息</div>
              <div className="mt-2 space-y-1 text-warning">
                <div>
                  用户：<span className="font-medium">{userName}</span>
                </div>
                <div>
                  充值金额：
                  <span className="font-semibold text-title">
                    {Number.parseInt(amount, 10).toLocaleString()}
                  </span>{' '}
                  credits
                </div>
                {description.trim() ? <div>备注：{description.trim()}</div> : null}
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setStep('input')
                  setError(null)
                }}
                disabled={submitting}
              >
                返回修改
              </Button>
              <Button onClick={handleRecharge} disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                确认充值
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
