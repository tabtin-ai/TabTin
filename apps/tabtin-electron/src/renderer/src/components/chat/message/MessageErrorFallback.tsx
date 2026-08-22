import React, { useState, useCallback } from 'react'
import { AlertTriangle, Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface MessageErrorFallbackProps {
  messageId: string
  role: string
  rawContent?: string | null
}

export const MessageErrorFallback: React.FC<MessageErrorFallbackProps> = ({
  messageId,
  role,
  rawContent,
}) => {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!rawContent) return
    try {
      await navigator.clipboard.writeText(rawContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard API 不可用时静默降级 */ }
  }, [rawContent])

  const roleLabel = role === 'user' ? t('message.user') : t('message.assistant')

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5">
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive/60" />
      <div className="min-w-0 flex-1">
        <p className="text-body text-foreground/80">
          {roleLabel} · {t('message.renderError')}
        </p>
        <p className="text-caption text-muted-foreground/60 truncate">
          ID: {messageId}
        </p>
      </div>
      {rawContent && (
        <button
          type="button"
          onClick={handleCopy}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-caption text-muted-foreground/60 transition-colors duration-150 hover:bg-muted/30 hover:text-foreground"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              {t('common.copied')}
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              {t('message.copyRawContent')}
            </>
          )}
        </button>
      )}
    </div>
  )
}
