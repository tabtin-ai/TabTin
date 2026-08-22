import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { runAuditApps, runAuditTools } from '../api/tool-management'
import type {
  AuditAppResult,
  AuditAppsResponse,
  AuditCheckResult,
  AuditToolsResponse,
} from '../types'

export function ToolAuditPage() {
  const [tab, setTab] = useState<'tools' | 'apps'>('tools')
  const [toolsData, setToolsData] = useState<AuditToolsResponse | null>(null)
  const [appsData, setAppsData] = useState<AuditAppsResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const runToolAudit = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await runAuditTools()
      setToolsData(resp)
    } catch (err) {
      console.error('Tool audit failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const runAppAudit = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await runAuditApps()
      setAppsData(resp)
    } catch (err) {
      console.error('App audit failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'tools' && !toolsData) runToolAudit()
    if (tab === 'apps' && !appsData) runAppAudit()
  }, [appsData, runAppAudit, runToolAudit, tab, toolsData])

  return (
    <AdminPage>
      <AdminPageHeader
        title="工具审计"
        icon={CheckCircle2}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={tab === 'tools' ? runToolAudit : runAppAudit}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" />
            )}
            刷新
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'tools' | 'apps')}>
        <TabsList>
          <TabsTrigger value="tools">
            工具审计
            {toolsData && (
              <span className="ml-2 text-body">({toolsData.summary.total_tools} 工具)</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="apps">
            App 审计
            {appsData && (
              <span className="ml-2 text-body">({appsData.summary.total_apps} Apps)</span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tools" className="space-y-6 mt-4">
          {loading && !toolsData ? (
            <AuditLoading />
          ) : toolsData ? (
            <ToolsAuditContent data={toolsData} />
          ) : null}
        </TabsContent>

        <TabsContent value="apps" className="space-y-6 mt-4">
          {loading && !appsData ? (
            <AuditLoading />
          ) : appsData ? (
            <AppsAuditContent data={appsData} />
          ) : null}
        </TabsContent>
      </Tabs>
    </AdminPage>
  )
}

function AuditLoading() {
  return (
    <div className="flex flex-col items-center gap-3 py-20">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <p className="text-body text-muted-foreground">正在运行审计检查...</p>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const displayValue = value === null || value === undefined || value === '' ? '—' : value
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 text-body last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[360px] break-words text-right">{displayValue}</span>
    </div>
  )
}

type ToolAuditRow = {
  id: string
  title: string
  target: string
  source: string
  domain: string
  status: string
  level: string
  checks: AuditCheckResult[]
}

function CheckStatusBadge({ status }: { status: string }) {
  if (status === '✗') {
    return (
      <span className="rounded-full border border-rose-200 bg-rose-100 px-2 py-0.5 text-caption text-rose-800">
        失败
      </span>
    )
  }
  if (status === '⚠') {
    return (
      <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-caption text-amber-800">
        警告
      </span>
    )
  }
  if (status === '✓') {
    return (
      <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-caption text-emerald-800">
        通过
      </span>
    )
  }
  return (
    <span className="rounded-full border border-muted bg-muted px-2 py-0.5 text-caption text-muted-foreground">
      信息
    </span>
  )
}

function CheckLevelBadge({ level }: { level: string }) {
  const className =
    level === '失败'
      ? 'border-rose-200 bg-rose-100 text-rose-800'
      : level === '警告'
        ? 'border-amber-200 bg-amber-100 text-amber-800'
        : level === '通过'
          ? 'border-emerald-200 bg-emerald-100 text-emerald-800'
          : 'border-muted bg-muted text-muted-foreground'
  return (
    <span className={`rounded-full border px-2 py-0.5 text-caption ${className}`}>{level}</span>
  )
}

function ToolsAuditContent({ data }: { data: AuditToolsResponse }) {
  const [selectedRow, setSelectedRow] = useState<ToolAuditRow | null>(null)
  const [detailTab, setDetailTab] = useState('overview')
  const { summary } = data
  const rows = useMemo<ToolAuditRow[]>(() => {
    const globalRows = data.global_checks.map((check, index) => ({
      id: `global:${index}`,
      title: check.message,
      target: '全局检查',
      source: '系统审计',
      domain: check.dimension || 'global',
      status: check.status,
      level:
        check.status === '✗'
          ? '失败'
          : check.status === '⚠'
            ? '警告'
            : check.status === '✓'
              ? '通过'
              : '信息',
      checks: [check],
    }))
    const toolRows = data.tools.map((tool) => ({
      id: `tool:${tool.name}`,
      title:
        tool.fail_count > 0
          ? '工具检查失败'
          : tool.warn_count > 0
            ? '工具存在警告'
            : '工具检查通过',
      target: tool.name,
      source: tool.source,
      domain: tool.domain,
      status: tool.fail_count > 0 ? '✗' : tool.warn_count > 0 ? '⚠' : '✓',
      level: tool.fail_count > 0 ? '失败' : tool.warn_count > 0 ? '警告' : '通过',
      checks: tool.checks,
    }))
    return [...globalRows, ...toolRows]
  }, [data])

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label="当前审计项" value={rows.length} />
        <SummaryCard
          label="失败检查"
          value={summary.total_fail + summary.global_fail}
          danger={summary.total_fail + summary.global_fail > 0}
        />
        <SummaryCard
          label="警告检查"
          value={summary.total_warn + summary.global_warn}
          warn={summary.total_warn + summary.global_warn > 0}
        />
        <SummaryCard label="涉及工具" value={summary.total_tools} />
      </div>

      <div className="rounded-lg border bg-background">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-body font-semibold">工具审计检查</h2>
            <p className="text-caption text-muted-foreground">
              当前数据源为审计检查结果，不包含操作人、真实风险等级或请求流水
            </p>
          </div>
          <Badge variant="outline">
            后端 {summary.backend_count} / 前端 {summary.frontend_count}
          </Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">检查项</th>
                <th className="px-4 py-3 text-left font-medium">对象</th>
                <th className="px-4 py-3 text-left font-medium">来源</th>
                <th className="px-4 py-3 text-left font-medium">结果</th>
                <th className="px-4 py-3 text-left font-medium">检查状态</th>
                <th className="px-4 py-3 text-left font-medium">数据口径</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.title}</div>
                    <code className="text-caption text-muted-foreground">{row.status}</code>
                  </td>
                  <td className="px-4 py-3">
                    <div>{row.target}</div>
                    <code className="text-caption text-muted-foreground">{row.domain}</code>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{row.source}</td>
                  <td className="px-4 py-3">
                    <CheckStatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3">
                    <CheckLevelBadge level={row.level} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">当前审计检查结果</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                      onClick={() => {
                        setSelectedRow(row)
                        setDetailTab('overview')
                      }}
                    >
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={Boolean(selectedRow)} onOpenChange={(open) => !open && setSelectedRow(null)}>
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>{selectedRow?.title || '审计详情'}</DialogTitle>
            <DialogDescription>
              check status · <code>{selectedRow?.status || '—'}</code>
            </DialogDescription>
          </DialogHeader>
          {selectedRow ? (
            <div className="px-6 py-4">
              <Tabs value={detailTab} onValueChange={setDetailTab}>
                <TabsList className="flex flex-wrap">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="diff">变更前后</TabsTrigger>
                  <TabsTrigger value="request">请求信息</TabsTrigger>
                  <TabsTrigger value="risk">风险</TabsTrigger>
                  <TabsTrigger value="audit">审计</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="mt-4">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="检查项" value={selectedRow.title} />
                    <InfoRow label="对象" value={<code>{selectedRow.target}</code>} />
                    <InfoRow label="source" value={selectedRow.source} />
                    <InfoRow label="domain" value={selectedRow.domain} />
                    <InfoRow
                      label="result"
                      value={<CheckStatusBadge status={selectedRow.status} />}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="diff" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    当前审计接口不包含 before / after
                  </div>
                </TabsContent>
                <TabsContent value="request" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    当前审计接口不包含请求信息
                  </div>
                </TabsContent>
                <TabsContent value="risk" className="mt-4">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="真实风险字段" value="当前审计接口不包含" />
                    <InfoRow
                      label="检查状态"
                      value={<CheckLevelBadge level={selectedRow.level} />}
                    />
                    <InfoRow label="检查项" value={`${selectedRow.checks.length} 条`} />
                  </div>
                </TabsContent>
                <TabsContent value="audit" className="mt-4 space-y-2">
                  <CheckList checks={selectedRow.checks} />
                </TabsContent>
              </Tabs>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function AppsAuditContent({ data }: { data: AuditAppsResponse }) {
  const [selectedApp, setSelectedApp] = useState<AuditAppResult | null>(null)

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label="App 总数" value={data.summary.total_apps} />
        <SummaryCard label="通过" value={data.summary.total_pass} />
        <SummaryCard
          label="失败"
          value={data.summary.total_fail}
          danger={data.summary.total_fail > 0}
        />
        <SummaryCard
          label="警告"
          value={data.summary.total_warn}
          warn={data.summary.total_warn > 0}
        />
      </div>

      <div className="rounded-lg border bg-background">
        <div className="border-b px-4 py-3">
          <h2 className="text-body font-semibold">App 审计检查</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">检查项</th>
                <th className="px-4 py-3 text-left font-medium">App</th>
                <th className="px-4 py-3 text-left font-medium">结果</th>
                <th className="px-4 py-3 text-left font-medium">检查状态</th>
                <th className="px-4 py-3 text-left font-medium">数据口径</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.apps.map((app) => (
                <tr key={app.app_id} className="border-b hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {app.fail_count > 0
                        ? 'App 检查失败'
                        : app.warn_count > 0
                          ? 'App 存在警告'
                          : 'App 检查通过'}
                    </div>
                    <code className="text-caption text-muted-foreground">{app.context_type}</code>
                  </td>
                  <td className="px-4 py-3">
                    <div>{app.app_name}</div>
                    <code className="text-caption text-muted-foreground">{app.app_id}</code>
                  </td>
                  <td className="px-4 py-3">
                    <CheckStatusBadge
                      status={app.fail_count > 0 ? '✗' : app.warn_count > 0 ? '⚠' : '✓'}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <CheckLevelBadge
                      level={app.fail_count > 0 ? '失败' : app.warn_count > 0 ? '警告' : '通过'}
                    />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">当前审计检查结果</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                      onClick={() => setSelectedApp(app)}
                    >
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={Boolean(selectedApp)} onOpenChange={(open) => !open && setSelectedApp(null)}>
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>{selectedApp?.app_name || 'App 审计详情'}</DialogTitle>
            <DialogDescription>
              app_id · <code>{selectedApp?.app_id || '—'}</code>
            </DialogDescription>
          </DialogHeader>
          {selectedApp ? (
            <div className="px-6 py-4 space-y-4">
              <div className="rounded-lg border p-4">
                <InfoRow label="app_id" value={<code>{selectedApp.app_id}</code>} />
                <InfoRow label="context_type" value={selectedApp.context_type} />
                <InfoRow label="检查项" value={selectedApp.total} />
                <InfoRow label="失败" value={selectedApp.fail_count} />
                <InfoRow label="警告" value={selectedApp.warn_count} />
              </div>
              <CheckList checks={selectedApp.checks} grouped />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function CheckList({ checks, grouped }: { checks: AuditCheckResult[]; grouped?: boolean }) {
  if (grouped) {
    const dims = new Map<string, AuditCheckResult[]>()
    for (const c of checks) {
      const key = c.dimension || '其他'
      const items = dims.get(key)
      if (items) {
        items.push(c)
      } else {
        dims.set(key, [c])
      }
    }
    return (
      <div className="space-y-3">
        {Array.from(dims).map(([dim, items]) => (
          <div key={dim}>
            <h4 className="mb-1 text-body font-semibold text-muted-foreground uppercase tracking-wide">
              {dim}
            </h4>
            <div className="space-y-0.5">
              {items.map((c) => (
                <CheckItem key={`${c.status}-${c.dimension || '其他'}-${c.message}`} check={c} />
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {checks.map((c) => (
        <CheckItem key={`${c.status}-${c.dimension || '其他'}-${c.message}`} check={c} />
      ))}
    </div>
  )
}

function CheckItem({ check }: { check: AuditCheckResult }) {
  const bg =
    check.status === '✓'
      ? 'bg-success/10 text-success'
      : check.status === '✗'
        ? 'bg-destructive/10 text-destructive'
        : check.status === '⚠'
          ? 'bg-warning/10 text-warning'
          : 'bg-muted text-muted-foreground'
  return (
    <div className={`flex items-start gap-2 rounded px-2.5 py-1 text-body ${bg}`}>
      <span className="font-mono w-4 flex-shrink-0 text-center">{check.status}</span>
      <span className="break-words">{check.message}</span>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  sub,
  danger,
  warn,
}: {
  label: string
  value: number | string
  sub?: string
  danger?: boolean
  warn?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${danger ? 'border-destructive/30 bg-destructive/10' : warn ? 'border-warning/30 bg-warning/10' : 'bg-card'}`}
    >
      <span className="text-body text-muted-foreground">{label}</span>
      <div
        className={`mt-1 text-heading font-bold ${danger ? 'text-destructive' : warn ? 'text-warning' : ''}`}
      >
        {value}
      </div>
      {sub && <span className="text-body text-muted-foreground">{sub}</span>}
    </div>
  )
}
