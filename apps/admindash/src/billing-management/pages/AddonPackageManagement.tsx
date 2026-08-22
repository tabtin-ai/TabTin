import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Switch } from '@/components/ui/switch'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { Boxes, Loader2, PencilLine, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  type AddonPackage,
  type AddonPackagePayload,
  type AddonQuotaKey,
  createAddonPackage,
  deleteAddonPackage,
  listAddonPackages,
  updateAddonPackage,
} from '../api/billing-admin'

const QUOTA_OPTIONS: Array<{ key: AddonQuotaKey; label: string; unit: string; hint: string }> = [
  { key: 'max_tables', label: '表格数量', unit: '个', hint: '购买后增加组织可创建表格数量。' },
  {
    key: 'max_documents',
    label: '文档数量',
    unit: '篇',
    hint: '购买后增加组织可创建或上传文档数量。',
  },
  { key: 'max_groups', label: '群组数量', unit: '个', hint: '购买后增加组织可创建群组数量。' },
  {
    key: 'storage_quota_bytes',
    label: '存储容量',
    unit: 'GB',
    hint: '表单按 GB 填写，保存时转换为字节。',
  },
  { key: 'max_members', label: '成员席位', unit: '席', hint: '购买后增加组织可邀请成员席位。' },
]

interface AddonPackageForm {
  addon_code: string
  addon_name: string
  description: string
  price: string
  quota_key: AddonQuotaKey
  quota_value: number
  period_months: number
  sort_order: number
  is_active: boolean
}

const EMPTY_FORM: AddonPackageForm = {
  addon_code: '',
  addon_name: '',
  description: '',
  price: '',
  quota_key: 'max_tables',
  quota_value: 100,
  period_months: 1,
  sort_order: 0,
  is_active: true,
}

const BYTES_PER_GB = 1024 * 1024 * 1024

function formatQuota(pkg: AddonPackage): string {
  if (pkg.quota_key === 'storage_quota_bytes') {
    return `${(pkg.quota_value / BYTES_PER_GB).toLocaleString(undefined, {
      maximumFractionDigits: 1,
    })} GB`
  }
  const option = QUOTA_OPTIONS.find((item) => item.key === pkg.quota_key)
  return `${pkg.quota_value.toLocaleString()} ${option?.unit ?? ''}`.trim()
}

function toForm(pkg: AddonPackage): AddonPackageForm {
  return {
    addon_code: pkg.addon_code,
    addon_name: pkg.addon_name,
    description: pkg.description,
    price: pkg.price,
    quota_key: pkg.quota_key,
    quota_value:
      pkg.quota_key === 'storage_quota_bytes'
        ? Math.round(pkg.quota_value / BYTES_PER_GB)
        : pkg.quota_value,
    period_months: pkg.period_months,
    sort_order: pkg.sort_order,
    is_active: pkg.is_active,
  }
}

function toPayload(form: AddonPackageForm): AddonPackagePayload {
  return {
    addon_code: form.addon_code.trim(),
    addon_name: form.addon_name.trim(),
    description: form.description.trim(),
    price: form.price,
    quota_key: form.quota_key,
    quota_value:
      form.quota_key === 'storage_quota_bytes'
        ? Math.max(1, Math.round(form.quota_value * BYTES_PER_GB))
        : Math.max(1, Math.round(form.quota_value)),
    period_months: Math.max(1, Math.round(form.period_months)),
    sort_order: Math.round(form.sort_order),
    is_active: form.is_active,
    metadata: {},
  }
}

export function AddonPackageManagement({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const [packages, setPackages] = useState<AddonPackage[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<AddonPackageForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AddonPackage | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (options?: { quiet?: boolean }) => {
    if (!options?.quiet) {
      setLoading(true)
    }
    try {
      const data = await listAddonPackages({ _ts: Date.now() })
      setPackages(data.packages || [])
    } catch {
      showToast('加载增值服务失败', 'error')
    } finally {
      if (!options?.quiet) {
        setLoading(false)
      }
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  const activeCount = packages.filter((pkg) => pkg.is_active).length
  const quotaTypeCount = useMemo(
    () => new Set(packages.map((pkg) => pkg.quota_key)).size,
    [packages]
  )
  const purchasedCount = packages.reduce(
    (sum, pkg) => sum + Number(pkg.active_entitlement_count || 0),
    0
  )

  const openCreate = () => {
    setEditing('__new__')
    setForm(EMPTY_FORM)
  }

  const openEdit = (pkg: AddonPackage) => {
    setEditing(pkg.id)
    setForm(toForm(pkg))
  }

  const applyLocalPackageUpdate = (packageId: string, payload: AddonPackagePayload) => {
    const quotaOption = QUOTA_OPTIONS.find((item) => item.key === payload.quota_key)
    setPackages((prev) =>
      prev.map((pkg) =>
        pkg.id === packageId
          ? {
              ...pkg,
              ...payload,
              quota_label: quotaOption?.label ?? pkg.quota_label,
            }
          : pkg
      )
    )
  }

  const handleSave = async () => {
    const editingId = editing
    const payload = toPayload(form)
    if (!payload.addon_code || !payload.addon_name || !payload.price) {
      showToast('编码、名称和价格不能为空', 'error')
      return
    }
    if (!editingId) {
      return
    }

    setSaving(true)
    try {
      if (editingId === '__new__') {
        await createAddonPackage(payload)
        showToast('增值服务已创建', 'success')
      } else {
        await updateAddonPackage(editingId, payload)
        applyLocalPackageUpdate(editingId, payload)
        showToast('增值服务已更新', 'success')
      }
      setEditing(null)
      await load({ quiet: true })
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (payload: { reason: string; ticket_id: string }) => {
    if (!deleteTarget) return
    const deletedId = deleteTarget.id
    setDeleting(true)
    try {
      await deleteAddonPackage(deletedId, payload)
      setPackages((prev) => prev.filter((pkg) => pkg.id !== deletedId))
      showToast('增值服务已删除或下架', 'success')
      setDeleteTarget(null)
      await load({ quiet: true })
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败', 'error')
    } finally {
      setDeleting(false)
    }
  }

  const selectedQuota = QUOTA_OPTIONS.find((item) => item.key === form.quota_key)

  return (
    <AdminPage className={embedded ? 'space-y-4' : undefined}>
      {toastEl}
      <AdminPageHeader
        title="权益扩容包"
        icon={Boxes}
        back={
          embedded
            ? undefined
            : {
                label: '返回商品与定价',
                onClick: () => navigate('/billing/products'),
              }
        }
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            新建增值服务
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <AdminMetricCard
          title="增值服务"
          value={packages.length.toLocaleString()}
          hint="所有已配置的扩容包。"
          icon={Boxes}
        />
        <AdminMetricCard
          title="上架中"
          value={activeCount.toLocaleString()}
          hint="客户端可购买的增值服务。"
          icon={Plus}
          tone={activeCount > 0 ? 'success' : 'default'}
        />
        <AdminMetricCard
          title="生效权益"
          value={purchasedCount.toLocaleString()}
          hint={`覆盖 ${quotaTypeCount} 类权益。`}
          icon={PencilLine}
        />
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setEditing(null)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === '__new__' ? '新建增值服务' : '编辑增值服务'}</DialogTitle>
            <DialogDescription>
              配置会展示给客户端，购买后发放到 Organization 权益。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="addon-code" className="space-y-1 text-body">
              <span className="font-medium">服务编码</span>
              <Input
                id="addon-code"
                placeholder="addon_table_100"
                value={form.addon_code}
                onChange={(event) => setForm({ ...form, addon_code: event.target.value })}
              />
            </label>
            <label htmlFor="addon-name" className="space-y-1 text-body">
              <span className="font-medium">服务名称</span>
              <Input
                id="addon-name"
                placeholder="增加 100 个表格"
                value={form.addon_name}
                onChange={(event) => setForm({ ...form, addon_name: event.target.value })}
              />
            </label>
            <label htmlFor="addon-price" className="space-y-1 text-body">
              <span className="font-medium">价格（元）</span>
              <Input
                id="addon-price"
                value={form.price}
                onChange={(event) => setForm({ ...form, price: event.target.value })}
              />
            </label>
            <label htmlFor="addon-quota-key" className="space-y-1 text-body">
              <span className="font-medium">权益类型</span>
              <Select
                value={form.quota_key}
                onValueChange={(value) => setForm({ ...form, quota_key: value as AddonQuotaKey })}
              >
                <SelectTrigger id="addon-quota-key">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUOTA_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label htmlFor="addon-quota-value" className="space-y-1 text-body">
              <span className="font-medium">增加额度（{selectedQuota?.unit ?? ''}）</span>
              <Input
                id="addon-quota-value"
                type="number"
                min={1}
                value={form.quota_value}
                onChange={(event) =>
                  setForm({ ...form, quota_value: Number.parseInt(event.target.value) || 0 })
                }
              />
              <span className="text-caption text-muted-foreground">{selectedQuota?.hint}</span>
            </label>
            <label htmlFor="addon-period-months" className="space-y-1 text-body">
              <span className="font-medium">有效期（月）</span>
              <Input
                id="addon-period-months"
                type="number"
                min={1}
                value={form.period_months}
                onChange={(event) =>
                  setForm({ ...form, period_months: Number.parseInt(event.target.value) || 1 })
                }
              />
            </label>
            <label htmlFor="addon-sort-order" className="space-y-1 text-body">
              <span className="font-medium">排序</span>
              <Input
                id="addon-sort-order"
                type="number"
                value={form.sort_order}
                onChange={(event) =>
                  setForm({ ...form, sort_order: Number.parseInt(event.target.value) || 0 })
                }
              />
            </label>
            <label htmlFor="addon-description" className="space-y-1 text-body sm:col-span-2">
              <span className="font-medium">描述</span>
              <Input
                id="addon-description"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Switch
                checked={form.is_active}
                onCheckedChange={(checked) => setForm({ ...form, is_active: checked })}
              />
              <span className="text-body">上架销售</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AdminListCard
        title="扩容包列表"
        description="配置会展示给客户端，购买后发放到 Organization 权益。"
        actions={<Badge variant="outline">共 {packages.length} 个</Badge>}
      >
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : packages.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">暂无扩容包</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-3 py-2">名称</th>
                  <th className="px-3 py-2">权益</th>
                  <th className="px-3 py-2">价格</th>
                  <th className="px-3 py-2">有效期</th>
                  <th className="px-3 py-2">生效组织</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <tr key={pkg.id} className="border-b">
                    <td className="px-3 py-2">
                      <div className="font-medium">{pkg.addon_name}</div>
                      <div className="text-caption text-muted-foreground">{pkg.addon_code}</div>
                    </td>
                    <td className="px-3 py-2">
                      {pkg.quota_label} +{formatQuota(pkg)}
                    </td>
                    <td className="px-3 py-2">¥{pkg.price}</td>
                    <td className="px-3 py-2">{pkg.period_months} 月</td>
                    <td className="px-3 py-2">{pkg.active_entitlement_count}</td>
                    <td className="px-3 py-2">
                      <Badge variant={pkg.is_active ? 'success' : 'secondary'}>
                        {pkg.is_active ? '上架' : '下架'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(pkg)}>
                          <PencilLine className="h-4 w-4" />
                        </Button>
                        <PermissionGate permission={ADMIN_PERMISSION.ADDON_PACKAGE_UPDATE}>
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(pkg)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </PermissionGate>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminListCard>
      <SensitiveActionConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除或下架增值包"
        targetLabel={deleteTarget?.addon_name ?? ''}
        impact="删除会影响后续购买，若存在已购记录将自动改为下架状态。"
        confirmText="下架"
        loading={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(payload) => void handleDelete(payload)}
      />
    </AdminPage>
  )
}
