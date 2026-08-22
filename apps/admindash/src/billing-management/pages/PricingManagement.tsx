import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { DollarSign, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatDateTime } from '@/lib/utils'
import {
  type PricingRule,
  createPricingRule,
  deletePricingRule,
  listPricingRules,
  updatePricingRule,
} from '../api/billing-admin'
import { SortableHeader, toggleSort } from '../components/SortableHeader'

const DEFAULT_PAGE_SIZE = 20

function createEmptyForm() {
  return {
    meter_key: '',
    scope: 'global',
    organization_id: '',
    provider_key: '',
    model_name: '',
    unit: 'token',
    unit_price: '0',
    currency: 'CNY',
    precision: 4,
    is_active: true,
    priority: 0,
    effective_from: '',
    effective_to: '',
  }
}


/** 列表展示用；库内仍存英文 unit 码，编辑表单继续用原始值。 */
const PRICING_UNIT_LABEL: Record<string, string> = {
  count: '次',
  request: '次请求',
  seconds: '秒',
  second: '秒',
  gb: 'GB',
  byte: '字节',
  bytes: '字节',
  characters: '字符',
  character: '字符',
  token: 'token',
  tokens: 'token',
  k_tokens: '千 token',
  'k tokens': '千 token',
  ktoken: '千 token',
  unit: '单位',
}

/** 计量项中文名；未知 key 回退为可读兜底，英文码始终另起一行展示。 */
const METER_KEY_LABEL: Record<string, string> = {
  'storage.gb': '对象存储',
  'storage.bytes': '对象存储（字节）',
  'storage.gb_day': '对象存储（GB·天）',
  'llm.tokens': 'LLM Token',
  'llm.token': 'LLM Token',
  'rag.embedding.tokens': 'RAG 向量嵌入',
  'media.image.count': '图片生成',
  'media.video.seconds': '视频生成',
  'media.bgm.seconds': '背景音乐生成',
  'speech.asr.seconds': '语音识别',
  'speech.tts.characters': '语音合成',
  'search.web.request': '联网搜索',
  'notification.sms.count': '短信通知',
  'notification.email.count': '邮件通知',
  'channel.message.count': '渠道消息',
}

function formatPricingUnit(unit?: string | null): string {
  const raw = (unit || '').trim()
  if (!raw) return '-'
  const normalized = raw.toLowerCase().replace(/\s+/g, '_')
  return PRICING_UNIT_LABEL[raw] || PRICING_UNIT_LABEL[normalized] || raw
}

function formatMeterKeyLabel(meterKey?: string | null): string {
  const key = (meterKey || '').trim()
  if (!key) return '未命名计量项'
  if (METER_KEY_LABEL[key]) return METER_KEY_LABEL[key]
  const tail = key.split('.').filter(Boolean).pop() || key
  return `计量项（${tail}）`
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
}: {
  id: string
  label: string
  value: string | number
  onChange: (value: string) => void
  type?: string
}) {
  return (
    <div>
      <label className="text-body font-medium" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        className="mt-1"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

export function PricingManagement({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [rules, setRules] = useState<PricingRule[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(createEmptyForm())
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [sort, setSort] = useState('-updated_at')
  const loadVersionRef = useRef(0)

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const params: Record<string, string | number | undefined> = {
        page,
        page_size: pageSize,
      }

      if (sort) {
        params.order_by = sort
      }

      const response = await listPricingRules(params)

      if (loadVersionRef.current !== version) {
        return
      }

      setRules(response.pricing_rules)
      setTotal(response.total)
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      setRules([])
      setLoadError(true)
      showToast('加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [page, pageSize, showToast, sort])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditId(null)
    setForm(createEmptyForm())
    setShowForm(true)
  }

  const openEdit = (rule: PricingRule) => {
    setEditId(rule.id)
    setForm({
      meter_key: rule.meter_key,
      scope: rule.scope,
      organization_id: rule.organization_id || '',
      provider_key: rule.provider_key,
      model_name: rule.model_name,
      unit: rule.unit,
      unit_price: rule.unit_price,
      currency: rule.currency,
      precision: rule.precision,
      is_active: rule.is_active,
      priority: rule.priority,
      effective_from: rule.effective_from?.slice(0, 16) || '',
      effective_to: rule.effective_to?.slice(0, 16) || '',
    })
    setShowForm(true)
  }

  const handleSave = async () => {
    setSaving(true)

    try {
      const payload = {
        ...form,
        organization_id:
          form.scope === 'organization' ? form.organization_id || undefined : undefined,
        effective_from: form.effective_from || undefined,
        effective_to: form.effective_to || undefined,
      }

      if (editId) {
        await updatePricingRule(editId, payload)
      } else {
        await createPricingRule(payload)
      }

      showToast('保存成功', 'success')
      setShowForm(false)
      setEditId(null)
      await load()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) {
      return
    }

    try {
      await deletePricingRule(deleteTarget)
      setDeleteTarget(null)
      showToast('删除成功', 'success')
      void load()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败', 'error')
      throw error
    }
  }

  const activeRules = rules.filter((rule) => rule.is_active).length
  const organizationRules = rules.filter((rule) => rule.scope === 'organization').length
  const uniqueMeters = new Set(rules.map((rule) => rule.meter_key)).size
  const formInvalid =
    !form.meter_key.trim() || (form.scope === 'organization' && !form.organization_id.trim())

  return (
    <AdminPage className={embedded ? 'space-y-4' : undefined}>
      {toastEl}

      <AdminPageHeader
        title="定价规则"
        icon={DollarSign}
        back={
          embedded
            ? undefined
            : {
                label: '返回商品与定价',
                onClick: () => navigate('/billing/products'),
              }
        }
        badges={
          <>
            <Badge variant="outline">共 {total} 条规则</Badge>
            <Badge variant="outline">启用 {activeRules} 条</Badge>
            <Badge variant="outline">组织覆盖 {organizationRules} 条</Badge>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              新建规则
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="规则总数"
          value={total.toLocaleString()}
          hint="当前分页条件下的定价规则总数。"
          icon={DollarSign}
        />
        <AdminMetricCard
          title="启用规则"
          value={activeRules.toLocaleString()}
          hint="启用后才会参与实际计费结算。"
          tone={activeRules > 0 ? 'success' : 'warning'}
          icon={RefreshCw}
        />
        <AdminMetricCard
          title="组织覆盖"
          value={organizationRules.toLocaleString()}
          hint="用于覆盖全局默认价，处理特殊客户或套餐。"
        />
        <AdminMetricCard
          title="当前页计量项"
          value={uniqueMeters.toLocaleString()}
          hint="可用来检查高频 meter 是否都已覆盖。"
        />
      </div>

      <Dialog
        open={showForm}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setShowForm(false)
            setEditId(null)
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editId ? '编辑定价规则' : '新建定价规则'}</DialogTitle>
            <DialogDescription>
              组织覆盖规则需填写组织 ID。优先级越高越优先生效；精度用于控制计价小数位。
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="pricing-meter-key"
              label="计量项"
              value={form.meter_key}
              onChange={(value) => setForm((current) => ({ ...current, meter_key: value }))}
            />

            <div>
              <label className="text-body font-medium" htmlFor="pricing-scope">
                作用域
              </label>
              <Select
                value={form.scope}
                onValueChange={(value) => setForm((current) => ({ ...current, scope: value }))}
              >
                <SelectTrigger id="pricing-scope" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">全局</SelectItem>
                  <SelectItem value="organization">组织</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.scope === 'organization' ? (
              <Field
                id="pricing-organization-id"
                label="组织 ID"
                value={form.organization_id}
                onChange={(value) => setForm((current) => ({ ...current, organization_id: value }))}
              />
            ) : (
              <div className="rounded-lg border border-dashed px-3 py-3 text-body text-muted-foreground">
                当前为全局规则，无需填写组织 ID。
              </div>
            )}

            <Field
              id="pricing-provider-key"
              label="渠道"
              value={form.provider_key}
              onChange={(value) => setForm((current) => ({ ...current, provider_key: value }))}
            />

            <Field
              id="pricing-model-name"
              label="模型"
              value={form.model_name}
              onChange={(value) => setForm((current) => ({ ...current, model_name: value }))}
            />
            <Field
              id="pricing-unit"
              label="单位"
              value={form.unit}
              onChange={(value) => setForm((current) => ({ ...current, unit: value }))}
            />
            <Field
              id="pricing-unit-price"
              label="单价"
              value={form.unit_price}
              onChange={(value) => setForm((current) => ({ ...current, unit_price: value }))}
            />
            <Field
              id="pricing-currency"
              label="币种"
              value={form.currency}
              onChange={(value) => setForm((current) => ({ ...current, currency: value }))}
            />
            <Field
              id="pricing-precision"
              label="精度"
              type="number"
              value={form.precision}
              onChange={(value) =>
                setForm((current) => ({ ...current, precision: Number(value || 0) }))
              }
            />
            <Field
              id="pricing-priority"
              label="优先级"
              type="number"
              value={form.priority}
              onChange={(value) =>
                setForm((current) => ({ ...current, priority: Number(value || 0) }))
              }
            />
            <div>
              <label className="text-body font-medium" htmlFor="pricing-effective-from">
                生效开始
              </label>
              <Input
                id="pricing-effective-from"
                className="mt-1"
                type="datetime-local"
                value={form.effective_from}
                onChange={(event) =>
                  setForm((current) => ({ ...current, effective_from: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="text-body font-medium" htmlFor="pricing-effective-to">
                生效结束
              </label>
              <Input
                id="pricing-effective-to"
                className="mt-1"
                type="datetime-local"
                value={form.effective_to}
                onChange={(event) =>
                  setForm((current) => ({ ...current, effective_to: event.target.value }))
                }
              />
            </div>
          </div>

          <div className="flex items-center gap-2 text-body">
            <Checkbox
              id="pricing-is-active"
              checked={form.is_active}
              onCheckedChange={(checked) =>
                setForm((current) => ({ ...current, is_active: checked === true }))
              }
            />
            <label htmlFor="pricing-is-active">启用规则</label>
          </div>

          {form.scope === 'organization' && !form.organization_id.trim() ? (
            <p className="text-body text-destructive">组织作用域必须填写组织 ID。</p>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowForm(false)
                setEditId(null)
              }}
              disabled={saving}
            >
              取消
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || formInvalid}>
              {saving ? '保存中...' : '保存规则'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AdminListCard
        title="定价规则列表"
        description="优先确认高占比 meter 是否有明确价格，并检查是否需要 organization 级覆盖。"
        contentClassName="space-y-4 px-0"
        actions={
          <Badge variant="outline">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
          </Badge>
        }
      >
        {loading && rules.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">定价规则加载失败，请检查网络后重试。</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="定价规则列表">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-3 py-3 text-left font-medium">计量项</th>
                    <th className="px-3 py-3 text-left font-medium">作用域</th>
                    <th className="px-3 py-3 text-left font-medium">作用对象</th>
                    <th className="px-3 py-3 text-left font-medium">渠道</th>
                    <th className="px-3 py-3 text-left font-medium">模型</th>
                    <th className="px-3 py-3 text-left">
                      <SortableHeader
                        label="单价"
                        field="unit_price"
                        currentSort={sort}
                        onSort={(field) => {
                          setSort(toggleSort(sort, field))
                          setPage(1)
                        }}
                      />
                    </th>
                    <th className="px-3 py-3 text-left font-medium">单位</th>
                    <th className="px-3 py-3 text-left">
                      <SortableHeader
                        label="优先级"
                        field="priority"
                        currentSort={sort}
                        onSort={(field) => {
                          setSort(toggleSort(sort, field))
                          setPage(1)
                        }}
                      />
                    </th>
                    <th className="px-3 py-3 text-left font-medium">状态</th>
                    <th className="px-3 py-3 text-left">
                      <SortableHeader
                        label="更新时间"
                        field="updated_at"
                        currentSort={sort}
                        onSort={(field) => {
                          setSort(toggleSort(sort, field))
                          setPage(1)
                        }}
                      />
                    </th>
                    <th className="px-3 py-3 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-3 text-left">
                        <div className="font-medium text-body">
                          {formatMeterKeyLabel(rule.meter_key)}
                        </div>
                        <div className="font-mono text-caption text-muted-foreground">
                          {rule.meter_key}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-left">
                        {rule.scope === 'organization' ? '组织' : '全局'}
                      </td>
                      <td className="px-3 py-3 text-left font-mono text-body text-muted-foreground">
                        {rule.scope === 'organization' ? rule.organization_id || '-' : '全局默认'}
                      </td>
                      <td className="px-3 py-3 text-left text-muted-foreground">
                        {rule.provider_key || '-'}
                      </td>
                      <td className="max-w-[180px] px-3 py-3 text-left text-muted-foreground">
                        <span className="block truncate">{rule.model_name || '-'}</span>
                      </td>
                      <td className="px-3 py-3 text-left font-mono">{rule.unit_price}</td>
                      <td className="px-3 py-3 text-left">{formatPricingUnit(rule.unit)}</td>
                      <td className="px-3 py-3 text-left">{rule.priority}</td>
                      <td className="px-3 py-3 text-left">
                        <Badge variant={rule.is_active ? 'success' : 'outline'}>
                          {rule.is_active ? '启用' : '禁用'}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-left text-body text-muted-foreground">
                        {formatDateTime(rule.updated_at)}
                      </td>
                      <td className="px-3 py-3 text-left">
                        <div className="flex justify-start gap-2">
                          <Button variant="outline" size="sm" onClick={() => openEdit(rule)}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            编辑
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(rule.id)}
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rules.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-4 py-12 text-left text-muted-foreground">
                        当前没有定价规则，建议先为核心计量项创建全局默认价。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <nav aria-label="定价规则分页导航" className="px-6 pb-6">
              <Pagination
                page={page}
                total={total}
                pageSize={pageSize}
                onChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPage(1)
                  setPageSize(nextPageSize)
                }}
              />
            </nav>
          </>
        )}
      </AdminListCard>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
          }
        }}
        title="删除定价规则"
        description="删除后不可恢复，确认删除这条定价规则吗？"
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDelete}
      />
    </AdminPage>
  )
}
