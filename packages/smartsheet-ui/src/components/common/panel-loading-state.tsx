import * as React from 'react'
import { cn } from '../../utils/cn'
import { Skeleton } from '../skeleton'

export type PanelLoadingStateVariant = 'list' | 'card' | 'detail'

export interface PanelLoadingStateProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: PanelLoadingStateVariant
  rows?: number
  showHeader?: boolean
}

const titleWidths = ['38%', '54%', '46%', '62%', '50%', '42%'] as const
const metaWidths = ['20%', '26%', '18%', '24%', '22%', '16%'] as const
const previewWidths = ['72%', '84%', '68%', '76%', '80%', '70%'] as const

const pickWidth = (widths: readonly string[], index: number) => widths[index % widths.length]

export const PanelLoadingState = React.forwardRef<HTMLDivElement, PanelLoadingStateProps>(
  (
    {
      variant = 'list',
      rows = 5,
      showHeader = true,
      className,
      ...props
    },
    ref,
  ) => {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn('space-y-3 p-4', className)}
        {...props}
      >
        {showHeader ? (
          <div className="space-y-2 pb-1">
            <Skeleton width="28%" height={14} rounded="md" />
            <div className="flex items-center gap-2">
              <Skeleton width="16%" height={10} rounded="full" className="opacity-70" />
              <Skeleton width="12%" height={10} rounded="full" className="opacity-55" />
            </div>
          </div>
        ) : null}

        {variant === 'card' ? (
          <div className="grid gap-3">
            {Array.from({ length: rows }).map((_, index) => (
              <div key={index} className="rounded-xl border border-border/20 bg-background/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton width={pickWidth(titleWidths, index)} height={13} rounded="md" />
                    <Skeleton width={pickWidth(previewWidths, index)} height={11} rounded="full" className="opacity-75" />
                  </div>
                  <Skeleton width={22} height={22} rounded="md" className="opacity-55" />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {variant === 'detail' ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border/20 bg-background/60 p-4">
              <div className="space-y-3">
                <Skeleton width="42%" height={16} rounded="md" />
                <Skeleton width="100%" height={11} rounded="full" />
                <Skeleton width="86%" height={11} rounded="full" className="opacity-85" />
                <Skeleton width="72%" height={11} rounded="full" className="opacity-75" />
              </div>
            </div>
            <div className="space-y-2">
              {Array.from({ length: Math.max(rows - 1, 3) }).map((_, index) => (
                <div key={index} className="flex items-start gap-3 rounded-lg border border-border/15 px-3 py-3">
                  <Skeleton width={18} height={18} rounded="md" className="mt-0.5 opacity-65" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton width={pickWidth(titleWidths, index)} height={12} rounded="md" />
                    <Skeleton width={pickWidth(previewWidths, index)} height={10} rounded="full" className="opacity-75" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {variant === 'list' ? (
          <div className="space-y-1.5">
            {Array.from({ length: rows }).map((_, index) => (
              <div key={index} className="flex items-start gap-3 rounded-lg border border-border/15 px-3 py-3">
                <Skeleton width={18} height={18} rounded="md" className="mt-0.5 opacity-70" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <Skeleton width={pickWidth(titleWidths, index)} height={12} rounded="md" />
                    <Skeleton width={pickWidth(metaWidths, index)} height={10} rounded="full" className="ml-auto opacity-65" />
                  </div>
                  <Skeleton width={pickWidth(previewWidths, index)} height={10} rounded="full" className="opacity-75" />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  },
)

PanelLoadingState.displayName = 'PanelLoadingState'
