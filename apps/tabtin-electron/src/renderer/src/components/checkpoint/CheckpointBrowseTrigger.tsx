/**
 * CheckpointBrowseTrigger — 聊天顶栏「Space 快照」入口
 *
 * 挂载在 ChatSessionBar（CompactGitStatus 下方 toolbar），与回退历史面板同级交互模式。
 */

import React, { lazy, Suspense, useState } from 'react'
import { Camera } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChatIconTooltip } from '@components/chat/panel/ChatIconTooltip'

const CheckpointBrowseSheet = lazy(() =>
  import('./CheckpointBrowseSheet').then(m => ({ default: m.CheckpointBrowseSheet })),
)

export interface CheckpointBrowseTriggerProps {
  spaceId: string
  sessionId?: string | null
  className?: string
  showLabel?: boolean
  labelClassName?: string
}

export const CheckpointBrowseTrigger: React.FC<CheckpointBrowseTriggerProps> = ({
  spaceId,
  sessionId,
  className,
  showLabel = false,
  labelClassName,
}) => {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const label = t('checkpoint.browseEntry', { defaultValue: '工作空间快照' })

  return (
    <>
      <ChatIconTooltip content={label}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={className ?? 'h-7 w-7 inline-flex items-center justify-center rounded-interactive text-muted-foreground/70 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] transition-colors no-drag'}
          aria-label={label}
        >
          <Camera className="h-3.5 w-3.5" aria-hidden />
          {showLabel ? <span className={labelClassName}>{label}</span> : null}
        </button>
      </ChatIconTooltip>
      {open && (
        <Suspense fallback={null}>
          <CheckpointBrowseSheet
            spaceId={spaceId}
            sessionId={sessionId}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  )
}
