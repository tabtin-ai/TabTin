import { useTranslation } from 'react-i18next'
import { formatMessageTimestamp } from '@/lib/dateUtils'

interface Props {
  createdAt: string
}

export function GroupCreatedAtMarker({ createdAt }: Props) {
  const { t } = useTranslation('tabchat')
  const time = formatMessageTimestamp(createdAt, t)

  return (
    <div className="flex justify-center px-4 py-3 select-none">
      <time
        className="rounded-full bg-muted/30 px-2.5 py-0.5 text-caption text-muted-foreground"
        dateTime={createdAt}
      >
        {t('groupCreatedAt', { time })}
      </time>
    </div>
  )
}
