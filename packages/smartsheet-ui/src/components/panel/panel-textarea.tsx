/**
 * PanelTextarea — compact textarea for property panels.
 *
 * Borderless design, same visual language as PanelInput.
 */

import React, { forwardRef, memo } from 'react'
import { cn } from '../../utils/cn'

export interface PanelTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const PanelTextarea = memo(
  forwardRef<HTMLTextAreaElement, PanelTextareaProps>(function PanelTextarea(
    { className, ...props },
    ref,
  ) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'min-h-[60px] w-full rounded bg-muted/40 px-1.5 py-1.5 text-body text-foreground outline-none',
          'resize-vertical border-none transition-colors',
          'hover:bg-muted/60',
          'focus:bg-muted/60 focus:ring-1 focus:ring-inset focus:ring-accent/40',
          'placeholder:text-muted-foreground/60',
          'disabled:pointer-events-none disabled:opacity-40',
          className,
        )}
        {...props}
      />
    )
  }),
)
