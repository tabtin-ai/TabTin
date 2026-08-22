import { AdminPage } from '@/components/admin-page'
import { PageSizeSelect } from '@/components/ui/pagination'
import { cn } from '@/lib/utils'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { appPlatformApi } from '../api/app-platform-api'
import type { PermissionAuditItem } from '../types'

function DecisionBadge({ decision }: { decision: string }) {
  const colors: Record<string, string> = {
    allow: 'bg-green-100 text-green-800',
    deny: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800',
    expired: 'bg-yellow-100 text-yellow-800',
    cancelled_by_rollback: 'bg-orange-100 text-orange-800',
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

function SourceBadge({ source }: { source: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800">
      {source}
    </span>
  )
}

export function PermissionAuditPage() {
  const [items, setItems] = useState<PermissionAuditItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)

  const [filterThreadId, setFilterThreadId] = useState('')
  const [filterAgentId, setFilterAgentId] = useState('')
  const [filterDecision, setFilterDecision] = useState('')
  const [filterSource, setFilterSource] = useState('')

  const buildParams = useCallback(() => {
    const params: Record<string, string | number> = { page, page_size: pageSize }
    if (filterThreadId.trim()) params.thread_id = filterThreadId.trim()
    if (filterAgentId.trim()) params.agent_id = filterAgentId.trim()
    if (filterDecision) params.decision = filterDecision
    if (filterSource) params.source = filterSource
    return params
  }, [page, pageSize, filterThreadId, filterAgentId, filterDecision, filterSource])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await appPlatformApi.listPermissionAudit(
        buildParams() as Parameters<typeof appPlatformApi.listPermissionAudit>[0]
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

  return (
    <AdminPage>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">审批审计</h1>
        </div>
        <button
          type="button"
          onClick={fetchData}
          className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          刷新
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="thread_id"
          value={filterThreadId}
          onChange={(e) => {
            setFilterThreadId(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm w-48 bg-background"
        />
        <input
          type="text"
          placeholder="agent_id (UUID)"
          value={filterAgentId}
          onChange={(e) => {
            setFilterAgentId(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm w-48 bg-background"
        />
        <select
          value={filterDecision}
          onChange={(e) => {
            setFilterDecision(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm bg-background"
        >
          <option value="">全部 decision</option>
          <option value="allow">allow</option>
          <option value="deny">deny</option>
          <option value="cancelled">cancelled</option>
          <option value="expired">expired</option>
          <option value="cancelled_by_rollback">cancelled_by_rollback</option>
        </select>
        <select
          value={filterSource}
          onChange={(e) => {
            setFilterSource(e.target.value)
            setPage(1)
          }}
          className="rounded-md border px-3 py-2 text-sm bg-background"
        >
          <option value="">全部 source</option>
          <option value="rule">rule</option>
          <option value="memoization">memoization</option>
          <option value="user_interactive">user_interactive</option>
          <option value="hardline">hardline</option>
          <option value="plan_guard">plan_guard</option>
          <option value="classifier">classifier</option>
          <option value="skill_trust">skill_trust</option>
          <option value="rollback">rollback</option>
        </select>
      </div>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full min-w-[1100px]">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-3 text-left text-sm font-medium">Tool</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Decision</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Source</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Reason</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Thread</th>
              <th className="px-3 py-3 text-left text-sm font-medium">Mode</th>
              <th className="px-3 py-3 text-left text-sm font-medium">时间</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  加载中...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  暂无数据
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 text-sm">
                    <div className="flex items-center gap-1">
                      <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono text-xs">{item.tool_name}</span>
                    </div>
                    {item.tool_input_preview ? (
                      <div className="text-xs text-muted-foreground truncate max-w-xs mt-0.5">
                        {item.tool_input_preview}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <DecisionBadge decision={item.decision} />
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <SourceBadge source={item.source} />
                  </td>
                  <td className="px-3 py-2 text-sm font-mono text-xs">{item.reason_type || '—'}</td>
                  <td className="px-3 py-2 text-sm font-mono text-xs truncate max-w-[140px]">
                    {item.thread_id}
                  </td>
                  <td className="px-3 py-2 text-sm text-xs">{item.runtime_mode}</td>
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
