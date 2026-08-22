/**
 * @deprecated 验证码人工介入已改走对话 ask_user + wire `captcha_required`
 *（captcha-wall-gate），不再挂 ContentArea。保留文件仅供对照，勿重新挂载。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface CaptchaIntervention {
  tabId: string
  captchaType: string
  message: string
}

export const CaptchaInterventionOverlay: React.FC = () => {
  const { t } = useTranslation('context')
  const [intervention, setIntervention] = useState<CaptchaIntervention | null>(null)

  useEffect(() => {
    const tabtin = window.tabtin
    if (!tabtin?.captcha?.onInterventionRequired) return

    const cleanup = tabtin.captcha.onInterventionRequired(
      (payload: CaptchaIntervention) => {
        setIntervention(payload)
      },
    )
    return cleanup
  }, [])

  const handleResolved = useCallback(() => {
    if (!intervention) return
    const tabtin = window.tabtin
    tabtin?.captcha?.resolveIntervention(intervention.tabId)
    setIntervention(null)
  }, [intervention])

  if (!intervention) return null

  const captchaLabel =
    intervention.captchaType === 'turnstile'
      ? 'Cloudflare Turnstile'
      : intervention.captchaType === 'recaptcha-v2'
        ? 'reCAPTCHA'
        : intervention.captchaType === 'hcaptcha'
          ? 'hCaptcha'
          : t('captcha.verification', '验证码')

  return (
    <div className="fixed bottom-4 right-4 z-global animate-in slide-in-from-bottom-2 fade-in duration-300" role="alert" aria-live="assertive">
      <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 shadow-lg">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/10">
          <svg
            className="h-4 w-4 text-warning"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>
        <div className="flex flex-col">
          <span className="text-body font-medium text-warning">
            {t('captcha.interventionRequired', '页面需要完成{{type}}验证', { type: captchaLabel })}
          </span>
          <span className="text-body text-warning">
            {t('captcha.interventionHint', '请在浏览器页面中完成验证后点击确认')}
          </span>
        </div>
        <button
          onClick={handleResolved}
          className="ml-2 shrink-0 rounded-md bg-warning px-3 py-1.5 text-body font-medium text-white transition-colors hover:bg-warning/80"
        >
          {t('captcha.resolved', '已完成')}
        </button>
      </div>
    </div>
  )
}

CaptchaInterventionOverlay.displayName = 'CaptchaInterventionOverlay'
