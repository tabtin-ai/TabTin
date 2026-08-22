import { getApiClient } from '@/api/tabtin-client'
import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/utils'
import { AlertTriangle, RefreshCw, ServerCrash, ShieldAlert, Target } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

interface ErrorCodeStats {
  count_24h: number
  count_7d: number
  last_seen: string | null
  top_scenes: Array<{ scene_key: string; count: number }>
}

type IncidentRow = {
  code: string
  title: string
  category: string
  count24h: number
  count7d: number
  lastSeen: string | null
  topScenes: Array<{ scene_key: string; count: number }>
  priority: '高' | '中' | '低'
  status: '待关注' | '历史'
}

function compactCode(value: string, start = 18, end = 8): string {
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function classifyIncident(code: string): { title: string; category: string } {
  const upper = code.toUpperCase()
  if (upper.includes('TIMEOUT') || upper.includes('E22')) {
    return { title: '超时', category: '模型调用失败' }
  }
  if (upper.includes('RATE_LIMIT') || upper.includes('E17')) {
    return { title: '限流', category: 'Provider 相关' }
  }
  if (upper.includes('AUTH') || upper.includes('KEY')) {
    return { title: '鉴权失败', category: 'Provider 相关' }
  }
  if (upper.includes('QUOTA') || upper.includes('BALANCE')) {
    return { title: '配额不足', category: 'Provider 相关' }
  }
  if (upper.includes('BINDING') || upper.includes('MISSING')) {
    return { title: '场景绑定异常', category: '场景绑定异常' }
  }
  if (upper.includes('CAPABILITY') || upper.includes('MISMATCH')) {
    return { title: '模型调用失败', category: '模型调用失败' }
  }
  if (upper.includes('PROVIDER') || upper.includes('BYOK')) {
    return { title: 'Provider 相关错误', category: 'Provider 相关' }
  }
  return { title: '模型调用失败', category: '模型调用失败' }
}

function getPriority(count24h: number, count7d: number): IncidentRow['priority'] {
  if (count24h >= 20 || count7d >= 100) return '高'
  if (count24h > 0 || count7d >= 20) return '中'
  return '低'
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const displayValue = value === null || value === undefined || value === '' ? '—' : value
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[360px] break-words text-right">{displayValue}</span>
    </div>
  )
}

function CompactMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | string
  icon: typeof AlertTriangle
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-3">
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}

export function IncidentPage() {
  const [stats, setStats] = useState<Record<string, ErrorCodeStats>>({})
  const [loading, setLoading] = useState(true)
  const [selectedIncident, setSelectedIncident] = useState<IncidentRow | null>(null)
  const [detailTab, setDetailTab] = useState('overview')

  const loadStats = useCallback(() => {
    setLoading(true)
    getApiClient()
      .raw<{ errors_by_code: Record<string, ErrorCodeStats> }>(
        'GET',
        '/services/llm/admin/incidents/error-stats'
      )
      .then((data) => setStats(data.errors_by_code))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const incidents = useMemo<IncidentRow[]>(() => {
    return Object.entries(stats)
      .map(([code, stat]) => {
        const cls = classifyIncident(code)
        const status: IncidentRow['status'] = stat.count_24h > 0 ? '待关注' : '历史'
        return {
          code,
          title: cls.title,
          category: cls.category,
          count24h: stat.count_24h,
          count7d: stat.count_7d,
          lastSeen: stat.last_seen,
          topScenes: stat.top_scenes || [],
          priority: getPriority(stat.count_24h, stat.count_7d),
          status,
        }
      })
      .sort((a, b) => b.count24h - a.count24h || b.count7d - a.count7d)
  }, [stats])

  const metrics = useMemo(() => {
    const open = incidents.filter((item) => item.status === '待关注').length
    const scenes = new Set(
      incidents.flatMap((item) => item.topScenes.map((scene) => scene.scene_key))
    )
    const providerAffected = incidents.filter((item) => item.category === 'Provider 相关').length
    const failuresToday = incidents.reduce((sum, item) => sum + item.count24h, 0)
    return { open, scenes: scenes.size, providerAffected, failuresToday }
  }, [incidents])

  const todoItems = incidents
    .filter((item) => item.count24h > 0 || item.priority !== '低')
    .slice(0, 8)

  return (
    <AdminPage>
      <AdminPageHeader
        title="AI 异常"
        icon={ShieldAlert}
        actions={
          <Button variant="outline" type="button" onClick={loadStats} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-4">
        <CompactMetric label="待关注异常" value={metrics.open} icon={AlertTriangle} />
        <CompactMetric label="影响场景" value={metrics.scenes} icon={Target} />
        <CompactMetric label="Provider 相关" value={metrics.providerAffected} icon={ServerCrash} />
        <CompactMetric label="24h 失败" value={metrics.failuresToday} icon={ShieldAlert} />
      </div>

      <section className="rounded-lg border bg-background">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-body font-semibold">待关注异常</h2>
            <p className="text-caption text-muted-foreground">按数量和影响范围排序</p>
          </div>
          <span className="text-caption text-muted-foreground">{todoItems.length} 项</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-2 text-left font-medium">异常</th>
                <th className="px-4 py-2 text-left font-medium">数量</th>
                <th className="px-4 py-2 text-left font-medium">影响范围</th>
                <th className="px-4 py-2 text-left font-medium">优先级</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    加载中...
                  </td>
                </tr>
              ) : todoItems.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    暂无待关注异常
                  </td>
                </tr>
              ) : (
                todoItems.map((item) => (
                  <tr key={`todo:${item.code}`} className="border-b">
                    <td className="px-4 py-2">
                      <div className="font-medium">{item.title}</div>
                      <code className="text-caption text-muted-foreground">
                        {compactCode(item.code)}
                      </code>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{item.count24h || item.count7d}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {item.topScenes.length ? `${item.topScenes.length} 个场景` : item.category}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-caption ${
                          item.priority === '高'
                            ? 'bg-red-100 text-red-800'
                            : item.priority === '中'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {item.priority}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                        onClick={() => {
                          setSelectedIncident(item)
                          setDetailTab('overview')
                        }}
                      >
                        查看
                      </button>
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-blue-700 hover:bg-blue-50"
                        onClick={() => {
                          setSelectedIncident(item)
                          setDetailTab('resolution')
                        }}
                      >
                        处理
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border bg-background">
        <div className="border-b px-4 py-3">
          <h2 className="text-body font-semibold">异常列表</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium">异常</th>
                <th className="px-4 py-3 text-left font-medium">Provider</th>
                <th className="px-4 py-3 text-left font-medium">模型 / 场景</th>
                <th className="px-4 py-3 text-left font-medium">影响范围</th>
                <th className="px-4 py-3 text-left font-medium">优先级</th>
                <th className="px-4 py-3 text-left font-medium">状态</th>
                <th className="px-4 py-3 text-left font-medium">最近发生</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    加载中...
                  </td>
                </tr>
              ) : incidents.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    最近 7 天没有错误记录
                  </td>
                </tr>
              ) : (
                incidents.map((item) => (
                  <tr key={item.code} className="border-b hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="font-medium">{item.title}</div>
                      <code className="text-caption text-muted-foreground">
                        {compactCode(item.code)}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.category === 'Provider 相关' ? 'Provider 相关' : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {item.topScenes[0] ? (
                        <div>
                          <div>场景</div>
                          <code className="text-caption text-muted-foreground">
                            {compactCode(item.topScenes[0].scene_key)}
                          </code>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.topScenes.length ? `${item.topScenes.length} 个场景` : item.category}
                    </td>
                    <td className="px-4 py-3">{item.priority}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-caption ${
                          item.status === '待关注'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(item.lastSeen)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                        onClick={() => {
                          setSelectedIncident(item)
                          setDetailTab('overview')
                        }}
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-muted-foreground hover:bg-muted"
                        onClick={() => {
                          setSelectedIncident(item)
                          setDetailTab('logs')
                        }}
                      >
                        更多
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog
        open={Boolean(selectedIncident)}
        onOpenChange={(open) => !open && setSelectedIncident(null)}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>{selectedIncident?.title || '异常详情'}</DialogTitle>
            <DialogDescription>
              异常代码 · <code>{selectedIncident ? compactCode(selectedIncident.code) : '—'}</code>
            </DialogDescription>
          </DialogHeader>
          {selectedIncident ? (
            <div className="px-6 py-4">
              <Tabs value={detailTab} onValueChange={setDetailTab}>
                <TabsList className="flex flex-wrap">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="impact">影响范围</TabsTrigger>
                  <TabsTrigger value="logs">日志</TabsTrigger>
                  <TabsTrigger value="resolution">处理记录</TabsTrigger>
                  <TabsTrigger value="audit">审计</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="mt-4 text-body">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="异常代码" value={<code>{selectedIncident.code}</code>} />
                    <InfoRow label="异常类型" value={selectedIncident.title} />
                    <InfoRow label="24h 次数" value={selectedIncident.count24h} />
                    <InfoRow label="7d 次数" value={selectedIncident.count7d} />
                    <InfoRow label="优先级" value={selectedIncident.priority} />
                    <InfoRow label="状态" value={selectedIncident.status} />
                    <InfoRow label="最近发生" value={formatDateTime(selectedIncident.lastSeen)} />
                  </div>
                </TabsContent>
                <TabsContent value="impact" className="mt-4 space-y-2">
                  {selectedIncident.topScenes.length > 0 ? (
                    selectedIncident.topScenes.map((scene) => (
                      <div key={scene.scene_key} className="rounded-lg border p-3 text-body">
                        <div className="font-medium">场景</div>
                        <code className="text-caption text-muted-foreground">
                          {scene.scene_key}
                        </code>
                        <div className="mt-1 text-caption text-muted-foreground">
                          {scene.count} 次
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      当前数据源不包含影响范围
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="logs" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    当前数据源不包含日志
                  </div>
                </TabsContent>
                <TabsContent value="resolution" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    当前数据源不包含处理记录
                  </div>
                </TabsContent>
                <TabsContent value="audit" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    当前数据源不包含审计记录
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
