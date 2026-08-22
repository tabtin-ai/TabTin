import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'
import { Badge } from '@components/ui'
import { cn } from '@utils/cn'

const AGENT_OWNER_BADGE_SIZE = 'px-1.5 py-0 leading-none'
const AGENT_ICON_SIZE = 'h-3.5 w-3.5'

interface AgentMemberBadgesProps {
  ownerName?: string
  offline?: boolean
  className?: string
}

export function AgentMemberBadges({ ownerName, offline = false, className }: AgentMemberBadgesProps) {
  const { t } = useTranslation('tabchat')
  const name = ownerName?.trim() ?? ''
  const aiLabel = t('aiAssistant', { defaultValue: 'AI' })
  const offlineLabel = t('offline', { defaultValue: '离线' })
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap', className)}>
      <span className="inline-flex text-primary" aria-label={aiLabel}>
        <Bot className={AGENT_ICON_SIZE} aria-hidden />
      </span>
      {name ? (
        <Badge
          variant="default"
          className={AGENT_OWNER_BADGE_SIZE}
          aria-label={t('aiOwnerBadgeAria', { name, defaultValue: `所属用户 ${name}` })}
        >
          {name}
        </Badge>
      ) : null}
      {offline ? (
        <Badge
          variant="secondary"
          className={AGENT_OWNER_BADGE_SIZE}
          aria-label={offlineLabel}
        >
          {offlineLabel}
        </Badge>
      ) : null}
    </span>
  )
}
