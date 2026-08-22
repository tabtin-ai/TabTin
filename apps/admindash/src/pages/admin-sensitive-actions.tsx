import { type AdminSensitiveActionItem, listAdminSensitiveActions } from '@/api/admin-audit'
import { AdminAuditDrawer } from '@/components/admin/AdminAuditDrawer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { formatDateTime } from '@/lib/utils'
import { useCallback, useEffect, useState } from 'react'

interface SensitiveActionFilters {
  action: string
  permissionCode: string
  targetType: string
  actorAdminAccountId: string
  actorUserId: string
  startAt: string
  endAt: string
}

const emptyFilters: SensitiveActionFilters = {
  action: '',
  permissionCode: '',
  targetType: '',
  actorAdminAccountId: '',
  actorUserId: '',
  startAt: '',
  endAt: '',
}

export function AdminSensitiveActionsPage() {
  const [items, setItems] = useState<AdminSensitiveActionItem[]>([])
  const [action, setAction] = useState('')
  const [permissionCode, setPermissionCode] = useState('')
  const [targetType, setTargetType] = useState('')
  const [actorAdminAccountId, setActorAdminAccountId] = useState('')
  const [actorUserId, setActorUserId] = useState('')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [selectedItem, setSelectedItem] = useState<AdminSensitiveActionItem | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const currentFilters = (): SensitiveActionFilters => ({
    action,
    permissionCode,
    targetType,
    actorAdminAccountId,
    actorUserId,
    startAt,
    endAt,
  })

  const load = useCallback(async (filters: SensitiveActionFilters) => {
    setLoading(true)
    setError('')
    try {
      const response = await listAdminSensitiveActions({
        action: filters.action.trim() || undefined,
        permission_code: filters.permissionCode,
        target_type: filters.targetType,
        actor_admin_account_id: filters.actorAdminAccountId.trim() || undefined,
        actor_user_id: filters.actorUserId.trim() || undefined,
        start_at: filters.startAt ? new Date(filters.startAt).toISOString() : undefined,
        end_at: filters.endAt ? new Date(filters.endAt).toISOString() : undefined,
      })
      setItems(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载敏感操作审计失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(emptyFilters)
  }, [load])

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-title font-semibold">敏感操作审计</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>筛选</CardTitle>
          <CardDescription>按权限点或目标类型排查操作链路。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-4">
          <Input
            placeholder="action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
          <Input
            placeholder="permission code"
            value={permissionCode}
            onChange={(event) => setPermissionCode(event.target.value)}
          />
          <Input
            placeholder="target type"
            value={targetType}
            onChange={(event) => setTargetType(event.target.value)}
          />
          <Input
            placeholder="actor admin account id"
            value={actorAdminAccountId}
            onChange={(event) => setActorAdminAccountId(event.target.value)}
          />
          <Input
            placeholder="actor user id"
            value={actorUserId}
            onChange={(event) => setActorUserId(event.target.value)}
          />
          <Input
            type="datetime-local"
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
          />
          <Input
            type="datetime-local"
            value={endAt}
            onChange={(event) => setEndAt(event.target.value)}
          />
          <Button variant="outline" disabled={loading} onClick={() => void load(currentFilters())}>
            查询
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-md border border-destructive/40 p-3 text-body text-destructive">
          {error}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>审计记录</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <div className="grid min-w-[1320px] grid-cols-[180px_180px_170px_150px_180px_1fr_180px_100px] bg-muted/40 px-4 py-2 text-caption font-medium">
              <div>时间</div>
              <div>操作人</div>
              <div>权限点</div>
              <div>动作</div>
              <div>目标</div>
              <div>原因</div>
              <div>请求</div>
              <div>详情</div>
            </div>
            {items.map((item) => (
              <div
                key={item.id}
                className="grid min-w-[1320px] grid-cols-[180px_180px_170px_150px_180px_1fr_180px_100px] border-t px-4 py-3 text-body"
              >
                <div>{formatDateTime(item.created_at)}</div>
                <div>
                  <div>{item.actor_display_name || '—'}</div>
                  <div className="break-all text-caption text-muted-foreground">
                    {item.actor_admin_account_id || item.actor_user_id || '—'}
                  </div>
                </div>
                <div>
                  <Badge variant="outline">{item.permission_code}</Badge>
                </div>
                <div>{item.action}</div>
                <div>
                  <div>{item.target_type}</div>
                  <div className="break-all text-caption text-muted-foreground">
                    {item.target_id || '—'}
                  </div>
                </div>
                <div>
                  <div>{item.reason}</div>
                  {item.ticket_id ? (
                    <div className="text-caption text-muted-foreground">工单：{item.ticket_id}</div>
                  ) : null}
                </div>
                <div>
                  <div>{item.ip || '—'}</div>
                  <div className="break-all text-caption text-muted-foreground">
                    {item.request_id || '—'}
                  </div>
                </div>
                <div>
                  <Button size="sm" variant="outline" onClick={() => setSelectedItem(item)}>
                    JSON
                  </Button>
                </div>
              </div>
            ))}
            {!items.length ? (
              <div className="px-4 py-8 text-center text-body text-muted-foreground">
                暂无敏感操作记录
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <AdminAuditDrawer
        open={selectedItem !== null}
        title={
          selectedItem ? `${selectedItem.action} · ${selectedItem.permission_code}` : '审计详情'
        }
        onClose={() => setSelectedItem(null)}
      >
        {selectedItem ? (
          <div className="space-y-4">
            <div className="rounded-md border p-3 text-body">
              <div className="font-medium">基本信息</div>
              <div className="mt-2 text-caption text-muted-foreground">
                {selectedItem.target_type}:{selectedItem.target_id || '-'} ·{' '}
                {formatDateTime(selectedItem.created_at)}
              </div>
              <div className="mt-2">{selectedItem.reason}</div>
            </div>
            <div>
              <div className="mb-2 font-medium">Before JSON</div>
              <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-3 text-caption">
                {JSON.stringify(selectedItem.before_json, null, 2)}
              </pre>
            </div>
            <div>
              <div className="mb-2 font-medium">After JSON</div>
              <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-3 text-caption">
                {JSON.stringify(selectedItem.after_json, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </AdminAuditDrawer>
    </div>
  )
}
