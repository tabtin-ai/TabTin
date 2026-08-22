import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Database } from 'lucide-react'

export interface TableHostMetricsCardProps {
  tablesCount: number
  fieldsCount: number
  recordsCount: number
  currentViewName: string
}

export function TableHostMetricsCard({
  tablesCount,
  fieldsCount,
  recordsCount,
  currentViewName,
}: TableHostMetricsCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-subtitle">宿主指标</CardTitle>
        <CardDescription>用于确认跨端挂载与数据流状态。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-background px-3 py-2">
          <div className="text-body text-muted-foreground">表格数量</div>
          <div className="text-title font-semibold">{tablesCount}</div>
        </div>
        <div className="rounded-md border bg-background px-3 py-2">
          <div className="text-body text-muted-foreground">字段数量</div>
          <div className="text-title font-semibold">{fieldsCount}</div>
        </div>
        <div className="rounded-md border bg-background px-3 py-2">
          <div className="text-body text-muted-foreground">记录数量</div>
          <div className="text-title font-semibold">{recordsCount}</div>
        </div>
        <div className="rounded-md border bg-background px-3 py-2">
          <div className="text-body text-muted-foreground">当前视图</div>
          <div className="text-body font-medium">{currentViewName}</div>
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-body text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5" />
            runtime: table-core + table-ui
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
