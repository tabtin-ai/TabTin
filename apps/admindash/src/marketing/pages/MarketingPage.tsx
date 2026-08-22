/**
 * 官网获客分析 + 下载短链维护
 *
 * - 概览：区间内访问 / 独立访客 / 新访客 / 下载
 * - 趋势：按天访问 / 下载曲线
 * - 分布：下载平台、来源渠道、热门页面、访客地域（省份）、来源网站
 * - 短链维护：创建 / 编辑 / 启停 / 删除；下载按钮挂这些短链，302 时落库计数
 */

import { API_BASE_URL } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import {
  BarChart3,
  Copy,
  Download,
  Globe,
  Link2,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  type AnalyticsOverview,
  type ShortLink,
  type ShortLinkInput,
  type TrendPoint,
  createShortLink,
  deleteShortLink,
  fetchOverview,
  fetchShortLinks,
  fetchTrends,
  updateShortLink,
} from '../api/marketing'

const DAY_OPTIONS = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
]

// 短链公网基址：由 API base 推导（去掉末尾 /api），用于展示 / 复制完整下载链接
const DOWNLOAD_BASE = (API_BASE_URL || `${window.location.origin}/api`).replace(/\/api\/?$/, '')

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | string
  icon: React.ElementType
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-caption text-muted-foreground">{label}</p>
          <p className="text-heading font-bold">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function DistributionList({
  rows,
  emptyText = '暂无数据',
}: {
  rows: Array<{ key: string; label: string; count: number }>
  emptyText?: string
}) {
  if (!rows.length) {
    return <p className="text-body text-muted-foreground">{emptyText}</p>
  }
  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1
  const max = Math.max(...rows.map((r) => r.count)) || 1
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.key} className="space-y-1">
          <div className="flex items-center justify-between text-body">
            <span className="truncate text-muted-foreground" title={r.label}>
              {r.label}
            </span>
            <span className="ml-2 shrink-0 font-medium">
              {r.count}
              <span className="ml-1 text-caption text-muted-foreground">
                {Math.round((r.count / total) * 100)}%
              </span>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.max((r.count / max) * 100, 2)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

const EMPTY_FORM: ShortLinkInput = {
  slug: '',
  name: '',
  description: '',
  target_type: 'latest_release',
  target_url: '',
  release_platform: 'mac',
  release_arch: 'arm64',
  release_channel: 'stable',
  channel: '',
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  is_active: true,
}

export function MarketingPage() {
  const { show, element: toast } = useSimpleToast()
  const [days, setDays] = useState(7)
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [pvTrend, setPvTrend] = useState<TrendPoint[]>([])
  const [dlTrend, setDlTrend] = useState<TrendPoint[]>([])
  const [links, setLinks] = useState<ShortLink[]>([])
  const [loading, setLoading] = useState(false)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ShortLinkInput>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ov, pv, dl, ls] = await Promise.all([
        fetchOverview(days),
        fetchTrends(days, 'page_view'),
        fetchTrends(days, 'download'),
        fetchShortLinks(),
      ])
      setOverview(ov)
      setPvTrend(pv.series)
      setDlTrend(dl.series)
      setLinks(ls.items)
    } catch (err) {
      show(err instanceof Error ? err.message : '加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [days, show])

  useEffect(() => {
    void load()
  }, [load])

  const chartData = useMemo(() => {
    const byDay = new Map<string, { day: string; page_view: number; download: number }>()
    for (const p of pvTrend) {
      if (!p.day) continue
      byDay.set(p.day, { day: p.day, page_view: p.count, download: 0 })
    }
    for (const p of dlTrend) {
      if (!p.day) continue
      const row = byDay.get(p.day) ?? { day: p.day, page_view: 0, download: 0 }
      row.download = p.count
      byDay.set(p.day, row)
    }
    return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day))
  }, [pvTrend, dlTrend])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (link: ShortLink) => {
    setEditingId(link.id)
    setForm({
      slug: link.slug,
      name: link.name,
      description: link.description,
      target_type: link.target_type,
      target_url: link.target_url,
      release_platform: link.release_platform || 'mac',
      release_arch: link.release_arch || 'arm64',
      release_channel: link.release_channel || 'stable',
      channel: link.channel,
      utm_source: link.utm_source,
      utm_medium: link.utm_medium,
      utm_campaign: link.utm_campaign,
      is_active: link.is_active,
    })
    setDialogOpen(true)
  }

  const save = async () => {
    if (!form.slug.trim() || !form.name.trim()) {
      show('slug 和名称必填', 'error')
      return
    }
    setSaving(true)
    try {
      if (editingId) {
        await updateShortLink(editingId, form)
        show('短链已更新')
      } else {
        await createShortLink(form)
        show('短链已创建')
      }
      setDialogOpen(false)
      await load()
    } catch (err) {
      show(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (link: ShortLink) => {
    try {
      await updateShortLink(link.id, {
        slug: link.slug,
        name: link.name,
        description: link.description,
        target_type: link.target_type,
        target_url: link.target_url,
        release_platform: link.release_platform,
        release_arch: link.release_arch,
        release_channel: link.release_channel,
        channel: link.channel,
        utm_source: link.utm_source,
        utm_medium: link.utm_medium,
        utm_campaign: link.utm_campaign,
        is_active: !link.is_active,
      })
      await load()
    } catch (err) {
      show(err instanceof Error ? err.message : '操作失败', 'error')
    }
  }

  const remove = async (link: ShortLink) => {
    if (!window.confirm(`确认删除短链 ${link.slug}？历史下载事件保留，但该短链将无法访问。`)) return
    try {
      await deleteShortLink(link.id)
      show('短链已删除')
      await load()
    } catch (err) {
      show(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  const copyLink = async (slug: string) => {
    const url = `${DOWNLOAD_BASE}/dl/${slug}`
    try {
      await navigator.clipboard.writeText(url)
      show(`已复制：${url}`)
    } catch {
      show(url, 'error')
    }
  }

  return (
    <div className="space-y-6 p-6">
      {toast}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-title font-bold">官网获客</h1>
          <p className="text-body text-muted-foreground">官网访问、下载漏斗与下载短链维护</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
        </div>
      </div>

      {/* 概览卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="页面访问" value={overview?.page_views ?? '—'} icon={TrendingUp} />
        <StatCard label="独立访客" value={overview?.unique_visitors ?? '—'} icon={Users} />
        <StatCard
          label="新访客"
          value={
            overview
              ? `${overview.new_visitors}${
                  overview.unique_visitors > 0
                    ? ` · ${Math.round((overview.new_visitors / overview.unique_visitors) * 100)}%`
                    : ''
                }`
              : '—'
          }
          icon={UserPlus}
        />
        <StatCard label="下载次数" value={overview?.downloads ?? '—'} icon={Download} />
      </div>

      {/* 趋势图 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-subtitle">
            <BarChart3 className="h-4 w-4" /> 访问与下载趋势
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-body text-muted-foreground">
              暂无数据
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="pvGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="dlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Area
                  type="monotone"
                  dataKey="page_view"
                  name="访问"
                  stroke="#3b82f6"
                  fill="url(#pvGrad)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="download"
                  name="下载"
                  stroke="#10b981"
                  fill="url(#dlGrad)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* 分布 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-subtitle">下载平台分布</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview?.platform_breakdown.length ? (
              overview.platform_breakdown.map((p) => (
                <div
                  key={`${p.platform}-${p.arch}`}
                  className="flex items-center justify-between text-body"
                >
                  <span className="text-muted-foreground">
                    {p.platform} / {p.arch}
                  </span>
                  <span className="font-medium">{p.count}</span>
                </div>
              ))
            ) : (
              <p className="text-body text-muted-foreground">暂无下载</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subtitle">来源渠道 Top</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview?.top_channels.length ? (
              overview.top_channels.map((c) => (
                <div
                  key={c.utm_source || '(direct)'}
                  className="flex items-center justify-between text-body"
                >
                  <span className="text-muted-foreground">{c.utm_source || '(直接访问)'}</span>
                  <span className="font-medium">{c.count}</span>
                </div>
              ))
            ) : (
              <p className="text-body text-muted-foreground">暂无数据</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-subtitle">热门页面 Top</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview?.top_pages.length ? (
              overview.top_pages.map((p) => (
                <div key={p.path} className="flex items-center justify-between text-body">
                  <span className="truncate text-muted-foreground" title={p.path}>
                    {p.path}
                  </span>
                  <span className="ml-2 font-medium">{p.count}</span>
                </div>
              ))
            ) : (
              <p className="text-body text-muted-foreground">暂无数据</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 访客分布：地域 + 来源网站 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-subtitle">
              <MapPin className="h-4 w-4" /> 访客地域分布
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DistributionList
              emptyText="暂无可定位的访问（内网 / 本地访问不计入）"
              rows={(overview?.geo_breakdown ?? []).map((g) => ({
                key: `${g.geo_country}-${g.geo_province}`,
                label: g.geo_province
                  ? g.geo_country && g.geo_country !== g.geo_province
                    ? `${g.geo_country} · ${g.geo_province}`
                    : g.geo_province
                  : g.geo_country || '未知',
                count: g.count,
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-subtitle">
              <Globe className="h-4 w-4" /> 来源网站分布
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DistributionList
              emptyText="暂无外部来源（多为直接访问）"
              rows={(overview?.referrer_breakdown ?? []).map((r) => ({
                key: r.referrer_host,
                label: r.referrer_host,
                count: r.count,
              }))}
            />
          </CardContent>
        </Card>
      </div>

      {/* 短链维护 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-subtitle">
            <Link2 className="h-4 w-4" /> 下载短链
          </CardTitle>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" /> 新建短链
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b text-left text-caption text-muted-foreground">
                  <th className="py-2 pr-4">短链</th>
                  <th className="py-2 pr-4">名称</th>
                  <th className="py-2 pr-4">目标</th>
                  <th className="py-2 pr-4">渠道</th>
                  <th className="py-2 pr-4">点击</th>
                  <th className="py-2 pr-4">状态</th>
                  <th className="py-2 pr-4">操作</th>
                </tr>
              </thead>
              <tbody>
                {links.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted-foreground">
                      还没有短链，点右上角新建
                    </td>
                  </tr>
                ) : (
                  links.map((link) => (
                    <tr key={link.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono">/dl/{link.slug}</td>
                      <td className="py-2 pr-4">{link.name}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {link.target_type === 'latest_release'
                          ? `最新 ${link.release_platform}/${link.release_arch}`
                          : '固定 URL'}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">{link.channel || '—'}</td>
                      <td className="py-2 pr-4">{link.click_count}</td>
                      <td className="py-2 pr-4">
                        <button
                          type="button"
                          onClick={() => void toggleActive(link)}
                          className={
                            link.is_active
                              ? 'rounded-full bg-success/15 px-2 py-0.5 text-caption text-success'
                              : 'rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground'
                          }
                        >
                          {link.is_active ? '启用中' : '已停用'}
                        </button>
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="复制下载链接"
                            onClick={() => void copyLink(link.slug)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="编辑"
                            onClick={() => openEdit(link)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="删除"
                            onClick={() => void remove(link)}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 新建 / 编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑短链' : '新建短链'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <span className="block text-caption text-muted-foreground">短链标识 (slug)</span>
              <Input
                value={form.slug}
                placeholder="mac-arm64"
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <span className="block text-caption text-muted-foreground">名称</span>
              <Input
                value={form.name}
                placeholder="Mac Apple 芯片"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <span className="block text-caption text-muted-foreground">目标类型</span>
              <Select
                value={form.target_type}
                onValueChange={(v) =>
                  setForm({ ...form, target_type: v as ShortLinkInput['target_type'] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="latest_release">跟随最新发版（推荐）</SelectItem>
                  <SelectItem value="static">固定 URL</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.target_type === 'static' ? (
              <div className="col-span-2 space-y-1">
                <span className="block text-caption text-muted-foreground">固定目标 URL</span>
                <Textarea
                  value={form.target_url}
                  placeholder="https://cdn.example.com/...exe 或 ...dmg"
                  rows={3}
                  className="min-h-20 resize-y break-all font-mono text-caption"
                  onChange={(e) => setForm({ ...form, target_url: e.target.value })}
                />
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <span className="block text-caption text-muted-foreground">平台</span>
                  <Select
                    value={form.release_platform}
                    onValueChange={(v) => setForm({ ...form, release_platform: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mac">macOS</SelectItem>
                      <SelectItem value="win">Windows</SelectItem>
                      <SelectItem value="linux">Linux</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <span className="block text-caption text-muted-foreground">架构</span>
                  <Select
                    value={form.release_arch}
                    onValueChange={(v) => setForm({ ...form, release_arch: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="arm64">ARM64</SelectItem>
                      <SelectItem value="x64">x64</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            <div className="space-y-1">
              <span className="block text-caption text-muted-foreground">渠道标签（可选）</span>
              <Input
                value={form.channel}
                placeholder="wechat / weibo"
                onChange={(e) => setForm({ ...form, channel: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <span className="block text-caption text-muted-foreground">UTM Source（可选）</span>
              <Input
                value={form.utm_source}
                onChange={(e) => setForm({ ...form, utm_source: e.target.value })}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <span className="block text-caption text-muted-foreground">备注（可选）</span>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
