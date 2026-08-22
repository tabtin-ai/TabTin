/**
 * PanelSelect — compact native select for property panels.
 *
 * Borderless design, same visual language as PanelInput / NumberInput.
 */

import React, { forwardRef, memo } from 'react'
import { cn } from '../../utils/cn'

export interface PanelSelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const PanelSelect = memo(
  forwardRef<HTMLSelectElement, PanelSelectProps>(function PanelSelect(
    { className, children, ...props },
    ref,
  ) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-7 w-full appearance-none rounded bg-muted/40 px-1.5 pr-5 text-body text-foreground outline-none',
          'border-none transition-colors',
          'hover:bg-muted/60',
          'focus:bg-muted/60 focus:ring-1 focus:ring-inset focus:ring-accent/40',
          'disabled:pointer-events-none disabled:opacity-40',
          'bg-[length:12px] bg-[position:right_4px_center] bg-no-repeat',
          "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    )
  }),
)
