import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient, type TabTinClient } from '@tabtin/sdk'
import type { RecordRow } from '@tabtin/sdk'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'

/**
 * Dashboard 模板 — 自动连接 TabData，开箱即用
 *
 * 环境变量由 init-template 自动注入到 .env.local，无需手动配置：
 *   VITE_TABTIN_API_URL   — API 地址
 *   VITE_TABTIN_TOKEN     — TabData Open API Token
 *   VITE_TABTIN_SPACE_ID  — Space ID
 *   VITE_TABTIN_TABLE_ID  — 默认数据表 ID
 */

const API_URL = import.meta.env.VITE_TABTIN_API_URL || 'https://api.example.com'
const TOKEN = import.meta.env.VITE_TABTIN_TOKEN || ''
const SPACE_ID = import.meta.env.VITE_TABTIN_SPACE_ID || ''
const TABLE_ID = import.meta.env.VITE_TABTIN_TABLE_ID || ''

const CHART_COLORS = [
  '#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#818cf8',
  '#60a5fa', '#38bdf8', '#22d3ee', '#2dd4bf', '#34d399',
]

type ViewMode = 'table' | 'cards' | 'chart'

interface TableInfo {
  id: string
  name: string
}

function useTabTin() {
  const [client] = useState<TabTinClient | null>(() =>
    TOKEN ? createClient({ baseURL: API_URL, token: TOKEN, spaceId: SPACE_ID }) : null,
  )
  return client
}

export default function App() {
  const client = useTabTin()
  const [records, setRecords] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [view, setView] = useState<ViewMode>('table')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [activeTableId, setActiveTableId] = useState(TABLE_ID)
  const [page, setPage] = useState(1)
  const pageSize = 50

  useEffect(() => {
    if (!client || !SPACE_ID) return
    client.listTables(SPACE_ID).then(({ data, error: err }) => {
      if (err) {
        setError(`获取表列表失败: ${err.message}`)
        return
      }
      if (data?.tables) {
        setTables(data.tables)
        if (!activeTableId && data.tables.length > 0) {
          setActiveTableId(data.tables[0].id)
        }
      }
    })
  }, [client])

  // 搜索防抖
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(debounceRef.current)
  }, [search])

  const fetchRecords = useCallback(async () => {
    if (!client || !activeTableId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      let query = client.from(activeTableId).select('*')
      if (debouncedSearch) query = query.search(debouncedSearch)
      const { data, error: err } = await query.page(page).limit(pageSize).execute()
      if (err) {
        setError(err.message)
      } else if (data) {
        setRecords(data.records || [])
        setTotal(data.total ?? 0)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [client, activeTableId, debouncedSearch, page])

  useEffect(() => { fetchRecords() }, [fetchRecords])

  const fieldNames = useMemo(() => {
    if (records.length === 0) return []
    return Object.keys(records[0].fields || {})
  }, [records])

  const chartData = useMemo(() => {
    if (records.length === 0 || fieldNames.length === 0) return null
    const groupField = fieldNames.find(
      (f) => typeof records[0]?.fields?.[f] === 'string',
    )
    if (!groupField) return null

    const counts: Record<string, number> = {}
    for (const r of records) {
      const key = String(r.fields?.[groupField] ?? '(空)')
      counts[key] = (counts[key] || 0) + 1
    }
    return Object.entries(counts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12)
  }, [records, fieldNames])

  // ── Setup hints ──
  if (!TOKEN) {
    return <SetupHint message="未检测到 API Token" detail="使用 dashboard 模板创建站点时会自动配置 Token。也可以手动在 .env.local 中设置 VITE_TABTIN_TOKEN" />
  }
  if (!SPACE_ID) {
    return <SetupHint message="未配置 Space ID" detail="请在 .env.local 中设置 VITE_TABTIN_SPACE_ID" />
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
      {/* Header */}
      <header className="sticky top-0 z-sticky border-b border-border/60 bg-card/80 backdrop-blur-lg">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-body font-bold text-white shadow-md shadow-indigo-200">
              T
            </div>
            <div>
              <h1 className="text-title font-semibold text-foreground">Dashboard</h1>
              <p className="text-caption text-muted-foreground">
                {tables.find((t) => t.id === activeTableId)?.name || activeTableId.slice(0, 8)}
                {total > 0 && <span className="ml-1">· {total} 条记录</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Table selector */}
            {tables.length >= 1 && (
              <select
                value={activeTableId}
                onChange={(e) => { setActiveTableId(e.target.value); setPage(1) }}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-body text-foreground shadow-sm transition hover:border-primary/30 focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/20"
              >
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
            {/* Search */}
            <div className="relative">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="搜索..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                className="w-48 rounded-lg border border-border bg-card py-1.5 pl-9 pr-3 text-body text-foreground shadow-sm transition placeholder:text-muted-foreground hover:border-primary/30 focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/20"
              />
            </div>
            {/* View toggle */}
            <div className="flex overflow-hidden rounded-lg border border-border shadow-sm">
              {(['table', 'cards', 'chart'] as ViewMode[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-caption font-medium transition ${view === v ? 'bg-primary/10 text-primary' : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  {{ table: '表格', cards: '卡片', chart: '图表' }[v]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {/* Stats */}
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="总记录" value={total} accent="indigo" />
          <StatCard label="当前页" value={records.length} accent="sky" />
          <StatCard label="字段数" value={fieldNames.length} accent="violet" />
          <StatCard label="状态" value={error ? '异常' : '正常'} accent={error ? 'rose' : 'emerald'} />
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-body text-destructive">
            <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <span>{error}</span>
            <button onClick={fetchRecords} className="ml-auto text-caption font-medium text-destructive underline hover:no-underline">重试</button>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <SkeletonLoader view={view} />
        ) : !activeTableId ? (
          tables.length === 0
            ? <EmptyState icon="📭" title="当前 Space 还没有数据表" subtitle="请先在 TabTin 中创建一张数据表，然后刷新页面" />
            : <EmptyState icon="📊" title="选择一张数据表" subtitle="从顶部下拉框中选择要展示的数据表" />
        ) : records.length === 0 ? (
          <EmptyState icon="📭" title="暂无数据" subtitle={search ? `搜索"${search}"没有匹配结果` : '数据表中还没有记录'} />
        ) : view === 'table' ? (
          <TableView records={records} fields={fieldNames} />
        ) : view === 'cards' ? (
          <CardsView records={records} fields={fieldNames} />
        ) : (
          <ChartView data={chartData} />
        )}

        {/* Pagination */}
        {!loading && records.length > 0 && totalPages > 1 && (
          <div className="mt-6 flex items-center justify-between">
            <span className="text-body text-muted-foreground">
              第 {page}/{totalPages} 页，共 {total} 条
            </span>
            <div className="flex gap-2">
              <PaginationBtn disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</PaginationBtn>
              <PaginationBtn disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</PaginationBtn>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

// ── Sub Components ──────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  const colors: Record<string, string> = {
    indigo: 'from-indigo-500 to-indigo-600 shadow-indigo-200',
    sky: 'from-sky-500 to-sky-600 shadow-sky-200',
    violet: 'from-violet-500 to-violet-600 shadow-violet-200',
    emerald: 'from-emerald-500 to-emerald-600 shadow-emerald-200',
    rose: 'from-rose-500 to-rose-600 shadow-rose-200',
  }
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/60 bg-card p-4 shadow-sm transition hover:shadow-md">
      <div className={`absolute -right-3 -top-3 h-16 w-16 rounded-full bg-gradient-to-br ${colors[accent] || colors.indigo} opacity-10 transition group-hover:opacity-20`} />
      <div className="text-caption font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-heading font-bold text-foreground">{value}</div>
    </div>
  )
}

function TableView({ records, fields }: { records: RecordRow[]; fields: string[] }) {
  const visibleFields = fields.slice(0, 8)
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-border bg-muted/80">
              {visibleFields.map((f) => (
                <th key={f} className="whitespace-nowrap px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted-foreground">
                  {f}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {records.map((r) => (
              <tr key={r.id} className="transition hover:bg-primary/5">
                {visibleFields.map((f) => (
                  <td key={f} className="max-w-[240px] truncate whitespace-nowrap px-4 py-3 text-foreground">
                    <CellValue value={r.fields?.[f]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CardsView({ records, fields }: { records: RecordRow[]; fields: string[] }) {
  const titleField = fields[0]
  const detailFields = fields.slice(1, 5)
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {records.map((r) => (
        <div
          key={r.id}
          className="group rounded-xl border border-border/60 bg-card p-5 shadow-sm transition hover:border-primary/30 hover:shadow-md"
        >
          {titleField && (
            <h3 className="mb-3 truncate text-subtitle font-semibold text-foreground group-hover:text-primary">
              <CellValue value={r.fields?.[titleField]} />
            </h3>
          )}
          <div className="space-y-2">
            {detailFields.map((f) => (
              <div key={f} className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-caption font-medium text-muted-foreground">{f}</span>
                <span className="truncate text-body text-muted-foreground">
                  <CellValue value={r.fields?.[f]} />
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ChartView({ data }: { data: { name: string; value: number }[] | null }) {
  if (!data || data.length === 0) {
    return <EmptyState icon="📊" title="无法生成图表" subtitle="需要至少一个文本类型字段来分组统计" />
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Bar chart */}
      <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
        <h3 className="mb-4 text-body font-semibold text-foreground">分布统计（柱状图）</h3>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }}
            />
            <Bar dataKey="value" radius={[6, 6, 0, 0]}>
              {data.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Pie chart */}
      <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
        <h3 className="mb-4 text-body font-semibold text-foreground">占比统计（饼图）</h3>
        <ResponsiveContainer width="100%" height={320}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={110}
              paddingAngle={2}
              dataKey="value"
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              labelLine={false}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>
  if (typeof value === 'boolean') {
    return value
      ? <span className="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-caption font-medium text-success">✓</span>
      : <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-caption font-medium text-muted-foreground">✗</span>
  }
  if (Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.slice(0, 3).map((v, i) => (
          <span key={i} className="inline-block rounded bg-primary/10 px-1.5 py-0.5 text-caption text-primary">{String(v)}</span>
        ))}
        {value.length > 3 && <span className="text-caption text-muted-foreground">+{value.length - 3}</span>}
      </span>
    )
  }
  if (typeof value === 'object') return <span className="text-caption text-muted-foreground">{JSON.stringify(value)}</span>
  return <>{String(value)}</>
}

function SkeletonLoader({ view }: { view: ViewMode }) {
  if (view === 'cards') {
    return (
      <div className="grid animate-pulse gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
            <div className="mb-3 h-5 w-2/3 rounded bg-muted-foreground/20" />
            <div className="space-y-2">
              <div className="h-4 w-full rounded bg-muted" />
              <div className="h-4 w-4/5 rounded bg-muted" />
              <div className="h-4 w-3/5 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="animate-pulse rounded-xl border border-border/60 bg-card p-4 shadow-sm">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={`flex gap-4 ${i > 0 ? 'mt-3' : ''}`}>
          <div className="h-4 w-1/4 rounded bg-muted-foreground/20" />
          <div className="h-4 w-1/5 rounded bg-muted" />
          <div className="h-4 w-1/3 rounded bg-muted" />
          <div className="h-4 w-1/6 rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}

function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 py-20">
      <span className="text-display">{icon}</span>
      <h3 className="mt-4 text-subtitle font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-body text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function SetupHint({ message, detail }: { message: string; detail: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50/30 p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-lg">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warning/10">
          <svg className="h-7 w-7 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="mt-5 text-title font-semibold text-foreground">{message}</h2>
        <p className="mt-2 text-body leading-relaxed text-muted-foreground">{detail}</p>
        <div className="mt-6 rounded-lg bg-muted p-3 text-left">
          <code className="block text-caption leading-relaxed text-muted-foreground">
            <span className="text-muted-foreground"># .env.local</span>{'\n'}
            VITE_TABTIN_API_URL=https://api.example.com{'\n'}
            VITE_TABTIN_TOKEN=ttn_xxx_yyy{'\n'}
            VITE_TABTIN_SPACE_ID=your-space-id{'\n'}
            VITE_TABTIN_TABLE_ID=your-table-id
          </code>
        </div>
      </div>
    </div>
  )
}

function PaginationBtn({ children, disabled, onClick }: { children: React.ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-border bg-card px-3 py-1.5 text-body font-medium text-muted-foreground shadow-sm transition hover:border-primary/30 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
    >
      {children}
    </button>
  )
}
