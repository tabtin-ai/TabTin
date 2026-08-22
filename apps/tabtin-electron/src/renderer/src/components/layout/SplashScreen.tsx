import React, { useCallback, useEffect, useState } from 'react'
import { LoadingSpinner } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@stores/useAuthStore'

const HINT_DELAY_MS = 1500
const RETRY_DELAY_MS = 5000

export const SplashScreen: React.FC = () => {
  const { t } = useTranslation('auth')
  const [showHint, setShowHint] = useState(false)
  const [showRetry, setShowRetry] = useState(false)

  useEffect(() => {
    const hintTimer = setTimeout(() => setShowHint(true), HINT_DELAY_MS)
    const retryTimer = setTimeout(() => setShowRetry(true), RETRY_DELAY_MS)
    return () => {
      clearTimeout(hintTimer)
      clearTimeout(retryTimer)
    }
  }, [])

  const handleRetry = useCallback(async () => {
    try {
      await useAuthStore.getState().loadAuthFromStorage()
    } catch {
      window.location.reload()
    }
  }, [])

  return (
    <div className="boot-screen">
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10">
          <span className="text-display select-none">🚀</span>
        </div>

        <LoadingSpinner size="sm" />

        {showHint && (
          <p className="animate-in fade-in text-body text-muted-foreground/60">
            {t('splash.loading')}
          </p>
        )}

        {showRetry && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            className="animate-in fade-in text-body text-accent-text hover:text-accent transition-colors"
          >
            {t('splash.retryHint')}
          </button>
        )}
      </div>
    </div>
  )
}
