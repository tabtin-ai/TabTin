import { PageSizeSelect } from '@/components/ui/pagination'
import { ChevronLeft, ChevronRight, ListChecks } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { UsageRequestItem } from '../../api/usage'
import { formatCurrency, formatDateTime, formatLatency, formatNumber } from './formatters'

interface UsageRequestsTableProps {
  items: UsageRequestItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  loading: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

const STATUS_BADGE: Record<string, string> = {
  completed:
    'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-800',
  failed:
    'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-900/40 dark:text-rose-200 dark:border-rose-800',
  pending:
    'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800/60 dark:text-zinc-200 dark:border-zinc-700',
  processing:
    'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-800',
  cancelled:
    'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-800',
}

const COST_STATUS_BADGE: Record<string, string> = {
  platform_paid:
    'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-800',
  byok_self_paid:
    'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-800',
  n_a: 'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800/60 dark:text-zinc-200 dark:border-zinc-700',
}

function badge(value: string | undefined | null, map: Record<string, string>): React.ReactNode {
  const key = value || ''
  const cls = map[key] ?? map.n_a ?? 'bg-zinc-100 text-zinc-700 border-zinc-300'
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-caption font-mono ${cls}`}
    >
      {key || '—'}
    </span>
  )
}

export function UsageRequestsTable({
  items,
  total,
  page,
  pageSize,
  totalPages,
  loading,
  onPageChange,
  onPageSizeChange,
}: UsageRequestsTableProps) {
  const navigate = useNavigate()

  return (
    <section className="rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          <span className="text-body font-semibold">单次请求明细</span>
          <span className="text-caption text-muted-foreground">
            （共 {formatNumber(total)} 条 · 第 {page} / {Math.max(1, totalPages)} 页）
          </span>
        </div>
        <div className="flex items-center gap-2">
          <PageSizeSelect value={pageSize} onChange={onPageSizeChange} />
          <button
            type="button"
            disabled={loading || page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-caption disabled:cursor-not-allowed disabled:opacity-50 hover:bg-muted"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </button>
          <button
            type="button"
            disabled={loading || page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-caption disabled:cursor-not-allowed disabled:opacity-50 hover:bg-muted"
          >
            下一页
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="mt-3 overflow-auto rounded-md border">
        <table className="w-full text-body">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">Scene</th>
              <th className="px-3 py-2 font-medium">对象链</th>
              <th className="px-3 py-2 font-medium">Provider · Model</th>
              <th className="px-3 py-2 font-medium">范围</th>
              <th className="px-3 py-2 font-medium">cost_status</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 text-right font-medium">延迟</th>
              <th className="px-3 py-2 text-right font-medium">Token</th>
              <th className="px-3 py-2 text-right font-medium">成本</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-10 text-center text-caption text-muted-foreground">
                  加载中…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-10 text-center text-caption text-muted-foreground">
                  暂无请求数据
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono text-caption">
                    <div>{formatDateTime(item.occurred_at)}</div>
                    <div className="text-muted-foreground">{item.request_id}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-caption">{item.scene_key || '—'}</td>
                  <td className="px-3 py-2 text-caption">
                    <div className="flex max-w-[180px] flex-col gap-1 font-mono">
                      {item.organization_id ? (
                        <button
                          type="button"
                          className="truncate text-left hover:text-primary"
                          title={item.organization_id}
                          onClick={() => navigate(`/organizations/${item.organization_id}`)}
                        >
                          wt {item.organization_id}
                        </button>
                      ) : null}
                      {item.user_id ? (
                        <button
                          type="button"
                          className="truncate text-left hover:text-primary"
                          title={item.user_id}
                          onClick={() => navigate(`/users?userId=${item.user_id}`)}
                        >
                          user {item.user_id}
                        </button>
                      ) : null}
                      {!item.organization_id && !item.user_id ? '—' : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col">
                      <button
                        type="button"
                        className="text-left hover:text-primary"
                        onClick={() => navigate('/ai/providers')}
                      >
                        {item.provider_display_name || item.provider_key || '—'}
                      </button>
                      <button
                        type="button"
                        className="text-left text-caption text-muted-foreground font-mono hover:text-primary"
                        onClick={() => navigate('/ai/models')}
                      >
                        {item.model_display_name || item.model_name || '—'}
                      </button>
                      <span className="text-caption text-muted-foreground">
                        {item.capability_domain || '—'}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {badge(item.effective_provider_scope, COST_STATUS_BADGE)}
                  </td>
                  <td className="px-3 py-2">{badge(item.cost_status, COST_STATUS_BADGE)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-0.5">
                      {badge(item.status, STATUS_BADGE)}
                      {item.error_code && (
                        <span className="text-caption text-rose-600 dark:text-rose-300 font-mono">
                          {item.error_code}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatLatency(item.latency_ms)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatNumber(item.total_tokens)}
                    <div className="text-caption text-muted-foreground">
                      in {formatNumber(item.input_tokens)} · out {formatNumber(item.output_tokens)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(item.total_cost, 6)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-caption text-muted-foreground">
        每页 {pageSize} 条；总成本 / scene_key / capability_domain / cost_status 字段直接来自
        LLMUsageFact（v0.1 写入链路保证不为空）。
      </div>
    </section>
  )
}
