import React from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { AGENT_MODE_THEME } from '../../../model/agentModeTheme'

export const BADGE_MODES: ReadonlySet<string> = new Set(['ask', 'plan', 'study'])

export const BADGE_VARIANT: Record<string, { iconClass: string; bgClass: string }> = {
  ask: { iconClass: 'text-info/80', bgClass: 'bg-info/10' },
  // eslint-disable-next-line tabtin/no-chat-design-violations -- 模式身份色图例（与 ask/study 同系），非单点 UI 警示
  plan: { iconClass: 'text-warning/80', bgClass: 'bg-warning/10' },
  study: { iconClass: 'text-type-webhook/80', bgClass: 'bg-type-webhook/10' },
}

export const AgentModeBadge: React.FC<{ metadata?: Record<string, unknown> | null }> = ({ metadata }) => {
  const { t } = useTranslation('chat')
  const mode = metadata?.agentMode as string | undefined
  if (!mode || !BADGE_MODES.has(mode)) return null
  const theme = AGENT_MODE_THEME[mode as keyof typeof AGENT_MODE_THEME]
  const variant = BADGE_VARIANT[mode]
  if (!theme || !variant) return null
  const Icon = theme.icon
  return (
    <div className="flex justify-end mt-0.5" data-testid="agent-mode-badge">
      <span className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption',
        variant.bgClass,
      )}>
        <Icon className={cn('h-3 w-3', variant.iconClass)} />
        <span className="text-foreground/60">{t(`agentMode.${mode}.name`)}</span>
      </span>
    </div>
  )
}
