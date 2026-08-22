import { getCeleryOverview } from '@/celery-management/api/celery-management'
import type { CeleryOverview } from '@/celery-management/types'
import { AdminPage } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Server, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

export function CeleryOverviewPage() {
  const [data, setData] = useState<CeleryOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await getCeleryOverview()
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取 Celery 概览失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-destructive">
        <AlertCircle className="h-6 w-6" />
        <p className="text-body">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchData}>
          重试
        </Button>
      </div>
    )
  }

  if (!data) return null

  const hasIssues = data.issues.length > 0

  return (
    <AdminPage>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-heading font-bold tracking-tight">Celery 总览</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-body font-medium text-muted-foreground">Workers</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-heading font-bold">
              {data.workers_healthy}
              <span className="text-body font-normal text-muted-foreground">
                {' '}
                / {data.workers_total}
              </span>
            </div>
            <p className="text-body text-muted-foreground mt-1">活跃 / 总计</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-body font-medium text-muted-foreground">
              队列待处理
            </CardTitle>
            <TriangleAlert className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-heading font-bold">
              {data.queues.reduce((sum, q) => sum + q.pending, 0)}
            </div>
            <p className="text-body text-muted-foreground mt-1">{data.queues.length} 个队列</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-body font-medium text-muted-foreground">
              未解决失败任务
            </CardTitle>
            <AlertCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <Link to="/celery/failed-tasks" className="hover:underline">
              <div className="text-heading font-bold text-destructive">{data.failed_open}</div>
            </Link>
            <p className="text-body text-muted-foreground mt-1">需要人工处理</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-body font-medium text-muted-foreground">
              24h 失败任务
            </CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-heading font-bold">{data.failed_total_24h}</div>
            <p className="text-body text-muted-foreground mt-1">近 24 小时</p>
          </CardContent>
        </Card>
      </div>

      {/* 告警信息 */}
      {hasIssues && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-body font-medium text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              告警 ({data.issues.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {data.issues.map((issue) => (
                <li key={issue} className="text-body text-destructive/80">
                  {issue}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* 队列详情 + Worker 列表 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-subtitle">队列详情</CardTitle>
          </CardHeader>
          <CardContent>
            {data.queues.length === 0 ? (
              <p className="text-body text-muted-foreground">暂无队列数据</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 font-medium">队列名称</th>
                      <th className="pb-2 font-medium text-right">待处理</th>
                      <th className="pb-2 font-medium text-right">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.queues.map((q) => (
                      <tr key={q.name} className="border-b last:border-0">
                        <td className="py-2 font-mono text-body">{q.name}</td>
                        <td className="py-2 text-right tabular-nums">{q.pending}</td>
                        <td className="py-2 text-right">
                          {q.warning ? (
                            <Badge variant="destructive">堆积</Badge>
                          ) : (
                            <Badge variant="secondary">正常</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subtitle">Worker 列表</CardTitle>
          </CardHeader>
          <CardContent>
            {data.worker_list.length === 0 ? (
              <p className="text-body text-muted-foreground">暂无 Worker 数据</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 font-medium">Worker</th>
                      <th className="pb-2 font-medium text-right">活跃任务</th>
                      <th className="pb-2 font-medium text-right">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.worker_list.map((w) => (
                      <tr key={w.name} className="border-b last:border-0">
                        <td className="py-2 font-mono text-body">{w.name}</td>
                        <td className="py-2 text-right tabular-nums">{w.active_tasks}</td>
                        <td className="py-2 text-right">
                          <CheckCircle2 className="inline h-4 w-4 text-success" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  )
}
