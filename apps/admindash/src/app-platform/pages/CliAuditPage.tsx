import { AdminPage } from '@/components/admin-page'
import { PageSizeSelect } from '@/components/ui/pagination'
import { cn } from '@/lib/utils'
import { Download, RefreshCw, Terminal } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { appPlatformApi } from '../api/app-platform-api'
import type { CliAuditItem } from '../types'

function RiskBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    safe: 'bg-green-100 text-green-800',
    review: 'bg-yellow-100 text-yellow-800',
    strict: 'bg-red-100 text-red-800',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        colors[level] || 'bg-gray-100 text-gray-800'
      )}
    >
      {level}
    </span>
  )
}

function DecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return <span className="text-muted-foreground">—</span>
  const colors: Record<string, string> = {
    allow: 'bg-green-100 text-green-800',
    deny: 'bg-red-100 text-red-800',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        colors[decision] || 'bg-gray-100 text-gray-800'
      )}
    >
      {decision}
    </span>
  )
}

export function CliAuditPage() {
  const [items, setItems] = useState<CliAuditItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)

  const [filterBinary, setFilterBinary] = useState('')
  const [filterInnerBinary, setFilterInnerBinary] = useState('')
  const [filterRiskLevel, setFilterRiskLevel] = useState('')
  const [filterHitlDecision, setFilterHitlDecision] = useState('')
  const [filterDomain, setFilterDomain] = useState('')

  const buildParams = useCallback(() => {
    const params: Record<string, string | number> = { page, page_size: pageSize }
    if (filterBinary.trim()) params.binary = filterBinary.trim()
    if (filterInnerBinary.trim()) params.inner_binary = filterInnerBinary.trim()
    if (filterRiskLevel) params.risk_level = filterRiskLevel
    if (filterHitlDecision) params.hitl_user_decision = filterHitlDecision
    if (filterDomain.trim()) params.domain = filterDomain.trim()
    return params
  }, [
    page,
    pageSize,
    filterBinary,
    filterInnerBinary,
    filterRiskLevel,
    filterHitlDecision,
    filterDomain,
  ])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await appPlatformApi.listCliAudit(
        buildParams() as Parameters<typeof appPlatformApi.listCliAudit>[0]
      )
      setItems(res.items)
      setTotal(res.total)
      setTotalPages(res.pagination.total_pages)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [buildParams])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleExport = () => {
    const params: Record<string, string> = {}
    if (filterBinary.trim()) params.binary = filterBinary.trim()
    if (filterRiskLevel) params.risk_level = filterRiskLevel
    if (filterHitlDecision) params.hitl_user_decision = filterHitlDecision
    const url = appPlatformApi.getCliAuditExportUrl(params)
    window.open(url, '_blank')
  }

  return (
    <AdminPage>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">CLI 审计查看</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted"
          >
            <Download className="h-4 w-4" />
            导出 CSV
          </button>
          <button
            type="button"
            onClick={fetchData}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="binary"
          value={filterBinary}
          onChange={(e) => {
            setFilterBinary(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm w-36 bg-background"
        />
        <input
          type="text"
          placeholder="inner_binary"
          value={filterInnerBinary}
          onChange={(e) => {
            setFilterInnerBinary(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm w-36 bg-background"
        />
        <input
          type="text"
          placeholder="domain"
          value={filterDomain}
          onChange={(e) => {
            setFilterDomain(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm w-28 bg-background"
        />
        <select
          value={filterRiskLevel}
          onChange={(e) => {
            setFilterRiskLevel(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm bg-background"
        >
          <option value="">全部风险级别</option>
          <option value="safe">safe</option>
          <option value="review">review</option>
          <option value="strict">strict</option>
        </select>
        <select
          value={filterHitlDecision}
          onChange={(e) => {
            setFilterHitlDecision(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm bg-background"
        >
          <option value="">全部 HITL 决策</option>
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
      </div>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-3 text-left text-sm font-medium">Binary</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Inner</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Domain</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Verb</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Risk</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Decision</th>
              <th className="px-3 py-3 text-left text-sm font-medium">HITL</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Exit</th>
              <th className="px-3 py-3 text-left text-sm font-medium">时间</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  加载中...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  暂无数据
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 text-sm">
                    <div className="flex items-center gap-1">
                      <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono text-xs">{item.binary}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm font-mono text-xs">
                    {item.inner_binary || '—'}
                  </td>
                  <td className="px-3 py-2 text-sm">{item.domain}</td>
                  <td className="px-3 py-2 text-sm">{item.verb}</td>
                  <td className="px-3 py-2 text-sm">
                    <RiskBadge level={item.risk_level} />
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <span
                      className={cn(
                        'text-xs',
                        item.rule_decision === 'deny' ? 'text-red-600 font-medium' : ''
                      )}
                    >
                      {item.rule_decision}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <DecisionBadge decision={item.hitl_user_decision} />
                  </td>
                  <td className="px-3 py-2 text-sm font-mono text-xs">{item.exit_code ?? '—'}</td>
                  <td className="px-3 py-2 text-sm text-muted-foreground text-xs">
                    {new Date(item.created_at).toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            共 {total} 条，第 {page}/{totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <PageSizeSelect
              value={pageSize}
              onChange={(nextPageSize) => {
                setPageSize(nextPageSize)
                setPage(1)
              }}
            />
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </AdminPage>
  )
}
