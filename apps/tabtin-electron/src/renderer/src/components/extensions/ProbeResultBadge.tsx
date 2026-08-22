import React from 'react'
import { useTranslation } from 'react-i18next'
import type { ProbeResultState } from '@/hooks/useProbeConnection'
import { cn } from '@utils/cn'

interface ProbeResultBadgeProps {
  result: ProbeResultState | null
  connId: string
}

export const ProbeResultBadge: React.FC<ProbeResultBadgeProps> = ({ result, connId }) => {
  const { t } = useTranslation('settings')
  if (!result || result.connId !== connId) return null
  return (
    <p className={cn('text-caption mt-0.5', result.ok ? 'text-success' : 'text-destructive/80')}>
      {result.ok
        ? `${t('extensions.probeSuccess')}${result.latency != null ? ` · ${t('extensions.probeLatency', { ms: result.latency })}` : ''}`
        : t('extensions.probeFailed', { error: result.error ?? t('extensions.unknown') })
      }
    </p>
  )
}
