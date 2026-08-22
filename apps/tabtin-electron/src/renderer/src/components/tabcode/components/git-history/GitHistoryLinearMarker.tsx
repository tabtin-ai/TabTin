import React from 'react'
import { cn } from '@utils/cn'

interface GitHistoryLinearMarkerProps {
  connectsPrevious: boolean
  connectsNext: boolean
  selected: boolean
}

export function GitHistoryLinearMarker({
  connectsPrevious,
  connectsNext,
  selected,
}: GitHistoryLinearMarkerProps): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-7 w-8 shrink-0 items-center justify-center"
      data-testid="git-history-linear-marker"
      data-connects-previous={connectsPrevious}
      data-connects-next={connectsNext}
    >
      {connectsPrevious ? (
        <span className="absolute left-1/2 top-0 h-1/2 w-px -translate-x-1/2 bg-primary/60" />
      ) : null}
      {connectsNext ? (
        <span className="absolute bottom-0 left-1/2 h-1/2 w-px -translate-x-1/2 bg-primary/60" />
      ) : null}
      <span
        className={cn(
          'relative z-content h-2 w-2 rounded-full border',
          selected
            ? 'border-primary bg-primary'
            : 'border-primary/80 bg-background',
        )}
      />
    </span>
  )
}
