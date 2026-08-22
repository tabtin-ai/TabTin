import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getToolDetail, getToolList, syncTools, toggleToolStatus } from '../api/tool-management'
import type { ToolBrief, ToolDetail, ToolListResponse } from '../types'

const RISK_CONFIG: Record<string, { label: string; color: string; icon: typeof Shield }> = {
  safe: { label: '安全', color: 'bg-success/10 text-success', icon: ShieldCheck },
  review: { label: '需审核', color: 'bg-warning/10 text-warning', icon: Shield },
  strict: { label: '严格', color: 'bg-destructive/10 text-destructive', icon: ShieldAlert },
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  active: { label: '启用', color: 'bg-success/10 text-success' },
  disabled: { label: '禁用', color: 'bg-muted text-muted-foreground' },
  deprecated: { label: '已弃用', color: 'bg-warning/10 text-warning' },
}

const SOURCE_CONFIG: Record<string, { label: string }> = {
  builtin: { label: '内置' },
  manifest: { label: 'Manifest' },
  extension: { label: '扩展' },
  custom: { label: '自定义' },
}

const DEFAULT_PAGE_SIZE = 20
type PendingToolStatusAction = {
  tool: ToolBrief
  nextStatus: 'active' | 'disabled'
}

function RiskBadge({ risk }: { risk: string }) {
  const cfg = RISK_CONFIG[risk] || {
    label: risk,
    color: 'bg-muted text-muted-foreground',
    icon: Shield,
  }
  const Icon = cfg.icon
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-body font-medium ${cfg.color}`}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: 'bg-muted text-muted-foreground' }
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-body font-medium ${cfg.color}`}
    >
      {cfg.label}
    </span>
  )
}

function compactCode(value?: string | null, start = 18, end = 8): string {
  if (!value) return '—'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
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

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-caption font-mono">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function ToolOverviewPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { show: showToast, element: toastEl } = useSimpleToast()

  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ToolListResponse | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingToolAction, setPendingToolAction] = useState<PendingToolStatusAction | null>(null)
  const [sensitiveReason, setSensitiveReason] = useState('')
  const [sensitiveTicketId, setSensitiveTicketId] = useState('')
  const [sensitiveSubmitting, setSensitiveSubmitting] = useState(false)

  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [domain, setDomain] = useState(searchParams.get('domain') || '')
  const [source, setSource] = useState(searchParams.get('source') || '')
  const [status, setStatus] = useState(searchParams.get('status') || '')
  const [riskFilter, setRiskFilter] = useState(searchParams.get('risk') || '')
  const [page, setPage] = useState(Number(searchParams.get('page')) || 1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [selectedTool, setSelectedTool] = useState<ToolDetail | null>(null)
  const [selectedBrief, setSelectedBrief] = useState<ToolBrief | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailTab, setDetailTab] = useState('overview')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setErrorMessage(null)
    try {
      const toolsResp = await getToolList({
        q: query || undefined,
        domain: domain || undefined,
        source: source || undefined,
        status: status || undefined,
        page,
        page_size: pageSize,
      })
      setData(toolsResp)
    } catch (err) {
      console.error('Failed to fetch tools:', err)
      setErrorMessage(err instanceof Error ? err.message : '加载工具列表失败')
    } finally {
      setLoading(false)
    }
  }, [query, domain, source, status, page, pageSize])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (query) params.q = query
    if (domain) params.domain = domain
    if (source) params.source = source
    if (status) params.status = status
    if (riskFilter) params.risk = riskFilter
    if (page > 1) params.page = String(page)
    if (pageSize !== DEFAULT_PAGE_SIZE) params.page_size = String(pageSize)
    setSearchParams(params, { replace: true })
  }, [query, domain, source, status, riskFilter, page, pageSize, setSearchParams])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const result = await syncTools()
      showToast(
        `同步完成：新增 ${result.created}，更新 ${result.updated}，弃用 ${result.deprecated}，无变化 ${result.unchanged}`
      )
      await fetchData()
    } catch (err) {
      const message = err instanceof Error ? err.message : '同步失败'
      setErrorMessage(message)
      showToast(message, 'error')
    } finally {
      setSyncing(false)
    }
  }

  const handleToggleStatus = async (tool: ToolBrief) => {
    const newStatus = tool.status === 'active' ? 'disabled' : 'active'
    setPendingToolAction({ tool, nextStatus: newStatus })
    setSensitiveReason('')
    setSensitiveTicketId('')
  }

  const executePendingToolAction = async () => {
    if (!pendingToolAction) {
      return
    }
    const reason = sensitiveReason.trim()
    if (!reason) {
      setErrorMessage('reason 必填')
      return
    }
    setSensitiveSubmitting(true)
    try {
      await toggleToolStatus(pendingToolAction.tool.name, pendingToolAction.nextStatus, {
        reason,
        ticket_id: sensitiveTicketId.trim() || undefined,
      })
      showToast(
        `已将 ${pendingToolAction.tool.name} 设置为${pendingToolAction.nextStatus === 'active' ? '启用' : '禁用'}`
      )
      setPendingToolAction(null)
      await fetchData()
    } catch (err) {
      const message = err instanceof Error ? err.message : '状态切换失败'
      setErrorMessage(message)
      showToast(message, 'error')
    } finally {
      setSensitiveSubmitting(false)
    }
  }

  const handleOpenDetail = async (tool: ToolBrief, tab = 'overview') => {
    setSelectedBrief(tool)
    setSelectedTool(null)
    setDetailTab(tab)
    setDetailLoading(true)
    try {
      const detail = await getToolDetail(tool.name)
      setSelectedTool(detail)
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载工具详情失败'
      setErrorMessage(message)
      showToast(message, 'error')
    } finally {
      setDetailLoading(false)
    }
  }

  const clearFilters = () => {
    setQuery('')
    setDomain('')
    setSource('')
    setStatus('')
    setRiskFilter('')
    setPage(1)
  }

  const filteredTools = data?.items?.filter((t) => {
    if (riskFilter && t.risk_level !== riskFilter) return false
    return true
  })

  const currentPageTools = data?.items ?? []
  const currentActiveCount = useMemo(
    () => currentPageTools.filter((tool) => tool.status === 'active').length,
    [currentPageTools]
  )
  const currentStrictCount = useMemo(
    () => currentPageTools.filter((tool) => tool.risk_level === 'strict').length,
    [currentPageTools]
  )
  const currentReviewCount = useMemo(
    () => currentPageTools.filter((tool) => tool.risk_level === 'review').length,
    [currentPageTools]
  )

  const hasFilters = Boolean(query || domain || source || status || riskFilter)

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="工具管理"
        icon={Wrench}
        badges={
          hasFilters ? (
            <Badge variant="outline">
              当前筛选：
              {[
                query ? `关键词 ${query}` : '',
                domain ? `域 ${domain}` : '',
                source ? `来源 ${source}` : '',
                status ? `状态 ${status}` : '',
                riskFilter ? `风险 ${riskFilter}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Badge>
          ) : null
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/tool-audit')}>
              <CheckCircle2 className="mr-2 h-4 w-4" />
              审计面板
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/skill-review')}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              Skill 审核
            </Button>
            <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
              {syncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              同步工具
            </Button>
          </>
        }
      />

      {errorMessage ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <AdminMetricCard
          title="工具总数"
          value={data?.total ?? '—'}
          hint="后端返回的工具总量。"
          icon={Wrench}
        />
        <AdminMetricCard title="当前页已启用" value={currentActiveCount} icon={CheckCircle2} />
        <AdminMetricCard title="当前页高风险" value={currentStrictCount} icon={ShieldAlert} />
        <AdminMetricCard title="当前页待处理" value={currentReviewCount} icon={Shield} />
      </div>

      <AdminListCard
        title="工具目录"
        actions={
          <>
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="工具名 / 工具域 / source"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setPage(1)
                }}
                className="pl-9"
              />
            </div>

            <Select
              value={domain || 'all'}
              onValueChange={(value) => {
                setDomain(value === 'all' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="工具域" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部域</SelectItem>
                {Array.from(new Set(data?.items?.map((tool) => tool.domain).filter(Boolean) || []))
                  .sort()
                  .map((domainValue) => (
                    <SelectItem key={domainValue} value={domainValue}>
                      {domainValue}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>

            <Select
              value={source || 'all'}
              onValueChange={(value) => {
                setSource(value === 'all' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-[130px]">
                <SelectValue placeholder="来源" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                {Object.entries(SOURCE_CONFIG).map(([key, item]) => (
                  <SelectItem key={key} value={key}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={riskFilter || 'all'}
              onValueChange={(value) => {
                setRiskFilter(value === 'all' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-[130px]">
                <SelectValue placeholder="风险等级" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部风险</SelectItem>
                {Object.entries(RISK_CONFIG).map(([key, item]) => (
                  <SelectItem key={key} value={key}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={status || 'all'}
              onValueChange={(value) => {
                setStatus(value === 'all' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(STATUS_CONFIG).map(([key, item]) => (
                  <SelectItem key={key} value={key}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {hasFilters ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-3 w-3" />
                重置
              </Button>
            ) : null}
          </>
        }
        contentClassName="space-y-4"
      >
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="rounded-md border">
              <table className="w-full text-body">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">工具</th>
                    <th className="px-4 py-3 text-left font-medium">来源</th>
                    <th className="px-4 py-3 text-left font-medium">工具域</th>
                    <th className="px-4 py-3 text-left font-medium">状态</th>
                    <th className="px-4 py-3 text-left font-medium">风险</th>
                    <th className="px-4 py-3 text-left font-medium">最近同步</th>
                    <th className="px-4 py-3 text-left font-medium">更新时间</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTools?.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                        无匹配工具
                      </td>
                    </tr>
                  )}
                  {filteredTools?.map((tool) => (
                    <tr key={tool.name} className="border-b transition-colors hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => handleOpenDetail(tool)}
                          className="text-left text-body font-medium hover:text-primary"
                        >
                          {tool.display_name || tool.name}
                        </button>
                        <div className="text-caption text-muted-foreground font-mono">
                          {compactCode(tool.name)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-body text-muted-foreground">
                        {SOURCE_CONFIG[tool.source]?.label || tool.source}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-body">
                          {tool.domain}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={tool.status} />
                      </td>
                      <td className="px-4 py-3">
                        <RiskBadge risk={tool.risk_level} />
                      </td>
                      <td className="px-4 py-3 text-body text-muted-foreground">暂无同步时间</td>
                      <td className="px-4 py-3 text-body text-muted-foreground">详情内查看</td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenDetail(tool)}
                          className="text-body"
                        >
                          详情
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenDetail(tool, 'schema')}
                          className="text-body"
                        >
                          更多
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleToggleStatus(tool)
                          }}
                          className="text-body"
                        >
                          {tool.status === 'active' ? '禁用' : '启用'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              total={data?.total ?? 0}
              pageSize={pageSize}
              onChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPage(1)
                setPageSize(nextPageSize)
              }}
            />
          </>
        )}
      </AdminListCard>

      <Dialog
        open={Boolean(selectedBrief)}
        onOpenChange={(open) => !open && setSelectedBrief(null)}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(720px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>
              {selectedBrief?.display_name || selectedBrief?.name || '工具详情'}
            </DialogTitle>
            <DialogDescription>
              tool code · <code>{compactCode(selectedBrief?.name)}</code>
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-4">
            <Tabs value={detailTab} onValueChange={setDetailTab}>
              <TabsList className="flex flex-wrap">
                <TabsTrigger value="overview">概览</TabsTrigger>
                <TabsTrigger value="schema">Schema</TabsTrigger>
                <TabsTrigger value="permission">权限</TabsTrigger>
                <TabsTrigger value="risk">风险</TabsTrigger>
                <TabsTrigger value="audit">审计</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="mt-4">
                <div className="rounded-lg border p-4">
                  <InfoRow
                    label="tool_id"
                    value={<code>{selectedTool?.id || selectedBrief?.id}</code>}
                  />
                  <InfoRow
                    label="tool code"
                    value={<code>{selectedTool?.name || selectedBrief?.name}</code>}
                  />
                  <InfoRow label="source" value={selectedTool?.source || selectedBrief?.source} />
                  <InfoRow label="domain" value={selectedTool?.domain || selectedBrief?.domain} />
                  <InfoRow
                    label="capability"
                    value={selectedTool?.interface_type || selectedBrief?.interface_type}
                  />
                  <InfoRow
                    label="状态"
                    value={
                      <StatusBadge status={selectedTool?.status || selectedBrief?.status || ''} />
                    }
                  />
                  <InfoRow
                    label="描述"
                    value={selectedTool?.description || selectedBrief?.description}
                  />
                  <InfoRow label="created_at" value={formatDateTime(selectedTool?.created_at)} />
                  <InfoRow label="updated_at" value={formatDateTime(selectedTool?.updated_at)} />
                </div>
              </TabsContent>
              <TabsContent value="schema" className="mt-4 space-y-3">
                {detailLoading ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    加载中...
                  </div>
                ) : selectedTool ? (
                  <>
                    <div>
                      <div className="mb-2 text-body font-medium">参数 Schema</div>
                      <JsonBlock value={selectedTool.parameters_schema} />
                    </div>
                    <div>
                      <div className="mb-2 text-body font-medium">返回 Schema</div>
                      <JsonBlock value={selectedTool.return_schema} />
                    </div>
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    暂无记录
                  </div>
                )}
              </TabsContent>
              <TabsContent value="permission" className="mt-4">
                {selectedTool?.permissions?.length ? (
                  <div className="flex flex-wrap gap-2 rounded-lg border p-4">
                    {selectedTool.permissions.map((permission) => (
                      <Badge key={permission} variant="outline">
                        {permission}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    暂无权限记录
                  </div>
                )}
              </TabsContent>
              <TabsContent value="risk" className="mt-4">
                <div className="rounded-lg border p-4">
                  <InfoRow
                    label="risk"
                    value={
                      <RiskBadge
                        risk={selectedTool?.risk_level || selectedBrief?.risk_level || ''}
                      />
                    }
                  />
                  <InfoRow
                    label="optional"
                    value={String(selectedTool?.optional ?? selectedBrief?.optional ?? '—')}
                  />
                  <InfoRow
                    label="execution_target"
                    value={selectedTool?.execution_target || selectedBrief?.execution_target}
                  />
                </div>
              </TabsContent>
              <TabsContent value="audit" className="mt-4">
                <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                  暂无记录
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>
      {pendingToolAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-md border bg-background p-4 shadow-lg">
            <div className="text-subtitle font-semibold">敏感工具治理操作</div>
            <div className="mt-2 text-body text-muted-foreground">
              Tool 启停会影响 Agent/Tool runtime 可用性。请填写 reason，ticket 可选。
            </div>
            <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-body">
              {pendingToolAction.nextStatus === 'active' ? '启用' : '禁用'} Tool：
              {pendingToolAction.tool.name}
            </div>
            <Input
              className="mt-3"
              placeholder="reason（必填）"
              value={sensitiveReason}
              onChange={(event) => setSensitiveReason(event.target.value)}
              disabled={sensitiveSubmitting}
            />
            <Input
              className="mt-3"
              placeholder="ticket_id（可选）"
              value={sensitiveTicketId}
              onChange={(event) => setSensitiveTicketId(event.target.value)}
              disabled={sensitiveSubmitting}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setPendingToolAction(null)}
                disabled={sensitiveSubmitting}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={executePendingToolAction}
                disabled={sensitiveSubmitting || !sensitiveReason.trim()}
              >
                {sensitiveSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                确认执行
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </AdminPage>
  )
}
