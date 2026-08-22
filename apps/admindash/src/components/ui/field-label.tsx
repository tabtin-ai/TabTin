/**
 * 字段标签组件
 * 显示中文标签 + Tooltip 说明
 */

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { getFieldDescription, getFieldLabel, hasFieldDescription } from '@/config/fieldLabels'
import { cn } from '@/lib/utils'
import { HelpCircle } from 'lucide-react'

interface FieldLabelProps {
  fieldKey: string
  showEnglish?: boolean // 是否显示英文原名
  className?: string
}

export function FieldLabel({ fieldKey, showEnglish = false, className }: FieldLabelProps) {
  const label = getFieldLabel(fieldKey)
  const description = getFieldDescription(fieldKey)
  const hasDesc = hasFieldDescription(fieldKey)

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      {/* 中文标签 */}
      <span className="font-medium">{label}</span>

      {/* 英文原名（可选） */}
      {showEnglish && label !== fieldKey && (
        <span className="text-body text-muted-foreground font-mono">({fieldKey})</span>
      )}

      {/* Tooltip 说明 */}
      {hasDesc && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help hover:text-foreground transition-colors" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-body">{description}</p>
              {showEnglish && label !== fieldKey && (
                <p className="text-body text-muted-foreground mt-1 font-mono">{fieldKey}</p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}
