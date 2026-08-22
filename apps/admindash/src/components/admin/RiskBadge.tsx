import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Info } from 'lucide-react'

const RISK_LABELS: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  unknown: '未知',
}

const RISK_LEVEL_HELP: Array<{
  level: string
  badge: 'destructive' | 'warning' | 'secondary'
  meaning: string
}> = [
  {
    level: '严重',
    badge: 'destructive',
    meaning: '存在严重异常告警，需优先排查扣费 / 用量问题。',
  },
  {
    level: '高',
    badge: 'destructive',
    meaning: '存在高等级异常告警。',
  },
  {
    level: '中',
    badge: 'warning',
    meaning: '存在中等等级异常告警。',
  },
  {
    level: '低',
    badge: 'secondary',
    meaning: '有异常记录或预算告警，但未达到中高严重度。',
  },
  {
    level: '暂无风险记录',
    badge: 'secondary',
    meaning: '当前无异常告警，也无预算告警；不代表组织状态一定正常。',
  },
]

export function RiskBadge({ risk }: { risk: 'low' | 'medium' | 'high' | 'critical' | string }) {
  const normalized = String(risk || '').toLowerCase()
  const variant =
    normalized === 'critical' || normalized === 'high'
      ? 'destructive'
      : normalized === 'medium'
        ? 'warning'
        : 'secondary'
  return <Badge variant={variant}>{RISK_LABELS[normalized] || risk}</Badge>
}

/** 顶栏风险状态旁的 (i)：等级释义 + 跳转风险 Tab */
export function RiskStatusInfoTip({ onGoRisk }: { onGoRisk: () => void }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="风险状态说明"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          className="pointer-events-auto w-96 border bg-popover p-0 text-popover-foreground shadow-lg"
          side="bottom"
          align="start"
          sideOffset={8}
        >
          <div className="flex items-center justify-between gap-3 border-b px-3.5 py-3">
            <div className="text-body font-medium">风险状态说明</div>
            <button
              type="button"
              className="shrink-0 text-caption font-medium text-primary underline-offset-2 hover:underline"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onGoRisk()
              }}
            >
              前往风险详情
            </button>
          </div>
          <ul className="space-y-2 px-3.5 py-3">
            {RISK_LEVEL_HELP.map((item) => (
              <li key={item.level} className="rounded-md border bg-background/80 px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Badge variant={item.badge} className="shrink-0">
                    {item.level}
                  </Badge>
                  <p className="min-w-0 flex-1 text-caption leading-snug text-muted-foreground">
                    {item.meaning}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
