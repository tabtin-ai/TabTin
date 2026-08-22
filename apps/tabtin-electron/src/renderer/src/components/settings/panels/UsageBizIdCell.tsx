import React, { useState } from 'react'
import { CheckCheck, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SETTINGS_TEXT_META } from '../settingsUi'
import { cn } from '@utils/cn'

/**
 * 用量明细「业务 ID」：DOM 保留完整值（CSS 截断），并提供一键复制完整 ID。
 * 旧实现用 shortenId 改写文案，选中/复制只能拿到截断串。
 */
export function UsageBizIdCell({ bizId }: { bizId: string | null | undefined }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)

  if (!bizId) {
    return <span className={cn(SETTINGS_TEXT_META, 'text-foreground-secondary')}>—</span>
  }

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(bizId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard not available */
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <code
        className={cn(SETTINGS_TEXT_META, 'text-foreground-secondary', 'min-w-0 truncate font-mono select-all')}
        title={bizId}
      >
        {bizId}
      </code>
      <button
        type="button"
        onClick={(e) => { void handleCopy(e) }}
        className="shrink-0 rounded-interactive p-0.5 text-muted-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]"
        title={
          copied
            ? t('usage.ledger.bizIdCopied', { defaultValue: '已复制' })
            : t('usage.ledger.copyBizId', { defaultValue: '复制完整业务ID' })
        }
        aria-label={t('usage.ledger.copyBizId', { defaultValue: '复制完整业务ID' })}
      >
        {copied ? (
          <CheckCheck className="h-3 w-3 text-success" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
    </div>
  )
}
