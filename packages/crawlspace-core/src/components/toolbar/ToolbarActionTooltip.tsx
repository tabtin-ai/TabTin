import React from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@tabtin/smartsheet-ui';

export interface ToolbarActionTooltipProps {
  label: string;
  description: string;
  children: React.ReactElement;
}

/**
 * 宽态浏览器工具栏的图标说明。
 *
 * Tooltip 横向展开，避免内容落入 Electron WebContentsView 的原生网页区域后被遮挡。
 */
export const ToolbarActionTooltip: React.FC<ToolbarActionTooltipProps> = ({
  label,
  description,
  children,
}) => (
  <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-[320px]">
        {label}｜{description}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

ToolbarActionTooltip.displayName = 'ToolbarActionTooltip';
