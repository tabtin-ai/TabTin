import { type AdminLoginLogItem, listAdminLoginLogs } from '@/api/admin-audit'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/utils'
import { useCallback, useEffect, useState } from 'react'

export function AdminLoginLogsPage() {
  const [items, setItems] = useState<AdminLoginLogItem[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await listAdminLoginLogs()
      setItems(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载后台登录日志失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-title font-semibold">后台登录日志</h1>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>登录记录</CardTitle>
              <CardDescription>按时间倒序展示最近后台登录。</CardDescription>
            </div>
            <Button variant="outline" disabled={loading} onClick={load}>
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {error ? <div className="mb-3 text-body text-destructive">{error}</div> : null}
          <div className="overflow-x-auto rounded-md border">
            <div className="grid min-w-[900px] grid-cols-[180px_220px_120px_160px_1fr] bg-muted/40 px-4 py-2 text-caption font-medium">
              <div>时间</div>
              <div>后台账号</div>
              <div>结果</div>
              <div>IP</div>
              <div>失败原因</div>
            </div>
            {items.map((item) => (
              <div
                key={item.id}
                className="grid min-w-[900px] grid-cols-[180px_220px_120px_160px_1fr] border-t px-4 py-3 text-body"
              >
                <div>{formatDateTime(item.created_at)}</div>
                <div>
                  <div>{item.display_name || '—'}</div>
                  <div className="break-all text-caption text-muted-foreground">
                    {item.admin_account_id || item.user_id}
                  </div>
                </div>
                <div>
                  <Badge variant={item.success ? 'success' : 'destructive'}>
                    {item.success ? '成功' : '失败'}
                  </Badge>
                </div>
                <div>{item.ip || '—'}</div>
                <div>{item.fail_reason || '—'}</div>
              </div>
            ))}
            {!items.length ? (
              <div className="px-4 py-8 text-center text-body text-muted-foreground">
                暂无后台登录日志
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
