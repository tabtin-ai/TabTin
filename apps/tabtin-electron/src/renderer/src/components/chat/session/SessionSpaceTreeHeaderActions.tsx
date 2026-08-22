import React from 'react'
import { Settings, SquarePen } from 'lucide-react'
import { cn } from '@utils/cn'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

const HOVER_ACTION_BTN = 'h-5 w-5 shrink-0 inline-flex items-center justify-center rounded text-muted-foreground/60 opacity-100 transition-colors hover:bg-muted/30 hover:text-foreground [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100'

export const SpaceTreeCreateSessionButton: React.FC<{
  targetSpaceId: string
  disabled: boolean
  label: string
  onCreateSessionInSpace: (spaceId: string) => void
}> = ({ targetSpaceId, disabled, label, onCreateSessionInSpace }) => (
  <ChatIconTooltip content={label}>
    <button
      type="button"
      disabled={disabled}
      className={cn(
        HOVER_ACTION_BTN,
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground/60',
      )}
      onClick={(event) => {
        event.stopPropagation()
        if (disabled) return
        onCreateSessionInSpace(targetSpaceId)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        if (disabled) return
        onCreateSessionInSpace(targetSpaceId)
      }}
      aria-label={label}
    >
      <SquarePen className="h-3.5 w-3.5" strokeWidth={1.75} />
    </button>
  </ChatIconTooltip>
)

export const SpaceTreeSettingsButton: React.FC<{
  targetSpaceId: string
  label: string
  onOpenSpaceSettings: (spaceId: string) => void
}> = ({ targetSpaceId, label, onOpenSpaceSettings }) => (
  <ChatIconTooltip content={label}>
    <button
      type="button"
      className={HOVER_ACTION_BTN}
      onClick={(event) => {
        event.stopPropagation()
        onOpenSpaceSettings(targetSpaceId)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        onOpenSpaceSettings(targetSpaceId)
      }}
      aria-label={label}
    >
      <Settings className="h-3 w-3" />
    </button>
  </ChatIconTooltip>
)
