import type { ReactElement } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@tabtin/smartsheet-ui'

interface BubbleToolbarTooltipProps {
  label: string
  children: ReactElement
}

export const BubbleToolbarTooltip = ({
  label,
  children,
}: BubbleToolbarTooltipProps) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
)
