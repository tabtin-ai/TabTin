import * as Popover from '@radix-ui/react-popover'
import { CalendarClock, Copy, Edit3, Eye, Plus, RefreshCw, Search, XCircle } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'

import { AdminPage } from '@/components/admin-page'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import {
  createInviteCodes,
  disableInviteCode,
  getInviteCodes,
  getInviteRedemptions,
  updateInviteCode,
} from '@/invite-code-management/api/invite-codes'
import type {
  InviteCodeCreatePayload,
  InviteCodeItem,
  InviteCodeSummary,
  InviteCodeUpdatePayload,
  InvitePagination,
  InviteRedemptionItem,
} from '@/invite-code-management/types'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'

type FormMode = 'create' | 'edit'

interface InviteFormState {
  codeMode: 'auto' | 'manual'
  code: string
  generateCount: string
  codeLength: string
  channel: string
  campaign: string
  description: string
  usageLimit: string
  startsAt: string
  expiresAt: string
  isActive: boolean
}

const EMPTY_PAGINATION: InvitePagination = {
  total: 0,
  page: 1,
  page_size: 20,
  total_pages: 1,
}

const EMPTY_SUMMARY: InviteCodeSummary = {
  total_codes: 0,
  active_codes: 0,
  available_codes: 0,
  used_count: 0,
  recent_7d_redemptions: 0,
}

const DEFAULT_FORM: InviteFormState = {
  codeMode: 'auto',
  code: '',
  generateCount: '1',
  codeLength: '10',
  channel: '',
  campaign: '',
  description: '',
  usageLimit: '1',
  startsAt: '',
  expiresAt: '',
  isActive: true,
}

function toLocalDateTimeInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function defaultExpiresAt(): string {
  const date = new Date()
  date.setDate(date.getDate() + 30)
  date.setHours(23, 59, 0, 0)
  return toLocalDateTimeInput(date)
}

function defaultStartsAt(): string {
  const date = new Date()
  date.setSeconds(0, 0)
  return toLocalDateTimeInput(date)
}

function friendlyErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  if (
    message.includes('HTTP 404') ||
    message.includes('HTTP 503') ||
    message.includes('Not Found') ||
    message.includes('Service Unavailable') ||
    message.includes('Failed to fetch')
  ) {
    return '后端服务不可用：请确认 Django 已重启并已加载邀请码管理接口，然后刷新页面重试'
  }
  return message || fallback
}

function statusLabel(status: InviteCodeItem['status']): string {
  const labels: Record<InviteCodeItem['status'], string> = {
    available: '可用',
    disabled: '已停用',
    expired: '已过期',
    scheduled: '未生效',
    exhausted: '已用完',
  }
  return labels[status] ?? status
}

function statusVariant(
  status: InviteCodeItem['status']
): 'success' | 'secondary' | 'warning' | 'destructive' {
  if (status === 'available') return 'success'
  if (status === 'scheduled') return 'warning'
  if (status === 'disabled' || status === 'expired' || status === 'exhausted') return 'destructive'
  return 'secondary'
}

function toDateInput(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return toLocalDateTimeInput(date)
}

function fromDateInput(value: string): string | null {
  if (!value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toForm(item?: InviteCodeItem | null): InviteFormState {
  if (!item) return { ...DEFAULT_FORM }
  return {
    codeMode: 'manual',
    code: item.code,
    generateCount: '1',
    codeLength: '10',
    channel: item.channel,
    campaign: item.campaign,
    description: item.description,
    usageLimit: item.usage_limit == null ? '' : String(item.usage_limit),
    startsAt: toDateInput(item.starts_at),
    expiresAt: toDateInput(item.expires_at),
    isActive: item.is_active,
  }
}

function validateForm(form: InviteFormState, mode: FormMode): string | null {
  if (!form.channel.trim()) return '请输入渠道'
  if (mode === 'create' && form.codeMode === 'manual' && !form.code.trim()) return '请输入邀请码'
  const count = Number(form.generateCount || 1)
  if (
    mode === 'create' &&
    form.codeMode === 'auto' &&
    (!Number.isFinite(count) || count < 1 || count > 200)
  ) {
    return '自动生成数量必须在 1 到 200 之间'
  }
  if (form.usageLimit.trim()) {
    const limit = Number(form.usageLimit)
    if (!Number.isFinite(limit) || limit < 1) return '使用上限必须大于 0，留空表示不限量'
  }
  const parsedStartsAt = form.startsAt ? new Date(form.startsAt) : null
  const parsedExpiresAt = form.expiresAt ? new Date(form.expiresAt) : null
  if (parsedStartsAt && Number.isNaN(parsedStartsAt.getTime())) return '生效时间格式不正确'
  if (parsedExpiresAt && Number.isNaN(parsedExpiresAt.getTime())) return '过期时间格式不正确'
  if (parsedStartsAt && parsedExpiresAt && parsedStartsAt >= parsedExpiresAt) {
    return '生效时间必须早于过期时间'
  }
  return null
}

function toCreatePayload(form: InviteFormState): InviteCodeCreatePayload {
  return {
    code: form.codeMode === 'manual' ? form.code.trim() : undefined,
    generate_count: Number(form.generateCount || 1),
    code_length: Number(form.codeLength || 10),
    description: form.description.trim(),
    channel: form.channel.trim(),
    campaign: form.campaign.trim(),
    is_active: form.isActive,
    starts_at: fromDateInput(form.startsAt),
    expires_at: fromDateInput(form.expiresAt),
    usage_limit: form.usageLimit.trim() ? Number(form.usageLimit) : null,
  }
}

function toUpdatePayload(form: InviteFormState): InviteCodeUpdatePayload {
  return {
    description: form.description.trim(),
    channel: form.channel.trim(),
    campaign: form.campaign.trim(),
    is_active: form.isActive,
    starts_at: fromDateInput(form.startsAt),
    expires_at: fromDateInput(form.expiresAt),
    usage_limit: form.usageLimit.trim() ? Number(form.usageLimit) : null,
  }
}

export function InviteCodeManagementPage() {
  const { show: showToast, element: toastElement } = useSimpleToast()
  const [items, setItems] = useState<InviteCodeItem[]>([])
  const [summary, setSummary] = useState<InviteCodeSummary>(EMPTY_SUMMARY)
  const [pagination, setPagination] = useState<InvitePagination>(EMPTY_PAGINATION)
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('all')
  const [channel, setChannel] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState<FormMode>('create')
  const [editing, setEditing] = useState<InviteCodeItem | null>(null)
  const [form, setForm] = useState<InviteFormState>(DEFAULT_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [redemptionOpen, setRedemptionOpen] = useState(false)
  const [redemptionTarget, setRedemptionTarget] = useState<InviteCodeItem | null>(null)
  const [redemptions, setRedemptions] = useState<InviteRedemptionItem[]>([])
  const [disableTarget, setDisableTarget] = useState<InviteCodeItem | null>(null)
  const [disableLoading, setDisableLoading] = useState(false)

  const channels = useMemo(() => {
    return Array.from(new Set(items.map((item) => item.channel).filter(Boolean))).sort()
  }, [items])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getInviteCodes({
        keyword: keyword.trim(),
        status,
        channel,
        page,
        page_size: pagination.page_size,
      })
      setItems(result.items)
      setSummary(result.summary)
      setPagination(result.pagination)
      setLoadError(null)
    } catch (error) {
      const message = friendlyErrorMessage(error, '加载邀请码失败')
      setLoadError(message)
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }, [channel, keyword, page, pagination.page_size, showToast, status])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setFormMode('create')
    setEditing(null)
    setForm({ ...DEFAULT_FORM, startsAt: defaultStartsAt(), expiresAt: defaultExpiresAt() })
    setFormError(null)
    setFormOpen(true)
  }

  const openEdit = (item: InviteCodeItem) => {
    setFormMode('edit')
    setEditing(item)
    setForm(toForm(item))
    setFormError(null)
    setFormOpen(true)
  }

  const submitForm = async () => {
    const error = validateForm(form, formMode)
    if (error) {
      setFormError(error)
      showToast(error, 'error')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const response =
        formMode === 'create'
          ? await createInviteCodes(toCreatePayload(form))
          : await updateInviteCode(editing?.id ?? '', toUpdatePayload(form))
      showToast(response.message || '保存成功')
      setFormOpen(false)
      await load()
    } catch (err) {
      const message = friendlyErrorMessage(err, '保存失败')
      setFormError(message)
      showToast(message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async (payload: { reason: string; ticket_id: string }) => {
    if (!disableTarget) return
    setDisableLoading(true)
    try {
      const response = await disableInviteCode(disableTarget.id, payload)
      showToast(response.message || '已停用')
      setDisableTarget(null)
      await load()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '停用失败', 'error')
    } finally {
      setDisableLoading(false)
    }
  }

  const handleCopy = async (code: string) => {
    await navigator.clipboard.writeText(code)
    showToast('邀请码已复制')
  }

  const openRedemptions = async (item: InviteCodeItem) => {
    setRedemptionTarget(item)
    setRedemptionOpen(true)
    try {
      const result = await getInviteRedemptions(item.id, { page: 1, page_size: 50 })
      setRedemptions(result.items)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '加载使用记录失败', 'error')
    }
  }

  const updateForm = (patch: Partial<InviteFormState>) => setForm((prev) => ({ ...prev, ...patch }))

  return (
    <AdminPage className="space-y-6 p-6">
      {toastElement}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">邀请码管理</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            新建邀请码
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard title="总码数" value={summary.total_codes} />
        <MetricCard title="可用码数" value={summary.available_codes} />
        <MetricCard title="累计使用" value={summary.used_count} />
        <MetricCard title="近 7 天注册" value={summary.recent_7d_redemptions} />
      </div>

      <Card>
        <CardContent className="pt-6">
          {loadError && (
            <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {loadError}
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-[1fr_160px_180px_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keyword}
                onChange={(event) => {
                  setKeyword(event.target.value)
                  setPage(1)
                }}
                placeholder="搜索邀请码、描述、渠道或活动"
                className="pl-9"
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value)
                setPage(1)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="available">可用</SelectItem>
                <SelectItem value="scheduled">未生效</SelectItem>
                <SelectItem value="disabled">已停用</SelectItem>
                <SelectItem value="expired">已过期</SelectItem>
                <SelectItem value="exhausted">已用完</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={channel || 'all'}
              onValueChange={(value) => {
                setChannel(value === 'all' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="渠道" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部渠道</SelectItem>
                {channels.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => {
                setKeyword('')
                setStatus('all')
                setChannel('')
                setPage(1)
              }}
            >
              清空筛选
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-b bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">邀请码</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">渠道/活动</th>
                  <th className="px-4 py-3 font-medium">描述</th>
                  <th className="px-4 py-3 font-medium">使用次数</th>
                  <th className="px-4 py-3 font-medium">有效期</th>
                  <th className="px-4 py-3 font-medium">创建人</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-mono font-medium">{item.code}</td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(item.status)}>{statusLabel(item.status)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{item.channel || '—'}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.campaign || '无活动'}
                      </div>
                    </td>
                    <td className="max-w-[220px] px-4 py-3 text-muted-foreground">
                      {item.description || '—'}
                    </td>
                    <td className="px-4 py-3">
                      {item.used_count} / {item.usage_limit == null ? '不限' : item.usage_limit}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.expires_at ? formatDateTime(item.expires_at) : '长期有效'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.created_by_display_name || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleCopy(item.code)}
                        >
                          <Copy className="mr-1 h-3.5 w-3.5" />
                          复制
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => openEdit(item)}>
                          <Edit3 className="mr-1 h-3.5 w-3.5" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void openRedemptions(item)}
                        >
                          <Eye className="mr-1 h-3.5 w-3.5" />
                          记录
                        </Button>
                        {item.is_active && (
                          <PermissionGate permission={ADMIN_PERMISSION.INVITE_CODE_DISABLE}>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setDisableTarget(item)}
                            >
                              <XCircle className="mr-1 h-3.5 w-3.5" />
                              停用
                            </Button>
                          </PermissionGate>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                      暂无邀请码，点击“新建邀请码”开始配置内测准入。
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                      正在加载邀请码...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
            <span>
              共 {pagination.total} 条，第 {pagination.page} / {pagination.total_pages} 页
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pagination.total_pages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {formMode === 'create' ? '新建邀请码' : `编辑邀请码 ${editing?.code ?? ''}`}
            </DialogTitle>
            <DialogDescription>
              邀请码用于内测阶段注册准入，只有成功创建用户后才会消耗次数。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {formError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </div>
            )}
            {formMode === 'create' && (
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1">
                  <span className="text-sm font-medium">生成方式</span>
                  <Select
                    value={form.codeMode}
                    onValueChange={(value: 'auto' | 'manual') => updateForm({ codeMode: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动生成</SelectItem>
                      <SelectItem value="manual">手动输入</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.codeMode === 'manual' ? (
                  <label className="space-y-1 md:col-span-2" htmlFor="invite-code-manual-code">
                    <span className="text-sm font-medium">邀请码</span>
                    <Input
                      id="invite-code-manual-code"
                      value={form.code}
                      onChange={(event) => updateForm({ code: event.target.value })}
                      placeholder="例如 ALPHA2026"
                    />
                  </label>
                ) : (
                  <>
                    <label className="space-y-1" htmlFor="invite-code-generate-count">
                      <span className="text-sm font-medium">数量</span>
                      <Input
                        id="invite-code-generate-count"
                        type="number"
                        min={1}
                        max={200}
                        value={form.generateCount}
                        onChange={(event) => updateForm({ generateCount: event.target.value })}
                      />
                    </label>
                    <label className="space-y-1" htmlFor="invite-code-length">
                      <span className="text-sm font-medium">长度</span>
                      <Input
                        id="invite-code-length"
                        type="number"
                        min={6}
                        max={32}
                        value={form.codeLength}
                        onChange={(event) => updateForm({ codeLength: event.target.value })}
                      />
                    </label>
                  </>
                )}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1" htmlFor="invite-code-channel">
                <span className="text-sm font-medium">渠道</span>
                <Input
                  id="invite-code-channel"
                  value={form.channel}
                  onChange={(event) => updateForm({ channel: event.target.value })}
                  placeholder="feishu_group"
                />
              </label>
              <label className="space-y-1" htmlFor="invite-code-campaign">
                <span className="text-sm font-medium">活动/批次</span>
                <Input
                  id="invite-code-campaign"
                  value={form.campaign}
                  onChange={(event) => updateForm({ campaign: event.target.value })}
                  placeholder="alpha_batch_1"
                />
              </label>
              <label className="space-y-1" htmlFor="invite-code-usage-limit">
                <span className="text-sm font-medium">使用上限</span>
                <Input
                  id="invite-code-usage-limit"
                  value={form.usageLimit}
                  onChange={(event) => updateForm({ usageLimit: event.target.value })}
                  placeholder="留空表示不限量"
                />
              </label>
              <label className="flex items-center gap-2 pt-6">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) => updateForm({ isActive: event.target.checked })}
                />
                <span className="text-sm font-medium">立即启用</span>
              </label>
              <div className="space-y-1">
                <span className="text-sm font-medium">生效时间</span>
                <DateTimePicker
                  value={form.startsAt}
                  onChange={(value) => updateForm({ startsAt: value })}
                  placeholder="选择生效时间"
                />
              </div>
              <div className="space-y-1">
                <span className="text-sm font-medium">过期时间</span>
                <DateTimePicker
                  value={form.expiresAt}
                  onChange={(value) => updateForm({ expiresAt: value })}
                  placeholder="选择过期时间"
                />
              </div>
            </div>
            <label className="space-y-1" htmlFor="invite-code-description">
              <span className="text-sm font-medium">描述</span>
              <Textarea
                id="invite-code-description"
                value={form.description}
                onChange={(event) => updateForm({ description: event.target.value })}
                rows={3}
                placeholder="例如：飞书社群第一批内测用户"
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void submitForm()} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SensitiveActionConfirmDialog
        open={Boolean(disableTarget)}
        title="停用邀请码"
        targetLabel={disableTarget?.code ?? ''}
        impact="停用后该邀请码将立即失效，新的注册兑换会被拒绝。"
        confirmText="停用"
        loading={disableLoading}
        onCancel={() => setDisableTarget(null)}
        onConfirm={(payload) => void handleDisable(payload)}
      />

      <Dialog open={redemptionOpen} onOpenChange={setRedemptionOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>使用记录：{redemptionTarget?.code}</DialogTitle>
            <DialogDescription>展示通过该邀请码完成注册的用户和入口。</DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">用户</th>
                  <th className="px-3 py-2 font-medium">入口</th>
                  <th className="px-3 py-2 font-medium">IP</th>
                  <th className="px-3 py-2 font-medium">使用时间</th>
                </tr>
              </thead>
              <tbody>
                {redemptions.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{row.user_display_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.user_email || row.user_phone || row.user_id}
                      </div>
                    </td>
                    <td className="px-3 py-2">{row.entrypoint}</td>
                    <td className="px-3 py-2">{row.ip_address || '—'}</td>
                    <td className="px-3 py-2">{formatDateTime(row.consumed_at)}</td>
                  </tr>
                ))}
                {redemptions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                      暂无使用记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function MetricCard({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}

function splitLocalDateTime(value: string): { date: string; time: string } {
  if (!value) return { date: '', time: '09:00' }
  const [date = '', time = '09:00'] = value.split('T')
  return { date, time: time.slice(0, 5) || '09:00' }
}

function mergeLocalDateTime(date: string, time: string): string {
  if (!date) return ''
  return `${date}T${time || '09:00'}`
}

function formatLocalDateTimeLabel(value: string, placeholder: string): string {
  if (!value) return placeholder
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function DateTimePicker({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  const dateInputId = useId()
  const timeInputId = useId()
  const { date, time } = splitLocalDateTime(value)

  const setPreset = (days: number) => {
    const next = new Date()
    next.setDate(next.getDate() + days)
    if (days > 0) {
      next.setHours(23, 59, 0, 0)
    } else {
      next.setSeconds(0, 0)
    }
    onChange(toLocalDateTimeInput(next))
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-9 w-full justify-start gap-2 px-3 font-normal"
        >
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          <span className={value ? 'text-foreground' : 'text-muted-foreground'}>
            {formatLocalDateTimeLabel(value, placeholder)}
          </span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-[80] w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1" htmlFor={dateInputId}>
                <span className="text-xs font-medium text-muted-foreground">日期</span>
                <Input
                  id={dateInputId}
                  type="date"
                  value={date}
                  onChange={(event) => onChange(mergeLocalDateTime(event.target.value, time))}
                />
              </label>
              <label className="space-y-1" htmlFor={timeInputId}>
                <span className="text-xs font-medium text-muted-foreground">时间</span>
                <Input
                  id={timeInputId}
                  type="time"
                  value={time}
                  onChange={(event) =>
                    onChange(
                      mergeLocalDateTime(
                        date || toLocalDateTimeInput(new Date()).slice(0, 10),
                        event.target.value
                      )
                    )
                  }
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setPreset(0)}>
                现在
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setPreset(7)}>
                7 天后
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setPreset(30)}>
                30 天后
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}>
                清空
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
