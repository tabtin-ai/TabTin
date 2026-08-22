import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
  Input,
  LoadingSpinner,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useCountdown } from '@tabtin/shared/use-countdown'
import apiService from '@/services/api'
import { useAuthStore } from '@/stores/useAuthStore'
import { extractErrorMessage } from '@/utils/extract-api-error'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL } from '../settingsUi'

interface BindEmailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onBound?: () => void
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 手机号注册用户绑定邮箱：发码到待绑定邮箱 → 校验后写入账号。
 */
export const BindEmailDialog: React.FC<BindEmailDialogProps> = ({
  open,
  onOpenChange,
  onBound,
}) => {
  const { t } = useTranslation(['profile', 'common'])
  const refreshProfile = useAuthStore((s) => s.refreshProfile)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const { countdown, start: startCountdown, clear: clearCountdown } = useCountdown(60)

  useEffect(() => {
    if (!open) {
      setEmail('')
      setCode('')
      setError(null)
      setSending(false)
      setSubmitting(false)
      clearCountdown()
    }
  }, [open, clearCountdown])

  const handleSendCode = async () => {
    const trimmed = email.trim().toLowerCase()
    if (!EMAIL_RE.test(trimmed)) {
      setError(t('bindEmail.errors.emailInvalid', { ns: 'profile' }))
      return
    }
    if (countdown > 0) return

    setSending(true)
    setError(null)
    try {
      await apiService.sendBindEmailCode({ email: trimmed })
      startCountdown()
      toast({ title: t('bindEmail.codeSent', { ns: 'profile' }) })
    } catch (err) {
      setError(extractErrorMessage(err, 'bindEmail.errors.sendCodeFailed', undefined, 'profile'))
    } finally {
      setSending(false)
    }
  }

  const handleSubmit = async () => {
    const trimmed = email.trim().toLowerCase()
    if (!EMAIL_RE.test(trimmed)) {
      setError(t('bindEmail.errors.emailInvalid', { ns: 'profile' }))
      return
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError(t('bindEmail.errors.codeInvalid', { ns: 'profile' }))
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await apiService.bindEmail({
        email: trimmed,
        verification_code: code.trim(),
      })
      await refreshProfile()
      toast({ title: t('bindEmail.success', { ns: 'profile' }) })
      onOpenChange(false)
      onBound?.()
    } catch (err) {
      setError(extractErrorMessage(err, 'bindEmail.errors.failed', undefined, 'profile'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('bindEmail.title', { ns: 'profile' })}</DialogTitle>
          <DialogDescription>{t('bindEmail.description', { ns: 'profile' })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-body text-muted-foreground">
              {t('bindEmail.labels.email', { ns: 'profile' })}
            </label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('bindEmail.placeholders.email', { ns: 'profile' })}
              className={SETTINGS_CONTROL}
              autoComplete="email"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-body text-muted-foreground">
              {t('bindEmail.labels.verificationCode', { ns: 'profile' })}
            </label>
            <div className="flex items-center gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder={t('bindEmail.placeholders.verificationCode', { ns: 'profile' })}
                className={cn('flex-1', SETTINGS_CONTROL)}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sending || countdown > 0}
                onClick={() => void handleSendCode()}
                className="shrink-0"
              >
                {sending ? (
                  <LoadingSpinner size="sm" />
                ) : countdown > 0 ? (
                  `${countdown}s`
                ) : (
                  t('bindEmail.actions.sendCode', { ns: 'profile' })
                )}
              </Button>
            </div>
          </div>

          {error ? <p className="text-body text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('cancel', { ns: 'common' })}
            </Button>
            <Button
              type="button"
              disabled={submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? <LoadingSpinner size="sm" /> : t('bindEmail.actions.submit', { ns: 'profile' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
