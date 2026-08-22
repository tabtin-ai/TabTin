import { Archive, Ban, CircleCheck, CirclePause, PencilLine, type LucideIcon } from 'lucide-react'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'

/** 自动化状态胶囊：列表 / 详情共用，active 明确用绿色。 */
export const TRACKER_STATUS_STYLE: Record<string, string> = {
  draft: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  active: 'bg-green-500/15 text-green-600 dark:text-green-400',
  paused: 'bg-foreground/[0.06] text-muted-foreground',
  disabled: 'bg-muted-foreground/15 text-muted-foreground',
  archived: 'bg-muted-foreground/15 text-muted-foreground',
}

const TRACKER_STATUS_ICON: Record<string, LucideIcon> = {
  draft: PencilLine,
  active: CircleCheck,
  paused: CirclePause,
  disabled: Ban,
  archived: Archive,
}

export function TrackerStatusPill({ status, label }: { status: string; label: string }) {
  const Icon = TRACKER_STATUS_ICON[status] ?? PencilLine
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 font-medium',
        CANVAS_TEXT_META,
        TRACKER_STATUS_STYLE[status] ?? TRACKER_STATUS_STYLE.draft,
      )}
      title={label}
    >
      <Icon className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  )
}
