import { EntityLink } from '@/components/entity-links/EntityLink'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/utils'

export interface AdminTimelineItem {
  id: string
  source: string
  action: string
  summary?: string | null
  actorId?: string | null
  actorLabel?: string | null
  objectType: string
  objectId?: string | null
  reason?: string | null
  ticketId?: string | null
  severity?: 'info' | 'warning' | 'critical'
  createdAt?: string | null
}

export function AdminAuditTimelineCard({
  title,
  description,
  items,
  emptyText = '暂无时间线事件',
}: {
  title: string
  description?: string
  items: AdminTimelineItem[]
  emptyText?: string
}) {
  return (
    <Card>
      <CardHeader className="space-y-1 pb-2">
        <CardTitle className="text-subtitle">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-body text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          items.map((item) => (
            <div
              key={`${item.source}-${item.id}`}
              className="grid gap-2 rounded border bg-muted/10 px-3 py-2 md:grid-cols-[minmax(0,1fr)_180px]"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={item.severity === 'critical' ? 'destructive' : 'outline'}>
                    {item.source}
                  </Badge>
                  <span className="truncate text-body font-medium">
                    {item.summary || item.action}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-body text-muted-foreground">
                  <span>actor</span>
                  <EntityLink
                    type="admin_account"
                    id={item.actorId || ''}
                    label={item.actorLabel || item.actorId || 'unknown'}
                    compact
                  />
                  <span>object</span>
                  <EntityLink type={item.objectType} id={item.objectId || ''} compact />
                </div>
                {item.reason || item.ticketId ? (
                  <div className="text-caption text-muted-foreground">
                    {item.reason ? `reason: ${item.reason}` : ''}
                    {item.ticketId ? ` ticket: ${item.ticketId}` : ''}
                  </div>
                ) : null}
              </div>
              <div className="text-body text-muted-foreground md:text-right">
                {formatDateTime(item.createdAt)}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
